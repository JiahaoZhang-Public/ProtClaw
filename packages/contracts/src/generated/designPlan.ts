// Auto-generated from JSON Schema. Do not edit manually.
// Source: schemas/design-plan.schema.json
// Run `pnpm codegen` from packages/contracts to regenerate.

import { z } from "zod";

export const DesignPlanSchema = z.object({
  plan_id: z.string(),
  project_id: z.string(),
  version: z.number().int().min(1),
  status: z.enum(["pending", "executing", "completed", "failed", "superseded"]),
  selected_toolkits: z.array(z.string()).min(1),
  operations: z.array(z.object({
    op_id: z.string(),
    toolkit_op: z.string(),
    tool_override: z.string().optional(),
    params: z.record(z.string(), z.any()),
    depends_on: z.array(z.string()).optional().default([]),
    parallel_group: z.string().optional(),
    cost_tier: z.enum(["fast", "balanced", "accurate"]).optional(),
  })),
  parallelism_policy: z.object({
    max_parallel_ops: z.number().int().optional().default(4),
    max_parallel_candidates: z.number().int().optional().default(10),
  }).optional(),
  stop_conditions: z.array(z.string()).optional(),
  fallback_policies: z.array(z.object({
    trigger: z.string(),
    action: z.enum(["retry", "skip", "substitute", "abort"]),
    substitute_tool: z.string().optional(),
  })).optional(),
  acceptance_rules: z.array(z.string()).optional(),
  created_at: z.string().optional(),
});

export type DesignPlan = z.infer<typeof DesignPlanSchema>;
