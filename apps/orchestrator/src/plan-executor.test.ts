import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ProjectManager } from './project-manager.js';
import { ScienceCache } from './science-cache.js';
import { ScienceQueue } from './science-queue.js';
import { ToolkitLoader } from './toolkit-loader.js';
import { PlanExecutor } from './plan-executor.js';
import { createProtClawSchema } from './db.js';
import type { ScienceRunConfig, ScienceRunResult } from './science-runner.js';

const MANIFEST_YAML = `
name: test-toolkit
version: "1.0.0"
operations:
  op_a:
    tool: tool-a
    description: "Op A"
    docker_image: protclaw/tool-a:latest
    gpu_required: false
    inputs:
      x:
        type: string
    outputs:
      out:
        type: json
  op_b:
    tool: tool-b
    description: "Op B"
    docker_image: protclaw/tool-b:latest
    gpu_required: false
    depends_on:
      - op_a
    inputs:
      y:
        type: string
    outputs:
      out:
        type: json
`;

function makeSuccessRunner(): (config: ScienceRunConfig) => Promise<ScienceRunResult> {
  return async (config) => {
    // Write a result.json to simulate container output
    const resultPath = path.join(config.outputDir, 'result.json');
    fs.mkdirSync(config.outputDir, { recursive: true });
    fs.writeFileSync(resultPath, JSON.stringify({ status: 'success', tool_name: config.toolName }));
    return {
      runId: config.runId,
      exitCode: 0,
      stdout: '',
      stderr: '',
      result: { status: 'success', tool_name: config.toolName },
      durationSeconds: 1.0,
    };
  };
}

function makeFailRunner(): (config: ScienceRunConfig) => Promise<ScienceRunResult> {
  return async (config) => ({
    runId: config.runId,
    exitCode: 1,
    stdout: '',
    stderr: 'Container failed',
    result: null,
    durationSeconds: 0.5,
  });
}

describe('PlanExecutor', () => {
  let tmpDir: string;
  let toolkitsDir: string;
  let projectDir: string;
  let cacheDir: string;
  let db: Database.Database;
  let pm: ProjectManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protclaw-executor-'));
    toolkitsDir = path.join(tmpDir, 'toolkits');
    projectDir = path.join(tmpDir, 'projects');
    cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(path.join(toolkitsDir, 'test-toolkit'), { recursive: true });
    fs.writeFileSync(path.join(toolkitsDir, 'test-toolkit', 'manifest.yaml'), MANIFEST_YAML);
    fs.mkdirSync(projectDir, { recursive: true });

    db = new Database(':memory:');
    createProtClawSchema(db);
    pm = new ProjectManager(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupProject(plan: object) {
    pm.createProject('proj-1', 'Test Project', {});
    pm.createPlan('plan-1', 'proj-1', plan);
  }

  it('executes a simple 2-op plan successfully', async () => {
    setupProject({
      plan_id: 'plan-1',
      project_id: 'proj-1',
      version: 1,
      status: 'pending',
      selected_toolkits: ['test-toolkit'],
      operations: [
        { op_id: 'a', toolkit_op: 'op_a', params: { x: 'hello' }, depends_on: [] },
        { op_id: 'b', toolkit_op: 'op_b', params: { y: 'world' }, depends_on: ['a'] },
      ],
    });

    const queue = new ScienceQueue(1, 4, makeSuccessRunner());
    const cache = new ScienceCache(cacheDir);
    const loader = new ToolkitLoader(toolkitsDir);

    const executor = new PlanExecutor({
      projectManager: pm,
      scienceQueue: queue,
      scienceCache: cache,
      toolkitLoader: loader,
      projectDir,
    });

    const result = await executor.execute('proj-1', 'plan-1');

    expect(result.status).toBe('completed');
    expect(result.completedOps.sort()).toEqual(['a', 'b']);
    expect(result.failedOps).toEqual([]);
    expect(result.skippedOps).toEqual([]);

    // Artifacts recorded
    const artifacts = pm.getArtifacts('proj-1');
    expect(artifacts.length).toBe(2);
  });

  it('records cache hit when result is cached', async () => {
    setupProject({
      plan_id: 'plan-1',
      project_id: 'proj-1',
      version: 1,
      status: 'pending',
      selected_toolkits: ['test-toolkit'],
      operations: [
        { op_id: 'a', toolkit_op: 'op_a', params: { x: 'hello' }, depends_on: [] },
      ],
    });

    const runner = vi.fn(makeSuccessRunner());
    const queue = new ScienceQueue(1, 4, runner);
    const cache = new ScienceCache(cacheDir);
    const loader = new ToolkitLoader(toolkitsDir);

    const executor = new PlanExecutor({
      projectManager: pm,
      scienceQueue: queue,
      scienceCache: cache,
      toolkitLoader: loader,
      projectDir,
    });

    // First execution — cache miss
    await executor.execute('proj-1', 'plan-1');
    expect(runner).toHaveBeenCalledTimes(1);

    // Reset artifacts for second run (create new plan)
    pm.createPlan('plan-2', 'proj-1', {
      plan_id: 'plan-2',
      project_id: 'proj-1',
      version: 2,
      status: 'pending',
      selected_toolkits: ['test-toolkit'],
      operations: [
        { op_id: 'a', toolkit_op: 'op_a', params: { x: 'hello' }, depends_on: [] },
      ],
    });

    // Second execution — cache hit
    const result2 = await executor.execute('proj-1', 'plan-2');
    expect(result2.status).toBe('completed');
    // Runner should not be called again (cache hit)
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('handles failure and skips dependents', async () => {
    setupProject({
      plan_id: 'plan-1',
      project_id: 'proj-1',
      version: 1,
      status: 'pending',
      selected_toolkits: ['test-toolkit'],
      operations: [
        { op_id: 'a', toolkit_op: 'op_a', params: {}, depends_on: [] },
        { op_id: 'b', toolkit_op: 'op_b', params: {}, depends_on: ['a'] },
      ],
    });

    const queue = new ScienceQueue(1, 4, makeFailRunner());
    const cache = new ScienceCache(cacheDir);
    const loader = new ToolkitLoader(toolkitsDir);

    const executor = new PlanExecutor({
      projectManager: pm,
      scienceQueue: queue,
      scienceCache: cache,
      toolkitLoader: loader,
      projectDir,
    });

    const result = await executor.execute('proj-1', 'plan-1');

    expect(result.status).toBe('failed');
    expect(result.failedOps).toContain('a');
    expect(result.skippedOps).toContain('b');
  });

  it('throws for nonexistent plan', async () => {
    const queue = new ScienceQueue(1, 4, makeSuccessRunner());
    const cache = new ScienceCache(cacheDir);
    const loader = new ToolkitLoader(toolkitsDir);

    const executor = new PlanExecutor({
      projectManager: pm,
      scienceQueue: queue,
      scienceCache: cache,
      toolkitLoader: loader,
      projectDir,
    });

    await expect(executor.execute('proj-1', 'nonexistent')).rejects.toThrow(/Plan not found/);
  });
});
