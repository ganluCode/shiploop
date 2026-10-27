import { randomBytes } from 'node:crypto';
import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
import { authorizeCommand, authorizeCommandReplay, type TrustedPrincipal } from '../ports/authorization.js';
import { createCompletedReceipt, createRejectedReceipt, evaluateCommandTiming, mapToPublicError, PublicError, type CommandReceipt, type ValidatedCommandEnvelope } from '../ports/commands.js';
import { createResultRef, decideCommandReplay } from '../ports/command-receipts.js';
import type { ControlledGitCommitService } from '../ports/controlled-git-commit.js';
import type { GitCommitReconciliationService } from '../ports/git-commit-reconciliation.js';
import type { GitOperationIntent } from '../ports/git-operations.js';
import { isStorageError } from '../ports/errors.js';
import { validateSha256Digest } from '../ports/validation.js';
import { createFeatureFinalizationService, type FeatureFinalizationInput, type FeatureFinalizationOptions } from './feature-finalization.js';
import { evaluateFeatureFinalApproval } from './feature-final-approval.js';
import { verifyFeaturePlanApprovalInTransaction } from './plan-approval-verification.js';

export type FeatureDeliveryEnvelope = Extract<ValidatedCommandEnvelope, {
  operation: 'feature.verification.continue' | 'git.operation.start' | 'git.operation.reconcile';
}>;

export interface IntegrationStartExecution {
  start(input: {
    readonly projectId: string;
    readonly featureId: string;
    readonly runId: string;
    readonly batchId: string;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly inputDigest: string;
    readonly commandId: string;
  }): Promise<{ readonly outcome: 'merging' | 'pending_verification' | 'blocked' | 'unknown'; readonly reason: string | null }>;
}

/** Trusted code only. These adapters must enforce current evidence, budgets,
 * fencing and stop confirmation using the existing verification/Git services.
 * No adapter or authorization flags may be supplied in a command payload.
 */
export interface FeatureDeliveryDependencies {
  readonly verify: FeatureFinalizationOptions['verify'];
  /** Read the current immutable intent identity from Core-owned delivery evidence. */
  readonly readIntent: (input: FeatureFinalizationInput) => Pick<GitOperationIntent,
    'projectId' | 'featureId' | 'runId' | 'operationId' | 'codeDigest'>;
  readonly commit: ControlledGitCommitService;
  readonly reconciliation: GitCommitReconciliationService;
  readonly integrationStart?: IntegrationStartExecution;
}
export type FeatureDeliveryFactory = (context: {
  readonly atomicStore: AtomicCommandStore;
}) => FeatureDeliveryDependencies;

