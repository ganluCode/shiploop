/**
 * F-010 独立人工丢弃预览与确认编排（application 层）。
 *
 * 不变量：
 * - 预览：授权（workspace.discard 能力 + 项目可见）后的只读核验——加载登记目标、
 *   运行 F-004 有界只读检查、构造有界摘要并发布不可变预览证据；不写任何业务
 *   状态、不登记 operation、不因失败状态自动触发；
 * - 确认：主体/能力/可见性在写事务前核验；意图登记（begin）在短事务内完成
 *   previewDigest 重算、有效期、状态、占用与停止证据门槛；Git/文件复核与删除
 *   全部在 SQLite 事务外；短 Git 元数据锁从复核前一直持有到回执提交；
 * - 删除已发生而回执未提交：保持 pending，重开后由删除器按受管意图与实际
 *   Git/文件状态核对补写；不重复删除、不假报成功、不自动重放未知删除；
 * - 拒绝（预览过期/内容或 HEAD 变化/占用/停止证据缺失/Git 拒绝）记录为 failed
 *   operation 并保留目录；自身 Git 进程停止不确定记录为 blocked 并隔离 workspace；
 * - 人工丢弃授权不复用于 F-008/F-009 自动清理，反之亦然；本服务不变更
 *   Task/Attempt/Feature 业务结论。
 */
import { PublicError } from '../ports/commands.js';
import { requireCapability, requireProjectVisible } from '../ports/authorization.js';
import type { GitPublicMetadataLock } from '../ports/git-public-metadata-lock.js';
import type { CommandProcessIdentity } from '../ports/command-process.js';
import type { WorkspaceInspector, WorkspaceContentEntry } from '../ports/workspace-inspector.js';
import type { WorkspaceOperationCommit } from '../ports/workspace.js';
import {
  computeWorkspaceDiscardPreviewDigest, toWorkspaceDiscardStoreInput,
  validateWorkspaceDiscardConfirmInput, validateWorkspaceDiscardPreviewInput,
  WORKSPACE_DISCARD_PREVIEW_MAX_ENTRIES, WORKSPACE_DISCARD_PREVIEW_TTL_DEFAULT_MS,
  WORKSPACE_DISCARD_SCOPE,
} from '../ports/workspace-discard.js';
import type {
  FeatureWorktreeDiscarder, WorkspaceDiscardOutcome, WorkspaceDiscardPreview, WorkspaceDiscardPreviewEntry,
  WorkspaceDiscardPreviewStore, WorkspaceDiscardStore, WorkspaceDiscardIntent,
} from '../ports/workspace-discard.js';

const PREVIEWABLE_STATUSES = ['ready', 'retained', 'quarantined'] as const;

function toEntry(entry: WorkspaceContentEntry): WorkspaceDiscardPreviewEntry {
  return { path: entry.path, state: entry.state, sizeBytes: entry.sizeBytes, protection: entry.protection };
}

