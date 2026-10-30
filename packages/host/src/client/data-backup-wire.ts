/**
 * P07-3 / F-014 备份查询 wire 校验器（client/ 纯函数模块；无 I/O）。
 *
 * 与 work-recording-wire.ts 同一纪律：
 * - 形状按 Core DataBackupQueryService 投影冻结（backups.get / backup.operations.get）；
 *   未知字段、错误 operation 身份、非法状态/摘要一律 response_malformed；
 * - 结果只携带稳定身份与受控摘要（无绝对路径、无凭据、无 Host 认证材料）；
 *   manifestDigest 仅接受 64 位小写十六进制 SHA-256。
 */
import type {
  DataBackupOperationQueryResult,
  DataBackupQueryResult,
} from './app-client.js';
import { HostProtocolError, isPlainObject, type HostOperation } from '../contract/index.js';

type Check = (value: unknown) => boolean;
const id: Check = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const natural: Check = v => typeof v === 'number' && Number.isSafeInteger(v) && Number(v) >= 0;
const positive: Check = v => natural(v) && Number(v) > 0;
const hash: Check = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const text: Check = v => typeof v === 'string' && v.length > 0 && v.length <= 256;
const isoUtc: Check = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(v);
const oneOf = (values: readonly unknown[]): Check => v => values.includes(v);
const array = (check: Check, max = 256): Check => v => Array.isArray(v) && v.length <= max && v.every(check);
const object = (shape: Record<string, Check>): Check => v => isPlainObject(v) &&
  Object.keys(v).length === Object.keys(shape).length && Object.entries(shape).every(([key, check]) => Object.hasOwn(v, key) && check(v[key]));
/** 必填键全部出现且通过检查；可选键（检查接受 undefined）出现即必须通过。 */
const objectWithOptional = (shape: Record<string, Check>): Check => v => isPlainObject(v) &&
  Object.keys(v).every(key => Object.hasOwn(shape, key)) &&
  Object.entries(shape).every(([key, check]) => !Object.hasOwn(v, key) || check(v[key])) &&
  Object.entries(shape).every(([key, check]) => Object.hasOwn(v, key) || check(undefined));

const reportSummary = object({
  status: oneOf(['complete', 'incomplete', 'failed']),
  backupId: id,
  scannedProjects: natural,
  scannedArtifacts: natural,
  copiedFiles: natural,
  totalBytes: natural,
  durationMs: natural,
  reasons: array(text, 128),
});

const manifestSummary = object({
  schemaVersion: positive,
  packageVersion: positive,
  backupId: id,
  createdAtUtc: isoUtc,
  database: object({ schemaVersion: natural, contentDigest: hash }),
  projectCount: natural,
  fileCount: natural,
  nativeRecordCount: natural,
  externalDependencyCount: natural,
});

const backupFactsComplete = objectWithOptional({
  operation: oneOf(['backups.get']),
  backupId: id,
  status: oneOf(['complete']),
  manifestDigest: hash,
  manifestSummary,
});

const backupFactsIncomplete = objectWithOptional({
  operation: oneOf(['backups.get']),
  backupId: id,
  status: oneOf(['incomplete', 'failed']),
  report: reportSummary,
});

const operationRecord = objectWithOptional({
  operation: oneOf(['backup.operations.get']),
  operationId: id,
  kind: oneOf(['backup']),
  commandId: id,
  backupId: id,
  target: id,
  status: oneOf(['running', 'completed', 'failed']),
  createdAtUtcMs: positive,
  updatedAtUtcMs: positive,
  manifestDigest: v => v === undefined || hash(v),
  reason: v => v === undefined || id(v),
  report: v => v === undefined || reportSummary(v),
});

function malformed(operation: HostOperation, reason: string): never {
  throw new HostProtocolError('response_malformed', operation, '备份查询响应畸形', { details: { reason } });
}

export function validateDataBackupQueryResultWire(
  value: unknown,
  operation: 'backups.get' | 'backup.operations.get',
): DataBackupQueryResult | DataBackupOperationQueryResult {
  if (!isPlainObject(value)) malformed(operation, 'backup_query_not_object');
  if (value.operation !== operation) malformed(operation, 'backup_query_operation_mismatch');
  if (operation === 'backups.get') {
    const status = value.status;
    if (status === 'complete') {
      if (!backupFactsComplete(value)) malformed(operation, 'backup_facts_malformed');
    } else if (status === 'incomplete' || status === 'failed') {
      if (!backupFactsIncomplete(value)) malformed(operation, 'backup_facts_malformed');
    } else {
      malformed(operation, 'backup_status_invalid');
    }
    return value as unknown as DataBackupQueryResult;
  }
  if (!operationRecord(value)) malformed(operation, 'backup_operation_malformed');
  return value as unknown as DataBackupOperationQueryResult;
}
