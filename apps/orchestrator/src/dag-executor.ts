/**
 * DAG Executor for ProtClaw
 *
 * Event-driven pipeline execution engine that:
 * 1. Parses a pipeline DAG and finds nodes with satisfied dependencies
 * 2. Acquires resources via ResourceScheduler (GPU waits, CPU immediate)
 * 3. Executes skill via ExecutionEngine
 * 4. Routes output files from completed nodes to dependent nodes
 * 5. On completion: releases resources, triggers downstream nodes
 * 6. Repeats until all nodes complete or a critical failure occurs
 *
 * Different hardware automatically gets different behavior:
 * - 4 GPU: GPU tasks can overlap if DAG allows
 * - 1 GPU: GPU tasks queue serially; CPU tasks run in parallel
 * - CPU-only: everything in CPU pool, gpu:preferred skills fallback
 *
 * Pipeline file routing (new):
 * - Each node gets a stable workdir under a pipeline-level directory
 * - After a node completes, its output files are copied to dependent nodes' input dirs
 * - File params are injected into downstream nodes by extension convention
 * - Upstream metrics are passed as _upstream_results for JSON-to-JSON transitions
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { ResourceScheduler, AcquiredResources } from './resource-scheduler.js';
import type { SkillRegistry } from './skill-registry.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface DagNode {
  /** Unique node ID within the pipeline (e.g. "backbone_generate"). */
  id: string;
  /** Skill name to execute (must exist in SkillRegistry). */
  skillName: string;
  /** IDs of nodes that must complete before this one starts. */
  dependsOn: string[];
  /**
   * Default params from manifest (e.g., input defaults, operation-specific params).
   * Merged into node params before execution — user params take precedence.
   */
  defaultParams?: Record<string, unknown>;
  /**
   * Per-dependency file routing overrides.
   * Maps source node ID → { format → param name } to override generic FORMAT_PARAM_MAP.
   * Example: { "structure_predict": { "pdb": "predicted_pdb" } }
   */
  sourceParamOverrides?: Record<string, Record<string, string>>;
}

export interface PipelineDAG {
  nodes: DagNode[];
}

export interface SkillRunConfig {
  skillName: string;
  nodeId: string;
  params: Record<string, unknown>;
  gpuId: number;
  isCpuFallback: boolean;
  /**
   * If provided, the execution engine uses this as the workdir instead of
   * creating a temp directory. The engine will NOT clean up this directory.
   * Used by DagExecutor for pipeline-level file routing between nodes.
   */
  workDir?: string;
}

export interface SkillRunResult {
  status: 'success' | 'failed' | 'partial';
  outputFiles: string[];
  metrics: Record<string, unknown>;
  errors: string[];
  durationSeconds: number;
}

/** Execution engine interface — implemented by LocalExecutionEngine / SshExecutionEngine. */
export interface ExecutionEngine {
  execute(config: SkillRunConfig): Promise<SkillRunResult>;
}

export interface DagCallbacks {
  onNodeStart?: (nodeId: string, skillName: string, resources: AcquiredResources) => void;
  onNodeComplete?: (nodeId: string, result: SkillRunResult) => void;
  onNodeFailed?: (nodeId: string, error: unknown) => void;
}

export interface DagResult {
  status: 'success' | 'partial' | 'failed';
  nodeResults: Map<string, SkillRunResult>;
  failedNodes: string[];
  durationSeconds: number;
}

export interface DagExecutorOptions {
  /**
   * Base directory for pipeline workdirs. If set, DagExecutor manages
   * per-node workdirs and routes files between nodes automatically.
   * If not set, each node manages its own temp workdir (no file routing).
   */
  pipelineDir?: string;
}

type NodeStatus = 'pending' | 'running' | 'completed' | 'failed';

/* ------------------------------------------------------------------ */
/*  PipelineFileRouter — convention-based file routing                  */
/* ------------------------------------------------------------------ */

/**
 * Format → param key mapping.
 * When routing files from upstream to downstream, we inject file references
 * into the downstream params using these key names (matching adapter conventions).
 */
const FORMAT_PARAM_MAP: Record<string, string> = {
  pdb: 'pdb_files',
  fasta: 'fasta_files',
  json: 'json_files',
  csv: 'csv_files',
};

/**
 * Detect file format from extension.
 */
