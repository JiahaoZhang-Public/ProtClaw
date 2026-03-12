import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProtClawSchema } from './db.js';
import { ProjectManager } from './project-manager.js';
import { CandidateCardBuilder } from './candidate-card-builder.js';
import type { PlanExecutionResult } from './plan-executor.js';

describe('CandidateCardBuilder', () => {
  let db: Database.Database;
  let pm: ProjectManager;
  let builder: CandidateCardBuilder;
  let tmpDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createProtClawSchema(db);
    pm = new ProjectManager(db);
    builder = new CandidateCardBuilder({ projectManager: pm });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protclaw-cards-'));

    // Create a project
    pm.createProject('proj-1', 'Test Project', {});
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeResultJson(opId: string, metrics: Record<string, unknown>): void {
    const resultDir = path.join(tmpDir, 'proj-1', 'runs', 'plan-1', opId, 'output');
    fs.mkdirSync(resultDir, { recursive: true });
    fs.writeFileSync(
      path.join(resultDir, 'result.json'),
      JSON.stringify({ status: 'success', metrics }),
    );
  }

  function writeOutputFile(opId: string, filename: string, content: string): void {
    const filesDir = path.join(tmpDir, 'proj-1', 'runs', 'plan-1', opId, 'output', 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(path.join(filesDir, filename), content);
  }

  function makeResult(overrides: Partial<PlanExecutionResult> = {}): PlanExecutionResult {
    return {
      planId: 'plan-1',
      status: 'completed',
      completedOps: ['gen', 'seq', 'pred', 'qc', 'dev', 'clust', 'rank', 'pkg'],
      failedOps: [],
      skippedOps: [],
      artifacts: {
        gen: 'art-gen',
        seq: 'art-seq',
        pred: 'art-pred',
        qc: 'art-qc',
        dev: 'art-dev',
        clust: 'art-clust',
        rank: 'art-rank',
        pkg: 'art-pkg',
      },
      opToolkitOps: {
        gen: 'backbone_generate',
        seq: 'sequence_design',
        pred: 'structure_predict',
        qc: 'structure_qc',
        dev: 'developability_check',
        clust: 'candidate_cluster',
        rank: 'candidate_rank',
        pkg: 'experiment_package',
      },
      ...overrides,
    };
  }

  it('builds candidate cards with scores from all stages', () => {
    writeResultJson('pred', { avg_plddt: 85.5, avg_ptm: 0.92 });
    writeResultJson('qc', { rmsd_angstrom: 1.2, clash_score: 0 });
    writeResultJson('dev', { aggregation_propensity: 0.15, mean_hydrophobicity: -0.3 });
    writeResultJson('rank', { num_fronts: 2 });
    writeOutputFile('seq', 'design.fasta', '>design_0\nMKTAYIAKQ\n');

    const cards = builder.buildCards('proj-1', 'plan-1', makeResult(), tmpDir);

    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.project_id).toBe('proj-1');
    expect(card.status).toBe('active');
    expect(card.sequence).toBe('MKTAYIAKQ');
    expect(card.scores?.plddt).toBe(85.5);
    expect(card.scores?.ptm).toBe(0.92);
    expect(card.scores?.rmsd_to_design).toBe(1.2);
    expect(card.scores?.aggregation_score).toBe(0.15);
    expect(card.scores?.solubility_score).toBe(0.3); // negated hydrophobicity
  });

  it('builds correct design lineage', () => {
    writeResultJson('pred', { avg_plddt: 80 });
    writeOutputFile('seq', 'seq.fasta', '>s\nAAAA\n');

    const cards = builder.buildCards('proj-1', 'plan-1', makeResult(), tmpDir);

    expect(cards[0].design_lineage).toEqual({
      backbone_artifact_id: 'art-gen',
      sequence_artifact_id: 'art-seq',
      structure_artifact_id: 'art-pred',
    });
  });

  it('persists candidate via ProjectManager', () => {
    writeResultJson('pred', { avg_plddt: 80 });
    writeOutputFile('seq', 'seq.fasta', '>s\nAAAA\n');

    const cards = builder.buildCards('proj-1', 'plan-1', makeResult(), tmpDir);

    const saved = pm.listCandidates('proj-1');
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(cards[0].candidate_id);
    expect(saved[0].sequence).toBe('AAAA');
  });

  it('returns empty array for failed execution', () => {
    const cards = builder.buildCards(
      'proj-1', 'plan-1',
      makeResult({ status: 'failed' }),
      tmpDir,
    );
    expect(cards).toHaveLength(0);
  });

  it('handles missing result files gracefully', () => {
    // No result.json written, but pipeline "completed" — should still produce a card
    writeOutputFile('seq', 'seq.fasta', '>s\nGGGG\n');

    const cards = builder.buildCards('proj-1', 'plan-1', makeResult(), tmpDir);

    expect(cards).toHaveLength(1);
    expect(cards[0].sequence).toBe('GGGG');
    expect(cards[0].scores).toBeUndefined(); // No metrics available
  });

  it('handles missing sequence file', () => {
    writeResultJson('pred', { avg_plddt: 80 });
    // No FASTA file

    const cards = builder.buildCards('proj-1', 'plan-1', makeResult(), tmpDir);

    expect(cards).toHaveLength(1);
    expect(cards[0].sequence).toBe('UNKNOWN');
  });
});
