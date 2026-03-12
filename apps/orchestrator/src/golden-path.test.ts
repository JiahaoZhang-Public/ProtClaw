/**
 * Golden Path Integration Test for De Novo Pipeline
 *
 * Exercises the full 8-operation pipeline with a mock runner that simulates
 * stub adapter outputs, validating file routing, caching, and candidate building.
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

const GOLDEN_PLAN = {
  plan_id: 'gp-1',
  project_id: 'proj-gp',
  version: 1,
  status: 'pending' as const,
  selected_toolkits: ['de-novo'],
  operations: [
    { op_id: 'gen', toolkit_op: 'backbone_generate', params: { contigs: '50-50', num_designs: 1 }, depends_on: [] },
    { op_id: 'seq', toolkit_op: 'sequence_design', params: { num_sequences: 1, temperature: 0.1 }, depends_on: ['gen'] },
    { op_id: 'pred', toolkit_op: 'structure_predict', params: {}, depends_on: ['seq'] },
    { op_id: 'qc', toolkit_op: 'structure_qc', params: {}, depends_on: ['pred'] },
    { op_id: 'dev', toolkit_op: 'developability_check', params: {}, depends_on: ['pred'] },
    { op_id: 'clust', toolkit_op: 'candidate_cluster', params: { n_clusters: 1 }, depends_on: ['qc', 'dev'] },
    { op_id: 'rank', toolkit_op: 'candidate_rank', params: {}, depends_on: ['clust'] },
    { op_id: 'pkg', toolkit_op: 'experiment_package', params: { project_name: 'GoldenPath' }, depends_on: ['rank'] },
  ],
};

/**
 * Mock runner that simulates what the real Python stub adapters produce.
 * Validates that upstream files were correctly routed to input directories.
 */
