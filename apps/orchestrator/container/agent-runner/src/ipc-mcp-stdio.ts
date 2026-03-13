/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const SCIENCE_DIR = path.join(IPC_DIR, 'science');
const SCIENCE_RESPONSES_DIR = path.join(IPC_DIR, 'science-responses');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// --- ProtClaw Science Tools ---

function writeScienceIpcFile(data: object): string {
  return writeIpcFile(SCIENCE_DIR, data);
}

function waitForScienceResponse(filename: string, timeoutMs: number = 10000): object | null {
  const responseFile = path.join(SCIENCE_RESPONSES_DIR, filename);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(responseFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
        fs.unlinkSync(responseFile);
        return data;
      } catch {
        return null;
      }
    }
    // Busy-wait with small delay (synchronous polling in container context)
    const waitUntil = Date.now() + 100;
    while (Date.now() < waitUntil) { /* spin */ }
  }
  return null;
}

server.tool(
  'create_project',
  'Create a new protein design project with a name and specification.',
  {
    id: z.string().describe('Unique project identifier'),
    name: z.string().describe('Human-readable project name'),
    spec: z.string().describe('JSON string of the project specification'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:create_project',
      project: { id: args.id, name: args.name, spec: JSON.parse(args.spec) },
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : `Project creation request submitted (${args.id})` }] };
  },
);

server.tool(
  'get_project',
  'Get project details by ID.',
  {
    project_id: z.string().describe('The project ID to retrieve'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:get_project',
      projectId: args.project_id,
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : 'No response received' }] };
  },
);

server.tool(
  'update_project',
  'Update project properties (name, spec, status).',
  {
    project_id: z.string().describe('The project ID to update'),
    name: z.string().optional().describe('New project name'),
    spec: z.string().optional().describe('New project specification (JSON string)'),
    status: z.enum(['active', 'completed', 'archived']).optional().describe('New project status'),
  },
  async (args) => {
    const updates: Record<string, unknown> = {};
    if (args.name) updates.name = args.name;
    if (args.spec) updates.spec = JSON.parse(args.spec);
    if (args.status) updates.status = args.status;

    const filename = writeScienceIpcFile({
      type: 'science:update_project',
      projectId: args.project_id,
      updates,
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : 'Update request submitted' }] };
  },
);

server.tool(
  'create_plan',
  'Create a new design plan for a project.',
  {
    plan_id: z.string().describe('Unique plan identifier'),
    project_id: z.string().describe('The project this plan belongs to'),
    plan: z.string().describe('JSON string of the plan specification'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:create_plan',
      planId: args.plan_id,
      projectId: args.project_id,
      plan: JSON.parse(args.plan),
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : `Plan ${args.plan_id} creation submitted` }] };
  },
);

server.tool(
  'get_plan',
  'Get a design plan by ID, or the latest plan for a project.',
  {
    plan_id: z.string().optional().describe('Specific plan ID'),
    project_id: z.string().optional().describe('Project ID to get latest plan for'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:get_plan',
      planId: args.plan_id,
      projectId: args.project_id,
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : 'No plan found' }] };
  },
);

server.tool(
  'submit_tool_run',
  'Submit a science tool operation for execution.',
  {
    id: z.string().describe('Unique artifact/run identifier'),
    project_id: z.string().describe('Project this run belongs to'),
    plan_id: z.string().optional().describe('Plan this run is part of'),
    op_id: z.string().optional().describe('Operation identifier in the plan'),
    candidate_id: z.string().optional().describe('Candidate this run is for'),
    artifact_type: z.string().optional().describe('Type of artifact being produced'),
    producer: z.string().optional().describe('Tool/toolkit producing the artifact'),
    artifact: z.string().optional().describe('JSON string of initial artifact data'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:submit_run',
      artifact: {
        id: args.id,
        project_id: args.project_id,
        plan_id: args.plan_id || '',
        op_id: args.op_id || '',
        candidate_id: args.candidate_id || '',
        artifact_type: args.artifact_type || '',
        producer: args.producer || '',
        status: 'pending',
        artifact: args.artifact ? JSON.parse(args.artifact) : {},
      },
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : `Run ${args.id} submitted` }] };
  },
);

server.tool(
  'get_run_status',
  'Get the status of science tool run(s).',
  {
    project_id: z.string().describe('Project ID'),
    op_id: z.string().optional().describe('Filter by operation ID'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:get_status',
      projectId: args.project_id,
      opId: args.op_id,
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : 'No status available' }] };
  },
);

server.tool(
  'get_artifacts',
  'Get artifacts for a project, with optional filters.',
  {
    project_id: z.string().describe('Project ID'),
    candidate_id: z.string().optional().describe('Filter by candidate ID'),
    op_id: z.string().optional().describe('Filter by operation ID'),
    artifact_type: z.string().optional().describe('Filter by artifact type'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:get_artifacts',
      projectId: args.project_id,
      candidateId: args.candidate_id,
      opId: args.op_id,
      artifactType: args.artifact_type,
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : 'No artifacts found' }] };
  },
);

server.tool(
  'record_evidence',
  'Record an evidence assessment for a candidate.',
  {
    id: z.string().describe('Unique evidence record identifier'),
    candidate_id: z.string().optional().describe('Candidate this evidence is for'),
    project_id: z.string().optional().describe('Project ID'),
    record: z.string().describe('JSON string of the evidence record'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:record_evidence',
      evidence: {
        id: args.id,
        candidate_id: args.candidate_id || '',
        project_id: args.project_id || '',
        record: JSON.parse(args.record),
      },
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : `Evidence ${args.id} recorded` }] };
  },
);

