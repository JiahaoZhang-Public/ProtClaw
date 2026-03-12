import crypto from 'node:crypto';

import type { DesignPlan, LearningUpdate } from '@protclaw/contracts';
import type { ProjectManager } from './project-manager.js';

export interface ReplanResult {
  newPlanId: string;
  newVersion: number;
  previousPlanId: string;
  changesApplied: string[];
  learningUpdateId: string;
}

export class Replanner {
  constructor(private pm: ProjectManager) {}

  /**
   * Create a new plan version based on the latest plan + learning update.
   * Marks the old plan as 'superseded'.
   */
  replan(projectId: string, learningUpdateId: string): ReplanResult {
    // Load latest plan
    const latestPlanRecord = this.pm.getLatestPlan(projectId);
    if (!latestPlanRecord) {
      throw new Error(`No existing plan found for project ${projectId}`);
    }

    // Load learning update
    const updates = this.pm.getLearningUpdates(projectId);
    const learningRecord = updates.find((u) => u.id === learningUpdateId);
    if (!learningRecord) {
      throw new Error(`Learning update ${learningUpdateId} not found for project ${projectId}`);
    }

    const learningUpdate = learningRecord.update_data as LearningUpdate;
    const oldPlan = latestPlanRecord.plan as DesignPlan;

    // Deep-clone the plan
    const newPlan: DesignPlan & { _lineage?: object } = JSON.parse(JSON.stringify(oldPlan));
    const changesApplied: string[] = [];

    // Apply parameter adjustments
    if (learningUpdate.parameter_adjustments) {
      for (const adj of learningUpdate.parameter_adjustments) {
        const op = newPlan.operations?.find((o) => o.toolkit_op === adj.operation);
        if (op) {
          if (!op.params) op.params = {};
          op.params[adj.parameter] = adj.new_value;
          changesApplied.push(
            `${adj.operation}.${adj.parameter}: ${JSON.stringify(adj.old_value)} → ${JSON.stringify(adj.new_value)} (${adj.rationale})`,
          );
        }
      }
    }

    // Append new constraints to acceptance_rules
    if (learningUpdate.new_constraints && learningUpdate.new_constraints.length > 0) {
      if (!newPlan.acceptance_rules) newPlan.acceptance_rules = [];
      for (const constraint of learningUpdate.new_constraints) {
        newPlan.acceptance_rules.push(constraint);
        changesApplied.push(`Added acceptance rule: ${constraint}`);
      }
    }

    // Set lineage metadata
    newPlan._lineage = {
      previous_plan_id: latestPlanRecord.id,
      learning_update_ids: [learningUpdateId],
    };

    // Generate new plan ID
    const newPlanId = `plan-${crypto.randomUUID().slice(0, 8)}`;

    // Set status to pending
    newPlan.status = 'pending';
    newPlan.plan_id = newPlanId;

    // Persist new plan (version auto-incremented by PM)
    this.pm.createPlan(newPlanId, projectId, newPlan);

    // Mark old plan as superseded
    this.pm.updatePlanStatus(latestPlanRecord.id, 'superseded');

    // Get the new version number
    const newPlanRecord = this.pm.getPlan(newPlanId);
    const newVersion = newPlanRecord?.version ?? latestPlanRecord.version + 1;

    return {
      newPlanId,
      newVersion,
      previousPlanId: latestPlanRecord.id,
      changesApplied,
      learningUpdateId,
    };
  }
}
