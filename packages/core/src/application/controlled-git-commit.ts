import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { StorageError } from '../ports/errors.js';
import { isUuidV4 } from '../ports/commands.js';
import { validateStableId } from '../ports/validation.js';
import { validateGitOperationRegisterInput } from '../ports/git-operations.js';
import type { GitOperationStore, GitOperationRecord } from '../ports/git-operations.js';
import { GitCommitProcessError, gitOperationCommitMessage } from '../ports/controlled-git-commit.js';
import type { ControlledGitCommitService, GitCommitAuthorization, GitCommitDriver, GitCommitRequest } from '../ports/controlled-git-commit.js';
import type { GitPublicMetadataLock } from '../ports/git-public-metadata-lock.js';
import type { WorkspaceInspector, WorkspaceInspection } from '../ports/workspace-inspector.js';
import type { WorkResourceAccess, WorkResourceStopVerifier } from '../ports/work-resources.js';
import { verificationCodeIdentity } from '../ports/verification-aggregate.js';

const OP = 'GitCommit.commit';
function fail(reason: string): never {
  throw new StorageError('conflict', OP, reason, { details: { reason } });
}
function safePath(path: string): boolean {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.startsWith('/')
    && !/[\0-\x1f\x7f]/.test(path) && !path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git');
}
/** Unlike verificationCodeIdentity, this comparison survives add/commit and tracked deletion.
 * It covers ALL observed bytes and modes, including non-delivered and ignored files.
 * The persisted intent still carries the original Verifier digest, never this projection.
 */
