import { describe, it, expect } from "vitest";
import {
  ProjectSpecSchema,
  DesignPlanSchema,
  ToolkitManifestSchema,
  RunArtifactSchema,
  EvidenceRecordSchema,
  CandidateCardSchema,
  ExperimentFeedbackSchema,
  LearningUpdateSchema,
  ToolResultSchema,
  ScienceContainerInputSchema,
  ScienceContainerOutputSchema,
} from "../src/generated/index.js";
import {
  projectSpecFixture,
  designPlanFixture,
  toolkitManifestFixture,
  runArtifactFixture,
  evidenceRecordFixture,
  candidateCardFixture,
  experimentFeedbackFixture,
  learningUpdateFixture,
  toolResultFixture,
  scienceContainerInputFixture,
  scienceContainerOutputFixture,
} from "./fixtures.js";

describe("Contract Schema Validation", () => {
  it("validates ProjectSpec fixture", () => {
    const result = ProjectSpecSchema.safeParse(projectSpecFixture);
    expect(result.success).toBe(true);
  });

  it("validates DesignPlan fixture", () => {
    const result = DesignPlanSchema.safeParse(designPlanFixture);
    expect(result.success).toBe(true);
  });

  it("validates ToolkitManifest fixture", () => {
    const result = ToolkitManifestSchema.safeParse(toolkitManifestFixture);
    expect(result.success).toBe(true);
  });

  it("validates RunArtifact fixture", () => {
    const result = RunArtifactSchema.safeParse(runArtifactFixture);
    expect(result.success).toBe(true);
  });

  it("validates EvidenceRecord fixture", () => {
    const result = EvidenceRecordSchema.safeParse(evidenceRecordFixture);
    expect(result.success).toBe(true);
  });

  it("validates CandidateCard fixture", () => {
    const result = CandidateCardSchema.safeParse(candidateCardFixture);
    expect(result.success).toBe(true);
  });

  it("validates ExperimentFeedback fixture", () => {
    const result = ExperimentFeedbackSchema.safeParse(experimentFeedbackFixture);
    expect(result.success).toBe(true);
  });

  it("validates LearningUpdate fixture", () => {
    const result = LearningUpdateSchema.safeParse(learningUpdateFixture);
    expect(result.success).toBe(true);
  });

  it("validates ToolResult fixture", () => {
    const result = ToolResultSchema.safeParse(toolResultFixture);
    expect(result.success).toBe(true);
  });

  it("validates ScienceContainerInput fixture", () => {
    const result = ScienceContainerInputSchema.safeParse(scienceContainerInputFixture);
    expect(result.success).toBe(true);
  });

  it("validates ScienceContainerOutput fixture", () => {
    const result = ScienceContainerOutputSchema.safeParse(scienceContainerOutputFixture);
    expect(result.success).toBe(true);
  });
});

describe("Contract Schema Rejection", () => {
  it("rejects ProjectSpec without required fields", () => {
    const result = ProjectSpecSchema.safeParse({ project_id: "p1" });
    expect(result.success).toBe(false);
  });

  it("rejects ProjectSpec with invalid task_type", () => {
    const result = ProjectSpecSchema.safeParse({
      ...projectSpecFixture,
      task_type: "invalid_type",
    });
    expect(result.success).toBe(false);
  });

  it("rejects DesignPlan with version < 1", () => {
    const result = DesignPlanSchema.safeParse({
      ...designPlanFixture,
      version: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects RunArtifact with invalid status", () => {
    const result = RunArtifactSchema.safeParse({
      ...runArtifactFixture,
      status: "unknown_status",
    });
    expect(result.success).toBe(false);
  });

  it("rejects EvidenceRecord with confidence > 1", () => {
    const result = EvidenceRecordSchema.safeParse({
      ...evidenceRecordFixture,
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects CandidateCard with invalid status", () => {
    const result = CandidateCardSchema.safeParse({
      ...candidateCardFixture,
      status: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects ToolResult with invalid status", () => {
    const result = ToolResultSchema.safeParse({
      ...toolResultFixture,
      status: "unknown",
    });
    expect(result.success).toBe(false);
  });

  it("rejects LearningUpdate without source_feedback_refs", () => {
    const { source_feedback_refs, ...rest } = learningUpdateFixture;
    const result = LearningUpdateSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

describe("JSON Round-Trip", () => {
  it("ProjectSpec survives JSON serialization round-trip", () => {
    const parsed = ProjectSpecSchema.parse(projectSpecFixture);
    const json = JSON.stringify(parsed);
    const reparsed = ProjectSpecSchema.parse(JSON.parse(json));
    expect(reparsed).toEqual(parsed);
  });

  it("DesignPlan survives JSON serialization round-trip", () => {
    const parsed = DesignPlanSchema.parse(designPlanFixture);
    const json = JSON.stringify(parsed);
    const reparsed = DesignPlanSchema.parse(JSON.parse(json));
    expect(reparsed).toEqual(parsed);
  });

  it("RunArtifact survives JSON serialization round-trip", () => {
    const parsed = RunArtifactSchema.parse(runArtifactFixture);
    const json = JSON.stringify(parsed);
    const reparsed = RunArtifactSchema.parse(JSON.parse(json));
    expect(reparsed).toEqual(parsed);
  });

  it("CandidateCard survives JSON serialization round-trip", () => {
    const parsed = CandidateCardSchema.parse(candidateCardFixture);
    const json = JSON.stringify(parsed);
    const reparsed = CandidateCardSchema.parse(JSON.parse(json));
    expect(reparsed).toEqual(parsed);
  });

  it("ToolResult survives JSON serialization round-trip", () => {
    const parsed = ToolResultSchema.parse(toolResultFixture);
    const json = JSON.stringify(parsed);
    const reparsed = ToolResultSchema.parse(JSON.parse(json));
    expect(reparsed).toEqual(parsed);
  });
});

describe("Default Values", () => {
  it("DesignPlan operations get default depends_on", () => {
    const plan = DesignPlanSchema.parse({
      plan_id: "p1",
      project_id: "proj-001",
      version: 1,
      status: "pending",
      selected_toolkits: ["de-novo-design"],
      operations: [{ op_id: "op1", toolkit_op: "backbone_generate", params: {} }],
    });
    expect(plan.operations[0].depends_on).toEqual([]);
  });

  it("ToolResult gets default empty arrays", () => {
    const result = ToolResultSchema.parse({
      status: "success",
      tool_name: "test",
      tool_version: "1.0.0",
    });
    expect(result.output_files).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("RunArtifact cache_hit defaults to false", () => {
    const artifact = RunArtifactSchema.parse({
      artifact_id: "a1",
      project_id: "p1",
      artifact_type: "backbone",
      producer: "rfdiffusion",
      status: "succeeded",
    });
    expect(artifact.cache_hit).toBe(false);
  });
});
