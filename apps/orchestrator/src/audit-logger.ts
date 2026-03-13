import fs from 'node:fs';
import path from 'node:path';

export interface AuditEntry {
  timestamp: string;
  eventType:
    | 'plan_executed'
    | 'plan_completed'
    | 'plan_failed'
    | 'feedback_ingested'
    | 'learning_analyzed'
    | 'replan_created'
    | 'command_received';
  projectId: string;
  details: Record<string, unknown>;
}

/**
 * Append-only JSONL audit logger for reproducibility.
 * Writes one file per project: {logDir}/{projectId}/audit.jsonl
 */
export class AuditLogger {
  constructor(private logDir: string) {}

  log(entry: Omit<AuditEntry, 'timestamp'>): void {
    const full: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    const projectDir = path.join(this.logDir, entry.projectId);
    fs.mkdirSync(projectDir, { recursive: true });

    const logFile = path.join(projectDir, 'audit.jsonl');
    fs.appendFileSync(logFile, JSON.stringify(full) + '\n');
  }

  getEntries(projectId: string): AuditEntry[] {
    const logFile = path.join(this.logDir, projectId, 'audit.jsonl');
    if (!fs.existsSync(logFile)) return [];

    const content = fs.readFileSync(logFile, 'utf-8').trim();
    if (!content) return [];

    return content.split('\n').map((line) => JSON.parse(line) as AuditEntry);
  }
}
