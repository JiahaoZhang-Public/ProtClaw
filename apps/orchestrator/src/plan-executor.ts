/**
 * Plan Executor for ProtClaw
 *
 * Orchestrates a DesignPlan end-to-end: builds operation graph, checks cache,
 * submits runs to the science queue, records artifacts, and applies fallback policies.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DesignPlan } from '@protclaw/contracts';
import { DesignPlanSchema } from '@protclaw/contracts';
import { OperationGraph } from './operation-graph.js';
import type { OperationNode } from './operation-graph.js';
import type { ToolkitLoader } from './toolkit-loader.js';
import type { ScienceCache } from './science-cache.js';
import type { ScienceQueue } from './science-queue.js';
import type { ScienceRunConfig, ScienceRunResult } from './science-runner.js';
import type { ProjectManager } from './project-manager.js';

export interface PlanExecutionResult {
  planId: string;
  status: 'completed' | 'failed' | 'partial';
  completedOps: string[];
  failedOps: string[];
  skippedOps: string[];
  artifacts: Record<string, string>; // opId → artifactId
}

export interface PlanExecutorConfig {
  projectManager: ProjectManager;
  scienceQueue: ScienceQueue;
  scienceCache: ScienceCache;
  toolkitLoader: ToolkitLoader;
  projectDir: string;
}

export class PlanExecutor {
  private pm: ProjectManager;
  private queue: ScienceQueue;
  private cache: ScienceCache;
  private toolkits: ToolkitLoader;
  private projectDir: string;

  constructor(config: PlanExecutorConfig) {
    this.pm = config.projectManager;
    this.queue = config.scienceQueue;
    this.cache = config.scienceCache;
    this.toolkits = config.toolkitLoader;
    this.projectDir = config.projectDir;
  }

  async execute(projectId: string, planId: string): Promise<PlanExecutionResult> {
    // 1. Load plan from DB
    const planRecord = this.pm.getPlan(planId);
    if (!planRecord) {
      throw new Error(`Plan not found: ${planId}`);
    }
    const plan = DesignPlanSchema.parse(planRecord.plan);

    // 2. Resolve toolkit manifests
    const manifests = this.toolkits.resolveToolkits(plan.selected_toolkits);

    // 3. Build operation graph
    const graph = OperationGraph.fromDesignPlan(plan, manifests);
    const maxParallel = plan.parallelism_policy?.max_parallel_ops ?? 4;

    // Track results
    const artifacts: Record<string, string> = {};
    const completedOps: string[] = [];
    const failedOps: string[] = [];
    const skippedOps: string[] = [];

    // 4. Execution loop
    while (!graph.isComplete()) {
      const ready = graph.getReady();
      if (ready.length === 0) {
        // No ready nodes but graph not complete — blocked by failures
        // Skip all remaining pending/ready nodes
        for (const node of graph.getAllNodes()) {
          if (node.status === 'pending' || node.status === 'ready') {
            graph.skipWithDependents(node.opId);
            skippedOps.push(node.opId);
          }
        }
        break;
      }

      // Limit parallel execution
      const batch = ready.slice(0, maxParallel);

      // Submit all ready ops in parallel
      const promises = batch.map((node) => this.executeOperation(projectId, planId, plan, node, graph));
      const results = await Promise.allSettled(promises);

      for (let i = 0; i < results.length; i++) {
        const node = batch[i];
        const result = results[i];

        if (result.status === 'fulfilled' && result.value.success) {
          completedOps.push(node.opId);
          if (result.value.artifactId) {
            artifacts[node.opId] = result.value.artifactId;
          }
        } else {
          const error = result.status === 'rejected'
            ? String(result.reason)
            : result.value.error ?? 'Unknown error';

          // Apply fallback policy
          const handled = this.applyFallbackPolicy(plan, node, error, graph);
          if (!handled) {
            failedOps.push(node.opId);
            // Skip all transitive dependents
            for (const depNode of graph.getAllNodes()) {
              if (depNode.status === 'skipped') {
                skippedOps.push(depNode.opId);
              }
            }
          }
        }
      }
    }

    // Collect any skipped nodes
    for (const node of graph.getAllNodes()) {
      if (node.status === 'skipped' && !skippedOps.includes(node.opId)) {
        skippedOps.push(node.opId);
      }
    }

    const status = failedOps.length === 0
      ? 'completed'
      : completedOps.length > 0
        ? 'partial'
        : 'failed';

    return { planId, status, completedOps, failedOps, skippedOps, artifacts };
  }

  private async executeOperation(
    projectId: string,
    planId: string,
    plan: DesignPlan,
    node: OperationNode,
    graph: OperationGraph,
  ): Promise<{ success: boolean; artifactId?: string; error?: string }> {
    graph.markRunning(node.opId);

    // Check cache
    const cacheKey = this.computeOpCacheKey(node);
    if (this.cache.has(cacheKey)) {
      const cachedResult = await this.cache.get(cacheKey);
      const artifactId = this.generateId('art');

      // Restore cached output files
      const outputDir = this.getOutputDir(projectId, planId, node.opId);
      fs.mkdirSync(outputDir, { recursive: true });
      await this.cache.restoreOutputFiles(cacheKey, outputDir);

      this.pm.recordArtifact({
        id: artifactId,
        project_id: projectId,
        plan_id: planId,
        op_id: node.opId,
        candidate_id: '',
        artifact_type: node.toolkitOp,
        producer: node.toolOverride ?? node.toolkitOp,
        status: 'completed',
        artifact: { ...cachedResult, cache_hit: true },
        cache_key: cacheKey,
      });

      graph.markComplete(node.opId, artifactId);
      return { success: true, artifactId };
    }

    // Prepare input/output dirs
    const inputDir = this.getInputDir(projectId, planId, node.opId);
    const outputDir = this.getOutputDir(projectId, planId, node.opId);
    fs.mkdirSync(path.join(inputDir, 'files'), { recursive: true });
    fs.mkdirSync(path.join(outputDir, 'files'), { recursive: true });

    // Build run config
    const runConfig: ScienceRunConfig = {
      runId: this.generateId('run'),
      toolName: node.toolOverride ?? node.toolkitOp,
      dockerImage: node.dockerImage,
      gpuRequired: node.gpuRequired,
      inputDir,
      outputDir,
      timeoutSeconds: 3600,
      params: node.params,
    };

    // Submit to science queue
    const runResult = await this.queue.submit(runConfig);

    if (runResult.exitCode === 0 && runResult.result) {
      const artifactId = this.generateId('art');

      // Cache the result
      const outputFiles = this.listOutputFiles(outputDir);
      await this.cache.set(cacheKey, runResult.result, outputFiles);

      this.pm.recordArtifact({
        id: artifactId,
        project_id: projectId,
        plan_id: planId,
        op_id: node.opId,
        candidate_id: '',
        artifact_type: node.toolkitOp,
        producer: runConfig.toolName,
        status: 'completed',
        artifact: { ...runResult.result, cache_hit: false, duration_seconds: runResult.durationSeconds },
        cache_key: cacheKey,
      });

      graph.markComplete(node.opId, artifactId);
      return { success: true, artifactId };
    }

    // Failure
    const error = runResult.stderr || `Exit code: ${runResult.exitCode}`;
    graph.markFailed(node.opId, error);

    this.pm.recordArtifact({
      id: this.generateId('art'),
      project_id: projectId,
      plan_id: planId,
      op_id: node.opId,
      candidate_id: '',
      artifact_type: node.toolkitOp,
      producer: runConfig.toolName,
      status: 'failed',
      artifact: { error, exit_code: runResult.exitCode, stderr: runResult.stderr },
      cache_key: '',
    });

    return { success: false, error };
  }

  private applyFallbackPolicy(
    plan: DesignPlan,
    node: OperationNode,
    error: string,
    graph: OperationGraph,
  ): boolean {
    const policies = plan.fallback_policies ?? [];

    for (const policy of policies) {
      // Match policy trigger against the failed operation or error
      if (
        policy.trigger === node.toolkitOp ||
        policy.trigger === `${node.toolkitOp}_failure` ||
        policy.trigger === `${node.toolkitOp}_timeout`
      ) {
        switch (policy.action) {
          case 'skip':
            graph.skipWithDependents(node.opId);
            return true;
          case 'abort':
            // Mark all remaining as skipped
            for (const n of graph.getAllNodes()) {
              if (n.status === 'pending' || n.status === 'ready') {
                graph.skipWithDependents(n.opId);
              }
            }
            return false; // Still a failure
          case 'retry':
          case 'substitute':
            // Retry/substitute would need re-submission; for now treat as unhandled
            return false;
        }
      }
    }

    // No matching policy — skip dependents
    graph.skipWithDependents(node.opId);
    return false;
  }

  private computeOpCacheKey(node: OperationNode): string {
    const hasher = crypto.createHash('sha256');
    hasher.update(node.toolkitOp);
    hasher.update(node.dockerImage);
    if (node.toolOverride) hasher.update(node.toolOverride);
    hasher.update(JSON.stringify(node.params, Object.keys(node.params).sort()));
    return hasher.digest('hex');
  }

  private getInputDir(projectId: string, planId: string, opId: string): string {
    return path.join(this.projectDir, projectId, 'runs', planId, opId, 'input');
  }

  private getOutputDir(projectId: string, planId: string, opId: string): string {
    return path.join(this.projectDir, projectId, 'runs', planId, opId, 'output');
  }

  private listOutputFiles(outputDir: string): string[] {
    const filesDir = path.join(outputDir, 'files');
    if (!fs.existsSync(filesDir)) return [];
    return fs.readdirSync(filesDir).map((f) => path.join(filesDir, f));
  }

  private generateId(prefix: string): string {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
}