export function createWorkspaceDiscardService(options: {
  readonly previewStore: WorkspaceDiscardPreviewStore;
  readonly store: WorkspaceDiscardStore;
  readonly inspector: WorkspaceInspector;
  readonly gitLock: GitPublicMetadataLock;
  readonly discarder: FeatureWorktreeDiscarder;
  /** Trusted supervisor proof of group absence for a crashed prior attempt of this operation. */
  readonly verifyDiscardStop?: (identity: CommandProcessIdentity) => Promise<{ readonly confirmed: boolean }>;
  /** Publishes an immutable JSON Artifact; the store rechecks that its ID is ready. */
  readonly publishEvidence: (projectId: string, operationId: string, evidence: Readonly<Record<string, unknown>>) => Promise<string>;
  readonly nowUtcMs?: () => number;
  readonly previewTtlMs?: number;
  readonly maxPreviewEntries?: number;
}) {
  const now = options.nowUtcMs ?? Date.now;
  const previewTtlMs = options.previewTtlMs ?? WORKSPACE_DISCARD_PREVIEW_TTL_DEFAULT_MS;
  const maxPreviewEntries = options.maxPreviewEntries ?? WORKSPACE_DISCARD_PREVIEW_MAX_ENTRIES;
  if (!Number.isSafeInteger(previewTtlMs) || previewTtlMs < 1 || !Number.isSafeInteger(maxPreviewEntries) || maxPreviewEntries < 1) {
    throw new TypeError('Workspace.discard: invalid preview bounds');
  }

  return {
    /** 显式只读预览：有界、不泄漏绝对路径、不登记任何 operation。 */
    async preview(raw: unknown): Promise<WorkspaceDiscardPreview> {
      const input = validateWorkspaceDiscardPreviewInput(raw);
      requireCapability(input.principal, 'workspace.discard', 'workspace.discard.preview');
      requireProjectVisible(input.principal, input.projectId, 'workspace.discard.preview');
      const target = options.previewStore.loadPreviewTarget(input.projectId, input.featureId);
      if (!target) {
        throw new PublicError('not_found', 'workspace.discard.preview', undefined, { details: { entityType: 'workspace' } });
      }
      if (!PREVIEWABLE_STATUSES.includes(target.workspace.status as typeof PREVIEWABLE_STATUSES[number])) {
        throw new PublicError('conflict', 'workspace.discard.preview', undefined, {
          details: { reason: 'workspace_not_previewable', entityType: 'workspace' },
        });
      }
      const baseline = {
        repositoryBindingId: target.workspace.repositoryBindingId,
        repositoryBindingRevision: target.workspace.repositoryBindingRevision,
        repoIdentity: target.workspace.repoIdentity,
        canonicalPath: target.workspace.canonicalPath,
        gitCommonDir: target.workspace.gitCommonDir,
        branch: target.workspace.branch,
        baseCommit: target.workspace.baseCommit,
      };
      const inspection = await options.inspector.inspect(baseline);
      const cap = (entries: readonly WorkspaceContentEntry[]) => entries.slice(0, maxPreviewEntries).map(toEntry);
      const truncated = inspection.contents.tracked.length > maxPreviewEntries
        || inspection.contents.untracked.length > maxPreviewEntries
        || inspection.contents.ignored.length > maxPreviewEntries;
      const observedAtUtcMs = now();
      const expiresAtUtcMs = observedAtUtcMs + previewTtlMs;
      const previewDigest = computeWorkspaceDiscardPreviewDigest({
        projectId: input.projectId, featureId: input.featureId, workspaceId: target.workspace.id,
        branch: target.workspace.branch, workspaceRevision: target.workspace.revision,
        headCommit: inspection.repository.headCommit, codeDigest: inspection.codeDigest,
        ignoredDigest: inspection.ignoredDigest, expiresAtUtcMs,
      });
      const preview: WorkspaceDiscardPreview = {
        schemaVersion: 1,
        projectId: input.projectId,
        featureId: input.featureId,
        workspaceId: target.workspace.id,
        branch: target.workspace.branch,
        baseCommit: target.workspace.baseCommit,
        status: target.workspace.status,
        scope: WORKSPACE_DISCARD_SCOPE,
        workspaceRevision: target.workspace.revision,
        headCommit: inspection.repository.headCommit,
        codeDigest: inspection.codeDigest,
        ignoredDigest: inspection.ignoredDigest,
        expiresAtUtcMs,
        previewDigest,
        contents: {
          tracked: cap(inspection.contents.tracked),
          untracked: cap(inspection.contents.untracked),
          ignored: cap(inspection.contents.ignored),
          counts: {
            tracked: inspection.contents.tracked.length,
            untracked: inspection.contents.untracked.length,
            ignored: inspection.contents.ignored.length,
            bytes: inspection.observedBytes,
          },
          truncated,
        },
        impact: {
          irreversible: true,
          discardsUncommittedTrackedChanges: inspection.contents.tracked.length,
          discardsUntrackedFiles: inspection.contents.untracked.length,
          discardsIgnoredFiles: inspection.contents.ignored.length,
          discardsBytes: inspection.observedBytes,
          preserves: ['source_repository', 'feature_branch', 'committed_work', 'audit_records'],
        },
        blockers: target.blockers,
        observedAtUtcMs,
        evidenceRef: '',
      };
      const evidenceRef = await options.publishEvidence(input.projectId, `discard-preview-${previewDigest.slice(0, 24)}`,
        preview as unknown as Readonly<Record<string, unknown>>);
      return { ...preview, evidenceRef };
    },

    /** 人工确认丢弃：commandId 幂等 + 预览绑定 + 门禁复核后的限定范围删除。 */
    async confirm(raw: unknown): Promise<WorkspaceOperationCommit> {
      const validated = validateWorkspaceDiscardConfirmInput(raw);
      requireCapability(validated.principal, 'workspace.discard', 'workspace.discard');
      requireProjectVisible(validated.principal, validated.projectId, 'workspace.discard');
      const input = toWorkspaceDiscardStoreInput(validated);
      const intent: WorkspaceDiscardIntent = options.store.begin(input);
      if (intent.commit.operation.status !== 'pending') return intent.commit;
      try {
        const lease = await options.gitLock.acquire({ repoIdentity: intent.baseline.repoIdentity,
          gitCommonDir: intent.baseline.gitCommonDir, workspacePath: intent.binding.canonicalPath,
          operationId: input.operationId });
        try {
          let journal = options.store.readJournal(input, intent);
          for (const process of journal.unfinishedProcesses) {
            const stopped = options.verifyDiscardStop ? await options.verifyDiscardStop(process) : { confirmed: false };
            if (!stopped.confirmed) {
              const startedAtUtcMs = now();
              const outcome: WorkspaceDiscardOutcome = { removed: false, recovered: false, removedHeadCommit: null,
                removedCodeDigest: null, reason: 'previous_git_stop_unconfirmed', isolated: true,
                result: { startedAtUtcMs, endedAtUtcMs: now(), durationMs: now() - startedAtUtcMs,
                  exitCode: null, signal: null } };
              return await finish(outcome);
            }
            options.store.recordCheckpoint(input, intent, 'stop', process);
          }
          journal = options.store.readJournal(input, intent);
          const outcome = await options.discarder.discard(intent.binding, intent.baseline, {
            headCommit: input.preview.headCommit, codeDigest: input.preview.codeDigest,
            ignoredDigest: input.preview.ignoredDigest,
          }, {
            fence: () => options.store.assertCurrent(input, intent),
            authorize: () => options.store.recheckAuthorization(input, intent),
          }, {
            ...journal,
            recordVerified: value => options.store.recordCheckpoint(input, intent, 'verified', value),
            recordProcess: value => options.store.recordCheckpoint(input, intent, 'process', value),
            recordStop: value => options.store.recordCheckpoint(input, intent, 'stop', value),
          });
          return await finish(outcome);
        } finally { await lease.release(); }
      } catch (error) {
        // Preserve the pending intent and bytes on uncertain I/O or persistence failure.
        options.store.quarantine(input, intent);
        throw error;
      }

      async function finish(outcome: WorkspaceDiscardOutcome): Promise<WorkspaceOperationCommit> {
        if (outcome.removed) {
          const evidenceRef = await options.publishEvidence(input.projectId, input.operationId, {
            schemaVersion: 1, operationId: input.operationId, principalId: input.principalId,
            commandId: input.commandId, workspaceId: input.workspaceId, scope: WORKSPACE_DISCARD_SCOPE,
            previewDigest: input.preview.previewDigest, removed: outcome.removed, recovered: outcome.recovered,
            removedHeadCommit: outcome.removedHeadCommit, removedCodeDigest: outcome.removedCodeDigest,
            evidenceRefs: input.evidenceRefs,
          });
          // Evidence publication can yield; recheck the removal facts before committing the receipt.
          const verified = options.store.readJournal(input, intent).verified;
          if (verified) await options.discarder.confirmDiscard(intent.binding, intent.baseline, verified);
          options.store.assertCurrent(input, intent);
          return options.store.finish(input, intent, outcome, evidenceRef);
        }
        const evidenceRef = await options.publishEvidence(input.projectId, input.operationId, {
          schemaVersion: 1, operationId: input.operationId, principalId: input.principalId,
          commandId: input.commandId, workspaceId: input.workspaceId, scope: WORKSPACE_DISCARD_SCOPE,
          previewDigest: input.preview.previewDigest, removed: false, reason: outcome.reason,
          isolated: outcome.isolated, evidenceRefs: input.evidenceRefs,
        });
        return options.store.finish(input, intent, outcome, evidenceRef);
      }
    },
  };
}
