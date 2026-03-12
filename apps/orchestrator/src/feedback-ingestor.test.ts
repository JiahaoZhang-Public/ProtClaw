import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProjectManager } from './project-manager.js';
import { createProtClawSchema } from './db.js';
import { FeedbackIngestor } from './feedback-ingestor.js';

let db: Database.Database;
let pm: ProjectManager;
let ingestor: FeedbackIngestor;

beforeEach(() => {
  db = new Database(':memory:');
  createProtClawSchema(db);
  pm = new ProjectManager(db);
  ingestor = new FeedbackIngestor(pm);
  pm.createProject('proj-1', 'Test Project', {});
  pm.createCandidate({ id: 'cand-1', project_id: 'proj-1', sequence: 'MGKL', status: 'active', rank: null, card: {} });
  pm.createCandidate({ id: 'cand-2', project_id: 'proj-1', sequence: 'ARND', status: 'active', rank: null, card: {} });
});

describe('FeedbackIngestor - JSON', () => {
  it('ingests valid JSON feedback entries', () => {
    const records = [
      { feedback_id: 'fb-1', project_id: 'proj-1', candidate_id: 'cand-1', assay_type: 'SPR', measurement: 5.2, pass_fail: 'pass' },
      { feedback_id: 'fb-2', project_id: 'proj-1', candidate_id: 'cand-2', assay_type: 'expression_titer', measurement: 0.1, pass_fail: 'fail' },
    ];

    const result = ingestor.ingestJson('proj-1', records);
    expect(result.total).toBe(2);
    expect(result.accepted).toBe(2);
    expect(result.rejected).toBe(0);
    expect(result.errors).toHaveLength(0);

    const stored = pm.getFeedback('proj-1');
    expect(stored).toHaveLength(2);
  });

  it('rejects invalid records and reports errors', () => {
    const records = [
      { feedback_id: 'fb-ok', project_id: 'proj-1', candidate_id: 'cand-1', assay_type: 'SPR', measurement: 5.2 },
      { feedback_id: 'fb-bad', project_id: 'proj-1' }, // missing required fields
    ];

    const result = ingestor.ingestJson('proj-1', records);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(1);
  });

  it('updates candidate status to rejected on fail', () => {
    const records = [
      { feedback_id: 'fb-f', project_id: 'proj-1', candidate_id: 'cand-1', assay_type: 'SPR', measurement: 0.1, pass_fail: 'fail' },
    ];

    const result = ingestor.ingestJson('proj-1', records);
    expect(result.candidateStatusUpdates).toEqual([{ candidateId: 'cand-1', newStatus: 'rejected' }]);

    const candidates = pm.listCandidates('proj-1');
    const cand = candidates.find((c) => c.id === 'cand-1');
    expect(cand!.status).toBe('rejected');
  });

  it('updates candidate status to promoted on pass', () => {
    const records = [
      { feedback_id: 'fb-p', project_id: 'proj-1', candidate_id: 'cand-2', assay_type: 'SPR', measurement: 5.2, pass_fail: 'pass' },
    ];

    const result = ingestor.ingestJson('proj-1', records);
    expect(result.candidateStatusUpdates).toEqual([{ candidateId: 'cand-2', newStatus: 'promoted' }]);
  });

  it('does not update candidate status when pass_fail is null', () => {
    const records = [
      { feedback_id: 'fb-n', project_id: 'proj-1', candidate_id: 'cand-1', assay_type: 'SPR', measurement: 3.0, pass_fail: null },
    ];

    const result = ingestor.ingestJson('proj-1', records);
    expect(result.candidateStatusUpdates).toHaveLength(0);
    const candidates = pm.listCandidates('proj-1');
    expect(candidates.find((c) => c.id === 'cand-1')!.status).toBe('active');
  });

  it('handles empty input array', () => {
    const result = ingestor.ingestJson('proj-1', []);
    expect(result.total).toBe(0);
    expect(result.accepted).toBe(0);
  });
});

describe('FeedbackIngestor - CSV', () => {
  it('parses CSV and ingests records', () => {
    const csv = [
      'feedback_id,project_id,candidate_id,assay_type,measurement,unit,pass_fail',
      'fb-c1,proj-1,cand-1,SPR,5.2,nM,pass',
      'fb-c2,proj-1,cand-2,expression_titer,0.1,mg/L,fail',
    ].join('\n');

    const result = ingestor.ingestCsv('proj-1', csv);
    expect(result.total).toBe(2);
    expect(result.accepted).toBe(2);

    const stored = pm.getFeedback('proj-1');
    expect(stored).toHaveLength(2);
    // Check measurement is stored as number
    const fb = stored.find((f) => f.id === 'fb-c1')!.feedback as { measurement: number };
    expect(fb.measurement).toBe(5.2);
  });

  it('handles CSV with quoted fields', () => {
    const csv = [
      'feedback_id,project_id,candidate_id,assay_type,measurement,notes',
      'fb-q,proj-1,cand-1,SPR,3.5,"Contains, comma"',
    ].join('\n');

    const result = ingestor.ingestCsv('proj-1', csv);
    expect(result.accepted).toBe(1);
    const fb = pm.getFeedback('proj-1')[0].feedback as { notes: string };
    expect(fb.notes).toBe('Contains, comma');
  });

  it('returns empty result for header-only CSV', () => {
    const csv = 'feedback_id,project_id,candidate_id,assay_type,measurement';
    const result = ingestor.ingestCsv('proj-1', csv);
    expect(result.total).toBe(0);
  });
});

describe('FeedbackIngestor - file', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingestor-'));
  });

  it('ingests a JSON file', () => {
    const filePath = path.join(tmpDir, 'feedback.json');
    fs.writeFileSync(filePath, JSON.stringify([
      { feedback_id: 'fb-f1', project_id: 'proj-1', candidate_id: 'cand-1', assay_type: 'SPR', measurement: 4.0 },
    ]));

    const result = ingestor.ingestFile('proj-1', filePath);
    expect(result.accepted).toBe(1);
  });

  it('ingests a CSV file', () => {
    const filePath = path.join(tmpDir, 'feedback.csv');
    fs.writeFileSync(filePath, [
      'feedback_id,project_id,candidate_id,assay_type,measurement,pass_fail',
      'fb-cf,proj-1,cand-1,SPR,2.1,pass',
    ].join('\n'));

    const result = ingestor.ingestFile('proj-1', filePath);
    expect(result.accepted).toBe(1);
  });
});
