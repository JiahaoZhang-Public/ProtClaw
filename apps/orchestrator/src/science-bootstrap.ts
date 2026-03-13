/**
 * Science Execution Bootstrap for ProtClaw
 *
 * Initializes the science execution infrastructure:
 * - Loads target config from .protclaw/targets.yaml
 * - Auto-infers runner type and concurrency from target hardware
 * - Creates ScienceQueue with hardware-appropriate limits
 * - Creates ScienceCache, ToolkitLoader, ExecutionDispatcher, AuditLogger
 * - Wires everything into the IPC layer via setExecutionDispatcher/setAuditLogger
 *
 * Call bootstrapScience() during app startup after database init.
 */

import path from 'node:path';

import { ScienceQueue } from './science-queue.js';
import { ScienceCache } from './science-cache.js';
import { ToolkitLoader } from './toolkit-loader.js';
import { ExecutionDispatcher } from './execution-dispatcher.js';
import { AuditLogger } from './audit-logger.js';
import { ProjectManager } from './project-manager.js';
import { runScienceContainer } from './science-runner.js';
import { runSshScience } from './ssh-science-runner.js';
import { setExecutionDispatcher, setAuditLogger } from './ipc.js';
import { loadTarget } from './target-loader.js';
import { ResourceScheduler } from './resource-scheduler.js';

export interface ScienceBootstrapConfig {
  /** SQLite database instance (from better-sqlite3) */
  db: import('better-sqlite3').Database;
  /** Base directory for project data */
  projectDir: string;
  /** Directory for audit logs */
  auditLogDir?: string;
  /** Directory for science cache */
  cacheDir?: string;
  /** Directory containing toolkit manifests */
  toolkitDir?: string;
}

export function bootstrapScience(config: ScienceBootstrapConfig): {
  dispatcher: ExecutionDispatcher;
  auditLogger: AuditLogger;
  queue: ScienceQueue;
} {
  const {
    db,
    projectDir,
    auditLogDir = path.join(projectDir, '_audit'),
    cacheDir = path.join(projectDir, '_cache'),
    toolkitDir = path.resolve(process.cwd(), '../../toolkits'),
  } = config;

  // 1. Choose runner based on SCIENCE_RUNNER env var
  const runnerType = process.env.SCIENCE_RUNNER || 'docker';
  const runner = runnerType === 'ssh' ? runSshScience : runScienceContainer;

  // 2. Auto-infer concurrency from target hardware
  let maxGpu: number;
  let maxCpu: number;

  if (runnerType === 'ssh') {
    try {
      const target = loadTarget(process.env.SSH_TARGET);
      const strategy = ResourceScheduler.inferStrategy(target);
      maxGpu = target.scheduling?.max_gpu_concurrent ?? strategy.gpuConcurrency;
      maxCpu = target.scheduling?.max_cpu_concurrent ?? strategy.cpuConcurrency;
    } catch {
      // Fallback if no targets.yaml found
      maxGpu = 3;
      maxCpu = 4;
    }
  } else {
    // Docker: conservative defaults
    maxGpu = 1;
    maxCpu = 4;
  }

  const queue = new ScienceQueue(maxGpu, maxCpu, runner);

  // 3. Create supporting services
  const cache = new ScienceCache(cacheDir);
  const toolkitLoader = new ToolkitLoader(toolkitDir);
  const pm = new ProjectManager(db);
  const auditLogger = new AuditLogger(auditLogDir);

  // 4. Create execution dispatcher
  const dispatcher = new ExecutionDispatcher({
    projectManager: pm,
    scienceQueue: queue,
    scienceCache: cache,
    toolkitLoader,
    projectDir,
    auditLogger,
  });

  // 5. Wire into IPC layer
  setExecutionDispatcher(dispatcher);
  setAuditLogger(auditLogger);

  return { dispatcher, auditLogger, queue };
}
