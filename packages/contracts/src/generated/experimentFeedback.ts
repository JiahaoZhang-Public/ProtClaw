// Auto-generated from JSON Schema. Do not edit manually.
// Source: schemas/experiment-feedback.schema.json
// Run `pnpm codegen` from packages/contracts to regenerate.

import { z } from "zod";

export const ExperimentFeedbackSchema = z.object({
  feedback_id: z.string(),
  project_id: z.string(),
  candidate_id: z.string(),
  assay_type: z.string(),
  measurement: z.number(),
  unit: z.string().optional(),
  pass_fail: z.enum(["pass", "fail"]).nullable().optional(),
  conditions: z.record(z.string(), z.any()).optional(),
  notes: z.string().optional(),
  raw_data_path: z.string().optional(),
  created_at: z.string().optional(),
});

export type ExperimentFeedback = z.infer<typeof ExperimentFeedbackSchema>;
