import { verificationCodeIdentity } from '../ports/verification-aggregate.js';
import { createHash } from 'node:crypto';
import type { ArtifactVerifier } from './artifact-verify.js';
import { observeGitCommit } from './git-commit-observation.js';
import { gitCommitSourceDigest } from './controlled-git-commit.js';
import { readGitCommitInspection } from './git-commit-evidence.js';
import type { GitOperationRecord } from '../ports/git-operations.js';
import type { WorkResourceStopVerifier } from '../ports/work-resources.js';
import type { WorkspaceInspection } from '../ports/workspace-inspector.js';
import { WorkspaceInspectionError } from '../ports/workspace-inspector.js';
import type { WorkspaceBaseline } from '../ports/workspace.js';
import type { GitPublicMetadataLock } from '../ports/git-public-metadata-lock.js';
import type { WorkStartupRecoveryEvidence } from '../ports/work-startup-recovery.js';
import {
  WORK_RECOVERY_RECONCILIATION_KIND,
  WORK_RECOVERY_RECONCILIATION_SCHEMA_VERSION,
  type WorkRecoveryGitOperationFacts,
  type WorkRecoveryReceiptSettlement,
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
  /** P07-1 / F-008：显式受信补回执：仅当全部 pending 提交实测 matched 且其余
   * 事实与 reconcile 同标准核验时，在同一收尾事务内复用副作用事实结算回执
   * 并释放隔离；任何未知/未执行/证据缺失部保持原隔离不变。 */
  resolve(source: WorkStartupRecoveryEvidence): Promise<WorkRecoveryReconciliationResult>;
}