export function createFeatureDeliveryCommandHandler(options: {
  readonly atomicStore: AtomicCommandStore;
  readonly dependencies: FeatureDeliveryDependencies;
  readonly nowUtcMs: () => number;
}) {
  const { atomicStore: store, dependencies: deps, nowUtcMs } = options;
  if (typeof deps?.verify !== 'function' || typeof deps.readIntent !== 'function' || typeof deps.commit?.commit !== 'function'
    || typeof deps.reconciliation?.reconcile !== 'function') {
    throw new TypeError('Feature delivery requires trusted verification, commit and reconciliation adapters');
  }
  const finalization = createFeatureFinalizationService({ atomic: store, verify: deps.verify, commit: deps.commit,
    async readApproval(input) {
      return store.transact('FeatureDelivery.approval', transaction => {
        const intent = checkedIntent(input);
        const plan = verifyFeaturePlanApprovalInTransaction(transaction, input.projectId, input.featureId);
        const gate = evaluateFeatureFinalApproval(transaction, plan, { codeDigest: intent.codeDigest });
        return { valid: gate.valid, reason: gate.reason ?? 'approval_current' };
      });
    },
  });
  let accepting = true;
  const commands = new Map<string, { digest: string; promise: Promise<CommandReceipt> }>();
  const targets = new Map<string, Promise<unknown>>();

  function original(principal: TrustedPrincipal, envelope: FeatureDeliveryEnvelope, digest: string,
    transaction: CommandTransaction): CommandReceipt | undefined {
    authorizeCommand(principal, envelope);
    const receipt = transaction.findReceipt(principal.principalId, envelope.commandId);
    if (receipt) authorizeCommandReplay(principal, receipt, null, envelope.operation);
    const decision = decideCommandReplay(receipt, digest, envelope.operation);
    return decision.kind === 'replay' ? decision.receipt : undefined;
  }

  function checkedIntent(input: FeatureFinalizationInput) {
    const intent = deps.readIntent(input);
    if (intent.projectId !== input.projectId || intent.featureId !== input.featureId
      || intent.runId !== input.runId || intent.operationId !== input.operationId) {
      throw new PublicError('not_found', 'feature.verification.continue');
    }
    validateSha256Digest(intent.codeDigest, { operation: 'feature.verification.continue' }, 'codeDigest');
    return intent;
  }

  function assertTarget(transaction: CommandTransaction, envelope: FeatureDeliveryEnvelope) {
    const projectId = envelope.scope.projectId;
    const { featureId, runId, batchId, operationId } = envelope.payload;
    const feature = transaction.getFeaturePlan(projectId, featureId).feature;
    const run = transaction.getExecutionRun(projectId, runId);
    const batch = transaction.getExecutionBatch(projectId, batchId);
    let operation;
    try { operation = transaction.getGitOperation(projectId, operationId); }
    catch (error) {
      if (envelope.operation === 'git.operation.reconcile' || !isStorageError(error) || error.kind !== 'not_found') throw error;
    }
    if (run.featureId !== featureId || run.batchId !== batchId || batch.featureId !== featureId
      || (operation && (operation.intent.projectId !== projectId || operation.intent.featureId !== featureId
      || operation.intent.runId !== runId || (envelope.operation === 'git.operation.start'
        ? operation.intent.operationType !== 'integration' : operation.intent.operationType !== 'feature_final_commit')))) {
      throw new PublicError('not_found', envelope.operation);
    }
    if (feature.revision !== envelope.expectedRevision) {
      throw new PublicError('conflict', envelope.operation, undefined, { details: { reason: 'feature_revision_conflict' } });
    }
    if (envelope.operation === 'feature.verification.continue') {
      // An uncertain intent can only enter the explicit read-only reconciliation
      // route; it is never sent back to commit, even after a transport crash.
      if (operation?.status === 'pending') throw new PublicError('conflict', envelope.operation,
        undefined, { details: { reason: 'reconciliation_required' } });
      const intent = checkedIntent({ projectId, ...envelope.payload });
      if (operation && intent.codeDigest !== operation.intent.codeDigest) {
        throw new PublicError('conflict', envelope.operation, undefined, { details: { reason: 'intent_conflict' } });
      }
    }
    // Recovery may inspect an uncertain operation after its execution budget expires.
    if (envelope.operation === 'feature.verification.continue' && (!operation || operation.status === 'pending')
      && (batch.deadlineAtUtcMs <= nowUtcMs()
      || (run.startedAtUtcMs !== null && run.startedAtUtcMs + run.runTimeLimitMs <= nowUtcMs()))) {
      throw new PublicError('conflict', envelope.operation, undefined, { details: { reason: 'deadline_exceeded' } });
    }
  }

  async function execute(principal: TrustedPrincipal, envelope: FeatureDeliveryEnvelope, digest: string) {
    const replayed = store.transact(envelope.operation, transaction => {
      const receipt = original(principal, envelope, digest, transaction);
      if (receipt) return receipt;
      const timing = evaluateCommandTiming(envelope, nowUtcMs());
      if (timing.kind !== 'fresh') {
        throw new PublicError(timing.kind === 'expired' ? 'command_expired' : 'invalid_input', envelope.operation);
      }
      // Project-scoped receipts require an existing project FK. Missing projects
      // follow the existing command channel's lookup error without persisting.
      transaction.getProject(envelope.scope.projectId);
      try { assertTarget(transaction, envelope); }
      catch (error) {
        const publicError = mapToPublicError(error, { operation: envelope.operation });
        if (!['conflict', 'not_found', 'forbidden'].includes(publicError.code)) throw publicError;
        const rejected = createRejectedReceipt({ principalId: principal.principalId,
          commandId: envelope.commandId, operation: envelope.operation, scope: envelope.scope,
          requestDigest: digest, issuedAt: envelope.issuedAt, completedAt: new Date(nowUtcMs()).toISOString(),
          error: publicError });
        transaction.saveReceipt(rejected);
        return rejected;
      }
      return undefined;
    });
    if (replayed) return replayed;
    // No SQLite transaction spans external I/O. Git's durable intent/receipt, not
    // this transport receipt, decides whether a lost response may be reconciled.
    const input = { projectId: envelope.scope.projectId, ...envelope.payload };
    const result = envelope.operation === 'feature.verification.continue'
      ? await finalization.finalize(input)
      : envelope.operation === 'git.operation.start'
        ? (deps.integrationStart === undefined ? (() => { throw new PublicError('unsupported', envelope.operation); })() : await deps.integrationStart.start({ ...input, expectedRevision: envelope.expectedRevision, inputDigest: (input as { inputDigest: string }).inputDigest, commandId: envelope.commandId }))
        : await deps.reconciliation.reconcile({ projectId: input.projectId, operationId: input.operationId });
    return store.transact(envelope.operation, transaction => {
      const receipt = original(principal, envelope, digest, transaction);
      if (receipt) return receipt;
      const delivery = envelope.operation === 'feature.verification.continue'
        ? result as Awaited<ReturnType<typeof finalization.finalize>> : null;
      const starting = envelope.operation === 'git.operation.start'
        ? result as Awaited<ReturnType<NonNullable<FeatureDeliveryDependencies['integrationStart']>['start']>> : null;
      const reconciliation = delivery === null && starting === null
        ? result as Awaited<ReturnType<GitCommitReconciliationService['reconcile']>> : null;
      // Keep command and Git operation identities separate; don't expose native
      // paths, Git user configuration or internal authorization in public results.
      const completed = createCompletedReceipt({ principalId: principal.principalId,
        commandId: envelope.commandId, operation: envelope.operation, scope: envelope.scope,
        requestDigest: digest, issuedAt: envelope.issuedAt, completedAt: new Date(nowUtcMs()).toISOString(),
        resultRef: createResultRef(randomBytes(32)), result: {
          featureId: input.featureId, runId: input.runId, batchId: input.batchId,
          gitOperationId: input.operationId,
          outcome: delivery?.outcome ?? starting?.outcome ?? reconciliation!.outcome,
          reason: delivery?.reason ?? starting?.reason ?? reconciliation!.reasonCode,
          deliveryStatus: delivery?.deliveryStatus ?? reconciliation?.operation.deliveryStatus ?? null,
          runtimeCalled: false, executionStarted: envelope.operation === 'git.operation.start',
        } });
      transaction.saveReceipt(completed);
      return completed;
    });
  }

  return {
    activity: {
      enterQuiesce() { accepting = false; return { accepted: commands.size }; },
      async awaitQuiesce(budgetMs: number) {
        if (commands.size === 0) return { confirmed: true, pending: [] };
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled([...commands.values()].map(command => command.promise)),
            new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, budgetMs)); }),
          ]);
          return { confirmed: commands.size === 0, pending: commands.size === 0 ? [] : ['feature_delivery_in_progress'] };
        } finally { if (timer !== undefined) clearTimeout(timer); }
      },
    },
    async submit(principal: TrustedPrincipal, envelope: FeatureDeliveryEnvelope, digest: string): Promise<CommandReceipt> {
      authorizeCommand(principal, envelope);
      const commandKey = JSON.stringify([principal.principalId, envelope.commandId]);
      const pending = commands.get(commandKey);
      if (pending) {
        if (pending.digest !== digest) throw new PublicError('conflict', envelope.operation,
          undefined, { details: { reason: 'idempotency_key_reuse' } });
        return { ...await pending.promise, replayed: true };
      }
      if (!accepting) {
        const receipt = store.transact(envelope.operation, transaction => original(principal, envelope, digest, transaction));
        if (receipt) return receipt;
        throw new PublicError('resource_busy', envelope.operation, undefined, { details: { reason: 'host_quiescing' } });
      }
      // Serializes different command IDs for the same Feature, too. Once the
      // first command changes its revision a stale second command cannot do I/O.
      const targetKey = JSON.stringify([envelope.scope.projectId, envelope.payload.featureId]);
      const previous = targets.get(targetKey);
      const promise = (async () => {
        if (previous) { try { await previous; } catch { /* recheck durable facts below */ } }
        return execute(principal, envelope, digest);
      })();
      commands.set(commandKey, { digest, promise });
      targets.set(targetKey, promise);
      try { return await promise; }
      finally {
        commands.delete(commandKey);
        if (targets.get(targetKey) === promise) targets.delete(targetKey);
      }
    },
  };
}
