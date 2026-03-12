/**
 * Science Queue for ProtClaw
 *
 * Manages concurrent execution of science tool containers with separate
 * GPU and CPU queues. Enforces concurrency limits (e.g., 1 GPU container
 * at a time, 4 CPU containers) and priority-based scheduling.
 */

import {
  runScienceContainer,
  type ScienceRunConfig,
  type ScienceRunResult,
} from './science-runner.js';

export interface QueuedRun {
  /** Unique run identifier */
  runId: string;
  /** Run configuration */
  config: ScienceRunConfig;
  /** Priority (higher number = higher priority) */
  priority: number;
  /** Whether this run needs GPU */
  gpuRequired: boolean;
  /** Promise resolve callback */
  resolve: (result: ScienceRunResult) => void;
  /** Promise reject callback */
  reject: (error: Error) => void;
}

export interface QueueStatus {
  /** Number of active GPU containers */
  gpuActive: number;
  /** Number of active CPU containers */
  cpuActive: number;
  /** Number of queued GPU runs */
  gpuQueued: number;
  /** Number of queued CPU runs */
  cpuQueued: number;
}

export class ScienceQueue {
  private gpuQueue: QueuedRun[] = [];
  private cpuQueue: QueuedRun[] = [];
  private activeGpu = 0;
  private activeCpu = 0;
  private maxGpuContainers: number;
  private maxCpuContainers: number;

  /**
   * The runner function to use for executing containers.
   * Defaults to the real runScienceContainer, but can be overridden for testing.
   */
  private runner: (
    config: ScienceRunConfig,
  ) => Promise<ScienceRunResult>;

  constructor(
    maxGpuContainers: number = 1,
    maxCpuContainers: number = 4,
    runner?: (config: ScienceRunConfig) => Promise<ScienceRunResult>,
  ) {
    this.maxGpuContainers = maxGpuContainers;
    this.maxCpuContainers = maxCpuContainers;
    this.runner = runner ?? runScienceContainer;
  }

  /**
   * Submit a science run to the queue.
   * Returns a promise that resolves when the run completes.
   */
  submit(
    config: ScienceRunConfig,
    priority: number = 0,
  ): Promise<ScienceRunResult> {
    return new Promise<ScienceRunResult>((resolve, reject) => {
      const queued: QueuedRun = {
        runId: config.runId,
        config,
        priority,
        gpuRequired: config.gpuRequired,
        resolve,
        reject,
      };

      if (config.gpuRequired) {
        this.gpuQueue.push(queued);
      } else {
        this.cpuQueue.push(queued);
      }

      this.processQueues();
    });
  }

  /**
   * Process queues: dequeue and run tasks if slots are available.
   * Called after submit and after task completion.
   */
  private processQueues(): void {
    // Process GPU queue
    this.gpuQueue.sort((a, b) => b.priority - a.priority);
    while (this.activeGpu < this.maxGpuContainers && this.gpuQueue.length > 0) {
      const run = this.gpuQueue.shift()!;
      this.activeGpu++;
      this.executeRun(run, true);
    }

    // Process CPU queue
    this.cpuQueue.sort((a, b) => b.priority - a.priority);
    while (this.activeCpu < this.maxCpuContainers && this.cpuQueue.length > 0) {
      const run = this.cpuQueue.shift()!;
      this.activeCpu++;
      this.executeRun(run, false);
    }
  }

  /**
   * Execute a queued run and handle completion.
   */
  private executeRun(run: QueuedRun, isGpu: boolean): void {
    this.runner(run.config)
      .then((result) => {
        run.resolve(result);
      })
      .catch((error) => {
        run.reject(
          error instanceof Error
            ? error
            : new Error(String(error)),
        );
      })
      .finally(() => {
        if (isGpu) {
          this.activeGpu--;
        } else {
          this.activeCpu--;
        }
        this.processQueues();
      });
  }

  /**
   * Get current queue status.
   */
  getStatus(): QueueStatus {
    return {
      gpuActive: this.activeGpu,
      cpuActive: this.activeCpu,
      gpuQueued: this.gpuQueue.length,
      cpuQueued: this.cpuQueue.length,
    };
  }
}
