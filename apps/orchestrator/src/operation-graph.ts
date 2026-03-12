/**
 * Operation Graph for ProtClaw
 *
 * Compiles a DesignPlan's operations into a dependency DAG,
 * provides topological ordering, cycle detection, and execution tracking.
 */

import type { DesignPlan, ToolkitManifest } from '@protclaw/contracts';

export type NodeStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped';

export interface OperationNode {
  opId: string;
  toolkitOp: string;
  toolOverride?: string;
  params: Record<string, unknown>;
  dependsOn: string[];
  dockerImage: string;
  gpuRequired: boolean;
  status: NodeStatus;
  artifactId?: string;
  error?: string;
}

export class OperationGraph {
  private nodes: Map<string, OperationNode>;
  /** Maps opId → set of opIds that depend on it */
  private dependents: Map<string, Set<string>>;

  private constructor(nodes: Map<string, OperationNode>, dependents: Map<string, Set<string>>) {
    this.nodes = nodes;
    this.dependents = dependents;
  }

  /**
   * Build an OperationGraph from a DesignPlan and resolved toolkit manifests.
   *
   * Validates that:
   * - All toolkit_op references exist in a selected toolkit
   * - All depends_on references point to valid op_ids in the plan
   * - The dependency graph is acyclic (via Kahn's algorithm)
   */
  static fromDesignPlan(
    plan: DesignPlan,
    manifests: Map<string, ToolkitManifest>,
  ): OperationGraph {
    const nodes = new Map<string, OperationNode>();
    const dependents = new Map<string, Set<string>>();

    // Build a combined operation lookup across all selected toolkits
    type OpDef = ToolkitManifest['operations'][string];
    const opLookup = new Map<string, { dockerImage: string; gpuRequired: boolean }>();
    for (const manifest of manifests.values()) {
      for (const [opName, opDef] of Object.entries(manifest.operations) as [string, OpDef][]) {
        opLookup.set(opName, {
          dockerImage: opDef.docker_image ?? `protclaw/${opDef.tool}:latest`,
          gpuRequired: opDef.gpu_required ?? false,
        });
      }
    }

    // Create nodes from plan operations
    for (const op of plan.operations) {
      const toolkitInfo = opLookup.get(op.toolkit_op);
      if (!toolkitInfo) {
        throw new Error(
          `Operation "${op.toolkit_op}" (op_id: "${op.op_id}") not found in selected toolkits: ${plan.selected_toolkits.join(', ')}`,
        );
      }

      nodes.set(op.op_id, {
        opId: op.op_id,
        toolkitOp: op.toolkit_op,
        toolOverride: op.tool_override,
        params: op.params,
        dependsOn: op.depends_on ?? [],
        dockerImage: op.tool_override
          ? `protclaw/${op.tool_override}:latest`
          : toolkitInfo.dockerImage,
        gpuRequired: toolkitInfo.gpuRequired,
        status: 'pending',
      });
    }

    // Validate depends_on references and build dependents map
    for (const [opId, node] of nodes) {
      dependents.set(opId, new Set());
    }
    for (const [opId, node] of nodes) {
      for (const depId of node.dependsOn) {
        if (!nodes.has(depId)) {
          throw new Error(
            `Operation "${opId}" depends on "${depId}" which is not in the plan`,
          );
        }
        dependents.get(depId)!.add(opId);
      }
    }

    // Cycle detection via Kahn's algorithm
    const inDegree = new Map<string, number>();
    for (const [opId, node] of nodes) {
      inDegree.set(opId, node.dependsOn.length);
    }

    const queue: string[] = [];
    for (const [opId, deg] of inDegree) {
      if (deg === 0) queue.push(opId);
    }

    let visited = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      visited++;
      for (const dep of dependents.get(current) ?? []) {
        const newDeg = inDegree.get(dep)! - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) queue.push(dep);
      }
    }

    if (visited !== nodes.size) {
      throw new Error('Cycle detected in operation dependency graph');
    }

    // Mark nodes with no dependencies as ready
    const graph = new OperationGraph(nodes, dependents);
    graph.updateReadyNodes();
    return graph;
  }

  /**
   * Get all nodes that are ready to execute (all dependencies completed).
   */
  getReady(): OperationNode[] {
    return [...this.nodes.values()].filter((n) => n.status === 'ready');
  }

  /**
   * Mark an operation as running.
   */
  markRunning(opId: string): void {
    const node = this.requireNode(opId);
    if (node.status !== 'ready') {
      throw new Error(`Cannot mark "${opId}" as running: status is "${node.status}"`);
    }
    node.status = 'running';
  }

  /**
   * Mark an operation as completed and unlock dependents.
   */
  markComplete(opId: string, artifactId?: string): void {
    const node = this.requireNode(opId);
    node.status = 'completed';
    node.artifactId = artifactId;
    this.updateReadyNodes();
  }

  /**
   * Mark an operation as failed.
   */
  markFailed(opId: string, error: string): void {
    const node = this.requireNode(opId);
    node.status = 'failed';
    node.error = error;
    // Don't auto-skip dependents — let the executor decide via fallback policies
  }

  /**
   * Mark an operation and all its transitive dependents as skipped.
   */
  skipWithDependents(opId: string): void {
    const node = this.requireNode(opId);
    node.status = 'skipped';

    for (const depId of this.dependents.get(opId) ?? []) {
      const depNode = this.nodes.get(depId)!;
      if (depNode.status === 'pending' || depNode.status === 'ready') {
        this.skipWithDependents(depId);
      }
    }
  }

  /**
   * Check if all operations are in a terminal state (completed, failed, or skipped).
   */
  isComplete(): boolean {
    return [...this.nodes.values()].every(
      (n) => n.status === 'completed' || n.status === 'failed' || n.status === 'skipped',
    );
  }

  /**
   * Check if any operation has failed.
   */
  hasFailed(): boolean {
    return [...this.nodes.values()].some((n) => n.status === 'failed');
  }

  getNode(opId: string): OperationNode | undefined {
    return this.nodes.get(opId);
  }

  getAllNodes(): OperationNode[] {
    return [...this.nodes.values()];
  }

  /**
   * Get the op IDs of all direct dependents of the given operation.
   */
  getDependents(opId: string): string[] {
    return [...(this.dependents.get(opId) ?? [])];
  }

  /**
   * Get a topological ordering of all operations.
   */
  topologicalOrder(): string[] {
    const inDegree = new Map<string, number>();
    for (const [opId, node] of this.nodes) {
      inDegree.set(opId, node.dependsOn.length);
    }

    const queue: string[] = [];
    for (const [opId, deg] of inDegree) {
      if (deg === 0) queue.push(opId);
    }

    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);
      for (const dep of this.dependents.get(current) ?? []) {
        const newDeg = inDegree.get(dep)! - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) queue.push(dep);
      }
    }

    return order;
  }

  private requireNode(opId: string): OperationNode {
    const node = this.nodes.get(opId);
    if (!node) {
      throw new Error(`Operation not found: "${opId}"`);
    }
    return node;
  }

  private updateReadyNodes(): void {
    for (const [opId, node] of this.nodes) {
      if (node.status !== 'pending') continue;

      const allDepsComplete = node.dependsOn.every((depId) => {
        const dep = this.nodes.get(depId)!;
        return dep.status === 'completed';
      });

      if (allDepsComplete) {
        node.status = 'ready';
      }
    }
  }
}
