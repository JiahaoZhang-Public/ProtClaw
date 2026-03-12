// Auto-generated from JSON Schema. Do not edit manually.
// Source: schemas/project-spec.schema.json
// Run `pnpm codegen` from packages/contracts to regenerate.

import { z } from "zod";

export const ProjectSpecSchema = z.object({
  project_id: z.string(),
  name: z.string(),
  scientific_objective: z.string(),
  task_type: z.enum(["de_novo_design", "binder_design", "optimization", "stabilization", "humanization"]),
  input_assets: z.array(z.object({
    asset_type: z.enum(["pdb", "fasta", "csv", "json", "sdf"]),
    path: z.string(),
    description: z.string().optional(),
  })).optional().default([]),
  hard_constraints: z.array(z.string()).optional().default([]),
  soft_preferences: z.array(z.string()).optional().default([]),
  target_properties: z.object({
    binding_target: z.string().optional(),
    affinity_threshold_nM: z.number().optional(),
    stability_requirements: z.object({
      tm_min_celsius: z.number().optional(),
      aggregation_score_max: z.number().optional(),
    }).optional(),
    expression_host: z.enum(["e_coli", "cho", "yeast", "hek293", "insect", "cell_free"]).optional(),
    size_range: z.object({
      min_residues: z.number().int().optional(),
      max_residues: z.number().int().optional(),
    }).optional(),
  }).optional(),
  budget: z.object({
    max_compute_hours: z.number().optional(),
    max_candidates: z.number().int().optional(),
    cost_tier: z.enum(["fast", "balanced", "accurate"]).optional().default("balanced"),
  }).optional(),
  timeline: z.object({
    deadline: z.string().optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  }).optional(),
  allowed_methods: z.array(z.string()).optional(),
  forbidden_methods: z.array(z.string()).optional(),
  success_criteria: z.array(z.string()).min(1),
  output_expectations: z.object({
    min_candidates: z.number().int().optional().default(5),
    diversity_required: z.boolean().optional().default(true),
    include_controls: z.boolean().optional().default(true),
    output_formats: z.array(z.enum(["candidate_cards", "order_sheet", "report"])).optional(),
  }).optional(),
  dbtl_config: z.object({
    max_cycles: z.number().int().optional().default(1),
    auto_replan: z.boolean().optional().default(false),
  }).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type ProjectSpec = z.infer<typeof ProjectSpecSchema>;
