/**
 * SSH Science Runner for ProtClaw
 *
 * Executes science tool adapters on a remote GPU server via SSH,
 * replacing Docker-based execution. Uses rsync for file transfer
 * and SSH for remote command execution.
 *
 * The adapter protocol (entrypoint.py + adapter.py) is container-agnostic:
 * same code runs whether invoked via Docker or SSH.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ScienceRunConfig, ScienceRunResult } from './science-runner.js';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

export interface SshRunnerConfig {
  /** SSH host (user@hostname) */
  sshHost: string;
  /** SSH port */
  sshPort: number;
  /** Remote base directory for protclaw code and workspace */
  remoteBase: string;
  /** Remote conda environments base path */
  remoteCondaBase: string;
  /** Local path to workers/science-python/ for code sync */
  localAdapterCodePath: string;
  /** Number of available GPUs (for round-robin allocation) */
  numGpus: number;
}

/** Map tool names to their conda environment names */
const TOOL_ENV_MAP: Record<string, string> = {
  rfdiffusion: 'protclaw-rfdiffusion',
  proteinmpnn: 'protclaw-mpnn',
  esmfold: 'protclaw-esmfold',
  structure_qc: 'protclaw-cpu',
  'structure-qc': 'protclaw-cpu',
  developability_check: 'protclaw-cpu',
  developability: 'protclaw-cpu',
  candidate_ops: 'protclaw-cpu',
  'candidate-ops': 'protclaw-cpu',
  experiment_package: 'protclaw-cpu',
  'experiment-package': 'protclaw-cpu',
};

/** Tools that require GPU */
const GPU_TOOLS = new Set(['rfdiffusion', 'proteinmpnn', 'esmfold']);

/* ------------------------------------------------------------------ */
/*  GPU Allocator                                                      */
/* ------------------------------------------------------------------ */

class GpuAllocator {
  private inUse = new Set<number>();
  private numGpus: number;

  constructor(numGpus: number) {
    this.numGpus = numGpus;
  }

  /** Acquire a free GPU index. Returns -1 if none available. */
  acquire(): number {
    for (let i = 0; i < this.numGpus; i++) {
      if (!this.inUse.has(i)) {
        this.inUse.add(i);
        return i;
      }
    }
    return -1;
  }

  /** Release a GPU index back to the pool. */
  release(gpuId: number): void {
    this.inUse.delete(gpuId);
  }
}

/* ------------------------------------------------------------------ */
/*  SSH Runner                                                         */
/* ------------------------------------------------------------------ */

/** Resolve config from env vars with sensible defaults */
function resolveConfig(): SshRunnerConfig {
  return {
    sshHost: process.env.SSH_HOST || 'root@connect.singapore-b.gpuhub.com',
    sshPort: parseInt(process.env.SSH_PORT || '43159', 10),
    remoteBase: process.env.REMOTE_BASE || '/root/protclaw',
    remoteCondaBase: process.env.REMOTE_CONDA || '/root/autodl-tmp/envs',
    localAdapterCodePath:
      process.env.LOCAL_ADAPTER_PATH ||
      path.resolve(process.cwd(), '../../workers/science-python'),
    numGpus: parseInt(process.env.NUM_GPUS || '4', 10),
  };
}

let _gpuAllocator: GpuAllocator | null = null;
let _codeSynced = false;

function getGpuAllocator(config: SshRunnerConfig): GpuAllocator {
  if (!_gpuAllocator) {
    _gpuAllocator = new GpuAllocator(config.numGpus);
  }
  return _gpuAllocator;
}

/** Build SSH command args */
function sshArgs(config: SshRunnerConfig): string[] {
  return [
    '-p', String(config.sshPort),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
  ];
}

/** Build rsync SSH flag */
function rsyncSshFlag(config: SshRunnerConfig): string {
  return `ssh -p ${config.sshPort} -o StrictHostKeyChecking=no -o BatchMode=yes`;
}

/** Sync adapter code to remote server (once per session) */
async function syncAdapterCode(config: SshRunnerConfig): Promise<void> {
  if (_codeSynced) return;

  await execFileAsync('rsync', [
    '-az', '--delete',
    '-e', rsyncSshFlag(config),
    `${config.localAdapterCodePath}/`,
    `${config.sshHost}:${config.remoteBase}/`,
  ], { timeout: 60_000 });

  _codeSynced = true;
}

/**
 * Run a science tool on a remote GPU server via SSH.
 *
 * Drop-in replacement for runScienceContainer() — same interface.
 */
