import { describe, it, expect } from 'vitest';
import { OperationGraph } from './operation-graph.js';
import type { DesignPlan, ToolkitManifest } from '@protclaw/contracts';

function makeManifest(ops: Record<string, { tool: string; gpu?: boolean; depends_on?: string[] }>): ToolkitManifest {
  const operations: Record<string, any> = {};
  for (const [name, def] of Object.entries(ops)) {
    operations[name] = {
      tool: def.tool,
      description: `${name} operation`,
      docker_image: `protclaw/${def.tool}:latest`,
      gpu_required: def.gpu ?? false,
      depends_on: def.depends_on,
      inputs: {},
      outputs: {},
    };
  }
  return {
    toolkit_id: 'test-toolkit',
    name: 'Test Toolkit',
    version: '1.0.0',
    operations,
  } as ToolkitManifest;
}

function makePlan(ops: Array<{ op_id: string; toolkit_op: string; depends_on?: string[] }>): DesignPlan {
  return {
    plan_id: 'plan-001',
    project_id: 'proj-001',
    version: 1,
    status: 'pending',
    selected_toolkits: ['test-toolkit'],
    operations: ops.map((o) => ({
      op_id: o.op_id,
      toolkit_op: o.toolkit_op,
      params: {},
      depends_on: o.depends_on ?? [],
    })),
  } as DesignPlan;
}

