/**
 * F-004 事务故障注入（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 注入面沿用 P01-4 既有端口：真实 SQLite `CREATE TEMP TRIGGER … RAISE(ABORT)`
 * （见 test/p01-4-sqlite-rollback-and-cas.test.ts 头部「与 F-005/F-007/F-010
 * 同一注入面」），不是 mock、不是方法调用计数。触发器是**连接级 TEMP 对象**：
 * 必须安装在执行业务事务的同一条 better-sqlite3 连接上，连接关闭即消亡。
 *
 * 关键注入点（契约 F-004/F-007：业务写入后、事件/回执写入前）：
 * - stateEventsBeforeInsert：同一 BEGIN IMMEDIATE 内业务行 UPDATE/INSERT
 *   已执行，state_events 插入处确定性 ABORT → better-sqlite3 事务包装器
 *   ROLLBACK，业务 revision/payload/事件整组回滚；
 * - commandReceiptsBeforeInsert：F-006 迁移 v3 之后才存在；在 v2 库安装
 *   必须显式失败（no such table），不允许静默成功；
 * - 业务表 BEFORE INSERT 点用于「首个写入后失败」与「首个写入即失败」场景。
 *
 * 安全约束：表名/时机/触发器名全部走白名单与标识符正则，错误消息固定为
 * `p02-2 injected fault: <label>`，不接受任意 SQL 片段或携带输入值的文本。
 */
import type Database from 'better-sqlite3';

export type FaultWhen = 'BEFORE' | 'AFTER';
export type FaultOperation = 'INSERT' | 'UPDATE' | 'DELETE';

export interface WriteFaultPoint {
  readonly table: string;
  readonly when: FaultWhen;
  readonly operation: FaultOperation;
  /** 固定错误标签（[a-z0-9_]），进入默认注入消息。 */
  readonly label: string;
}

function point(
  table: string,
  when: FaultWhen,
  operation: FaultOperation,
  label: string,
): WriteFaultPoint {
  return Object.freeze({ table, when, operation, label });
}

/**
 * P02-2 冻结故障点。commandReceiptsBeforeInsert 依赖 F-006 迁移 v3；
 * 其余点对应 v1/v2 既有表。
 */
export const WRITE_FAULT_POINTS = Object.freeze({
  projectsBeforeInsert: point('projects', 'BEFORE', 'INSERT', 'projects_before_insert'),
  repositoryBindingsBeforeInsert: point(
    'repository_bindings',
    'BEFORE',
    'INSERT',
    'repository_bindings_before_insert',
  ),
  globalSettingsBeforeInsert: point(
    'global_settings',
    'BEFORE',
    'INSERT',
    'global_settings_before_insert',
  ),
  globalSettingsBeforeUpdate: point(
    'global_settings',
    'BEFORE',
    'UPDATE',
    'global_settings_before_update',
  ),
  projectSettingsBeforeInsert: point(
    'project_settings',
    'BEFORE',
    'INSERT',
    'project_settings_before_insert',
  ),
  projectSettingsBeforeUpdate: point(
    'project_settings',
    'BEFORE',
    'UPDATE',
    'project_settings_before_update',
  ),
  /** 业务写后、事件写前（F-007 原子提交回滚的关键注入点）。 */
  stateEventsBeforeInsert: point(
    'state_events',
    'BEFORE',
    'INSERT',
    'state_events_before_insert',
  ),
  stateEventsBeforeUpdate: point(
    'state_events',
    'BEFORE',
    'UPDATE',
    'state_events_before_update',
  ),
  /** 业务与事件写后、回执写前（F-006 迁移 v3 之后可用）。 */
  commandReceiptsBeforeInsert: point(
    'command_receipts',
    'BEFORE',
    'INSERT',
    'command_receipts_before_insert',
  ),
} satisfies Record<string, WriteFaultPoint>);

