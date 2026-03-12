/**
 * Candidate Card Builder for ProtClaw
 *
 * After a pipeline completes, collects scores from tool results and builds
 * CandidateCard objects with design lineage and composite metrics.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CandidateCard } from '@protclaw/contracts';
import type { ProjectManager } from './project-manager.js';
import type { PlanExecutionResult } from './plan-executor.js';

export interface CardBuilderConfig {
  projectManager: ProjectManager;
}

/**
 * Reads tool result JSON files from completed operations and assembles
 * CandidateCard objects with scores and design lineage.
 */
export class CandidateCardBuilder {
  private pm: ProjectManager;

  constructor(config: CardBuilderConfig) {
    this.pm = config.projectManager;
  }

  /**
   * Build CandidateCards from a completed plan execution.
   *
   * Reads result.json files from each operation's output directory to extract
   * metrics, then combines them into scored CandidateCards with design lineage.
   */
  buildCards(
    projectId: string,
    planId: string,
    result: PlanExecutionResult,
    projectDir: string,
  ): CandidateCard[] {
    if (result.status === 'failed') return [];

    // Read metrics from each completed operation's result.json
    const opMetrics = new Map<string, Record<string, unknown>>();
    for (const opId of result.completedOps) {
      const resultPath = path.join(
        projectDir, projectId, 'runs', planId, opId, 'output', 'result.json',
      );
      if (fs.existsSync(resultPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
          opMetrics.set(opId, data.metrics ?? {});
        } catch {
          // Skip unreadable result files
        }
      }
    }

    // Find the op IDs for each pipeline stage (by toolkit_op mapping in artifacts)
    const opByType = this.mapOpsByToolkitOp(result);

    // Extract scores from each stage
    const scores: CandidateCard['scores'] = {};

    // structure_predict → pLDDT, pTM
    const predOpId = opByType.get('structure_predict');
    if (predOpId) {
      const m = opMetrics.get(predOpId);
      if (m) {
        if (typeof m.avg_plddt === 'number') scores.plddt = m.avg_plddt;
        if (typeof m.avg_ptm === 'number') scores.ptm = m.avg_ptm;
      }
    }

    // structure_qc → RMSD
    const qcOpId = opByType.get('structure_qc');
    if (qcOpId) {
      const m = opMetrics.get(qcOpId);
      if (m) {
        if (typeof m.rmsd_angstrom === 'number') scores.rmsd_to_design = m.rmsd_angstrom;
      }
    }

    // developability_check → aggregation, solubility
    const devOpId = opByType.get('developability_check');
    if (devOpId) {
      const m = opMetrics.get(devOpId);
      if (m) {
        if (typeof m.aggregation_propensity === 'number') scores.aggregation_score = m.aggregation_propensity;
        if (typeof m.mean_hydrophobicity === 'number') scores.solubility_score = -m.mean_hydrophobicity;
      }
    }

    // candidate_rank → rank
    const rankOpId = opByType.get('candidate_rank');
    let rank: number | undefined;
    if (rankOpId) {
      const m = opMetrics.get(rankOpId);
      if (m && typeof m.num_fronts === 'number') {
        rank = 1; // top candidate from the pipeline
      }
    }

    // Build design lineage from artifact IDs
    const lineage: CandidateCard['design_lineage'] = {};
    const bbOpId = opByType.get('backbone_generate');
    if (bbOpId && result.artifacts[bbOpId]) lineage.backbone_artifact_id = result.artifacts[bbOpId];
    const seqOpId = opByType.get('sequence_design');
    if (seqOpId && result.artifacts[seqOpId]) lineage.sequence_artifact_id = result.artifacts[seqOpId];
    if (predOpId && result.artifacts[predOpId]) lineage.structure_artifact_id = result.artifacts[predOpId];

    // Extract sequence (read from sequence_design output if available)
    let sequence = 'UNKNOWN';
    if (seqOpId) {
      const seqOutputDir = path.join(
        projectDir, projectId, 'runs', planId, seqOpId, 'output', 'files',
      );
      if (fs.existsSync(seqOutputDir)) {
        const fastaFiles = fs.readdirSync(seqOutputDir).filter(
          (f) => f.endsWith('.fasta') || f.endsWith('.fa'),
        );
        if (fastaFiles.length > 0) {
          const fastaContent = fs.readFileSync(path.join(seqOutputDir, fastaFiles[0]), 'utf-8');
          const seqLine = fastaContent.split('\n').find((l) => !l.startsWith('>') && l.trim());
          if (seqLine) sequence = seqLine.trim();
        }
      }
    }

    const candidateId = `cand-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    const card: CandidateCard = {
      candidate_id: candidateId,
      project_id: projectId,
      sequence,
      status: 'active',
      scores: Object.keys(scores).length > 0 ? scores : undefined,
      design_lineage: Object.keys(lineage).length > 0 ? lineage : undefined,
      rank,
      created_at: now,
      updated_at: now,
    };

    // Persist candidate
    this.pm.createCandidate({
      id: candidateId,
      project_id: projectId,
      sequence,
      status: 'active',
      rank: rank ?? null,
      card,
    });

    return [card];
  }

  /**
   * Map toolkit operation names to their op IDs from the execution result.
   * Uses the artifact type (which is set to toolkitOp) from recorded artifacts.
   */
  private mapOpsByToolkitOp(result: PlanExecutionResult): Map<string, string> {
    const map = new Map<string, string>();
    // The PlanExecutionResult.artifacts maps opId → artifactId.
    // We need the reverse: toolkitOp → opId. Since we don't have the graph here,
    // we use the opToolkitOps map if available, otherwise use conventions.
    if (result.opToolkitOps) {
      for (const [opId, toolkitOp] of Object.entries(result.opToolkitOps)) {
        map.set(toolkitOp, opId);
      }
    }
    return map;
  }
}
