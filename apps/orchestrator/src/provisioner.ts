/**
 * Provisioner for ProtClaw
 *
 * Reads skill.yaml manifests via SkillRegistry and a target config,
 * then generates and executes environment setup commands:
 *
 * 1. Groups skills by conda env name (shared envs merged)
 * 2. Selects backend deps based on target.compute.backend (cuda/mps/cpu)
 * 3. Resolves template variables (${CUDA_WHEEL_TAG}, ${REPOS_DIR}, etc.)
 * 4. Creates conda envs + installs pip deps
 * 5. Clones repos + downloads models
 * 6. Runs skill patches (e.g. openfold monkey-patches)
 *
 * Works identically for SSH and local targets via ShellExecutor abstraction.
 * All commands are executed through ShellExecutor.exec() which uses
 * execFile (not exec) internally to avoid shell injection.
 *
 * Supports parallel env creation, incremental updates, and --dry-run.
 */

import type { ShellExecutor, TargetConfig, ResolvedPaths } from './shell-executor.js';
import type { SkillManifest, ComputeBackend, BackendDeps, SkillPatch } from './skill-registry.js';
import { SkillRegistry } from './skill-registry.js';
import { createExecutor, inferPaths } from './shell-executor.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ProvisionOptions {
  /** Only provision these skills (default: all loaded skills). */
  skills?: string[];
  /** Dry-run: generate commands but don't execute. */
  dryRun?: boolean;
  /** Force reinstall even if env already exists. */
  force?: boolean;
  /** Progress callback. */
  onProgress?: (event: ProvisionEvent) => void;
}

export interface ProvisionEvent {
  phase: 'env' | 'repo' | 'model' | 'patch' | 'done';
  envName?: string;
  skillName?: string;
  message: string;
  command?: string;
}

export interface ProvisionResult {
  success: boolean;
  envsCreated: string[];
  reposCloned: string[];
  modelsDownloaded: string[];
  patchesApplied: string[];
  errors: string[];
  commands: string[];
}

/* ------------------------------------------------------------------ */
/*  Provisioner                                                        */
/* ------------------------------------------------------------------ */

export class Provisioner {
  constructor(
    private registry: SkillRegistry,
    private target: TargetConfig,
    private executor?: ShellExecutor,
  ) {}

  /**
   * Provision all (or selected) skills for the target.
   *
   * Detects backend if 'auto', groups skills by conda env,
   * then creates envs, clones repos, downloads models, applies patches.
   */
  async provision(opts: ProvisionOptions = {}): Promise<ProvisionResult> {
    const exec = this.executor ?? createExecutor(this.target);
    const paths = inferPaths(this.target);
    const result: ProvisionResult = {
      success: true,
      envsCreated: [],
      reposCloned: [],
      modelsDownloaded: [],
      patchesApplied: [],
      errors: [],
      commands: [],
    };

    const emit = (event: ProvisionEvent) => {
      if (event.command) result.commands.push(event.command);
      opts.onProgress?.(event);
    };

    // Resolve backend (auto-detect if needed)
    const backend = await this.resolveBackend(exec);

    // Select skills to provision
    const skills = this.selectSkills(opts.skills);
    if (skills.length === 0) {
      emit({ phase: 'done', message: 'No skills to provision' });
      return result;
    }

    // Ensure base directories exist
    await this.ensureBaseDirs(exec, paths, opts.dryRun, emit);

    // 1. Group by env and create conda envs (parallel)
    const envGroups = this.groupByEnv(skills);
    const envPromises = [...envGroups.entries()].map(([envName, groupSkills]) =>
      this.provisionEnv(exec, paths, envName, groupSkills, backend, opts, emit, result),
    );
    await Promise.all(envPromises);

    // 2. Clone repos
    const allRepos = this.collectRepos(skills, paths);
    for (const repo of allRepos) {
      await this.provisionRepo(exec, repo, opts.dryRun, emit, result);
    }

    // 3. Download models
    const allModels = this.collectModels(skills, paths);
    for (const model of allModels) {
      await this.provisionModel(exec, model, opts.dryRun, emit, result);
    }

    // 4. Apply patches (after repos + envs are ready)
    for (const [envName, groupSkills] of envGroups) {
      for (const skill of groupSkills) {
        if (skill.environment.patches.length > 0) {
          await this.applyPatches(
            exec, paths, envName, skill, backend, opts.dryRun, emit, result,
          );
        }
      }
    }

    emit({ phase: 'done', message: `Provisioning complete: ${result.envsCreated.length} envs, ${result.reposCloned.length} repos, ${result.modelsDownloaded.length} models` });
    return result;
  }

