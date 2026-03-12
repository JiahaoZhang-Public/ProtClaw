import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadToolkitManifest, loadAllToolkits, ToolkitLoader } from './toolkit-loader.js';

const VALID_MANIFEST_YAML = `
name: test-toolkit
version: "1.0.0"
description: "Test toolkit"
operations:
  op_a:
    tool: tool-a
    description: "Operation A"
    docker_image: protclaw/tool-a:latest
    gpu_required: true
    inputs:
      input1:
        type: string
        description: "Input 1"
    outputs:
      output1:
        type: file
        format: pdb
    planner_hints:
      typical_runtime: "5 min"
      cost_tier: fast
  op_b:
    tool: tool-b
    description: "Operation B"
    docker_image: protclaw/tool-b:latest
    gpu_required: false
    depends_on:
      - op_a
    inputs:
      input2:
        type: file
        format: pdb
    outputs:
      output2:
        type: json
`;

describe('ToolkitLoader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protclaw-toolkit-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadToolkitManifest', () => {
    it('loads valid manifest.yaml and derives toolkit_id from directory name', () => {
      const toolkitDir = path.join(tmpDir, 'my-toolkit');
      fs.mkdirSync(toolkitDir);
      fs.writeFileSync(path.join(toolkitDir, 'manifest.yaml'), VALID_MANIFEST_YAML);

      const manifest = loadToolkitManifest(path.join(toolkitDir, 'manifest.yaml'));

      expect(manifest.toolkit_id).toBe('my-toolkit');
      expect(manifest.name).toBe('test-toolkit');
      expect(manifest.version).toBe('1.0.0');
      expect(Object.keys(manifest.operations)).toEqual(['op_a', 'op_b']);
    });

    it('rejects manifest missing required fields', () => {
      const toolkitDir = path.join(tmpDir, 'bad-toolkit');
      fs.mkdirSync(toolkitDir);
      fs.writeFileSync(path.join(toolkitDir, 'manifest.yaml'), 'name: incomplete\n');

      expect(() => loadToolkitManifest(path.join(toolkitDir, 'manifest.yaml'))).toThrow();
    });

    it('parses operation inputs/outputs correctly', () => {
      const toolkitDir = path.join(tmpDir, 'test-tk');
      fs.mkdirSync(toolkitDir);
      fs.writeFileSync(path.join(toolkitDir, 'manifest.yaml'), VALID_MANIFEST_YAML);

      const manifest = loadToolkitManifest(path.join(toolkitDir, 'manifest.yaml'));
      const opA = manifest.operations['op_a'];

      expect(opA.tool).toBe('tool-a');
      expect(opA.gpu_required).toBe(true);
      expect(opA.docker_image).toBe('protclaw/tool-a:latest');
      expect(opA.planner_hints?.cost_tier).toBe('fast');
    });
  });

  describe('loadAllToolkits', () => {
    it('loads all toolkits from directory', () => {
      // Create two toolkit directories
      for (const name of ['toolkit-a', 'toolkit-b']) {
        const dir = path.join(tmpDir, name);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'manifest.yaml'), VALID_MANIFEST_YAML);
      }

      const manifests = loadAllToolkits(tmpDir);

      expect(manifests.size).toBe(2);
      expect(manifests.has('toolkit-a')).toBe(true);
      expect(manifests.has('toolkit-b')).toBe(true);
    });

    it('skips directories without manifest.yaml', () => {
      fs.mkdirSync(path.join(tmpDir, 'no-manifest'));
      const dir = path.join(tmpDir, 'has-manifest');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.yaml'), VALID_MANIFEST_YAML);

      const manifests = loadAllToolkits(tmpDir);

      expect(manifests.size).toBe(1);
    });

    it('returns empty map for non-existent directory', () => {
      const manifests = loadAllToolkits('/nonexistent/path');
      expect(manifests.size).toBe(0);
    });
  });

  describe('ToolkitLoader class', () => {
    it('provides getToolkit() and listToolkits()', () => {
      const dir = path.join(tmpDir, 'tk');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.yaml'), VALID_MANIFEST_YAML);

      const loader = new ToolkitLoader(tmpDir);

      expect(loader.listToolkits().length).toBe(1);
      expect(loader.getToolkit('tk')?.name).toBe('test-toolkit');
      expect(loader.getToolkit('nonexistent')).toBeUndefined();
    });

    it('provides getOperation()', () => {
      const dir = path.join(tmpDir, 'tk');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.yaml'), VALID_MANIFEST_YAML);

      const loader = new ToolkitLoader(tmpDir);

      expect(loader.getOperation('tk', 'op_a')?.tool).toBe('tool-a');
      expect(loader.getOperation('tk', 'nonexistent')).toBeUndefined();
      expect(loader.getOperation('bad-id', 'op_a')).toBeUndefined();
    });

    it('findOperationToolkit() searches across toolkits', () => {
      const dir = path.join(tmpDir, 'tk');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.yaml'), VALID_MANIFEST_YAML);

      const loader = new ToolkitLoader(tmpDir);
      const result = loader.findOperationToolkit('op_b');

      expect(result).toBeDefined();
      expect(result!.toolkitId).toBe('tk');
      expect(result!.operation.tool).toBe('tool-b');
    });

    it('resolveToolkits() throws for missing toolkits', () => {
      const dir = path.join(tmpDir, 'tk');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.yaml'), VALID_MANIFEST_YAML);

      const loader = new ToolkitLoader(tmpDir);

      expect(() => loader.resolveToolkits(['tk'])).not.toThrow();
      expect(() => loader.resolveToolkits(['nonexistent'])).toThrow(/Toolkit not found/);
    });
  });

  describe('loads real de-novo manifest', () => {
    it('loads the actual toolkits/de-novo/manifest.yaml', () => {
      const realToolkitsDir = path.resolve(__dirname, '../../../toolkits');
      if (!fs.existsSync(path.join(realToolkitsDir, 'de-novo', 'manifest.yaml'))) {
        return; // Skip if not in monorepo context
      }

      const loader = new ToolkitLoader(realToolkitsDir);
      const manifest = loader.getToolkit('de-novo');

      expect(manifest).toBeDefined();
      expect(manifest!.name).toBe('de-novo-design');
      expect(Object.keys(manifest!.operations).length).toBe(8);
      expect(manifest!.operations['backbone_generate'].tool).toBe('rfdiffusion');
    });
  });
});
