/**
 * Skill Registry for ProtClaw
 *
 * Scans skill directories following the Agent Skills standard (agentskills.io):
 * - SKILL.md: Agent-facing metadata (name, description, version) in YAML frontmatter
 * - infrastructure.yaml: Provisioner-facing infra config (environment, repos, models)
 *
 * The registry merges both sources into a unified SkillManifest for downstream
 * consumers (Provisioner, ResourceScheduler, DagExecutor, ExecutionEngine).
 *
 * Directory structure per skill:
 *   {toolsDir}/{skillName}/
 *     SKILL.md              — Standard Agent Skills format (required)
 *     infrastructure.yaml   — ProtClaw infra declarations (required)
 *     adapter.py            — Python execution code
 *     scripts/patches/      — Environment patch scripts (optional)
 *
 * Legacy skill.yaml format is still supported for backward compatibility.
 */

import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ComputeBackend = 'cuda' | 'mps' | 'cpu';

export interface BackendDeps {
  pip: string[];
  editable_installs?: string[];
  notes?: string;
}

export interface SkillPatch {
  name: string;
  description?: string;
  /** Shell script content or relative path to a .sh file. */
  script: string;
}

export interface SkillRepo {
  url: string;
  path: string;
  branch?: string;
}

export interface SkillModel {
  name: string;
  path: string;
  url?: string;
  auto_download?: boolean;
  size_gb?: number;
}

export interface SkillResources {
  gpu: 'required' | 'preferred' | 'none';
  gpu_vram_min_gb?: number;
  ram_min_gb?: number;
  estimated_runtime?: Record<string, string>;
  cost_tier?: 'fast' | 'balanced' | 'expensive';
}

export interface SkillEnvironment {
  name: string;
  python: string;
  backends: Partial<Record<ComputeBackend, BackendDeps>>;
  patches: SkillPatch[];
}

/** Agent-facing metadata from SKILL.md frontmatter. */
export interface SkillMeta {
  name: string;
  description: string;
  version: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowed_tools?: string;
}

/** Provisioner-facing infra config from infrastructure.yaml. */
export interface SkillInfra {
  environment: SkillEnvironment;
  repos: SkillRepo[];
  models: SkillModel[];
  resources: SkillResources;
  runtime_env: Record<string, string>;
}

/** Merged view: SkillMeta + SkillInfra (backward-compatible). */
export interface SkillManifest extends SkillMeta, SkillInfra {}

export interface TargetPaths {
  base: string;
  envs: string;
  repos: string;
  models: string;
  cache: string;
}

/* ------------------------------------------------------------------ */
/*  Skill Registry                                                     */
/* ------------------------------------------------------------------ */

export class SkillRegistry {
  private skills: Map<string, SkillManifest> = new Map();

