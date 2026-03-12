// Auto-generated from JSON Schema. Do not edit manually.
// Source: schemas/evidence-record.schema.json
// Run `pnpm codegen` from packages/contracts to regenerate.

import { z } from "zod";

export const EvidenceRecordSchema = z.object({
  evidence_id: z.string(),
  candidate_id: z.string(),
  project_id: z.string().optional(),
  claim: z.string(),
  evidence_type: z.enum(["evidence_backed", "hypothesis_only"]).optional(),
  evidence_source: z.enum(["structure_qc", "developability", "binding_prediction", "experimental", "expert_judgment", "literature", "custom"]),
  raw_metrics: z.record(z.string(), z.any()).optional(),
  confidence: z.number().min(0).max(1),
  reason_text: z.string().optional(),
  linked_artifacts: z.array(z.string()).optional(),
  pass: z.boolean().nullable().optional(),
  created_at: z.string().optional(),
});

export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
