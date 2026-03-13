/**
 * Shell Executor for ProtClaw
 *
 * Abstracts shell command execution across local and SSH targets.
 * Both provisioner and execution engine use this interface to run commands
 * without knowing whether they're local or remote.
 *
 * Uses execFile (not exec) to avoid shell injection — commands are passed
 * as arguments to bash/ssh, not interpolated into a shell string.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
  maxBuffer?: number;
}

export interface ShellExecutor {
  /** Execute a shell command. */
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;

  /** Copy files between local and target. */
  syncFiles(
    src: string,
    dst: string,
    direction: 'push' | 'pull',
  ): Promise<void>;

  /** Check if a file or directory exists on the target. */
  fileExists(remotePath: string): Promise<boolean>;

  /** Read a file from the target. Returns undefined if not found. */
  readFile(remotePath: string): Promise<string | undefined>;

  /** Get the executor type. */
  readonly type: 'local' | 'ssh';
}

/* ------------------------------------------------------------------ */
/*  Local Executor                                                     */
/* ------------------------------------------------------------------ */

export class LocalShellExecutor implements ShellExecutor {
  readonly type = 'local' as const;

  async exec(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    try {
      // execFile with ['bash', '-c', cmd] — cmd is a single argument, not interpolated
      const result = await execFileAsync('bash', ['-c', cmd], {
        timeout: opts?.timeout ?? 120_000,
        cwd: opts?.cwd,
        env: opts?.env ? { ...process.env, ...opts.env } : undefined,
        maxBuffer: opts?.maxBuffer ?? 50 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'stdout' in error) {
        const execErr = error as { stdout: string; stderr: string; code?: number };
        return {
          stdout: execErr.stdout ?? '',
          stderr: execErr.stderr ?? '',
          exitCode: execErr.code ?? 1,
        };
      }
      throw error;
    }
  }

  async syncFiles(src: string, dst: string, _direction: 'push' | 'pull'): Promise<void> {
    // Local: just copy recursively
    const srcResolved = path.resolve(src);
    const dstResolved = path.resolve(dst);
    if (srcResolved === dstResolved) return;

    fs.mkdirSync(path.dirname(dstResolved), { recursive: true });
    await execFileAsync('cp', ['-r', srcResolved, dstResolved], { timeout: 60_000 });
  }

  async fileExists(localPath: string): Promise<boolean> {
    return fs.existsSync(localPath);
  }

  async readFile(localPath: string): Promise<string | undefined> {
    try {
      return fs.readFileSync(localPath, 'utf-8');
    } catch {
      return undefined;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  SSH Executor                                                       */
/* ------------------------------------------------------------------ */

export interface SshConfig {
  host: string;
  port: number;
}

export class SshShellExecutor implements ShellExecutor {
  readonly type = 'ssh' as const;

  constructor(private ssh: SshConfig) {}

  private sshArgs(): string[] {
    return [
      '-p', String(this.ssh.port),
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
    ];
  }

  private rsyncSshFlag(): string {
    return `ssh -p ${this.ssh.port} -o StrictHostKeyChecking=no -o BatchMode=yes`;
  }

  async exec(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    try {
      // execFile passes cmd as a single SSH argument — no shell interpolation
      const result = await execFileAsync('ssh', [
        ...this.sshArgs(),
        this.ssh.host,
        cmd,
      ], {
        timeout: opts?.timeout ?? 120_000,
        maxBuffer: opts?.maxBuffer ?? 50 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'stdout' in error) {
        const execErr = error as { stdout: string; stderr: string; code?: number };
        return {
          stdout: execErr.stdout ?? '',
          stderr: execErr.stderr ?? '',
          exitCode: execErr.code ?? 1,
        };
      }
      throw error;
    }
  }

  async syncFiles(src: string, dst: string, direction: 'push' | 'pull'): Promise<void> {
    const rsyncArgs = [
      '-az', '--delete',
      '-e', this.rsyncSshFlag(),
    ];

    if (direction === 'push') {
      rsyncArgs.push(`${src}/`, `${this.ssh.host}:${dst}/`);
    } else {
      rsyncArgs.push(`${this.ssh.host}:${src}/`, `${dst}/`);
    }

    await execFileAsync('rsync', rsyncArgs, { timeout: 120_000 });
  }

  async fileExists(remotePath: string): Promise<boolean> {
    const result = await this.exec(`test -e ${remotePath} && echo yes || echo no`);
    return result.stdout.trim() === 'yes';
  }

  async readFile(remotePath: string): Promise<string | undefined> {
    const result = await this.exec(`cat ${remotePath} 2>/dev/null`);
    if (result.exitCode !== 0) return undefined;
    return result.stdout;
  }
}

/* ------------------------------------------------------------------ */
/*  Target Config Types                                                */
/* ------------------------------------------------------------------ */

export interface TargetConfig {
  name: string;
  type: 'local' | 'ssh';
  ssh?: { host: string; port: number };
  compute: {
    backend: 'cuda' | 'mps' | 'cpu' | 'auto';
    cuda_version?: string;
    gpus: number;
    gpu_vram_gb?: number;
    ram_gb?: number;
  };
  paths?: Partial<{
    base: string;
    envs: string;
    repos: string;
    models: string;
    cache: string;
    conda: string;
  }>;
  scheduling?: {
    max_gpu_concurrent?: number;
    max_cpu_concurrent?: number;
  };
}

export interface ResolvedPaths {
  base: string;
  envs: string;
  repos: string;
  models: string;
  cache: string;
  conda: string;
}

/** Infer default paths based on target type. User overrides take precedence. */
export function inferPaths(target: TargetConfig): ResolvedPaths {
  const overrides = target.paths ?? {};

  if (target.type === 'local') {
    const home = process.env.HOME ?? '/tmp';
    const base = overrides.base ?? path.join(home, '.protclaw');
    return {
      base,
      envs: overrides.envs ?? path.join(base, 'envs'),
      repos: overrides.repos ?? path.join(base, 'repos'),
      models: overrides.models ?? path.join(base, 'models'),
      cache: overrides.cache ?? path.join(home, '.cache', 'protclaw'),
      conda: overrides.conda ?? detectCondaActivate(),
    };
  }

  // SSH: use conventional paths
  const sshUser = target.ssh?.host?.split('@')[0] ?? 'root';
  const homeDir = sshUser === 'root' ? '/root' : `/home/${sshUser}`;
  const base = overrides.base ?? `${homeDir}/protclaw`;
  return {
    base,
    envs: overrides.envs ?? `${base}/envs`,
    repos: overrides.repos ?? `${base}/repos`,
    models: overrides.models ?? `${base}/models`,
    cache: overrides.cache ?? `${base}/cache`,
    conda: overrides.conda ?? `${homeDir}/miniconda3/bin/activate`,
  };
}

function detectCondaActivate(): string {
  const home = process.env.HOME ?? '';
  const candidates = [
    path.join(home, 'miniconda3/bin/activate'),
    path.join(home, 'anaconda3/bin/activate'),
    '/opt/homebrew/Caskroom/miniconda/base/bin/activate',
    '/usr/local/miniconda3/bin/activate',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.join(home, 'miniconda3/bin/activate');
}

/** Create a ShellExecutor for a target config. */
export function createExecutor(target: TargetConfig): ShellExecutor {
  if (target.type === 'ssh') {
    if (!target.ssh) throw new Error(`SSH target "${target.name}" missing ssh config`);
    return new SshShellExecutor({ host: target.ssh.host, port: target.ssh.port });
  }
  return new LocalShellExecutor();
}
