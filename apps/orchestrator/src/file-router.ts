/**
 * File Router for ProtClaw
 *
 * Routes output files from completed operations into downstream operations'
 * input directories, using manifest format declarations and the DAG edges.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolkitManifest } from '@protclaw/contracts';
import type { OperationGraph, OperationNode } from './operation-graph.js';

type OpDef = ToolkitManifest['operations'][string];
type InputDef = OpDef['inputs'][string];
type OutputDef = OpDef['outputs'][string];

export interface FileRouteMapping {
  sourceOpId: string;
  sourceOutputDir: string;
  targetOpId: string;
  targetInputDir: string;
  files: string[];
}

/**
 * Routes output files between operations based on manifest format declarations.
 */
export class FileRouter {
  private opLookup: Map<string, OpDef>;

  constructor(manifests: Map<string, ToolkitManifest>) {
    this.opLookup = new Map();
    for (const manifest of manifests.values()) {
      for (const [opName, opDef] of Object.entries(manifest.operations) as [string, OpDef][]) {
        this.opLookup.set(opName, opDef);
      }
    }
  }

  /**
   * Compute file routes from a completed operation to all downstream operations
   * that directly depend on it.
   */
  computeRoutes(
    completedOpId: string,
    completedOutputDir: string,
    graph: OperationGraph,
  ): FileRouteMapping[] {
    const completedNode = graph.getNode(completedOpId);
    if (!completedNode) return [];

    const sourceOpDef = this.opLookup.get(completedNode.toolkitOp);
    if (!sourceOpDef) return [];

    // Get actual files in the output directory
    const filesDir = path.join(completedOutputDir, 'files');
    if (!fs.existsSync(filesDir)) return [];
    const outputFiles = fs.readdirSync(filesDir);
    if (outputFiles.length === 0) return [];

    // Determine output formats from manifest
    const outputFormats = new Map<string, string[]>(); // format → filenames
    for (const [, outputDef] of Object.entries(sourceOpDef.outputs) as [string, OutputDef][]) {
      const fmt = (outputDef as Record<string, unknown>).format as string | undefined;
      if (fmt) {
        const matching = outputFiles.filter((f) => this.matchesFormat(f, fmt));
        if (matching.length > 0) {
          const existing = outputFormats.get(fmt) ?? [];
          outputFormats.set(fmt, [...existing, ...matching]);
        }
      }
    }

    // If no format-based matches, treat all output files as routable
    if (outputFormats.size === 0) {
      // Non-file outputs (json types) don't need routing
      return [];
    }

    // Find downstream operations that depend on this completed op
    const routes: FileRouteMapping[] = [];
    const dependentIds = graph.getDependents(completedOpId);

    for (const depId of dependentIds) {
      const depNode = graph.getNode(depId);
      if (!depNode) continue;

      const depOpDef = this.opLookup.get(depNode.toolkitOp);
      if (!depOpDef) continue;

      // Check which inputs of the downstream op match our output formats
      const filesToRoute: string[] = [];
      for (const [, inputDef] of Object.entries(depOpDef.inputs) as [string, InputDef][]) {
        const inputFmt = (inputDef as Record<string, unknown>).format as string | undefined;
        if (!inputFmt) continue;
        // Direct match
        if (outputFormats.has(inputFmt)) {
          filesToRoute.push(...outputFormats.get(inputFmt)!);
        } else {
          // Compatible format match (e.g., amino_acid ↔ fasta)
          const compatible = this.getCompatibleFormat(inputFmt);
          if (compatible && outputFormats.has(compatible)) {
            filesToRoute.push(...outputFormats.get(compatible)!);
          }
        }
      }

      if (filesToRoute.length > 0) {
        // Deduplicate
        const uniqueFiles = [...new Set(filesToRoute)];
        routes.push({
          sourceOpId: completedOpId,
          sourceOutputDir: completedOutputDir,
          targetOpId: depId,
          targetInputDir: '', // Will be resolved during execution
          files: uniqueFiles,
        });
      }
    }

    return routes;
  }

