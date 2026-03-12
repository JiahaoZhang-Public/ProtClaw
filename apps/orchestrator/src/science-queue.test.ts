import { describe, it, expect, vi } from 'vitest';

import { ScienceQueue } from './science-queue.js';
import type { ScienceRunConfig, ScienceRunResult } from './science-runner.js';

function makeConfig(overrides: Partial<ScienceRunConfig> = {}): ScienceRunConfig {
  return {
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    toolName: 'test-tool',
    dockerImage: 'test:latest',
    gpuRequired: false,
    inputDir: '/tmp/input',
    outputDir: '/tmp/output',
    timeoutSeconds: 60,
    params: {},
    ...overrides,
  };
}

function makeResult(
  config: ScienceRunConfig,
  overrides: Partial<ScienceRunResult> = {},
): ScienceRunResult {
  return {
    runId: config.runId,
    exitCode: 0,
    stdout: '',
    stderr: '',
    result: { status: 'success' },
    durationSeconds: 1.0,
    ...overrides,
  };
}

describe('ScienceQueue', () => {
  describe('submit', () => {
    it('executes a CPU task immediately when slots available', async () => {
      const runner = vi.fn(async (config: ScienceRunConfig) =>
        makeResult(config),
      );
      const queue = new ScienceQueue(1, 4, runner);

      const config = makeConfig({ gpuRequired: false });
      const result = await queue.submit(config);

      expect(runner).toHaveBeenCalledWith(config);
      expect(result.exitCode).toBe(0);
    });

    it('executes a GPU task immediately when slots available', async () => {
      const runner = vi.fn(async (config: ScienceRunConfig) =>
        makeResult(config),
      );
      const queue = new ScienceQueue(1, 4, runner);

      const config = makeConfig({ gpuRequired: true });
      const result = await queue.submit(config);

      expect(runner).toHaveBeenCalledWith(config);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('concurrency limits', () => {
    it('limits GPU concurrency to maxGpuContainers', async () => {
      let activeGpu = 0;
      let maxObservedGpu = 0;

      const runner = vi.fn(async (config: ScienceRunConfig) => {
        activeGpu++;
        maxObservedGpu = Math.max(maxObservedGpu, activeGpu);
        // Simulate some work
        await new Promise((r) => setTimeout(r, 50));
        activeGpu--;
        return makeResult(config);
      });

      const queue = new ScienceQueue(1, 4, runner);

      // Submit 3 GPU tasks
      const promises = [
        queue.submit(makeConfig({ runId: 'gpu-1', gpuRequired: true })),
        queue.submit(makeConfig({ runId: 'gpu-2', gpuRequired: true })),
        queue.submit(makeConfig({ runId: 'gpu-3', gpuRequired: true })),
      ];

      await Promise.all(promises);

      // Only 1 GPU task should have been active at a time
      expect(maxObservedGpu).toBe(1);
      expect(runner).toHaveBeenCalledTimes(3);
    });

    it('limits CPU concurrency to maxCpuContainers', async () => {
      let activeCpu = 0;
      let maxObservedCpu = 0;

      const runner = vi.fn(async (config: ScienceRunConfig) => {
        activeCpu++;
        maxObservedCpu = Math.max(maxObservedCpu, activeCpu);
        await new Promise((r) => setTimeout(r, 50));
        activeCpu--;
        return makeResult(config);
      });

      const queue = new ScienceQueue(1, 2, runner); // max 2 CPU

      // Submit 4 CPU tasks
      const promises = [
        queue.submit(makeConfig({ runId: 'cpu-1' })),
        queue.submit(makeConfig({ runId: 'cpu-2' })),
        queue.submit(makeConfig({ runId: 'cpu-3' })),
        queue.submit(makeConfig({ runId: 'cpu-4' })),
      ];

      await Promise.all(promises);

      // At most 2 CPU tasks should have been active at once
      expect(maxObservedCpu).toBeLessThanOrEqual(2);
      expect(runner).toHaveBeenCalledTimes(4);
    });
  });

  describe('priority', () => {
    it('processes higher priority tasks first', async () => {
      const executionOrder: string[] = [];

      // Create a runner that takes 100ms but tracks execution order
      let resolveGate: (() => void) | null = null;
      const gate = new Promise<void>((r) => {
        resolveGate = r;
      });

      let firstCall = true;
      const runner = vi.fn(async (config: ScienceRunConfig) => {
        if (firstCall) {
          firstCall = false;
          // Block the first task until we've queued the others
          await gate;
        }
        executionOrder.push(config.runId);
        return makeResult(config);
      });

      // Only 1 CPU slot so tasks queue up
      const queue = new ScienceQueue(1, 1, runner);

      // Submit blocker first, then low and high priority
      const p1 = queue.submit(makeConfig({ runId: 'blocker' }), 0);
      const p2 = queue.submit(makeConfig({ runId: 'low-priority' }), 1);
      const p3 = queue.submit(makeConfig({ runId: 'high-priority' }), 10);

      // Release the gate after all are queued
      resolveGate!();

      await Promise.all([p1, p2, p3]);

      // After the blocker, high-priority should run before low-priority
      expect(executionOrder.indexOf('high-priority')).toBeLessThan(
        executionOrder.indexOf('low-priority'),
      );
    });
  });

  describe('getStatus', () => {
    it('reports initial empty status', () => {
      const queue = new ScienceQueue(1, 4);
      const status = queue.getStatus();
      expect(status.gpuActive).toBe(0);
      expect(status.cpuActive).toBe(0);
      expect(status.gpuQueued).toBe(0);
      expect(status.cpuQueued).toBe(0);
    });

    it('reports active tasks', async () => {
      let resolveRunner: (() => void) | null = null;
      const runnerGate = new Promise<void>((r) => {
        resolveRunner = r;
      });

      const runner = vi.fn(async (config: ScienceRunConfig) => {
        await runnerGate;
        return makeResult(config);
      });

      const queue = new ScienceQueue(1, 2, runner);

      // Submit tasks that will block
      const p1 = queue.submit(makeConfig({ runId: 's1' }));
      const p2 = queue.submit(makeConfig({ runId: 's2', gpuRequired: true }));

      // Check status while tasks are running
      // Need a small delay for async processing
      await new Promise((r) => setTimeout(r, 10));

      const status = queue.getStatus();
      expect(status.cpuActive).toBe(1);
      expect(status.gpuActive).toBe(1);

      // Release tasks
      resolveRunner!();
      await Promise.all([p1, p2]);
    });

    it('reports queued tasks when slots full', async () => {
      let resolveRunner: (() => void) | null = null;
      const runnerGate = new Promise<void>((r) => {
        resolveRunner = r;
      });

      const runner = vi.fn(async (config: ScienceRunConfig) => {
        await runnerGate;
        return makeResult(config);
      });

      // 1 GPU slot, 1 CPU slot
      const queue = new ScienceQueue(1, 1, runner);

      // Fill all slots then queue more
      const p1 = queue.submit(makeConfig({ runId: 'active-cpu' }));
      const p2 = queue.submit(
        makeConfig({ runId: 'active-gpu', gpuRequired: true }),
      );
      const p3 = queue.submit(makeConfig({ runId: 'queued-cpu' }));
      const p4 = queue.submit(
        makeConfig({ runId: 'queued-gpu', gpuRequired: true }),
      );

      await new Promise((r) => setTimeout(r, 10));

      const status = queue.getStatus();
      expect(status.cpuActive).toBe(1);
      expect(status.gpuActive).toBe(1);
      expect(status.cpuQueued).toBe(1);
      expect(status.gpuQueued).toBe(1);

      resolveRunner!();
      await Promise.all([p1, p2, p3, p4]);
    });
  });

  describe('error handling', () => {
    it('rejects the promise when runner throws', async () => {
      const runner = vi.fn(async () => {
        throw new Error('container exploded');
      });

      const queue = new ScienceQueue(1, 4, runner);
      const config = makeConfig();

      await expect(queue.submit(config)).rejects.toThrow('container exploded');
    });

    it('continues processing after a failed task', async () => {
      let callCount = 0;
      const runner = vi.fn(async (config: ScienceRunConfig) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('first task fails');
        }
        return makeResult(config);
      });

      // 1 CPU slot so tasks are sequential
      const queue = new ScienceQueue(1, 1, runner);

      const p1 = queue.submit(makeConfig({ runId: 'fail' }));
      const p2 = queue.submit(makeConfig({ runId: 'succeed' }));

      await expect(p1).rejects.toThrow('first task fails');
      const result2 = await p2;
      expect(result2.exitCode).toBe(0);
    });
  });
});