  /**
   * Generate a dry-run summary of all commands that would be executed.
   */
  async dryRun(skillNames?: string[]): Promise<string[]> {
    const result = await this.provision({ skills: skillNames, dryRun: true });
    return result.commands;
  }

  /* ---------------------------------------------------------------- */
  /*  Backend detection                                                */
  /* ---------------------------------------------------------------- */

  private async resolveBackend(exec: ShellExecutor): Promise<ComputeBackend> {
    if (this.target.compute.backend !== 'auto') {
      return this.target.compute.backend as ComputeBackend;
    }

    // Auto-detect: try CUDA first, then MPS, then CPU
    const cudaCheck = await exec.exec(
      'nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null',
      { timeout: 10_000 },
    );
    if (cudaCheck.exitCode === 0 && cudaCheck.stdout.trim()) {
      return 'cuda';
    }

    // MPS check (macOS with Apple Silicon)
    const mpsCheck = await exec.exec(
      'python3 -c "import torch; print(torch.backends.mps.is_available())" 2>/dev/null',
      { timeout: 15_000 },
    );
    if (mpsCheck.exitCode === 0 && mpsCheck.stdout.trim() === 'True') {
      return 'mps';
    }

    return 'cpu';
  }

  /* ---------------------------------------------------------------- */
  /*  Skill selection & grouping                                       */
  /* ---------------------------------------------------------------- */

  private selectSkills(skillNames?: string[]): SkillManifest[] {
    if (skillNames && skillNames.length > 0) {
      return skillNames
        .map(n => this.registry.getSkill(n))
        .filter((s): s is SkillManifest => s !== undefined);
    }
    return this.registry.getAllSkills();
  }

  private groupByEnv(skills: SkillManifest[]): Map<string, SkillManifest[]> {
    const groups = new Map<string, SkillManifest[]>();
    for (const skill of skills) {
      const envName = skill.environment.name;
      const group = groups.get(envName) ?? [];
      group.push(skill);
      groups.set(envName, group);
    }
    return groups;
  }

  /* ---------------------------------------------------------------- */
  /*  Base directories                                                 */
  /* ---------------------------------------------------------------- */

