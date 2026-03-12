import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DesignPlan, ToolkitManifest } from '@protclaw/contracts';
import { FileRouter } from './file-router.js';
import { OperationGraph } from './operation-graph.js';

function makeManifest(): ToolkitManifest {
  return {
    toolkit_id: 'test',
    name: 'Test',
    version: '1.0.0',
    operations: {
      op_a: {
        tool: 'tool-a',
        description: 'Generates PDB files',
        docker_image: 'img-a',
        gpu_required: false,
        inputs: {},
        outputs: {
          result_pdb: { type: 'file', format: 'pdb' },
        },
      },
      op_b: {
        tool: 'tool-b',
        description: 'Takes PDB, outputs FASTA',
        docker_image: 'img-b',
        gpu_required: false,
        depends_on: ['op_a'],
        inputs: {
          input_pdb: { type: 'file', format: 'pdb', required: true },
        },
        outputs: {
          result_fasta: { type: 'file', format: 'fasta' },
        },
      },
      op_c: {
        tool: 'tool-c',
        description: 'Takes FASTA, outputs PDB',
        docker_image: 'img-c',
        gpu_required: false,
        depends_on: ['op_b'],
        inputs: {
          input_fasta: { type: 'file', format: 'fasta', required: true },
        },
        outputs: {
          pred_pdb: { type: 'file', format: 'pdb' },
        },
      },
      op_d: {
        tool: 'tool-d',
        description: 'Takes PDB from both A and C',
        docker_image: 'img-d',
        gpu_required: false,
        depends_on: ['op_a', 'op_c'],
        inputs: {
          designed_pdb: { type: 'file', format: 'pdb', required: true },
        },
        outputs: {
          report: { type: 'json' },
        },
      },
      op_e: {
        tool: 'tool-e',
        description: 'Takes JSON input, no files',
        docker_image: 'img-e',
        gpu_required: false,
        depends_on: ['op_d'],
        inputs: {
          data: { type: 'json', required: true },
        },
        outputs: {
          result: { type: 'json' },
        },
      },
    },
  } as ToolkitManifest;
}

function makePlan(): DesignPlan {
  return {
    plan_id: 'p1',
    project_id: 'proj',
    version: 1,
    status: 'pending',
    selected_toolkits: ['test'],
    operations: [
      { op_id: 'a', toolkit_op: 'op_a', params: {}, depends_on: [] },
      { op_id: 'b', toolkit_op: 'op_b', params: {}, depends_on: ['a'] },
      { op_id: 'c', toolkit_op: 'op_c', params: {}, depends_on: ['b'] },
      { op_id: 'd', toolkit_op: 'op_d', params: {}, depends_on: ['a', 'c'] },
      { op_id: 'e', toolkit_op: 'op_e', params: {}, depends_on: ['d'] },
    ],
  } as DesignPlan;
}

