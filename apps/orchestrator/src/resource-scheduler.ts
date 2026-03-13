/**
 * Resource Scheduler for ProtClaw
 *
 * Auto-infers execution strategy from target hardware:
 *
 * | Hardware         | GPU Concurrency | CPU Concurrency | Mode       |
 * |------------------|-----------------|-----------------|------------|
 * | 4×GPU SSH        | 3 (1 reserved)  | 8               | multi-gpu  |
 * | 1×GPU local/SSH  | 1 (serial)      | 4               | single-gpu |
 * | Apple MPS        | 1 (serial)      | 4               | single-gpu |
 * | CPU-only         | 0 (fallback)    | cpus (max 8)    | cpu-only   |
 *
 * GPU tasks queue when all slots are busy.
 * CPU tasks run independently (never blocked by GPU queue).
 * Skills with gpu:"preferred" fallback to CPU on cpu-only targets.
 * Skills with gpu:"required" fail on cpu-only targets.
 */

import os from 'node:os';

import type { TargetConfig } from './shell-executor.js';
import type { SkillManifest, SkillResources } from './skill-registry.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ScheduleMode = 'multi-gpu' | 'single-gpu' | 'cpu-only';

export interface ScheduleStrategy {
  gpuConcurrency: number;
  cpuConcurrency: number;
  gpuFallbackToCpu: boolean;
  mode: ScheduleMode;
}

export interface AcquiredResources {
  /** GPU index (0-based), or -1 if running on CPU. */
  gpuId: number;
  /** Whether this skill is running on CPU fallback. */
  isCpuFallback: boolean;
  /** Release token (internal). */
  _releaseId: string;
}

/* ------------------------------------------------------------------ */
/*  ResourceScheduler                                                  */
/* ------------------------------------------------------------------ */

export class ResourceScheduler {
  readonly strategy: ScheduleStrategy;

  private gpuSlots: boolean[];
  private gpuWaiters: Array<{ resolve: (gpuId: number) => void }> = [];
  private cpuActive = 0;
  private cpuWaiters: Array<{ resolve: () => void }> = [];
  private allocations = new Map<string, { gpuId: number }>();

  constructor(target: TargetConfig) {
    this.strategy = ResourceScheduler.inferStrategy(target);
    this.gpuSlots = new Array(this.strategy.gpuConcurrency).fill(false);
  }

  /**
   * Infer scheduling strategy from target hardware.
   * Users never configure this — it's fully automatic.
   */
  static inferStrategy(target: TargetConfig): ScheduleStrategy {
    const { backend, gpus } = target.compute;

    if (backend === 'cpu' || gpus === 0) {
      return {
        gpuConcurrency: 0,
        cpuConcurrency: Math.min(os.cpus().length, 8),
        gpuFallbackToCpu: true,
        mode: 'cpu-only',
      };
    }

    if (gpus === 1) {
      return {
        gpuConcurrency: 1,
        cpuConcurrency: 4,
        gpuFallbackToCpu: false,
        mode: 'single-gpu',
      };
    }

    // Multi-GPU: leave 1 GPU reserved for system/debug
    return {
      gpuConcurrency: Math.max(1, gpus - 1),
      cpuConcurrency: 8,
      gpuFallbackToCpu: false,
      mode: 'multi-gpu',
    };
  }

  /**
   * Acquire resources for a skill execution.
   *
   * - GPU skills wait for a free GPU slot (or fallback to CPU).
   * - CPU skills acquire a CPU slot immediately (bounded concurrency).
   * - gpu:"required" on cpu-only target throws an error.
   */
  async acquire(skill: SkillManifest, nodeId: string): Promise<AcquiredResources> {
    const needsGpu = this.skillNeedsGpu(skill.resources);

    if (needsGpu) {
      return this.acquireGpu(nodeId);
    }

    return this.acquireCpu(nodeId);
  }

  /**
   * Release resources after skill execution completes.
   */
  release(nodeId: string): void {
    const alloc = this.allocations.get(nodeId);
    if (!alloc) return;

    this.allocations.delete(nodeId);

    if (alloc.gpuId >= 0) {
      this.releaseGpuSlot(alloc.gpuId);
    } else {
      this.releaseCpuSlot();
    }
  }

  /**
   * Check whether a skill should run on GPU given current target.
   */
  skillNeedsGpu(resources: SkillResources): boolean {
    if (resources.gpu === 'none') return false;

    if (resources.gpu === 'required') {
      if (this.strategy.mode === 'cpu-only') {
        throw new Error(
          'Skill requires GPU but target has no GPU. ' +
          'Configure a GPU target: protclaw target add --ssh ...',
        );
      }
      return true;
    }

    // gpu: 'preferred'
    if (this.strategy.mode === 'cpu-only') {
      return false; // fallback to CPU
    }
    return true;
  }

  /* ---------------------------------------------------------------- */
  /*  GPU slot management                                              */
  /* ---------------------------------------------------------------- */

  private async acquireGpu(nodeId: string): Promise<AcquiredResources> {
    // Try to get a free GPU slot immediately
    const freeSlot = this.gpuSlots.indexOf(false);
    if (freeSlot >= 0) {
      this.gpuSlots[freeSlot] = true;
      this.allocations.set(nodeId, { gpuId: freeSlot });
      return { gpuId: freeSlot, isCpuFallback: false, _releaseId: nodeId };
    }

    // Wait for a GPU to become available
    const gpuId = await new Promise<number>(resolve => {
      this.gpuWaiters.push({ resolve });
    });

    this.gpuSlots[gpuId] = true;
    this.allocations.set(nodeId, { gpuId });
    return { gpuId, isCpuFallback: false, _releaseId: nodeId };
  }

  private releaseGpuSlot(gpuId: number): void {
    this.gpuSlots[gpuId] = false;

    // Wake the oldest waiter
    const waiter = this.gpuWaiters.shift();
    if (waiter) {
      waiter.resolve(gpuId);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  CPU slot management                                              */
  /* ---------------------------------------------------------------- */

  private async acquireCpu(nodeId: string): Promise<AcquiredResources> {
    if (this.cpuActive < this.strategy.cpuConcurrency) {
      this.cpuActive++;
      this.allocations.set(nodeId, { gpuId: -1 });
      return { gpuId: -1, isCpuFallback: this.strategy.gpuFallbackToCpu, _releaseId: nodeId };
    }

    // Wait for a CPU slot
    await new Promise<void>(resolve => {
      this.cpuWaiters.push({ resolve });
    });

    this.cpuActive++;
    this.allocations.set(nodeId, { gpuId: -1 });
    return { gpuId: -1, isCpuFallback: this.strategy.gpuFallbackToCpu, _releaseId: nodeId };
  }

  private releaseCpuSlot(): void {
    this.cpuActive--;

    const waiter = this.cpuWaiters.shift();
    if (waiter) {
      waiter.resolve();
    }
  }
}
