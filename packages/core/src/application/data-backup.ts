/**
 * P07-3 / F-014：备份创建/核验命令与查询的 application 服务（默认接线）。
 *
 * 命令语义（信封 payload 深校验已在 ports/commands 经
 * validateDataLifecycleCommandPayload 完成）：
 * - `data.backup.create`（global scope + data.backup 能力）：事务外解析受控
 *   目标引用并预检占用/目标冲突；事务内只持久化 accepted v5 回执（稳定
 *   operationId）。实际导出由 {@link createDataBackupExecutionService} 在回执
 *   事务提交后运行（备份包服务自身持有 backup 维护占用）；完成事实持久化到
 *   备份包目录与操作日志，同 commandId 重放返回原回执、绝不重复导出。
 * - `data.backup.verify`（global scope + data.backup 能力）：事务外对受管
 *   `backups/<backupId>` 包执行只读核验（manifest 摘要必须与请求一致）；
 *   事务内持久化 completed 回执（报告如实携带 complete/incomplete/failed/
 *   rejected，不把 incomplete 折算为命令失败）。
 * - `data.backup.restore` 不在本服务接线：实际恢复只在持有目标数据根 writer
 *   锁的独立维护入口执行（host offline restore service），HTTP 命令面保持
 *   unsupported，不通过 HTTP 替换任何 Host 已打开的数据库。
 *
 * 查询（能力位复用 data.backup，owner 管理；受限主体 403）：
 * - `backups.get`：读取备份包持久事实（manifest 摘要与摘要视图/未完成报告）；
 * - `backup.operations.get`：按稳定 operationId 读取操作日志。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertTrustedPrincipal,
  requireCapability,
} from '../ports/authorization.js';
import type { TrustedPrincipal } from '../ports/authorization.js';
import {
  PublicError,
  createAcceptedReceipt,
  createCompletedReceipt,
  mapToPublicError,
} from '../ports/commands.js';
import type { CommandReceipt } from '../ports/commands.js';
import { createResultRef } from '../ports/command-receipts.js';
import { isStorageError } from '../ports/errors.js';
import { validateStableId } from '../ports/validation.js';
import type { BackupVerificationReport } from '../ports/backup-verification.js';
import type { BackupPackageService } from '../ports/backup-package.js';
import {
  BACKUP_OPERATIONS_GET_OPERATION,
  BACKUPS_GET_OPERATION,
  DATA_BACKUP_CREATE_OPERATION,
  DATA_BACKUP_DEFAULT_TARGET,
  DATA_BACKUP_VERIFY_OPERATION,
} from '../ports/data-backup.js';
import type {
  BackupPackageFactsReader,
  DataBackupCommandPort,
  DataBackupExecutionPort,
  DataBackupOperationJournal,
  DataBackupOperationQueryResult,
  DataBackupOperationRecord,
  DataBackupOperationReportSummary,
  DataBackupQueryResult,
  DataBackupQueryService,
  DataBackupReceiptIdentity,
  PreparedDataBackupCreate,
  PreparedDataBackupVerify,
} from '../ports/data-backup.js';
import type { MaintenanceWriteGate } from '../ports/data-maintenance.js';

const BACKUP_TARGETS: ReadonlySet<string> = new Set([DATA_BACKUP_DEFAULT_TARGET]);

function stableId(value: unknown, operation: string, field: string): string {
  try {
    return validateStableId(value, { operation }, field);
  } catch (error) {
    throw mapToPublicError(error, { operation });
  }
}

function verificationReportResult(report: BackupVerificationReport): Record<string, unknown> {
  return {
    status: report.status,
    backupId: report.backupId,
    manifestDigest: report.manifestDigest,
    checks: report.checks.map(check => ({ name: check.name, status: check.status, ...(check.details === undefined ? {} : { details: check.details }) })),
    reasons: report.reasons,
    scannedFiles: report.scannedFiles,
    verifiedFiles: report.verifiedFiles,
    totalBytes: report.totalBytes,
    durationMs: report.durationMs,
  };
}

function packageReportSummary(report: {
  readonly status: 'complete' | 'incomplete' | 'failed';
  readonly backupId: string;
  readonly scannedProjects: number;
  readonly scannedArtifacts: number;
  readonly copiedFiles: number;
  readonly totalBytes: number;
  readonly durationMs: number;
  readonly reasons: readonly string[];
}): DataBackupOperationReportSummary {
  return {
    status: report.status,
    backupId: report.backupId,
    scannedProjects: report.scannedProjects,
    scannedArtifacts: report.scannedArtifacts,
    copiedFiles: report.copiedFiles,
    totalBytes: report.totalBytes,
    durationMs: report.durationMs,
    reasons: [...new Set(report.reasons)],
  };
}

/** 事务外预检后的占用冲突/目标冲突在准备阶段拒绝（零回执、零副作用）。 */
function assertGateIdle(gate: MaintenanceWriteGate | undefined, operation: string): void {
  const occupancy = gate?.read();
  if (occupancy !== undefined && occupancy.state !== 'idle') {
    throw new PublicError('resource_busy', operation, undefined, {
      details: {
        reason: 'maintenance_occupied',
        operation: occupancy.operation ?? 'unknown',
        operationId: occupancy.operationId ?? undefined,
      },
    });
  }
}