describe('FileRouter', () => {
  let tmpDir: string;
  let manifests: Map<string, ToolkitManifest>;
  let graph: OperationGraph;
  let router: FileRouter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protclaw-router-'));
    manifests = new Map([['test', makeManifest()]]);
    graph = OperationGraph.fromDesignPlan(makePlan(), manifests);
    router = new FileRouter(manifests);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupOutputFiles(opId: string, files: Record<string, string>): string {
    const outputDir = path.join(tmpDir, opId, 'output');
    const filesDir = path.join(outputDir, 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(filesDir, name), content);
    }
    return outputDir;
  }

  it('routes PDB files from op_a to op_b', () => {
    const outputDir = setupOutputFiles('a', { 'design.pdb': 'ATOM\nEND\n' });

    // Mark a as completed so b can see it as dependency
    graph.markRunning('a');
    graph.markComplete('a');

    const routes = router.computeRoutes('a', outputDir, graph);

    // op_b and op_d both depend on op_a
    expect(routes).toHaveLength(2);
    const routeToB = routes.find((r) => r.targetOpId === 'b');
    expect(routeToB).toBeDefined();
    expect(routeToB!.files).toContain('design.pdb');
  });

  it('routes FASTA files from op_b to op_c', () => {
    const outputDir = setupOutputFiles('b', { 'seq.fasta': '>seq\nAAAA\n' });

    graph.markRunning('a');
    graph.markComplete('a');
    graph.markRunning('b');
    graph.markComplete('b');

    const routes = router.computeRoutes('b', outputDir, graph);

    expect(routes).toHaveLength(1);
    expect(routes[0].targetOpId).toBe('c');
    expect(routes[0].files).toContain('seq.fasta');
  });

  it('routes PDB from op_c to op_d (multi-dependency)', () => {
    const outputDir = setupOutputFiles('c', { 'pred.pdb': 'ATOM\nEND\n' });

    graph.markRunning('a');
    graph.markComplete('a');
    graph.markRunning('b');
    graph.markComplete('b');
    graph.markRunning('c');
    graph.markComplete('c');

    const routes = router.computeRoutes('c', outputDir, graph);

    expect(routes).toHaveLength(1);
    expect(routes[0].targetOpId).toBe('d');
    expect(routes[0].files).toContain('pred.pdb');
  });

  it('returns no routes for op with JSON-only outputs', () => {
    const outputDir = setupOutputFiles('d', { 'report.json': '{}' });

    graph.markRunning('a');
    graph.markComplete('a');
    graph.markRunning('b');
    graph.markComplete('b');
    graph.markRunning('c');
    graph.markComplete('c');
    graph.markRunning('d');
    graph.markComplete('d');

    const routes = router.computeRoutes('d', outputDir, graph);

    // op_d outputs type: json (no format-based file routing)
    // op_e inputs type: json — no file routing needed
    expect(routes).toHaveLength(0);
  });

  it('executeRoutes copies files between directories', () => {
    const sourceOutputDir = setupOutputFiles('a', { 'backbone.pdb': 'ATOM\nEND\n' });
    const targetInputDir = path.join(tmpDir, 'b', 'input');

    router.executeRoutes([{
      sourceOpId: 'a',
      sourceOutputDir,
      targetOpId: 'b',
      targetInputDir,
      files: ['backbone.pdb'],
    }]);

    expect(fs.existsSync(path.join(targetInputDir, 'files', 'backbone.pdb'))).toBe(true);
    expect(fs.readFileSync(path.join(targetInputDir, 'files', 'backbone.pdb'), 'utf-8')).toBe('ATOM\nEND\n');
  });

  it('injectFileParams updates node params with filenames', () => {
    const node = graph.getNode('b')!;
    const opDef = makeManifest().operations.op_b;

    router.injectFileParams(node, ['design.pdb'], opDef);

    expect(node.params.input_pdb).toBe('design.pdb');
  });

  it('injectFileParams handles file_list type', () => {
    // op_a has file_list output in the real de-novo manifest; simulate here
    const manifest: ToolkitManifest = {
      ...makeManifest(),
      operations: {
        ...makeManifest().operations,
        op_b: {
          ...makeManifest().operations.op_b,
          inputs: {
            input_pdbs: { type: 'file_list', format: 'pdb', required: true },
          },
        },
      },
    } as ToolkitManifest;

    const node = graph.getNode('b')!;
    const opDef = manifest.operations.op_b;

    router.injectFileParams(node, ['a.pdb', 'b.pdb'], opDef);

    expect(node.params.input_pdbs).toEqual(['a.pdb', 'b.pdb']);
  });

  it('routeForCompletedOp performs full routing cycle', () => {
    const projectDir = tmpDir;
    const projectId = 'proj';
    const planId = 'p1';

    // Create op_a output files
    const opAOutputDir = path.join(projectDir, projectId, 'runs', planId, 'a', 'output');
    const opAFilesDir = path.join(opAOutputDir, 'files');
    fs.mkdirSync(opAFilesDir, { recursive: true });
    fs.writeFileSync(path.join(opAFilesDir, 'design.pdb'), 'ATOM\nEND\n');

    graph.markRunning('a');
    graph.markComplete('a');

    router.routeForCompletedOp('a', opAOutputDir, graph, projectDir, projectId, planId);

    // Check op_b got the PDB file
    const bInputFiles = path.join(projectDir, projectId, 'runs', planId, 'b', 'input', 'files');
    expect(fs.existsSync(path.join(bInputFiles, 'design.pdb'))).toBe(true);

    // Check op_b node params were injected
    const nodeB = graph.getNode('b')!;
    expect(nodeB.params.input_pdb).toBe('design.pdb');
  });

  it('returns empty routes when output dir has no files subdir', () => {
    const emptyDir = path.join(tmpDir, 'empty-output');
    fs.mkdirSync(emptyDir, { recursive: true });

    graph.markRunning('a');
    graph.markComplete('a');

    const routes = router.computeRoutes('a', emptyDir, graph);
    expect(routes).toHaveLength(0);
  });
});