  /**
   * Load all skills from a tools directory.
   *
   * Scans: {toolsDir}/{skillName}/SKILL.md + infrastructure.yaml
   * Falls back to legacy skill.yaml if SKILL.md is not found.
   */
  loadAll(toolsDir: string): void {
    if (!fs.existsSync(toolsDir)) return;

    for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) {
        continue;
      }
      const skillDir = path.join(toolsDir, entry.name);
      const manifest = this.tryLoadSkill(skillDir);
      if (manifest) {
        this.skills.set(manifest.name, manifest);
      }
    }
  }

  /**
   * Load a single skill from its directory path.
   */
  loadOne(skillDirOrYaml: string): SkillManifest | undefined {
    // Support both: directory path or direct YAML file path (legacy)
    let skillDir: string;
    if (skillDirOrYaml.endsWith('.yaml') || skillDirOrYaml.endsWith('.yml')) {
      skillDir = path.dirname(skillDirOrYaml);
    } else {
      skillDir = skillDirOrYaml;
    }

    const manifest = this.tryLoadSkill(skillDir);
    if (manifest) {
      this.skills.set(manifest.name, manifest);
    }
    return manifest;
  }

  /** Get skill by name. */
  getSkill(name: string): SkillManifest | undefined {
    return this.skills.get(name);
  }

  /** Get all loaded skills. */
  getAllSkills(): SkillManifest[] {
    return [...this.skills.values()];
  }

  /** Get skill names. */
  getSkillNames(): string[] {
    return [...this.skills.keys()];
  }

  /** Get conda env name for a skill. Falls back to 'protclaw-cpu'. */
  getEnvName(skillName: string): string {
    return this.skills.get(skillName)?.environment.name ?? 'protclaw-cpu';
  }

  /** Get all skill names that require or prefer GPU. */
  getGpuSkills(): string[] {
    return [...this.skills.values()]
      .filter(s => s.resources.gpu === 'required' || s.resources.gpu === 'preferred')
      .map(s => s.name);
  }

  /** Check if a skill needs GPU on a given target. */
  needsGpu(skillName: string, hasGpu: boolean): boolean {
    const skill = this.skills.get(skillName);
    if (!skill) return false;
    if (skill.resources.gpu === 'required') return true;
    if (skill.resources.gpu === 'preferred' && hasGpu) return true;
    return false;
  }

  /**
   * Resolve pip dependencies for a skill on a given backend.
   *
   * Falls back: requested backend → cpu → first available backend.
   */
  resolveBackendDeps(
    skillName: string,
    backend: ComputeBackend,
    cudaVersion?: string,
  ): BackendDeps | undefined {
    const skill = this.skills.get(skillName);
    if (!skill) return undefined;

    const { backends } = skill.environment;
    const deps = backends[backend] ?? backends.cpu ?? Object.values(backends)[0];
    if (!deps) return undefined;

    // Resolve ${CUDA_WHEEL_TAG} template
    const cudaWheelTag = cudaVersion
      ? `cu${cudaVersion.replace('.', '')}`
      : 'cu121';

    return {
      pip: deps.pip.map(p => p.replace(/\$\{CUDA_WHEEL_TAG\}/g, cudaWheelTag)),
      editable_installs: deps.editable_installs?.map(p =>
        p.replace(/\$\{CUDA_WHEEL_TAG\}/g, cudaWheelTag),
      ),
      notes: deps.notes,
    };
  }

  /**
   * Resolve runtime environment variables for a skill,
   * substituting path templates.
   */
  resolveRuntimeEnv(
    skillName: string,
    paths: TargetPaths,
  ): Record<string, string> {
    const skill = this.skills.get(skillName);
    if (!skill) return {};

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(skill.runtime_env)) {
      result[key] = value
        .replace(/\$\{REPOS_DIR\}/g, paths.repos)
        .replace(/\$\{MODELS_DIR\}/g, paths.models)
        .replace(/\$\{CACHE_DIR\}/g, paths.cache);
    }
    return result;
  }

  /**
   * Group skills by their conda env name.
   * Skills sharing the same env name will be installed together.
   */
  groupByEnv(): Map<string, SkillManifest[]> {
    const groups = new Map<string, SkillManifest[]>();
    for (const skill of this.skills.values()) {
      const envName = skill.environment.name;
      const group = groups.get(envName) ?? [];
      group.push(skill);
      groups.set(envName, group);
    }
    return groups;
  }

  /* ---------------------------------------------------------------- */
  /*  Private: Loading                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Try to load a skill from a directory.
   *
   * Priority:
   * 1. SKILL.md + infrastructure.yaml (standard format)
   * 2. skill.yaml (legacy format, backward-compatible)
   */
  private tryLoadSkill(skillDir: string): SkillManifest | undefined {
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    const infraPath = path.join(skillDir, 'infrastructure.yaml');
    const legacyPath = path.join(skillDir, 'skill.yaml');

    // Standard format: SKILL.md + infrastructure.yaml
    if (fs.existsSync(skillMdPath) && fs.existsSync(infraPath)) {
      return this.loadStandardSkill(skillDir, skillMdPath, infraPath);
    }

    // Legacy format: skill.yaml (contains everything)
    if (fs.existsSync(legacyPath)) {
      return this.parseLegacySkillYaml(legacyPath);
    }

    return undefined;
  }

  /**
   * Load a skill from the standard Agent Skills format:
   * SKILL.md (frontmatter) + infrastructure.yaml
   */
  private loadStandardSkill(
    skillDir: string,
    skillMdPath: string,
    infraPath: string,
  ): SkillManifest {
    const meta = this.parseSkillMd(skillMdPath);
    const infra = this.parseInfraYaml(skillDir, infraPath);
    return { ...meta, ...infra };
  }

  /**
   * Parse SKILL.md YAML frontmatter.
   *
   * Format:
   * ---
   * name: skill-name
   * description: ...
   * metadata:
   *   version: "1.0.0"
   * ---
   * # Markdown body (ignored by registry)
   */
  private parseSkillMd(skillMdPath: string): SkillMeta {
    const content = fs.readFileSync(skillMdPath, 'utf-8');

    // Extract YAML frontmatter between --- delimiters
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) {
      throw new Error(`No YAML frontmatter found in ${skillMdPath}`);
    }

    const frontmatter = YAML.parse(match[1]!) as Record<string, unknown>;

    const name = frontmatter.name as string;
    const description = frontmatter.description as string;
    const compatibility = frontmatter.compatibility as string | undefined;
    const metadata = frontmatter.metadata as Record<string, string> | undefined;
    const allowedTools = frontmatter['allowed-tools'] as string | undefined;

    // Extract version from metadata (our convention) or default to "0.0.0"
    const version = metadata?.version ?? '0.0.0';

    return {
      name,
      description,
      version,
      compatibility,
      metadata,
      allowed_tools: allowedTools,
    };
  }

  /**
   * Parse infrastructure.yaml — the ProtClaw-specific infra declarations.
   *
   * Resolves patch script file references: if a patch.script looks like a
   * file path (contains / or ends with .sh), read the file content.
   */
  private parseInfraYaml(skillDir: string, infraPath: string): SkillInfra {
    const raw = fs.readFileSync(infraPath, 'utf-8');
    const parsed = YAML.parse(raw) as Record<string, unknown>;

    const environment = parsed.environment as SkillEnvironment;

    // Resolve patch script file references
    const patches: SkillPatch[] = (environment.patches ?? []).map(patch => {
      if (this.isPatchFilePath(patch.script)) {
        const scriptPath = path.resolve(skillDir, patch.script);
        if (fs.existsSync(scriptPath)) {
          return { ...patch, script: fs.readFileSync(scriptPath, 'utf-8') };
        }
      }
      return patch;
    });

    return {
      environment: {
        ...environment,
        patches,
      },
      repos: (parsed.repos as SkillRepo[]) ?? [],
      models: (parsed.models as SkillModel[]) ?? [],
      resources: parsed.resources as SkillResources,
      runtime_env: (parsed.runtime_env as Record<string, string>) ?? {},
    };
  }

  /**
   * Legacy: parse a single skill.yaml that contains everything.
   * Kept for backward compatibility.
   */
  private parseLegacySkillYaml(yamlPath: string): SkillManifest {
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    const parsed = YAML.parse(raw) as Record<string, unknown>;

    return {
      name: parsed.name as string,
      version: parsed.version as string,
      description: parsed.description as string,
      environment: {
        ...(parsed.environment as SkillEnvironment),
        patches: (parsed.environment as SkillEnvironment).patches ?? [],
      },
      repos: (parsed.repos as SkillRepo[]) ?? [],
      models: (parsed.models as SkillModel[]) ?? [],
      resources: parsed.resources as SkillResources,
      runtime_env: (parsed.runtime_env as Record<string, string>) ?? {},
    };
  }

  /**
   * Check if a patch script string looks like a file path rather than inline script.
   * File paths contain '/' and are single-line, or end with '.sh'.
   */
  private isPatchFilePath(script: string): boolean {
    const trimmed = script.trim();
    return (trimmed.includes('/') && !trimmed.includes('\n')) || trimmed.endsWith('.sh');
  }
}
