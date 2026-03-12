// Auto-generated from JSON Schema. Do not edit manually.
// Source: schemas/run-artifact.schema.json
// Run `pnpm codegen` from packages/contracts to regenerate.

import { z } from "zod";

export const RunArtifactSchema = z.object({
  artifact_id: z.string(),
  project_id: z.string(),
  plan_id: z.string().optional(),
  op_id: z.string().optional(),
  candidate_id: z.string().optional(),
  artifact_type: z.enum(["backbone", "sequence", "structure", "qc_report", "developability_report", "cluster_result", "ranking_result", "experiment_package", "custom"]),
  producer: z.string(),
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled", "resumable"]),
  inputs_hash: z.string().optional(),
  params_hash: z.string().optional(),
  files: z.array(z.object({
    path: z.string(),
    type: z.enum(["pdb", "fasta", "csv", "json", "html", "log", "other"]),
    size_bytes: z.number().int().optional(),
    checksum: z.string().optional(),
  })).optional(),
  metrics: z.record(z.string(), z.any()).optional(),
  upstream_refs: z.array(z.string()).optional(),
  provenance: z.object({
    tool_name: z.string(),
    tool_version: z.string(),
    image_digest: z.string().optional(),
    model_checkpoint: z.string().optional(),
    runtime_profile: z.enum(["cpu", "gpu_small", "gpu_large"]).optional(),
    params_hash: z.string().optional(),
    random_seed: z.number().int().optional(),
    host_id: z.string().optional(),
    started_at: z.string().optional(),
    completed_at: z.string().optional(),
    duration_seconds: z.number().optional(),
  }).optional(),
  cache_key: z.string().optional(),
  cache_hit: z.boolean().optional().default(false),
  error_message: z.string().optional(),
  created_at: z.string().optional(),
});

export type RunArtifact = z.infer<typeof RunArtifactSchema>;
