import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import { ProjectManager } from './project-manager.js';

let db: Database.Database;
let pm: ProjectManager;

function initTestDb(): Database.Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      spec TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS design_plans (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      plan TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_design_plans_project_id ON design_plans(project_id);

    CREATE TABLE IF NOT EXISTS run_artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      plan_id TEXT NOT NULL DEFAULT '',
      op_id TEXT NOT NULL DEFAULT '',
      candidate_id TEXT NOT NULL DEFAULT '',
      artifact_type TEXT NOT NULL DEFAULT '',
      producer TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      artifact TEXT NOT NULL DEFAULT '{}',
      cache_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_run_artifacts_project_id ON run_artifacts(project_id);
    CREATE INDEX IF NOT EXISTS idx_run_artifacts_candidate_id ON run_artifacts(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_run_artifacts_status ON run_artifacts(status);
    CREATE INDEX IF NOT EXISTS idx_run_artifacts_op_id ON run_artifacts(op_id);

    CREATE TABLE IF NOT EXISTS evidence_records (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      record TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_records_candidate_id ON evidence_records(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_records_project_id ON evidence_records(project_id);

    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      sequence TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      rank INTEGER,
      card TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_candidates_project_id ON candidates(project_id);
    CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);

    CREATE TABLE IF NOT EXISTS experiment_feedback (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL DEFAULT '',
      feedback TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_experiment_feedback_project_id ON experiment_feedback(project_id);
    CREATE INDEX IF NOT EXISTS idx_experiment_feedback_candidate_id ON experiment_feedback(candidate_id);

    CREATE TABLE IF NOT EXISTS learning_updates (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_feedback_refs TEXT NOT NULL DEFAULT '[]',
      update_data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_learning_updates_project_id ON learning_updates(project_id);
  `);
  return database;
}

beforeEach(() => {
  db = initTestDb();
  pm = new ProjectManager(db);
});

// --- Project CRUD ---

describe('ProjectManager - projects', () => {
  it('creates and retrieves a project', () => {
    const project = pm.createProject('proj-1', 'Test Project', { task_type: 'binder_design' });
    expect(project.id).toBe('proj-1');
    expect(project.name).toBe('Test Project');
    expect(project.status).toBe('active');
    expect(project.spec).toEqual({ task_type: 'binder_design' });

    const retrieved = pm.getProject('proj-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('Test Project');
    expect(retrieved!.spec).toEqual({ task_type: 'binder_design' });
  });

  it('returns undefined for non-existent project', () => {
    expect(pm.getProject('nonexistent')).toBeUndefined();
  });

  it('updates project fields', () => {
    pm.createProject('proj-2', 'Original Name', { v: 1 });

    const updated = pm.updateProject('proj-2', { name: 'New Name', status: 'completed' });
    expect(updated.name).toBe('New Name');
    expect(updated.status).toBe('completed');
  });

  it('updates project spec', () => {
    pm.createProject('proj-3', 'Spec Test', { old: true });

    const updated = pm.updateProject('proj-3', { spec: { new: true } });
    expect(updated.spec).toEqual({ new: true });
  });

  it('lists all projects', () => {
    pm.createProject('proj-a', 'Project A', {});
    pm.createProject('proj-b', 'Project B', {});

    const projects = pm.listProjects();
    expect(projects).toHaveLength(2);
  });

  it('lists projects filtered by status', () => {
    pm.createProject('proj-x', 'Active', {});
    pm.createProject('proj-y', 'Also Active', {});
    pm.updateProject('proj-y', { status: 'archived' });

    const active = pm.listProjects('active');
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('proj-x');

    const archived = pm.listProjects('archived');
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe('proj-y');
  });
});

// --- Design Plans ---

describe('ProjectManager - design plans', () => {
  beforeEach(() => {
    pm.createProject('proj-plans', 'Plan Test', {});
  });

  it('creates and retrieves a plan', () => {
    pm.createPlan('plan-1', 'proj-plans', { operations: ['op1', 'op2'] });

    const plan = pm.getPlan('plan-1');
    expect(plan).toBeDefined();
    expect(plan!.project_id).toBe('proj-plans');
    expect(plan!.version).toBe(1);
    expect(plan!.plan).toEqual({ operations: ['op1', 'op2'] });
  });

  it('auto-increments version', () => {
    pm.createPlan('plan-v1', 'proj-plans', { v: 1 });
    pm.createPlan('plan-v2', 'proj-plans', { v: 2 });

    const v1 = pm.getPlan('plan-v1');
    const v2 = pm.getPlan('plan-v2');
    expect(v1!.version).toBe(1);
    expect(v2!.version).toBe(2);
  });

  it('gets latest plan for a project', () => {
    pm.createPlan('plan-old', 'proj-plans', { old: true });
    pm.createPlan('plan-new', 'proj-plans', { new: true });

    const latest = pm.getLatestPlan('proj-plans');
    expect(latest).toBeDefined();
    expect(latest!.id).toBe('plan-new');
    expect(latest!.version).toBe(2);
  });

  it('returns undefined for project with no plans', () => {
    expect(pm.getLatestPlan('proj-plans')).toBeUndefined();
  });
});

// --- Artifacts ---

describe('ProjectManager - artifacts', () => {
  beforeEach(() => {
    pm.createProject('proj-art', 'Artifact Test', {});
  });

  it('records and retrieves artifacts', () => {
    pm.recordArtifact({
      id: 'art-1',
      project_id: 'proj-art',
      plan_id: 'plan-1',
      op_id: 'op-1',
      candidate_id: 'cand-1',
      artifact_type: 'structure',
      producer: 'esmfold',
      status: 'completed',
      artifact: { pdb: 'path/to/file.pdb' },
      cache_key: 'abc123',
    });

    const artifacts = pm.getArtifacts('proj-art');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact).toEqual({ pdb: 'path/to/file.pdb' });
    expect(artifacts[0].producer).toBe('esmfold');
  });

  it('filters artifacts by candidateId', () => {
    pm.recordArtifact({
      id: 'art-a',
      project_id: 'proj-art',
      plan_id: '',
      op_id: '',
      candidate_id: 'cand-1',
      artifact_type: 'structure',
      producer: '',
      status: 'completed',
      artifact: {},
      cache_key: '',
    });
    pm.recordArtifact({
      id: 'art-b',
      project_id: 'proj-art',
      plan_id: '',
      op_id: '',
      candidate_id: 'cand-2',
      artifact_type: 'structure',
      producer: '',
      status: 'completed',
      artifact: {},
      cache_key: '',
    });

    const filtered = pm.getArtifacts('proj-art', { candidateId: 'cand-1' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('art-a');
  });

  it('filters artifacts by opId and type', () => {
    pm.recordArtifact({
      id: 'art-c',
      project_id: 'proj-art',
      plan_id: '',
      op_id: 'fold-op',
      candidate_id: '',
      artifact_type: 'structure',
      producer: '',
      status: 'completed',
      artifact: {},
      cache_key: '',
    });
    pm.recordArtifact({
      id: 'art-d',
      project_id: 'proj-art',
      plan_id: '',
      op_id: 'fold-op',
      candidate_id: '',
      artifact_type: 'metrics',
      producer: '',
      status: 'completed',
      artifact: {},
      cache_key: '',
    });

    const structures = pm.getArtifacts('proj-art', { opId: 'fold-op', type: 'structure' });
    expect(structures).toHaveLength(1);
    expect(structures[0].id).toBe('art-c');
  });
});

// --- Evidence ---

describe('ProjectManager - evidence', () => {
  beforeEach(() => {
    pm.createProject('proj-ev', 'Evidence Test', {});
  });

  it('records and retrieves evidence', () => {
    pm.recordEvidence({
      id: 'ev-1',
      candidate_id: 'cand-1',
      project_id: 'proj-ev',
      record: { metric: 'plddt', value: 85 },
    });

    const evidence = pm.getEvidence('proj-ev');
    expect(evidence).toHaveLength(1);
    expect(evidence[0].record).toEqual({ metric: 'plddt', value: 85 });
  });

  it('filters evidence by candidateId', () => {
    pm.recordEvidence({
      id: 'ev-a',
      candidate_id: 'cand-1',
      project_id: 'proj-ev',
      record: { v: 1 },
    });
    pm.recordEvidence({
      id: 'ev-b',
      candidate_id: 'cand-2',
      project_id: 'proj-ev',
      record: { v: 2 },
    });

    const filtered = pm.getEvidence('proj-ev', 'cand-1');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('ev-a');
  });
});

// --- Candidates ---

describe('ProjectManager - candidates', () => {
  beforeEach(() => {
    pm.createProject('proj-cand', 'Candidate Test', {});
  });

  it('creates and lists candidates', () => {
    pm.createCandidate({
      id: 'cand-1',
      project_id: 'proj-cand',
      sequence: 'MGKL...',
      status: 'draft',
      rank: null,
      card: { name: 'variant-1' },
    });

    const candidates = pm.listCandidates('proj-cand');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sequence).toBe('MGKL...');
    expect(candidates[0].card).toEqual({ name: 'variant-1' });
  });

  it('filters candidates by status', () => {
    pm.createCandidate({
      id: 'cand-a',
      project_id: 'proj-cand',
      sequence: 'A',
      status: 'active',
      rank: null,
      card: {},
    });
    pm.createCandidate({
      id: 'cand-b',
      project_id: 'proj-cand',
      sequence: 'B',
      status: 'rejected',
      rank: null,
      card: {},
    });

    const active = pm.listCandidates('proj-cand', 'active');
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('cand-a');
  });

  it('updates candidate status and rank', () => {
    pm.createCandidate({
      id: 'cand-up',
      project_id: 'proj-cand',
      sequence: 'SEQ',
      status: 'draft',
      rank: null,
      card: {},
    });

    pm.updateCandidate('cand-up', { status: 'active', rank: 1 });

    const candidates = pm.listCandidates('proj-cand');
    expect(candidates[0].status).toBe('active');
    expect(candidates[0].rank).toBe(1);
  });

  it('updates candidate card', () => {
    pm.createCandidate({
      id: 'cand-card',
      project_id: 'proj-cand',
      sequence: 'SEQ',
      status: 'draft',
      rank: null,
      card: { original: true },
    });

    pm.updateCandidate('cand-card', { card: { updated: true, score: 0.95 } });

    const candidates = pm.listCandidates('proj-cand');
    expect(candidates[0].card).toEqual({ updated: true, score: 0.95 });
  });
});

// --- Feedback ---

describe('ProjectManager - feedback', () => {
  beforeEach(() => {
    pm.createProject('proj-fb', 'Feedback Test', {});
  });

  it('records and retrieves feedback', () => {
    pm.recordFeedback({
      id: 'fb-1',
      project_id: 'proj-fb',
      candidate_id: 'cand-1',
      feedback: { result: 'positive', notes: 'Good binding' },
    });

    const feedback = pm.getFeedback('proj-fb');
    expect(feedback).toHaveLength(1);
    expect(feedback[0].feedback).toEqual({ result: 'positive', notes: 'Good binding' });
  });

  it('filters feedback by candidateId', () => {
    pm.recordFeedback({
      id: 'fb-a',
      project_id: 'proj-fb',
      candidate_id: 'cand-1',
      feedback: { v: 1 },
    });
    pm.recordFeedback({
      id: 'fb-b',
      project_id: 'proj-fb',
      candidate_id: 'cand-2',
      feedback: { v: 2 },
    });

    const filtered = pm.getFeedback('proj-fb', 'cand-1');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('fb-a');
  });
});

// --- Learning Updates ---

describe('ProjectManager - learning updates', () => {
  beforeEach(() => {
    pm.createProject('proj-lu', 'Learning Test', {});
  });

  it('records and retrieves learning updates', () => {
    pm.recordLearningUpdate({
      id: 'lu-1',
      project_id: 'proj-lu',
      source_feedback_refs: ['fb-1', 'fb-2'],
      update_data: { success_rate: 0.5, parameter_adjustments: [] },
    });

    const updates = pm.getLearningUpdates('proj-lu');
    expect(updates).toHaveLength(1);
    expect(updates[0].source_feedback_refs).toEqual(['fb-1', 'fb-2']);
    expect(updates[0].update_data).toEqual({ success_rate: 0.5, parameter_adjustments: [] });
  });

  it('returns updates ordered by created_at DESC', () => {
    pm.recordLearningUpdate({
      id: 'lu-a',
      project_id: 'proj-lu',
      source_feedback_refs: ['fb-1'],
      update_data: { v: 1 },
      created_at: '2024-01-01T00:00:00Z',
    });
    pm.recordLearningUpdate({
      id: 'lu-b',
      project_id: 'proj-lu',
      source_feedback_refs: ['fb-2'],
      update_data: { v: 2 },
      created_at: '2024-01-02T00:00:00Z',
    });

    const updates = pm.getLearningUpdates('proj-lu');
    expect(updates).toHaveLength(2);
    expect(updates[0].id).toBe('lu-b'); // most recent first
    expect(updates[1].id).toBe('lu-a');
  });
});

// --- Plan Status ---

describe('ProjectManager - updatePlanStatus', () => {
  beforeEach(() => {
    pm.createProject('proj-ps', 'Plan Status Test', {});
  });

  it('updates plan status to superseded', () => {
    pm.createPlan('plan-1', 'proj-ps', { operations: [] });
    pm.updatePlanStatus('plan-1', 'superseded');

    const plan = pm.getPlan('plan-1');
    expect(plan).toBeDefined();
    expect(plan!.status).toBe('superseded');
  });

  it('updates plan status to completed', () => {
    pm.createPlan('plan-2', 'proj-ps', { operations: [] });
    pm.updatePlanStatus('plan-2', 'completed');

    const plan = pm.getPlan('plan-2');
    expect(plan!.status).toBe('completed');
  });
});
