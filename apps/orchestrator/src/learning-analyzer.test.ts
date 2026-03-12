import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import { ProjectManager } from './project-manager.js';
import { createProtClawSchema } from './db.js';
import { LearningAnalyzer } from './learning-analyzer.js';

let db: Database.Database;
let pm: ProjectManager;
let analyzer: LearningAnalyzer;

function setupProjectWithPlan() {
  pm.createProject('proj-1', 'Test', {});
  pm.createPlan('plan-1', 'proj-1', {
    plan_id: 'plan-1',
    project_id: 'proj-1',
    version: 1,
    status: 'completed',
    selected_toolkits: ['de-novo'],
    operations: [
      { op_id: 'op-bg', toolkit_op: 'backbone_generate', params: { num_designs: 10 } },
      { op_id: 'op-sd', toolkit_op: 'sequence_design', params: { temperature: 0.2 } },
      { op_id: 'op-sp', toolkit_op: 'structure_predict', params: { num_recycles: 3 } },
      { op_id: 'op-dc', toolkit_op: 'developability_check', params: { aggregation_threshold: 0.5 } },
    ],
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  createProtClawSchema(db);
  pm = new ProjectManager(db);
  analyzer = new LearningAnalyzer(pm);
});

describe('LearningAnalyzer', () => {
  it('returns success_rate = 1 when all feedback passes', () => {
    setupProjectWithPlan();
    pm.recordFeedback({ id: 'fb-1', project_id: 'proj-1', candidate_id: 'c1', feedback: { feedback_id: 'fb-1', project_id: 'proj-1', candidate_id: 'c1', assay_type: 'SPR', measurement: 5, pass_fail: 'pass' } });
    pm.recordFeedback({ id: 'fb-2', project_id: 'proj-1', candidate_id: 'c2', feedback: { feedback_id: 'fb-2', project_id: 'proj-1', candidate_id: 'c2', assay_type: 'SPR', measurement: 3, pass_fail: 'pass' } });

    const update = analyzer.analyze('proj-1');
    expect(update.success_rate).toBe(1.0);
    expect(update.observed_failure_patterns).toBeUndefined();
    expect(update.parameter_adjustments).toBeUndefined();
  });

  it('detects failure pattern for expression_titer and suggests temperature adjustment', () => {
    setupProjectWithPlan();
    pm.recordFeedback({ id: 'fb-1', project_id: 'proj-1', candidate_id: 'c1', feedback: { feedback_id: 'fb-1', project_id: 'proj-1', candidate_id: 'c1', assay_type: 'expression_titer', measurement: 0.1, pass_fail: 'fail' } });
    pm.recordFeedback({ id: 'fb-2', project_id: 'proj-1', candidate_id: 'c2', feedback: { feedback_id: 'fb-2', project_id: 'proj-1', candidate_id: 'c2', assay_type: 'expression_titer', measurement: 0.05, pass_fail: 'fail' } });

    const update = analyzer.analyze('proj-1');
    expect(update.success_rate).toBe(0);
    expect(update.observed_failure_patterns).toHaveLength(1);
    expect(update.observed_failure_patterns![0].pattern).toContain('expression_titer');

    expect(update.parameter_adjustments).toHaveLength(1);
    expect(update.parameter_adjustments![0].operation).toBe('sequence_design');
    expect(update.parameter_adjustments![0].parameter).toBe('temperature');
    expect(update.parameter_adjustments![0].old_value).toBe(0.2);
    expect(update.parameter_adjustments![0].new_value).toBeCloseTo(0.15);
  });

  it('computes correct success rate for mixed results', () => {
    setupProjectWithPlan();
    pm.recordFeedback({ id: 'fb-1', project_id: 'proj-1', candidate_id: 'c1', feedback: { feedback_id: 'fb-1', project_id: 'proj-1', candidate_id: 'c1', assay_type: 'SPR', measurement: 5, pass_fail: 'pass' } });
    pm.recordFeedback({ id: 'fb-2', project_id: 'proj-1', candidate_id: 'c2', feedback: { feedback_id: 'fb-2', project_id: 'proj-1', candidate_id: 'c2', assay_type: 'SPR', measurement: 0.1, pass_fail: 'fail' } });
    pm.recordFeedback({ id: 'fb-3', project_id: 'proj-1', candidate_id: 'c3', feedback: { feedback_id: 'fb-3', project_id: 'proj-1', candidate_id: 'c3', assay_type: 'SPR', measurement: 4, pass_fail: 'pass' } });

    const update = analyzer.analyze('proj-1');
    expect(update.success_rate).toBeCloseTo(2 / 3);
  });

  it('generates separate failure patterns per assay type', () => {
    setupProjectWithPlan();
    // expression_titer: 2 fail
    pm.recordFeedback({ id: 'fb-1', project_id: 'proj-1', candidate_id: 'c1', feedback: { feedback_id: 'fb-1', project_id: 'proj-1', candidate_id: 'c1', assay_type: 'expression_titer', measurement: 0.1, pass_fail: 'fail' } });
    pm.recordFeedback({ id: 'fb-2', project_id: 'proj-1', candidate_id: 'c2', feedback: { feedback_id: 'fb-2', project_id: 'proj-1', candidate_id: 'c2', assay_type: 'expression_titer', measurement: 0.05, pass_fail: 'fail' } });
    // DSF: 2 fail
    pm.recordFeedback({ id: 'fb-3', project_id: 'proj-1', candidate_id: 'c3', feedback: { feedback_id: 'fb-3', project_id: 'proj-1', candidate_id: 'c3', assay_type: 'DSF', measurement: 40, pass_fail: 'fail' } });
    pm.recordFeedback({ id: 'fb-4', project_id: 'proj-1', candidate_id: 'c4', feedback: { feedback_id: 'fb-4', project_id: 'proj-1', candidate_id: 'c4', assay_type: 'DSF', measurement: 35, pass_fail: 'fail' } });

    const update = analyzer.analyze('proj-1');
    expect(update.observed_failure_patterns).toHaveLength(2);

    const patterns = update.observed_failure_patterns!.map((p) => p.pattern);
    expect(patterns).toContain('High failure rate in expression_titer');
    expect(patterns).toContain('High failure rate in DSF');

    // Should have 2 adjustments: sequence_design.temperature + structure_predict.num_recycles
    expect(update.parameter_adjustments).toHaveLength(2);
    const ops = update.parameter_adjustments!.map((a) => a.operation);
    expect(ops).toContain('sequence_design');
    expect(ops).toContain('structure_predict');
  });

  it('filters by specific feedback IDs', () => {
    setupProjectWithPlan();
    pm.recordFeedback({ id: 'fb-1', project_id: 'proj-1', candidate_id: 'c1', feedback: { feedback_id: 'fb-1', project_id: 'proj-1', candidate_id: 'c1', assay_type: 'SPR', measurement: 5, pass_fail: 'pass' } });
    pm.recordFeedback({ id: 'fb-2', project_id: 'proj-1', candidate_id: 'c2', feedback: { feedback_id: 'fb-2', project_id: 'proj-1', candidate_id: 'c2', assay_type: 'SPR', measurement: 0.1, pass_fail: 'fail' } });

    // Only analyze fb-1
    const update = analyzer.analyze('proj-1', ['fb-1']);
    expect(update.success_rate).toBe(1.0);
    expect(update.source_feedback_refs).toEqual(['fb-1']);
  });

  it('persists learning update via ProjectManager', () => {
    setupProjectWithPlan();
    pm.recordFeedback({ id: 'fb-1', project_id: 'proj-1', candidate_id: 'c1', feedback: { feedback_id: 'fb-1', project_id: 'proj-1', candidate_id: 'c1', assay_type: 'SPR', measurement: 5, pass_fail: 'pass' } });

    const update = analyzer.analyze('proj-1');
    const stored = pm.getLearningUpdates('proj-1');
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(update.update_id);
  });

  it('adds new_constraints for 100% failure assay types', () => {
    setupProjectWithPlan();
    pm.recordFeedback({ id: 'fb-1', project_id: 'proj-1', candidate_id: 'c1', feedback: { feedback_id: 'fb-1', project_id: 'proj-1', candidate_id: 'c1', assay_type: 'expression_titer', measurement: 0.1, pass_fail: 'fail' } });

    const update = analyzer.analyze('proj-1');
    expect(update.new_constraints).toContain('Must improve expression_titer performance');
  });

  it('validates output against LearningUpdateSchema', () => {
    setupProjectWithPlan();
    pm.recordFeedback({ id: 'fb-1', project_id: 'proj-1', candidate_id: 'c1', feedback: { feedback_id: 'fb-1', project_id: 'proj-1', candidate_id: 'c1', assay_type: 'SPR', measurement: 5, pass_fail: 'pass' } });

    const update = analyzer.analyze('proj-1');
    // If we got here without error, schema validation passed (done inside analyze())
    expect(update.update_id).toBeDefined();
    expect(update.project_id).toBe('proj-1');
    expect(update.source_feedback_refs.length).toBeGreaterThan(0);
  });
});
