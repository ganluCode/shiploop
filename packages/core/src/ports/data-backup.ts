/**
 * P07-3 / F-014：备份创建、核验与隔离恢复的默认接线契约（application 端口）。
 *
 * 设计依据：input/p07-reliability FR-1、core-design/08 §1/§2/§4/§5.1/§6 与
 * docs/p07-3-f008-project-lifecycle.md 的命令边界（数据备份恢复 =
 * `data.backup.restore`，与项目恢复互不通用）。
 *
 * 不变量：
 * - 备份创建是长 I/O 操作：命令面只持久化 accepted 回执（稳定 operationId），
 *   实际导出由受信执行编排在回执事务提交后运行；完成状态取自持久结果
 *   （备份包 manifest/报告与操作日志），不重复导出（同 commandId 重放原回执）；
 * - 备份核验是只读命令：事务外完成包内数据库/正文/引用核验，事务内只持久化
 *   completed 回执（报告如实携带 complete/incomplete/failed/rejected）；
 * - `data.backup.restore` 不经 HTTP 执行：实际发布只在持有目标数据根 writer
 *   锁的独立维护入口（offline restore service）进行，本命令面不接线；
 * - 备份目标/恢复源由 owner 管理入口显式选择并转换为受控引用（target 固定
 *   受管 `backups/` 根；packagePath 仅由受信装配从 backupId 推导）；受限
 *   Work 工具操作表不含 data.* 操作，认证失败不回退 owner；
 * - 操作日志/查询结果不包含绝对路径、凭据或 Host 认证材料。
 */
import type { TrustedPrincipal } from './authorization.js';
import type { BackupPackageReport, BackupPackageService } from './backup-package.js';
import type { BackupManifest } from './data-lifecycle.js';
import type { BackupVerificationReport, BackupPackageVerificationService } from './backup-verification.js';
import type { CommandReceipt } from './commands.js';
import type { MaintenanceWriteGate } from './data-maintenance.js';

export const DATA_BACKUP_CREATE_OPERATION = 'data.backup.create' as const;
export const DATA_BACKUP_VERIFY_OPERATION = 'data.backup.verify' as const;

/** Host 只读查询操作（与 Host 能力宣告同步；授权复用 data.backup 能力位）。 */
export const BACKUPS_GET_OPERATION = 'backups.get' as const;
export const BACKUP_OPERATIONS_GET_OPERATION = 'backup.operations.get' as const;
export const DATA_BACKUP_QUERY_OPERATIONS = [
  BACKUPS_GET_OPERATION,
  BACKUP_OPERATIONS_GET_OPERATION,
] as const;

/** 备份目标的唯一受控引用：数据根内受管 `backups/` 根目录。 */
export const DATA_BACKUP_DEFAULT_TARGET = 'default' as const;

export interface DataBackupReceiptIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly operation: typeof DATA_BACKUP_CREATE_OPERATION | typeof DATA_BACKUP_VERIFY_OPERATION;
  readonly scope: { readonly kind: 'global' };
  readonly requestDigest: string;
  readonly issuedAt: string;
}

export interface PreparedDataBackupCreate {
  readonly backupId: string;
  readonly target: typeof DATA_BACKUP_DEFAULT_TARGET;
}

export interface PreparedDataBackupVerify {
  readonly report: BackupVerificationReport;
}

/**
 * 命令面端口：事务外准备（目标引用解析/包核验）+ 事务内回执持久化。
 * 端口缺席时两个命令 unsupported（不冒充能力）；装配者：composition 根。
 */
export interface DataBackupCommandPort {
  prepareCreate(principal: TrustedPrincipal, payload: Readonly<Record<string, unknown>>): Promise<PreparedDataBackupCreate>;
  submitCreate(
    identity: DataBackupReceiptIdentity,
    prepared: PreparedDataBackupCreate,
    transaction: { saveReceipt(receipt: CommandReceipt): void },
    completedAtUtcMs: number,
  ): CommandReceipt;
  prepareVerify(principal: TrustedPrincipal, payload: Readonly<Record<string, unknown>>): Promise<PreparedDataBackupVerify>;
  submitVerify(
    identity: DataBackupReceiptIdentity,
    prepared: PreparedDataBackupVerify,
    transaction: { saveReceipt(receipt: CommandReceipt): void },
    completedAtUtcMs: number,
  ): CommandReceipt;
}

