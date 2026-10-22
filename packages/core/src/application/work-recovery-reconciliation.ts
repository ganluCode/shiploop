import { createHash } from 'node:crypto';
import type { ArtifactVerifier } from './artifact-verify.js';
import { gitOperationCommitMessage } from '../ports/controlled-git-commit.js';
import type { GitOperationRecord } from '../ports/git-operations.js';
import type { WorkResourceStopVerifier } from '../ports/work-resources.js';
import type { WorkspaceInspection } from '../ports/workspace-inspector.js';
import { WorkspaceInspectionError } from '../ports/workspace-inspector.js';
import type { WorkspaceBaseline } from '../ports/workspace.js';
import type { WorkStartupRecoveryEvidence } from '../ports/work-startup-recovery.js';
import {
  WORK_RECOVERY_RECONCILIATION_KIND,
  WORK_RECOVERY_RECONCILIATION_SCHEMA_VERSION,
  type WorkRecoveryGitOperationFacts,
  type WorkRecoveryReconciliationEvidence,
  type WorkRecoveryReconciliationResult,
  type RecoveryGitReader,
  type WorkRecoveryReconciliationSnapshot,
  type WorkRecoveryReconciliationStore,
  type WorkRecoveryRelease,
} from '../ports/work-recovery-reconciliation.js';

const GAP_MAX = 32;
const ARTIFACT_CHECK_MAX = 64;

export interface WorkRecoveryReconciler {
  reconcile(source: WorkStartupRecoveryEvidence): Promise<WorkRecoveryReconciliationResult>;
}

export interface WorkRecoveryReconcilerOptions {
  readonly store: WorkRecoveryReconciliationStore;
  /** Trusted bounded inspector; must verify repository identity, registration, branch, HEAD and contents. */
  readonly inspect: (projectId: string, baseline: WorkspaceBaseline) => Promise<WorkspaceInspection>;
  readonly git: RecoveryGitReader;
  readonly artifacts: Pick<ArtifactVerifier, 'verifyArtifact'>;
  readonly stopVerifier: Pick<WorkResourceStopVerifier, 'verify'>;
  readonly publishEvidence: (projectId: string, evidence: WorkRecoveryReconciliationEvidence) => Promise<string>;
  readonly nowUtcMs?: () => number;
}

function baselineOf(snapshot: WorkRecoveryReconciliationSnapshot): WorkspaceBaseline | null {
  const workspace = snapshot.workspace;
  if (workspace === null) return null;
  return {
    repositoryBindingId: workspace.repositoryBindingId,
    repositoryBindingRevision: workspace.repositoryBindingRevision,
    repoIdentity: workspace.repoIdentity,
    canonicalPath: workspace.canonicalPath,
    gitCommonDir: workspace.gitCommonDir,
    branch: workspace.branch,
    baseCommit: workspace.baseCommit,
  };
}

function resourceKey(baseline: WorkspaceBaseline): string {
  return `workspace:${createHash('sha256').update(JSON.stringify([baseline.repoIdentity, baseline.canonicalPath])).digest('hex')}`;
}

function addGap(gaps: string[], gap: string): void {
  if (!gaps.includes(gap) && gaps.length < GAP_MAX) gaps.push(gap);
}

function errorReason(error: unknown): string {
  return error instanceof WorkspaceInspectionError ? error.reason : 'inspection_failed';
}

function sameIdentity(left: { name: string; email: string }, right: { name: string; email: string }): boolean {
  return left.name === right.name && left.email === right.email;
}