  private async ensureBaseDirs(
    exec: ShellExecutor,
    paths: ResolvedPaths,
    dryRun: boolean | undefined,
    emit: (e: ProvisionEvent) => void,
  ): Promise<void> {
    const dirs = [paths.envs, paths.repos, paths.models, paths.cache].join(' ');
    const cmd = `mkdir -p ${dirs}`;
    emit({ phase: 'env', message: 'Creating base directories', command: cmd });
    if (!dryRun) {
      await exec.exec(cmd, { timeout: 10_000 });
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Conda env provisioning                                           */
  /* ---------------------------------------------------------------- */

  private async provisionEnv(
    exec: ShellExecutor,
    paths: ResolvedPaths,
    envName: string,
    skills: SkillManifest[],
    backend: ComputeBackend,
    opts: ProvisionOptions,
    emit: (e: ProvisionEvent) => void,
    result: ProvisionResult,
  ): Promise<void> {
    const envPath = `${paths.envs}/${envName}`;
    const pythonVersion = skills[0]!.environment.python;

    // Check if env already exists
    if (!opts.force) {
      const exists = await exec.fileExists(`${envPath}/bin/python`);
      if (exists) {
        emit({ phase: 'env', envName, message: `Env ${envName} already exists, skipping (use --force to reinstall)` });
        return;
      }
    }

    emit({ phase: 'env', envName, message: `Creating conda env: ${envName} (Python ${pythonVersion}, backend: ${backend})` });

    // Create conda env
    const condaActivate = paths.conda;
    const createCmd = [
      `source ${condaActivate} 2>/dev/null || true`,
      `conda create -y -p ${envPath} python=${pythonVersion}`,
    ].join(' && ');

    emit({ phase: 'env', envName, message: 'Creating conda environment', command: createCmd });
    if (!opts.dryRun) {
      const createResult = await exec.exec(createCmd, { timeout: 300_000 });
      if (createResult.exitCode !== 0) {
        const err = `Failed to create env ${envName}: ${createResult.stderr}`;
        result.errors.push(err);
        result.success = false;
        return;
      }
    }

    // Merge pip deps from all skills sharing this env
    const mergedPip = this.mergePipDeps(skills, backend);
    const mergedEditable = this.mergeEditableInstalls(skills, backend, paths);

    // Install pip packages
    if (mergedPip.length > 0) {
      const pipCmd = [
        `source ${condaActivate} ${envPath}`,
        `pip install ${mergedPip.join(' ')}`,
      ].join(' && ');

      emit({ phase: 'env', envName, message: 'Installing pip packages', command: pipCmd });
      if (!opts.dryRun) {
        const pipResult = await exec.exec(pipCmd, { timeout: 600_000 });
        if (pipResult.exitCode !== 0) {
          const err = `Failed to install pip packages for ${envName}: ${pipResult.stderr}`;
          result.errors.push(err);
          result.success = false;
          return;
        }
      }
    }

    // Install editable packages
    for (const editablePath of mergedEditable) {
      const editCmd = [
        `source ${condaActivate} ${envPath}`,
        `pip install -e ${editablePath}`,
      ].join(' && ');

      emit({ phase: 'env', envName, message: `Installing editable: ${editablePath}`, command: editCmd });
      if (!opts.dryRun) {
        const editResult = await exec.exec(editCmd, { timeout: 300_000 });
        if (editResult.exitCode !== 0) {
          result.errors.push(`Failed to install editable ${editablePath}: ${editResult.stderr}`);
          // Non-fatal: continue with other installs
        }
      }
    }

    result.envsCreated.push(envName);
  }

  /**
   * Merge pip deps from all skills sharing the same env,
   * deduplicating packages and resolving backend-specific deps.
   */
  private mergePipDeps(skills: SkillManifest[], backend: ComputeBackend): string[] {
    const seen = new Set<string>();
    const merged: string[] = [];

    const cudaWheelTag = this.getCudaWheelTag();

    for (const skill of skills) {
      const deps = this.selectBackendDeps(skill, backend);
      if (!deps) continue;

      for (const pkg of deps.pip) {
        const resolved = pkg.replace(/\$\{CUDA_WHEEL_TAG\}/g, cudaWheelTag);
        // Deduplicate by first word (package name)
        const pkgName = resolved.split(/\s+/)[0]!.replace(/[><=!@].*/g, '');
        if (!seen.has(pkgName)) {
          seen.add(pkgName);
          merged.push(resolved);
        }
      }
    }

    return merged;
  }

  private mergeEditableInstalls(
    skills: SkillManifest[],
    backend: ComputeBackend,
    paths: ResolvedPaths,
  ): string[] {
    const seen = new Set<string>();
    const merged: string[] = [];

    for (const skill of skills) {
      const deps = this.selectBackendDeps(skill, backend);
      if (!deps?.editable_installs) continue;

      for (const pkg of deps.editable_installs) {
        const resolved = this.resolvePathTemplate(pkg, paths);
        if (!seen.has(resolved)) {
          seen.add(resolved);
          merged.push(resolved);
        }
      }
    }

    return merged;
  }

  /**
   * Select the best backend deps for a skill.
   * Falls back: requested backend → cpu → first available.
   */
  private selectBackendDeps(skill: SkillManifest, backend: ComputeBackend): BackendDeps | undefined {
    const { backends } = skill.environment;
    return backends[backend] ?? backends.cpu ?? Object.values(backends)[0];
  }

  /* ---------------------------------------------------------------- */
  /*  Repos                                                            */
  /* ---------------------------------------------------------------- */

  private collectRepos(
    skills: SkillManifest[],
    paths: ResolvedPaths,
  ): Array<{ url: string; path: string; branch?: string }> {
    const seen = new Set<string>();
    const repos: Array<{ url: string; path: string; branch?: string }> = [];

    for (const skill of skills) {
      for (const repo of skill.repos) {
        const resolvedPath = this.resolvePathTemplate(repo.path, paths);
        if (!seen.has(resolvedPath)) {
          seen.add(resolvedPath);
          repos.push({ url: repo.url, path: resolvedPath, branch: repo.branch });
        }
      }
    }

    return repos;
  }

  private async provisionRepo(
    exec: ShellExecutor,
    repo: { url: string; path: string; branch?: string },
    dryRun: boolean | undefined,
    emit: (e: ProvisionEvent) => void,
    result: ProvisionResult,
  ): Promise<void> {
    // Check if already cloned
    const exists = await exec.fileExists(`${repo.path}/.git`);
    if (exists) {
      emit({ phase: 'repo', message: `Repo already cloned: ${repo.path}` });
      return;
    }

    const branchFlag = repo.branch ? `-b ${repo.branch}` : '';
    const cmd = `git clone --depth 1 ${branchFlag} ${repo.url} ${repo.path}`.trim();

    emit({ phase: 'repo', message: `Cloning ${repo.url}`, command: cmd });
    if (!dryRun) {
      const cloneResult = await exec.exec(cmd, { timeout: 300_000 });
      if (cloneResult.exitCode !== 0) {
        result.errors.push(`Failed to clone ${repo.url}: ${cloneResult.stderr}`);
        result.success = false;
        return;
      }
    }

    result.reposCloned.push(repo.path);
  }

  /* ---------------------------------------------------------------- */
  /*  Models                                                           */
  /* ---------------------------------------------------------------- */

  private collectModels(
    skills: SkillManifest[],
    paths: ResolvedPaths,
  ): Array<{ name: string; path: string; url?: string; auto_download?: boolean; size_gb?: number }> {
    const seen = new Set<string>();
    const models: Array<{ name: string; path: string; url?: string; auto_download?: boolean; size_gb?: number }> = [];

    for (const skill of skills) {
      for (const model of skill.models) {
        const resolvedPath = this.resolvePathTemplate(model.path, paths);
        if (!seen.has(resolvedPath)) {
          seen.add(resolvedPath);
          models.push({ ...model, path: resolvedPath });
        }
      }
    }

    return models;
  }

  private async provisionModel(
    exec: ShellExecutor,
    model: { name: string; path: string; url?: string; auto_download?: boolean; size_gb?: number },
    dryRun: boolean | undefined,
    emit: (e: ProvisionEvent) => void,
    result: ProvisionResult,
  ): Promise<void> {
    // Auto-download models (e.g. HuggingFace) are downloaded at runtime
    if (model.auto_download) {
      emit({ phase: 'model', message: `Model ${model.name} will auto-download at runtime (${model.size_gb ?? '?'}GB)` });
      return;
    }

    // No URL means model must be manually placed
    if (!model.url) {
      emit({ phase: 'model', message: `Model ${model.name} has no URL — must be manually placed at ${model.path}` });
      return;
    }

    // Check if already downloaded
    const exists = await exec.fileExists(model.path);
    if (exists) {
      emit({ phase: 'model', message: `Model already exists: ${model.path}` });
      return;
    }

    // Ensure parent dir exists and download
    const parentDir = model.path.substring(0, model.path.lastIndexOf('/'));
    const cmd = `mkdir -p ${parentDir} && wget -q -O ${model.path} "${model.url}"`;

    const sizeInfo = model.size_gb ? ` (~${model.size_gb}GB)` : '';
    emit({ phase: 'model', message: `Downloading ${model.name}${sizeInfo}`, command: cmd });
    if (!dryRun) {
      const dlResult = await exec.exec(cmd, { timeout: 600_000 });
      if (dlResult.exitCode !== 0) {
        result.errors.push(`Failed to download ${model.name}: ${dlResult.stderr}`);
        result.success = false;
        return;
      }
    }

    result.modelsDownloaded.push(model.name);
  }

  /* ---------------------------------------------------------------- */
  /*  Patches                                                          */
  /* ---------------------------------------------------------------- */

  private async applyPatches(
    exec: ShellExecutor,
    paths: ResolvedPaths,
    envName: string,
    skill: SkillManifest,
    backend: ComputeBackend,
    dryRun: boolean | undefined,
    emit: (e: ProvisionEvent) => void,
    result: ProvisionResult,
  ): Promise<void> {
    const envPath = `${paths.envs}/${envName}`;
    const condaActivate = paths.conda;

    for (const patch of skill.environment.patches) {
      // Skip CUDA-specific patches on non-CUDA backends
      if (this.isCudaOnlyPatch(patch) && backend !== 'cuda') {
        emit({ phase: 'patch', skillName: skill.name, message: `Skipping CUDA-only patch: ${patch.name}` });
        continue;
      }

      // Resolve template variables in patch script
      const resolvedScript = this.resolvePathTemplate(patch.script, paths);

      const cmd = [
        `source ${condaActivate} ${envPath}`,
        resolvedScript,
      ].join(' && ');

      emit({ phase: 'patch', skillName: skill.name, message: `Applying patch: ${patch.name}`, command: cmd });
      if (!dryRun) {
        const patchResult = await exec.exec(cmd, { timeout: 120_000 });
        if (patchResult.exitCode !== 0) {
          result.errors.push(`Patch ${patch.name} failed for ${skill.name}: ${patchResult.stderr}`);
          // Non-fatal: continue with other patches
        } else {
          result.patchesApplied.push(`${skill.name}:${patch.name}`);
        }
      } else {
        result.patchesApplied.push(`${skill.name}:${patch.name}`);
      }
    }
  }

  /**
   * Heuristic: patches that mention deepspeed or CUDA kernels are CUDA-only.
   */
  private isCudaOnlyPatch(patch: SkillPatch): boolean {
    const name = patch.name.toLowerCase();
    return name.includes('deepspeed') || name.includes('cuda-kernel');
  }

  /* ---------------------------------------------------------------- */
  /*  Template resolution                                              */
  /* ---------------------------------------------------------------- */

  private getCudaWheelTag(): string {
    const ver = this.target.compute.cuda_version;
    return ver ? `cu${ver.replace('.', '')}` : 'cu121';
  }

  private resolvePathTemplate(template: string, paths: ResolvedPaths): string {
    return template
      .replace(/\$\{REPOS_DIR\}/g, paths.repos)
      .replace(/\$\{MODELS_DIR\}/g, paths.models)
      .replace(/\$\{CACHE_DIR\}/g, paths.cache)
      .replace(/\$\{CUDA_WHEEL_TAG\}/g, this.getCudaWheelTag());
  }
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Create a Provisioner from a target config.
 * Loads all skills from the default tools directory.
 */
export function createProvisioner(
  target: TargetConfig,
  toolsDir: string,
  executor?: ShellExecutor,
): Provisioner {
  const registry = new SkillRegistry();
  registry.loadAll(toolsDir);
  return new Provisioner(registry, target, executor);
}
