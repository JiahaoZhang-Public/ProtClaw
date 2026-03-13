#!/usr/bin/env npx tsx
/**
 * ProtClaw CLI — Direct provisioning and skill execution
 *
 * Usage:
 *   npx tsx apps/orchestrator/src/protclaw-cli.ts provision [--target NAME] [--skill NAME] [--dry-run]
 *   npx tsx apps/orchestrator/src/protclaw-cli.ts run-skill SKILL_NAME [--target NAME] [--params JSON]
 *   npx tsx apps/orchestrator/src/protclaw-cli.ts run-pipeline TOOLKIT_NAME [--target NAME]
 *   npx tsx apps/orchestrator/src/protclaw-cli.ts targets
 *
 * This CLI is independent of the NanoClaw agent flow — it lets users
 * directly provision targets and run skills for validation/testing.
 */

import path from 'node:path';

import { SkillRegistry } from './skill-registry.js';
import { Provisioner } from './provisioner.js';
import { createEngine } from './execution-engine.js';
import { ResourceScheduler } from './resource-scheduler.js';
import { loadTarget, loadAllTargets } from './target-loader.js';
import { executePipeline } from './pipeline-builder.js';
import type { SkillRunConfig } from './dag-executor.js';

/* ------------------------------------------------------------------ */
/*  CLI parsing                                                        */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

/* ------------------------------------------------------------------ */
/*  Shared setup                                                       */
/* ------------------------------------------------------------------ */

const WORKERS_DIR = path.resolve(process.cwd(), '../../workers/science-python');
const TOOLS_DIR = path.join(WORKERS_DIR, 'tools');

function loadRegistry(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.loadAll(TOOLS_DIR);
  return registry;
}

/* ------------------------------------------------------------------ */
/*  Command: targets                                                   */
/* ------------------------------------------------------------------ */

async function cmdTargets(): Promise<void> {
  const targets = loadAllTargets();

  console.log('\n=== ProtClaw Targets ===\n');
  for (const [name, target] of targets) {
    const type = target.type.toUpperCase();
    const backend = target.compute.backend;
    const gpus = target.compute.gpus;
    const host = target.ssh ? `${target.ssh.host}:${target.ssh.port}` : 'localhost';
    console.log(`  ${name} [${type}] — ${backend}, ${gpus} GPU(s) @ ${host}`);
  }
  console.log('');
}

/* ------------------------------------------------------------------ */
/*  Command: provision                                                 */
/* ------------------------------------------------------------------ */

async function cmdProvision(): Promise<void> {
  const targetName = getFlag('target');
  const skillFilter = getFlag('skill');
  const dryRun = hasFlag('dry-run');

  const target = loadTarget(targetName);
  const registry = loadRegistry();

  console.log(`\n=== Provisioning target: ${target.name} (${target.type}) ===`);
  console.log(`Backend: ${target.compute.backend}, GPUs: ${target.compute.gpus}`);
  if (dryRun) console.log('Mode: DRY RUN (no commands will be executed)\n');

  const provisioner = new Provisioner(registry, target);

  const prefix = dryRun ? '[DRY-RUN]' : '[PROVISION]';
  const result = await provisioner.provision({
    skills: skillFilter ? [skillFilter] : undefined,
    dryRun,
    onProgress: (event) => {
      console.log(`${prefix} [${event.phase}] ${event.message}`);
      if (dryRun && event.command) {
        console.log(`  $ ${event.command}`);
      }
    },
  });

  if (result.envsCreated.length > 0) console.log(`Envs: ${result.envsCreated.join(', ')}`);
  if (result.reposCloned.length > 0) console.log(`Repos: ${result.reposCloned.join(', ')}`);
  if (result.modelsDownloaded.length > 0) console.log(`Models: ${result.modelsDownloaded.join(', ')}`);
  if (result.patchesApplied.length > 0) console.log(`Patches: ${result.patchesApplied.join(', ')}`);
  if (result.errors.length > 0) {
    console.error(`Errors:\n  ${result.errors.join('\n  ')}`);
  }

  console.log('\n=== Provisioning complete ===\n');
}

/* ------------------------------------------------------------------ */
/*  Command: run-skill                                                 */
/* ------------------------------------------------------------------ */