export interface WorkRecoveryReconcilerOptions {
  readonly store: WorkRecoveryReconciliationStore;
  /** Trusted bounded inspector; must verify repository identity, registration, branch, HEAD and contents. */
  readonly inspect: (projectId: string, baseline: WorkspaceBaseline) => Promise<WorkspaceInspection>;
  readonly git: RecoveryGitReader;
  readonly artifacts: Pick<ArtifactVerifier, 'verifyArtifact'> & Partial<Pick<ArtifactVerifier, 'readVerifiedContent'>>;
  readonly stopVerifier: Pick<WorkResourceStopVerifier, 'verify'>;
  readonly publishEvidence: (projectId: string, evidence: WorkRecoveryReconciliationEvidence) => Promise<string>;
  /** P07-1 / F-008：显式结算后受信清理旧写入者的公共元数据 claim
   *（仅在整组停止证据确认后；exact-owner 释放，缺失/他人持有保持不动）。 */
  readonly lock?: GitPublicMetadataLock;
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

/** P07-1 / F-008：停止证据确认后清理已结算回执遗留的公共元数据 claim。
 * Exact-owner 释放且幂等：缺失或他人持有的 claim 保持不动，失败可由下次显式
 * 结算重试；不触碰原生 Git 锁。 */
async function releaseSettledClaims(lock: GitPublicMetadataLock | undefined, baseline: WorkspaceBaseline | null,
  operationIds: readonly string[]): Promise<void> {
  if (lock === undefined || baseline === null || operationIds.length === 0) return;
  for (const operationId of operationIds) {
    try {
      await lock.releaseRecovered({ repoIdentity: baseline.repoIdentity, workspacePath: baseline.canonicalPath,
        gitCommonDir: baseline.gitCommonDir, operationId });
    } catch { /* 保留现场，下次显式结算重试 */ }
  }
}

function addGap(gaps: string[], gap: string): void {
  if (!gaps.includes(gap) && gaps.length < GAP_MAX) gaps.push(gap);
}

function errorReason(error: unknown): string {
  return error instanceof WorkspaceInspectionError ? error.reason : 'inspection_failed';
}

/** Excludes timestamps/evidence ids so two observations can be compared as the same Git/file fact. */
function workspaceObservationDigest(inspection: WorkspaceInspection): string {
  return JSON.stringify({
    repository: {
      repoIdentity: inspection.repository.repoIdentity,
      canonicalPath: inspection.repository.canonicalPath,
      gitCommonDir: inspection.repository.gitCommonDir,
      branch: inspection.repository.branch,
      baseCommit: inspection.repository.baseCommit,
      headCommit: inspection.repository.headCommit,
    },
    registration: inspection.registration,
    statusPorcelainBase64: inspection.statusPorcelainBase64,
    refsDigest: inspection.refsDigest,
    codeDigest: inspection.codeDigest,
    ignoredDigest: inspection.ignoredDigest,
    contents: inspection.contents,
  });
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
  const observed = observeGitCommit(intent, facts);
  if (observed.outcome === 'unknown') addGap(gaps, 'git_commit_side_effect_unknown');
  return observed;
}

export function createWorkRecoveryReconciler(options: WorkRecoveryReconcilerOptions): WorkRecoveryReconciler {
  const now = options.nowUtcMs ?? Date.now;
  return {
    reconcile(source) {
      return runRecovery(source, false);
    },
    resolve(source) {
      return runRecovery(source, true);
    },
  };

  async function runRecovery(source: WorkStartupRecoveryEvidence, explicit: boolean): Promise<WorkRecoveryReconciliationResult> {
      const snapshot = options.store.load(source);
      if (snapshot.alreadyReconciled) {
        /* P07-1 / F-008：结算已落库但 claim 清理可能通不过进程存活窗口；
         * 幂等补清，不重复诊断写入。 */
        if (explicit) {
          await releaseSettledClaims(options.lock, baselineOf(snapshot), snapshot.settledTaskCommitOperationIds ?? []);
        }
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
      for (const gap of snapshot.verificationGaps ?? []) addGap(gaps, gap);
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

      const firstInspection = inspection;
      const recheckWorkspace = async (): Promise<void> => {
        if (baseline === null) return;
        let current: WorkspaceInspection | null = null;
        try {
          current = await options.inspect(source.projectId, baseline);
          if (firstInspection !== null
            && workspaceObservationDigest(firstInspection) !== workspaceObservationDigest(current)) {
            addGap(gaps, 'workspace_changed_during_recovery');
          }
          if (inspection !== null
            && workspaceObservationDigest(inspection) !== workspaceObservationDigest(current)) {
            addGap(gaps, 'workspace_changed_between_rechecks');
          }
          inspection = current;
        } catch (error) {
          addGap(gaps, `workspace_recheck_${errorReason(error)}`);
        }
        try {
          const currentLocks = await options.git.locks(baseline);
          locks = currentLocks;
          if (currentLocks.length > 0) addGap(gaps, 'git_lock_present');
          if (snapshot.pendingGitOperations.length > 0) {
            const currentFacts = currentLocks.length === 0 ? await options.git.facts(source.projectId, baseline) : null;
            if (JSON.stringify(currentFacts) !== JSON.stringify(facts)) {
              addGap(gaps, 'git_facts_changed_during_recovery');
              settlements.length = 0;
              for (let index = 0; index < gitOperations.length; index++) {
                gitOperations[index] = { operationId: gitOperations[index]!.operationId, outcome: 'unknown',
                  actualCommit: currentFacts?.head ?? null, actualTree: currentFacts?.tree ?? null,
                  reasonCode: 'git_facts_changed_during_recovery' };
              }
            }
          }
        } catch {
          addGap(gaps, 'git_lock_probe_failed');
        }
        if (current !== null) {
          const head = current.repository.headCommit;
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
      };

      let facts: Awaited<ReturnType<RecoveryGitReader['facts']>> | null = null;
      if (baseline !== null && locks.length === 0 && snapshot.pendingGitOperations.length > 0) {
        try { facts = await options.git.facts(source.projectId, baseline); }
        catch { addGap(gaps, 'git_facts_unavailable'); }
      }
      const gitOperations: WorkRecoveryGitOperationFacts[] = [];
      const settlements: WorkRecoveryReceiptSettlement[] = [];
      const verifiedCommitDigests = new Set<string>();
      for (const operation of snapshot.pendingGitOperations) {
        let observed = await reconcileGitOperation(baseline, operation, facts, gaps);
        const original = options.artifacts.readVerifiedContent
          ? await readGitCommitInspection(operation.intent, { readVerifiedContent: options.artifacts.readVerifiedContent.bind(options.artifacts) })
          : null;
        if (original === null || snapshot.verificationGaps?.includes('git_verification_batch_invalid')) {
          addGap(gaps, 'git_verification_evidence_missing');
          if (observed.outcome === 'matched') {
            observed = { ...observed, outcome: 'unknown', reasonCode: 'verification_evidence_missing' };
          }
        } else if (observed.outcome === 'matched') {
          if (inspection === null || gitCommitSourceDigest(original) !== gitCommitSourceDigest(inspection)) {
            addGap(gaps, 'git_verification_source_changed');
            observed = { ...observed, outcome: 'unknown', reasonCode: 'source_changed' };
          } else verifiedCommitDigests.add(operation.intent.codeDigest);
        }
        gitOperations.push(observed);
        // Startup revoked the original writer's fence. Observed side effects are
        // durable diagnosis, never permission to finalize that writer's business
        // receipt or release its retained Git claim; no model or new commit is
        // launched here. P07-1 / F-008: only the explicit trusted resolve() may
        // settle matched receipts and then only with every other fact verified.
        if (explicit && observed.outcome === 'matched') {
          settlements.push({ operationId: operation.intent.operationId,
            expectedRevision: operation.revision, actualCommit: observed.actualCommit!,
            actualTree: observed.actualTree! });
        } else {
          addGap(gaps, 'git_receipt_recovery_required');
        }
      }
      if (inspection !== null && (snapshot.verificationCodeDigests ?? []).some(digest =>
        digest !== verificationCodeIdentity(inspection!).codeDigest && !verifiedCommitDigests.has(digest))) {
        addGap(gaps, 'verification_code_changed');
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
      await recheckWorkspace();
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
          else {
            const gapsBeforeStopRecheck = gaps.length;
            await recheckWorkspace();
            if (gaps.length === gapsBeforeStopRecheck) release = { mode: 'stopped', token };
          }
        }
      }
      /* P07-1 / F-008：整组停止证据确认后、收尾事务前清理旧写入者的公共
       * 元数据 claim（含本次待结算与此前已结算回执）；收尾失败可幂等重试。 */
      if (explicit && release.mode === 'stopped') {
        await releaseSettledClaims(options.lock, baseline, [
          ...settlements.map(settlement => settlement.operationId),
          ...(snapshot.settledTaskCommitOperationIds ?? []),
        ]);
      }

      let status: WorkRecoveryReconciliationEvidence['status'] = gaps.length === 0 ? 'reconciled' : 'quarantined';
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
      const buildEvidence = (): WorkRecoveryReconciliationEvidence => ({
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
        gaps: [...gaps],
        startupGaps,
        workspace: inspection === null || baseline === null ? null : {
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
        },
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
      });
      let evidence = buildEvidence();
      let evidenceRef = await options.publishEvidence(source.projectId, evidence);
      // Publishing is asynchronous and may overlap an external editor. Recheck once
      // after publication; a changed fact invalidates the just-built release evidence.
      const gapsBeforePublishRecheck = gaps.length;
      await recheckWorkspace();
      if (gaps.length > gapsBeforePublishRecheck) {
        status = 'quarantined';
        release = { mode: 'none' };
        settlements.length = 0;
        evidence = buildEvidence();
        evidenceRef = await options.publishEvidence(source.projectId, evidence);
      }
      if (status === 'quarantined') options.store.quarantine(source, evidence, evidenceRef, snapshot.recoveryFingerprint);
      else options.store.finish(source, evidence, evidenceRef, release, snapshot.recoveryFingerprint,
        explicit && settlements.length > 0 ? settlements : undefined);
      return { status, gaps, evidenceRef, alreadyReconciled: false };
  }
}