function makeGoldenPathRunner(callLog: string[]) {
  return async (config: ScienceRunConfig): Promise<ScienceRunResult> => {
    callLog.push(config.toolName);
    const filesDir = path.join(config.outputDir, 'files');
    fs.mkdirSync(filesDir, { recursive: true });

    let metrics: Record<string, unknown> = {};

    switch (config.toolName) {
      case 'backbone_generate': {
        fs.writeFileSync(
          path.join(filesDir, 'design_0000.pdb'),
          'ATOM      1  N   ALA A   1       0.000   0.000   0.000  1.00  0.00\nEND\n',
        );
        metrics = { num_designs_generated: 1, contigs: config.params.contigs };
        break;
      }
      case 'sequence_design': {
        // Validate PDB was routed from backbone_generate
        const inputFiles = path.join(config.inputDir, 'files');
        const pdbs = fs.existsSync(inputFiles)
          ? fs.readdirSync(inputFiles).filter((f) => f.endsWith('.pdb'))
          : [];
        if (pdbs.length === 0) throw new Error('sequence_design: no PDB files in input');

        fs.writeFileSync(
          path.join(filesDir, 'design_0000_designed.fasta'),
          '>design_0000|T=0.1\nMKTAYIAKQRQISFVKSHFS\n',
        );
        metrics = { total_sequences_designed: 1, sampling_temp: 0.1 };
        break;
      }
      case 'structure_predict': {
        // Validate FASTA was routed from sequence_design
        const inputFiles = path.join(config.inputDir, 'files');
        const fastas = fs.existsSync(inputFiles)
          ? fs.readdirSync(inputFiles).filter((f) => f.endsWith('.fasta'))
          : [];
        if (fastas.length === 0) throw new Error('structure_predict: no FASTA files in input');

        fs.writeFileSync(
          path.join(filesDir, 'predicted_0000.pdb'),
          'ATOM      1  N   MET A   1       1.000   1.000   1.000  1.00 85.00\nEND\n',
        );
        metrics = { num_structures_predicted: 1, avg_plddt: 85.0, avg_ptm: 0.91 };
        break;
      }
      case 'structure_qc': {
        // Validate PDB was routed from structure_predict
        const inputFiles = path.join(config.inputDir, 'files');
        const pdbs = fs.existsSync(inputFiles)
          ? fs.readdirSync(inputFiles).filter((f) => f.endsWith('.pdb'))
          : [];
        if (pdbs.length === 0) throw new Error('structure_qc: no PDB files in input');

        fs.writeFileSync(
          path.join(filesDir, 'qc_report.json'),
          JSON.stringify({ rmsd_angstrom: 1.2, clash_score: 0, ramachandran_favored: 95 }),
        );
        metrics = { rmsd_angstrom: 1.2, clash_score: 0 };
        break;
      }
      case 'developability_check': {
        fs.writeFileSync(
          path.join(filesDir, 'dev_report.json'),
          JSON.stringify({
            sequences: [{
              molecular_weight_da: 2300, isoelectric_point: 6.5,
              mean_hydrophobicity: -0.3, aggregation_propensity: 0.15,
            }],
          }),
        );
        metrics = { num_sequences_analyzed: 1, aggregation_propensity: 0.15, mean_hydrophobicity: -0.3 };
        break;
      }
      case 'candidate_cluster': {
        fs.writeFileSync(
          path.join(filesDir, 'clusters.json'),
          JSON.stringify({ clusters: [{ cluster_id: 0, candidates: ['design_0000'] }] }),
        );
        metrics = { mode: 'cluster', num_candidates: 1, num_clusters: 1 };
        break;
      }
      case 'candidate_rank': {
        fs.writeFileSync(
          path.join(filesDir, 'ranked.json'),
          JSON.stringify({ ranked: [{ id: 'design_0000', rank: 1, pareto_front: 0 }] }),
        );
        metrics = { mode: 'rank', num_candidates: 1, num_fronts: 1 };
        break;
      }
      case 'experiment_package': {
        fs.writeFileSync(path.join(filesDir, 'order_sheet.csv'), 'id,sequence\ndesign_0000,MKTAYIAKQRQISFVKSHFS\n');
        fs.writeFileSync(path.join(filesDir, 'report.html'), '<html><body>Report</body></html>');
        metrics = { num_candidates_packaged: 1, files_generated: 2 };
        break;
      }
    }

    // Write result.json
    const result = {
      status: 'success' as const,
      tool_name: config.toolName,
      tool_version: '1.0.0',
      metrics,
      output_files: fs.readdirSync(filesDir).map((f) => ({ path: f, type: path.extname(f).slice(1) })),
    };
    fs.writeFileSync(path.join(config.outputDir, 'result.json'), JSON.stringify(result));

    return {
      runId: config.runId,
      exitCode: 0,
      stdout: '',
      stderr: '',
      result,
      durationSeconds: 0.1,
    };
  };
}

