import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask, getDb } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { ProjectManager } from './project-manager.js';
import { RegisteredGroup } from './types.js';
import { AuditLogger } from './audit-logger.js';
import { ExecutionDispatcher } from './execution-dispatcher.js';
import { LearningAnalyzer } from './learning-analyzer.js';
import { Replanner } from './replanner.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Process science operations from this group's IPC directory
      const scienceDir = path.join(ipcBaseDir, sourceGroup, 'science');
      try {
        if (fs.existsSync(scienceDir)) {
          const scienceFiles = fs
            .readdirSync(scienceDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of scienceFiles) {
            const filePath = path.join(scienceDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              const result = processScienceIpc(data);
              // Write result back to a response file
              const responseDir = path.join(ipcBaseDir, sourceGroup, 'science-responses');
              fs.mkdirSync(responseDir, { recursive: true });
              const responseFile = path.join(responseDir, file);
              const tempPath = `${responseFile}.tmp`;
              fs.writeFileSync(tempPath, JSON.stringify(result, null, 2));
              fs.renameSync(tempPath, responseFile);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC science operation',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-science-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC science directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

// --- Science IPC handlers ---

let _projectManager: ProjectManager | null = null;

function getProjectManager(): ProjectManager {
  if (!_projectManager) {
    _projectManager = new ProjectManager(getDb());
  }
  return _projectManager;
}

/** @internal - for tests only. Reset project manager instance. */
export function _resetProjectManager(): void {
  _projectManager = null;
}

export interface ScienceIpcResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export function processScienceIpc(data: {
  type: string;
  [key: string]: unknown;
}): ScienceIpcResult {
  const pm = getProjectManager();

  try {
    switch (data.type) {
      case 'science:submit_run': {
        if (!data.artifact) {
          return { success: false, error: 'Missing artifact data' };
        }
        const artifact = data.artifact as {
          id: string;
          project_id: string;
          plan_id?: string;
          op_id?: string;
          candidate_id?: string;
          artifact_type?: string;
          producer?: string;
          status?: string;
          artifact?: object;
          cache_key?: string;
        };
        pm.recordArtifact({
          id: artifact.id,
          project_id: artifact.project_id,
          plan_id: artifact.plan_id || '',
          op_id: artifact.op_id || '',
          candidate_id: artifact.candidate_id || '',
          artifact_type: artifact.artifact_type || '',
          producer: artifact.producer || '',
          status: (artifact.status as 'pending' | 'running' | 'completed' | 'failed') || 'pending',
          artifact: artifact.artifact || {},
          cache_key: artifact.cache_key || '',
        });
        logger.info({ artifactId: artifact.id }, 'Science run submitted via IPC');
        return { success: true, data: { id: artifact.id } };
      }

      case 'science:get_status': {
        const projectId = data.projectId as string;
        const opId = data.opId as string | undefined;
        if (!projectId) {
          return { success: false, error: 'Missing projectId' };
        }
        const artifacts = pm.getArtifacts(projectId, opId ? { opId } : undefined);
        return { success: true, data: artifacts };
      }

      case 'science:get_artifacts': {
        const projectId = data.projectId as string;
        if (!projectId) {
          return { success: false, error: 'Missing projectId' };
        }
        const filters: { candidateId?: string; opId?: string; type?: string } = {};
        if (data.candidateId) filters.candidateId = data.candidateId as string;
        if (data.opId) filters.opId = data.opId as string;
        if (data.artifactType) filters.type = data.artifactType as string;
        const artifacts = pm.getArtifacts(projectId, filters);
        return { success: true, data: artifacts };
      }

      case 'science:record_evidence': {
        const evidence = data.evidence as {
          id: string;
          candidate_id?: string;
          project_id?: string;
          record?: object;
        };
        if (!evidence?.id) {
          return { success: false, error: 'Missing evidence data or id' };
        }
        pm.recordEvidence({
          id: evidence.id,
          candidate_id: evidence.candidate_id || '',
          project_id: evidence.project_id || '',
          record: evidence.record || {},
        });
        logger.info({ evidenceId: evidence.id }, 'Evidence recorded via IPC');
        return { success: true, data: { id: evidence.id } };
      }

      case 'science:create_candidate': {
        const candidate = data.candidate as {
          id: string;
          project_id: string;
          sequence?: string;
          status?: string;
          rank?: number | null;
          card?: object;
        };
        if (!candidate?.id || !candidate?.project_id) {
          return { success: false, error: 'Missing candidate id or project_id' };
        }
        pm.createCandidate({
          id: candidate.id,
          project_id: candidate.project_id,
          sequence: candidate.sequence || '',
          status: (candidate.status as 'draft' | 'active' | 'promoted' | 'rejected' | 'archived') || 'draft',
          rank: candidate.rank ?? null,
          card: candidate.card || {},
        });
        logger.info({ candidateId: candidate.id }, 'Candidate created via IPC');
        return { success: true, data: { id: candidate.id } };
      }

      case 'science:list_candidates': {
        const projectId = data.projectId as string;
        if (!projectId) {
          return { success: false, error: 'Missing projectId' };
        }
        const status = data.status as string | undefined;
        const candidates = pm.listCandidates(projectId, status);
        return { success: true, data: candidates };
      }

      case 'science:rank_candidates': {
        const projectId = data.projectId as string;
        if (!projectId) {
          return { success: false, error: 'Missing projectId' };
        }
        // Retrieve all active candidates and rank them by their current rank field
        const candidates = pm.listCandidates(projectId, 'active');
        // Re-rank by assigning sequential ranks based on current order
        for (let i = 0; i < candidates.length; i++) {
          pm.updateCandidate(candidates[i].id, { rank: i + 1 });
        }
        logger.info({ projectId, count: candidates.length }, 'Candidates ranked via IPC');
        return { success: true, data: { ranked: candidates.length } };
      }

      case 'science:submit_feedback': {
        const feedback = data.feedback as {
          id: string;
          project_id: string;
          candidate_id?: string;
          feedback?: object;
        };
        if (!feedback?.id || !feedback?.project_id) {
          return { success: false, error: 'Missing feedback id or project_id' };
        }
        pm.recordFeedback({
          id: feedback.id,
          project_id: feedback.project_id,
          candidate_id: feedback.candidate_id || '',
          feedback: feedback.feedback || {},
        });
        logger.info({ feedbackId: feedback.id }, 'Feedback submitted via IPC');
        return { success: true, data: { id: feedback.id } };
      }

      case 'science:request_replan': {
        const projectId = data.projectId as string;
        if (!projectId) {
          return { success: false, error: 'Missing projectId' };
        }

        // Analyze feedback and generate learning update
        const analyzer = new LearningAnalyzer(pm);
        const learningUpdate = analyzer.analyze(projectId);

        const audit = getAuditLogger();
        audit?.log({
          eventType: 'learning_analyzed',
          projectId,
          details: {
            updateId: learningUpdate.update_id,
            successRate: learningUpdate.success_rate,
            patterns: learningUpdate.observed_failure_patterns?.length ?? 0,
            adjustments: learningUpdate.parameter_adjustments?.length ?? 0,
          },
        });

        // Generate new plan based on learnings
        const replanner = new Replanner(pm);
        const replanResult = replanner.replan(projectId, learningUpdate.update_id);

        audit?.log({
          eventType: 'replan_created',
          projectId,
          details: {
            newPlanId: replanResult.newPlanId,
            newVersion: replanResult.newVersion,
            previousPlanId: replanResult.previousPlanId,
            changesApplied: replanResult.changesApplied,
          },
        });

        logger.info({ projectId, newPlanId: replanResult.newPlanId, version: replanResult.newVersion }, 'Replan completed via IPC');
        return {
          success: true,
          data: {
            planId: replanResult.newPlanId,
            version: replanResult.newVersion,
            previousPlanId: replanResult.previousPlanId,
            changesApplied: replanResult.changesApplied,
            learningUpdateId: learningUpdate.update_id,
          },
        };
      }

      // --- Toolkit system IPC handlers ---

      case 'science:execute_plan': {
        const projectId = data.projectId as string;
        const planId = data.planId as string;
        if (!projectId || !planId) {
          return { success: false, error: 'Missing projectId or planId' };
        }

        const dispatcher = getExecutionDispatcher();
        if (!dispatcher) {
          // Fallback: no dispatcher configured, return accepted stub
          logger.info({ projectId, planId }, 'Plan execution requested via IPC (no dispatcher)');
          return { success: true, data: { projectId, planId, status: 'accepted' } };
        }

        const { executionId } = dispatcher.dispatch(projectId, planId);
        logger.info({ projectId, planId, executionId }, 'Plan execution dispatched via IPC');
        return { success: true, data: { projectId, planId, executionId, status: 'dispatched' } };
      }

      case 'science:get_plan_status': {
        const planId = data.planId as string;
        if (!planId) {
          return { success: false, error: 'Missing planId' };
        }
        const planRecord = pm.getPlan(planId);
        if (!planRecord) {
          return { success: false, error: `Plan not found: ${planId}` };
        }
        const artifacts = pm.getArtifacts(planRecord.project_id);
        const planArtifacts = artifacts.filter((a) => a.plan_id === planId);
        return {
          success: true,
          data: {
            planId,
            status: planRecord.status,
            operations: planArtifacts.map((a) => ({
              op_id: a.op_id,
              status: a.status,
              artifact_id: a.id,
            })),
          },
        };
      }

      case 'science:list_toolkits': {
        // Toolkit manifests are loaded externally — this handler returns a placeholder.
        // The actual toolkit data is injected via setToolkitData().
        const toolkitData = getToolkitData();
        return { success: true, data: toolkitData };
      }

      case 'science:get_toolkit_operations': {
        const toolkitId = data.toolkitId as string;
        if (!toolkitId) {
          return { success: false, error: 'Missing toolkitId' };
        }
        const allToolkits = getToolkitData() as Array<Record<string, unknown>>;
        const toolkit = allToolkits.find((t) => t.toolkit_id === toolkitId);
        if (!toolkit) {
          return { success: false, error: `Toolkit not found: ${toolkitId}` };
        }
        return { success: true, data: toolkit };
      }

      default:
        return { success: false, error: `Unknown science IPC type: ${data.type}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, type: data.type }, 'Science IPC error');
    return { success: false, error: message };
  }
}

// Toolkit data injected from the main orchestrator after loading manifests
let _toolkitData: unknown[] = [];

export function setToolkitData(data: unknown[]): void {
  _toolkitData = data;
}

function getToolkitData(): unknown[] {
  return _toolkitData;
}

// --- Execution dispatcher & audit logger singletons ---

let _executionDispatcher: ExecutionDispatcher | null = null;
let _auditLogger: AuditLogger | null = null;

export function setExecutionDispatcher(dispatcher: ExecutionDispatcher): void {
  _executionDispatcher = dispatcher;
}

function getExecutionDispatcher(): ExecutionDispatcher | null {
  return _executionDispatcher;
}

export function setAuditLogger(auditLogger: AuditLogger): void {
  _auditLogger = auditLogger;
}

function getAuditLogger(): AuditLogger | null {
  return _auditLogger;
}

/** @internal - for tests only. Reset all singletons. */
export function _resetIpcSingletons(): void {
  _executionDispatcher = null;
  _auditLogger = null;
}