async function reconcileGitOperation(baseline: WorkspaceBaseline | null,
  operation: GitOperationRecord, facts: Awaited<ReturnType<RecoveryGitReader['facts']>> | null,
  gaps: string[]): Promise<WorkRecoveryGitOperationFacts> {
  const intent = operation.intent;
  if (baseline === null) {
    addGap(gaps, 'managed_workspace_missing');
    return { operationId: intent.operationId, outcome: 'unknown', actualCommit: null, actualTree: null,
      reasonCode: 'managed_workspace_missing' };
  }
  if (intent.repoIdentity !== baseline.repoIdentity || intent.worktreePath !== baseline.canonicalPath) {
    addGap(gaps, 'git_operation_workspace_mismatch');
    return { operationId: intent.operationId, outcome: 'unknown', actualCommit: null, actualTree: null,
      reasonCode: 'git_operation_workspace_mismatch' };
  }
  if (facts === null) {
    return { operationId: intent.operationId, outcome: 'unknown', actualCommit: null, actualTree: null,
      reasonCode: 'git_facts_unavailable' };
  }
  if (facts.head === intent.expectedHead) {
    return { operationId: intent.operationId, outcome: 'not_executed', actualCommit: null, actualTree: null,
      reasonCode: 'commit_not_observed' };
  }
  const message = gitOperationCommitMessage(intent.message, intent.operationId);
  if (facts.parents.length === 1 && facts.parents[0] === intent.expectedHead
    && facts.tree === intent.candidateTree && facts.message === message
    && sameIdentity(facts.author, intent.gitIdentity) && sameIdentity(facts.committer, intent.gitIdentity)) {
    return { operationId: intent.operationId, outcome: 'matched', actualCommit: facts.head, actualTree: facts.tree,
      reasonCode: null };
  }
  addGap(gaps, 'git_commit_side_effect_unknown');
  return { operationId: intent.operationId, outcome: 'unknown', actualCommit: null, actualTree: null,
    reasonCode: 'commit_intent_mismatch' };
}

