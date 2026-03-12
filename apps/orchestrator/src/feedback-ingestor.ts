import fs from 'node:fs';
import path from 'node:path';

import { ExperimentFeedbackSchema, type ExperimentFeedback } from '@protclaw/contracts';
import type { ProjectManager } from './project-manager.js';

export interface IngestionResult {
  total: number;
  accepted: number;
  rejected: number;
  errors: Array<{ row: number; message: string }>;
  candidateStatusUpdates: Array<{ candidateId: string; newStatus: string }>;
}

export class FeedbackIngestor {
  constructor(private pm: ProjectManager) {}

  /** Ingest from a JSON array of ExperimentFeedback objects. */
  ingestJson(projectId: string, records: unknown[]): IngestionResult {
    const result: IngestionResult = {
      total: records.length,
      accepted: 0,
      rejected: 0,
      errors: [],
      candidateStatusUpdates: [],
    };

    for (let i = 0; i < records.length; i++) {
      const parsed = ExperimentFeedbackSchema.safeParse(records[i]);
      if (!parsed.success) {
        result.rejected++;
        result.errors.push({
          row: i,
          message: parsed.error.issues.map((iss) => iss.message).join('; '),
        });
        continue;
      }

      const fb = parsed.data;
      this.pm.recordFeedback({
        id: fb.feedback_id,
        project_id: projectId,
        candidate_id: fb.candidate_id,
        feedback: fb,
      });
      result.accepted++;

      // Update candidate status based on pass_fail
      if (fb.pass_fail === 'fail') {
        this.pm.updateCandidate(fb.candidate_id, { status: 'rejected' });
        result.candidateStatusUpdates.push({ candidateId: fb.candidate_id, newStatus: 'rejected' });
      } else if (fb.pass_fail === 'pass') {
        this.pm.updateCandidate(fb.candidate_id, { status: 'promoted' });
        result.candidateStatusUpdates.push({ candidateId: fb.candidate_id, newStatus: 'promoted' });
      }
    }

    return result;
  }

  /** Ingest from CSV content string. Expects header row mapping to ExperimentFeedback fields. */
  ingestCsv(projectId: string, csvContent: string): IngestionResult {
    const lines = csvContent.trim().split('\n');
    if (lines.length < 2) {
      return { total: 0, accepted: 0, rejected: 0, errors: [], candidateStatusUpdates: [] };
    }

    const headers = parseCsvLine(lines[0]);
    const records: unknown[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = parseCsvLine(lines[i]);
      const obj: Record<string, unknown> = {};
      for (let j = 0; j < headers.length; j++) {
        const key = headers[j].trim();
        const val = values[j]?.trim() ?? '';
        if (key === 'measurement') {
          obj[key] = parseFloat(val);
        } else if (key === 'conditions' && val) {
          try {
            obj[key] = JSON.parse(val);
          } catch {
            obj[key] = val;
          }
        } else if (key === 'pass_fail') {
          obj[key] = val === '' ? null : val;
        } else {
          obj[key] = val;
        }
      }
      records.push(obj);
    }

    return this.ingestJson(projectId, records);
  }

  /** Ingest from a file path (auto-detect CSV vs JSON by extension). */
  ingestFile(projectId: string, filePath: string): IngestionResult {
    const content = fs.readFileSync(filePath, 'utf-8');
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.json') {
      const data = JSON.parse(content);
      const records = Array.isArray(data) ? data : [data];
      return this.ingestJson(projectId, records);
    }
    // Default to CSV for .csv or any other extension
    return this.ingestCsv(projectId, content);
  }
}

/** Simple CSV line parser that handles quoted fields. */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