describe('OperationGraph', () => {
  const manifest = makeManifest({
    step_a: { tool: 'tool-a', gpu: true },
    step_b: { tool: 'tool-b', depends_on: ['step_a'] },
    step_c: { tool: 'tool-c', depends_on: ['step_a'] },
    step_d: { tool: 'tool-d', depends_on: ['step_b', 'step_c'] },
  });
  const manifests = new Map([['test-toolkit', manifest]]);

  describe('fromDesignPlan', () => {
    it('builds graph from linear chain (A→B→C)', () => {
      const plan = makePlan([
        { op_id: 'a', toolkit_op: 'step_a' },
        { op_id: 'b', toolkit_op: 'step_b', depends_on: ['a'] },
        { op_id: 'c', toolkit_op: 'step_c', depends_on: ['b'] },
      ]);

      const graph = OperationGraph.fromDesignPlan(plan, manifests);
      const ready = graph.getReady();

      expect(ready.length).toBe(1);
      expect(ready[0].opId).toBe('a');
    });

    it('builds graph with parallel fan-out (A→B, A→C, B+C→D)', () => {
      const plan = makePlan([
        { op_id: 'a', toolkit_op: 'step_a' },
        { op_id: 'b', toolkit_op: 'step_b', depends_on: ['a'] },
        { op_id: 'c', toolkit_op: 'step_c', depends_on: ['a'] },
        { op_id: 'd', toolkit_op: 'step_d', depends_on: ['b', 'c'] },
      ]);

      const graph = OperationGraph.fromDesignPlan(plan, manifests);

      // Only A is ready
      expect(graph.getReady().length).toBe(1);

      // Complete A → B and C become ready
      graph.markRunning('a');
      graph.markComplete('a');
      const readyAfterA = graph.getReady();
      expect(readyAfterA.length).toBe(2);
      expect(readyAfterA.map((n) => n.opId).sort()).toEqual(['b', 'c']);
    });

    it('detects cycles and throws', () => {
      const cyclicManifest = makeManifest({
        x: { tool: 'x' },
        y: { tool: 'y' },
      });

      const plan = makePlan([
        { op_id: 'x', toolkit_op: 'x', depends_on: ['y'] },
        { op_id: 'y', toolkit_op: 'y', depends_on: ['x'] },
      ]);

      expect(() => OperationGraph.fromDesignPlan(plan, new Map([['test-toolkit', cyclicManifest]]))).toThrow(
        /Cycle detected/,
      );
    });

    it('throws for unknown toolkit_op', () => {
      const plan = makePlan([{ op_id: 'a', toolkit_op: 'nonexistent_op' }]);

      expect(() => OperationGraph.fromDesignPlan(plan, manifests)).toThrow(/not found in selected toolkits/);
    });

    it('throws for invalid depends_on reference', () => {
      const plan = makePlan([{ op_id: 'a', toolkit_op: 'step_a', depends_on: ['nonexistent'] }]);

      expect(() => OperationGraph.fromDesignPlan(plan, manifests)).toThrow(/depends on "nonexistent"/);
    });
  });

  describe('execution tracking', () => {
    it('getReady() returns nodes with all deps satisfied', () => {
      const plan = makePlan([
        { op_id: 'a', toolkit_op: 'step_a' },
        { op_id: 'b', toolkit_op: 'step_b', depends_on: ['a'] },
      ]);

      const graph = OperationGraph.fromDesignPlan(plan, manifests);

      expect(graph.getReady().map((n) => n.opId)).toEqual(['a']);
    });

    it('markComplete() unlocks dependents', () => {
      const plan = makePlan([
        { op_id: 'a', toolkit_op: 'step_a' },
        { op_id: 'b', toolkit_op: 'step_b', depends_on: ['a'] },
      ]);

      const graph = OperationGraph.fromDesignPlan(plan, manifests);
      graph.markRunning('a');
      graph.markComplete('a', 'art-001');

      expect(graph.getNode('a')!.status).toBe('completed');
      expect(graph.getNode('a')!.artifactId).toBe('art-001');
      expect(graph.getReady().map((n) => n.opId)).toEqual(['b']);
    });

    it('markFailed() records error without auto-skipping dependents', () => {
      const plan = makePlan([
        { op_id: 'a', toolkit_op: 'step_a' },
        { op_id: 'b', toolkit_op: 'step_b', depends_on: ['a'] },
      ]);

      const graph = OperationGraph.fromDesignPlan(plan, manifests);
      graph.markRunning('a');
      graph.markFailed('a', 'timeout');

      expect(graph.getNode('a')!.status).toBe('failed');
      expect(graph.getNode('a')!.error).toBe('timeout');
      // b stays pending — executor decides what to do
      expect(graph.getNode('b')!.status).toBe('pending');
    });

    it('skipWithDependents() skips transitive dependents', () => {
      const plan = makePlan([
        { op_id: 'a', toolkit_op: 'step_a' },
        { op_id: 'b', toolkit_op: 'step_b', depends_on: ['a'] },
        { op_id: 'c', toolkit_op: 'step_c', depends_on: ['a'] },
        { op_id: 'd', toolkit_op: 'step_d', depends_on: ['b', 'c'] },
      ]);

      const graph = OperationGraph.fromDesignPlan(plan, manifests);
      graph.skipWithDependents('a');

      expect(graph.getNode('a')!.status).toBe('skipped');
      expect(graph.getNode('b')!.status).toBe('skipped');
      expect(graph.getNode('c')!.status).toBe('skipped');
      expect(graph.getNode('d')!.status).toBe('skipped');
    });

    it('isComplete() returns true when all nodes are terminal', () => {
      const plan = makePlan([
        { op_id: 'a', toolkit_op: 'step_a' },
        { op_id: 'b', toolkit_op: 'step_b', depends_on: ['a'] },
      ]);

      const graph = OperationGraph.fromDesignPlan(plan, manifests);

      expect(graph.isComplete()).toBe(false);

      graph.markRunning('a');
      graph.markComplete('a');
      graph.markRunning('b');
      graph.markComplete('b');

      expect(graph.isComplete()).toBe(true);
    });

    it('isComplete() is true with mixed completed/failed/skipped', () => {
      const plan = makePlan([
        { op_id: 'a', toolkit_op: 'step_a' },
        { op_id: 'b', toolkit_op: 'step_b', depends_on: ['a'] },
      ]);

      const graph = OperationGraph.fromDesignPlan(plan, manifests);
      graph.markRunning('a');
      graph.markFailed('a', 'error');
      graph.skipWithDependents('b');

      expect(graph.isComplete()).toBe(true);
      expect(graph.hasFailed()).toBe(true);
    });
  });

  describe('topologicalOrder', () => {
    it('returns valid topological ordering', () => {
      const plan = makePlan([
        { op_id: 'a', toolkit_op: 'step_a' },
        { op_id: 'b', toolkit_op: 'step_b', depends_on: ['a'] },
        { op_id: 'c', toolkit_op: 'step_c', depends_on: ['a'] },
        { op_id: 'd', toolkit_op: 'step_d', depends_on: ['b', 'c'] },
      ]);

      const graph = OperationGraph.fromDesignPlan(plan, manifests);
      const order = graph.topologicalOrder();

      expect(order.length).toBe(4);
      expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
      expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
      expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
      expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
    });
  });

  describe('node properties', () => {
    it('resolves dockerImage and gpuRequired from manifest', () => {
      const plan = makePlan([{ op_id: 'a', toolkit_op: 'step_a' }]);

      const graph = OperationGraph.fromDesignPlan(plan, manifests);
      const node = graph.getNode('a')!;

      expect(node.dockerImage).toBe('protclaw/tool-a:latest');
      expect(node.gpuRequired).toBe(true);
    });

    it('getAllNodes() returns all nodes', () => {
      const plan = makePlan([
        { op_id: 'a', toolkit_op: 'step_a' },
        { op_id: 'b', toolkit_op: 'step_b', depends_on: ['a'] },
      ]);

      const graph = OperationGraph.fromDesignPlan(plan, manifests);

      expect(graph.getAllNodes().length).toBe(2);
    });
  });
});
