import crypto from 'node:crypto';

import { LearningUpdateSchema, type LearningUpdate } from '@protclaw/contracts';
import type { ExperimentFeedback } from '@protclaw/contracts';
import type { ProjectManager } from './project-manager.js';

/** Maps assay failure types to pipeline parameter adjustment suggestions. */
const ADJUSTMENT_RULES: Record<string, { operation: string; parameter: string; modifier: (old: number) => number; rationale: string }> = {
  expression_titer: {
    operation: 'sequence_design',
    parameter: 'temperature',
    modifier: (old) => Math.max(0.01, old - 0.05),
    rationale: 'Lower sampling temperature for more conservative sequences',
  },
  DSF: {
    operation: 'structure_predict',
    parameter: 'num_recycles',
    modifier: (old) => old + 3,
    rationale: 'More recycles for better structure prediction confidence',
  },
  thermal_stability: {
    operation: 'structure_predict',
    parameter: 'num_recycles',
    modifier: (old) => old + 3,
    rationale: 'More recycles for better structure prediction confidence',
  },
  aggregation: {
    operation: 'developability_check',
    parameter: 'aggregation_threshold',
    modifier: (old) => old * 0.8,
    rationale: 'Tighter aggregation threshold based on experimental data',
  },
};

const DEFAULT_ADJUSTMENT = {
  operation: 'backbone_generate',
  parameter: 'num_designs',
  modifier: (old: number) => old * 2,
  rationale: 'Increase design diversity to explore more sequence space',
};

/** Hypothesis templates per assay type. */
const HYPOTHESES: Record<string, string> = {
  expression_titer: 'Low expression may indicate poor folding or aggregation',
  SPR: 'Binding affinity below threshold',
  DSF: 'Low thermal stability suggests structural instability',
  thermal_stability: 'Low thermal stability suggests structural instability',
  aggregation: 'Aggregation propensity too high for manufacturing',
};

export class LearningAnalyzer {
  constructor(private pm: ProjectManager) {}

  /**
   * Analyze all feedback for a project (optionally limited to specific feedback IDs).
   * Returns a validated LearningUpdate, persisted via ProjectManager.
   */
  analyze(projectId: string, feedbackIds?: string[]): LearningUpdate {
    // Gather feedback
    const allFeedback = this.pm.getFeedback(projectId);
    const feedbackEntries = feedbackIds
      ? allFeedback.filter((f) => feedbackIds.includes(f.id))
      : allFeedback;

    const feedbackData = feedbackEntries.map((f) => f.feedback as ExperimentFeedback);
    const feedbackRefIds = feedbackEntries.map((f) => f.id);

    // Group by assay_type
    const byAssay = new Map<string, ExperimentFeedback[]>();
    for (const fb of feedbackData) {
      const group = byAssay.get(fb.assay_type) || [];
      group.push(fb);
      byAssay.set(fb.assay_type, group);
    }

    // Compute success rate
    const passCount = feedbackData.filter((fb) => fb.pass_fail === 'pass').length;
    const failCount = feedbackData.filter((fb) => fb.pass_fail === 'fail').length;
    const totalJudged = passCount + failCount;
    const successRate = totalJudged > 0 ? passCount / totalJudged : undefined;

    // Detect failure patterns
    const failurePatterns: LearningUpdate['observed_failure_patterns'] = [];
    for (const [assayType, entries] of byAssay) {
      const fails = entries.filter((e) => e.pass_fail === 'fail').length;
      const rate = entries.length > 0 ? fails / entries.length : 0;
      if (rate > 0.5) {
        failurePatterns.push({
          pattern: `High failure rate in ${assayType}`,
          frequency: rate,
          affected_candidates: [...new Set(entries.filter((e) => e.pass_fail === 'fail').map((e) => e.candidate_id))],
          hypothesis: HYPOTHESES[assayType] || `Failures in ${assayType} assay exceed threshold`,
        });
      }
    }

    // Get latest plan for old parameter values
    const latestPlan = this.pm.getLatestPlan(projectId);
    const planOps = (latestPlan?.plan as { operations?: Array<{ toolkit_op: string; params: Record<string, number> }> })?.operations || [];

    // Suggest parameter adjustments based on failure patterns
    const parameterAdjustments: NonNullable<LearningUpdate['parameter_adjustments']> = [];
    const adjustedOps = new Set<string>();

    for (const pattern of failurePatterns) {
      // Extract assay type from pattern text
      const assayMatch = pattern.pattern.match(/High failure rate in (.+)/);
      const assayType = assayMatch?.[1] || '';
      const rule = ADJUSTMENT_RULES[assayType] || DEFAULT_ADJUSTMENT;

      // Avoid duplicate adjustments for the same operation+parameter
      const adjKey = `${rule.operation}:${rule.parameter}`;
      if (adjustedOps.has(adjKey)) continue;
      adjustedOps.add(adjKey);

      const matchingOp = planOps.find((op) => op.toolkit_op === rule.operation);
      const oldValue = matchingOp?.params?.[rule.parameter] ?? 1;
      const newValue = rule.modifier(typeof oldValue === 'number' ? oldValue : 1);

      parameterAdjustments.push({
        operation: rule.operation,
        parameter: rule.parameter,
        old_value: oldValue,
        new_value: newValue,
        rationale: rule.rationale,
      });
    }

    // New constraints for 100% failure assay types
    const newConstraints: string[] = [];
    for (const [assayType, entries] of byAssay) {
      const allFail = entries.every((e) => e.pass_fail === 'fail');
      if (allFail && entries.length > 0) {
        newConstraints.push(`Must improve ${assayType} performance`);
      }
    }

    // Build the LearningUpdate
    const updateId = `lu-${crypto.randomUUID().slice(0, 8)}`;
    const update = LearningUpdateSchema.parse({
      update_id: updateId,
      project_id: projectId,
      source_feedback_refs: feedbackRefIds.length > 0 ? feedbackRefIds : ['none'],
      observed_failure_patterns: failurePatterns.length > 0 ? failurePatterns : undefined,
      new_constraints: newConstraints.length > 0 ? newConstraints : undefined,
      parameter_adjustments: parameterAdjustments.length > 0 ? parameterAdjustments : undefined,
      success_rate: successRate,
      created_at: new Date().toISOString(),
    });

    // Persist
    this.pm.recordLearningUpdate({
      id: updateId,
      project_id: projectId,
      source_feedback_refs: feedbackRefIds,
      update_data: update,
    });

    return update;
  }
}
