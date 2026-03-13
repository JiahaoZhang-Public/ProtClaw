/**
 * Target Loader for ProtClaw
 *
 * Reads .protclaw/targets.yaml and returns TargetConfig objects.
 * Falls back to auto-detected local target if no config file found.
 */

import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import type { TargetConfig } from './shell-executor.js';

/**
 * Load all targets from .protclaw/targets.yaml.
 * Searches upward from cwd to find .protclaw/ directory.
 */
export function loadAllTargets(): Map<string, TargetConfig> {
  const configPath = findTargetsYaml();
  const targets = new Map<string, TargetConfig>();

  if (!configPath) {
    const local = autoDetectLocal();
    targets.set(local.name, local);
    return targets;
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = YAML.parse(raw) as { targets?: Record<string, Record<string, unknown>> };

  if (!parsed?.targets) {
    const local = autoDetectLocal();
    targets.set(local.name, local);
    return targets;
  }

  for (const [name, config] of Object.entries(parsed.targets)) {
    const rawCompute = config.compute as Record<string, unknown> | undefined;
    targets.set(name, {
      name,
      type: (config.type as string) ?? 'local',
      ssh: config.ssh,
      compute: {
        backend: rawCompute?.backend ?? 'auto',
        gpus: rawCompute?.gpus ?? 0,
        cuda_version: rawCompute?.cuda_version,
        gpu_vram_gb: rawCompute?.gpu_vram_gb,
        ram_gb: rawCompute?.ram_gb,
      },
      paths: config.paths,
      scheduling: config.scheduling,
    } as TargetConfig);
  }

  return targets;
}

/**
 * Load a specific target by name.
 * If name is not provided, returns the first SSH target or 'local'.
 */
export function loadTarget(name?: string): TargetConfig {
  const targets = loadAllTargets();

  if (name) {
    const target = targets.get(name);
    if (!target) {
      const available = [...targets.keys()].join(', ');
      throw new Error(`Target "${name}" not found. Available: ${available}`);
    }
    return target;
  }

  // Default: first SSH target, or local
  for (const t of targets.values()) {
    if (t.type === 'ssh') return t;
  }

  return targets.values().next().value!;
}

/**
 * Auto-detect local machine configuration.
 */
function autoDetectLocal(): TargetConfig {
  return {
    name: 'local',
    type: 'local',
    compute: {
      backend: 'auto',
      gpus: 0,
    },
  };
}

/**
 * Search for .protclaw/targets.yaml starting from cwd.
 */
function findTargetsYaml(): string | undefined {
  let dir = process.cwd();
  const root = path.parse(dir).root;

  while (dir !== root) {
    const candidate = path.join(dir, '.protclaw', 'targets.yaml');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }

  return undefined;
}
