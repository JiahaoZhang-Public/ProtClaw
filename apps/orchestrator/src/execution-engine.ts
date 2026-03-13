/**
 * Execution Engines for ProtClaw
 *
 * Unified interface for running science skills on local or SSH targets.
 * Both engines follow the same protocol:
 *
 * 1. Create temp workdir (input/ + output/ dirs)
 * 2. Write params.json with _adapter_module
 * 3. Activate conda env → run `python -m common.entrypoint`
 * 4. Read result.json from output/
 * 5. Clean up workdir
 *
 * LocalExecutionEngine: subprocess directly, no rsync needed.
 * SshExecutionEngine: rsync input → SSH execute → rsync output back.
 *
 * All commands go through ShellExecutor which uses execFile internally
 * (not child_process.exec) to avoid shell injection vulnerabilities.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { ShellExecutor, TargetConfig, ResolvedPaths } from './shell-executor.js';
import type { SkillRunConfig, SkillRunResult, ExecutionEngine } from './dag-executor.js';
import { SkillRegistry } from './skill-registry.js';
import { createExecutor, inferPaths } from './shell-executor.js';

/* ------------------------------------------------------------------ */
/*  Skill → adapter module mapping                                     */
/* ------------------------------------------------------------------ */

/**
 * Convert a skill name to its Python adapter module path.
 * Convention: tools/{skillName}/adapter → tools.{skillName}.adapter
 */
function adapterModule(skillName: string): string {
  return `tools.${skillName}.adapter`;
}

/* ------------------------------------------------------------------ */
/*  Local Execution Engine                                             */
/* ------------------------------------------------------------------ */

export class LocalExecutionEngine implements ExecutionEngine {
  private registry: SkillRegistry;
  private paths: ResolvedPaths;
  private shellExecutor: ShellExecutor;
  private workersDir: string;

  constructor(
    target: TargetConfig,
    registry: SkillRegistry,
    workersDir: string,
    shellExecutor?: ShellExecutor,
  ) {
    this.registry = registry;
    this.paths = inferPaths(target);
    this.shellExecutor = shellExecutor ?? createExecutor(target);
    this.workersDir = workersDir;
  }

  async execute(config: SkillRunConfig): Promise<SkillRunResult> {
    const startTime = Date.now();
    const runId = crypto.randomUUID().slice(0, 8);

    // Create local workdir
    const workdir = path.join(this.paths.cache, 'runs', `${config.nodeId}-${runId}`);
    const inputDir = path.join(workdir, 'input');
    const outputDir = path.join(workdir, 'output');
    fs.mkdirSync(path.join(inputDir, 'files'), { recursive: true });
    fs.mkdirSync(path.join(outputDir, 'files'), { recursive: true });

    // Write params.json
    const params = {
      ...config.params,
      _adapter_module: adapterModule(config.skillName),
    };
    fs.writeFileSync(
      path.join(inputDir, 'params.json'),
      JSON.stringify(params, null, 2),
    );

    // Resolve env and runtime vars
    const envName = this.registry.getEnvName(config.skillName);
    const envPath = `${this.paths.envs}/${envName}`;
    const runtimeEnv = this.registry.resolveRuntimeEnv(config.skillName, this.paths);

    // Build environment variables
    const envVars: string[] = [
      `PROTCLAW_INPUT_DIR=${inputDir}`,
      `PROTCLAW_OUTPUT_DIR=${outputDir}`,
    ];

    if (config.gpuId >= 0) {
      envVars.push(`CUDA_VISIBLE_DEVICES=${config.gpuId}`);
    }

    for (const [key, value] of Object.entries(runtimeEnv)) {
      envVars.push(`${key}=${value}`);
    }

    // Execute via ShellExecutor (uses execFile internally, not child_process.exec)
    const cmd = [
      `source ${this.paths.conda} ${envPath}`,
      `cd ${this.workersDir}`,
      `${envVars.join(' ')} python -m common.entrypoint`,
    ].join(' && ');

    const shellResult = await this.shellExecutor.exec(cmd, {
      timeout: 1800_000, // 30 min default
    });

    // Read result.json
    const result = this.readResult(outputDir, config, startTime, shellResult.stdout, shellResult.stderr);

    // Cleanup workdir (fire-and-forget)
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }

