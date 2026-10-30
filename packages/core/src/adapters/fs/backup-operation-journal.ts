/**
 * P07-3 / F-014：备份操作日志与备份包持久事实的 fs 适配器。
 *
 * - 操作日志位于受管 `<backupRoot>/operations/<operationId>.json`：原子写
 *   （tmp + rename），只含受控字段（无绝对路径/凭据）；损坏或非法 JSON 的
 *   日志按 fail-closed 处理（读取抛 StorageError corrupt，不虚构状态）；
 * - 备份包事实读取 `<backupRoot>/<backupId>/manifest.json`（digest 为原始字节
 *   SHA-256，与核验服务同源）与未完成报告 `<backupRoot>/<backupId>.incomplete.json`；
 *   不跟随符号链接，不读取包内其他文件。
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, sep } from 'node:path';
import { StorageError } from '../../ports/errors.js';
import { validateBackupManifest } from '../../ports/data-lifecycle.js';
import type {
  BackupPackageFacts,
  BackupPackageFactsReader,
  DataBackupOperationJournal,
  DataBackupOperationRecord,
  DataBackupOperationReportSummary,
} from '../../ports/data-backup.js';

const OPERATION = 'data.backup.journal';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPORT_STATUS = new Set(['complete', 'incomplete', 'failed']);

function ensureBackupRoot(backupRoot: string): string {
  if (!isAbsolute(backupRoot) || backupRoot.includes('\0')) {
    throw new StorageError('validation', OPERATION, 'backupRoot 必须是绝对路径');
  }
  if (!existsSync(backupRoot)) mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const stat = lstatSync(backupRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new StorageError('validation', OPERATION, 'backupRoot 必须是真实目录');
  }
  return backupRoot;
}

function validId(value: string, field: string): string {
  if (!ID.test(value)) throw new StorageError('validation', OPERATION, `${field} 非法`, { details: { field } });
  return value;
}

function reportSummary(value: unknown): DataBackupOperationRecord['report'] {
  if (value === null || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (row.status !== undefined && !REPORT_STATUS.has(String(row.status))) return undefined;
  const reasons = Array.isArray(row.reasons) ? row.reasons.filter((item): item is string => typeof item === 'string') : [];
  const numbers = (input: unknown): number => (typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : 0);
  return {
    status: REPORT_STATUS.has(String(row.status)) ? (String(row.status) as 'complete' | 'incomplete' | 'failed') : 'failed',
    backupId: typeof row.backupId === 'string' ? row.backupId : '',
    scannedProjects: numbers(row.scannedProjects),
    scannedArtifacts: numbers(row.scannedArtifacts),
    copiedFiles: numbers(row.copiedFiles),
    totalBytes: numbers(row.totalBytes),
    durationMs: numbers(row.durationMs),
    reasons: Object.freeze([...new Set(reasons)]),
  };
}

function parseRecord(value: unknown, operationId: string): DataBackupOperationRecord | null {
  if (value === null || typeof value !== 'object') {
    throw new StorageError('corrupt', OPERATION, '备份操作日志损坏', { entity: { type: 'backup', id: operationId } });
  }
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || row.operationId !== operationId || row.kind !== 'backup'
    || typeof row.commandId !== 'string' || !ID.test(row.commandId)
    || typeof row.backupId !== 'string' || !ID.test(row.backupId)
    || typeof row.target !== 'string' || !ID.test(row.target)
    || (row.status !== 'running' && row.status !== 'completed' && row.status !== 'failed')
    || typeof row.createdAtUtcMs !== 'number' || !Number.isSafeInteger(row.createdAtUtcMs) || row.createdAtUtcMs < 1
    || typeof row.updatedAtUtcMs !== 'number' || !Number.isSafeInteger(row.updatedAtUtcMs) || row.updatedAtUtcMs < 1) {
    throw new StorageError('corrupt', OPERATION, '备份操作日志字段非法', { entity: { type: 'backup', id: operationId } });
  }
  return {
    schemaVersion: 1,
    operationId,
    kind: 'backup',
    commandId: row.commandId,
    backupId: row.backupId,
    target: row.target,
    status: row.status,
    createdAtUtcMs: row.createdAtUtcMs,
    updatedAtUtcMs: row.updatedAtUtcMs,
    ...(typeof row.manifestDigest === 'string' && /^[0-9a-f]{64}$/.test(row.manifestDigest) ? { manifestDigest: row.manifestDigest } : {}),
    ...(typeof row.reason === 'string' && ID.test(row.reason) ? { reason: row.reason } : {}),
    ...(row.report === undefined ? {} : { report: reportSummary(row.report) }),
  };
}

export function createDataBackupOperationJournal(options: {
  readonly backupRoot: string;
}): DataBackupOperationJournal {
  const root = ensureBackupRoot(options.backupRoot);
  const journalRoot = join(root, 'operations');
  if (!existsSync(journalRoot)) mkdirSync(journalRoot, { recursive: true, mode: 0o700 });
  const journalStat = lstatSync(journalRoot);
  if (!journalStat.isDirectory() || journalStat.isSymbolicLink()) {
    throw new StorageError('validation', OPERATION, '备份操作日志目录必须真实存在');
  }
  return Object.freeze({
    save(record: DataBackupOperationRecord): void {
      validId(record.operationId, 'operationId');
      const path = join(journalRoot, `${record.operationId}.json`);
      const temporary = join(journalRoot, `.${record.operationId}.${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    },
    read(operationId: string): DataBackupOperationRecord | null {
      validId(operationId, 'operationId');
      const path = join(journalRoot, `${operationId}.json`);
      if (!existsSync(path)) return null;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new StorageError('corrupt', OPERATION, '备份操作日志不是受控普通文件', { entity: { type: 'backup', id: operationId } });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch (cause) {
        throw new StorageError('corrupt', OPERATION, '备份操作日志 JSON 损坏', { entity: { type: 'backup', id: operationId }, cause });
      }
      return parseRecord(parsed, operationId);
    },
  });
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

export function createBackupPackageFactsReader(options: {
  readonly backupRoot: string;
}): BackupPackageFactsReader {
  const root = ensureBackupRoot(options.backupRoot);
  return Object.freeze({
    read(backupId: string): BackupPackageFacts | null {
      validId(backupId, 'backupId');
      const packagePath = join(root, backupId);
      if (existsSync(packagePath)) {
        const stat = lstatSync(packagePath);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new StorageError('corrupt', OPERATION, '备份包目录不是受控目录', { entity: { type: 'backup', id: backupId } });
        }
        const manifestPath = join(packagePath, 'manifest.json');
        if (!existsSync(manifestPath)) return null;
        const manifestStat = lstatSync(manifestPath);
        if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || !inside(packagePath, manifestPath)) {
          throw new StorageError('corrupt', OPERATION, '备份 manifest 不是受控普通文件', { entity: { type: 'backup', id: backupId } });
        }
        const bytes = readFileSync(manifestPath);
        const manifest = validateBackupManifest(JSON.parse(bytes.toString('utf8')), OPERATION);
        return {
          status: 'complete',
          backupId: manifest.backupId,
          manifestDigest: createHash('sha256').update(bytes).digest('hex'),
          manifest,
        };
      }
      const reportPath = join(root, `${backupId}.incomplete.json`);
      if (!existsSync(reportPath)) return null;
      const reportStat = lstatSync(reportPath);
      if (!reportStat.isFile() || reportStat.isSymbolicLink()) {
        throw new StorageError('corrupt', OPERATION, '备份报告不是受控普通文件', { entity: { type: 'backup', id: backupId } });
      }
      const report = reportSummary(JSON.parse(readFileSync(reportPath, 'utf8')));
      if (report === undefined || report.status === 'complete') {
        throw new StorageError('corrupt', OPERATION, '未完成备份报告损坏', { entity: { type: 'backup', id: backupId } });
      }
      return { status: report.status, backupId, report };
    },
  });
}
