/**
 * DAG Executor for ProtClaw
 *
 * Event-driven pipeline execution engine that:
 * 1. Parses a pipeline DAG and finds nodes with satisfied dependencies
 * 2. Acquires resources via ResourceScheduler (GPU waits, CPU immediate)
 * 3. Executes skill via ExecutionEngine
 * 4. On completion: releases resources, triggers downstream nodes
 * 5. Repeats until all nodes complete or a critical failure occurs
 *
 * Different hardware automatically gets different behavior:
 * - 4 GPU: GPU tasks can overlap if DAG allows
 * - 1 GPU: GPU tasks queue serially; CPU tasks run in parallel
 * - CPU-only: everything in CPU pool, gpu:preferred skills fallback
 */

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

type NodeStatus = 'pending' | 'running' | 'completed' | 'failed';

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
   * Execute a pipeline DAG with automatic resource scheduling.
   *
   * Algorithm:
   * 1. Find all nodes with no unsatisfied dependencies
   * 2. For each ready node: acquire resources (may wait for GPU)
   * 3. Execute skill via engine
   * 4. On completion: release resources, find newly ready nodes
   * 5. Repeat until all nodes are done
   */
  async execute(
    pipeline: PipelineDAG,
    params: Record<string, Record<string, unknown>>,
    callbacks?: DagCallbacks,
  ): Promise<DagResult> {
    const startTime = Date.now();
    const state = new DagState(pipeline);
    const running = new Map<string, Promise<void>>();

    // Validate all skills exist
    for (const node of pipeline.nodes) {
      const skill = this.registry.getSkill(node.skillName);
      if (!skill) {
        throw new Error(`Unknown skill "${node.skillName}" in node "${node.id}"`);
      }
    }

    // Event loop: keep launching ready nodes until everything is done
    while (!state.isComplete()) {
      const readyNodes = state.getReadyNodes();

      // Launch all ready nodes
      for (const node of readyNodes) {
        state.markRunning(node.id);

        const promise = this.launchNode(
          node,
          params[node.id] ?? {},
          state,
          callbacks,
        ).then(() => {
          running.delete(node.id);
        });

        running.set(node.id, promise);
      }

      // If nothing is running and nothing is ready, we're stuck (shouldn't happen with valid DAG)
      if (running.size === 0 && readyNodes.length === 0) {
        break;
      }

      // Wait for at least one running node to complete before checking again
      if (running.size > 0) {
        await Promise.race(running.values());
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
    callbacks?: DagCallbacks,
  ): Promise<void> {
    const skill = this.registry.getSkill(node.skillName)!;
    let resources: AcquiredResources | undefined;

    try {
      // Acquire resources (may wait for GPU)
      resources = await this.scheduler.acquire(skill, node.id);
      callbacks?.onNodeStart?.(node.id, skill.name, resources);

      // Execute skill
      const result = await this.engine.execute({
        skillName: skill.name,
        nodeId: node.id,
        params,
        gpuId: resources.gpuId,
        isCpuFallback: resources.isCpuFallback,
      });

      state.markComplete(node.id, result);
      callbacks?.onNodeComplete?.(node.id, result);
    } catch (error) {
      state.markFailed(node.id, error);
      callbacks?.onNodeFailed?.(node.id, error);
    } finally {
      if (resources) {
        this.scheduler.release(node.id);
      }
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