export function gitCommitSourceDigest(inspection: WorkspaceInspection): string {
  const entries = [...inspection.contents.tracked, ...inspection.contents.untracked, ...inspection.contents.ignored]
    .filter(entry => entry.state === 'present').map(entry => [entry.path, entry.digest, entry.mode])
    .sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function createControlledGitCommitService(deps: {
  readonly operations: GitOperationStore;
  readonly inspector: WorkspaceInspector;
  readonly resources: Pick<WorkResourceAccess, 'read'>;
  readonly stopVerifier: WorkResourceStopVerifier;
  readonly lock: GitPublicMetadataLock;
  readonly driver: GitCommitDriver;
  readonly readAuthorization: (request: GitCommitRequest) => GitCommitAuthorization;
  /** Synchronous write transaction shared with operations and readAuthorization.
   * Use session.transactWrite; no Git, filesystem I/O or awaits inside this callback.
   */
  readonly transact: <T>(callback: () => T) => T;
  /** Trusted assembly must include every Core artifact/data directory inside the worktree. */
  readonly excludedPaths: readonly string[];
  readonly nowMs?: () => number;
}): ControlledGitCommitService {
  const now = deps.nowMs ?? Date.now;
  const exclusions = ['.shiploop', ...deps.excludedPaths];
  if (exclusions.some(path => !safePath(path))) throw new TypeError('Invalid Core exclusion path');
  return { async commit(request) {
    if (!request || Object.keys(request).some(key => !['projectId', 'operationId'].includes(key))) fail('invalid_request');
    validateStableId(request.projectId, { operation: OP }, 'projectId');
    if (!isUuidV4(request.operationId)) fail('invalid_operation_id');
    // A pending operation is never an authorization to repeat an uncertain commit.
    try {
      const previous = deps.operations.getGitOperation(request.projectId, request.operationId);
      if (previous.status === 'pending') fail('reconciliation_required');
      // Replays return historical facts, not a bypass of newly added human blocks/fencing.
      const current = deps.readAuthorization(request);
      const { expectedFeatureRevision: _revision, ...currentIntent } = current.intent;
      if (current.verificationPassed !== true || current.approvalCurrent !== true || current.commitAuthorized !== true
        || !isDeepStrictEqual({ ...currentIntent, candidateTree: previous.intent.candidateTree }, previous.intent)) {
        fail('recorded_operation_not_current');
      }
      return previous;
    } catch (error) {
      if (!(error instanceof StorageError) || error.kind !== 'not_found') throw error;
    }
    const authorization = structuredClone(deps.readAuthorization(request));
    const { intent, baseline, resourceIdentity, allowedPaths } = authorization;
    // Validate confirmed user identity and immutable input before even staging.
    validateGitOperationRegisterInput({ ...intent, candidateTree: intent.expectedHead });
    if (intent.projectId !== request.projectId || intent.operationId !== request.operationId
      || resourceIdentity.projectId !== request.projectId || intent.ownerId !== resourceIdentity.owner
      || intent.hostInstanceId !== resourceIdentity.hostInstanceId || intent.executionVersion !== resourceIdentity.executionVersion
      || (intent.attemptId !== null && intent.attemptId !== resourceIdentity.attemptId)
      || baseline.canonicalPath !== intent.worktreePath || baseline.repoIdentity !== intent.repoIdentity
      || baseline.repositoryBindingId !== intent.repositoryBindingId) fail('authorization_identity_mismatch');
    if (!Array.isArray(allowedPaths) || allowedPaths.length > 512 || new Set(allowedPaths).size !== allowedPaths.length
      || allowedPaths.some(path => !safePath(path) || exclusions.some(excluded => path === excluded || path.startsWith(`${excluded}/`)))
      || Buffer.byteLength(JSON.stringify(allowedPaths)) > 32_768) fail('invalid_allowed_paths');
    const workspaceKey = `workspace:${createHash('sha256').update(JSON.stringify([intent.repoIdentity, intent.worktreePath])).digest('hex')}`;
    function held() {
      const snapshot = deps.resources.read(resourceIdentity);
      if (!isDeepStrictEqual(snapshot.identity, resourceIdentity) || snapshot.leases.length !== 3
        || ['global:execution', `project:${intent.projectId}:work`, workspaceKey].some((key, index) => {
          const lease = snapshot.leases[index];
          return !lease || lease.resourceKey !== key || lease.resourceKind !== ['global', 'project', 'workspace'][index]
            || lease.ownerKind !== 'attempt' || lease.owner !== resourceIdentity.attemptId
            || lease.projectId !== intent.projectId || lease.hostInstanceId !== intent.hostInstanceId
            || lease.executionVersion !== intent.executionVersion || lease.state !== 'held' || lease.leaseUntilUtcMs <= now();
        })) fail('workspace_not_held');
      return snapshot;
    }
    let stoppedSnapshot: ReturnType<typeof held> | null = null;
    function current() {
      if (authorization.verificationPassed !== true || intent.verificationRefs.length === 0) fail('verification_not_passed');
      if (authorization.approvalCurrent !== true) fail('approval_not_current');
      if (authorization.commitAuthorized !== true) fail('commit_not_authorized');
      if (!isDeepStrictEqual(deps.readAuthorization(request), authorization)) fail('authorization_changed');
      const snapshot = held();
      if (stoppedSnapshot !== null && (snapshot.invocationId !== stoppedSnapshot.invocationId
        || !isDeepStrictEqual(snapshot.processIdentity, stoppedSnapshot.processIdentity)
        || !isDeepStrictEqual(snapshot.leases.map(lease => lease.processIdentity), stoppedSnapshot.leases.map(lease => lease.processIdentity)))) {
        fail('writer_identity_changed');
      }
    }
    async function stopped() {
      const snapshot = held(), token = await deps.stopVerifier.verify(snapshot);
      if (token === null || !isDeepStrictEqual(deps.stopVerifier.inspect(token), snapshot)) fail('previous_writer_stop_unconfirmed');
      stoppedSnapshot = structuredClone(snapshot);
      current();
    }
    current();
    await stopped();
    const lease = await deps.lock.acquire({ repoIdentity: intent.repoIdentity, workspacePath: intent.worktreePath,
      gitCommonDir: baseline.gitCommonDir, operationId: intent.operationId });
    let retainClaim = false;
    let registered: GitOperationRecord | null = null;
    try {
      current();
      const before = await deps.inspector.inspect(baseline);
      current();
      if (before.repository.headCommit !== intent.expectedHead) fail('head_drift');
      if (verificationCodeIdentity(before).codeDigest !== intent.codeDigest) fail('source_changed');
      const evidencePaths = new Set([...before.contents.tracked, ...before.contents.untracked].map(entry => entry.path));
      if (allowedPaths.some(path => !evidencePaths.has(path))) fail('path_not_in_evidence');
      const sourceDigest = gitCommitSourceDigest(before);
      // Reads after a side effect remain possible even when approval/owner changed.
      // Only pre-write calls use business admission; read-only inspection supplies facts.
      let admissionRequired = true;
      const driver = deps.driver.open(baseline, () => { if (admissionRequired) current(); });
      const initial = await driver.facts();
      if (initial.head !== intent.expectedHead) fail('head_drift');
      if ((await driver.stagedPaths()).some(path => !allowedPaths.includes(path))) fail('unapproved_staged_files');
      await stopped();
      const verifiedEntries = [...before.contents.tracked, ...before.contents.untracked].filter(entry => allowedPaths.includes(entry.path));
      // Already-staged deletion has no remaining path for `git add` to match.
      await driver.stage(verifiedEntries.filter(entry => entry.state === 'present' || entry.indexObject !== null).map(entry => entry.path));
      if ((await driver.stagedPaths()).some(path => !allowedPaths.includes(path))) fail('unapproved_staged_files');
      // No successful delivery/no_change may leave verified source outside the commit.
      // Only explicit trusted Core/data exclusions may remain unstaged; keep their bytes.
      if ((await driver.unstagedPaths()).some(path => !exclusions.some(excluded => path === excluded || path.startsWith(`${excluded}/`)))) {
        fail('undelivered_source');
      }
      const candidateTree = await driver.tree();
      await driver.verifyIndex(verifiedEntries);
      const staged = await deps.inspector.inspect(baseline);
      if (staged.repository.headCommit !== intent.expectedHead) fail('head_drift');
      if (gitCommitSourceDigest(staged) !== sourceDigest) fail('source_changed');
      registered = deps.transact(() => {
        current();
        const mutation = deps.operations.registerGitOperation({ ...intent, candidateTree });
        if (!mutation.created) fail('reconciliation_required');
        return mutation.operation;
      });
      // Re-read the durable intent before the commit process can be released.
      const durable = deps.operations.getGitOperation(intent.projectId, intent.operationId);
      if (durable.status !== 'pending' || durable.intentDigest !== registered.intentDigest) fail('intent_changed');
      await stopped();
      const finalSource = await deps.inspector.inspect(baseline);
      current();
      if (finalSource.repository.headCommit !== intent.expectedHead) fail('head_drift');
      if (gitCommitSourceDigest(finalSource) !== sourceDigest) fail('source_changed');
      if (await driver.tree() !== candidateTree) fail('index_changed');
      await driver.verifyIndex(verifiedEntries);
      const finalPreflight = await driver.facts();
      if (finalPreflight.head !== intent.expectedHead) fail('head_drift');
      const noChange = candidateTree === initial.tree;
      const message = gitOperationCommitMessage(intent.message, intent.operationId);
      // A crash/unknown stop or a lost receipt after this point retains the claim for F-004.
      retainClaim = true;
      const command = noChange ? { exitCode: null, durationMs: null, reason: null }
        : await driver.commit(message, intent.gitIdentity);
      admissionRequired = false;
      const actual = await driver.facts();
      const after = await deps.inspector.inspect(baseline);
      const actualIndex = await driver.tree();
      let reason: string | null = null;
      if (command.reason !== null || (!noChange && command.exitCode !== 0)) reason = command.reason ?? 'git_commit_failed';
      else if (noChange ? actual.head !== intent.expectedHead
        : actual.head === intent.expectedHead || actual.parents.length !== 1 || actual.parents[0] !== intent.expectedHead) reason = 'parent_or_head_mismatch';
      else if (actual.tree !== candidateTree || actualIndex !== candidateTree) reason = 'candidate_tree_mismatch';
      else if (!noChange && (actual.message !== message || !isDeepStrictEqual(actual.author, { name: intent.gitIdentity.name, email: intent.gitIdentity.email })
        || !isDeepStrictEqual(actual.committer, actual.author))) reason = 'commit_intent_mismatch';
      else if (after.repository.headCommit !== actual.head || gitCommitSourceDigest(after) !== sourceDigest) reason = 'source_changed';
      const operation = deps.transact(() => {
        // Last synchronous re-read is inside the SAME transaction as receipt/events.
        try { current(); } catch { reason = 'authorization_or_occupancy_changed'; }
        return deps.operations.finalizeGitOperation({ operationId: intent.operationId, projectId: intent.projectId,
          expectedRevision: registered!.revision, status: reason ? 'failed' : noChange ? 'no_change' : 'succeeded',
          actualCommit: actual.head, actualTree: actual.tree, exitCode: command.exitCode,
          durationMs: command.durationMs, reasonCode: reason, deliveryStatus: reason ? 'failed' : 'succeeded', settledAtUtcMs: now() }).operation;
      });
      retainClaim = false;
      return operation;
    } catch (error) {
      if ((error instanceof GitCommitProcessError && !error.stopConfirmed)
        || (typeof error === 'object' && error !== null && 'reason' in error && error.reason === 'stop_unconfirmed')) retainClaim = true;
      // Pending intent is evidence, not success. Preserve it for bounded reconciliation.
      throw error;
    } finally {
      if (!retainClaim) await lease.release();
      // Work leases are NEVER released here, including on success or known hook failure.
    }
  } };
}