/** 允许安装故障触发器的表白名单（与冻结点一致，拒绝任意标识符拼接）。 */
const ALLOWED_TABLES: ReadonlySet<string> = new Set(
  Object.values(WRITE_FAULT_POINTS).map((faultPoint) => faultPoint.table),
);

const TRIGGER_NAME_PATTERN = /^p022_fault_[a-z0-9_]{1,48}$/;
const LABEL_PATTERN = /^[a-z0-9_]{1,64}$/;
const FAULT_MESSAGE_PATTERN = /^p02-2 injected fault: [a-z0-9_]{1,64}$/;

export interface InstallWriteFaultInput {
  readonly target: WriteFaultPoint;
  /** 默认 `p02-2 injected fault: <target.label>`；只允许受控字符。 */
  readonly message?: string;
  /** 默认唯一自动名；显式提供时必须匹配 p022_fault_<a-z0-9_>。 */
  readonly triggerName?: string;
}

export interface InstalledWriteFault {
  readonly name: string;
  readonly target: WriteFaultPoint;
  readonly message: string;
  readonly removed: boolean;
  /** DROP TEMP TRIGGER；幂等。 */
  remove(): void;
}

let triggerCounter = 0;

function isWriteFaultPoint(value: unknown): value is WriteFaultPoint {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<WriteFaultPoint>;
  return (
    typeof candidate.table === 'string' &&
    (candidate.when === 'BEFORE' || candidate.when === 'AFTER') &&
    (candidate.operation === 'INSERT' ||
      candidate.operation === 'UPDATE' ||
      candidate.operation === 'DELETE') &&
    typeof candidate.label === 'string'
  );
}

/**
 * 在给定 better-sqlite3 连接上安装连接级 TEMP 故障触发器。
 * 目标表不存在（如 v3 之前的 command_receipts）时抛出显式错误且不留残留。
 */
export function installWriteFault(
  database: Database.Database,
  input: InstallWriteFaultInput,
): InstalledWriteFault {
  if (!isWriteFaultPoint(input?.target)) {
    throw new TypeError('installWriteFault: target 必须是冻结 WriteFaultPoint');
  }
  const target = input.target;
  if (!ALLOWED_TABLES.has(target.table)) {
    throw new TypeError(`installWriteFault: 表不在注入白名单内：${target.table}`);
  }
  if (!LABEL_PATTERN.test(target.label)) {
    throw new TypeError(`installWriteFault: 非法故障标签：${target.label}`);
  }
  const message = input.message ?? `p02-2 injected fault: ${target.label}`;
  if (!FAULT_MESSAGE_PATTERN.test(message)) {
    throw new TypeError(
      'installWriteFault: 故障消息必须形如 p02-2 injected fault: <a-z0-9_>',
    );
  }
  const name =
    input.triggerName ??
    `p022_fault_${process.pid}_${(triggerCounter += 1)}_${Math.random().toString(36).slice(2, 8)}`;
  if (!TRIGGER_NAME_PATTERN.test(name)) {
    throw new TypeError(`installWriteFault: 非法触发器名：${name}`);
  }
  if (database === null || typeof database !== 'object' || typeof (database as { exec?: unknown }).exec !== 'function') {
    throw new TypeError('installWriteFault: database 必须是 better-sqlite3 连接');
  }

  // 消息字符已由白名单约束为 [a-z0-9_: ]，插值不构成注入面。
  const ddl =
    `CREATE TEMP TRIGGER ${name} ${target.when} ${target.operation} ON ${target.table} ` +
    `BEGIN SELECT RAISE(ABORT, '${message}'); END`;
  try {
    database.exec(ddl);
  } catch (error) {
    throw new Error(
      `installWriteFault: 无法在表 ${target.table} 安装故障触发器` +
        `（迁移是否已到？）：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  let removed = false;
  return {
    name,
    target,
    message,
    get removed(): boolean {
      return removed;
    },
    remove(): void {
      if (removed) {
        return;
      }
      database.exec(`DROP TRIGGER ${name}`);
      removed = true;
    },
  };
}
