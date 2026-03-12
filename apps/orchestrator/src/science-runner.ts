/**
 * Science Runner for ProtClaw
 *
 * Spawns science tool containers (RFdiffusion, ProteinMPNN, ESMFold, etc.)
 * with proper volume mounts, GPU passthrough, and timeout handling.
 *
 * Unlike the agent container runner (container-runner.ts), this runner is
 * purpose-built for science execution: it writes params.json, mounts
 * input/output directories, and reads structured result.json output.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface ScienceRunConfig {
  /** Unique run identifier */
  runId: string;
  /** Tool name (e.g., "rfdiffusion", "proteinmpnn") */
  toolName: string;
  /** Docker image to use (e.g., "protclaw-rfdiffusion:1.1.0") */
  dockerImage: string;
  /** Whether this tool requires GPU */
  gpuRequired: boolean;
  /** Host directory with input files */
  inputDir: string;
  /** Host directory for output files */
  outputDir: string;
  /** Execution timeout in seconds */
  timeoutSeconds: number;
  /** Parameters to pass to the adapter */
  params: Record<string, unknown>;
}

export interface ScienceRunResult {
  /** Unique run identifier */
  runId: string;
  /** Container exit code */
  exitCode: number;
  /** Container stdout */
  stdout: string;
  /** Container stderr */
  stderr: string;
  /** Parsed result from result.json, or null on failure */
  result: Record<string, unknown> | null;
  /** Wall-clock execution time in seconds */
  durationSeconds: number;
}

/**
 * Detect the container runtime binary (docker or podman).
 * Prefers CONTAINER_RUNTIME env var, then defaults to "docker".
 */
function getContainerRuntime(): string {
  return process.env.CONTAINER_RUNTIME || 'docker';
}

/**
 * Run a science tool in a Docker container.
 *
 * 1. Writes params.json to inputDir
 * 2. Builds docker run command with volume mounts
 * 3. Adds --gpus all if gpuRequired
 * 4. Sets timeout
 * 5. Spawns container, captures stdout/stderr
 * 6. Reads result.json from outputDir
 * 7. Returns ScienceRunResult
 */
export async function runScienceContainer(
  config: ScienceRunConfig,
): Promise<ScienceRunResult> {
  const startTime = Date.now();

  // Ensure directories exist
  fs.mkdirSync(path.join(config.inputDir, 'files'), { recursive: true });
  fs.mkdirSync(path.join(config.outputDir, 'files'), { recursive: true });

  // 1. Write params.json to inputDir
  const paramsPath = path.join(config.inputDir, 'params.json');
  fs.writeFileSync(paramsPath, JSON.stringify(config.params, null, 2));

  // 2. Build docker run command
  const containerRuntime = getContainerRuntime();
  const containerName = `protclaw-${config.toolName}-${config.runId}`;
  const args: string[] = [
    'run',
    '--rm',
    '--name',
    containerName,
  ];

  // 3. Add GPU support if required
  if (config.gpuRequired) {
    args.push('--gpus', 'all');
  }

  // Volume mounts: bind input and output directories
  args.push('-v', `${config.inputDir}:/workspace/input:ro`);
  args.push('-v', `${config.outputDir}:/workspace/output`);

  // Memory and CPU limits (sensible defaults)
  args.push('--memory', config.gpuRequired ? '32g' : '8g');
  args.push('--cpus', config.gpuRequired ? '8' : '4');

  // Container image
  args.push(config.dockerImage);

  // 4-5. Spawn container with timeout
  return new Promise<ScienceRunResult>((resolve) => {
    const container = spawn(containerRuntime, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    container.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    container.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Set timeout
    const timeoutMs = config.timeoutSeconds * 1000;
    const timeout = setTimeout(() => {
      timedOut = true;
      // Try graceful stop first, then force kill
      const kill = spawn(containerRuntime, ['stop', '-t', '10', containerName], {
        stdio: 'ignore',
      });
      kill.on('error', () => {
        container.kill('SIGKILL');
      });
    }, timeoutMs);

    container.on('close', (code) => {
      clearTimeout(timeout);
      const durationSeconds = (Date.now() - startTime) / 1000;
      const exitCode = code ?? 1;

      if (timedOut) {
        resolve({
          runId: config.runId,
          exitCode,
          stdout,
          stderr,
          result: null,
          durationSeconds,
        });
        return;
      }

      // 6. Read result.json from outputDir
      let result: Record<string, unknown> | null = null;
      const resultPath = path.join(config.outputDir, 'result.json');
      try {
        if (fs.existsSync(resultPath)) {
          const resultText = fs.readFileSync(resultPath, 'utf-8');
          result = JSON.parse(resultText);
        }
      } catch {
        // result stays null if we can't parse it
      }

      // 7. Return result
      resolve({
        runId: config.runId,
        exitCode,
        stdout,
        stderr,
        result,
        durationSeconds,
      });
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      const durationSeconds = (Date.now() - startTime) / 1000;
      resolve({
        runId: config.runId,
        exitCode: 1,
        stdout,
        stderr: `${stderr}\nSpawn error: ${err.message}`,
        result: null,
        durationSeconds,
      });
    });
  });
}