/** 操作日志状态：running 之后只有终态 completed/failed（不虚构中断转移）。 */
export type DataBackupOperationStatus = 'running' | 'completed' | 'failed';

export interface DataBackupOperationReportSummary {
  readonly status: BackupPackageReport['status'];
  readonly backupId: string;
  readonly scannedProjects: number;
  readonly scannedArtifacts: number;
  readonly copiedFiles: number;
  readonly totalBytes: number;
  readonly durationMs: number;
  readonly reasons: readonly string[];
}

export interface DataBackupOperationRecord {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly kind: 'backup';
  readonly commandId: string;
  readonly backupId: string;
  readonly target: string;
  readonly status: DataBackupOperationStatus;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
  readonly manifestDigest?: string;
  readonly reason?: string;
  readonly report?: DataBackupOperationReportSummary;
}

/** 操作日志窄端口（fs 适配器实现；application 不直接触碰文件系统布局）。 */
export interface DataBackupOperationJournal {
  save(record: DataBackupOperationRecord): void;
  read(operationId: string): DataBackupOperationRecord | null;
}

export type BackupPackageFacts =
  | {
    readonly status: 'complete';
    readonly backupId: string;
    readonly manifestDigest: string;
    readonly manifest: BackupManifest;
  }
  | {
    readonly status: 'incomplete' | 'failed';
    readonly backupId: string;
    readonly report: DataBackupOperationReportSummary;
  };

/** 备份包持久事实读取（manifest/报告；不存在返回 null，不抛存在性差异）。 */
export interface BackupPackageFactsReader {
  read(backupId: string): BackupPackageFacts | null;
}

export interface DataBackupQueryService {
  getBackup(principal: TrustedPrincipal, backupId: string): Promise<DataBackupQueryResult>;
  getOperation(principal: TrustedPrincipal, operationId: string): Promise<DataBackupOperationQueryResult>;
}

export interface DataBackupQueryResult {
  readonly operation: typeof BACKUPS_GET_OPERATION;
  readonly backupId: string;
  readonly status: 'complete' | 'incomplete' | 'failed';
  readonly manifestDigest?: string;
  readonly manifestSummary?: {
    readonly schemaVersion: number;
    readonly packageVersion: number;
    readonly backupId: string;
    readonly createdAtUtc: string;
    readonly database: { readonly schemaVersion: number; readonly contentDigest: string };
    readonly projectCount: number;
    readonly fileCount: number;
    readonly nativeRecordCount: number;
    readonly externalDependencyCount: number;
  };
  readonly report?: DataBackupOperationReportSummary;
}

export interface DataBackupOperationQueryResult {
  readonly operation: typeof BACKUP_OPERATIONS_GET_OPERATION;
  readonly operationId: string;
  readonly kind: 'backup';
  readonly commandId: string;
  readonly backupId: string;
  readonly target: string;
  readonly status: DataBackupOperationStatus;
  readonly createdAtUtcMs: number;
  readonly updatedAtUtcMs: number;
  readonly manifestDigest?: string;
  readonly reason?: string;
  readonly report?: DataBackupOperationReportSummary;
}

/**
 * 受信执行编排端口：包装通用命令面提交——新的 accepted 回执在事务提交后启动
 * 实际导出（best-effort 后台执行；完成事实持久化到操作日志与备份包目录）。
 * Host 装配将 `data.backup.create` 分流到本端口（与 baseline.run 同一先例）。
 */
export interface DataBackupExecutionPort {
  submit(principal: unknown, envelope: unknown): Promise<CommandReceipt>;
}

export interface DataBackupServiceOptions {
  readonly dataRoot: string;
  readonly backupRoot: string;
  readonly packages: BackupPackageService;
  readonly verification: BackupPackageVerificationService;
  readonly journal: DataBackupOperationJournal;
  readonly facts: BackupPackageFactsReader;
  readonly maintenanceGate?: MaintenanceWriteGate;
  readonly nowUtcMs?: () => number;
}