export function createWorkRecoveryReconciler(options: WorkRecoveryReconcilerOptions): WorkRecoveryReconciler {
  const now = options.nowUtcMs ?? Date.now;
  return {
    async reconcile(source) {
      const snapshot = options.store.load(source);
      if (snapshot.alreadyReconciled) {
        return { status: 'reconciled', gaps: [], evidenceRef: snapshot.priorEvidenceRef, alreadyReconciled: true };
      }
      const attempt = snapshot.attempt;
      const neverStarted = snapshot.resources.invocationId === null && snapshot.resources.processIdentity === null
        && snapshot.resources.leases.every(lease => lease.processIdentity === null)
        && attempt.startedAtUtcMs === null && attempt.executionStage === 'preflight';
      const gaps: string[] = [];
      const ignoredNeverStartedGaps = new Set(['process_identity_missing', 'process_identity_mismatch',
        'invalid_process_identity', 'stop_unconfirmed', 'stop_failed']);
      const startupGaps = source.gaps.filter(gap => gap !== 'workspace_not_reconciled'
        && !(neverStarted && snapshot.resources.leases.length === 0 && gap === 'incomplete_resource_group')
        && !(neverStarted && ignoredNeverStartedGaps.has(gap)));
      for (const gap of startupGaps) addGap(gaps, `startup_${gap}`);
      for (const gap of snapshot.dispatchGaps ?? []) addGap(gaps, gap);
      if (!source.stopConfirmed && !neverStarted) addGap(gaps, 'stop_unconfirmed');

      if (attempt.id !== source.attemptId || attempt.projectId !== source.projectId || attempt.runId !== source.runId
        || attempt.owner !== source.owner || attempt.hostInstanceId !== source.hostInstanceId
        || attempt.executionVersion !== source.executionVersion) addGap(gaps, 'attempt_identity_mismatch');

      const baseline = baselineOf(snapshot);
      let inspection: WorkspaceInspection | null = null;
      let locks: readonly string[] = [];
      if (baseline === null) addGap(gaps, 'managed_workspace_missing');
      else {
        const workspaceLease = snapshot.resources.leases.find(lease => lease.resourceKind === 'workspace');
        if (workspaceLease !== undefined && workspaceLease.resourceKey !== resourceKey(baseline)) {
          addGap(gaps, 'workspace_resource_mismatch');
        }
        try {
          inspection = await options.inspect(source.projectId, baseline);
        } catch (error) {
          addGap(gaps, `workspace_${errorReason(error)}`);
        }
        try {
          locks = await options.git.locks(baseline);
          if (locks.length > 0) addGap(gaps, 'git_lock_present');
        } catch {
          addGap(gaps, 'git_lock_probe_failed');
        }
        if (inspection !== null) {
          const head = inspection.repository.headCommit;
          try {
            if (!(await options.git.isAncestor(source.projectId, baseline, baseline.baseCommit, head))) {
              addGap(gaps, 'head_not_descended_from_base');
            }
            if (snapshot.workspace?.headCommit != null
              && !(await options.git.isAncestor(source.projectId, baseline, snapshot.workspace.headCommit, head))) {
              addGap(gaps, 'recorded_head_not_ancestor');
            }
          } catch {
            addGap(gaps, 'git_ancestry_check_failed');
          }
        }
      }

      let facts: Awaited<ReturnType<RecoveryGitReader['facts']>> | null = null;
      if (baseline !== null && locks.length === 0 && snapshot.pendingGitOperations.length > 0) {
        try { facts = await options.git.facts(source.projectId, baseline); }
        catch { addGap(gaps, 'git_facts_unavailable'); }
      }
      const gitOperations: WorkRecoveryGitOperationFacts[] = [];
      for (const operation of snapshot.pendingGitOperations) {
        gitOperations.push(await reconcileGitOperation(baseline, operation, facts, gaps));
      }
      if (snapshot.pendingWorkspaceOperations.length > 0) addGap(gaps, 'unfinished_workspace_operation');

      const recordingGaps = [...(snapshot.session?.recordingGaps ?? [])];
      const session = snapshot.session;
      const launched = snapshot.resources.invocationId !== null;
      const processIdentity = snapshot.resources.processIdentity !== null
        ? 'confirmed' as const : neverStarted ? 'not_applicable' as const : 'missing' as const;
      if (!neverStarted && !launched) addGap(gaps, 'launch_receipt_missing');
      if (!neverStarted && snapshot.resources.processIdentity === null) addGap(gaps, 'process_identity_missing');
      if (launched && (session === null || session.status === 'reserved')) addGap(gaps, 'session_start_receipt_missing');
      if (session !== null) {
        if (session.projectId !== attempt.projectId || session.attemptId !== attempt.id) {
          addGap(gaps, 'session_identity_mismatch');
        }
        if (neverStarted && session.status !== 'reserved') addGap(gaps, 'session_attempt_stage_mismatch');
        if (session.status === 'started') addGap(gaps, 'native_session_occupancy');
        if (session.status === 'started' || session.status === 'ended') addGap(gaps, 'session_stop_receipt_missing');
        if (session.status !== 'reserved' && session.recordingWatermark === null) {
          addGap(gaps, 'recording_watermark_missing');
        }
        if (session.startedAtUtcMs !== null && session.lastActivityAtUtcMs < session.startedAtUtcMs) {
          addGap(gaps, 'last_activity_before_start');
        }
        if (session.lastActivityAtUtcMs > now()) addGap(gaps, 'last_activity_in_future');
        if (session.stoppedAtUtcMs !== null && session.lastActivityAtUtcMs > session.stoppedAtUtcMs) {
          addGap(gaps, 'last_activity_after_stop');
        }
      }
      if (recordingGaps.length > 0) addGap(gaps, 'recording_gaps_present');

      const artifactIds = [...new Set(snapshot.artifacts.map(artifact => artifact.id))].slice(0, ARTIFACT_CHECK_MAX);
      const verifiedArtifacts = new Set<string>();
      let artifactsChecked = 0;
      for (const artifactId of artifactIds) {
        const artifact = snapshot.artifacts.find(record => record.id === artifactId);
        if (artifact === undefined) { addGap(gaps, 'artifact_missing'); continue; }
        if (artifact.status !== 'ready') { addGap(gaps, 'artifact_not_ready'); continue; }
        try {
          const report = await options.artifacts.verifyArtifact(source.projectId, artifactId);
          artifactsChecked += 1;
          if (report.kind !== 'verified_ready') addGap(gaps, report.kind === 'corrupt' ? 'artifact_corrupt' : 'artifact_untrusted');
          else verifiedArtifacts.add(artifactId);
        } catch {
          addGap(gaps, 'artifact_verification_failed');
        }
      }
      const recoverySelection = attempt.inputSnapshot.rework?.recovery.selection;
      const recoverySource = recoverySelection !== undefined && recoverySelection.mode !== 'new'
        ? recoverySelection.source : undefined;
      if (recoverySource !== undefined) {
        if (recoverySource.sourceProjectId !== source.projectId) addGap(gaps, 'native_archive_source_project_mismatch');
        const artifact = snapshot.artifacts.find(record => record.id === recoverySource.nativeArchiveRef);
        if (artifact === undefined) addGap(gaps, 'native_archive_source_missing');
        else if (!verifiedArtifacts.has(artifact.id) || artifact.contentHash !== recoverySource.sourceDigest) {
          addGap(gaps, 'native_archive_source_unverified');
        }
      }

      let release: WorkRecoveryRelease = { mode: 'none' };
      if (gaps.length === 0 && snapshot.resources.leases.length > 0) {
        if (neverStarted) release = { mode: 'unstarted' };
        else {
          const token = await options.stopVerifier.verify(snapshot.resources);
          if (token === null) addGap(gaps, 'stop_unconfirmed');
          else release = { mode: 'stopped', token };
        }
      }

      const status = gaps.length === 0 ? 'reconciled' : 'quarantined';
      const runtime = {
        launchReceipt: launched ? 'present' as const : 'missing' as const,
        stopReceipt: neverStarted ? 'not_applicable' as const
          : session?.status === 'stopped' && source.stopConfirmed ? 'confirmed' as const : 'missing' as const,
        sessionId: session?.id ?? null,
        sessionStatus: session?.status ?? null,
        providerSessionId: session?.providerSessionId ?? null,
        nativeSessionOccupied: session?.status === 'started',
        processIdentity,
        lastActivityAtUtcMs: session?.lastActivityAtUtcMs ?? null,
      };

      const native = {
        sessionStorageKind: snapshot.session?.nativeRef?.storageKind ?? null,
        sessionFormatVersion: snapshot.session?.nativeRef?.formatVersion ?? null,
        sourceArchiveRef: recoverySource?.nativeArchiveRef ?? null,
        sourceDigest: recoverySource?.sourceDigest ?? null,
        sourceVerified: recoverySource !== undefined && verifiedArtifacts.has(recoverySource.nativeArchiveRef)
          && snapshot.artifacts.some(record => record.id === recoverySource.nativeArchiveRef
            && record.contentHash === recoverySource.sourceDigest),
        singleWriter: release.mode === 'unstarted' ? 'never_started' as const
          : source.stopConfirmed ? 'confirmed_stopped' as const : 'not_referenced' as const,
        opened: false as const,
      };
      const workspace = inspection === null || baseline === null ? null : {
        id: snapshot.workspace!.id,
        status: status === 'reconciled' ? 'retained' as const : 'quarantined' as const,
        canonicalPath: baseline.canonicalPath,
        repoIdentity: baseline.repoIdentity,
        branch: inspection.repository.branch,
        baseCommit: baseline.baseCommit,
        headCommit: inspection.repository.headCommit,
        codeDigest: inspection.codeDigest,
        registrationDigest: createHash('sha256').update(JSON.stringify(inspection.registration)).digest('hex'),
        trackedCount: inspection.contents.tracked.length,
        untrackedCount: inspection.contents.untracked.length,
        ignoredCount: inspection.contents.ignored.length,
        retainedTrackedCount: inspection.contents.tracked.length,
        retainedUntrackedCount: inspection.contents.untracked.length,
        locks,
      };
      const evidence: WorkRecoveryReconciliationEvidence = {
        schemaVersion: WORK_RECOVERY_RECONCILIATION_SCHEMA_VERSION,
        kind: WORK_RECOVERY_RECONCILIATION_KIND,
        projectId: attempt.projectId,
        featureId: attempt.featureId,
        runId: attempt.runId,
        taskId: attempt.taskId,
        attemptId: attempt.id,
        owner: attempt.owner,
        hostInstanceId: attempt.hostInstanceId,
        executionVersion: attempt.executionVersion,
        status,
        gaps,
        startupGaps,
        workspace,
        recording: {
          sessionId: snapshot.session?.id ?? null,
          status: snapshot.session?.status ?? null,
          watermark: snapshot.session?.recordingWatermark ?? null,
          gaps: recordingGaps.slice(0, GAP_MAX),
          artifactsChecked,
        },
        runtime,
        native,
        gitOperations,
        taskPassed: false,
        newAttemptCreated: false,
        manualNextSteps: status === 'quarantined' ? [
          '保留并人工核对 Attempt、进程身份、原生 Session 和录制水印；确认无残留写入后再释放占用。',
          '确认恢复证据完整前不得创建新 Attempt、复用工作区或继续原生会话。',
        ] : [],
        observedAtUtcMs: now(),
      };
      const evidenceRef = await options.publishEvidence(source.projectId, evidence);
      if (status === 'quarantined') options.store.quarantine(source, evidence, evidenceRef, snapshot.recoveryFingerprint);
      else options.store.finish(source, evidence, evidenceRef, release, snapshot.recoveryFingerprint);
      return { status, gaps, evidenceRef, alreadyReconciled: false };
    },
  };
}
