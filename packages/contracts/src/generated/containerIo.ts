// Auto-generated from JSON Schema. Do not edit manually.
// Source: schemas/container-io.schema.json
// Run `pnpm codegen` from packages/contracts to regenerate.

import { z } from "zod";

export const ScienceContainerInputSchema = z.object({
  run_id: z.string(),
  project_id: z.string().optional(),
  plan_id: z.string().optional(),
  op_id: z.string().optional(),
  candidate_id: z.string().optional(),
  tool_name: z.string(),
  adapter_module: z.string(),
  params: z.record(z.string(), z.any()),
  input_files: z.array(z.object({
    source_path: z.string(),
    mount_path: z.string(),
  })).optional(),
  cache_key: z.string().optional(),
  timeout_seconds: z.number().int().optional().default(3600),
});
export type ScienceContainerInput = z.infer<typeof ScienceContainerInputSchema>;

export const ScienceContainerOutputSchema = z.object({
  run_id: z.string(),
  status: z.enum(["success", "failed", "timeout", "cancelled"]),
  result: z.record(z.string(), z.any()).optional(),
  exit_code: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  duration_seconds: z.number().optional(),
});
export type ScienceContainerOutput = z.infer<typeof ScienceContainerOutputSchema>;

