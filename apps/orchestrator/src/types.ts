export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- ProtClaw domain types ---

export interface ProjectRecord {
  id: string;
  name: string;
  spec: object;
  status: 'active' | 'completed' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface DesignPlanRecord {
  id: string;
  project_id: string;
  version: number;
  status: 'draft' | 'active' | 'completed' | 'superseded';
  plan: object;
  created_at: string;
}

export interface RunArtifactRecord {
  id: string;
  project_id: string;
  plan_id: string;
  op_id: string;
  candidate_id: string;
  artifact_type: string;
  producer: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  artifact: object;
  cache_key: string;
  created_at: string;
}

export interface EvidenceRecordEntry {
  id: string;
  candidate_id: string;
  project_id: string;
  record: object;
  created_at: string;
}

export interface CandidateRecord {
  id: string;
  project_id: string;
  sequence: string;
  status: 'draft' | 'active' | 'promoted' | 'rejected' | 'archived';
  rank: number | null;
  card: object;
  created_at: string;
  updated_at: string;
}

export interface FeedbackRecord {
  id: string;
  project_id: string;
  candidate_id: string;
  feedback: object;
  created_at: string;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
