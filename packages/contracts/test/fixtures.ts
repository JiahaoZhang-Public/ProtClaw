/**
 * Test fixtures for all contract schemas.
 * Each fixture is a valid instance of its corresponding contract.
 */

import type { ProjectSpec } from "../src/generated/projectSpec.js";
import type { DesignPlan } from "../src/generated/designPlan.js";
import type { ToolkitManifest } from "../src/generated/toolkitManifest.js";
import type { RunArtifact } from "../src/generated/runArtifact.js";
import type { EvidenceRecord } from "../src/generated/evidenceRecord.js";
import type { CandidateCard } from "../src/generated/candidateCard.js";
import type { ExperimentFeedback } from "../src/generated/experimentFeedback.js";
import type { LearningUpdate } from "../src/generated/learningUpdate.js";
import type { ToolResult } from "../src/generated/toolResult.js";
import type {
  ScienceContainerInput,
  ScienceContainerOutput,
} from "../src/generated/containerIo.js";

export const projectSpecFixture: ProjectSpec = {
  project_id: "proj-001",
  name: "EGFR Binder Design",
  scientific_objective:
    "Design a de novo protein binder targeting EGFR with sub-nanomolar affinity",
  task_type: "binder_design",
  input_assets: [{ asset_type: "pdb", path: "/data/egfr.pdb" }],
  hard_constraints: ["Must bind EGFR ECD", "No free cysteines"],
  soft_preferences: ["Prefer high expression in E. coli"],
  target_properties: {
    binding_target: "EGFR (1NQL)",
    affinity_threshold_nM: 1.0,
    stability_requirements: {
      tm_min_celsius: 65,
      aggregation_score_max: 0.3,
    },
    expression_host: "e_coli",
    size_range: { min_residues: 60, max_residues: 120 },
  },
  budget: {
    max_compute_hours: 48,
    max_candidates: 100,
    cost_tier: "balanced",
  },
  timeline: { priority: "high" },
  success_criteria: [
    "At least 5 candidates with pLDDT > 85",
    "Predicted binding affinity < 10 nM for top candidates",
  ],
  output_expectations: {
    min_candidates: 10,
    diversity_required: true,
    include_controls: true,
    output_formats: ["candidate_cards", "order_sheet"],
  },
  dbtl_config: { max_cycles: 2, auto_replan: true },
  created_at: "2026-01-15T10:00:00Z",
};

export const designPlanFixture: DesignPlan = {
  plan_id: "plan-001",
  project_id: "proj-001",
  version: 1,
  status: "pending",
  selected_toolkits: ["de-novo-design"],
  operations: [
    {
      op_id: "op-backbone",
      toolkit_op: "backbone_generate",
      params: { num_designs: 50, length: "80-100" },
      depends_on: [],
    },
    {
      op_id: "op-seqdesign",
      toolkit_op: "sequence_design",
      params: { num_seqs_per_backbone: 4 },
      depends_on: ["op-backbone"],
    },
    {
      op_id: "op-predict",
      toolkit_op: "structure_predict",
      params: {},
      depends_on: ["op-seqdesign"],
    },
  ],
  parallelism_policy: {
    max_parallel_ops: 4,
    max_parallel_candidates: 10,
  },
  stop_conditions: ["all_operations_complete"],
  fallback_policies: [
    {
      trigger: "structure_predict_timeout",
      action: "retry",
    },
  ],
  created_at: "2026-01-15T10:05:00Z",
};

export const toolkitManifestFixture: ToolkitManifest = {
  toolkit_id: "de-novo-design",
  name: "De Novo Protein Design",
  version: "1.0.0",
  operations: {
    backbone_generate: {
      tool: "rfdiffusion",
      description: "Generate protein backbones via RFdiffusion",
      docker_image: "protclaw/rfdiffusion:latest",
      gpu_required: true,
      inputs: {
        pdb: { type: "file", format: "pdb", description: "Target PDB for conditional generation" },
      },
      outputs: {
        pdbs: { type: "file", format: "pdb", description: "Generated backbone PDB files" },
      },
      planner_hints: {
        description: "Generate protein backbones via RFdiffusion",
        typical_runtime: "5-30 min per design",
        cost_tier: "balanced",
      },
    },
  },
};

export const runArtifactFixture: RunArtifact = {
  artifact_id: "art-001",
  project_id: "proj-001",
  plan_id: "plan-001",
  op_id: "op-backbone",
  artifact_type: "backbone",
  producer: "rfdiffusion",
  status: "succeeded",
  files: [
    {
      path: "backbone_001.pdb",
      type: "pdb",
      size_bytes: 45000,
      checksum: "sha256:abc123",
    },
  ],
  metrics: { num_designs: 50 },
  provenance: {
    tool_name: "rfdiffusion",
    tool_version: "1.1.0",
    image_digest: "sha256:def456",
    model_checkpoint: "RFdiffusion_v1.1",
    runtime_profile: "gpu_large",
    random_seed: 42,
    started_at: "2026-01-15T10:10:00Z",
    completed_at: "2026-01-15T10:40:00Z",
    duration_seconds: 1800,
  },
  cache_key: "rfdiffusion:1.1.0:sha256:def456:abc",
  cache_hit: false,
  created_at: "2026-01-15T10:40:00Z",
};

