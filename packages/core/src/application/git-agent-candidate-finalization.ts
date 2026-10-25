import type { GitCommitAuthorization, GitCommitFacts, ControlledGitCommitService } from '../ports/controlled-git-commit.js';
import { gitOperationCommitMessage } from '../ports/controlled-git-commit.js';
import type { GitCommitReconciliationService } from '../ports/git-commit-reconciliation.js';
import type { GitOperationRecord, GitOperationStore, GitOperationEvidenceRef } from '../ports/git-operations.js';
import type { GitAgentRepairHold, GitAgentRepairView } from '../ports/git-agent-repair-store.js';
import type { WorkspaceBaseline } from '../ports/workspace.js';
import type { WorkspaceInspection, WorkspaceInspector } from '../ports/workspace-inspector.js';
import type { GitCommitDriver } from '../ports/controlled-git-commit.js';
import type { GitAgentRepairRuntimeOutput } from '../ports/git-agent-repair.js';
import { StorageError } from '../ports/errors.js';
import { validateStableId } from '../ports/validation.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const OPERATION = 'GitAgentCandidateFinalization';
const SHA256 = /^[0-9a-f]{64}$/;

type CandidateRequest = { readonly projectId: string; readonly repairId: string; readonly attemptId: string };
type CandidateAttempt = GitAgentRepairView['attempts'][number];

export interface GitAgentCandidateVerificationInput {
  readonly request: GitAgentRepairView['request'];
  readonly attempt: CandidateAttempt;
  readonly output: GitAgentRepairRuntimeOutput;
  readonly baseline: WorkspaceBaseline;
  readonly inspection: WorkspaceInspection;
  readonly facts: GitCommitFacts;
  readonly changedPaths: readonly string[];
  readonly deletedPaths: readonly string[];
}

export interface GitAgentCandidateVerificationResult {
  readonly outcome: 'passed' | 'failed' | 'blocked';
  /** This evidence is produced by the Core verifier, never copied from Runtime. */
  readonly evidence: GitOperationEvidenceRef | null;
  readonly reason: string | null;
  readonly hold: GitAgentRepairHold | null;
}

export interface GitAgentCandidateAuthorizationContext {
  readonly repair: GitAgentRepairView;
  readonly attempt: CandidateAttempt;
  readonly output: GitAgentRepairRuntimeOutput;
  readonly baseline: WorkspaceBaseline;
  readonly inspection: WorkspaceInspection;
  readonly facts: GitCommitFacts;
  readonly verification: GitAgentCandidateVerificationResult;
  readonly operationId: string;
}

export interface GitAgentCandidateFinalizationResult {
  readonly outcome: 'committed' | 'no_change' | 'blocked' | 'failed' | 'pending' | 'unknown';
  readonly reason: string | null;
  readonly operation: GitOperationRecord | null;
  /** Only a verified succeeded operation can make a successor eligible. */
  readonly successorUnlocked: boolean;
}

export interface GitAgentCandidateFinalizationDependencies {
  readonly repair: {
    read(projectId: string, repairId: string): GitAgentRepairView;
    hold(projectId: string, repairId: string, reason: GitAgentRepairHold): unknown;
  };
  readonly inspector: WorkspaceInspector;
  readonly driver: GitCommitDriver;
  readonly readBaseline: (request: CandidateRequest, repair: GitAgentRepairView) => WorkspaceBaseline;
  /** Trusted Core assembly. This callback is never populated from Runtime output. */
  readonly readAuthorization: (context: GitAgentCandidateAuthorizationContext) => GitCommitAuthorization;
  readonly verify: (input: GitAgentCandidateVerificationInput) => Promise<GitAgentCandidateVerificationResult>;
  readonly commit: ControlledGitCommitService;
  readonly operations: Pick<GitOperationStore, 'getGitOperation'>;
  readonly reconciliation?: GitCommitReconciliationService;
}

