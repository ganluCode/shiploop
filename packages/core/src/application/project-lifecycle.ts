/**
 * P07-3 / F-008：项目软归档/显式恢复的命令用例（application 层）。
 *
 * 归档提交分两段短写事务，事务外只做有界收尾等待：
 * 1. enter 事务：重放重核 + 维护占用 + revision CAS，active→archiving 并同事务
 *    追加 project.status_changed 事件与进程内幂等检查点回执（真实 commandId +
 *    请求摘要锚定；崩溃/Host 重启后同 commandId 重放凭检查点继续收尾核验）。
 *    已处于 archiving 时按检查点（同 commandId 同参数）或当前 revision（新命令
 *    显式继续）进入等待；archived 幂等直接进入 settle；deleting 稳定拒绝。
 * 2. 事务外：在有限预算内轮询只读收尾快照（占用不清晰绝不放行；停止不明保持
 *    可查询的 archiving）。等待不持有写事务，也不做任何进程/Git/文件 I/O。
 * 3. settle 事务：同事务重核重放 + 占用；全部阻塞为 0 才 archiving→archived
 *    （状态、事件与回执原子提交）；仍有阻塞或超时，则回执如实记录
 *    completed + settled=false + 阻塞计数（项目保持可查询的 archiving，
 *    不伪造 archived），新 commandId 可再次提交归档继续收尾。
 *
 * 恢复（project.restore）是显式管理操作（与数据备份恢复 data.backup.restore
 * 名称互不通用）：仅 archived→active，同事务重核归属与 revision；不自动恢复
 * Run、不清预算、不重复已通过 Task——本用例不写任何执行/预算/任务行。
 */
import { randomBytes } from 'node:crypto';
import {
  createCompletedReceipt,
  createRejectedReceipt,
  evaluateCommandTiming,
  PublicError,
  type CommandReceipt,
} from '../ports/commands.js';
import { createResultRef } from '../ports/command-receipts.js';
import {
  assertTrustedPrincipal,
  authorizeCommandReplay,
  mapProjectLookupError,
  type TrustedPrincipal,
} from '../ports/authorization.js';
import { decideCommandReplay } from '../ports/command-receipts.js';
import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
import type { MaintenanceWriteGate } from '../ports/data-maintenance.js';
import { toPublicProjectRecord } from '../ports/queries.js';
import {
  PROJECT_ARCHIVE_CHECKPOINT_PRINCIPAL_ID,
  PROJECT_ARCHIVE_CLOSEOUT_BUDGET_MS,
  PROJECT_ARCHIVE_CLOSEOUT_POLL_INTERVAL_MS,
  type ProjectArchiveEnvelope,
  type ProjectLifecycleCloseout,
  type ProjectLifecycleCommandHandler,
  type ProjectLifecycleCommandHandlerOptions,
  type ProjectRestoreEnvelope,
} from '../ports/project-lifecycle.js';
import type { ProjectRecord } from '../ports/state-store.js';

interface ReceiptIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly operation: 'project.archive' | 'project.restore';
  readonly scope: { readonly kind: 'project'; readonly projectId: string };
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}

type EnterOutcome =
  | { readonly kind: 'receipt'; readonly receipt: CommandReceipt }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'already' };

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

