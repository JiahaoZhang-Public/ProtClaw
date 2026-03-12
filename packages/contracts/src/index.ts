/**
 * @protclaw/contracts
 *
 * Shared domain contracts for the ProtClaw protein design agentic system.
 * JSON Schema is the source of truth; TypeScript types and Zod validators
 * are generated from schemas via codegen.
 *
 * Contracts defined here:
 * - ProjectSpec: Design campaign goals, constraints, budget
 * - DesignPlan: Ordered operations with dependency graph
 * - ToolkitManifest: Tool capabilities, Docker images, I/O schemas
 * - RunArtifact: Output of a single tool execution with provenance
 * - EvidenceRecord: Quality assessment linked to artifacts
 * - CandidateCard: Final deliverable per candidate protein
 * - ExperimentFeedback: Wet-lab results mapped to candidates
 * - LearningUpdate: Insights from experiment feedback for replanning
 * - ToolResult: Standardized tool adapter output envelope
 */

export * from "./generated/index.js";