server.tool(
  'create_candidate',
  'Register a new candidate protein design.',
  {
    id: z.string().describe('Unique candidate identifier'),
    project_id: z.string().describe('Project this candidate belongs to'),
    sequence: z.string().optional().describe('Protein sequence'),
    status: z.enum(['draft', 'active', 'promoted', 'rejected', 'archived']).optional().describe('Candidate status'),
    card: z.string().optional().describe('JSON string of candidate card/metadata'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:create_candidate',
      candidate: {
        id: args.id,
        project_id: args.project_id,
        sequence: args.sequence || '',
        status: args.status || 'draft',
        card: args.card ? JSON.parse(args.card) : {},
      },
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : `Candidate ${args.id} created` }] };
  },
);

server.tool(
  'list_candidates',
  'List candidate proteins for a project.',
  {
    project_id: z.string().describe('Project ID'),
    status: z.string().optional().describe('Filter by status'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:list_candidates',
      projectId: args.project_id,
      status: args.status,
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : 'No candidates found' }] };
  },
);

server.tool(
  'rank_candidates',
  'Trigger ranking of active candidates in a project.',
  {
    project_id: z.string().describe('Project ID'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:rank_candidates',
      projectId: args.project_id,
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : 'Ranking submitted' }] };
  },
);

server.tool(
  'submit_experiment_feedback',
  'Submit experimental feedback for a candidate.',
  {
    id: z.string().describe('Unique feedback identifier'),
    project_id: z.string().describe('Project ID'),
    candidate_id: z.string().optional().describe('Candidate this feedback is for'),
    feedback: z.string().describe('JSON string of the feedback data'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:submit_feedback',
      feedback: {
        id: args.id,
        project_id: args.project_id,
        candidate_id: args.candidate_id || '',
        feedback: JSON.parse(args.feedback),
      },
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : `Feedback ${args.id} submitted` }] };
  },
);

server.tool(
  'request_replan',
  'Request a design replan with updated constraints.',
  {
    project_id: z.string().describe('Project ID'),
    constraints: z.string().optional().describe('JSON string of updated constraints'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:request_replan',
      projectId: args.project_id,
      constraints: args.constraints ? JSON.parse(args.constraints) : {},
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : 'Replan request submitted' }] };
  },
);

// --- Toolkit system MCP tools ---

server.tool(
  'execute_plan',
  'Execute a design plan for a project. Triggers async execution of all plan operations.',
  {
    project_id: z.string().describe('Project ID'),
    plan_id: z.string().describe('Plan ID to execute'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:execute_plan',
      projectId: args.project_id,
      planId: args.plan_id,
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : `Plan ${args.plan_id} execution requested` }] };
  },
);

server.tool(
  'get_plan_execution_status',
  'Get the execution status of a design plan, including per-operation status.',
  {
    plan_id: z.string().describe('Plan ID to check'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:get_plan_status',
      planId: args.plan_id,
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : 'Status unavailable' }] };
  },
);

server.tool(
  'list_toolkits',
  'List all available toolkit manifests with their operations.',
  {},
  async () => {
    const filename = writeScienceIpcFile({
      type: 'science:list_toolkits',
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : 'No toolkits available' }] };
  },
);

server.tool(
  'get_toolkit_operations',
  'Get detailed operations for a specific toolkit.',
  {
    toolkit_id: z.string().describe('Toolkit identifier (e.g., "de-novo")'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:get_toolkit_operations',
      toolkitId: args.toolkit_id,
    });
    const result = waitForScienceResponse(filename);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : `Toolkit ${args.toolkit_id} not found` }] };
  },
);

// --- Direct skill execution tools ---

server.tool(
  'execute_skill',
  'Execute a science skill directly by name. Returns execution result with metrics and output files. Use for single-step computation (e.g., generate backbones with RFdiffusion, design sequences with ProteinMPNN, predict structure with ESMFold). The call blocks until the skill completes (may take minutes for GPU skills).',
  {
    skill_name: z.string().describe('Skill name (e.g., "rfdiffusion", "proteinmpnn", "esmfold", "structure-qc", "developability", "candidate-ops", "experiment-package")'),
    params: z.string().describe('JSON string of skill parameters (e.g., \'{"contigs": "50-50", "num_designs": 1}\')'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:execute_skill',
      skillName: args.skill_name,
      params: JSON.parse(args.params),
    });
    // GPU skills can take minutes — 10 minute timeout
    const result = waitForScienceResponse(filename, 600_000);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : `Skill ${args.skill_name} execution timed out` }] };
  },
);

server.tool(
  'run_pipeline',
  'Run a full de novo protein design pipeline (all 8 steps: RFdiffusion → ProteinMPNN → ESMFold → Structure QC → Developability → Candidate Cluster → Candidate Rank → Experiment Package). Returns aggregated results for all steps. This call blocks until the entire pipeline completes.',
  {
    toolkit: z.string().default('de-novo').describe('Toolkit name (default: "de-novo")'),
    params: z.string().optional().describe('JSON string of pipeline-level params (e.g., \'{"contigs": "50-50", "num_designs": 1}\')'),
  },
  async (args) => {
    const filename = writeScienceIpcFile({
      type: 'science:run_pipeline',
      toolkit: args.toolkit,
      params: args.params ? JSON.parse(args.params) : {},
    });
    // Full pipeline can take 30+ minutes
    const result = waitForScienceResponse(filename, 1_800_000);
    return { content: [{ type: 'text' as const, text: result ? JSON.stringify(result) : 'Pipeline execution timed out' }] };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