describe('Golden Path: De Novo Pipeline', () => {
  let db: Database.Database;
  let pm: ProjectManager;
  let tmpDir: string;
  let cacheDir: string;
  let toolkitLoader: ToolkitLoader;

  beforeEach(() => {
    db = new Database(':memory:');
    createProtClawSchema(db);
    pm = new ProjectManager(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protclaw-gp-'));
    cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(cacheDir);

    // Create project
    pm.createProject('proj-gp', 'Golden Path Test', {});

    // Create plan in DB
    pm.createPlan('gp-1', 'proj-gp', GOLDEN_PLAN);

    // Load the real de-novo toolkit manifest
    const toolkitsDir = path.resolve(__dirname, '../../../toolkits');
    toolkitLoader = new ToolkitLoader(toolkitsDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('executes all 8 operations end-to-end with file routing', async () => {
    const callLog: string[] = [];
    const runner = makeGoldenPathRunner(callLog);

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

    const result = await executor.execute('proj-gp', 'gp-1');

    expect(result.status).toBe('completed');
    expect(result.completedOps).toHaveLength(8);
    expect(result.failedOps).toHaveLength(0);
    expect(result.skippedOps).toHaveLength(0);

    // All 8 tools were called
    expect(callLog).toHaveLength(8);
    expect(callLog).toContain('backbone_generate');
    expect(callLog).toContain('sequence_design');
    expect(callLog).toContain('structure_predict');
    expect(callLog).toContain('structure_qc');
    expect(callLog).toContain('developability_check');
    expect(callLog).toContain('candidate_cluster');
    expect(callLog).toContain('candidate_rank');
    expect(callLog).toContain('experiment_package');

    // Artifacts recorded for all ops
    expect(Object.keys(result.artifacts)).toHaveLength(8);

    // Candidate cards built
    expect(result.candidates).toBeDefined();
    expect(result.candidates!.length).toBeGreaterThanOrEqual(1);
    const card = result.candidates![0];
    expect(card.project_id).toBe('proj-gp');
    expect(card.sequence).not.toBe('UNKNOWN');
    expect(card.scores?.plddt).toBe(85.0);
    expect(card.scores?.ptm).toBe(0.91);
  });

  it('cache hit on re-execution skips runner calls', async () => {
    const callLog: string[] = [];
    const runner = makeGoldenPathRunner(callLog);

    const cache = new ScienceCache(cacheDir);
    const queue = new ScienceQueue(1, 4, runner);
    const manifests = toolkitLoader.resolveToolkits(['de-novo']);
    const fileRouter = new FileRouter(manifests);

    const executor = new PlanExecutor({
      projectManager: pm,
      scienceQueue: queue,
      scienceCache: cache,
      toolkitLoader,
      projectDir: tmpDir,
      fileRouter,
    });

    // First execution
    const result1 = await executor.execute('proj-gp', 'gp-1');
    expect(result1.status).toBe('completed');
    expect(callLog).toHaveLength(8);

    // Reset call log and re-create plan as pending
    callLog.length = 0;
    pm.createPlan('gp-2', 'proj-gp', { ...GOLDEN_PLAN, plan_id: 'gp-2', version: 2 });

    // Second execution with same params should hit cache
    const result2 = await executor.execute('proj-gp', 'gp-2');
    expect(result2.status).toBe('completed');
    // Cache hits mean fewer runner calls (root op has same params so cache hit)
    // At minimum, the first op should be cached since params are identical
    expect(callLog.length).toBeLessThan(8);
  });

  it('failure in mid-pipeline skips downstream dependents', async () => {
    const callLog: string[] = [];

    const failingRunner = async (config: ScienceRunConfig): Promise<ScienceRunResult> => {
      callLog.push(config.toolName);

      if (config.toolName === 'structure_predict') {
        // Write minimal output
        fs.mkdirSync(path.join(config.outputDir, 'files'), { recursive: true });
        return { runId: config.runId, exitCode: 1, stdout: '', stderr: 'GPU OOM', result: null, durationSeconds: 0.1 };
      }

      // Delegate to golden path runner for successful ops
      return makeGoldenPathRunner([])(config);
    };

    const cache = new ScienceCache(cacheDir);
    const queue = new ScienceQueue(1, 4, failingRunner);
    const manifests = toolkitLoader.resolveToolkits(['de-novo']);
    const fileRouter = new FileRouter(manifests);

    const executor = new PlanExecutor({
      projectManager: pm,
      scienceQueue: queue,
      scienceCache: cache,
      toolkitLoader,
      projectDir: tmpDir,
      fileRouter,
    });

    const result = await executor.execute('proj-gp', 'gp-1');

    expect(result.status).toBe('partial');
    // backbone_generate and sequence_design should complete
    expect(result.completedOps).toContain('gen');
    expect(result.completedOps).toContain('seq');
    // structure_predict failed
    expect(result.failedOps).toContain('pred');
    // All downstream should be skipped
    expect(result.skippedOps).toContain('qc');
    expect(result.skippedOps).toContain('dev');
    expect(result.skippedOps).toContain('clust');
    expect(result.skippedOps).toContain('rank');
    expect(result.skippedOps).toContain('pkg');
    // No candidate cards for partial execution
    expect(result.candidates).toBeUndefined();
  });
});