export function createDataBackupCommandPort(options: {
  readonly backupRoot: string;
  readonly verification: import('../ports/backup-verification.js').BackupPackageVerificationService;
  readonly facts: BackupPackageFactsReader;
  readonly maintenanceGate?: MaintenanceWriteGate;
}): DataBackupCommandPort {
  const backupRoot = options.backupRoot;
  const verification = options.verification;

  return Object.freeze({
    async prepareCreate(_principal: TrustedPrincipal, payload: Readonly<Record<string, unknown>>): Promise<PreparedDataBackupCreate> {
      const operation = DATA_BACKUP_CREATE_OPERATION;
      assertGateIdle(options.maintenanceGate, operation);
      const backupId = stableId(payload.backupId, operation, 'payload.backupId');
      const target = stableId(payload.target, operation, 'payload.target');
      if (target !== DATA_BACKUP_DEFAULT_TARGET) {
        throw new PublicError('invalid_input', operation, undefined, {
          details: { field: 'payload.target', reason: 'unknown_backup_target' },
        });
      }
      const facts = options.facts.read(backupId);
      if (facts !== null) {
        // 已有完整包或既有失败/未完成报告：目标身份已被占用，拒绝覆盖。
        throw new PublicError('conflict', operation, undefined, {
          details: { reason: 'backup_target_exists', backupId },
        });
      }
      return { backupId, target };
    },

    submitCreate(
      identity: DataBackupReceiptIdentity,
      prepared: PreparedDataBackupCreate,
      transaction: { saveReceipt(receipt: CommandReceipt): void },
      completedAtUtcMs: number,
    ): CommandReceipt {
      void backupRoot;
      const receipt = createAcceptedReceipt({
        principalId: identity.principalId,
        commandId: identity.commandId,
        operation: DATA_BACKUP_CREATE_OPERATION,
        scope: identity.scope,
        requestDigest: identity.requestDigest,
        issuedAt: identity.issuedAt,
        completedAt: new Date(completedAtUtcMs).toISOString(),
        operationId: randomUUID(),
        backupId: prepared.backupId,
      });
      transaction.saveReceipt(receipt);
      return receipt;
    },

    async prepareVerify(_principal: TrustedPrincipal, payload: Readonly<Record<string, unknown>>): Promise<PreparedDataBackupVerify> {
      const operation = DATA_BACKUP_VERIFY_OPERATION;
      const backupId = stableId(payload.backupId, operation, 'payload.backupId');
      const manifestDigest = stableId(payload.manifestDigest, operation, 'payload.manifestDigest');
      const facts = options.facts.read(backupId);
      if (facts === null || facts.status !== 'complete') {
        throw new PublicError('not_found', operation, undefined, {
          details: { reason: 'backup_package_not_found', backupId },
        });
      }
      let report: BackupVerificationReport;
      try {
        report = await verification.verify({
          packagePath: join(backupRoot, backupId),
          expectedBackupId: backupId,
        });
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
      if (report.manifestDigest !== manifestDigest) {
        throw new PublicError('conflict', operation, undefined, {
          details: { reason: 'manifest_digest_mismatch', backupId },
        });
      }
      return { report };
    },

    submitVerify(
      identity: DataBackupReceiptIdentity,
      prepared: PreparedDataBackupVerify,
      transaction: { saveReceipt(receipt: CommandReceipt): void },
      completedAtUtcMs: number,
    ): CommandReceipt {
      const receipt = createCompletedReceipt({
        principalId: identity.principalId,
        commandId: identity.commandId,
        operation: DATA_BACKUP_VERIFY_OPERATION,
        scope: identity.scope,
        requestDigest: identity.requestDigest,
        issuedAt: identity.issuedAt,
        completedAt: new Date(completedAtUtcMs).toISOString(),
        resultRef: createResultRef(randomBytes(32)),
        result: verificationReportResult(prepared.report),
      });
      transaction.saveReceipt(receipt);
      return receipt;
    },
  });
}

interface BackupPackageFailureLike {
  readonly reason?: unknown;
  readonly report?: {
    readonly status?: unknown;
    readonly backupId?: unknown;
    readonly scannedProjects?: unknown;
    readonly scannedArtifacts?: unknown;
    readonly copiedFiles?: unknown;
    readonly totalBytes?: unknown;
    readonly durationMs?: unknown;
    readonly reasons?: unknown;
  };
}

function failureSummary(error: unknown, backupId: string): { reason: string; report: DataBackupOperationReportSummary } {
  const candidate = error as BackupPackageFailureLike | null;
  const reason = typeof candidate?.reason === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate.reason)
    ? candidate.reason
    : 'backup_failed';
  const report = candidate?.report;
  const numbers = (value: unknown): number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const summary: DataBackupOperationReportSummary = report === null || report === undefined || typeof report !== 'object'
    ? {
      status: 'failed', backupId, scannedProjects: 0, scannedArtifacts: 0,
      copiedFiles: 0, totalBytes: 0, durationMs: 0, reasons: [reason],
    }
    : {
      status: report.status === 'incomplete' ? 'incomplete' : 'failed',
      backupId,
      scannedProjects: numbers(report.scannedProjects),
      scannedArtifacts: numbers(report.scannedArtifacts),
      copiedFiles: numbers(report.copiedFiles),
      totalBytes: numbers(report.totalBytes),
      durationMs: numbers(report.durationMs),
      reasons: Array.isArray(report.reasons)
        ? [...new Set(report.reasons.filter((item): item is string => typeof item === 'string'))]
        : [reason],
    };
  return { reason, report: summary };
}

