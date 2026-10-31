/**
 * P07-3 / F-015 项目生命周期查询 wire 校验器（client/ 纯函数模块；无 I/O）。
 *
 * 与 data-backup-wire.ts 同一纪律：
 * - 形状按 Core 投影冻结（project.delete.operation.get / retention.evaluation.get）；
 *   未知字段、错误 operation 身份、非法状态一律 response_malformed；
 * - 结果只携带稳定身份与受控摘要（无绝对路径、无凭据）；
 * - 保留评估的全部观测量区分实际观测/未知，客户端不折算未知为完整结论。
 */
import type {
  ProjectDeleteOperationQueryResult,
  RetentionEvaluationReport,
} from './app-client.js';
import { HostProtocolError, isPlainObject, type HostOperation } from '../contract/index.js';

type Check = (value: unknown) => boolean;
const stableId: Check = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const uuid: Check = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const natural: Check = v => typeof v === 'number' && Number.isSafeInteger(v) && Number(v) >= 0;
const positive: Check = v => natural(v) && Number(v) > 0;
const text: Check = v => typeof v === 'string' && v.length > 0 && v.length <= 256;
const oneOf = (values: readonly unknown[]): Check => v => values.includes(v);
const array = (check: Check, max = 256): Check => v => Array.isArray(v) && v.length <= max && v.every(item => check(item));
const object = (shape: Record<string, Check>): Check => v => isPlainObject(v) &&
  Object.keys(v).length === Object.keys(shape).length && Object.entries(shape).every(([key, check]) => Object.hasOwn(v, key) && check(v[key]));
/** 必填键全部出现且通过检查；可选键（检查接受 undefined）出现即必须通过。 */
const objectWithOptional = (shape: Record<string, Check>): Check => v => isPlainObject(v) &&
  Object.keys(v).every(key => Object.hasOwn(shape, key)) &&
  Object.entries(shape).every(([key, check]) => !Object.hasOwn(v, key) || check(v[key])) &&
  Object.entries(shape).every(([key, check]) => Object.hasOwn(v, key) || check(undefined));

const deleteStepView = object({
  step: oneOf(['artifact_bodies', 'artifact_staging', 'managed_worktrees']),
  status: oneOf(['pending', 'completed', 'failed']),
});

const deleteOperationResult = objectWithOptional({
  operation: oneOf(['project.delete.operation.get']),
  schemaVersion: oneOf([1]),
  operationId: uuid,
  projectId: stableId,
  status: oneOf(['intent', 'running', 'failed', 'purging', 'completed']),
  failedStep: v => v === undefined || v === null || oneOf(['artifact_bodies', 'artifact_staging', 'managed_worktrees', 'external_verification', 'database'])(v),
  steps: array(deleteStepView, 8),
  fence: natural,
});

const triggerAssessment = objectWithOptional({
  kind: oneOf(['disk_min_free_bytes', 'disk_min_free_percent']),
  configuredValue: positive,
  observedValue: v => v === undefined || (typeof v === 'number' && Number.isFinite(v) && Number(v) >= 0),
  assessment: oneOf(['triggered', 'not_triggered', 'unknown']),
});

const cleanableComponent = objectWithOptional({
  kind: oneOf(['backup_rotation', 'evidence_retention']),
  status: oneOf(['not_configured', 'assessed', 'unknown']),
  reason: v => v === undefined || text(v),
  bytes: v => v === undefined || natural(v),
  items: v => v === undefined || natural(v),
});

const retainedComponent = objectWithOptional({
  kind: oneOf(['backup_retained', 'evidence_references']),
  status: oneOf(['not_configured', 'assessed', 'unknown']),
  reason: v => v === undefined || text(v),
  bytes: v => v === undefined || natural(v),
  items: v => v === undefined || natural(v),
});

const diskObservation = objectWithOptional({
  status: oneOf(['observed', 'unknown']),
  reason: v => v === undefined || text(v),
  availableBytes: v => v === undefined || natural(v),
  totalBytes: v => v === undefined || natural(v),
});

const areaUsage = objectWithOptional({
  area: oneOf(['projects', 'staging', 'backups', 'database']),
  status: oneOf(['observed', 'partial', 'unknown']),
  reason: v => v === undefined || text(v),
  bytes: v => v === undefined || natural(v),
  files: v => v === undefined || natural(v),
});

const retentionPolicy = objectWithOptional({
  evidenceRetentionDays: v => v === undefined || (typeof v === 'number' && Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 36_500),
  backupRetentionDays: v => v === undefined || (typeof v === 'number' && Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 36_500),
  maxBackupCount: v => v === undefined || (typeof v === 'number' && Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 1_000),
  diskMinFreeBytes: v => v === undefined || (typeof v === 'number' && Number.isInteger(v) && Number(v) >= 1_048_576 && Number(v) <= 1_099_511_627_776),
  diskMinFreePercent: v => v === undefined || (typeof v === 'number' && Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 99),
});

const policySection = objectWithOptional({
  status: oneOf(['configured', 'not_configured']),
  retention: v => v === undefined || retentionPolicy(v),
  source: v => v === undefined || object({
    kind: oneOf(['global_default']),
    scopeRevision: positive,
    sourceKey: oneOf(['policies.retentionPolicy']),
  })(v),
});

const evaluationReport = objectWithOptional({
  operation: oneOf(['retention.evaluation.get']),
  schemaVersion: oneOf([1]),
  evaluatedAtUtcMs: positive,
  policy: policySection,
  disk: diskObservation,
  thresholds: objectWithOptional({
    status: oneOf(['not_configured', 'evaluated', 'unknown']),
    reason: v => v === undefined || text(v),
    triggers: array(triggerAssessment, 16),
  }),
  cleanable: objectWithOptional({
    status: oneOf(['not_configured', 'assessed', 'partial', 'unknown']),
    bytes: v => v === undefined || natural(v),
    components: array(cleanableComponent, 16),
  }),
  referencedRetained: objectWithOptional({
    status: oneOf(['not_configured', 'assessed', 'unknown']),
    reason: v => v === undefined || text(v),
    bytes: v => v === undefined || natural(v),
    components: array(retainedComponent, 16),
  }),
  managedUsage: object({
    areas: array(areaUsage, 8),
    entriesExamined: natural,
    budgetExhausted: v => typeof v === 'boolean',
  }),
});

function malformed(operation: HostOperation, reason: string): never {
  throw new HostProtocolError('response_malformed', operation, '项目生命周期查询响应畸形', { details: { reason } });
}

export function validateProjectDeleteOperationQueryResultWire(
  value: unknown,
  operation: 'project.delete.operation.get',
): ProjectDeleteOperationQueryResult {
  if (!isPlainObject(value)) malformed(operation, 'delete_operation_query_not_object');
  if (value.operation !== operation) malformed(operation, 'delete_operation_query_operation_mismatch');
  if (!deleteOperationResult(value)) malformed(operation, 'delete_operation_result_malformed');
  return value as unknown as ProjectDeleteOperationQueryResult;
}

export function validateRetentionEvaluationReportWire(
  value: unknown,
  operation: 'retention.evaluation.get',
): RetentionEvaluationReport {
  if (!isPlainObject(value)) malformed(operation, 'retention_evaluation_not_object');
  if (value.operation !== operation) malformed(operation, 'retention_evaluation_operation_mismatch');
  if (!evaluationReport(value)) malformed(operation, 'retention_evaluation_report_malformed');
  return value as unknown as RetentionEvaluationReport;
}
