import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import { ProjectManager } from './project-manager.js';
import { createProtClawSchema } from './db.js';
import { Replanner } from './replanner.js';

let db: Database.Database;
let pm: ProjectManager;
let replanner: Replanner;

const BASE_PLAN = {
  plan_id: 'plan-1',
  project_id: 'proj-1',
  version: 1,
  status: 'completed' as const,
  selected_toolkits: ['de-novo'],
  operations: [
    { op_id: 'op-bg', toolkit_op: 'backbone_generate', params: { num_designs: 10, noise_scale: 1.0 } },
    { op_id: 'op-sd', toolkit_op: 'sequence_design', params: { temperature: 0.2, num_samples: 4 } },
    { op_id: 'op-sp', toolkit_op: 'structure_predict', params: { num_recycles: 3 }, depends_on: ['op-sd'] },
    { op_id: 'op-dc', toolkit_op: 'developability_check', params: { aggregation_threshold: 0.5 }, depends_on: ['op-sp'] },
  ],
};

function setupProjectWithLearning(paramAdjustments: object[], newConstraints?: string[]) {
  pm.createProject('proj-1', 'Test', {});
  pm.createPlan('plan-1', 'proj-1', BASE_PLAN);

  const updateData = {
    update_id: 'lu-1',
    project_id: 'proj-1',
    source_feedback_refs: ['fb-1', 'fb-2'],
    parameter_adjustments: paramAdjustments,
    new_constraints: newConstraints,
    success_rate: 0.3,
  };

  pm.recordLearningUpdate({
    id: 'lu-1',
    project_id: 'proj-1',
    source_feedback_refs: ['fb-1', 'fb-2'],
    update_data: updateData,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  createProtClawSchema(db);
  pm = new ProjectManager(db);
  replanner = new Replanner(pm);
});

describe('Replanner', () => {
  it('applies parameter adjustment to correct operation', () => {
    setupProjectWithLearning([
      { operation: 'sequence_design', parameter: 'temperature', old_value: 0.2, new_value: 0.15, rationale: 'Lower temperature' },
    ]);

    const result = replanner.replan('proj-1', 'lu-1');
    const newPlan = pm.getPlan(result.newPlanId);
    const ops = (newPlan!.plan as { operations: Array<{ toolkit_op: string; params: Record<string, number> }> }).operations;
    const sdOp = ops.find((o) => o.toolkit_op === 'sequence_design')!;
    expect(sdOp.params.temperature).toBe(0.15);
  });

  it('increments version number', () => {
    setupProjectWithLearning([]);

    const result = replanner.replan('proj-1', 'lu-1');
    expect(result.newVersion).toBe(2);

    const newPlan = pm.getPlan(result.newPlanId);
    expect(newPlan!.version).toBe(2);
  });

  it('marks old plan as superseded', () => {
    setupProjectWithLearning([]);

    replanner.replan('proj-1', 'lu-1');
    const oldPlan = pm.getPlan('plan-1');
    expect(oldPlan!.status).toBe('superseded');
  });

  it('appends new constraints to acceptance_rules', () => {
    setupProjectWithLearning([], ['Must improve expression_titer performance']);

    const result = replanner.replan('proj-1', 'lu-1');
    const newPlan = pm.getPlan(result.newPlanId);
    const plan = newPlan!.plan as { acceptance_rules?: string[] };
    expect(plan.acceptance_rules).toContain('Must improve expression_titer performance');
  });

  it('stores lineage metadata in plan JSON', () => {
    setupProjectWithLearning([]);

    const result = replanner.replan('proj-1', 'lu-1');
    const newPlan = pm.getPlan(result.newPlanId);
    const plan = newPlan!.plan as { _lineage?: { previous_plan_id: string; learning_update_ids: string[] } };
    expect(plan._lineage).toBeDefined();
    expect(plan._lineage!.previous_plan_id).toBe('plan-1');
    expect(plan._lineage!.learning_update_ids).toContain('lu-1');
  });

  it('applies multiple parameter adjustments', () => {
    setupProjectWithLearning([
      { operation: 'sequence_design', parameter: 'temperature', old_value: 0.2, new_value: 0.15, rationale: 'Lower' },
      { operation: 'backbone_generate', parameter: 'num_designs', old_value: 10, new_value: 20, rationale: 'More diversity' },
    ]);

    const result = replanner.replan('proj-1', 'lu-1');
    expect(result.changesApplied).toHaveLength(2);

    const newPlan = pm.getPlan(result.newPlanId);
    const ops = (newPlan!.plan as { operations: Array<{ toolkit_op: string; params: Record<string, number> }> }).operations;
    expect(ops.find((o) => o.toolkit_op === 'sequence_design')!.params.temperature).toBe(0.15);
    expect(ops.find((o) => o.toolkit_op === 'backbone_generate')!.params.num_designs).toBe(20);
  });

  it('returns human-readable changesApplied', () => {
    setupProjectWithLearning([
      { operation: 'sequence_design', parameter: 'temperature', old_value: 0.2, new_value: 0.15, rationale: 'Lower temperature' },
    ]);

    const result = replanner.replan('proj-1', 'lu-1');
    expect(result.changesApplied[0]).toContain('sequence_design.temperature');
    expect(result.changesApplied[0]).toContain('Lower temperature');
  });

  it('throws if no existing plan found', () => {
    pm.createProject('proj-empty', 'Empty', {});
    pm.recordLearningUpdate({ id: 'lu-x', project_id: 'proj-empty', source_feedback_refs: ['fb-1'], update_data: {} });

    expect(() => replanner.replan('proj-empty', 'lu-x')).toThrow('No existing plan found');
  });

  it('throws if learning update not found', () => {
    pm.createProject('proj-2', 'Test', {});
    pm.createPlan('plan-2', 'proj-2', BASE_PLAN);

    expect(() => replanner.replan('proj-2', 'lu-nonexistent')).toThrow('Learning update lu-nonexistent not found');
  });
});
