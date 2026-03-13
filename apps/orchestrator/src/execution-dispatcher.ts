import crypto from 'node:crypto';

import type { ProjectManager } from './project-manager.js';
import type { ScienceQueue } from './science-queue.js';
import type { ScienceCache } from './science-cache.js';
import type { ToolkitLoader } from './toolkit-loader.js';
import { PlanExecutor, type PlanExecutionResult } from './plan-executor.js';
import { FileRouter } from './file-router.js';
import { CandidateCardBuilder } from './candidate-card-builder.js';
import type { AuditLogger } from './audit-logger.js';

export interface ExecutionProgress {
  executionId: string;
  planId: string;
  projectId: string;
  status: 'running' | 'completed' | 'failed' | 'partial';
  completedOps: string[];
  failedOps: string[];
  skippedOps: string[];
  totalOps: number;
  result?: PlanExecutionResult;
  error?: string;
}

export interface ExecutionDispatcherConfig {
  projectManager: ProjectManager;
  scienceQueue: ScienceQueue;
  scienceCache: ScienceCache;
  toolkitLoader: ToolkitLoader;
  projectDir: string;
  auditLogger?: AuditLogger;
}

/**
 * Manages async plan execution. Dispatch returns immediately;
 * callers poll getStatus() for progress.
 */
export class ExecutionDispatcher {
  private pm: ProjectManager;
  private queue: ScienceQueue;
  private cache: ScienceCache;
  private toolkitLoader: ToolkitLoader;
  private projectDir: string;
  private auditLogger?: AuditLogger;
  private executions = new Map<string, ExecutionProgress>();

  constructor(config: ExecutionDispatcherConfig) {
    this.pm = config.projectManager;
    this.queue = config.scienceQueue;
    this.cache = config.scienceCache;
    this.toolkitLoader = config.toolkitLoader;
    this.projectDir = config.projectDir;
    this.auditLogger = config.auditLogger;
  }

  /** Start async plan execution. Returns immediately. */
  dispatch(projectId: string, planId: string): { executionId: string } {
    const executionId = `exec-${crypto.randomUUID().slice(0, 8)}`;

    // Get plan to determine total ops
    const planRecord = this.pm.getPlan(planId);
    const plan = planRecord?.plan as { operations?: unknown[] } | undefined;
    const totalOps = plan?.operations?.length ?? 0;

    const progress: ExecutionProgress = {
      executionId,
      planId,
      projectId,
      status: 'running',
      completedOps: [],
      failedOps: [],
      skippedOps: [],
      totalOps,
    };
    this.executions.set(planId, progress);

    // Update plan status to executing
    this.pm.updatePlanStatus(planId, 'executing');

    this.auditLogger?.log({
      eventType: 'plan_executed',
      projectId,
      details: { planId, executionId, totalOps },
    });

    // Fire-and-forget execution
    this.runExecution(projectId, planId, progress).catch((err) => {
      progress.status = 'failed';
      progress.error = err instanceof Error ? err.message : String(err);
      this.pm.updatePlanStatus(planId, 'failed');
      this.auditLogger?.log({
        eventType: 'plan_failed',
        projectId,
        details: { planId, executionId, error: progress.error },
      });
    });

    return { executionId };
  }

  /** Get current execution status for a plan. */
  getStatus(planId: string): ExecutionProgress | undefined {
    return this.executions.get(planId);
  }

  /** List all tracked executions. */
  listActive(): ExecutionProgress[] {
    return [...this.executions.values()].filter((e) => e.status === 'running');
  }

  private async runExecution(
    projectId: string,
    planId: string,
    progress: ExecutionProgress,
  ): Promise<void> {
    // Resolve toolkits for the plan
    const planRecord = this.pm.getPlan(planId);
    const plan = planRecord?.plan as { selected_toolkits?: string[] } | undefined;
    const toolkitIds = plan?.selected_toolkits ?? [];
    const manifests = this.toolkitLoader.resolveToolkits(toolkitIds);

    const fileRouter = new FileRouter(manifests);
    const cardBuilder = new CandidateCardBuilder({ projectManager: this.pm });

    const executor = new PlanExecutor({
      projectManager: this.pm,
      scienceQueue: this.queue,
      scienceCache: this.cache,
      toolkitLoader: this.toolkitLoader,
      projectDir: this.projectDir,
      fileRouter,
      cardBuilder,
    });

    const result = await executor.execute(projectId, planId);

    // Update progress
    progress.completedOps = result.completedOps;
    progress.failedOps = result.failedOps;
    progress.skippedOps = result.skippedOps;
    progress.result = result;

    if (result.status === 'completed') {
      progress.status = 'completed';
      this.pm.updatePlanStatus(planId, 'completed');
      this.auditLogger?.log({
        eventType: 'plan_completed',
        projectId,
        details: {
          planId,
          executionId: progress.executionId,
          completedOps: result.completedOps.length,
          candidates: result.candidates?.length ?? 0,
        },
      });
    } else if (result.status === 'failed') {
      progress.status = 'failed';
      this.pm.updatePlanStatus(planId, 'failed');
      this.auditLogger?.log({
        eventType: 'plan_failed',
        projectId,
        details: { planId, executionId: progress.executionId, failedOps: result.failedOps },
      });
    } else {
      progress.status = 'partial';
      this.auditLogger?.log({
        eventType: 'plan_failed',
        projectId,
        details: { planId, executionId: progress.executionId, status: 'partial', failedOps: result.failedOps },
      });
    }
  }
}
