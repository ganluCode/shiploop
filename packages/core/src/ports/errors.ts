/**
 * F-002 结构化存储错误（ports 契约层）。
 *
 * 设计依据：core-design/03 §3（busy 冲突有限退避后返回结构化错误）、
 * §6（不支持的高版本拒绝写入）与 core-design/11 §1（CAS revision）。
 *
 * 约定：
 * - 每个错误都携带 kind、operation（发生操作）与适用的实体身份（entity），
 *   供 Host/CLI 做结构化呈现与重试决策，不依赖错误文案匹配；
 * - details 只放可序列化、已脱敏的诊断字段（如 field/reason/expectedRevision），
 *   绝不放凭据、payload 原文或完整用户路径；
 * - TypeScript 类型只是编译期提示：跨越端口边界的外部 JSON 必须经
 *   ports/validation.ts 的运行时校验，校验失败抛 kind='validation' 的本错误。
 */
export type StorageEntityType =
  | 'project'
  | 'repository_binding'
  | 'global_settings'
  | 'project_settings'
  | 'artifact'
  | 'migration'
  /** P02-2 / F-006：幂等命令回执（command_receipts，迁移 v3）。 */
  | 'command_receipt'
  /** P02-3 / F-007：不可变基线授权（baseline_authorizations，迁移 v4）。 */
  | 'baseline_authorization'
  /** P02-3 / F-007：基线操作生命周期（baseline_operations，迁移 v4）。 */
  | 'baseline_operation'
  /** P02-3 / F-007：基线逐项检查输入快照与结果（baseline_check_results，迁移 v4）。 */
  | 'baseline_check_result'
  /** P02-3 / F-007：全局单并发占用（baseline_occupancy，迁移 v4）。 */
  | 'baseline_occupancy'
  /** P03-1 / F-001：计划校验错误归属的 Feature 聚合（持久化表随 F-002 迁移建立）。 */
  | 'feature'
  /** P03-1 / F-001：计划 DAG 校验错误的节点定位（持久化表随 F-002 迁移建立）。 */
  | 'task'
  /** P03-1 / F-002：阶段（phases，迁移 v6）。 */
  | 'phase'
  /** P03-1 / F-002：同 Feature 任务依赖边（task_dependencies，迁移 v6）。 */
  | 'task_dependency'
  /** P03-3 / F-002：单 Feature 执行批次（execution_batches，迁移 v9）。 */
  | 'execution_batch'
  /** P03-3 / F-002：执行 Run（runs，迁移 v9）。 */
  | 'run'
  /** P03-3 / F-002：批次预算修订记录（batch_budget_revisions，迁移 v9）。 */
  | 'batch_budget_revision'
  /** P03-3 / F-006：Task 尝试预占账本（task_attempt_reservations，迁移 v11）。 */
  | 'task_attempt_reservation'
  /** P03-3 / F-007：Runtime 启动预占账本（runtime_start_reservations，迁移 v12）。 */
  | 'runtime_start_reservation'
  /** P03-3 / F-008：Run 结果结算账本（run_outcome_settlements，迁移 v13）。 */
  | 'attempt'
  | 'workspace_lease'
  | 'run_outcome_settlement'
  | 'workspace'
  | 'workspace_operation'
  /** P03-6 / F-006：最小 Work Session（sessions，迁移 v20）。 */
  | 'work_session'
  /** P03-7 / F-002：验证批次（verification_batches，迁移 v21）。 */
  | 'verification_batch'
  /** P03-7 / F-002：逐项检查结果（check_results，迁移 v21）。 */
  | 'check_result'
  /** P03-8 / F-002：受控 Git 提交意图与操作回执（git_operations，迁移 v26）。 */
  | 'git_operation'
  /** P04-9 / F-001：Run 级持久派发认领（run_dispatch_claims，迁移 v33）。 */
  | 'run_dispatch_claim'
  /** P04-9 / F-001：单执行槽位认领（execution_slot_claims，迁移 v33）。 */
  | 'execution_slot_claim'
  /** P04-9 / F-002：Run 持久入队意图（run_dispatch_intents，迁移 v34）。 */
  | 'run_dispatch_intent';

export type StorageErrorKind =
  /** 外部输入未通过运行时校验（缺字段/类型错误/未知 schemaVersion/非法摘要等）。 */
  | 'validation'
  /** 请求的实体不存在。 */
  | 'not_found'
  /** CAS revision 冲突、唯一性冲突或状态前置条件不满足（如终态不可覆盖）。 */
  | 'conflict'
  /** 有界 busy 等待/重试预算耗尽（F-004 起由适配器产生）。 */
  | 'busy'
  /** 持久化数据损坏：非法 JSON、未知格式、正文缺失或摘要/大小不匹配。 */
  | 'corrupt'
  /** 库或数据的版本高于本版本支持范围，拒绝写入（F-005 起由适配器产生）。 */
  | 'unsupported_version'
  /** 跨项目归属违规：请求实体存在但不属于给定 projectId。 */
  | 'ownership';

/** 适用实体身份：错误归属于哪类实体、哪个实例、哪个项目。 */
export interface StorageEntityRef {
  readonly type: StorageEntityType;
  readonly id?: string;
  readonly projectId?: string;
}

export interface StorageErrorOptions {
  readonly entity?: StorageEntityRef;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  readonly operation: string;
  readonly entity: StorageEntityRef | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    kind: StorageErrorKind,
    operation: string,
    message: string,
    options: StorageErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'StorageError';
    this.kind = kind;
    this.operation = operation;
    this.entity = options.entity;
    this.details = options.details;
  }
}

/** 类型守卫；kind 传入时同时按错误类别收窄。 */
export function isStorageError(value: unknown, kind?: StorageErrorKind): value is StorageError {
  return value instanceof StorageError && (kind === undefined || value.kind === kind);
}
