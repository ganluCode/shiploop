/**
 * F-009 工作区清理 operation 编排（application 层）。
 *
 * 不变量：
 * - 意图登记（begin）在短事务内完成全门槛核验；Git/文件复核、删除与证据发布
 *   全部在 SQLite 事务外；结果回执在短事务内按 fencing CAS 提交；
 * - 短 Git 元数据锁从复核前一直持有到回执提交（与准备 operation 同一纪律）；
 * - 删除已发生而回执未提交时：保持 pending，重开后由清理器按受管意图和实际
 *   Git/文件状态核对补写；不重复删除、不假报成功；
 * - 拒绝（内容/HEAD/路径/授权变化、Git 非强制拒绝）记录为 failed operation
 *   并保留目录；自身 Git 进程停止不确定记录为 blocked 并隔离 workspace；
 *   永不降级为强制删除、递归删除或源仓库清理；
 * - 不变更 Task 通过、Attempt 结论、返工计数或 Feature 完成语义。
 */
import type { GitPublicMetadataLock } from '../ports/git-public-metadata-lock.js';
import type { CommandProcessIdentity, CommandProcessStop } from '../ports/command-process.js';
import type { WorkspaceOperationCommit, WorkspaceOperationResult } from '../ports/workspace.js';
import { validateWorkspaceCleanerInput } from '../ports/workspace-cleaner.js';
import type { WorkspaceCleanerInput, WorkspaceCleanerIntent, WorkspaceCleanerOutcome,
  WorkspaceCleanerStore, FeatureWorktreeCleaner } from '../ports/workspace-cleaner.js';

export function createWorkspaceCleanerService(options: {
  readonly store: WorkspaceCleanerStore;
  readonly gitLock: GitPublicMetadataLock;
  readonly cleaner: FeatureWorktreeCleaner;
  /** Trusted supervisor proof of group absence for a crashed prior attempt of this operation. */
  readonly verifyCleanupStop?: (identity: CommandProcessIdentity) => Promise<CommandProcessStop>;
  /** Publishes an immutable JSON Artifact; the store rechecks that its ID is ready. */
  readonly publishEvidence: (projectId: string, operationId: string, evidence: Readonly<Record<string, unknown>>) => Promise<string>;
}) {
  return {
    async clean(raw: WorkspaceCleanerInput): Promise<WorkspaceOperationCommit> {
      const input = validateWorkspaceCleanerInput(raw);
      const intent: WorkspaceCleanerIntent = options.store.begin(input);
      if (intent.commit.operation.status !== 'pending') return intent.commit;
      try {
        const lease = await options.gitLock.acquire({ repoIdentity: intent.baseline.repoIdentity,
          gitCommonDir: intent.baseline.gitCommonDir, workspacePath: intent.binding.canonicalPath,
          operationId: input.operationId });
        try {
          let journal = options.store.readJournal(input, intent);
          for (const process of journal.unfinishedProcesses) {
            const stopped = options.verifyCleanupStop ? await options.verifyCleanupStop(process) : { confirmed: false };
            if (!stopped.confirmed) {
              const startedAtUtcMs = Date.now();
              const outcome: WorkspaceCleanerOutcome = { removed: false, recovered: false, removedHeadCommit: null,
                removedCodeDigest: null, reason: 'previous_git_stop_unconfirmed', isolated: true,
                result: { startedAtUtcMs, endedAtUtcMs: Date.now(), durationMs: Date.now() - startedAtUtcMs,
                  exitCode: null, signal: null } satisfies Omit<WorkspaceOperationResult, 'evidenceRefs' | 'errorRef'> };
              return await finish(outcome);
            }
            options.store.recordCheckpoint(input, intent, 'stop', process);
          }
          journal = options.store.readJournal(input, intent);
          const outcome = await options.cleaner.clean(intent.binding, intent.baseline, input.expected, {
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

      async function finish(outcome: WorkspaceCleanerOutcome): Promise<WorkspaceOperationCommit> {
        if (outcome.removed) {
          const evidenceRef = await options.publishEvidence(input.identity.projectId, input.operationId, {
            schemaVersion: 1, operationId: input.operationId, identity: input.identity,
            workspaceId: input.workspaceId, removed: outcome.removed, recovered: outcome.recovered,
            removedHeadCommit: outcome.removedHeadCommit, removedCodeDigest: outcome.removedCodeDigest,
            evidenceRefs: input.evidenceRefs,
          });
          // Evidence publication can yield; recheck the removal facts before committing the receipt.
          const verified = options.store.readJournal(input, intent).verified;
          if (verified) await options.cleaner.confirmRemoval(intent.binding, intent.baseline, verified);
          options.store.assertCurrent(input, intent);
          return options.store.finish(input, intent, outcome, evidenceRef);
        }
        const evidenceRef = await options.publishEvidence(input.identity.projectId, input.operationId, {
          schemaVersion: 1, operationId: input.operationId, identity: input.identity,
          workspaceId: input.workspaceId, removed: false, reason: outcome.reason, isolated: outcome.isolated,
          evidenceRefs: input.evidenceRefs,
        });
        return options.store.finish(input, intent, outcome, evidenceRef);
      }
    },
  };
}