function operationIdDigest(repairId: string): string {
  const digest = createHash('sha256').update(`shiploop:git-agent-repair-commit:v1\n${repairId}`, 'utf8').digest('hex').slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${((Number.parseInt(digest.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')}${digest.slice(18, 20)}-${digest.slice(20)}`;
}

/** Stable Core identity: replaying a repair must address the same operation intent. */
export function gitAgentRepairCommitOperationId(repairId: string): string {
  validateStableId(repairId, { operation: OPERATION }, 'repairId');
  return operationIdDigest(repairId);
}

function result(outcome: GitAgentCandidateFinalizationResult['outcome'], reason: string | null, operation: GitOperationRecord | null, successorUnlocked = false): GitAgentCandidateFinalizationResult {
  return { outcome, reason, operation, successorUnlocked };
}

function readOperation(deps: GitAgentCandidateFinalizationDependencies, projectId: string, operationId: string): GitOperationRecord | null {
  try { return deps.operations.getGitOperation(projectId, operationId); }
  catch (error) {
    if (error instanceof StorageError && error.kind === 'not_found') return null;
    throw error;
  }
}

function holdFor(deps: GitAgentCandidateFinalizationDependencies, request: CandidateRequest, reason: GitAgentRepairHold | null): void {
  if (reason !== null) deps.repair.hold(request.projectId, request.repairId, reason);
}

function decodeStatus(inspection: WorkspaceInspection): { readonly paths: readonly string[]; readonly unresolved: boolean; readonly deleted: readonly string[] } {
  const raw = Buffer.from(inspection.statusPorcelainBase64, 'base64').toString('utf8');
  const records = raw.split('\0').filter(Boolean);
  const paths: string[] = [];
  const deleted: string[] = [];
  let unresolved = false;
  for (const record of records) {
    if (record.length < 3 || record[2] !== ' ') return { paths: [], unresolved: true, deleted: [] };
    const state = record.slice(0, 2);
    const path = record.slice(3);
    if (path.length === 0 || path.includes('\0')) return { paths: [], unresolved: true, deleted: [] };
    if (state.includes('U') || state === 'AA' || state === 'DD') unresolved = true;
    if (state.includes('D')) deleted.push(path);
    paths.push(path);
    // Porcelain -z represents a rename/copy as two path records. It is not a
    // safe exact candidate contract because Runtime reports one path identity.
    if (state.includes('R') || state.includes('C')) unresolved = true;
  }
  const deletedPaths = new Set<string>(inspection.contents.tracked.filter(entry => entry.state === 'deleted').map(entry => entry.path));
  for (const path of deleted) deletedPaths.add(path);
  return { paths: [...new Set(paths)].sort(), unresolved, deleted: [...deletedPaths].sort() };
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return isDeepStrictEqual([...left].sort(), [...right].sort());
}

function operationOutcome(operation: GitOperationRecord): GitAgentCandidateFinalizationResult['outcome'] {
  switch (operation.status) {
    case 'succeeded': return 'committed';
    case 'no_change': return 'no_change';
    case 'failed': return 'failed';
    case 'pending': return 'pending';
    case 'unknown': return 'unknown';
  }
}

async function verifySuccess(
  deps: GitAgentCandidateFinalizationDependencies,
  operation: GitOperationRecord,
  baseline: WorkspaceBaseline,
): Promise<boolean> {
  if (operation.status !== 'succeeded' || operation.actualCommit === null || operation.actualTree === null) {
    if (operation.status !== 'no_change') return false;
    const facts = await deps.driver.open(baseline, () => undefined).facts();
    return facts.head === operation.intent.expectedHead && facts.tree === operation.actualTree;
  }
  const session = deps.driver.open(baseline, () => undefined);
  const facts = await session.facts();
  const expectedMessage = gitOperationCommitMessage(operation.intent.message, operation.intent.operationId);
  return facts.head === operation.actualCommit && facts.tree === operation.actualTree
    && facts.parents.length === 1 && facts.parents[0] === operation.intent.expectedHead
    && facts.message === expectedMessage
    && isDeepStrictEqual(facts.author, { name: operation.intent.gitIdentity.name, email: operation.intent.gitIdentity.email })
    && isDeepStrictEqual(facts.committer, facts.author);
}

function validateAuthorization(
  authorization: GitCommitAuthorization,
  context: GitAgentCandidateAuthorizationContext,
  changedPaths: readonly string[],
): string | null {
  const intent = authorization.intent;
  if (intent.operationId !== context.operationId) return 'operation_identity_mismatch';
  if (intent.projectId !== context.repair.request.projectId || intent.operationType !== 'feature_final_commit') return 'operation_identity_mismatch';
  if (intent.repoIdentity !== context.repair.request.target.repoIdentity
    || authorization.baseline.repoIdentity !== context.repair.request.target.repoIdentity
    || authorization.baseline.baseCommit !== context.repair.request.target.baselineCommitSha) return 'target_identity_mismatch';
  if (intent.expectedHead !== context.facts.head || authorization.baseline.canonicalPath !== intent.worktreePath) return 'head_drift';
  if (!samePaths(authorization.allowedPaths, changedPaths)) return 'authorization_scope_mismatch';
  if (authorization.verificationPassed !== true || authorization.approvalCurrent !== true
    || authorization.finalApprovalCurrent === false || authorization.commitAuthorized !== true) return 'authorization_not_current';
  const evidence = context.verification.evidence;
  if (evidence === null || !SHA256.test(evidence.digest) || !authorization.intent.verificationRefs.some(ref => isDeepStrictEqual(ref, evidence))) return 'verification_evidence_missing';
  if (intent.integrationPlan !== null && intent.integrationPlan !== undefined
    && (intent.integrationPlan.target.baseCommit !== context.repair.request.target.baselineCommitSha
      || intent.integrationPlan.target.repoIdentity !== context.repair.request.target.repoIdentity
      || intent.integrationPlan.inputDigest !== context.repair.request.source.inputDigest)) return 'integration_input_changed';
  return null;
}

function failureReasonHold(reason: string): GitAgentRepairHold {
  if (reason === 'high_risk_delete' || reason === 'requirements_tradeoff' || reason === 'public_contract_break') return reason;
  if (reason === 'stop_unconfirmed' || reason === 'identity_or_lock' || reason === 'head_drift'
    || reason === 'target_identity_mismatch' || reason === 'authorization_not_current') return 'identity_or_lock';
  if (reason === 'budget_exhausted') return reason;
  return reason.startsWith('candidate_') || reason.includes('scope') ? 'out_of_scope' : 'invalid_runtime_output';
}

/**
 * Core-only candidate裁决。It never accepts a Runtime "passed" field, never
 * stages or resolves conflicts itself, and delegates the sole Git write to the
 * existing controlled commit service.
 */
export function createGitAgentCandidateFinalizationService(deps: GitAgentCandidateFinalizationDependencies) {
  if (!deps || !deps.repair || typeof deps.repair.read !== 'function' || typeof deps.repair.hold !== 'function'
    || typeof deps.inspector?.inspect !== 'function' || typeof deps.driver?.open !== 'function'
    || typeof deps.readBaseline !== 'function' || typeof deps.readAuthorization !== 'function'
    || typeof deps.verify !== 'function' || typeof deps.commit?.commit !== 'function'
    || typeof deps.operations?.getGitOperation !== 'function') throw new TypeError(`${OPERATION}: dependencies missing`);

  async function settleExisting(
    request: CandidateRequest,
    operation: GitOperationRecord,
    baseline: WorkspaceBaseline,
  ): Promise<GitAgentCandidateFinalizationResult> {
    if (operation.status === 'pending' && deps.reconciliation) {
      const reconciled = await deps.reconciliation.reconcile({ projectId: request.projectId, operationId: operation.intent.operationId });
      if (reconciled.outcome === 'matched' && reconciled.operation.status === 'succeeded') {
        if (!await verifySuccess(deps, reconciled.operation, baseline)) {
          holdFor(deps, request, 'identity_or_lock');
          return result('unknown', 'commit_facts_mismatch', reconciled.operation);
        }
        return result('committed', null, reconciled.operation, true);
      }
      const mapped = operationOutcome(reconciled.operation);
      if (mapped === 'failed') holdFor(deps, request, 'identity_or_lock');
      return result(mapped, reconciled.reasonCode, reconciled.operation);
    }
    if (operation.status === 'succeeded' && !await verifySuccess(deps, operation, baseline)) {
      holdFor(deps, request, 'identity_or_lock');
      return result('unknown', 'commit_facts_mismatch', operation);
    }
    return result(operationOutcome(operation), operation.reasonCode, operation, operation.status === 'succeeded');
  }

  return {
    async finalize(rawRequest: CandidateRequest): Promise<GitAgentCandidateFinalizationResult> {
      validateStableId(rawRequest.projectId, { operation: OPERATION }, 'projectId');
      validateStableId(rawRequest.repairId, { operation: OPERATION }, 'repairId');
      validateStableId(rawRequest.attemptId, { operation: OPERATION }, 'attemptId');
      const request = rawRequest;
      const operationId = gitAgentRepairCommitOperationId(request.repairId);
      const repair = deps.repair.read(request.projectId, request.repairId);
      const baseline = deps.readBaseline(request, repair);
      const existing = readOperation(deps, request.projectId, operationId);
      if (existing !== null) return settleExisting(request, existing, baseline);
      if (repair.blockedReason !== null) return result('blocked', repair.blockedReason, null);
      if (repair.request.projectId !== request.projectId || repair.request.repairId !== request.repairId) {
        holdFor(deps, request, 'identity_or_lock');
        return result('blocked', 'repair_identity_mismatch', null);
      }
      const attempt = repair.attempts.find(item => item.id === request.attemptId);
      if (!attempt || attempt.stoppedAtUtcMs === null || attempt.output === null) return result('blocked', 'candidate_not_stopped', null);
      const output = attempt.output;
      if (output.status !== 'modified' && output.status !== 'no_change') {
        holdFor(deps, request, 'invalid_runtime_output');
        return result('blocked', 'runtime_not_successful', null);
      }
      const inspection = await deps.inspector.inspect(baseline);
      const factsSession = deps.driver.open(baseline, () => undefined);
      const facts = await factsSession.facts();
      if (baseline.baseCommit !== repair.request.target.baselineCommitSha
        || baseline.repoIdentity !== repair.request.target.repoIdentity
        || inspection.repository.repoIdentity !== repair.request.target.repoIdentity
        || inspection.repository.headCommit !== facts.head
        || !(await factsSession.isAncestor(repair.request.target.baselineCommitSha, facts.head))) {
        holdFor(deps, request, 'identity_or_lock');
        return result('blocked', 'target_or_head_drift', null);
      }
      const status = decodeStatus(inspection);
      const changedPaths = [...new Set(output.changedPaths)].sort();
      const observedPaths = new Set([...inspection.contents.tracked, ...inspection.contents.untracked, ...inspection.contents.ignored].map(entry => entry.path));
      const deletionCandidate = status.deleted.length > 0 || changedPaths.some(path => !observedPaths.has(path));
      if (status.unresolved || deletionCandidate || (output.status === 'no_change' && status.paths.length !== 0)
        || (output.status === 'modified' && (!samePaths(status.paths, changedPaths) || changedPaths.length === 0))
        || changedPaths.some(path => !repair.request.writablePaths.includes(path))) {
        holdFor(deps, request, deletionCandidate ? 'high_risk_delete' : 'out_of_scope');
        return result('blocked', status.unresolved ? 'unresolved_conflict' : deletionCandidate ? 'high_risk_delete' : 'candidate_scope_mismatch', null);
      }
      const verification = await deps.verify({ request: repair.request, attempt, output, baseline, inspection, facts,
        changedPaths, deletedPaths: status.deleted });
      if (verification.outcome !== 'passed' || verification.evidence === null) {
        const hold = verification.hold ?? 'invalid_runtime_output';
        holdFor(deps, request, hold);
        return result('blocked', verification.reason ?? 'verification_failed', null);
      }
      const afterVerification = await deps.inspector.inspect(baseline);
      const afterFactsSession = deps.driver.open(baseline, () => undefined);
      const afterFacts = await afterFactsSession.facts();
      const afterStatus = decodeStatus(afterVerification);
      if (afterFacts.head !== facts.head || afterVerification.repository.headCommit !== afterFacts.head
        || afterStatus.unresolved || !samePaths(afterStatus.paths, changedPaths)
        || !samePaths(afterStatus.deleted, status.deleted)) {
        holdFor(deps, request, 'identity_or_lock');
        return result('blocked', 'candidate_changed_during_verification', null);
      }
      const verificationContext: GitAgentCandidateAuthorizationContext = {
        repair, attempt, output, baseline, inspection: afterVerification, facts: afterFacts, verification, operationId,
      };
      let authorization: GitCommitAuthorization;
      try { authorization = deps.readAuthorization(verificationContext); }
      catch {
        holdFor(deps, request, 'identity_or_lock');
        return result('blocked', 'authorization_not_current', null);
      }
      const authorizationError = validateAuthorization(authorization, verificationContext, changedPaths);
      if (authorizationError !== null) {
        holdFor(deps, request, failureReasonHold(authorizationError));
        return result('blocked', authorizationError, null);
      }
      let operation: GitOperationRecord;
      try {
        operation = await deps.commit.commit({ projectId: request.projectId, operationId });
      } catch (error) {
        const observed = readOperation(deps, request.projectId, operationId);
        if (observed?.status === 'pending' && deps.reconciliation) return settleExisting(request, observed, baseline);
        const reason = error instanceof StorageError ? String(error.details?.reason ?? error.message) : error instanceof Error ? error.message : 'commit_failed';
        if (observed?.status === 'failed') holdFor(deps, request, 'identity_or_lock');
        return result(observed ? operationOutcome(observed) : 'failed', reason, observed);
      }
      if (operation.status === 'succeeded') {
        if (!await verifySuccess(deps, operation, baseline)) {
          holdFor(deps, request, 'identity_or_lock');
          return result('unknown', 'commit_facts_mismatch', operation);
        }
        return result('committed', null, operation, true);
      }
      if (operation.status === 'failed' || operation.status === 'unknown') holdFor(deps, request, 'identity_or_lock');
      return result(operationOutcome(operation), operation.reasonCode, operation);
    },
  };
}

export type GitAgentCandidateFinalizationService = ReturnType<typeof createGitAgentCandidateFinalizationService>;
