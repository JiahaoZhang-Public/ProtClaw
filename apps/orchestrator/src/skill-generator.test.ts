import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolkitManifest } from '@protclaw/contracts';
import { generateToolkitSkills } from './skill-generator.js';

function makeManifest(overrides: Partial<ToolkitManifest> = {}): ToolkitManifest {
  return {
    toolkit_id: 'test-toolkit',
    name: 'Test Toolkit',
    version: '1.0.0',
    operations: {
      op_alpha: {
        tool: 'tool-alpha',
        description: 'Alpha operation',
        docker_image: 'protclaw/alpha:latest',
        gpu_required: false,
        inputs: {
          seq: { type: 'string', required: true, description: 'Input sequence' },
        },
        outputs: {
          result: { type: 'json', description: 'Alpha result' },
        },
      },
      op_beta: {
        tool: 'tool-beta',
        description: 'Beta operation',
        docker_image: 'protclaw/beta:latest',
        gpu_required: true,
        depends_on: ['op_alpha'],
        inputs: {
          data: { type: 'json', required: true },
        },
        outputs: {
          out: { type: 'file', description: 'Output file' },
        },
        planner_hints: {
          typical_runtime: '10m',
          cost_tier: 'high',
        },
      },
    },
    ...overrides,
  } as ToolkitManifest;
}

describe('skill-generator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protclaw-skills-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates SKILL.md files for each operation plus overview', () => {
    const manifests = new Map<string, ToolkitManifest>();
    manifests.set('test-toolkit', makeManifest());

    const files = generateToolkitSkills(manifests, tmpDir);

    // 2 ops + 1 overview = 3 files
    expect(files).toHaveLength(3);
    expect(fs.existsSync(path.join(tmpDir, 'toolkit-op_alpha', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'toolkit-op_beta', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'toolkit-overview', 'SKILL.md'))).toBe(true);
  });

  it('generates correct YAML frontmatter', () => {
    const manifests = new Map<string, ToolkitManifest>();
    manifests.set('test-toolkit', makeManifest());

    generateToolkitSkills(manifests, tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, 'toolkit-op_alpha', 'SKILL.md'), 'utf-8');
    expect(content).toContain('---');
    expect(content).toContain('name: toolkit-op_alpha');
    expect(content).toContain('description: "Alpha operation"');
  });

  it('includes operation details section', () => {
    const manifests = new Map<string, ToolkitManifest>();
    manifests.set('test-toolkit', makeManifest());

    generateToolkitSkills(manifests, tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, 'toolkit-op_alpha', 'SKILL.md'), 'utf-8');
    expect(content).toContain('## Details');
    expect(content).toContain('**Toolkit**: Test Toolkit (test-toolkit)');
    expect(content).toContain('**Tool**: tool-alpha');
    expect(content).toContain('**Docker Image**: protclaw/alpha:latest');
    expect(content).toContain('**GPU Required**: No');
  });

  it('shows depends_on when present', () => {
    const manifests = new Map<string, ToolkitManifest>();
    manifests.set('test-toolkit', makeManifest());

    generateToolkitSkills(manifests, tmpDir);

    const beta = fs.readFileSync(path.join(tmpDir, 'toolkit-op_beta', 'SKILL.md'), 'utf-8');
    expect(beta).toContain('**Depends On**: op_alpha');
  });

  it('includes planner hints when present', () => {
    const manifests = new Map<string, ToolkitManifest>();
    manifests.set('test-toolkit', makeManifest());

    generateToolkitSkills(manifests, tmpDir);

    const beta = fs.readFileSync(path.join(tmpDir, 'toolkit-op_beta', 'SKILL.md'), 'utf-8');
    expect(beta).toContain('## Planner Hints');
    expect(beta).toContain('**Typical Runtime**: 10m');
    expect(beta).toContain('**Cost Tier**: high');
  });

  it('includes inputs and outputs sections', () => {
    const manifests = new Map<string, ToolkitManifest>();
    manifests.set('test-toolkit', makeManifest());

    generateToolkitSkills(manifests, tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, 'toolkit-op_alpha', 'SKILL.md'), 'utf-8');
    expect(content).toContain('## Inputs');
    expect(content).toContain('**seq** (required): Input sequence');
    expect(content).toContain('## Outputs');
    expect(content).toContain('**result**: Alpha result');
  });

  it('includes usage JSON example', () => {
    const manifests = new Map<string, ToolkitManifest>();
    manifests.set('test-toolkit', makeManifest());

    generateToolkitSkills(manifests, tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, 'toolkit-op_alpha', 'SKILL.md'), 'utf-8');
    expect(content).toContain('## Usage');
    expect(content).toContain('"toolkit_op": "op_alpha"');
  });

  it('generates overview skill with all operations', () => {
    const manifests = new Map<string, ToolkitManifest>();
    manifests.set('test-toolkit', makeManifest());

    generateToolkitSkills(manifests, tmpDir);

    const overview = fs.readFileSync(path.join(tmpDir, 'toolkit-overview', 'SKILL.md'), 'utf-8');
    expect(overview).toContain('name: toolkit-overview');
    expect(overview).toContain('# Available Toolkit Operations');
    expect(overview).toContain('## Test Toolkit (`test-toolkit`)');
    expect(overview).toContain('| op_alpha |');
    expect(overview).toContain('| op_beta |');
  });

  it('overview includes dependency chain', () => {
    const manifests = new Map<string, ToolkitManifest>();
    manifests.set('test-toolkit', makeManifest());

    generateToolkitSkills(manifests, tmpDir);

    const overview = fs.readFileSync(path.join(tmpDir, 'toolkit-overview', 'SKILL.md'), 'utf-8');
    expect(overview).toContain('### Dependency Chain');
    expect(overview).toContain('`op_beta` depends on: op_alpha');
  });

  it('handles empty manifests map', () => {
    const manifests = new Map<string, ToolkitManifest>();

    const files = generateToolkitSkills(manifests, tmpDir);

    // Only overview generated
    expect(files).toHaveLength(1);
    expect(fs.existsSync(path.join(tmpDir, 'toolkit-overview', 'SKILL.md'))).toBe(true);
  });

  it('handles multiple toolkits', () => {
    const manifests = new Map<string, ToolkitManifest>();
    manifests.set('toolkit-a', makeManifest({ toolkit_id: 'toolkit-a', name: 'Toolkit A' }));
    manifests.set('toolkit-b', {
      toolkit_id: 'toolkit-b',
      name: 'Toolkit B',
      version: '2.0.0',
      operations: {
        op_gamma: {
          tool: 'tool-gamma',
          description: 'Gamma op',
          docker_image: 'protclaw/gamma:latest',
          gpu_required: false,
          inputs: {},
          outputs: {},
        },
      },
    } as ToolkitManifest);

    const files = generateToolkitSkills(manifests, tmpDir);

    // 2 ops from toolkit-a + 1 op from toolkit-b + 1 overview = 4
    expect(files).toHaveLength(4);

    const overview = fs.readFileSync(path.join(tmpDir, 'toolkit-overview', 'SKILL.md'), 'utf-8');
    expect(overview).toContain('Toolkit A');
    expect(overview).toContain('Toolkit B');
  });
});
