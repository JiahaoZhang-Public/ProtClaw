// Auto-generated from JSON Schema. Do not edit manually.
// Source: schemas/toolkit-manifest.schema.json
// Run `pnpm codegen` from packages/contracts to regenerate.

import { z } from "zod";

export const ToolkitManifestSchema = z.object({
  toolkit_id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  supported_task_types: z.array(z.string()).optional(),
  operations: z.record(z.string(), z.object({
    tool: z.string(),
    description: z.string(),
    docker_image: z.string().optional(),
    gpu_required: z.boolean().optional().default(false),
    depends_on: z.array(z.string()).optional(),
    inputs: z.record(z.string(), z.object({
      type: z.string().optional(),
      format: z.string().optional(),
      description: z.string().optional(),
      required: z.boolean().optional(),
      default: z.any().optional(),
    })),
    outputs: z.record(z.string(), z.object({
      type: z.string().optional(),
      format: z.string().optional(),
      description: z.string().optional(),
    })),
    planner_hints: z.object({
      typical_runtime: z.string().optional(),
      cost_tier: z.enum(["fast", "balanced", "accurate"]).optional(),
      description: z.string().optional(),
    }).optional(),
    cost_profile: z.object({
      gpu_minutes_estimate: z.number().optional(),
      cpu_minutes_estimate: z.number().optional(),
      memory_gb: z.number().optional(),
    }).optional(),
    runtime_requirements: z.object({
      image: z.string().optional(),
      image_digest: z.string().optional(),
      entrypoint: z.string().optional(),
      required_env: z.array(z.string()).optional(),
      hardware_profile: z.enum(["cpu", "gpu_small", "gpu_large"]).optional(),
      mount_policy: z.enum(["read_only", "read_write"]).optional(),
      cache_namespace: z.string().optional(),
      network_policy: z.enum(["none", "limited", "full"]).optional(),
      checkpoint_refs: z.array(z.string()).optional(),
    }).optional(),
    evidence_types: z.array(z.string()).optional(),
    cache_key_fields: z.array(z.string()).optional(),
    failure_modes: z.array(z.object({
      mode: z.string().optional(),
      description: z.string().optional(),
      severity: z.enum(["warning", "error", "fatal"]).optional(),
      suggested_action: z.string().optional(),
    })).optional(),
  })),
});

export type ToolkitManifest = z.infer<typeof ToolkitManifestSchema>;
