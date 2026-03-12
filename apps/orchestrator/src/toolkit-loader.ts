/**
 * Toolkit Loader for ProtClaw
 *
 * Discovers and loads toolkit manifest YAML files from the toolkits directory,
 * validates them against the ToolkitManifest schema, and provides query methods.
 */

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ToolkitManifestSchema } from '@protclaw/contracts';
import type { ToolkitManifest } from '@protclaw/contracts';

/**
 * Load a single toolkit manifest from a YAML file.
 * Derives toolkit_id from the parent directory name.
 */
export function loadToolkitManifest(yamlPath: string): ToolkitManifest {
  const content = fs.readFileSync(yamlPath, 'utf-8');
  const raw = YAML.parse(content);

  // Derive toolkit_id from directory name (e.g., toolkits/de-novo/ → "de-novo")
  const dirName = path.basename(path.dirname(yamlPath));
  const withId = { toolkit_id: dirName, ...raw };

  return ToolkitManifestSchema.parse(withId);
}

/**
 * Load all toolkit manifests from a directory.
 * Expects structure: toolkitsDir/{toolkit-name}/manifest.yaml
 */
export function loadAllToolkits(toolkitsDir: string): Map<string, ToolkitManifest> {
  const manifests = new Map<string, ToolkitManifest>();

  if (!fs.existsSync(toolkitsDir)) {
    return manifests;
  }

  const entries = fs.readdirSync(toolkitsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifestPath = path.join(toolkitsDir, entry.name, 'manifest.yaml');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = loadToolkitManifest(manifestPath);
    manifests.set(manifest.toolkit_id, manifest);
  }

  return manifests;
}

/**
 * Toolkit registry providing query access to loaded manifests.
 */
export class ToolkitLoader {
  private manifests: Map<string, ToolkitManifest>;

  constructor(toolkitsDir: string) {
    this.manifests = loadAllToolkits(toolkitsDir);
  }

  getToolkit(toolkitId: string): ToolkitManifest | undefined {
    return this.manifests.get(toolkitId);
  }

  listToolkits(): ToolkitManifest[] {
    return [...this.manifests.values()];
  }

  getOperation(toolkitId: string, opId: string) {
    const manifest = this.manifests.get(toolkitId);
    if (!manifest) return undefined;
    return manifest.operations[opId];
  }

  /**
   * Find which toolkit contains a given operation name.
   * Searches across all loaded toolkits.
   */
  findOperationToolkit(opName: string): { toolkitId: string; operation: ToolkitManifest['operations'][string] } | undefined {
    for (const [toolkitId, manifest] of this.manifests) {
      if (opName in manifest.operations) {
        return { toolkitId, operation: manifest.operations[opName] };
      }
    }
    return undefined;
  }

  /**
   * Resolve toolkits for a list of toolkit IDs (from DesignPlan.selected_toolkits).
   * Throws if any toolkit is not found.
   */
  resolveToolkits(toolkitIds: string[]): Map<string, ToolkitManifest> {
    const resolved = new Map<string, ToolkitManifest>();
    for (const id of toolkitIds) {
      const manifest = this.manifests.get(id);
      if (!manifest) {
        throw new Error(`Toolkit not found: "${id}". Available: ${[...this.manifests.keys()].join(', ')}`);
      }
      resolved.set(id, manifest);
    }
    return resolved;
  }

  getManifests(): Map<string, ToolkitManifest> {
    return this.manifests;
  }
}
