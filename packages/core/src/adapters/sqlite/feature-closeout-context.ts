import { createHash } from 'node:crypto';
import { stableStringify } from '../../ports/feature-plan.js';
import { StorageError } from '../../ports/errors.js';
import { TASK_TERMINAL_EVENT_TYPE } from '../../ports/execution-store.js';
import { FEATURE_VERIFICATION_OPERATION } from '../../ports/feature-verification.js';
import { computeDeliveryPolicyDigest, resolveDeliveryPolicyForUse } from '../../ports/delivery-policy.js';
import type { WorkResourceAccess } from '../../ports/work-resources.js';
import { mergeEffectiveSettings } from '../../application/effective-settings.js';
import { resolveFeatureAutoFixPolicy } from '../../application/feature-auto-fix-policy.js';
import { verifyFeaturePlanApprovalInTransaction } from '../../application/plan-approval-verification.js';
import { createSqliteAtomicCommandStore } from './atomic-commands.js';
import { createSqliteVerificationStore } from './verification-store.js';
import { createSqliteAttemptAccess } from './attempt-store.js';
import { createSqliteWorkspaceAccess } from './workspace.js';
import type { SqliteStorageSession } from './session.js';
import type { CommandTransaction } from '../../ports/atomic-commands.js';

/** Only identity/selection records are read; no Session JSONL or mutable model files. */
export function createSqliteFeatureCloseoutContext(session: SqliteStorageSession, options: { resources: WorkResourceAccess; nowUtcMs?: () => number }) {
  const atomic = createSqliteAtomicCommandStore(session, options);
  const verification = createSqliteVerificationStore(session, options);
  const attempts = createSqliteAttemptAccess(session);
  const workspaces = createSqliteWorkspaceAccess(session, options);
  const now = options.nowUtcMs ?? Date.now;
  function fail(reason: string): never {
    throw new StorageError('conflict', 'FeatureCloseout.context', 'Feature closeout preparation blocked', { details: { reason } });
  }
  function readInTransaction(tx: CommandTransaction, projectId: string, runId: string) {
        if (!session.database.inTransaction) throw new TypeError('closeout_context_requires_transaction');
        if (tx.getProject(projectId).status !== 'active') fail('project_not_active');
        const run = tx.getExecutionRun(projectId, runId), batch = tx.getExecutionBatch(projectId, run.batchId);
        if (!['queued', 'running'].includes(run.status) || !['queued', 'running'].includes(batch.status)
          || run.pauseRequestedAtUtcMs !== null || batch.pauseRequestedAtUtcMs !== null) fail('run_control_blocked');
        const plan = tx.getFeaturePlan(projectId, run.featureId);
        if (!plan.tasks.length || plan.tasks.some(task => task.status !== 'passed')) fail('tasks_not_passed');
        const approval = verifyFeaturePlanApprovalInTransaction(tx, projectId, run.featureId);
        const memberApproval = Array.isArray(batch.configSnapshot.members)
          ? (batch.configSnapshot.members as {featureId:string;approval?:unknown}[]).find(member=>member.featureId===run.featureId)?.approval : undefined;
        const frozen = (memberApproval ?? batch.configSnapshot.approval) as { planDigest?: string; checkPolicyDigest?: string; decisionId?: string } | undefined;
        if (!approval.validity.valid || !approval.planDigest || frozen?.planDigest !== approval.planDigest
          || frozen.checkPolicyDigest !== approval.checkPolicyDigest
          || (frozen.decisionId !== undefined && frozen.decisionId !== approval.currentDecision?.id)) fail('plan_approval_invalid');
        const global = tx.getGlobalSettingsOrNull(), project = tx.getProjectSettingsOrNull(projectId);
        const effective = mergeEffectiveSettings({ global: global && { scopeRevision: global.revision, payload: global.payload },
          project: project && { scopeRevision: project.revision, payload: project.payload } });
        const policy = effective.policies.verification?.value;
        const autoFix = resolveFeatureAutoFixPolicy(effective);
        if (!policy?.featureChecks?.length) fail('feature_check_scope_missing');
        const delivery = resolveDeliveryPolicyForUse(effective.policies.deliveryPolicy?.value);
        if (delivery.status !== 'ready') fail(delivery.reason);
        const selected = new Set<string>();
        const proofs: { taskId: string; attemptId: string; verificationBatchId: string }[] = [];
        for (const task of plan.tasks) {
          const current = session.database.prepare('SELECT execution_version,manual_block FROM tasks WHERE project_id=? AND id=?')
            .get(projectId, task.id) as { execution_version: number; manual_block: number };
          if (current.manual_block) fail('manual_block');
          const terminal = session.database.prepare(`SELECT payload FROM state_events WHERE project_id=? AND aggregate_type='task'
            AND aggregate_id=? AND event_type=? ORDER BY aggregate_revision DESC,rowid DESC LIMIT 1`)
            .get(projectId, task.id, TASK_TERMINAL_EVENT_TYPE) as { payload: string } | undefined;
          if (!terminal) fail('task_verification_evidence_missing');
          const event = JSON.parse(terminal.payload);
          if (event.status !== 'passed' || event.resultCategory !== 'passed' || typeof event.resultRef !== 'string'
            || typeof event.attemptId !== 'string') fail('task_verification_evidence_missing');
          const attempt = attempts.getAttempt(projectId, event.attemptId);
          const evidence = verification.getVerificationBatch(projectId, event.resultRef);
          if (attempt.featureId !== run.featureId || attempt.taskId !== task.id || attempt.status !== 'succeeded'
            || attempt.executionVersion !== current.execution_version || event.runId !== attempt.runId
            || evidence.operation === FEATURE_VERIFICATION_OPERATION || evidence.status !== 'passed'
            || evidence.projectId !== projectId || evidence.featureId !== run.featureId || evidence.runId !== attempt.runId
            || evidence.taskId !== task.id || evidence.attemptId !== attempt.id || evidence.executionVersion !== attempt.executionVersion
            || evidence.policyDigest !== approval.checkPolicyDigest || !evidence.checkSnapshot.length) fail('task_verification_identity_invalid');
          const results = verification.listCheckResults(projectId, evidence.id);
          if (results.length !== evidence.checkSnapshot.length || evidence.checkSnapshot.some(check => {
            const matching = results.filter(result => result.checkKey === check.checkKey);
            return matching.length !== 1 || matching[0].status !== 'passed' || matching[0].outputArtifactId === null;
          })) fail('task_verification_evidence_missing');
          for (const ref of evidence.selection.selectedCheckKeys) {
            if (!policy.featureChecks.includes(ref)) continue;
            const check = evidence.checkSnapshot.find(check => check.checkKey === ref);
            const approved = policy.checkDefinitions?.find(check => check.checkKey === ref);
            if (!check || !approved || stableStringify(check) !== stableStringify(approved)) fail('task_check_definition_changed');
            selected.add(ref);
          }
          proofs.push({ taskId: task.id, attemptId: attempt.id, verificationBatchId: evidence.id });
        }
        const checkKeys = policy.featureChecks.filter(ref => selected.has(ref));
        if (!checkKeys.length) fail('feature_check_scope_missing');
        const anchor = proofs.map(proof => attempts.getAttempt(projectId, proof.attemptId)).find(attempt => attempt.runId === runId);
        if (!anchor) fail('closeout_attempt_anchor_missing');
        const workspace = workspaces.readWorkspace(projectId, run.featureId);
        const binding = tx.getRepositoryBinding(projectId);
        if (!workspace || !['ready', 'retained'].includes(workspace.status) || !workspace.gitCommonDir
          || workspace.repositoryBindingId !== binding.id || workspace.repositoryBindingRevision !== binding.bindingRevision) fail('workspace_identity_changed');
        const deadlineUtcMs = Math.min(batch.deadlineAtUtcMs, (run.startedAtUtcMs ?? run.createdAtUtcMs) + run.runTimeLimitMs);
        if (deadlineUtcMs <= now()) fail('parent_deadline');
        const material = { projectId, featureId: run.featureId, runId, batchId: batch.id, scopeDigest: run.scopeDigest,
          planDigest: approval.planDigest, policyDigest: approval.checkPolicyDigest, approvalId: approval.currentDecision?.id,
          workspaceId: workspace.id, bindingRevision: binding.bindingRevision, checkKeys, proofs,
          autoFixPolicyDigest: autoFix.status === 'ready' ? autoFix.policyDigest : autoFix.status,
          deliveryPolicyDigest: computeDeliveryPolicyDigest(effective.policies.deliveryPolicy?.value) };
        const inputDigest = createHash('sha256').update(stableStringify(material)).digest('hex');
        return { key: { projectId, featureId: run.featureId, runId, inputDigest }, run, batch, plan, policy, checkKeys, proofs,
          anchor, workspace, approval, autoFix, deliveryPolicy: delivery.policy, deliveryPolicyDigest: material.deliveryPolicyDigest, deadlineUtcMs };
  }
  return { readInTransaction, read: (projectId: string, runId: string) =>
    atomic.transact('FeatureCloseout.context.read', tx => readInTransaction(tx, projectId, runId)) };
}