function detectFormat(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase().slice(1);
  switch (ext) {
    case 'pdb': return 'pdb';
    case 'fasta':
    case 'fa':
    case 'faa':
      return 'fasta';
    case 'json': return 'json';
    case 'csv': return 'csv';
    case 'html':
    case 'htm':
      return 'html';
    case 'xlsx': return 'xlsx';
    default: return null;
  }
}

/**
 * Route output files from a completed node to a dependent node's input dir.
 * Returns the list of files copied (basenames).
 */
function routeFiles(
  sourceOutputDir: string,
  targetInputDir: string,
): Map<string, string[]> {
  const sourceFilesDir = path.join(sourceOutputDir, 'output', 'files');
  const targetFilesDir = path.join(targetInputDir, 'input', 'files');

  const filesByFormat = new Map<string, string[]>();

  if (!fs.existsSync(sourceFilesDir)) return filesByFormat;

  const files = fs.readdirSync(sourceFilesDir);
  if (files.length === 0) return filesByFormat;

  fs.mkdirSync(targetFilesDir, { recursive: true });

  for (const file of files) {
    const format = detectFormat(file);
    if (!format) continue;

    const src = path.join(sourceFilesDir, file);
    const dst = path.join(targetFilesDir, file);

    // Don't overwrite if already exists (earlier dependency may have routed same format)
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }

    const list = filesByFormat.get(format) ?? [];
    list.push(file);
    filesByFormat.set(format, list);
  }

  return filesByFormat;
}

/**
 * Inject file references into node params based on format conventions.
 *
 * Rules:
 * - Multiple files of same format → array param (e.g., pdb_files: ["a.pdb", "b.pdb"])
 * - Single file → still array for list params, single string for singular params
 * - Does NOT overwrite existing params (user-provided params take precedence)
 *
 * Special handling for adapters that use singular params:
 * - developability expects `fasta_file` (singular string), not `fasta_files`
 * - structure_qc expects `predicted_pdb` and `designed_pdb` (singular strings)
 *
 * @param overrides - Per-source format→param overrides (e.g., { pdb: "predicted_pdb" })
 *   When provided, these override the default FORMAT_PARAM_MAP for this specific source.
 *   Used for source-aware routing (e.g., ESMFold PDBs → predicted_pdb, RFdiffusion PDBs → designed_pdb).
 */
function injectFileParams(
  params: Record<string, unknown>,
  filesByFormat: Map<string, string[]>,
  overrides?: Record<string, string>,
): void {
  for (const [format, files] of filesByFormat) {
    // Check for source-specific override first
    const overrideKey = overrides?.[format];
    if (overrideKey) {
      if (!(overrideKey in params) && files.length > 0) {
        params[overrideKey] = files[0]; // Override params are always singular
      }
      continue; // Skip generic injection when override is defined
    }

    const listKey = FORMAT_PARAM_MAP[format];
    if (!listKey) continue;

    // Only inject if not already set by user or earlier routing
    if (!(listKey in params)) {
      params[listKey] = files;
    }

    // Also set singular form for adapters that expect it
    const singularKey = listKey.replace(/_files$/, '_file');
    if (singularKey !== listKey && !(singularKey in params) && files.length > 0) {
      params[singularKey] = files[0];
    }
  }
}

/* ------------------------------------------------------------------ */
/*  DagState — tracks node lifecycle                                   */
/* ------------------------------------------------------------------ */

class DagState {
  private statuses: Map<string, NodeStatus> = new Map();
  private results: Map<string, SkillRunResult> = new Map();
  private nodeMap: Map<string, DagNode> = new Map();
  private dependents: Map<string, string[]> = new Map(); // nodeId → downstream nodeIds

  constructor(dag: PipelineDAG) {
    for (const node of dag.nodes) {
      this.statuses.set(node.id, 'pending');
      this.nodeMap.set(node.id, node);
    }

    // Build reverse dependency map
    for (const node of dag.nodes) {
      for (const dep of node.dependsOn) {
        const list = this.dependents.get(dep) ?? [];
        list.push(node.id);
        this.dependents.set(dep, list);
      }
    }
  }

  getReadyNodes(): DagNode[] {
    const ready: DagNode[] = [];
    for (const [id, status] of this.statuses) {
      if (status !== 'pending') continue;
      const node = this.nodeMap.get(id)!;
      const allDepsComplete = node.dependsOn.every(
        dep => this.statuses.get(dep) === 'completed',
      );
      if (allDepsComplete) {
        ready.push(node);
      }
    }
    return ready;
  }

