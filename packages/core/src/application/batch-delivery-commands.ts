import { randomBytes } from 'node:crypto';
import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
import { authorizeCommand, authorizeCommandReplay, type TrustedPrincipal } from '../ports/authorization.js';
import { createCompletedReceipt, createRejectedReceipt, evaluateCommandTiming, mapToPublicError, PublicError, type CommandReceipt, type ValidatedCommandEnvelope } from '../ports/commands.js';
import { createResultRef, decideCommandReplay } from '../ports/command-receipts.js';
import { validateBatchDeliveryCommandResult } from '../ports/batch-delivery-commands.js';
import type { BatchDeliveryCommandResult } from '../ports/batch-delivery-commands.js';
import type { BatchFinalizationCandidate, BatchLeafFinalizationService } from './batch-leaf-finalization.js';
import type { PhaseDeliveryApprovalService } from './phase-delivery-approval.js';
import type { DeliveryActivity } from './command-service.js';

export interface BatchDeliveryDependencies {
  /** Services retain their durable candidate/CAS, Git journal and evidence gates. */
  readonly finalization: BatchLeafFinalizationService;
  readonly approval: PhaseDeliveryApprovalService;
}
export type BatchDeliveryFactory = (context: { readonly atomicStore: AtomicCommandStore }) => BatchDeliveryDependencies;
export type BatchDeliveryEnvelope = Extract<ValidatedCommandEnvelope, { operation: 'execution.batch.finalize' | 'phase.delivery.approve' }>;

function conflict(envelope: BatchDeliveryEnvelope, reason: string): never {
  throw new PublicError('conflict', envelope.operation, undefined, { details: { reason } });
}

