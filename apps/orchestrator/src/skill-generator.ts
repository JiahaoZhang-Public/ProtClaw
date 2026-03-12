/**
 * Skill Generator for ProtClaw
 *
 * Auto-generates SKILL.md files from toolkit manifests so that
 * agent containers can discover available toolkit operations.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolkitManifest } from '@protclaw/contracts';

type OpDef = ToolkitManifest['operations'][string];
type InputDef = OpDef['inputs'][string];
type OutputDef = OpDef['outputs'][string];

/**
 * Generate SKILL.md files for all operations across all toolkit manifests.
 * Creates one skill per operation plus an overview skill.
 */
export function generateToolkitSkills(
  manifests: Map<string, ToolkitManifest>,
  outputDir: string,
): string[] {
  const generatedFiles: string[] = [];

  for (const [toolkitId, manifest] of manifests) {
    for (const [opName, op] of Object.entries(manifest.operations) as [string, OpDef][]) {
      const skillDir = path.join(outputDir, `toolkit-${opName}`);
      fs.mkdirSync(skillDir, { recursive: true });

      const skillPath = path.join(skillDir, 'SKILL.md');
      const content = generateOperationSkill(toolkitId, manifest, opName, op);
      fs.writeFileSync(skillPath, content);
      generatedFiles.push(skillPath);
    }
  }

  // Generate overview skill
  const overviewDir = path.join(outputDir, 'toolkit-overview');
  fs.mkdirSync(overviewDir, { recursive: true });
  const overviewPath = path.join(overviewDir, 'SKILL.md');
  fs.writeFileSync(overviewPath, generateOverviewSkill(manifests));
  generatedFiles.push(overviewPath);

  return generatedFiles;
}

function generateOperationSkill(
  toolkitId: string,
  manifest: ToolkitManifest,
  opName: string,
  op: ToolkitManifest['operations'][string],
): string {
  const lines: string[] = [];

  // YAML frontmatter
  lines.push('---');
  lines.push(`name: toolkit-${opName}`);
  lines.push(`description: "${op.description}"`);
  lines.push('---');
  lines.push('');

  // Title
  lines.push(`# ${opName}`);
  lines.push('');
  lines.push(op.description);
  lines.push('');

  // Metadata
  lines.push('## Details');
  lines.push('');
  lines.push(`- **Toolkit**: ${manifest.name} (${toolkitId})`);
  lines.push(`- **Tool**: ${op.tool}`);
  if (op.docker_image) {
    lines.push(`- **Docker Image**: ${op.docker_image}`);
  }
  lines.push(`- **GPU Required**: ${op.gpu_required ? 'Yes' : 'No'}`);
  if (op.depends_on && op.depends_on.length > 0) {
    lines.push(`- **Depends On**: ${op.depends_on.join(', ')}`);
  }
  lines.push('');

  // Planner hints
  if (op.planner_hints) {
    lines.push('## Planner Hints');
    lines.push('');
    if (op.planner_hints.typical_runtime) {
      lines.push(`- **Typical Runtime**: ${op.planner_hints.typical_runtime}`);
    }
    if (op.planner_hints.cost_tier) {
      lines.push(`- **Cost Tier**: ${op.planner_hints.cost_tier}`);
    }
    lines.push('');
  }

  // Inputs
  if (Object.keys(op.inputs).length > 0) {
    lines.push('## Inputs');
    lines.push('');
    for (const [inputName, inputDef] of Object.entries(op.inputs) as [string, InputDef][]) {
      const req = inputDef.required ? ' (required)' : ' (optional)';
      lines.push(`- **${inputName}**${req}: ${inputDef.description ?? inputDef.type ?? 'any'}`);
    }
    lines.push('');
  }

  // Outputs
  if (Object.keys(op.outputs).length > 0) {
    lines.push('## Outputs');
    lines.push('');
    for (const [outputName, outputDef] of Object.entries(op.outputs) as [string, OutputDef][]) {
      lines.push(`- **${outputName}**: ${outputDef.description ?? outputDef.type ?? 'any'}`);
    }
    lines.push('');
  }

  // Usage
  lines.push('## Usage');
  lines.push('');
  lines.push('Submit this operation via the `submit_tool_run` MCP tool:');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify({
    toolkit_op: opName,
    params: Object.fromEntries(
      (Object.entries(op.inputs) as [string, InputDef][]).map(([k, v]) => [k, v.default ?? `<${v.type ?? 'value'}>`]),
    ),
  }, null, 2));
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

function generateOverviewSkill(manifests: Map<string, ToolkitManifest>): string {
  const lines: string[] = [];

  lines.push('---');
  lines.push('name: toolkit-overview');
  lines.push('description: "Overview of all available toolkit operations"');
  lines.push('---');
  lines.push('');
  lines.push('# Available Toolkit Operations');
  lines.push('');

  for (const [toolkitId, manifest] of manifests) {
    lines.push(`## ${manifest.name} (\`${toolkitId}\`)`);
    lines.push('');
    if (manifest.description) {
      lines.push(manifest.description);
      lines.push('');
    }

    lines.push('| Operation | Tool | GPU | Description |');
    lines.push('|-----------|------|-----|-------------|');

    for (const [opName, op] of Object.entries(manifest.operations) as [string, OpDef][]) {
      const gpu = op.gpu_required ? 'Yes' : 'No';
      lines.push(`| ${opName} | ${op.tool} | ${gpu} | ${op.description} |`);
    }

    lines.push('');

    // Show dependency chain
    const opsWithDeps = (Object.entries(manifest.operations) as [string, OpDef][]).filter(
      ([, op]) => op.depends_on && op.depends_on.length > 0,
    );
    if (opsWithDeps.length > 0) {
      lines.push('### Dependency Chain');
      lines.push('');
      for (const [opName, op] of opsWithDeps) {
        lines.push(`- \`${opName}\` depends on: ${op.depends_on!.join(', ')}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
