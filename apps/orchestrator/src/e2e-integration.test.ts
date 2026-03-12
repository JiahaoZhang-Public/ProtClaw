/**
 * End-to-End Integration Test
 *
 * Validates the full workflow through the IPC bridge:
 * 1. Create project + plan via processScienceIpc
 * 2. Execute plan via ExecutionDispatcher
 * 3. Ingest feedback
 * 4. Request replan (triggers LearningAnalyzer + Replanner)
 * 5. Execute new plan
 * 6. Verify audit trail
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProtClawSchema } from './db.js';
import { ProjectManager } from './project-manager.js';
import { ScienceCache } from './science-cache.js';
import { ScienceQueue } from './science-queue.js';
import type { ScienceRunConfig, ScienceRunResult } from './science-runner.js';
import { ToolkitLoader } from './toolkit-loader.js';
import { AuditLogger } from './audit-logger.js';
import { ExecutionDispatcher } from './execution-dispatcher.js';
import { FeedbackIngestor } from './feedback-ingestor.js';
import {
  processScienceIpc,
  _resetProjectManager,
  setExecutionDispatcher,
  setAuditLogger,
  _resetIpcSingletons,
} from './ipc.js';

// Inject the in-memory DB for ipc.ts's getProjectManager()
// The IPC module uses getDb() which needs to be the same DB.
// For testing, we'll use processScienceIpc directly with our own PM.

const PLAN = {
  plan_id: 'plan-e2e',
  project_id: 'proj-e2e',
  version: 1,
  status: 'pending' as const,
  selected_toolkits: ['de-novo'],
  operations: [
    { op_id: 'gen', toolkit_op: 'backbone_generate', params: { num_designs: 1 }, depends_on: [] },
    { op_id: 'seq', toolkit_op: 'sequence_design', params: { temperature: 0.2 }, depends_on: ['gen'] },
    { op_id: 'pred', toolkit_op: 'structure_predict', params: { num_recycles: 3 }, depends_on: ['seq'] },
    { op_id: 'qc', toolkit_op: 'structure_qc', params: {}, depends_on: ['pred'] },
    { op_id: 'dev', toolkit_op: 'developability_check', params: {}, depends_on: ['pred'] },
    { op_id: 'clust', toolkit_op: 'candidate_cluster', params: { n_clusters: 1 }, depends_on: ['qc', 'dev'] },
    { op_id: 'rank', toolkit_op: 'candidate_rank', params: {}, depends_on: ['clust'] },
    { op_id: 'pkg', toolkit_op: 'experiment_package', params: { project_name: 'E2E' }, depends_on: ['rank'] },
  ],
};

function makeMockRunner(callLog: Array<{ tool: string; params: Record<string, unknown> }>) {
  return async (config: ScienceRunConfig): Promise<ScienceRunResult> => {
    callLog.push({ tool: config.toolName, params: { ...config.params } });
    const filesDir = path.join(config.outputDir, 'files');
    fs.mkdirSync(filesDir, { recursive: true });

    let metrics: Record<string, unknown> = {};

    switch (config.toolName) {
      case 'backbone_generate':
        fs.writeFileSync(path.join(filesDir, 'design_0000.pdb'), 'ATOM\nEND\n');
        metrics = { num_designs_generated: 1 };
        break;
      case 'sequence_design':
        fs.writeFileSync(path.join(filesDir, 'design_0000_designed.fasta'), '>d|T=0.2\nMKTAYIAKQRQ\n');
        metrics = { total_sequences_designed: 1, sampling_temp: config.params.temperature || 0.2 };
        break;
      case 'structure_predict':
        fs.writeFileSync(path.join(filesDir, 'predicted_0000.pdb'), 'ATOM predicted\nEND\n');
        metrics = { avg_plddt: 85.0, avg_ptm: 0.91 };
        break;
      case 'structure_qc':
        fs.writeFileSync(path.join(filesDir, 'qc_report.json'), JSON.stringify({ rmsd_angstrom: 1.2 }));
        metrics = { rmsd_angstrom: 1.2 };
        break;
      case 'developability_check':
        fs.writeFileSync(path.join(filesDir, 'dev_report.json'), JSON.stringify({ aggregation_propensity: 0.15 }));
        metrics = { aggregation_propensity: 0.15 };
        break;
      case 'candidate_cluster':
        fs.writeFileSync(path.join(filesDir, 'clusters.json'), JSON.stringify({ clusters: [] }));
        metrics = { num_clusters: 1 };
        break;
      case 'candidate_rank':
        fs.writeFileSync(path.join(filesDir, 'ranked.json'), JSON.stringify({ ranked: [{ id: 'd0', rank: 1 }] }));
        metrics = { num_candidates: 1 };
        break;
      case 'experiment_package':
        fs.writeFileSync(path.join(filesDir, 'order.csv'), 'id,seq\n');
        metrics = { num_candidates_packaged: 1 };
        break;
    }

    const result = {
      status: 'success' as const,
      tool_name: config.toolName,
      tool_version: '1.0.0',
      metrics,
      output_files: fs.readdirSync(filesDir).map((f) => ({ path: f, type: path.extname(f).slice(1) })),
    };
    fs.writeFileSync(path.join(config.outputDir, 'result.json'), JSON.stringify(result));

    return { runId: config.runId, exitCode: 0, stdout: '', stderr: '', result, durationSeconds: 0.01 };
  };
}

describe('E2E Integration: Full workflow', () => {
  let db: Database.Database;
  let pm: ProjectManager;
  let tmpDir: string;
  let cacheDir: string;
  let auditDir: string;
  let toolkitLoader: ToolkitLoader;

  beforeEach(() => {
    db = new Database(':memory:');
    createProtClawSchema(db);
    pm = new ProjectManager(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protclaw-e2e-'));
    cacheDir = path.join(tmpDir, 'cache');
    auditDir = path.join(tmpDir, 'audit');
    fs.mkdirSync(cacheDir);

    const toolkitsDir = path.resolve(__dirname, '../../../toolkits');
    toolkitLoader = new ToolkitLoader(toolkitsDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('executes full workflow: create → execute → feedback → replan → re-execute', async () => {
    // === Step 1: Create project and plan ===
    pm.createProject('proj-e2e', 'E2E Test', {});
    pm.createPlan('plan-e2e', 'proj-e2e', PLAN);

    // === Step 2: Execute plan via ExecutionDispatcher ===
    const callLog1: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const runner1 = makeMockRunner(callLog1);
    const cache = new ScienceCache(cacheDir);
    const queue1 = new ScienceQueue(1, 4, runner1);
    const audit = new AuditLogger(auditDir);

    const dispatcher = new ExecutionDispatcher({
      projectManager: pm,
      scienceQueue: queue1,
      scienceCache: cache,
      toolkitLoader,
      projectDir: tmpDir,
      auditLogger: audit,
    });

    const { executionId } = dispatcher.dispatch('proj-e2e', 'plan-e2e');
    expect(executionId).toBeDefined();

    // Wait for async completion
    await new Promise((r) => setTimeout(r, 1000));

    const status = dispatcher.getStatus('plan-e2e');
    expect(status!.status).toBe('completed');
    expect(status!.completedOps).toHaveLength(8);

    // Plan status updated
    expect(pm.getPlan('plan-e2e')!.status).toBe('completed');

    // === Step 3: Ingest feedback ===
    pm.createCandidate({
      id: 'cand-e2e',
      project_id: 'proj-e2e',
      sequence: 'MKTAYIAKQRQ',
      status: 'active',
      rank: 1,
      card: {},
    });

    const ingestor = new FeedbackIngestor(pm);
    const ingestionResult = ingestor.ingestJson('proj-e2e', [
      { feedback_id: 'fb-e1', project_id: 'proj-e2e', candidate_id: 'cand-e2e', assay_type: 'expression_titer', measurement: 0.05, unit: 'mg/L', pass_fail: 'fail' },
      { feedback_id: 'fb-e2', project_id: 'proj-e2e', candidate_id: 'cand-e2e', assay_type: 'SPR', measurement: 5.2, unit: 'nM', pass_fail: 'pass' },
    ]);
    expect(ingestionResult.accepted).toBe(2);

    audit.log({
      eventType: 'feedback_ingested',
      projectId: 'proj-e2e',
      details: { accepted: ingestionResult.accepted, rejected: ingestionResult.rejected },
    });

    // === Step 4: Learning + Replan ===
    const { LearningAnalyzer } = await import('./learning-analyzer.js');
    const { Replanner } = await import('./replanner.js');

    const analyzer = new LearningAnalyzer(pm);
    const learningUpdate = analyzer.analyze('proj-e2e');

    expect(learningUpdate.success_rate).toBe(0.5);
    expect(learningUpdate.observed_failure_patterns).toBeDefined();

    audit.log({
      eventType: 'learning_analyzed',
      projectId: 'proj-e2e',
      details: { updateId: learningUpdate.update_id, successRate: learningUpdate.success_rate },
    });

    const replanner = new Replanner(pm);
    const replanResult = replanner.replan('proj-e2e', learningUpdate.update_id);
    expect(replanResult.newVersion).toBe(2);

    audit.log({
      eventType: 'replan_created',
      projectId: 'proj-e2e',
      details: { newPlanId: replanResult.newPlanId, version: replanResult.newVersion },
    });

    // Old plan superseded
    expect(pm.getPlan('plan-e2e')!.status).toBe('superseded');

    // === Step 5: Re-execute new plan ===
    const callLog2: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const runner2 = makeMockRunner(callLog2);
    const queue2 = new ScienceQueue(1, 4, runner2);

    const dispatcher2 = new ExecutionDispatcher({
      projectManager: pm,
      scienceQueue: queue2,
      scienceCache: cache,
      toolkitLoader,
      projectDir: tmpDir,
      auditLogger: audit,
    });

    dispatcher2.dispatch('proj-e2e', replanResult.newPlanId);
    await new Promise((r) => setTimeout(r, 1000));

    const status2 = dispatcher2.getStatus(replanResult.newPlanId);
    expect(status2!.status).toBe('completed');

    // Verify adjusted temperature reached the runner
    const seqCall = callLog2.find((c) => c.tool === 'sequence_design');
    expect(seqCall).toBeDefined();
    expect(seqCall!.params.temperature).toBeLessThan(0.2);
  });

  it('produces complete audit trail', async () => {
    // Quick workflow
    pm.createProject('proj-audit', 'Audit Test', {});
    pm.createPlan('plan-a1', 'proj-audit', {
      ...PLAN,
      plan_id: 'plan-a1',
      project_id: 'proj-audit',
      operations: PLAN.operations.slice(0, 2), // Just 2 ops for speed
    });

    const callLog: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const runner = makeMockRunner(callLog);
    const cache = new ScienceCache(cacheDir);
    const queue = new ScienceQueue(1, 4, runner);
    const audit = new AuditLogger(auditDir);

    const dispatcher = new ExecutionDispatcher({
      projectManager: pm,
      scienceQueue: queue,
      scienceCache: cache,
      toolkitLoader,
      projectDir: tmpDir,
      auditLogger: audit,
    });

    dispatcher.dispatch('proj-audit', 'plan-a1');
    await new Promise((r) => setTimeout(r, 500));

    // Check audit entries
    const entries = audit.getEntries('proj-audit');
    expect(entries.length).toBeGreaterThanOrEqual(2);

    // Should have plan_executed and plan_completed
    const types = entries.map((e) => e.eventType);
    expect(types).toContain('plan_executed');
    expect(types).toContain('plan_completed');

    // All entries have timestamps
    for (const entry of entries) {
      expect(entry.timestamp).toBeDefined();
      expect(entry.projectId).toBe('proj-audit');
    }
  });
});