/** No transaction spans integration or verification. Candidate journals own recovery. */
export function createBatchDeliveryCommandHandler(options: {
  readonly atomicStore: AtomicCommandStore;
  readonly dependencies: BatchDeliveryDependencies;
  readonly nowUtcMs: () => number;
}) {
  const { atomicStore: store, dependencies: deps, nowUtcMs } = options;
  if (typeof deps?.finalization?.run !== 'function' || typeof deps.approval?.approve !== 'function') {
    throw new TypeError('Batch delivery requires trusted finalization and approval services');
  }
  let accepting = true;
  const commands = new Map<string, { digest: string; promise: Promise<CommandReceipt> }>();
  const targets = new Map<string, Promise<unknown>>();
  function replay(principal: TrustedPrincipal, envelope: BatchDeliveryEnvelope, digest: string, tx: CommandTransaction) {
    authorizeCommand(principal, envelope);
    const existing = tx.findReceipt(principal.principalId, envelope.commandId);
    if (existing) authorizeCommandReplay(principal, existing, null, envelope.operation);
    const decision = decideCommandReplay(existing, digest, envelope.operation);
    return decision.kind === 'replay' ? decision.receipt : undefined;
  }
  function assertTarget(tx: CommandTransaction, envelope: BatchDeliveryEnvelope) {
    const batch = tx.getExecutionBatch(envelope.scope.projectId, envelope.payload.batchId);
    if (batch.phaseId !== envelope.payload.phaseId) throw new PublicError('not_found', envelope.operation);
    if (batch.revision !== envelope.expectedRevision) conflict(envelope, 'stale_revision');
    return batch;
  }
  function identity(principal: TrustedPrincipal, envelope: BatchDeliveryEnvelope, digest: string) {
    return { principalId: principal.principalId, commandId: envelope.commandId, operation: envelope.operation,
      scope: envelope.scope, requestDigest: digest, issuedAt: envelope.issuedAt, completedAt: new Date(nowUtcMs()).toISOString() };
  }
  function rejection(principal: TrustedPrincipal, envelope: BatchDeliveryEnvelope, digest: string, error: unknown) {
    return store.transact(envelope.operation, tx => {
      const previous = replay(principal, envelope, digest, tx); if (previous) return previous;
      const receipt = createRejectedReceipt({ ...identity(principal, envelope, digest), error: mapToPublicError(error, { operation: envelope.operation }) });
      tx.saveReceipt(receipt); return receipt;
    });
  }
  function candidateResult(envelope: BatchDeliveryEnvelope, candidate: BatchFinalizationCandidate): BatchDeliveryCommandResult {
    const batch = store.transact(envelope.operation, tx => assertTarget(tx, envelope));
    const members = batch.scopeSnapshot.featureIds as readonly string[];
    if (!Array.isArray(members) || candidate.leafFeatureIds.some(id => !members.includes(id))) conflict(envelope, 'candidate_identity_mismatch');
    const integration = candidate.integration; const verification = candidate.verification;
    if (candidate.projectId !== envelope.scope.projectId || candidate.phaseId !== envelope.payload.phaseId || candidate.batchId !== envelope.payload.batchId
      || candidate.batchRevision !== envelope.expectedRevision) conflict(envelope, 'candidate_identity_mismatch');
    if (candidate.status !== 'ready_for_phase_approval' || integration?.status !== 'succeeded' || verification?.status !== 'passed'
      || !integration.commitSha || !integration.treeSha || !integration.evidenceId || !integration.evidenceDigest || !verification.evidenceId || !verification.evidenceDigest) conflict(envelope, 'integration_not_verified');
    return { schemaVersion: 1, projectId: candidate.projectId, phaseId: candidate.phaseId, batchId: candidate.batchId, batchRevision: candidate.batchRevision,
      candidateId: candidate.candidateId, candidateRevision: candidate.revision, status: 'ready_for_phase_approval', featureIds: [...candidate.leafFeatureIds],
      scopeDigest: candidate.scopeDigest, inputDigest: candidate.inputDigest, integrationCommitSha: integration.commitSha, integrationTreeSha: integration.treeSha,
      integrationEvidenceId: integration.evidenceId, integrationEvidenceDigest: integration.evidenceDigest,
      verificationEvidenceId: verification.evidenceId, verificationEvidenceDigest: verification.evidenceDigest, approvalId: null, summaryDigest: null };
  }
  async function execute(principal: TrustedPrincipal, envelope: BatchDeliveryEnvelope, digest: string): Promise<CommandReceipt> {
    const previous = store.transact(envelope.operation, tx => {
      const previous = replay(principal, envelope, digest, tx); if (previous) return previous;
      const timing = evaluateCommandTiming(envelope, nowUtcMs());
      if (timing.kind !== 'fresh') throw new PublicError(timing.kind === 'expired' ? 'command_expired' : 'invalid_input', envelope.operation);
      tx.getProject(envelope.scope.projectId);
      return undefined;
    });
    if (previous) return previous;
    let result: BatchDeliveryCommandResult;
    try {
      store.transact(envelope.operation, tx => assertTarget(tx, envelope));
      if (envelope.operation === 'execution.batch.finalize') {
        const finalized = await deps.finalization.run({ projectId: envelope.scope.projectId, batchId: envelope.payload.batchId,
          commandId: envelope.commandId, expectedBatchRevision: envelope.expectedRevision, phaseId: envelope.payload.phaseId });
        if (finalized.status !== 'ready_for_phase_approval' || !finalized.candidate) {
          const reasons = finalized.blockReasons;
          const reason = reasons.some(r => r.includes('conflict')) ? 'integration_conflict'
            : reasons.includes('manual_block') ? 'manual_block'
            : reasons.includes('budget_exhausted') ? 'budget_exhausted'
            : finalized.status === 'reconciliation_required' ? 'reconciliation_required'
            : reasons.includes('stale_revision') ? 'stale_revision' : 'batch_finalization_blocked';
          conflict(envelope, reason);
        }
        result = candidateResult(envelope, finalized.candidate);
      } else {
        const approved = await deps.approval.approve({ projectId: envelope.scope.projectId, ...envelope.payload,
          commandId: envelope.commandId, actorId: principal.principalId, expectedBatchRevision: envelope.expectedRevision,
          commandContext: { requestDigest: digest, issuedAt: envelope.issuedAt } });
        if (approved.status === 'rejected') conflict(envelope, approved.reason);
        const approval = approved.approval;
        if (approval.projectId !== envelope.scope.projectId || approval.phaseId !== envelope.payload.phaseId || approval.batchId !== envelope.payload.batchId
          || approval.candidateId !== envelope.payload.candidateId || approval.candidateRevision !== envelope.payload.expectedCandidateRevision
          || approval.batchRevision !== envelope.expectedRevision || approval.status !== 'approved') conflict(envelope, 'candidate_identity_mismatch');
        result = { schemaVersion: 1, projectId: approval.projectId, phaseId: approval.phaseId, batchId: approval.batchId,
          batchRevision: approval.batchRevision, candidateId: approval.candidateId, candidateRevision: approval.candidateRevision,
          status: 'approved', featureIds: store.transact(envelope.operation, tx => [...assertTarget(tx, envelope).scopeSnapshot.featureIds as string[]]), scopeDigest: approval.scopeDigest, inputDigest: approval.inputDigest,
          integrationCommitSha: approval.integrationCommitSha, integrationTreeSha: approval.integrationTreeSha,
          integrationEvidenceId: approval.integrationEvidenceId, integrationEvidenceDigest: approval.integrationEvidenceDigest,
          verificationEvidenceId: approval.verificationEvidenceId, verificationEvidenceDigest: approval.verificationEvidenceDigest,
          approvalId: approval.approvalId, summaryDigest: approval.summaryDigest };
      }
      validateBatchDeliveryCommandResult(result);
    } catch (error) { return rejection(principal, envelope, digest, error); }
    return store.transact(envelope.operation, tx => {
      const previous = replay(principal, envelope, digest, tx); if (previous) return { ...previous, replayed: false };
      // Recheck current Batch CAS after external work; stale results never become success.
      try { assertTarget(tx, envelope); }
      catch (error) {
        const receipt = createRejectedReceipt({ ...identity(principal, envelope, digest), error: mapToPublicError(error, { operation: envelope.operation }) });
        tx.saveReceipt(receipt); return receipt;
      }
      const receipt = createCompletedReceipt({ ...identity(principal, envelope, digest), resultRef: createResultRef(randomBytes(32)), result });
      tx.saveReceipt(receipt); return receipt;
    });
  }
  const activity: DeliveryActivity = {
    enterQuiesce() { accepting = false; return { accepted: commands.size }; },
    async awaitQuiesce(budgetMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (commands.size) await Promise.race([Promise.allSettled([...commands.values()].map(c => c.promise)), new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, budgetMs)); })]);
        return { confirmed: commands.size === 0, pending: commands.size ? ['batch_delivery_in_progress'] : [] };
      } finally { if (timer !== undefined) clearTimeout(timer); }
    },
  };
  return { activity, async submit(principal: TrustedPrincipal, envelope: BatchDeliveryEnvelope, digest: string) {
    authorizeCommand(principal, envelope);
    const key = JSON.stringify([principal.principalId, envelope.commandId]);
    const pending = commands.get(key);
    if (pending) {
      if (pending.digest !== digest) conflict(envelope, 'idempotency_key_reuse');
      return { ...await pending.promise, replayed: true };
    }
    if (!accepting) {
      const previous = store.transact(envelope.operation, tx => replay(principal, envelope, digest, tx));
      if (previous) return previous;
      throw new PublicError('resource_busy', envelope.operation, undefined, { details: { reason: 'host_quiescing' } });
    }
    const target = JSON.stringify([envelope.scope.projectId, envelope.payload.batchId]);
    const before = targets.get(target);
    const promise = (async () => { if (before) await before.catch(() => undefined); return execute(principal, envelope, digest); })();
    commands.set(key, { digest, promise }); targets.set(target, promise);
    try { return await promise; }
    finally { commands.delete(key); if (targets.get(target) === promise) targets.delete(target); }
  } };
}