export const evidenceRecordFixture: EvidenceRecord = {
  evidence_id: "ev-001",
  candidate_id: "cand-001",
  claim: "Structure prediction shows high confidence folding",
  evidence_type: "evidence_backed",
  evidence_source: "structure_qc",
  raw_metrics: { plddt_mean: 92.3, ptm: 0.88 },
  confidence: 0.9,
  linked_artifacts: ["art-003"],
  created_at: "2026-01-15T11:00:00Z",
};

export const candidateCardFixture: CandidateCard = {
  candidate_id: "cand-001",
  project_id: "proj-001",
  sequence: "MKTLLVFLAGLLASSRAGVVEKDYGHKQFICGGSLIG",
  structure_refs: ["structures/cand-001_pred.pdb"],
  design_lineage: {
    backbone_artifact_id: "art-001",
    sequence_artifact_id: "art-002",
    structure_artifact_id: "art-003",
  },
  scores: {
    plddt: 92.3,
    ptm: 0.88,
    rmsd_to_design: 0.9,
    sequence_recovery: 0.45,
    binding_energy: -12.5,
    solubility_score: 0.85,
    tm_predicted_celsius: 72.0,
    composite_score: 0.91,
  },
  constraint_satisfaction_summary: [
    { constraint: "Must bind EGFR ECD", satisfied: true, details: "Predicted binding energy -12.5 REU" },
    { constraint: "No free cysteines", satisfied: true },
  ],
  risk_flags: ["Low pLDDT in loop region 45-52"],
  diversity_cluster: "cluster-A",
  recommended_assays: ["SPR", "SEC-MALS", "DSF"],
  recommended_controls: ["wild-type EGFR binder"],
  evidence_summary: ["ev-001"],
  rank: 1,
  status: "selected",
  created_at: "2026-01-15T12:00:00Z",
};

export const experimentFeedbackFixture: ExperimentFeedback = {
  feedback_id: "fb-001",
  project_id: "proj-001",
  candidate_id: "cand-001",
  assay_type: "SPR",
  measurement: 2.3,
  unit: "nM",
  pass_fail: "pass",
  conditions: { temperature: 25, pH: 7.4, buffer: "HBS-EP+" },
  notes: "Clean binding kinetics, no aggregation observed",
  created_at: "2026-02-01T14:00:00Z",
};

export const learningUpdateFixture: LearningUpdate = {
  update_id: "lu-001",
  project_id: "proj-001",
  source_feedback_refs: ["fb-001", "fb-002", "fb-003"],
  observed_failure_patterns: [
    {
      pattern: "Candidates with loops > 15 residues tend to aggregate",
      frequency: 0.6,
      affected_candidates: ["cand-005", "cand-008"],
      hypothesis: "Long unstructured loops cause aggregation in E. coli expression",
    },
  ],
  new_constraints: ["Loop length must be <= 12 residues"],
  new_preferences: ["Prefer designs with beta-sheet core"],
  parameter_adjustments: [
    {
      operation: "backbone_generate",
      parameter: "max_loop_length",
      old_value: 20,
      new_value: 12,
      rationale: "60% of candidates with loops > 15 residues showed aggregation",
    },
  ],
  plan_impact_summary:
    "Constrain RFdiffusion loop length and prefer beta-sheet folds in next design cycle",
  success_rate: 0.4,
  created_at: "2026-02-05T09:00:00Z",
};

export const toolResultFixture: ToolResult = {
  status: "success",
  tool_name: "rfdiffusion",
  tool_version: "1.1.0",
  output_files: [
    {
      path: "designs/backbone_001.pdb",
      type: "pdb",
      size_bytes: 45000,
      checksum_sha256: "abc123def456",
    },
  ],
  metrics: { num_designs: 50, avg_plddt: 85.2 },
  provenance: {
    image_digest: "sha256:def456",
    model_checkpoint: "RFdiffusion_v1.1",
    random_seed: 42,
    started_at: "2026-01-15T10:10:00Z",
    completed_at: "2026-01-15T10:40:00Z",
    duration_seconds: 1800,
  },
  cache_key: "rfdiffusion:1.1.0:sha256:def456:abc",
};

export const scienceContainerInputFixture: ScienceContainerInput = {
  run_id: "run-001",
  project_id: "proj-001",
  plan_id: "plan-001",
  op_id: "op-backbone",
  tool_name: "rfdiffusion",
  adapter_module: "tools.rfdiffusion.adapter",
  params: { num_designs: 50, contigs: "A1-100/0 80-100" },
  input_files: [
    { source_path: "/data/egfr.pdb", mount_path: "/workspace/input/files/target.pdb" },
  ],
  timeout_seconds: 3600,
};

export const scienceContainerOutputFixture: ScienceContainerOutput = {
  run_id: "run-001",
  status: "success",
  result: {
    status: "success",
    tool_name: "rfdiffusion",
    tool_version: "1.1.0",
  },
  exit_code: 0,
  duration_seconds: 1800,
};