export function createProjectLifecycleCommandHandler(
  options: ProjectLifecycleCommandHandlerOptions & {
    readonly atomicStore: AtomicCommandStore;
    readonly maintenanceGate?: MaintenanceWriteGate;
  },
): ProjectLifecycleCommandHandler {
  const store = options.atomicStore;
  const gate = options.maintenanceGate;
  const nowUtcMs = options.nowUtcMs ?? Date.now;
  const budgetMs = options.closeoutBudgetMs ?? PROJECT_ARCHIVE_CLOSEOUT_BUDGET_MS;
  const pollIntervalMs = options.closeoutPollIntervalMs ?? PROJECT_ARCHIVE_CLOSEOUT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 0) throw new TypeError('归档收尾预算非法');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) throw new TypeError('归档收尾轮询间隔非法');

  const assertMaintenance = (): void => {
    gate?.assertCanWrite('configuration');
  };

  /** 同一 commandId 的既有用户回执重放（能力/归属重核 + 同源摘要比对）。 */
  const replay = (principal: TrustedPrincipal, existing: CommandReceipt | undefined, digest: string, operation: string): CommandReceipt | undefined => {
    if (existing !== undefined) {
      authorizeCommandReplay(principal, existing, existing.scope.kind === 'project' ? existing.scope.projectId : null, operation);
    }
    const decision = decideCommandReplay(existing, digest, operation);
    return decision.kind === 'replay' ? decision.receipt : undefined;
  };

  const identityOf = (principal: TrustedPrincipal, envelope: ProjectArchiveEnvelope | ProjectRestoreEnvelope, digest: string, now: number): ReceiptIdentity => ({
    principalId: principal.principalId,
    commandId: envelope.commandId,
    operation: envelope.operation,
    scope: envelope.scope,
    requestDigest: digest,
    issuedAt: envelope.issuedAt,
    completedAt: new Date(now).toISOString(),
  });

  /** enter/settle 事务内重读项目（缺失/不可见统一受控公开错误）。 */
  const requireProject = (projectId: string, operation: string, transaction: CommandTransaction): ProjectRecord => {
    try {
      return transaction.getProject(projectId);
    } catch (error) {
      mapProjectLookupError(error, operation);
    }
  };

  /** 事务外有界收尾等待：不持锁、不做外部 I/O；预算耗尽返回最后一次快照。 */
  const awaitCloseout = async (projectId: string): Promise<ProjectLifecycleCloseout> => {
    let waited = 0;
    for (;;) {
      const closeout = options.readCloseout(projectId);
      if (closeout.clear || waited >= budgetMs) return closeout;
      await sleep(Math.min(pollIntervalMs, budgetMs - waited));
      waited += pollIntervalMs;
    }
  };

  const settleReceipt = (
    principal: TrustedPrincipal,
    envelope: ProjectArchiveEnvelope,
    digest: string,
    transaction: CommandTransaction,
  ): CommandReceipt => {
    const operation = 'project.archive';
    const replayed = replay(principal, transaction.findReceipt(principal.principalId, envelope.commandId), digest, operation);
    if (replayed !== undefined) return replayed;
    assertMaintenance();
    const now = nowUtcMs();
    evaluateTiming(envelope, now, operation);
    const identity = identityOf(principal, envelope, digest, now);
    const closeout = transaction.readProjectArchiveCloseout(envelope.scope.projectId);
    if (closeout.clear) {
      let project: ProjectRecord;
      if (closeout.status === 'archiving') {
        const current = requireProject(envelope.scope.projectId, operation, transaction);
        project = transaction.transitionProjectStatus({
          operation: 'archiveComplete',
          projectId: envelope.scope.projectId,
          expectedRevision: current.revision,
        });
      } else if (closeout.status === 'archived') {
        project = requireProject(envelope.scope.projectId, operation, transaction);
      } else {
        return saveRejected(transaction, identity, lifecycleConflict());
      }
      const receipt = createCompletedReceipt({
        ...identity,
        resultRef: createResultRef(randomBytes(32)),
        result: { status: 'archived', settled: true, project: toPublicProjectRecord(project) },
      });
      transaction.saveReceipt(receipt);
      return receipt;
    }
    // 超时/停止不明：项目保持 archiving（可查询），回执如实记录 settled=false +
    // 阻塞计数（completed + result 形态；不伪造 archived，也不携带白名单外错误字段）。
    const project = requireProject(envelope.scope.projectId, operation, transaction);
    const receipt = createCompletedReceipt({
      ...identity,
      resultRef: createResultRef(randomBytes(32)),
      result: { status: 'archiving', settled: false, blockers: { ...closeout.blockers }, project: toPublicProjectRecord(project) },
    });
    transaction.saveReceipt(receipt);
    return receipt;
  };

  const saveRejected = (
    transaction: CommandTransaction,
    identity: ReceiptIdentity,
    error: PublicError,
  ): CommandReceipt => {
    const receipt = createRejectedReceipt({ ...identity, error });
    transaction.saveReceipt(receipt);
    return receipt;
  };

  return {
    async submitArchive(principal: unknown, envelope: ProjectArchiveEnvelope, digest: string): Promise<CommandReceipt> {
      assertTrustedPrincipal(principal);
      const owner: TrustedPrincipal = principal;
      const operation = 'project.archive';
      const enter = store.transact<EnterOutcome>(`${operation}.enter`, transaction => {
        const replayed = replay(owner, transaction.findReceipt(owner.principalId, envelope.commandId), digest, operation);
        if (replayed !== undefined) return { kind: 'receipt', receipt: replayed };
        assertMaintenance();
        const now = nowUtcMs();
        evaluateTiming(envelope, now, operation);
        const identity = identityOf(owner, envelope, digest, now);
        const project = requireProject(envelope.scope.projectId, operation, transaction);
        if (project.status === 'active') {
          if (project.revision !== envelope.expectedRevision) {
            return { kind: 'receipt', receipt: saveRejected(transaction, identity, revisionConflict(envelope.expectedRevision, project.revision)) };
          }
          transaction.transitionProjectStatus({
            operation: 'archive',
            projectId: envelope.scope.projectId,
            expectedRevision: envelope.expectedRevision,
          });
          saveCheckpoint(transaction, envelope, digest, now, { phase: 'entered', fromRevision: project.revision });
          return { kind: 'waiting' };
        }
        if (project.status === 'archiving') {
          // 同 commandId 凭检查点继续（不同参数冲突）；新命令须持当前 revision 显式继续。
          const checkpoint = transaction.findReceipt(PROJECT_ARCHIVE_CHECKPOINT_PRINCIPAL_ID, envelope.commandId);
          if (checkpoint !== undefined) {
            if (checkpoint.requestDigest !== digest) {
              throw new PublicError('conflict', operation, undefined, { details: { reason: 'command_reused' } });
            }
          } else {
            if (envelope.expectedRevision !== project.revision) {
              return { kind: 'receipt', receipt: saveRejected(transaction, identity, revisionConflict(envelope.expectedRevision, project.revision)) };
            }
            saveCheckpoint(transaction, envelope, digest, now, { phase: 'continued', fromRevision: project.revision });
          }
          return { kind: 'waiting' };
        }
        if (project.status === 'archived') {
          // 已归档：幂等直接核验收尾（settle 返回 settled=true），不重复进入等待。
          return { kind: 'already' };
        }
        return { kind: 'receipt', receipt: saveRejected(transaction, identity, lifecycleConflict()) };
      });
      if (enter.kind === 'receipt') return enter.receipt;
      if (enter.kind === 'waiting') await awaitCloseout(envelope.scope.projectId);
      return store.transact(`${operation}.settle`, transaction => settleReceipt(owner, envelope, digest, transaction));
    },

    async submitRestore(principal: unknown, envelope: ProjectRestoreEnvelope, digest: string): Promise<CommandReceipt> {
      assertTrustedPrincipal(principal);
      const owner: TrustedPrincipal = principal;
      const operation = 'project.restore';
      return store.transact(operation, transaction => {
        const replayed = replay(owner, transaction.findReceipt(owner.principalId, envelope.commandId), digest, operation);
        if (replayed !== undefined) return replayed;
        assertMaintenance();
        const now = nowUtcMs();
        evaluateTiming(envelope, now, operation);
        const identity = identityOf(owner, envelope, digest, now);
        const project = requireProject(envelope.scope.projectId, operation, transaction);
        if (project.status !== 'archived') {
          return saveRejected(transaction, identity, lifecycleConflict());
        }
        if (project.revision !== envelope.expectedRevision) {
          return saveRejected(transaction, identity, revisionConflict(envelope.expectedRevision, project.revision));
        }
        const updated = transaction.transitionProjectStatus({
          operation: 'restore',
          projectId: envelope.scope.projectId,
          expectedRevision: envelope.expectedRevision,
        });
        const receipt = createCompletedReceipt({
          ...identity,
          resultRef: createResultRef(randomBytes(32)),
          result: { status: 'active', project: toPublicProjectRecord(updated) },
        });
        transaction.saveReceipt(receipt);
        return receipt;
      });
    },

    readCloseout(projectId: string): ProjectLifecycleCloseout {
      return options.readCloseout(projectId);
    },
  };
}

