import { randomUUID } from 'node:crypto';
import { createFeatureCloseoutCoordinator } from '../application/feature-closeout.js';
import { createFeatureCloseoutVerifier } from '../application/feature-closeout-verifier.js';
import { createFeatureCloseoutDelivery } from '../application/feature-closeout-delivery.js';
import { createFinalizationGitDelivery } from '../application/finalization-git-delivery.js';
import { evaluateFeatureFinalApproval } from '../application/feature-final-approval.js';
import { createArtifactVerifier } from '../application/artifact-verify.js';
import { createFeatureNodeVerificationExecutor } from '../application/node-task-verification.js';
import { verifyStoredVerificationOutputs } from '../application/verification-output-evidence.js';
import { createSqliteFeatureCloseoutContext } from './sqlite/feature-closeout-context.js';
import { createSqliteFeatureCloseoutStore } from './sqlite/feature-closeout-store.js';
import { createSqliteFeatureCloseoutLease } from './sqlite/feature-closeout-lease.js';
import { createSqliteFeatureCloseoutStopVerifier } from './sqlite/feature-closeout-stop.js';
import { createSqliteAtomicCommandStore } from './sqlite/atomic-commands.js';
import { createSqliteGitOperationStore } from './sqlite/git-operations.js';
import { createSqliteVerificationStore } from './sqlite/verification-store.js';
import { createBaselineWorkspaceReader } from './fs/baseline-workspace.js';
import { computeFinalizationOperationId } from '../ports/finalization-completion.js';
import { verificationCodeIdentity } from '../ports/verification-aggregate.js';
import { StorageError } from '../ports/errors.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { CommandProcessPort, CommandProcessIdentity } from '../ports/command-process.js';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import type { createSqliteTaskCommitter } from './sqlite/task-commit.js';

type DeliveryDeps = Parameters<typeof createSqliteTaskCommitter>[0];