    return result;
  }

  private readResult(
    outputDir: string,
    config: SkillRunConfig,
    startTime: number,
    stdout: string,
    stderr: string,
  ): SkillRunResult {
    const resultPath = path.join(outputDir, 'result.json');
    const durationSeconds = (Date.now() - startTime) / 1000;

    try {
      if (fs.existsSync(resultPath)) {
        const raw = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
        return {
          status: raw.status ?? 'failed',
          outputFiles: raw.output_files ?? [],
          metrics: raw.metrics ?? {},
          errors: raw.errors ?? [],
          durationSeconds: raw.duration_seconds ?? durationSeconds,
        };
      }
    } catch {
      // fall through
    }

    return {
      status: 'failed',
      outputFiles: [],
      metrics: {},
      errors: [`No result.json found. stdout: ${stdout.slice(-500)}, stderr: ${stderr.slice(-500)}`],
      durationSeconds,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  SSH Execution Engine                                               */
/* ------------------------------------------------------------------ */

export class SshExecutionEngine implements ExecutionEngine {
  private registry: SkillRegistry;
  private paths: ResolvedPaths;
  private shellExecutor: ShellExecutor;
  private target: TargetConfig;
  private workersDir: string;
  private codeSynced = false;

  constructor(
    target: TargetConfig,
    registry: SkillRegistry,
    workersDir: string,
    shellExecutor?: ShellExecutor,
  ) {
    this.target = target;
    this.registry = registry;
    this.paths = inferPaths(target);
    this.shellExecutor = shellExecutor ?? createExecutor(target);
    this.workersDir = workersDir;
  }

  async execute(config: SkillRunConfig): Promise<SkillRunResult> {
    const startTime = Date.now();
    const runId = crypto.randomUUID().slice(0, 8);

    // Local temp dirs for staging
    const localWorkdir = path.join(
      process.env.HOME ?? '/tmp',
      '.protclaw', 'staging', `${config.nodeId}-${runId}`,
    );
    const localInputDir = path.join(localWorkdir, 'input');
    const localOutputDir = path.join(localWorkdir, 'output');
    fs.mkdirSync(path.join(localInputDir, 'files'), { recursive: true });
    fs.mkdirSync(path.join(localOutputDir, 'files'), { recursive: true });

    // Remote paths
    const remoteRunDir = `${this.paths.base}/runs/${config.nodeId}-${runId}`;
    const remoteInputDir = `${remoteRunDir}/input`;
    const remoteOutputDir = `${remoteRunDir}/output`;

    // Write params.json locally
    const params = {
      ...config.params,
      _adapter_module: adapterModule(config.skillName),
    };
    fs.writeFileSync(
      path.join(localInputDir, 'params.json'),
      JSON.stringify(params, null, 2),
    );

    try {
      // 1. Sync adapter code (once per session)
      await this.syncAdapterCode();

      // 2. Create remote dirs
      await this.shellExecutor.exec(
        `mkdir -p ${remoteInputDir}/files ${remoteOutputDir}/files`,
        { timeout: 15_000 },
      );

      // 3. Push input files
      await this.shellExecutor.syncFiles(localInputDir, remoteInputDir, 'push');

      // 4. Execute remotely via ShellExecutor (uses execFile internally)
      const envName = this.registry.getEnvName(config.skillName);
      const envPath = `${this.paths.envs}/${envName}`;
      const runtimeEnv = this.registry.resolveRuntimeEnv(config.skillName, this.paths);

      const envVars: string[] = [
        `PROTCLAW_INPUT_DIR=${remoteInputDir}`,
        `PROTCLAW_OUTPUT_DIR=${remoteOutputDir}`,
      ];

      if (config.gpuId >= 0) {
        envVars.push(`CUDA_VISIBLE_DEVICES=${config.gpuId}`);
      }

      for (const [key, value] of Object.entries(runtimeEnv)) {
        envVars.push(`${key}=${value}`);
      }

      const remoteCmd = [
        `source ${this.paths.conda} ${envPath}`,
        `cd ${this.paths.base}`,
        `${envVars.join(' ')} python -m common.entrypoint`,
      ].join(' && ');

      await this.shellExecutor.exec(remoteCmd, { timeout: 1800_000 });

      // 5. Pull output files back
      await this.shellExecutor.syncFiles(remoteOutputDir, localOutputDir, 'pull');

      // 6. Read result
      return this.readResult(localOutputDir, startTime);
    } catch (error) {
      // Try to recover result.json
      try {
        await this.shellExecutor.syncFiles(remoteOutputDir, localOutputDir, 'pull');
      } catch {
        // ignore
      }

      const partial = this.readResult(localOutputDir, startTime);
      if (partial.status === 'success') return partial;

      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        status: 'failed',
        outputFiles: [],
        metrics: {},
        errors: [`SSH run error: ${errMsg}`],
        durationSeconds: (Date.now() - startTime) / 1000,
      };
    } finally {
      // Cleanup remote run dir (fire-and-forget)
      this.shellExecutor.exec(`rm -rf ${remoteRunDir}`, { timeout: 15_000 }).catch(() => {});

      // Cleanup local staging
      try {
        fs.rmSync(localWorkdir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  private async syncAdapterCode(): Promise<void> {
    if (this.codeSynced) return;

    await this.shellExecutor.syncFiles(this.workersDir, this.paths.base, 'push');
    this.codeSynced = true;
  }

  private readResult(outputDir: string, startTime: number): SkillRunResult {
    const resultPath = path.join(outputDir, 'result.json');
    const durationSeconds = (Date.now() - startTime) / 1000;

    try {
      if (fs.existsSync(resultPath)) {
        const raw = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
        return {
          status: raw.status ?? 'failed',
          outputFiles: raw.output_files ?? [],
          metrics: raw.metrics ?? {},
          errors: raw.errors ?? [],
          durationSeconds: raw.duration_seconds ?? durationSeconds,
        };
      }
    } catch {
      // fall through
    }

    return {
      status: 'failed',
      outputFiles: [],
      metrics: {},
      errors: ['No result.json found'],
      durationSeconds,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Create the appropriate execution engine for a target.
 */
export function createEngine(
  target: TargetConfig,
  registry: SkillRegistry,
  workersDir: string,
  shellExecutor?: ShellExecutor,
): ExecutionEngine {
  if (target.type === 'ssh') {
    return new SshExecutionEngine(target, registry, workersDir, shellExecutor);
  }
  return new LocalExecutionEngine(target, registry, workersDir, shellExecutor);
}
