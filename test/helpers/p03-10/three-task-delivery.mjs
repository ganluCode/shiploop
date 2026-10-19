// Scenario-only consumer assembly. No seeded evidence, revived leases or SQL writes.
import { randomUUID } from 'node:crypto';
import { createSqliteSchedulerStore } from '../../../packages/core/dist/adapters/sqlite/scheduler-store.js';
import { createSqliteTaskDagStore } from '../../../packages/core/dist/adapters/sqlite/task-dag-store.js';
import { createSqliteAttemptAccess } from '../../../packages/core/dist/adapters/sqlite/attempt-store.js';
import { createSqliteGitOperationStore } from '../../../packages/core/dist/adapters/sqlite/git-operations.js';
import { createGitCommitDriver } from '../../../packages/core/dist/adapters/fs/git-commit-driver.js';
import { createGitPublicMetadataLock } from '../../../packages/core/dist/adapters/fs/git-public-metadata-lock.js';
import { createWorkScheduler } from '../../../packages/core/dist/application/work-scheduler.js';
import { evaluateTaskDag, evaluateTaskDagAfterResume } from '../../../packages/core/dist/application/task-dag.js';
import { createNodeFinalizationVerifier } from '../../../packages/core/dist/application/finalization-node-verifier.js';
import { createFinalizationGitDelivery } from '../../../packages/core/dist/application/finalization-git-delivery.js';
import { createFeatureFinalizationService } from '../../../packages/core/dist/application/feature-finalization.js';
import { verifyFeaturePlanApprovalInTransaction } from '../../../packages/core/dist/application/plan-approval-verification.js';
import { evaluateFeatureFinalApproval } from '../../../packages/core/dist/application/feature-final-approval.js';
import { computeDeliveryPolicyDigest } from '../../../packages/core/dist/ports/delivery-policy.js';
import { verificationCodeIdentity } from '../../../packages/core/dist/ports/verification-aggregate.js';