  getNode(nodeId: string): DagNode | undefined {
    return this.nodeMap.get(nodeId);
  }

  getDependents(nodeId: string): string[] {
    return this.dependents.get(nodeId) ?? [];
  }

  getResult_forNode(nodeId: string): SkillRunResult | undefined {
    return this.results.get(nodeId);
  }

  markRunning(nodeId: string): void {
    this.statuses.set(nodeId, 'running');
  }

  markComplete(nodeId: string, result: SkillRunResult): void {
    this.statuses.set(nodeId, 'completed');
    this.results.set(nodeId, result);
  }

  markFailed(nodeId: string, error: unknown): void {
    this.statuses.set(nodeId, 'failed');
    // Mark all transitive dependents as failed (cascade)
    this.cascadeFailure(nodeId);
  }

  isComplete(): boolean {
    for (const status of this.statuses.values()) {
      if (status === 'pending' || status === 'running') return false;
    }
    return true;
  }

  hasRunningNodes(): boolean {
    for (const status of this.statuses.values()) {
      if (status === 'running') return true;
    }
    return false;
  }

  getResult(): DagResult {
    const failedNodes: string[] = [];
    for (const [id, status] of this.statuses) {
      if (status === 'failed') failedNodes.push(id);
    }

    let status: DagResult['status'] = 'success';
    if (failedNodes.length > 0) {
      status = failedNodes.length === this.statuses.size ? 'failed' : 'partial';
    }

    return {
      status,
      nodeResults: new Map(this.results),
      failedNodes,
      durationSeconds: 0, // filled by caller
    };
  }

