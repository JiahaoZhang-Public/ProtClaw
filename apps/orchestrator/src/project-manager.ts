import Database from 'better-sqlite3';

import {
  ProjectRecord,
  DesignPlanRecord,
  RunArtifactRecord,
  EvidenceRecordEntry,
  CandidateRecord,
  FeedbackRecord,
  LearningUpdateRecord,
} from './types.js';

/**
 * ProjectManager provides CRUD operations for ProtClaw domain entities.
 * Wraps better-sqlite3 prepared statements over the ProtClaw tables.
 */
export class ProjectManager {
  constructor(private db: Database.Database) {}

  // --- Projects ---

  createProject(id: string, name: string, spec: object): ProjectRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, spec, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, name, JSON.stringify(spec), now, now);
    return { id, name, spec, status: 'active', created_at: now, updated_at: now };
  }

  getProject(id: string): ProjectRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as { id: string; name: string; spec: string; status: string; created_at: string; updated_at: string } | undefined;
    if (!row) return undefined;
    return {
      ...row,
      spec: JSON.parse(row.spec),
      status: row.status as ProjectRecord['status'],
    };
  }

  updateProject(
    id: string,
    updates: Partial<Pick<ProjectRecord, 'name' | 'spec' | 'status'>>,
  ): ProjectRecord {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.spec !== undefined) {
      fields.push('spec = ?');
      values.push(JSON.stringify(updates.spec));
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }

    if (fields.length > 0) {
      fields.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(id);
      this.db
        .prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`)
        .run(...values);
    }

    return this.getProject(id)!;
  }

  listProjects(status?: string): ProjectRecord[] {
    let sql = 'SELECT * FROM projects';
    const params: unknown[] = [];
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC';

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string; name: string; spec: string; status: string; created_at: string; updated_at: string;
    }>;
    return rows.map((row) => ({
      ...row,
      spec: JSON.parse(row.spec),
      status: row.status as ProjectRecord['status'],
    }));
  }

  // --- Design Plans ---

  createPlan(planId: string, projectId: string, plan: object): void {
    // Auto-increment version for this project
    const maxVersion = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) as v FROM design_plans WHERE project_id = ?')
      .get(projectId) as { v: number };
    const version = maxVersion.v + 1;

    this.db
      .prepare(
        `INSERT INTO design_plans (id, project_id, version, status, plan, created_at) VALUES (?, ?, ?, 'draft', ?, ?)`,
      )
      .run(planId, projectId, version, JSON.stringify(plan), new Date().toISOString());
  }

  getPlan(planId: string): DesignPlanRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM design_plans WHERE id = ?')
      .get(planId) as { id: string; project_id: string; version: number; status: string; plan: string; created_at: string } | undefined;
    if (!row) return undefined;
    return {
      ...row,
      plan: JSON.parse(row.plan),
      status: row.status as DesignPlanRecord['status'],
    };
  }

  getLatestPlan(projectId: string): DesignPlanRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM design_plans WHERE project_id = ? ORDER BY version DESC LIMIT 1')
      .get(projectId) as { id: string; project_id: string; version: number; status: string; plan: string; created_at: string } | undefined;
    if (!row) return undefined;
    return {
      ...row,
      plan: JSON.parse(row.plan),
      status: row.status as DesignPlanRecord['status'],
    };
  }

  // --- Artifacts ---

  recordArtifact(artifact: Omit<RunArtifactRecord, 'created_at'> & { created_at?: string }): void {
    const now = artifact.created_at || new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO run_artifacts (id, project_id, plan_id, op_id, candidate_id, artifact_type, producer, status, artifact, cache_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.project_id,
        artifact.plan_id || '',
        artifact.op_id || '',
        artifact.candidate_id || '',
        artifact.artifact_type || '',
        artifact.producer || '',
        artifact.status || 'pending',
        JSON.stringify(artifact.artifact || {}),
        artifact.cache_key || '',
        now,
      );
  }

  getArtifacts(
    projectId: string,
    filters?: { candidateId?: string; opId?: string; type?: string },
  ): RunArtifactRecord[] {
    let sql = 'SELECT * FROM run_artifacts WHERE project_id = ?';
    const params: unknown[] = [projectId];

    if (filters?.candidateId) {
      sql += ' AND candidate_id = ?';
      params.push(filters.candidateId);
    }
    if (filters?.opId) {
      sql += ' AND op_id = ?';
      params.push(filters.opId);
    }
    if (filters?.type) {
      sql += ' AND artifact_type = ?';
      params.push(filters.type);
    }

    sql += ' ORDER BY created_at DESC';

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string; project_id: string; plan_id: string; op_id: string; candidate_id: string;
      artifact_type: string; producer: string; status: string; artifact: string;
      cache_key: string; created_at: string;
    }>;

    return rows.map((row) => ({
      ...row,
      artifact: JSON.parse(row.artifact),
      status: row.status as RunArtifactRecord['status'],
    }));
  }

  // --- Evidence ---

  recordEvidence(evidence: Omit<EvidenceRecordEntry, 'created_at'> & { created_at?: string }): void {
    const now = evidence.created_at || new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO evidence_records (id, candidate_id, project_id, record, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        evidence.id,
        evidence.candidate_id || '',
        evidence.project_id || '',
        JSON.stringify(evidence.record || {}),
        now,
      );
  }

  getEvidence(projectId: string, candidateId?: string): EvidenceRecordEntry[] {
    let sql = 'SELECT * FROM evidence_records WHERE project_id = ?';
    const params: unknown[] = [projectId];

    if (candidateId) {
      sql += ' AND candidate_id = ?';
      params.push(candidateId);
    }
    sql += ' ORDER BY created_at DESC';

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string; candidate_id: string; project_id: string; record: string; created_at: string;
    }>;
    return rows.map((row) => ({
      ...row,
      record: JSON.parse(row.record),
    }));
  }

  // --- Candidates ---

  createCandidate(candidate: Omit<CandidateRecord, 'created_at' | 'updated_at'> & { created_at?: string; updated_at?: string }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO candidates (id, project_id, sequence, status, rank, card, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.id,
        candidate.project_id,
        candidate.sequence || '',
        candidate.status || 'draft',
        candidate.rank ?? null,
        JSON.stringify(candidate.card || {}),
        candidate.created_at || now,
        candidate.updated_at || now,
      );
  }

  listCandidates(projectId: string, status?: string): CandidateRecord[] {
    let sql = 'SELECT * FROM candidates WHERE project_id = ?';
    const params: unknown[] = [projectId];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY rank ASC, created_at DESC';

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string; project_id: string; sequence: string; status: string;
      rank: number | null; card: string; created_at: string; updated_at: string;
    }>;
    return rows.map((row) => ({
      ...row,
      card: JSON.parse(row.card),
      status: row.status as CandidateRecord['status'],
    }));
  }

  updateCandidate(
    candidateId: string,
    updates: Partial<Pick<CandidateRecord, 'status' | 'rank' | 'card' | 'sequence'>>,
  ): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.rank !== undefined) {
      fields.push('rank = ?');
      values.push(updates.rank);
    }
    if (updates.card !== undefined) {
      fields.push('card = ?');
      values.push(JSON.stringify(updates.card));
    }
    if (updates.sequence !== undefined) {
      fields.push('sequence = ?');
      values.push(updates.sequence);
    }

    if (fields.length > 0) {
      fields.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(candidateId);
      this.db
        .prepare(`UPDATE candidates SET ${fields.join(', ')} WHERE id = ?`)
        .run(...values);
    }
  }

  // --- Feedback ---

  recordFeedback(feedback: Omit<FeedbackRecord, 'created_at'> & { created_at?: string }): void {
    const now = feedback.created_at || new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO experiment_feedback (id, project_id, candidate_id, feedback, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        feedback.id,
        feedback.project_id,
        feedback.candidate_id || '',
        JSON.stringify(feedback.feedback || {}),
        now,
      );
  }

  getFeedback(projectId: string, candidateId?: string): FeedbackRecord[] {
    let sql = 'SELECT * FROM experiment_feedback WHERE project_id = ?';
    const params: unknown[] = [projectId];

    if (candidateId) {
      sql += ' AND candidate_id = ?';
      params.push(candidateId);
    }
    sql += ' ORDER BY created_at DESC';

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string; project_id: string; candidate_id: string; feedback: string; created_at: string;
    }>;
    return rows.map((row) => ({
      ...row,
      feedback: JSON.parse(row.feedback),
    }));
  }

  // --- Learning Updates ---

  recordLearningUpdate(update: Omit<LearningUpdateRecord, 'created_at'> & { created_at?: string }): void {
    const now = update.created_at || new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO learning_updates (id, project_id, source_feedback_refs, update_data, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        update.id,
        update.project_id,
        JSON.stringify(update.source_feedback_refs || []),
        JSON.stringify(update.update_data || {}),
        now,
      );
  }

  getLearningUpdates(projectId: string): LearningUpdateRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM learning_updates WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as Array<{
        id: string; project_id: string; source_feedback_refs: string; update_data: string; created_at: string;
      }>;
    return rows.map((row) => ({
      ...row,
      source_feedback_refs: JSON.parse(row.source_feedback_refs),
      update_data: JSON.parse(row.update_data),
    }));
  }

  updatePlanStatus(planId: string, status: DesignPlanRecord['status']): void {
    this.db
      .prepare('UPDATE design_plans SET status = ? WHERE id = ?')
      .run(status, planId);
  }
}