export function createThreeTaskDelivery({ core, session, atomic, verificationStore, inspector, processes }) {
  const db = session.database;
  const dag = createSqliteTaskDagStore(session);
  const operations = createSqliteGitOperationStore(session);
  const evidence = { verification: null, approval: null, delivery: null, reconciliation: null, finalization: null };
  let context;
  function assertIdle() {
    if (core.workExecution.activeAttemptIds().length !== 0
      || db.prepare('SELECT id FROM workspace_leases LIMIT 1').get()
      || db.prepare("SELECT id FROM baseline_occupancy WHERE holder_operation_id IS NOT NULL LIMIT 1").get()
      || db.prepare("SELECT id FROM attempts WHERE status IN ('preparing', 'executing', 'verifying') LIMIT 1").get()
      || db.prepare("SELECT id FROM sessions WHERE status <> 'stopped' LIMIT 1").get()) {
      throw Error('Feature finalization requires confirmed stopped writers and zero leases');
    }
  }
  const delivery = createFinalizationGitDelivery({
    operations, inspector,
    driver: createGitCommitDriver({ confirmProcessIdentity: async identity => identity }),
    lock: createGitPublicMetadataLock(),
    transact: callback => session.transactWrite('F003.finalGit', callback),
    readFeatureRevision: (projectId, featureId) => {
      const feature = db.prepare('SELECT revision FROM features WHERE project_id = ? AND id = ?').get(projectId, featureId);
      if (!feature) throw Error('Feature missing');
      return feature.revision;
    },
  });
  const verifier = createNodeFinalizationVerifier({
    processes, verification: verificationStore, atomic, artifacts: core.artifactStore, files: core.artifactFileStore,
    attempts: createSqliteAttemptAccess(session), stopControl: core.verificationStops,
    readPolicy: () => context.policy,
    resolveCwd: async () => context.baseline.canonicalPath,
    resolveEnvironment: () => ({}),
    resolveFeatureAnchor: () => ({ taskId: context.attempt.taskId, attemptId: context.attempt.id,
      runId: context.attempt.runId, executionVersion: context.attempt.executionVersion }),
  });
  async function assertCurrent() {
    assertIdle();
    const view = dag.readTaskDagView(context.input.projectId, context.input.runId);
    // feature finalize --confirm continues delivery without reserving a fifth
    // coding Attempt. Only this already-complete, human-approved pause qualifies.
    const approvalPause = view.run.status === 'paused' && view.batch.status === 'paused'
      && view.plan.feature.status === 'awaiting_approval'
      && ['approval_required', 'approval', 'feature_final_verification_handed_off'].includes(view.run.reason);
    if (approvalPause) {
      const gate = atomic.transact('F003.explicitFinalApproval', tx => evaluateFeatureFinalApproval(tx,
        verifyFeaturePlanApprovalInTransaction(tx, context.input.projectId, context.input.featureId),
        { codeDigest: context.identity.codeDigest }));
      if (!gate.valid) throw Error('Feature is still awaiting explicit approval');
    }
    const evaluation = approvalPause ? evaluateTaskDagAfterResume(view, Date.now()) : evaluateTaskDag(view, Date.now());
    if (evaluation.reason !== 'all_passed'
      || view.batch.deadlineAtUtcMs <= Date.now()
      || (view.run.startedAtUtcMs !== null && view.run.startedAtUtcMs + view.run.runTimeLimitMs <= Date.now())
      || view.run.pauseRequestedAtUtcMs !== null || view.batch.pauseRequestedAtUtcMs !== null
      || (!approvalPause && (!['queued', 'running'].includes(view.run.status) || !['queued', 'running'].includes(view.batch.status)))
      || view.plan.feature.planDigest !== context.planDigest
      || JSON.stringify(view.settings) !== context.settings) throw Error('Feature authority changed');
    const current = await inspector.inspect(context.baseline);
    if (current.repository.headCommit !== context.request.expectedHead || current.codeDigest !== context.request.codeDigest) {
      throw Error('Feature source changed');
    }
  }
  async function approval() {
    await assertCurrent();
    const gate = atomic.transact('F003.finalApproval', tx => evaluateFeatureFinalApproval(tx,
      verifyFeaturePlanApprovalInTransaction(tx, context.input.projectId, context.input.featureId),
      { codeDigest: context.identity.codeDigest }));
    evidence.approval = gate;
    if (gate.valid && gate.approval) context.request.approvalRefs = [
      { kind: 'human_approval', id: gate.approval.id, digest: context.identity.codeDigest },
    ];
    return { valid: gate.valid, reason: gate.reason ?? 'approval_current' };
  }
  const dependencies = {
    async verify(input) {
      if (input.runId !== context.input.runId || input.operationId !== context.input.operationId) throw Error('Feature identity mismatch');
      await assertCurrent();
      if (evidence.verification?.status === 'passed') {
        const stored = verificationStore.getVerificationBatch(input.projectId, evidence.verification.batchId);
        const checks = verificationStore.listCheckResults(input.projectId, stored.id);
        if (stored.status !== 'passed' || stored.codeDigest !== context.identity.codeDigest
          || stored.policyDigest !== context.policyDigest || stored.operation !== 'FeatureVerification.full'
          || checks.length !== 1 || checks[0].status !== 'passed'
          || checks[0].outputArtifactId !== evidence.verification.checks[0].outputArtifactId) {
          throw Error('Stored Feature verification is no longer current');
        }
        const artifact = await core.artifactStore.getArtifact(input.projectId, checks[0].outputArtifactId);
        if (artifact.status !== 'ready') throw Error('Feature output artifact is no longer ready');
        return { passed: true, reason: 'feature_full_verification_reused' };
      }
      const result = await verifier.verifyFeature({
        projectId: input.projectId, featureId: input.featureId,
        finalizationRunId: input.runId, historicalRunId: input.runId,
        planDigest: context.planDigest, checkPolicyDigest: context.policyDigest,
        codeDigest: context.identity.codeDigest, headCommit: context.identity.headCommit,
        workspaceBaseline: context.baseline, checkKeys: ['chain'],
        deadlineUtcMs: context.deadline, reasons: ['three_task_chain_completed'],
      });
      const outputs = [];
      for (const check of result.checks) {
        if (check.outputArtifactId === null) throw Error('Feature check output missing');
        const file = await core.artifactFileStore.openFinalRead({ projectId: input.projectId, artifactId: check.outputArtifactId });
        const chunks = [];
        for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
        outputs.push(Buffer.concat(chunks).toString('utf8'));
      }
      evidence.verification = { ...result, outputs };
      await assertCurrent();
      const passed = result.status === 'passed' && !result.invalidated && result.checks.length === 1
        && result.checks.every(check => check.status === 'passed' && check.testCount === 3)
        && outputs.some(output => output.includes('PASS chain checks'));
      if (passed) context.request.verificationRefs = [
        { kind: 'verification_batch', id: result.batchId, digest: context.identity.codeDigest },
      ];
      return { passed, reason: passed ? 'feature_full_verification_passed' : 'feature_full_verification_failed' };
    },
    readIntent: () => ({ ...context.input, codeDigest: context.identity.codeDigest }),
    commit: { async commit(input) {
      if (input.projectId !== context.input.projectId || input.operationId !== context.input.operationId) throw Error('Git identity mismatch');
      if (!(await approval()).valid || evidence.verification?.status !== 'passed'
        || context.request.verificationRefs.length !== 1) throw Error('Feature delivery gate not passed');
      evidence.delivery = await delivery.commit(context.request);
      evidence.reconciliation = await delivery.verifyOperation(context.request, input.operationId);
      if (!evidence.reconciliation.matched) throw Error(`Final Git mismatch: ${evidence.reconciliation.reasonCode}`);
      return operations.getGitOperation(input.projectId, input.operationId);
    } },
    reconciliation: { reconcile: input => delivery.reconcile(context.request, input.operationId) },
  };
  const finalization = createFeatureFinalizationService({ atomic, verify: dependencies.verify,
    readApproval: approval, commit: dependencies.commit });
  const scheduler = createWorkScheduler({
    store: createSqliteSchedulerStore(session),
    dag: { evaluate: (projectId, runId) => evaluateTaskDag(dag.readTaskDagView(projectId, runId), Date.now()) },
    async onHandoff(handoff) {
      if (handoff.runId !== context.input.runId || handoff.featureId !== context.input.featureId) throw Error('Unexpected handoff');
      evidence.finalization = await finalization.finalize(context.input);
      if (!['completed', 'awaiting_approval'].includes(evidence.finalization.outcome)) {
        throw Error(`Feature finalization: ${evidence.finalization.reason}`);
      }
    },
  });
  return {
    dependencies,
    async finish(attemptRow, baseline) {
      assertIdle();
      // The built Host has no ordinary-Run onHandoff injection. Retire only its
      // idle coding consumer before using the public Scheduler consumer here.
      const stopped = await core.workExecution.close();
      if (!stopped.closed || stopped.pendingAttemptIds.length !== 0) throw Error('Coding consumer did not quiesce');
      const view = dag.readTaskDagView(attemptRow.project_id, attemptRow.run_id);
      if (evaluateTaskDag(view, Date.now()).reason !== 'all_passed') throw Error('Task DAG not complete');
      const taskOperations = db.prepare("SELECT attempt_id, status FROM git_operations WHERE operation_type = 'task_commit'").all();
      const successful = db.prepare("SELECT id FROM attempts WHERE run_id = ? AND status = 'succeeded'").all(attemptRow.run_id);
      if (successful.length !== 3 || successful.some(attempt => !taskOperations.some(operation =>
        operation.attempt_id === attempt.id && ['succeeded', 'no_change'].includes(operation.status)))) {
        throw Error('Missing controlled Task commit');
      }
      const attempt = createSqliteAttemptAccess(session).getAttempt(attemptRow.project_id, attemptRow.id);
      const policies = view.settings.project?.payload.policies;
      if (policies?.deliveryPolicy?.commitMode !== 'task_and_feature'
        || policies.deliveryPolicy.gitIdentity?.confirmed !== true
        || JSON.stringify(policies.deliveryPolicy.deliveryActions) !== '["commit"]') throw Error('Missing confirmed delivery authority');
      const inspection = await inspector.inspect(baseline);
      const identity = verificationCodeIdentity(inspection);
      const input = { projectId: attempt.projectId, featureId: attempt.featureId, runId: attempt.runId,
        batchId: view.batch.id, operationId: randomUUID() };
      const policyDigest = attempt.inputSnapshot.approval.checkPolicyDigest;
      context = { input, attempt, baseline, identity, policy: policies.verification, policyDigest,
        planDigest: view.plan.feature.planDigest, settings: JSON.stringify(view.settings),
        deadline: Math.min(view.batch.deadlineAtUtcMs, view.run.startedAtUtcMs === null ? Infinity
          : view.run.startedAtUtcMs + view.run.runTimeLimitMs),
        request: { ...input, expectedHead: inspection.repository.headCommit, codeDigest: inspection.codeDigest,
          planDigest: view.plan.feature.planDigest, checkPolicyDigest: policyDigest,
          workspaceId: db.prepare('SELECT id FROM managed_workspaces WHERE feature_id = ?').get(attempt.featureId).id,
          workspaceRevision: db.prepare('SELECT revision FROM managed_workspaces WHERE feature_id = ?').get(attempt.featureId).revision,
          verificationRefs: [], approvalRefs: [], baseline,
          attempt: { attemptId: attempt.id, executionVersion: attempt.executionVersion, owner: attempt.owner,
            hostInstanceId: attempt.hostInstanceId },
          message: 'Deliver verified P03-10 three Task chain', gitIdentity: policies.deliveryPolicy.gitIdentity,
          deliveryPolicyDigest: computeDeliveryPolicyDigest(policies.deliveryPolicy) },
      };
      evidence.codingConsumerStopped = stopped;
      evidence.approvalRequest = { taskId: attempt.taskId, planDigest: context.planDigest,
        codeDigest: context.identity.codeDigest };
      evidence.scheduler = await scheduler.scan();
      if (!['completed', 'awaiting_approval'].includes(evidence.finalization?.outcome)) {
        throw Error(`Feature consumer failed: ${JSON.stringify(evidence)}`);
      }
      return evidence;
    },
    readState() {
      if (!context) throw Error('Feature delivery has not been prepared');
      const current = atomic.transact('F003.deliveryState', tx => ({
        feature: tx.getFeaturePlan(context.input.projectId, context.input.featureId).feature,
        run: tx.getExecutionRun(context.input.projectId, context.input.runId),
        batch: tx.getExecutionBatch(context.input.projectId, context.input.batchId),
      }));
      return { ...evidence, finalization: { ...current, outcome: current.feature.status,
        deliveryStatus: current.feature.deliveryStatus, reason: current.run.reason,
        operationId: context.input.operationId } };
    },
    close: () => scheduler.close(),
  };
}
