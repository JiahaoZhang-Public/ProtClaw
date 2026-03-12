// Auto-generated from JSON Schema. Do not edit manually.
// Source: schemas/tool-result.schema.json
// Run `pnpm codegen` from packages/contracts to regenerate.

import { z } from "zod";

export const ToolResultSchema = z.object({
  status: z.enum(["success", "failed", "partial"]),
  tool_name: z.string(),
  tool_version: z.string(),
  output_files: z.array(z.object({
    path: z.string(),
    type: z.string(),
    size_bytes: z.number().int().optional(),
    checksum_sha256: z.string().optional(),
  })).optional().default([]),
  metrics: z.record(z.string(), z.any()).optional(),
  errors: z.array(z.string()).optional().default([]),
  warnings: z.array(z.string()).optional().default([]),
  provenance: z.object({
    image_digest: z.string().optional(),
    model_checkpoint: z.string().optional(),
    random_seed: z.number().int().optional(),
    started_at: z.string().optional(),
    completed_at: z.string().optional(),
    duration_seconds: z.number().optional(),
  }).optional(),
  cache_key: z.string().optional(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;
