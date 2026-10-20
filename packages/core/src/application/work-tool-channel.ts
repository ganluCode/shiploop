/** Core-owned Work tool bridge. Never pass these dependencies or bind/revoke to a Runner. */
import { randomBytes } from 'node:crypto';
import { assertTrustedPrincipal, requireCapability, requireProjectVisible } from '../ports/authorization.js';
import {
  PublicError, WORK_TOOL_OPERATION_SPECS, validateCommandEnvelopeFields, evaluateCommandTiming,
  createCompletedReceipt, createRejectedReceipt,
} from '../ports/commands.js';
import type { CommandReceipt } from '../ports/commands.js';
import { computeCommandRequestDigest, createResultRef, decideCommandReplay, stableCanonicalJson } from '../ports/command-receipts.js';
import { buildWorkAccessManifest, validateWorkAccessConfiguration } from '../ports/work-access.js';
import type { WorkAccessBinding, WorkAccessContext, WorkAccessOperation } from '../ports/work-access.js';
import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
import type { AttemptStore } from '../ports/attempt-store.js';
import type { TaskDagStore } from '../ports/task-dag.js';
import type { ArtifactVerifier } from './artifact-verify.js';
import type { VerificationCandidateValidator } from './verification-candidates.js';
import type { TestCandidateValidationInput } from '../ports/verification-candidates.js';
import { requirePlainObject, rejectUnknownKeys, validateStableId } from '../ports/validation.js';

export interface WorkToolChannelDeps {
  /** All synchronous readers must share the atomicStore connection/transaction. */
  readonly atomicStore: AtomicCommandStore;
  readonly attempts: Pick<AttemptStore, 'getAttempt'>;
  readonly dag: TaskDagStore;
  /** Trusted live Host/Core authority: null revokes the grant. Never derive this from a request/sessionId. */
  readonly currentBinding: (context: WorkAccessContext) => WorkAccessBinding | null;
  readonly verifier: Pick<ArtifactVerifier, 'readVerifiedContent'>;
  readonly candidates: Pick<VerificationCandidateValidator, 'validateCandidates'>;
  /** Approved policy and observed code/workspace, never supplied by the model. */
  readonly candidateContext: (context: WorkAccessContext) => Pick<TestCandidateValidationInput, 'policy' | 'workspaceRoot' | 'codeDigest'>;
}

export interface WorkTaskResult {
  readonly operation: 'task.read';
  readonly task: { readonly id: string; readonly title: string; readonly status: string; readonly acceptance: unknown };
}
export interface WorkToolBridge {
  invoke(request: unknown): Promise<CommandReceipt | WorkTaskResult>;
  /** Host/Core only; in-flight operations recheck before persisting. */
  revoke(): void;
}

function denied(reason: string): never {
  throw new PublicError('forbidden', 'work.tools.invoke', undefined, { details: { reason } });
}

