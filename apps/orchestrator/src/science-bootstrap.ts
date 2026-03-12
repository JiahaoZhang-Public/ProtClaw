/**
 * Science Execution Bootstrap for ProtClaw
 *
 * Initializes the science execution infrastructure:
 * - Chooses runner (Docker or SSH) based on SCIENCE_RUNNER env var
 * - Creates ScienceQueue with appropriate concurrency limits
 * - Creates ScienceCache
 * - Creates ToolkitLoader
 * - Creates ExecutionDispatcher and AuditLogger
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

  // 2. Configure queue concurrency based on runner type
  //    SSH: 3 GPU slots (4 GPUs, 1 reserved), 4 CPU slots
  //    Docker: 1 GPU slot, 4 CPU slots
  const maxGpu = runnerType === 'ssh' ? 3 : 1;
  const maxCpu = 4;

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
