import { createHash } from 'node:crypto';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import { PublicError } from '../ports/commands.js';
import { validateFeaturePlanInput, type ValidatedFeaturePlan } from '../ports/feature-plan.js';

/** Candidate IDs are local authoring labels. Preserve existing identities and
 * deterministically scope new labels that another Feature already owns. */
export function bindPlanningTaskIdentities(transaction: CommandTransaction, projectId: string,
  featureId: string, plan: ValidatedFeaturePlan) {
  const scoped = (id: string) => 'task-' + createHash('sha256')
    .update(JSON.stringify(['shiploop:planning-task:v1', projectId, featureId, id])).digest('hex');
  const links = transaction.getTaskFeatureLinks(plan.tasks.flatMap(task => [task.id, scoped(task.id)]));
  const mapping = Object.fromEntries(plan.tasks.map(task => {
    const derived = scoped(task.id);
    const actual = links.get(task.id) === featureId ? task.id
      : links.get(derived) === featureId || links.has(task.id) ? derived : task.id;
    if (links.has(actual) && links.get(actual) !== featureId) {
      throw new PublicError('conflict', 'planning.candidate.decide', undefined,
        { details: { reason: 'task_identity_collision' } });
    }
    return [task.id, actual];
  }));
  if (new Set(Object.values(mapping)).size !== plan.tasks.length) {
    throw new PublicError('conflict', 'planning.candidate.decide', undefined,
      { details: { reason: 'task_identity_collision' } });
  }
  const appliedPlan = validateFeaturePlanInput({ schemaVersion: plan.schemaVersion, feature: plan.feature,
    tasks: plan.tasks.map(task => ({ ...task, id: mapping[task.id],
      dependsOn: task.dependsOn.map(id => mapping[id]) })) });
  return { plan: appliedPlan, mapping };
}