export function createWorkToolChannel(deps: WorkToolChannelDeps) {
  // Host-instance-local grants. Restart requires trusted reissuance; no credentials or owner discovery.
  const grants = new Set<string>();
  return {
    bind(value: unknown, binding: WorkAccessBinding): WorkToolBridge {
      assertTrustedPrincipal(binding.principal);
      const access = buildWorkAccessManifest(value, binding).access;
      const context = access.context;
      Object.freeze(context.identity);
      Object.freeze(context.operations);
      Object.freeze(context);
      if (grants.has(context.grantId)) denied('grant_already_issued');
      let revoked = false;
      function check(transaction: CommandTransaction, operation: WorkAccessOperation) {
        if (revoked) denied('grant_revoked');
        const current = deps.currentBinding(context);
        if (current === null) denied('grant_revoked');
        validateWorkAccessConfiguration(access, current);
        requireCapability(current.principal, 'project.read', operation);
        requireProjectVisible(current.principal, context.projectId, operation);
        if (!context.operations.includes(operation)) denied('operation_denied');
        const attempt = deps.attempts.getAttempt(context.projectId, context.identity.attemptId);
        const run = transaction.getExecutionRun(context.projectId, context.identity.runId);
        const task = transaction.getTask(context.projectId, context.identity.taskId);
        const view = deps.dag.readTaskDagView(context.projectId, run.id);
        const fence = view.facts.find(fact => fact.taskId === task.id);
        if (attempt.runId !== run.id || attempt.taskId !== task.id || attempt.featureId !== task.featureId
          || run.featureId !== task.featureId || attempt.executionVersion !== context.executionVersion
          || fence?.executionVersion !== context.executionVersion
          || attempt.hostInstanceId !== context.hostInstanceId || attempt.invocationId !== context.invocationId) denied('identity_mismatch');
        if (attempt.status !== 'executing' || run.status !== 'running' || view.batch.status !== 'running' || task.status !== 'running'
          || attempt.leaseUntilUtcMs <= current.nowUtcMs) denied('execution_inactive');
        return { current, task };
      }
      // Issue only for a currently executing Work, with authority independent of the declaration.
      deps.atomicStore.transact('work.tools.bind', tx => check(tx, context.operations[0]!));
      grants.add(context.grantId);
      return {
        revoke() { revoked = true; },
        async invoke(input: unknown) {
          const envelope = validateCommandEnvelopeFields(input, WORK_TOOL_OPERATION_SPECS);
          const operation = envelope.operation as WorkAccessOperation;
          const validation = { operation: 'work.tools.invoke' };
          const raw = requirePlainObject(envelope.payload, validation, 'payload');
          rejectUnknownKeys(raw, ['identity', 'invocationId', 'executionVersion', ...(operation === 'task.read' ? [] : ['artifactId'])], validation, 'payload');
          const identity = requirePlainObject(raw.identity, validation, 'payload.identity');
          rejectUnknownKeys(identity, ['purpose', 'runId', 'taskId', 'attemptId'], validation, 'payload.identity');
          if (envelope.scope.kind !== 'project' || envelope.scope.projectId !== context.projectId
            || stableCanonicalJson(identity) !== stableCanonicalJson(context.identity)
            || raw.invocationId !== context.invocationId || raw.executionVersion !== context.executionVersion) denied('identity_mismatch');
          const artifactId = operation === 'task.read' ? null : validateStableId(raw.artifactId, validation, 'payload.artifactId');
          // Snapshot all untrusted values before asynchronous work.
          const normalized = { ...envelope, payload: {
            identity: { ...context.identity }, invocationId: context.invocationId, executionVersion: context.executionVersion,
            ...(artifactId === null ? {} : { artifactId }),
          } };
          const digest = computeCommandRequestDigest(normalized);
          const replay = (tx: CommandTransaction) => {
            check(tx, operation); // includes current grant validity even on replay
            return decideCommandReplay(tx.findReceipt(context.principalId, envelope.commandId), digest, operation);
          };
          const preliminary = deps.atomicStore.transact('work.tools.preflight', tx => {
            const state = check(tx, operation);
            if (operation !== 'task.read') {
              const decision = replay(tx);
              if (decision.kind === 'replay') return decision.receipt;
            }
            const timing = evaluateCommandTiming(envelope, state.current.nowUtcMs);
            if (timing.kind !== 'fresh') throw new PublicError(timing.kind === 'expired' ? 'command_expired' : 'invalid_input', operation);
            if (operation === 'task.read') {
              const { id, title, status, acceptance } = state.task;
              return { operation: 'task.read' as const, task: { id, title, status, acceptance } };
            }
            return null;
          });
          if (preliminary !== null) return preliminary;
          let result: Record<string, unknown>;
          let rejection: string | null = null;
          // Existing managed verifier checks ready/hash/project; caller cannot supply paths or bytes.
          const content = await deps.verifier.readVerifiedContent(context.projectId, artifactId!);
          if (content.projectId !== context.projectId || content.artifactId !== artifactId) denied('artifact_identity_mismatch');
          if (operation === 'candidate.submit') {
            const candidate = await deps.candidates.validateCandidates({
              ...deps.candidateContext(context), projectId: context.projectId, attemptId: context.identity.attemptId,
              executionVersion: context.executionVersion, candidateArtifactId: artifactId,
            });
            if (!candidate.ok) rejection = candidate.reason;
            else if (candidate.artifact.artifactId !== content.artifactId || candidate.artifact.contentHash !== content.contentHash
              || candidate.artifact.sizeBytes !== content.sizeBytes) denied('artifact_identity_mismatch');
            result = candidate.ok ? { candidateDigest: candidate.candidateDigest, moduleCount: candidate.modules.length } : {};
          } else result = {};
          return deps.atomicStore.transact(operation, tx => {
            const decision = replay(tx);
            if (decision.kind === 'replay') return decision.receipt;
            const { current } = check(tx, operation);
            const ref = tx.getArtifactInputRef(context.projectId, artifactId!);
            if (ref.contentHash !== content.contentHash || ref.sizeBytes !== content.sizeBytes) denied('artifact_identity_mismatch');
            const receiptIdentity = {
              principalId: context.principalId, commandId: envelope.commandId, operation,
              scope: envelope.scope, requestDigest: digest, issuedAt: envelope.issuedAt,
              completedAt: new Date(current.nowUtcMs).toISOString(),
            };
            const receipt = rejection === null ? createCompletedReceipt({
              ...receiptIdentity, resultRef: createResultRef(randomBytes(32)),
              result: { ...result, identity: context.identity, invocationId: context.invocationId,
                executionVersion: context.executionVersion, artifact: { artifactId, contentHash: ref.contentHash, sizeBytes: ref.sizeBytes },
                verificationPassed: false },
            }) : createRejectedReceipt({ ...receiptIdentity,
              error: new PublicError('invalid_input', operation, undefined, { details: { reason: rejection } }),
            });
            tx.saveReceipt(receipt); // submission fact and idempotency anchor; no Task/budget/lock mutation
            return receipt;
          });
        },
      };
    },
  };
}
