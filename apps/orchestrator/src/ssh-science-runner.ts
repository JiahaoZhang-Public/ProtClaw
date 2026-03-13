/**
 * SSH Science Runner for ProtClaw
 *
 * Executes science tool adapters on a remote target via SSH + conda.
 * Drop-in replacement for runScienceContainer() in ScienceQueue.
 *
 * Now uses SkillRegistry (reads SKILL.md + infrastructure.yaml) instead
 * of hardcoded TOOL_ENV_MAP. Target configuration comes from
 * .protclaw/targets.yaml via target-loader.
 *
 * The adapter protocol (entrypoint.py + adapter.py) is container-agnostic:
 * same code runs whether invoked via Docker or SSH.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { ScienceRunConfig, ScienceRunResult } from './science-runner.js';
import type { SkillRunConfig, SkillRunResult, ExecutionEngine } from './dag-executor.js';
import { SshExecutionEngine, createEngine } from './execution-engine.js';
import { SkillRegistry } from './skill-registry.js';
import { loadTarget } from './target-loader.js';
import type { TargetConfig } from './shell-executor.js';

/* ------------------------------------------------------------------ */
/*  Module-level singletons (initialized on first call)                */
/* ------------------------------------------------------------------ */

let _engine: ExecutionEngine | null = null;
let _registry: SkillRegistry | null = null;
let _target: TargetConfig | null = null;

function ensureInitialized(): { engine: ExecutionEngine; registry: SkillRegistry; target: TargetConfig } {
  if (_engine && _registry && _target) {
    return { engine: _engine, registry: _registry, target: _target };
  }

  _target = loadTarget(process.env.SSH_TARGET);

  // Load skill registry
  const workersDir = path.resolve(process.cwd(), '../../workers/science-python');
  const toolsDir = path.join(workersDir, 'tools');

  _registry = new SkillRegistry();
  _registry.loadAll(toolsDir);

  _engine = createEngine(_target, _registry, workersDir);

  return { engine: _engine, registry: _registry, target: _target };
}

/* ------------------------------------------------------------------ */
/*  Tool name normalization                                            */
/* ------------------------------------------------------------------ */

/**
 * Normalize legacy toolkit operation names to skill directory names.
 * Toolkit manifests use operation names like "backbone_generate",
 * but skill directories are named by tool (e.g., "rfdiffusion").
 */
const OPERATION_TO_SKILL: Record<string, string> = {
  backbone_generate: 'rfdiffusion',
  sequence_design: 'proteinmpnn',
  structure_predict: 'esmfold',
  developability_check: 'developability',
  candidate_cluster: 'candidate_ops',
  candidate_rank: 'candidate_ops',
};

function normalizeToolName(toolName: string): string {
  // 1. Check operation aliases
  const aliased = OPERATION_TO_SKILL[toolName];
  if (aliased) return aliased;

  // 2. Convert kebab-case to underscore (structure-qc → structure_qc)
  return toolName.replace(/-/g, '_');
}

/* ------------------------------------------------------------------ */
/*  Public: SSH Science Runner                                         */
/* ------------------------------------------------------------------ */

/**
 * Run a science tool on a remote target via SSH + conda.
 *
 * Same signature as runScienceContainer() — drop-in replacement.
 * Uses SkillRegistry for env mapping and TargetConfig for server info.
 */
export async function runSshScience(
  runConfig: ScienceRunConfig,
): Promise<ScienceRunResult> {
  const startTime = Date.now();
  const { engine, registry } = ensureInitialized();

  // Ensure local directories exist
  fs.mkdirSync(path.join(runConfig.inputDir, 'files'), { recursive: true });
  fs.mkdirSync(path.join(runConfig.outputDir, 'files'), { recursive: true });

  // Write params.json locally
  const paramsPath = path.join(runConfig.inputDir, 'params.json');
  fs.writeFileSync(paramsPath, JSON.stringify(runConfig.params, null, 2));

  // Resolve skill name
  const skillName = normalizeToolName(runConfig.toolName);

  // Determine GPU assignment (ScienceQueue manages concurrency limits,
  // but we need a gpuId for CUDA_VISIBLE_DEVICES)
  const skill = registry.getSkill(skillName);
  const gpuId = runConfig.gpuRequired && skill?.resources.gpu !== 'none' ? 0 : -1;

  // Build SkillRunConfig
  const skillConfig: SkillRunConfig = {
    skillName,
    nodeId: runConfig.runId,
    params: runConfig.params,
    gpuId,
    isCpuFallback: !runConfig.gpuRequired,
  };

  let stdout = '';
  let stderr = '';

  try {
    const result = await engine.execute(skillConfig);

    // Map SkillRunResult → ScienceRunResult
    const exitCode = result.status === 'success' ? 0 : 1;

    const resultJson: Record<string, unknown> = {
      status: result.status,
      output_files: result.outputFiles,
      metrics: result.metrics,
      errors: result.errors,
      duration_seconds: result.durationSeconds,
    };

    // Write result.json to plan-executor's expected location
    const resultPath = path.join(runConfig.outputDir, 'result.json');
    fs.writeFileSync(resultPath, JSON.stringify(resultJson, null, 2));

    return {
      runId: runConfig.runId,
      exitCode,
      stdout,
      stderr: result.errors.join('\n'),
      result: resultJson,
      durationSeconds: (Date.now() - startTime) / 1000,
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      runId: runConfig.runId,
      exitCode: 1,
      stdout,
      stderr: `SSH runner error: ${errMsg}`,
      result: null,
      durationSeconds: (Date.now() - startTime) / 1000,
    };
  }
}

/**
 * Get the SkillRegistry used by the SSH runner (for external access).
 */
export function getSshRunnerRegistry(): SkillRegistry {
  return ensureInitialized().registry;
}

/**
 * Get the target config used by the SSH runner.
 */
export function getSshRunnerTarget(): TargetConfig {
  return ensureInitialized().target;
}

/**
 * Reset module state (for testing).
 */
export function _resetSshRunner(): void {
  _engine = null;
  _registry = null;
  _target = null;
}
