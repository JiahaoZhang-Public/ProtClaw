import { describe, it, expect } from 'vitest';

import { assembleTeam, getRolesDir } from './team-assembly.js';

describe('assembleTeam', () => {
  it('includes core roles for a basic design task', () => {
    const team = assembleTeam({ task_type: 'binder_design' });

    const roles = team.map((r) => r.role);
    expect(roles).toContain('principal-scientist');
    expect(roles).toContain('program-manager');
    expect(roles).toContain('toolkit-specialist');
    expect(roles).toContain('evidence-reviewer');
  });

  it('excludes DBTL reflection when max_cycles is 0', () => {
    const team = assembleTeam({
      task_type: 'binder_design',
      dbtl_config: { max_cycles: 0 },
    });

    const roles = team.map((r) => r.role);
    expect(roles).not.toContain('dbtl-reflection');
  });

  it('excludes DBTL reflection when dbtl_config is absent', () => {
    const team = assembleTeam({ task_type: 'binder_design' });

    const roles = team.map((r) => r.role);
    expect(roles).not.toContain('dbtl-reflection');
  });

  it('includes DBTL reflection when max_cycles > 0', () => {
    const team = assembleTeam({
      task_type: 'binder_design',
      dbtl_config: { max_cycles: 3 },
    });

    const roles = team.map((r) => r.role);
    expect(roles).toContain('dbtl-reflection');
  });

  it('all returned configs are active', () => {
    const team = assembleTeam({ task_type: 'stability_optimization' });

    for (const config of team) {
      expect(config.active).toBe(true);
    }
  });

  it('system prompts are non-empty strings', () => {
    const team = assembleTeam({ task_type: 'binder_design' });

    for (const config of team) {
      expect(config.systemPrompt).toBeTruthy();
      expect(typeof config.systemPrompt).toBe('string');
      expect(config.systemPrompt.length).toBeGreaterThan(0);
    }
  });

  it('template paths point to agent-roles directory', () => {
    const team = assembleTeam({ task_type: 'binder_design' });
    const rolesDir = getRolesDir();

    for (const config of team) {
      expect(config.templatePath).toContain(rolesDir);
      expect(config.templatePath.endsWith('.md')).toBe(true);
    }
  });

  it('returns 4 roles for design task without DBTL', () => {
    const team = assembleTeam({ task_type: 'enzyme_design' });
    expect(team).toHaveLength(4);
  });

  it('returns 5 roles for design task with DBTL', () => {
    const team = assembleTeam({
      task_type: 'enzyme_design',
      dbtl_config: { max_cycles: 2 },
    });
    expect(team).toHaveLength(5);
  });
});