  /**
   * Execute file routes: copy files from source output to target input directories.
   */
  executeRoutes(routes: FileRouteMapping[]): void {
    for (const route of routes) {
      const sourceFilesDir = path.join(route.sourceOutputDir, 'files');
      const targetFilesDir = path.join(route.targetInputDir, 'files');
      fs.mkdirSync(targetFilesDir, { recursive: true });

      for (const file of route.files) {
        const src = path.join(sourceFilesDir, file);
        const dst = path.join(targetFilesDir, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dst);
        }
      }
    }
  }

  /**
   * After an operation completes, route its output files to all downstream
   * operations and inject file params into their nodes.
   */
  routeForCompletedOp(
    completedOpId: string,
    completedOutputDir: string,
    graph: OperationGraph,
    projectDir: string,
    projectId: string,
    planId: string,
  ): void {
    const routes = this.computeRoutes(completedOpId, completedOutputDir, graph);

    // Resolve target input directories
    for (const route of routes) {
      route.targetInputDir = path.join(
        projectDir, projectId, 'runs', planId, route.targetOpId, 'input',
      );
    }

    this.executeRoutes(routes);

    // Inject file params into downstream nodes
    for (const route of routes) {
      const depNode = graph.getNode(route.targetOpId);
      if (!depNode) continue;

      const depOpDef = this.opLookup.get(depNode.toolkitOp);
      if (!depOpDef) continue;

      this.injectFileParams(depNode, route.files, depOpDef);
    }
  }

  /**
   * Inject routed filenames into the downstream operation's params,
   * matching manifest input keys by format.
   */
  injectFileParams(node: OperationNode, routedFiles: string[], opDef: OpDef): void {
    for (const [inputKey, inputDef] of Object.entries(opDef.inputs) as [string, InputDef][]) {
      const inputFmt = (inputDef as Record<string, unknown>).format as string | undefined;
      if (!inputFmt) continue;

      // Try direct match, then compatible format
      let matching = routedFiles.filter((f) => this.matchesFormat(f, inputFmt));
      if (matching.length === 0) {
        const compat = this.getCompatibleFormat(inputFmt);
        if (compat) {
          matching = routedFiles.filter((f) => this.matchesFormat(f, compat));
        }
      }
      if (matching.length === 0) continue;

      const inputType = (inputDef as Record<string, unknown>).type as string | undefined;

      // Set the param: file_list → array, single file → string or array depending on adapter convention
      if (inputType === 'file_list' || matching.length > 1) {
        // Merge with existing array if present
        const existing = node.params[inputKey];
        if (Array.isArray(existing)) {
          node.params[inputKey] = [...existing, ...matching];
        } else {
          node.params[inputKey] = matching;
        }
      } else {
        // Single file
        node.params[inputKey] = matching[0];
      }
    }
  }

  /**
   * Map semantically compatible formats (e.g., amino_acid sequences are stored in FASTA files).
   */
  private getCompatibleFormat(format: string): string | null {
    const compatMap: Record<string, string> = {
      amino_acid: 'fasta',
      fasta: 'amino_acid',
    };
    return compatMap[format] ?? null;
  }

  private matchesFormat(filename: string, format: string): boolean {
    const ext = path.extname(filename).toLowerCase().slice(1); // remove dot
    switch (format) {
      case 'pdb':
        return ext === 'pdb';
      case 'fasta':
        return ext === 'fasta' || ext === 'fa' || ext === 'faa';
      case 'csv':
        return ext === 'csv';
      case 'json':
        return ext === 'json';
      case 'html':
        return ext === 'html' || ext === 'htm';
      case 'amino_acid':
        return ext === 'fasta' || ext === 'fa' || ext === 'faa';
      default:
        return ext === format;
    }
  }
}