  private cascadeFailure(nodeId: string): void {
    const downstream = this.dependents.get(nodeId) ?? [];
    for (const depId of downstream) {
      if (this.statuses.get(depId) === 'pending') {
        this.statuses.set(depId, 'failed');
        this.cascadeFailure(depId); // recursive
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  DagExecutor                                                        */
/* ------------------------------------------------------------------ */

export class DagExecutor {
  constructor(
    private scheduler: ResourceScheduler,
    private engine: ExecutionEngine,
    private registry: SkillRegistry,
  ) {}

  /**
   * Execute a pipeline DAG with automatic resource scheduling and file routing.
   *
   * Algorithm:
   * 1. Create pipeline-level workdir (if pipelineDir option set)
   * 2. Find all nodes with no unsatisfied dependencies
   * 3. For each ready node: acquire resources (may wait for GPU)
   * 4. Execute skill via engine (using per-node workdir for file routing)
   * 5. On completion: route output files to downstream nodes, inject params
   * 6. Release resources, find newly ready nodes
   * 7. Repeat until all nodes are done
   * 8. Clean up pipeline workdir
   */
  async execute(
    pipeline: PipelineDAG,
    params: Record<string, Record<string, unknown>>,
    callbacks?: DagCallbacks,
    options?: DagExecutorOptions,
  ): Promise<DagResult> {
    const startTime = Date.now();
    const state = new DagState(pipeline);
    const running = new Map<string, Promise<void>>();

    // Create pipeline-level workdir for file routing
    const pipelineId = crypto.randomUUID().slice(0, 8);
    const pipelineDir = options?.pipelineDir
      ? path.join(options.pipelineDir, `pipeline-${pipelineId}`)
      : undefined;

    if (pipelineDir) {
      fs.mkdirSync(pipelineDir, { recursive: true });
    }

    // Mutable params map — we'll inject file params into these
    const nodeParams = new Map<string, Record<string, unknown>>();
    for (const node of pipeline.nodes) {
      nodeParams.set(node.id, { ...(params[node.id] ?? {}) });
    }

    // Validate all skills exist
    for (const node of pipeline.nodes) {
      const skill = this.registry.getSkill(node.skillName);
      if (!skill) {
        throw new Error(`Unknown skill "${node.skillName}" in node "${node.id}"`);
      }
    }

    try {
      // Event loop: keep launching ready nodes until everything is done
      while (!state.isComplete()) {
        const readyNodes = state.getReadyNodes();

        // Launch all ready nodes
        for (const node of readyNodes) {
          state.markRunning(node.id);

          const promise = this.launchNode(
            node,
            nodeParams.get(node.id) ?? {},
            state,
            nodeParams,
            pipelineDir,
            callbacks,
          ).then(() => {
            running.delete(node.id);
          });

          running.set(node.id, promise);
        }

        // If nothing is running and nothing is ready, we're stuck
        if (running.size === 0 && readyNodes.length === 0) {
          break;
        }

        // Wait for at least one running node to complete before checking again
        if (running.size > 0) {
          await Promise.race(running.values());
        }
      }
    } finally {
      // Clean up pipeline workdir
      if (pipelineDir) {
        try {
          fs.rmSync(pipelineDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }

    const result = state.getResult();
    result.durationSeconds = (Date.now() - startTime) / 1000;
    return result;
  }

  private async launchNode(
    node: DagNode,
    params: Record<string, unknown>,
    state: DagState,
    nodeParams: Map<string, Record<string, unknown>>,
    pipelineDir: string | undefined,
    callbacks?: DagCallbacks,
  ): Promise<void> {
    const skill = this.registry.getSkill(node.skillName)!;
    let resources: AcquiredResources | undefined;

    try {
      // Acquire resources (may wait for GPU)
      resources = await this.scheduler.acquire(skill, node.id);
      callbacks?.onNodeStart?.(node.id, skill.name, resources);

      // Build workdir path if pipeline mode is active
      const nodeWorkDir = pipelineDir
        ? path.join(pipelineDir, node.id)
        : undefined;

      // Merge default params from manifest (user/routed params take precedence)
      const mergedParams = { ...(node.defaultParams ?? {}), ...params };

      // Execute skill
      const result = await this.engine.execute({
        skillName: skill.name,
        nodeId: node.id,
        params: mergedParams,
        gpuId: resources.gpuId,
        isCpuFallback: resources.isCpuFallback,
        workDir: nodeWorkDir,
      });

      state.markComplete(node.id, result);
      callbacks?.onNodeComplete?.(node.id, result);

      // Route files and inject params to downstream nodes (pipeline mode only)
      if (pipelineDir && result.status === 'success') {
        this.routeToDownstream(node, state, nodeParams, pipelineDir, result);
      }
    } catch (error) {
      state.markFailed(node.id, error);
      callbacks?.onNodeFailed?.(node.id, error);
    } finally {
      if (resources) {
        this.scheduler.release(node.id);
      }
    }
  }

  /**
   * After a node completes successfully, route its output files to all
   * dependent nodes and inject upstream results into their params.
   */
  private routeToDownstream(
    completedNode: DagNode,
    state: DagState,
    nodeParams: Map<string, Record<string, unknown>>,
    pipelineDir: string,
    result: SkillRunResult,
  ): void {
    const dependentIds = state.getDependents(completedNode.id);

    for (const depId of dependentIds) {
      const depNode = state.getNode(depId);
      if (!depNode) continue;

      const depParams = nodeParams.get(depId) ?? {};
      const sourceDir = path.join(pipelineDir, completedNode.id);
      const targetDir = path.join(pipelineDir, depId);

      // Route files by format
      const filesByFormat = routeFiles(sourceDir, targetDir);

      // Use source-aware param overrides if defined on the dependent node
      const overrides = depNode.sourceParamOverrides?.[completedNode.id];
      injectFileParams(depParams, filesByFormat, overrides);

      // Inject upstream metrics as _upstream_results
      const upstream = (depParams._upstream_results as Record<string, unknown>) ?? {};
      upstream[completedNode.id] = {
        metrics: result.metrics,
        outputFiles: result.outputFiles,
        status: result.status,
      };
      depParams._upstream_results = upstream;

      nodeParams.set(depId, depParams);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build a PipelineDAG from a simple step list (linear or partially parallel).
 *
 * Each step can specify dependsOn explicitly, or default to depending
 * on the previous step (linear chain).
 */
export function buildLinearDag(
  steps: Array<{ id: string; skillName: string; dependsOn?: string[] }>,
): PipelineDAG {
  const nodes: DagNode[] = steps.map((step, i) => ({
    id: step.id,
    skillName: step.skillName,
    dependsOn: step.dependsOn ?? (i > 0 ? [steps[i - 1]!.id] : []),
  }));

  return { nodes };
}
