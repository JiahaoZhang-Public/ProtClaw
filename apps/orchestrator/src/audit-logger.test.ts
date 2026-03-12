import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuditLogger } from './audit-logger.js';

let tmpDir: string;
let logger: AuditLogger;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  logger = new AuditLogger(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AuditLogger', () => {
  it('logs and reads entries for a project', () => {
    logger.log({ eventType: 'plan_executed', projectId: 'proj-1', details: { planId: 'p1' } });
    logger.log({ eventType: 'plan_completed', projectId: 'proj-1', details: { planId: 'p1', ops: 8 } });

    const entries = logger.getEntries('proj-1');
    expect(entries).toHaveLength(2);
    expect(entries[0].eventType).toBe('plan_executed');
    expect(entries[0].timestamp).toBeDefined();
    expect(entries[1].eventType).toBe('plan_completed');
    expect(entries[1].details.ops).toBe(8);
  });

  it('isolates entries by project', () => {
    logger.log({ eventType: 'plan_executed', projectId: 'proj-a', details: {} });
    logger.log({ eventType: 'plan_executed', projectId: 'proj-b', details: {} });

    expect(logger.getEntries('proj-a')).toHaveLength(1);
    expect(logger.getEntries('proj-b')).toHaveLength(1);
  });

  it('returns empty array for unknown project', () => {
    expect(logger.getEntries('nonexistent')).toEqual([]);
  });

  it('handles concurrent writes to same project', () => {
    for (let i = 0; i < 10; i++) {
      logger.log({ eventType: 'command_received', projectId: 'proj-c', details: { seq: i } });
    }

    const entries = logger.getEntries('proj-c');
    expect(entries).toHaveLength(10);
    expect(entries.map((e) => (e.details as { seq: number }).seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
