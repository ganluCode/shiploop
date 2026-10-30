/**
 * P07-3 / F-008：项目软归档、等待收尾与显式恢复的窄端口。
 *
 * 设计依据：FR-2、core-design/02 项目生命周期、03 §6、04 §3、08 §2。
 *
 * 契约要点：
 * - 归档是**管理状态**转换（active→archiving→archived），不删除、不移动源仓库、
 *   Git worktree、制品、Session 及历史结果；文件与历史事实原样保留；
 * - 进入 archiving 即刻阻止新规划/Batch/Run/Attempt（各自短写事务内重核项目
 *   status='active'）；已开始的执行沿既有安全收尾路径完成；
 * - 只有项目级活动占用与相关停止证据全部收口（closeout 无阻塞）才允许
 *   archiving→archived；超时或停止不明保持可查询的 archiving 状态，不伪造
 *   archived；
 * - 显式恢复只允许 archived→active（与数据备份恢复 data.backup.restore 是不同
 *   操作，公开名称与命令互不通用）；恢复只重核归属与 revision，不自动恢复
 *   Run、不清预算、不重复已通过 Task；
 * - 与 F-001 的 ProjectLifecyclePort/validateProjectLifecycleRequest 共用底层
 *   迁移表（PROJECT_LIFECYCLE_TRANSITIONS），不向普通元数据更新暴露任意
 *   status 写入。
 */
import type { CommandReceipt } from './commands.js';
import type { ValidatedCommandEnvelope } from './commands.js';
import type { ProjectRecord, ProjectStatus } from './state-store.js';

/** 命令信封公共字段（与 ports/commands.ts 的 EnvelopeCommon 同形；本地声明避免导出内部类型）。 */
interface LifecycleEnvelopeCommon {
  readonly schemaVersion: typeof import('./commands.js').WIRE_MESSAGE_SCHEMA_VERSION;
  readonly commandId: string;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
}

/** 项目状态迁移审计事件（同一短事务内随状态写入追加；payload 只含 from/to）。 */
export const PROJECT_STATUS_CHANGED_EVENT_TYPE = 'project.status_changed';

/**
 * 归档命令的进程内幂等锚点主体：enter 事务以真实 commandId + 请求摘要持久化
 * 一条 completed 检查点回执（与 workspace discard 的内部检查点同一先例），
 * 使崩溃/重启后同一 commandId 的重放能继续收尾核验而不是 CAS 失败。
 */
export const PROJECT_ARCHIVE_CHECKPOINT_PRINCIPAL_ID = 'core-project-archive';

/** 项目归档收尾的阻塞占用事实（全部为项目级聚合计数；值为 0 才可收口）。 */
export interface ProjectArchiveBlockers {
  /** 非终态 Batch（含规划/工作/最终化用途）。 */
  readonly activeBatches: number;
  /** 非终态 Run。 */
  readonly activeRuns: number;
  /** preparing/executing/verifying 的 Attempt。 */
  readonly activeAttempts: number;
  /** held/quarantined 的 worktree 租约。 */
  readonly heldWorkspaceLeases: number;
  /** held/quarantined 的 Run 派发认领。 */
  readonly heldDispatchClaims: number;
  /** held/quarantined 的执行槽位认领。 */
  readonly heldSlotClaims: number;
  /** 未确认停止（status<>'stopped' 或 stop_confirmed<>1）的停止操作。 */
  readonly unconfirmedStops: number;
  /** accepted/running/cancelling 的基线操作（同项目）。 */
  readonly activeBaselineOperations: number;
}

export function hasProjectArchiveBlockers(blockers: ProjectArchiveBlockers): boolean {
  return blockers.activeBatches > 0
    || blockers.activeRuns > 0
    || blockers.activeAttempts > 0
    || blockers.heldWorkspaceLeases > 0
    || blockers.heldDispatchClaims > 0
    || blockers.heldSlotClaims > 0
    || blockers.unconfirmedStops > 0
    || blockers.activeBaselineOperations > 0;
}

/** 归档收尾只读快照：阻塞计数 + 当前状态 + 是否可收口。 */
export interface ProjectLifecycleCloseout {
  readonly projectId: string;
  readonly status: ProjectStatus;
  readonly blockers: ProjectArchiveBlockers;
  /** 全部阻塞为 0 才为 true；true 不代表已完成迁移，迁移在写事务内提交。 */
  readonly clear: boolean;
}

export type ProjectArchiveEnvelope = LifecycleEnvelopeCommon & {
  readonly operation: 'project.archive';
  readonly scope: { readonly kind: 'project'; readonly projectId: string };
  readonly expectedRevision: number;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type ProjectRestoreEnvelope = LifecycleEnvelopeCommon & {
  readonly operation: 'project.restore';
  readonly scope: { readonly kind: 'project'; readonly projectId: string };
  readonly expectedRevision: number;
  readonly payload: Readonly<Record<string, unknown>>;
};

export function isProjectArchiveEnvelope(
  envelope: ValidatedCommandEnvelope,
): envelope is ProjectArchiveEnvelope {
  return envelope.operation === 'project.archive';
}

export function isProjectRestoreEnvelope(
  envelope: ValidatedCommandEnvelope,
): envelope is ProjectRestoreEnvelope {
  return envelope.operation === 'project.restore';
}

/** 归档等待收尾的默认预算与轮询间隔（Host quiesce 同量级；测试可注入更小值）。 */
export const PROJECT_ARCHIVE_CLOSEOUT_BUDGET_MS = 10_000;
export const PROJECT_ARCHIVE_CLOSEOUT_POLL_INTERVAL_MS = 100;

export interface ProjectLifecycleCommandHandlerOptions {
  /** 事务外只读收尾快照来源（SQLite 一致读；由可信装配注入）。 */
  readonly readCloseout: (projectId: string) => ProjectLifecycleCloseout;
  /** 收尾等待预算（毫秒）；默认 PROJECT_ARCHIVE_CLOSEOUT_BUDGET_MS。 */
  readonly closeoutBudgetMs?: number;
  /** 收尾轮询间隔（毫秒）；默认 PROJECT_ARCHIVE_CLOSEOUT_POLL_INTERVAL_MS。 */
  readonly closeoutPollIntervalMs?: number;
  /** 可注入休眠（默认 setTimeout）；测试用屏障控制等待窗口。 */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly nowUtcMs?: () => number;
}

/**
 * 命令面窄句柄：commandService 在授权/信封校验之后把 project.archive /
 * project.restore 路由到这里；enter/settle/restore 各自的短写事务内重核
 * 重放、维护占用与 CAS，状态、事件与回执原子提交。
 */
export interface ProjectLifecycleCommandHandler {
  submitArchive(principal: unknown, envelope: ProjectArchiveEnvelope, digest: string): Promise<CommandReceipt>;
  submitRestore(principal: unknown, envelope: ProjectRestoreEnvelope, digest: string): Promise<CommandReceipt>;
  /** 只读收尾快照（不在写事务内调用）。 */
  readCloseout(projectId: string): ProjectLifecycleCloseout;
}

/** 归档命令回执 result（settled=true 时 status 恒为 'archived'）。 */
export interface ProjectArchiveReceiptResult {
  readonly status: 'archiving' | 'archived';
  readonly settled: boolean;
  readonly project: ProjectRecord;
  readonly blockers?: ProjectArchiveBlockers;
}
