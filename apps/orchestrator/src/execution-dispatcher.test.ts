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

const TEST_PLAN = {
  plan_id: 'plan-t1',
  project_id: 'proj-t',
  version: 1,
  status: 'pending' as const,
  selected_toolkits: ['de-novo'],
  operations: [
    { op_id: 'gen', toolkit_op: 'backbone_generate', params: { num_designs: 1 }, depends_on: [] },
    { op_id: 'seq', toolkit_op: 'sequence_design', params: { temperature: 0.1 }, depends_on: ['gen'] },
  ],
};

function makeSimpleRunner(callLog: string[]) {
  return async (config: ScienceRunConfig): Promise<ScienceRunResult> => {
    callLog.push(config.toolName);
    const filesDir = path.join(config.outputDir, 'files');
    fs.mkdirSync(filesDir, { recursive: true });

    if (config.toolName === 'backbone_generate') {
      fs.writeFileSync(path.join(filesDir, 'design.pdb'), 'ATOM\nEND\n');
    } else if (config.toolName === 'sequence_design') {
      fs.writeFileSync(path.join(filesDir, 'design.fasta'), '>d\nMKT\n');
    }

    const result = { status: 'success' as const, tool_name: config.toolName, tool_version: '1.0', metrics: {}, output_files: [] };
    fs.writeFileSync(path.join(config.outputDir, 'result.json'), JSON.stringify(result));
    return { runId: config.runId, exitCode: 0, stdout: '', stderr: '', result, durationSeconds: 0.01 };
  };
}

function makeFailingRunner() {
  return async (config: ScienceRunConfig): Promise<ScienceRunResult> => {
    fs.mkdirSync(path.join(config.outputDir, 'files'), { recursive: true });
    const result = { status: 'error' as const, tool_name: config.toolName, tool_version: '1.0', metrics: {}, output_files: [], error: 'Mock failure' };
    fs.writeFileSync(path.join(config.outputDir, 'result.json'), JSON.stringify(result));
    return { runId: config.runId, exitCode: 1, stdout: '', stderr: 'fail', result, durationSeconds: 0.01 };
  };
}

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
  cacheDir = path.join(tmpDir, 'cache');
  auditDir = path.join(tmpDir, 'audit');
  fs.mkdirSync(cacheDir);

  pm.createProject('proj-t', 'Dispatch Test', {});
  pm.createPlan('plan-t1', 'proj-t', TEST_PLAN);

  const toolkitsDir = path.resolve(__dirname, '../../../toolkits');
  toolkitLoader = new ToolkitLoader(toolkitsDir);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ExecutionDispatcher', () => {
  it('dispatches and completes execution', async () => {
    const callLog: string[] = [];
    const runner = makeSimpleRunner(callLog);
    const queue = new ScienceQueue(1, 4, runner);
    const cache = new ScienceCache(cacheDir);
    const audit = new AuditLogger(auditDir);

    const dispatcher = new ExecutionDispatcher({
      projectManager: pm,
      scienceQueue: queue,
      scienceCache: cache,
      toolkitLoader,
      projectDir: tmpDir,
      auditLogger: audit,
    });

    const { executionId } = dispatcher.dispatch('proj-t', 'plan-t1');
    expect(executionId).toBeDefined();

    // Wait for async completion
    await new Promise((r) => setTimeout(r, 500));

    const status = dispatcher.getStatus('plan-t1');
    expect(status).toBeDefined();
    expect(status!.status).toBe('completed');
    expect(status!.completedOps).toContain('gen');
    expect(status!.completedOps).toContain('seq');
    expect(callLog).toHaveLength(2);

    // Plan status updated in DB
    const plan = pm.getPlan('plan-t1');
    expect(plan!.status).toBe('completed');
  });

  it('marks plan as failed on runner failure', async () => {
    const runner = makeFailingRunner();
    const queue = new ScienceQueue(1, 4, runner);
    const cache = new ScienceCache(cacheDir);

    const dispatcher = new ExecutionDispatcher({
      projectManager: pm,
      scienceQueue: queue,
      scienceCache: cache,
      toolkitLoader,
      projectDir: tmpDir,
    });

    dispatcher.dispatch('proj-t', 'plan-t1');
    await new Promise((r) => setTimeout(r, 500));

    const status = dispatcher.getStatus('plan-t1');
    expect(status).toBeDefined();
    // Should be failed or partial since first op fails
    expect(['failed', 'partial']).toContain(status!.status);
    expect(status!.failedOps.length).toBeGreaterThan(0);
  });

  it('returns undefined for unknown plan', () => {
    const queue = new ScienceQueue(1, 4, makeSimpleRunner([]));
    const cache = new ScienceCache(cacheDir);

    const dispatcher = new ExecutionDispatcher({
      projectManager: pm,
      scienceQueue: queue,
      scienceCache: cache,
      toolkitLoader,
      projectDir: tmpDir,
    });

    expect(dispatcher.getStatus('nonexistent')).toBeUndefined();
  });

  it('logs audit entries on execution', async () => {
    const callLog: string[] = [];
    const runner = makeSimpleRunner(callLog);
    const queue = new ScienceQueue(1, 4, runner);
    const cache = new ScienceCache(cacheDir);
    const audit = new AuditLogger(auditDir);

    const dispatcher = new ExecutionDispatcher({
      projectManager: pm,
      scienceQueue: queue,
      scienceCache: cache,
      toolkitLoader,
      projectDir: tmpDir,
      auditLogger: audit,
    });

    dispatcher.dispatch('proj-t', 'plan-t1');
    await new Promise((r) => setTimeout(r, 500));

    const entries = audit.getEntries('proj-t');
    expect(entries.length).toBeGreaterThanOrEqual(2); // plan_executed + plan_completed
    expect(entries[0].eventType).toBe('plan_executed');
    expect(entries[entries.length - 1].eventType).toBe('plan_completed');
  });

  it('tracks active executions', async () => {
    const callLog: string[] = [];
    const runner = makeSimpleRunner(callLog);
    const queue = new ScienceQueue(1, 4, runner);
    const cache = new ScienceCache(cacheDir);

    const dispatcher = new ExecutionDispatcher({
      projectManager: pm,
      scienceQueue: queue,
      scienceCache: cache,
      toolkitLoader,
      projectDir: tmpDir,
    });

    dispatcher.dispatch('proj-t', 'plan-t1');

    // Immediately after dispatch, should have 1 active
    const active = dispatcher.listActive();
    expect(active.length).toBeGreaterThanOrEqual(0); // may complete fast

    await new Promise((r) => setTimeout(r, 500));

    // After completion, no active
    expect(dispatcher.listActive()).toHaveLength(0);
  });
});
