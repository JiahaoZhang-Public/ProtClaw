// Auto-generated from JSON Schema. Do not edit manually.
// Source: schemas/candidate-card.schema.json
// Run `pnpm codegen` from packages/contracts to regenerate.

import { z } from "zod";

export const CandidateCardSchema = z.object({
  candidate_id: z.string(),
  project_id: z.string(),
  sequence: z.string(),
  structure_refs: z.array(z.string()).optional(),
  design_lineage: z.object({
    backbone_artifact_id: z.string().optional(),
    sequence_artifact_id: z.string().optional(),
    structure_artifact_id: z.string().optional(),
    parent_candidate_id: z.string().optional(),
  }).optional(),
  scores: z.object({
    plddt: z.number().optional(),
    ptm: z.number().optional(),
    rmsd_to_design: z.number().optional(),
    sequence_recovery: z.number().optional(),
    binding_energy: z.number().optional(),
    solubility_score: z.number().optional(),
    aggregation_score: z.number().optional(),
    tm_predicted_celsius: z.number().optional(),
    composite_score: z.number().optional(),
  }).optional(),
  constraint_satisfaction_summary: z.array(z.object({
    constraint: z.string(),
    satisfied: z.boolean(),
    details: z.string().optional(),
  })).optional(),
  key_mutation_or_motif_rationale: z.string().optional(),
  risk_flags: z.array(z.string()).optional(),
  diversity_cluster: z.string().optional(),
  recommended_assays: z.array(z.string()).optional(),
  recommended_controls: z.array(z.string()).optional(),
  evidence_summary: z.array(z.string()).optional(),
  rank: z.number().int().optional(),
  status: z.enum(["active", "selected", "discarded", "experimental"]),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type CandidateCard = z.infer<typeof CandidateCardSchema>;