/** Default normal-Run consumer. No client-provided callbacks, SDK or model calls. */
export function assembleFeatureCloseout(options: Pick<DeliveryDeps,
  'session' | 'resources' | 'inspectorFor' | 'driverFor' | 'lock' | 'publisher' | 'files' | 'stopControl'> & {
  artifacts: ArtifactStore;
  processes: CommandProcessPort;
  ownerId: string;
  hostInstanceId: string;
  confirmProcessIdentity(projectId: string, identity: CommandProcessIdentity): Promise<void>;
  nowUtcMs?: () => number;
}) {
  const { session } = options;
  const now = options.nowUtcMs ?? Date.now;
  const atomic = createSqliteAtomicCommandStore(session, { nowUtcMs: now });
  const contexts = createSqliteFeatureCloseoutContext(session, { resources: options.resources, nowUtcMs: now });
  const ledger = createSqliteFeatureCloseoutStore(session);
  const leases = createSqliteFeatureCloseoutLease(session, { ...options, nowUtcMs: now });
  const verification = createSqliteVerificationStore(session, { nowUtcMs: now });
  const operations = createSqliteGitOperationStore(session, { nowUtcMs: now });
  const artifacts = createArtifactVerifier({ artifacts: options.artifacts, files: options.files, limits: { maxReadBytes: 16_000_000 } });
  const cwdReader = createBaselineWorkspaceReader();
  const shutdown = new AbortController();
  const pending = new Map<string, Promise<{ recordHandoff: false }>>();
  const verifyEvidence = async (projectId: string, batchId: string) => {
    await verifyStoredVerificationOutputs({ verification, artifacts: options.artifacts, files: options.files }, projectId, batchId);
    return true;
  };
  function reasonOf(error: unknown) {
    const reason = error instanceof StorageError ? error.details?.reason : undefined;
    return typeof reason === 'string' && /^[a-z][a-z0-9_.-]{0,127}$/.test(reason) ? reason : 'closeout_preparation_blocked';
  }
  function pause(projectId: string, runId: string, reason: string) {
    atomic.transact('FeatureCloseout.pause', tx => {
      const run = tx.getExecutionRun(projectId, runId);
      if (!['queued', 'running'].includes(run.status)) return;
      const changed = session.database.prepare(`UPDATE runs SET status='paused',reason=?,revision=revision+1,updated_at=?
        WHERE project_id=? AND id=? AND revision=? AND status IN ('queued','running')`)
        .run(reason, now(), projectId, runId, run.revision);
      if (changed.changes !== 1) throw new Error('closeout_pause_conflict');
      tx.appendExecutionEvent({ projectId, eventType: 'execution.run.paused', aggregateType: 'run', aggregateId: runId,
        aggregateRevision: run.revision + 1, payload: { paused: true } });
    });
  }
  async function execute(projectId: string, runId: string) {
    if (shutdown.signal.aborted) return { recordHandoff: false as const };
    const prior = ledger.read(projectId, runId);
    if (prior && ['completed', 'failed', 'blocked', 'reconcile_required'].includes(prior.stage)) return { recordHandoff: false as const };
    let context;
    try { context = contexts.read(projectId, runId); }
    catch (error) { pause(projectId, runId, reasonOf(error)); return { recordHandoff: false as const }; }
    if (context.autoFix.status !== 'disabled') {
      pause(projectId, runId, context.autoFix.status === 'blocked' ? context.autoFix.reason : 'feature_auto_fix_runtime_not_assembled');
      return { recordHandoff: false as const };
    }
    const { key } = context;
    const baseline = { repositoryBindingId: context.workspace.repositoryBindingId,
      repositoryBindingRevision: context.workspace.repositoryBindingRevision, repoIdentity: context.workspace.repoIdentity,
      canonicalPath: context.workspace.canonicalPath, gitCommonDir: context.workspace.gitCommonDir,
      branch: context.workspace.branch, baseCommit: context.workspace.baseCommit };
    try {
      await leases.run(key, async token => {
        const signal = AbortSignal.any([token.signal, shutdown.signal]);
        let transaction: CommandTransaction | undefined;
        const read = () => transaction ? contexts.readInTransaction(transaction, projectId, runId) : contexts.read(projectId, runId);
        const assertCurrent = () => {
          signal.throwIfAborted();
          leases.assertCurrent(token, transaction);
          if (read().key.inputDigest !== key.inputDigest) throw new Error('closeout_identity_changed');
        };
        const approval = (codeDigest: string) => {
          const evaluate = (tx: CommandTransaction) => evaluateFeatureFinalApproval(tx, context.approval,
            { codeDigest, requireApproval: false });
          return transaction ? evaluate(transaction) : atomic.transact('FeatureCloseout.approval', evaluate);
        };
        const inspector = await options.inspectorFor(projectId);
        const identity = { projectId, attemptId: context.anchor.id, owner: context.anchor.owner,
          hostInstanceId: context.anchor.hostInstanceId, executionVersion: context.anchor.executionVersion };
        const stopVerifier = createSqliteFeatureCloseoutStopVerifier({ session, key, token,
          assertLease: value => leases.assertCurrent(value), artifacts, processes: options.processes });
        const executor = createFeatureNodeVerificationExecutor({ atomic, verification, processes: options.processes,
          artifacts: options.artifacts, files: options.files, nowUtcMs: now, stopControl: options.stopControl,
          confirmProcessIdentity: process => { assertCurrent(); return options.confirmProcessIdentity(projectId, process); },
          resolveCwd: async ref => {
            assertCurrent();
            const cwd = await cwdReader.resolveContainedCwd(context.workspace.canonicalPath, ref);
            if (cwd.status !== 'inside') throw new Error('closeout_cwd_unavailable');
            return cwd.canonicalPath;
          },
          // Non-null references require an explicit trusted environment resolver.
          resolveEnvironment: ref => { if (ref !== null) throw new Error('closeout_environment_unavailable'); return {}; },
          resolveFeatureAttempt: () => ({ taskId: context.anchor.taskId, attemptId: context.anchor.id }),
        });
        const verifier = createFeatureCloseoutVerifier({ verifyEvidence,
          prepare: async () => {
            assertCurrent();
            return { inputDigest: key.inputDigest, checkKeys: context.checkKeys, input: { ...key,
              batchId: randomUUID(), executionVersion: identity.executionVersion, resourceIdentity: identity,
              workspaceBaseline: baseline, policy: context.policy, policyDigest: context.approval.checkPolicyDigest,
              environmentSummary: {}, targets: context.checkKeys, signal, deadlineUtcMs: context.deadlineUtcMs } };
          },
          coordinator: {
            taskDag: { evaluate: () => { assertCurrent(); return { ...key, reason: 'all_passed', handoff: 'feature_final_verification' }; } },
            resources: options.resources, stopVerifier, workspace: inspector, execute: executor,
            withResource: async (_identity, callback) => { assertCurrent(); return callback(); },
            readExecutionIdentity: async () => { assertCurrent(); return { policyDigest: read().approval.checkPolicyDigest }; },
          },
        });
        const operationId = computeFinalizationOperationId(`normal-closeout:${projectId}:${runId}`);
        const delivery = createFeatureCloseoutDelivery({ atomic, verification, verifyEvidence,
          prepare: async (_key, evidenceRef) => {
            assertCurrent();
            const inspection = await inspector.inspect(baseline);
            assertCurrent();
            return { inputDigest: key.inputDigest, codeDigest: verificationCodeIdentity(inspection).codeDigest,
              policyDigest: context.approval.checkPolicyDigest,
              input: { projectId, runId, featureId: key.featureId, batchId: context.batch.id, operationId } };
          },
          readApproval: async (_input, codeDigest) => { assertCurrent(); const gate = approval(codeDigest);
            return { valid: gate.valid, reason: gate.reason ?? 'approval_current' }; },
          commit: { async commit() {
            assertCurrent();
            const row = ledger.read(projectId, runId);
            if (!row?.evidenceRef) throw new Error('closeout_verification_missing');
            const inspection = await inspector.inspect(baseline);
            const code = verificationCodeIdentity(inspection).codeDigest;
            const evidence = verification.getVerificationBatch(projectId, row.evidenceRef);
            if (evidence.status !== 'passed' || evidence.codeDigest !== code || !approval(code).valid) throw new Error('closeout_delivery_invalidated');
            await verifyEvidence(projectId, row.evidenceRef);
            const git = createFinalizationGitDelivery({ operations, inspector, driver: options.driverFor(projectId, signal),
              lock: options.lock, publisher: options.publisher, artifacts, nowMs: now,
              transact: callback => atomic.transact('FeatureCloseout.git', tx => {
                transaction = tx; try { return callback(); } finally { transaction = undefined; }
              }),
              readFeatureRevision: (p, f) => transaction ? transaction.getFeaturePlan(p, f).feature.revision
                : atomic.transact('FeatureCloseout.feature', tx => tx.getFeaturePlan(p, f).feature.revision),
            });
            const request = { projectId, featureId: key.featureId, runId, operationId,
              expectedHead: inspection.repository.headCommit, codeDigest: inspection.codeDigest,
              planDigest: context.approval.planDigest!, checkPolicyDigest: context.approval.checkPolicyDigest,
              workspaceId: context.workspace.id, workspaceRevision: context.workspace.revision,
              verificationRefs: [{ kind: 'verification_batch' as const, id: row.evidenceRef, digest: code }], approvalRefs: [],
              baseline, attempt: { attemptId: context.anchor.id, executionVersion: identity.executionVersion,
                owner: identity.owner, hostInstanceId: identity.hostInstanceId }, message: `Feature ${key.featureId}: verified delivery`,
              gitIdentity: context.deliveryPolicy.gitIdentity, deliveryPolicyDigest: context.deliveryPolicyDigest, assertCurrent };
            const previous = git.readOperation(projectId, operationId);
            if (previous) {
              if (!['succeeded', 'no_change'].includes(previous.status)
                || !(await git.verifyOperation(request, operationId)).matched) throw new Error('closeout_git_reconcile_required');
            } else { await git.commit(request); }
            return operations.getGitOperation(projectId, operationId);
          } },
        });
        const coordinator = createFeatureCloseoutCoordinator({ store: ledger, owner: options.ownerId,
          consumers: {
            authorize: async () => { try { assertCurrent(); return { allowed: true, reason: 'authorized' }; }
              catch (error) { return { allowed: false, reason: reasonOf(error) }; } },
            verify: async ref => {
              const result = await verifier.verify(ref);
              if (await stopVerifier.verify(options.resources.read(identity)) === null) throw new Error('closeout_verifier_stop_unconfirmed');
              return result;
            }, complete: delivery.complete,
            repair: async () => { throw new Error('closeout_repair_not_configured'); },
          } });
        const result = await coordinator.execute(key);
        if (result.stage === 'failed') {
          assertCurrent();
          atomic.transact('FeatureCloseout.verificationFailed', tx => {
            const fresh = contexts.readInTransaction(tx, projectId, runId);
            tx.finalizeFeatureDelivery({ projectId, featureId: key.featureId, runId, batchId: fresh.batch.id,
              expectedFeatureRevision: fresh.plan.feature.revision, expectedRunRevision: fresh.run.revision,
              expectedBatchRevision: fresh.batch.revision, outcome: 'partial', deliveryStatus: 'not_requested',
              reason: result.reason ?? 'verification_failed', operationId: null });
          });
        } else if (result.stage !== 'completed') pause(projectId, runId, result.reason ?? `closeout_${result.stage}`);
      });
    } catch (error) { pause(projectId, runId, reasonOf(error)); }
    return { recordHandoff: false as const };
  }
  return {
    execute(input: { projectId: string; runId: string }) {
      const id = JSON.stringify([input.projectId, input.runId]);
      let promise = pending.get(id);
      if (!promise) { promise = execute(input.projectId, input.runId).finally(() => pending.delete(id)); pending.set(id, promise); }
      return promise;
    },
    async close() { shutdown.abort(); await Promise.allSettled([...pending.values()]); },
  };
}