/**
 * 受信执行编排：accepted 回执提交并提交事务之后才启动实际导出（与
 * baseline.run 同一先例）。失败写入操作日志（status=failed + reason），不
 * 改写已持久化的 accepted 回执；重放/非 accepted 回执绝不重复执行。
 */
export function createDataBackupExecutionService(options: {
  readonly commands: import('../application/command-service.js').CommandService;
  readonly packages: BackupPackageService;
  readonly journal: DataBackupOperationJournal;
  readonly nowUtcMs?: () => number;
}): DataBackupExecutionPort {
  const now = options.nowUtcMs ?? Date.now;
  const active = new Set<string>();

  function persist(record: DataBackupOperationRecord): void {
    try {
      options.journal.save(record);
    } catch {
      // 日志写失败不撤销已提交回执；查询按 not_found/旧状态如实呈现。
    }
  }

  function executeCreate(
    operationId: string,
    commandId: string,
    principalId: string,
    backupId: string,
    target: string,
  ): void {
    if (active.has(operationId)) return;
    active.add(operationId);
    const started = now();
    persist({
      schemaVersion: 1, operationId, kind: 'backup', commandId, backupId, target,
      status: 'running', createdAtUtcMs: started, updatedAtUtcMs: started,
    });
    void options.packages
      .create({ backupId, owner: principalId, hostInstanceId: randomUUID() })
      .then(result => {
        persist({
          schemaVersion: 1, operationId, kind: 'backup', commandId, backupId, target,
          status: 'completed', createdAtUtcMs: started, updatedAtUtcMs: now(),
          ...(result.report.manifest === undefined ? {} : { manifestDigest: manifestDigestOf(result.manifestPath) }),
          report: packageReportSummary(result.report),
        });
      })
      .catch((error: unknown) => {
        const failure = failureSummary(error, backupId);
        persist({
          schemaVersion: 1, operationId, kind: 'backup', commandId, backupId, target,
          status: 'failed', createdAtUtcMs: started, updatedAtUtcMs: now(),
          reason: failure.reason, report: failure.report,
        });
      })
      .finally(() => { active.delete(operationId); });
  }

  function manifestDigestOf(manifestPath: string): string | undefined {
    try {
      return createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
    } catch {
      return undefined;
    }
  }

  return Object.freeze({
    async submit(principal: unknown, envelope: unknown): Promise<CommandReceipt> {
      assertTrustedPrincipal(principal);
      const operation = 'commands.submit';
      let backupId: string | undefined;
      let target: string | undefined;
      try {
        const parsed = envelope as { readonly payload?: { readonly backupId?: unknown; readonly target?: unknown } } | null;
        if (parsed !== null && typeof parsed === 'object' && parsed.payload !== undefined
          && typeof parsed.payload.backupId === 'string') {
          backupId = parsed.payload.backupId;
          target = typeof parsed.payload.target === 'string' ? parsed.payload.target : DATA_BACKUP_DEFAULT_TARGET;
        }
      } catch {
        backupId = undefined;
      }
      const receipt = await options.commands.submit(principal, envelope);
      if (
        receipt.status === 'accepted' && !receipt.replayed && typeof receipt.operationId === 'string'
        && backupId !== undefined && target !== undefined && !active.has(receipt.operationId)
      ) {
        executeCreate(
          receipt.operationId,
          receipt.commandId,
          (principal as TrustedPrincipal).principalId,
          backupId,
          target,
        );
      }
      return receipt;
    },
  });
}