async function cmdRunSkill(): Promise<void> {
  const skillName = args[1];
  if (!skillName) {
    console.error('Usage: protclaw-cli run-skill SKILL_NAME [--target NAME] [--params JSON]');
    process.exit(1);
  }

  const targetName = getFlag('target');
  const paramsStr = getFlag('params');
  const params = paramsStr ? JSON.parse(paramsStr) : {};

  const target = loadTarget(targetName);
  const registry = loadRegistry();

  const skill = registry.getSkill(skillName);
  if (!skill) {
    console.error(`Skill "${skillName}" not found. Available: ${registry.getSkillNames().join(', ')}`);
    process.exit(1);
  }

  console.log(`\n=== Running skill: ${skillName} on ${target.name} ===`);
  console.log(`Params: ${JSON.stringify(params)}\n`);

  const engine = createEngine(target, registry, WORKERS_DIR);

  const config: SkillRunConfig = {
    skillName,
    nodeId: `cli-${Date.now()}`,
    params,
    gpuId: skill.resources.gpu !== 'none' ? 0 : -1,
    isCpuFallback: skill.resources.gpu === 'none',
  };

  const startTime = Date.now();
  const result = await engine.execute(config);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n=== Result (${elapsed}s) ===`);
  console.log(`Status: ${result.status}`);
  if (result.outputFiles.length > 0) {
    console.log(`Output files: ${result.outputFiles.join(', ')}`);
  }
  if (Object.keys(result.metrics).length > 0) {
    console.log(`Metrics: ${JSON.stringify(result.metrics, null, 2)}`);
  }
  if (result.errors.length > 0) {
    console.error(`Errors: ${result.errors.join('\n')}`);
  }
  console.log('');

  process.exit(result.status === 'success' ? 0 : 1);
}

/* ------------------------------------------------------------------ */
/*  Command: run-pipeline                                              */
/* ------------------------------------------------------------------ */

async function cmdRunPipeline(): Promise<void> {
  const toolkitName = args[1] || 'de-novo';
  const targetName = getFlag('target');
  const paramsStr = getFlag('params');
  const params = paramsStr ? JSON.parse(paramsStr) : {};

  const target = loadTarget(targetName);
  const registry = loadRegistry();

  console.log(`\n=== Running pipeline: ${toolkitName} on ${target.name} ===\n`);

  const scheduler = new ResourceScheduler(target);
  const engine = createEngine(target, registry, WORKERS_DIR);

  console.log(`Schedule: ${scheduler.strategy.mode} (GPU:${scheduler.strategy.gpuConcurrency}, CPU:${scheduler.strategy.cpuConcurrency})\n`);

  const result = await executePipeline(toolkitName, params, {
    engine,
    registry,
    scheduler,
    toolkitDir: path.resolve(process.cwd(), '../../toolkits'),
    pipelineDir: path.resolve(process.cwd(), '../../projects/_pipelines'),
  }, {
    onNodeStart: (nodeId, skillName, resources) => {
      const device = resources.gpuId >= 0 ? `GPU:${resources.gpuId}` : 'CPU';
      console.log(`▶ ${nodeId} (${skillName}) started on ${device}`);
    },
    onNodeComplete: (nodeId, res) => {
      console.log(`✓ ${nodeId} completed (${res.durationSeconds.toFixed(1)}s)`);
    },
    onNodeFailed: (nodeId, error) => {
      console.error(`✗ ${nodeId} failed: ${error}`);
    },
  });

  const completedNodes = [...result.nodeResults.keys()];
  console.log(`\n=== Pipeline ${result.status} (${result.durationSeconds.toFixed(1)}s) ===`);
  console.log(`Completed: ${completedNodes.join(', ') || 'none'}`);
  if (result.failedNodes.length > 0) {
    console.log(`Failed: ${result.failedNodes.join(', ')}`);
  }
  console.log('');

  process.exit(result.status === 'success' ? 0 : 1);
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  switch (command) {
    case 'targets':
      return cmdTargets();
    case 'provision':
      return cmdProvision();
    case 'run-skill':
      return cmdRunSkill();
    case 'run-pipeline':
      return cmdRunPipeline();
    default:
      console.log(`
ProtClaw CLI — Direct provisioning and execution

Commands:
  targets                             List configured targets
  provision [--target T] [--skill S]  Provision target environments
  run-skill SKILL [--target T]        Run a single skill
  run-pipeline [TOOLKIT] [--target T] Run a toolkit pipeline

Options:
  --target NAME     Target name from .protclaw/targets.yaml
  --skill NAME      Filter provisioning to a single skill
  --dry-run         Show commands without executing
  --params JSON     Parameters for run-skill (JSON string)
`);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
