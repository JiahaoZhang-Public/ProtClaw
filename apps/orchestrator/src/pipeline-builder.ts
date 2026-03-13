/**
 * Pipeline Builder — Shared logic for building and executing toolkit pipelines.
 *
 * Used by both protclaw-cli.ts (CLI path) and ipc.ts (agent IPC path).
 */

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { DagExecutor, type DagCallbacks, type DagExecutorOptions, type DagResult, type ExecutionEngine, type PipelineDAG } from './dag-executor.js';
import type { ResourceScheduler } from './resource-scheduler.js';
import type { SkillRegistry } from './skill-registry.js';

/* ------------------------------------------------------------------ */
/*  Operation → Skill mapping                                          */
/* ------------------------------------------------------------------ */

/** Maps toolkit operation names to SKILL.md names (kebab-case). */
export const OPERATION_TO_SKILL: Record<string, string> = {
  backbone_generate: 'rfdiffusion',
  sequence_design: 'proteinmpnn',
  structure_predict: 'esmfold',
  structure_qc: 'structure-qc',
  developability_check: 'developability',
  candidate_cluster: 'candidate-ops',
  candidate_rank: 'candidate-ops',
  experiment_package: 'experiment-package',
};

/* ------------------------------------------------------------------ */
/*  DAG construction from manifest                                     */
/* ------------------------------------------------------------------ */

export interface ManifestOperation {
  tool?: string;
  depends_on?: string[];
  [key: string]: unknown;
}

/**
 * Build a PipelineDAG from a toolkit manifest YAML file.
 */
export function buildDagFromManifest(manifestPath: string): PipelineDAG {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Toolkit manifest not found: ${manifestPath}`);
  }

  const manifest = YAML.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const operationsObj = manifest.operations as Record<string, ManifestOperation>;
  const operationNames = Object.keys(operationsObj);

  return {
    nodes: operationNames.map(opName => {
      const op = operationsObj[opName]!;
      return {
        id: opName,
        skillName: OPERATION_TO_SKILL[opName] ?? op.tool ?? opName,
        dependsOn: op.depends_on ?? [],
      };
    }),
  };
}

/* ------------------------------------------------------------------ */
/*  Pipeline execution                                                 */
/* ------------------------------------------------------------------ */

export interface PipelineContext {
  engine: ExecutionEngine;
  registry: SkillRegistry;
  scheduler: ResourceScheduler;
  toolkitDir: string;
  pipelineDir: string;
}

/**
 * Execute a full toolkit pipeline. Builds DAG from manifest and runs it.
 */
export async function executePipeline(
  toolkitName: string,
  params: Record<string, unknown>,
  ctx: PipelineContext,
  callbacks?: DagCallbacks,
): Promise<DagResult> {
  const manifestPath = path.join(ctx.toolkitDir, toolkitName, 'manifest.yaml');
  const dag = buildDagFromManifest(manifestPath);

  const executor = new DagExecutor(ctx.scheduler, ctx.engine, ctx.registry);

  const options: DagExecutorOptions = { pipelineDir: ctx.pipelineDir };

  // Distribute params to DAG nodes:
  // If params are keyed by node ID (e.g., { backbone_generate: {...} }), use as-is.
  // Otherwise, inject flat params into the first root node(s) (nodes with no dependencies).
  let nodeParams: Record<string, Record<string, unknown>>;

  const firstKey = Object.keys(params)[0];
  const isNodeKeyed = firstKey && dag.nodes.some(n => n.id === firstKey);

  if (isNodeKeyed) {
    nodeParams = params as Record<string, Record<string, unknown>>;
  } else {
    // Flat params → inject into all root nodes (no dependencies)
    nodeParams = {};
    for (const node of dag.nodes) {
      if (node.dependsOn.length === 0) {
        nodeParams[node.id] = { ...params };
      }
    }
  }

  return executor.execute(dag, nodeParams, callbacks ?? {}, options);
}