function saveCheckpoint(
  transaction: CommandTransaction,
  envelope: ProjectArchiveEnvelope,
  digest: string,
  now: number,
  result: Record<string, unknown>,
): void {
  transaction.saveReceipt(createCompletedReceipt({
    principalId: PROJECT_ARCHIVE_CHECKPOINT_PRINCIPAL_ID,
    commandId: envelope.commandId,
    operation: 'project.archive',
    scope: envelope.scope,
    requestDigest: digest,
    issuedAt: envelope.issuedAt,
    completedAt: new Date(now).toISOString(),
    resultRef: createResultRef(randomBytes(32)),
    result,
  }));
}

function evaluateTiming(envelope: ProjectArchiveEnvelope | ProjectRestoreEnvelope, now: number, operation: string): void {
  const verdict = evaluateCommandTiming(envelope, now);
  if (verdict.kind === 'expired') {
    throw new PublicError('command_expired', operation, undefined, { details: { reason: 'command_expired' } });
  }
  if (verdict.kind === 'clock_skew') {
    throw new PublicError('invalid_input', operation, undefined, { details: { field: 'issuedAt', reason: 'clock_skew' } });
  }
}

function revisionConflict(expectedRevision: number, actualRevision: number): PublicError {
  return new PublicError('conflict', 'project.archive', undefined, {
    details: { reason: 'stale_revision', expectedRevision, actualRevision, entityType: 'project' },
  });
}

function lifecycleConflict(): PublicError {
  return new PublicError('conflict', 'project.archive', undefined, {
    details: { reason: 'invalid_project_transition', entityType: 'project' },
  });
}

export type { ProjectArchiveEnvelope, ProjectRestoreEnvelope };
