// Auto-generated from JSON Schema. Do not edit manually.
// Source: schemas/learning-update.schema.json
// Run `pnpm codegen` from packages/contracts to regenerate.

import { z } from "zod";

export const LearningUpdateSchema = z.object({
  update_id: z.string(),
  project_id: z.string(),
  source_feedback_refs: z.array(z.string()).min(1),
  observed_failure_patterns: z.array(z.object({
    pattern: z.string(),
    frequency: z.number(),
    affected_candidates: z.array(z.string()).optional(),
    hypothesis: z.string().optional(),
  })).optional(),
  new_constraints: z.array(z.string()).optional(),
  new_preferences: z.array(z.string()).optional(),
  parameter_adjustments: z.array(z.object({
    operation: z.string(),
    parameter: z.string(),
    old_value: z.any(),
    new_value: z.any(),
    rationale: z.string(),
  })).optional(),
  plan_impact_summary: z.string().optional(),
  success_rate: z.number().min(0).max(1).optional(),
  created_at: z.string().optional(),
});

export type LearningUpdate = z.infer<typeof LearningUpdateSchema>;
