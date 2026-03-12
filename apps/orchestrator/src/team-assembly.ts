import fs from 'fs';
import path from 'path';

export interface AgentRoleConfig {
  role: string;
  templatePath: string;
  systemPrompt: string;
  active: boolean;
}

interface ProjectSpec {
  task_type: string;
  dbtl_config?: { max_cycles?: number };
  allowed_methods?: string[];
}

const ROLES_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'agent-roles',
);

const ROLE_TEMPLATES: Record<string, { file: string; alwaysInclude: boolean; condition?: (spec: ProjectSpec) => boolean }> = {
  'principal-scientist': {
    file: 'principal-scientist.md',
    alwaysInclude: true,
  },
  'program-manager': {
    file: 'program-manager.md',
    alwaysInclude: true,
  },
  'toolkit-specialist': {
    file: 'toolkit-specialist.md',
    alwaysInclude: true,
  },
  'evidence-reviewer': {
    file: 'evidence-reviewer.md',
    alwaysInclude: true,
  },
  'dbtl-reflection': {
    file: 'dbtl-reflection.md',
    alwaysInclude: false,
    condition: (spec: ProjectSpec) =>
      (spec.dbtl_config?.max_cycles ?? 0) > 0,
  },
};

function readTemplate(templatePath: string): string {
  try {
    return fs.readFileSync(templatePath, 'utf-8');
  } catch {
    return '';
  }
}

function interpolateContext(template: string, spec: ProjectSpec): string {
  let result = template;
  result = result.replace(/\{\{task_type\}\}/g, spec.task_type || 'unknown');
  if (spec.allowed_methods) {
    result = result.replace(
      /\{\{allowed_methods\}\}/g,
      spec.allowed_methods.join(', '),
    );
  }
  if (spec.dbtl_config?.max_cycles !== undefined) {
    result = result.replace(
      /\{\{max_cycles\}\}/g,
      String(spec.dbtl_config.max_cycles),
    );
  }
  return result;
}

/**
 * Assemble the team of agent roles for a given project spec.
 * Returns role configs with their system prompts loaded from template files.
 */
export function assembleTeam(projectSpec: ProjectSpec): AgentRoleConfig[] {
  const team: AgentRoleConfig[] = [];

  for (const [role, config] of Object.entries(ROLE_TEMPLATES)) {
    const shouldInclude =
      config.alwaysInclude ||
      (config.condition ? config.condition(projectSpec) : false);

    if (!shouldInclude) continue;

    const templatePath = path.join(ROLES_DIR, config.file);
    const rawTemplate = readTemplate(templatePath);
    const systemPrompt = interpolateContext(rawTemplate, projectSpec);

    team.push({
      role,
      templatePath,
      systemPrompt,
      active: true,
    });
  }

  return team;
}

/**
 * Get the roles directory path (for testing).
 */
export function getRolesDir(): string {
  return ROLES_DIR;
}