export function createDataBackupQueryService(options: {
  readonly facts: BackupPackageFactsReader;
  readonly journal: DataBackupOperationJournal;
}): DataBackupQueryService {
  return Object.freeze({
    async getBackup(principal: TrustedPrincipal, backupIdInput: string): Promise<DataBackupQueryResult> {
      assertTrustedPrincipal(principal);
      requireCapability(principal, 'data.backup', BACKUPS_GET_OPERATION);
      const backupId = stableId(backupIdInput, BACKUPS_GET_OPERATION, 'backupId');
      let facts: ReturnType<BackupPackageFactsReader['read']> = null;
      try {
        facts = options.facts.read(backupId);
      } catch (error) {
        throw mapToPublicError(error, { operation: BACKUPS_GET_OPERATION });
      }
      if (facts === null) {
        throw new PublicError('not_found', BACKUPS_GET_OPERATION, undefined, {
          details: { reason: 'backup_package_not_found', backupId },
        });
      }
      if (facts.status === 'complete') {
        return {
          operation: BACKUPS_GET_OPERATION,
          backupId: facts.backupId,
          status: 'complete',
          manifestDigest: facts.manifestDigest,
          manifestSummary: {
            schemaVersion: facts.manifest.schemaVersion,
            packageVersion: facts.manifest.packageVersion,
            backupId: facts.manifest.backupId,
            createdAtUtc: facts.manifest.createdAtUtc,
            database: {
              schemaVersion: facts.manifest.database.schemaVersion,
              contentDigest: facts.manifest.database.contentDigest,
            },
            projectCount: facts.manifest.projects.length,
            fileCount: facts.manifest.files.length,
            nativeRecordCount: facts.manifest.nativeRecords.length,
            externalDependencyCount: facts.manifest.externalDependencies.length,
          },
        };
      }
      return {
        operation: BACKUPS_GET_OPERATION,
        backupId: facts.backupId,
        status: facts.status,
        report: facts.report,
      };
    },

    async getOperation(principal: TrustedPrincipal, operationIdInput: string): Promise<DataBackupOperationQueryResult> {
      assertTrustedPrincipal(principal);
      requireCapability(principal, 'data.backup', BACKUP_OPERATIONS_GET_OPERATION);
      const operationId = stableId(operationIdInput, BACKUP_OPERATIONS_GET_OPERATION, 'operationId');
      let record: DataBackupOperationRecord | null = null;
      try {
        record = options.journal.read(operationId);
      } catch (error) {
        if (isStorageError(error)) {
          throw mapToPublicError(error, { operation: BACKUP_OPERATIONS_GET_OPERATION });
        }
        throw error;
      }
      if (record === null) {
        throw new PublicError('not_found', BACKUP_OPERATIONS_GET_OPERATION, undefined, {
          details: { reason: 'backup_operation_not_found', operationId },
        });
      }
      return {
        operation: BACKUP_OPERATIONS_GET_OPERATION,
        operationId: record.operationId,
        kind: record.kind,
        commandId: record.commandId,
        backupId: record.backupId,
        target: record.target,
        status: record.status,
        createdAtUtcMs: record.createdAtUtcMs,
        updatedAtUtcMs: record.updatedAtUtcMs,
        ...(record.manifestDigest === undefined ? {} : { manifestDigest: record.manifestDigest }),
        ...(record.reason === undefined ? {} : { reason: record.reason }),
        ...(record.report === undefined ? {} : { report: record.report }),
      };
    },
  });
}