export async function runSshScience(
  runConfig: ScienceRunConfig,
): Promise<ScienceRunResult> {
  const startTime = Date.now();
  const config = resolveConfig();

  // Ensure directories exist locally
  fs.mkdirSync(path.join(runConfig.inputDir, 'files'), { recursive: true });
  fs.mkdirSync(path.join(runConfig.outputDir, 'files'), { recursive: true });

  // Write params.json locally
  const paramsPath = path.join(runConfig.inputDir, 'params.json');
  fs.writeFileSync(paramsPath, JSON.stringify(runConfig.params, null, 2));

  const remoteRunDir = `${config.remoteBase}/runs/${runConfig.runId}`;
  const remoteInputDir = `${remoteRunDir}/input`;
  const remoteOutputDir = `${remoteRunDir}/output`;

  // Resolve conda env
  const envName = TOOL_ENV_MAP[runConfig.toolName] || 'protclaw-cpu';
  const envPath = `${config.remoteCondaBase}/${envName}`;

  // Allocate GPU if needed
  const gpuAllocator = getGpuAllocator(config);
  let gpuId = -1;
  if (runConfig.gpuRequired && GPU_TOOLS.has(runConfig.toolName)) {
    gpuId = gpuAllocator.acquire();
    if (gpuId < 0) {
      // Fallback to GPU 0 if allocator is exhausted
      gpuId = 0;
    }
  }

  let stdout = '';
  let stderr = '';

  try {
    // 1. Sync adapter code (idempotent, once per session)
    await syncAdapterCode(config);

    // 2. Create remote run directory
    await execFileAsync('ssh', [
      ...sshArgs(config),
      config.sshHost,
      `mkdir -p ${remoteInputDir}/files ${remoteOutputDir}/files`,
    ], { timeout: 15_000 });

    // 3. rsync input files to remote
    await execFileAsync('rsync', [
      '-az',
      '-e', rsyncSshFlag(config),
      `${runConfig.inputDir}/`,
      `${config.sshHost}:${remoteInputDir}/`,
    ], { timeout: 60_000 });

    // 4. Execute on remote via SSH
    const envVars = [
      `PROTCLAW_INPUT_DIR=${remoteInputDir}`,
      `PROTCLAW_OUTPUT_DIR=${remoteOutputDir}`,
      `RFDIFFUSION_DIR=/root/repos/RFdiffusion`,
      `RFDIFFUSION_WEIGHTS=/root/autodl-tmp/models/rfdiffusion`,
      `PROTEINMPNN_DIR=/root/repos/ProteinMPNN`,
      `PROTEINMPNN_WEIGHTS=/root/autodl-tmp/models/proteinmpnn`,
      `HF_HOME=/root/autodl-tmp/cache/huggingface`,
    ];

    if (gpuId >= 0) {
      envVars.push(`CUDA_VISIBLE_DEVICES=${gpuId}`);
    }

    const remoteCmd = [
      `source /root/miniconda3/bin/activate ${envPath}`,
      `cd ${config.remoteBase}`,
      `${envVars.join(' ')} python -m common.entrypoint`,
    ].join(' && ');

    const timeoutMs = runConfig.timeoutSeconds * 1000;
    const result = await execFileAsync('ssh', [
      ...sshArgs(config),
      config.sshHost,
      remoteCmd,
    ], {
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024, // 50MB
    });

    stdout = result.stdout;
    stderr = result.stderr;

    // 5. rsync output files back
    await execFileAsync('rsync', [
      '-az',
      '-e', rsyncSshFlag(config),
      `${config.sshHost}:${remoteOutputDir}/`,
      `${runConfig.outputDir}/`,
    ], { timeout: 120_000 });

    // 6. Read result.json
    let parsedResult: Record<string, unknown> | null = null;
    const resultPath = path.join(runConfig.outputDir, 'result.json');
    try {
      if (fs.existsSync(resultPath)) {
        const resultText = fs.readFileSync(resultPath, 'utf-8');
        parsedResult = JSON.parse(resultText);
      }
    } catch {
      // result stays null
    }

    const durationSeconds = (Date.now() - startTime) / 1000;
    return {
      runId: runConfig.runId,
      exitCode: 0,
      stdout,
      stderr,
      result: parsedResult,
      durationSeconds,
    };
  } catch (error: unknown) {
    const durationSeconds = (Date.now() - startTime) / 1000;
    const errMsg = error instanceof Error ? error.message : String(error);

    // Try to recover result.json even on failure (might have been rsynced)
    let parsedResult: Record<string, unknown> | null = null;
    try {
      // Try rsyncing output back even on error
      await execFileAsync('rsync', [
        '-az',
        '-e', rsyncSshFlag(config),
        `${config.sshHost}:${remoteOutputDir}/`,
        `${runConfig.outputDir}/`,
      ], { timeout: 30_000 }).catch(() => { /* ignore rsync failure */ });

      const resultPath = path.join(runConfig.outputDir, 'result.json');
      if (fs.existsSync(resultPath)) {
        const resultText = fs.readFileSync(resultPath, 'utf-8');
        parsedResult = JSON.parse(resultText);
      }
    } catch {
      // ignore
    }

    return {
      runId: runConfig.runId,
      exitCode: 1,
      stdout,
      stderr: `${stderr}\nSSH runner error: ${errMsg}`,
      result: parsedResult,
      durationSeconds,
    };
  } finally {
    // Release GPU
    if (gpuId >= 0) {
      gpuAllocator.release(gpuId);
    }

    // 7. Cleanup remote run directory (fire-and-forget)
    execFileAsync('ssh', [
      ...sshArgs(config),
      config.sshHost,
      `rm -rf ${remoteRunDir}`,
    ], { timeout: 15_000 }).catch(() => { /* ignore cleanup failure */ });
  }
}

/**
 * Reset module state (for testing).
 */
export function _resetSshRunner(): void {
  _gpuAllocator = null;
  _codeSynced = false;
}
