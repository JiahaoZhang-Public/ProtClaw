/**
 * DBTL Loop Integration Test
 *
 * Exercises the full Design-Build-Test-Learn cycle:
 * 1. Design: Create project + plan
 * 2. Build: Execute pipeline with mock runner
 * 3. Test: Ingest simulated experiment feedback
 * 4. Learn: Analyze feedback for failure patterns
 * 5. Replan: Generate new plan with adjusted parameters
 * 6. Re-execute: Run the new plan
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
import { FileRouter } from './file-router.js';
import { CandidateCardBuilder } from './candidate-card-builder.js';
import { PlanExecutor } from './plan-executor.js';
import { FeedbackIngestor } from './feedback-ingestor.js';
import { LearningAnalyzer } from './learning-analyzer.js';
import { Replanner } from './replanner.js';

const INITIAL_PLAN = {
  plan_id: 'plan-v1',
  project_id: 'proj-dbtl',
  version: 1,
  status: 'pending' as const,
  selected_toolkits: ['de-novo'],
  operations: [
    { op_id: 'gen', toolkit_op: 'backbone_generate', params: { contigs: '50-50', num_designs: 1 }, depends_on: [] },
    { op_id: 'seq', toolkit_op: 'sequence_design', params: { num_sequences: 1, temperature: 0.2 }, depends_on: ['gen'] },
    { op_id: 'pred', toolkit_op: 'structure_predict', params: { num_recycles: 3 }, depends_on: ['seq'] },
    { op_id: 'qc', toolkit_op: 'structure_qc', params: {}, depends_on: ['pred'] },
    { op_id: 'dev', toolkit_op: 'developability_check', params: {}, depends_on: ['pred'] },
    { op_id: 'clust', toolkit_op: 'candidate_cluster', params: { n_clusters: 1 }, depends_on: ['qc', 'dev'] },
    { op_id: 'rank', toolkit_op: 'candidate_rank', params: {}, depends_on: ['clust'] },
    { op_id: 'pkg', toolkit_op: 'experiment_package', params: { project_name: 'DBTL' }, depends_on: ['rank'] },
  ],
};

/** Mock runner that simulates stub adapter outputs. Tracks calls and params. */
function makeMockRunner(callLog: Array<{ tool: string; params: Record<string, unknown> }>) {
  return async (config: ScienceRunConfig): Promise<ScienceRunResult> => {
    callLog.push({ tool: config.toolName, params: { ...config.params } });
    const filesDir = path.join(config.outputDir, 'files');
    fs.mkdirSync(filesDir, { recursive: true });

    let metrics: Record<string, unknown> = {};

    switch (config.toolName) {
      case 'backbone_generate':
        fs.writeFileSync(path.join(filesDir, 'design_0000.pdb'), 'ATOM 1\nEND\n');
        metrics = { num_designs_generated: 1 };
        break;
      case 'sequence_design':
        fs.writeFileSync(path.join(filesDir, 'design_0000_designed.fasta'), '>d|T=0.2\nMKTAYIAKQRQ\n');
        metrics = { total_sequences_designed: 1, sampling_temp: config.params.temperature || 0.2 };
        break;
      case 'structure_predict':
        fs.writeFileSync(path.join(filesDir, 'predicted_0000.pdb'), 'ATOM 1 predicted\nEND\n');
        metrics = { avg_plddt: 85.0, avg_ptm: 0.91 };
        break;
      case 'structure_qc':
        fs.writeFileSync(path.join(filesDir, 'qc_report.json'), JSON.stringify({ rmsd_angstrom: 1.2 }));
        metrics = { rmsd_angstrom: 1.2 };
        break;
      case 'developability_check':
        fs.writeFileSync(path.join(filesDir, 'dev_report.json'), JSON.stringify({ aggregation_propensity: 0.15 }));
        metrics = { aggregation_propensity: 0.15, mean_hydrophobicity: -0.3 };
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
        fs.writeFileSync(path.join(filesDir, 'order_sheet.csv'), 'id,seq\n');
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

    return { runId: config.runId, exitCode: 0, stdout: '', stderr: '', result, durationSeconds: 0.1 };
  };
}

describe('DBTL Loop Integration', () => {
  let db: Database.Database;
  let pm: ProjectManager;
  let tmpDir: string;
  let cacheDir: string;
  let toolkitLoader: ToolkitLoader;

  beforeEach(() => {
    db = new Database(':memory:');
    createProtClawSchema(db);
    pm = new ProjectManager(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protclaw-dbtl-'));
    cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(cacheDir);

    pm.createProject('proj-dbtl', 'DBTL Test', {});
    pm.createPlan('plan-v1', 'proj-dbtl', INITIAL_PLAN);

    const toolkitsDir = path.resolve(__dirname, '../../../toolkits');
    toolkitLoader = new ToolkitLoader(toolkitsDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('completes full DBTL cycle: execute → feedback → learn → replan → re-execute', async () => {
    // === DESIGN + BUILD: Execute initial pipeline ===
    const callLog1: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const runner1 = makeMockRunner(callLog1);
    const cache = new ScienceCache(cacheDir);
    const queue1 = new ScienceQueue(1, 4, runner1);
    const manifests = toolkitLoader.resolveToolkits(['de-novo']);
    const fileRouter = new FileRouter(manifests);
    const cardBuilder = new CandidateCardBuilder({ projectManager: pm });

    const executor1 = new PlanExecutor({
      projectManager: pm,
      scienceQueue: queue1,
      scienceCache: cache,
      toolkitLoader,
      projectDir: tmpDir,
      fileRouter,
      cardBuilder,
    });

    const result1 = await executor1.execute('proj-dbtl', 'plan-v1');
    expect(result1.status).toBe('completed');
    expect(result1.completedOps).toHaveLength(8);

    // Create a candidate for feedback to target
    pm.createCandidate({
      id: 'cand-d0',
      project_id: 'proj-dbtl',
      sequence: 'MKTAYIAKQRQ',
      status: 'active',
      rank: 1,
      card: {},
    });

    // === TEST: Ingest experiment feedback (simulated lab results) ===
    const ingestor = new FeedbackIngestor(pm);
    const feedbackData = [
      { feedback_id: 'fb-1', project_id: 'proj-dbtl', candidate_id: 'cand-d0', assay_type: 'expression_titer', measurement: 0.05, unit: 'mg/L', pass_fail: 'fail' as const },
      { feedback_id: 'fb-2', project_id: 'proj-dbtl', candidate_id: 'cand-d0', assay_type: 'SPR', measurement: 3.2, unit: 'nM', pass_fail: 'pass' as const },
    ];
    const ingestionResult = ingestor.ingestJson('proj-dbtl', feedbackData);
    expect(ingestionResult.accepted).toBe(2);
    expect(ingestionResult.candidateStatusUpdates).toHaveLength(2);

    // Candidate should be updated (last feedback was 'pass' → 'promoted')
    // But first feedback was 'fail' → 'rejected', then overwritten by 'pass' → 'promoted'

    // === LEARN: Analyze feedback ===
    const analyzer = new LearningAnalyzer(pm);
    const learningUpdate = analyzer.analyze('proj-dbtl');

    expect(learningUpdate.success_rate).toBe(0.5);
    expect(learningUpdate.source_feedback_refs).toHaveLength(2);

    // expression_titer has 100% failure rate → failure pattern + constraint
    expect(learningUpdate.observed_failure_patterns).toBeDefined();
    const exprPattern = learningUpdate.observed_failure_patterns!.find(
      (p) => p.pattern.includes('expression_titer'),
    );
    expect(exprPattern).toBeDefined();
    expect(exprPattern!.frequency).toBe(1.0);

    // Should suggest lowering sequence_design temperature
    expect(learningUpdate.parameter_adjustments).toBeDefined();
    const tempAdj = learningUpdate.parameter_adjustments!.find(
      (a) => a.operation === 'sequence_design' && a.parameter === 'temperature',
    );
    expect(tempAdj).toBeDefined();
    expect(tempAdj!.old_value).toBe(0.2);

    // Learning update should be persisted
    const storedUpdates = pm.getLearningUpdates('proj-dbtl');
    expect(storedUpdates).toHaveLength(1);

    // === REPLAN: Generate new plan version ===
    const replanner = new Replanner(pm);
    const replanResult = replanner.replan('proj-dbtl', learningUpdate.update_id);

    expect(replanResult.newVersion).toBe(2);
    expect(replanResult.changesApplied.length).toBeGreaterThan(0);

    // Old plan should be superseded
    const oldPlan = pm.getPlan('plan-v1');
    expect(oldPlan!.status).toBe('superseded');

    // New plan should have adjusted temperature
    const newPlanRecord = pm.getPlan(replanResult.newPlanId);
    const newPlan = newPlanRecord!.plan as typeof INITIAL_PLAN;
    const seqOp = newPlan.operations.find((o) => o.toolkit_op === 'sequence_design');
    expect(seqOp!.params.temperature).toBeLessThan(0.2); // temperature was lowered

    // === RE-EXECUTE: Run the new plan ===
    const callLog2: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const runner2 = makeMockRunner(callLog2);
    const queue2 = new ScienceQueue(1, 4, runner2);

    const executor2 = new PlanExecutor({
      projectManager: pm,
      scienceQueue: queue2,
      scienceCache: cache,
      toolkitLoader,
      projectDir: tmpDir,
      fileRouter,
      cardBuilder,
    });

    const result2 = await executor2.execute('proj-dbtl', replanResult.newPlanId);
    expect(result2.status).toBe('completed');
    expect(result2.completedOps).toHaveLength(8);

    // Verify the updated temperature reached the runner
    const seqCall = callLog2.find((c) => c.tool === 'sequence_design');
    expect(seqCall).toBeDefined();
    expect(seqCall!.params.temperature).toBeLessThan(0.2);
  });

  it('maintains version lineage through the DBTL cycle', async () => {
    // Quick pipeline execution
    const callLog: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const runner = makeMockRunner(callLog);
    const cache = new ScienceCache(cacheDir);
    const queue = new ScienceQueue(1, 4, runner);
    const manifests = toolkitLoader.resolveToolkits(['de-novo']);
    const fileRouter = new FileRouter(manifests);
    const cardBuilder = new CandidateCardBuilder({ projectManager: pm });

    const executor = new PlanExecutor({
      projectManager: pm,
      scienceQueue: queue,
      scienceCache: cache,
      toolkitLoader,
      projectDir: tmpDir,
      fileRouter,
      cardBuilder,
    });

    await executor.execute('proj-dbtl', 'plan-v1');

    // Record feedback + analyze + replan
    pm.recordFeedback({
      id: 'fb-lin',
      project_id: 'proj-dbtl',
      candidate_id: '',
      feedback: { feedback_id: 'fb-lin', project_id: 'proj-dbtl', candidate_id: '', assay_type: 'expression_titer', measurement: 0.01, pass_fail: 'fail' },
    });

    const analyzer = new LearningAnalyzer(pm);
    const update = analyzer.analyze('proj-dbtl');

    const replanner = new Replanner(pm);
    const replanResult = replanner.replan('proj-dbtl', update.update_id);

    // Verify lineage chain
    const v1 = pm.getPlan('plan-v1');
    const v2 = pm.getPlan(replanResult.newPlanId);
    expect(v1!.status).toBe('superseded');
    expect(v1!.version).toBe(1);
    expect(v2!.version).toBe(2);

    const v2Plan = v2!.plan as { _lineage?: { previous_plan_id: string; learning_update_ids: string[] } };
    expect(v2Plan._lineage).toBeDefined();
    expect(v2Plan._lineage!.previous_plan_id).toBe('plan-v1');
    expect(v2Plan._lineage!.learning_update_ids).toContain(update.update_id);

    // Learning update references the feedback
    const stored = pm.getLearningUpdates('proj-dbtl');
    expect(stored[0].source_feedback_refs).toContain('fb-lin');
  });
});
