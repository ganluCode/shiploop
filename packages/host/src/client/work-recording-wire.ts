/**
 * P04-5 / F-007 Work 公开记录 wire 校验器（纯函数；无 I/O）。
 *
 * 与 work-session-wire.ts 同一纪律：
 * - 形状按 Core publicWorkRecordingRow 投影冻结（消息行含 sequence，manifest 行
 *   含 version/finalized）；未知字段、错误 scope、坏游标、records 超出 limit、
 *   行形状与 recordType 不符一律 response_malformed；schema 版本不符 →
 *   unsupported_schema_version；
 * - 公开行只携带稳定身份：contentRef/manifestRef/attachments 为
 *   artifactId+contentHash+sizeBytes，绝不接受 locator 或内部路径；
 *   工具身份只接受公开哈希（64 hex）或 null；
 * - 正文 content 为 base64，解码后重新核对 size/hash（不符即拒绝），
 *   返回 Uint8Array 正文。
 */
import { createHash } from 'node:crypto';
import {
  WIRE_MESSAGE_SCHEMA_VERSION,
  isPublicWorkRecordingDetailCode,
  WORK_RECORDING_COVERAGES,
  WORK_RECORDING_MESSAGE_KINDS,
  WORK_RECORDING_MESSAGE_ROLES,
  WORK_RECORDING_SEQUENCE_RECONCILIATIONS,
  WORK_RECORDING_SOURCES,
} from 'shiploop-core/protocol';
import type { WorkRecordingBody, WorkRecordingPage } from 'shiploop-core/protocol';
import { HostProtocolError, isPlainObject, MAX_WORK_SESSION_EVIDENCE_RESPONSE_BYTES, type HostOperation } from '../contract/index.js';

type Check = (value: unknown) => boolean;
const text: Check = isPublicWorkRecordingDetailCode;
const id: Check = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const natural: Check = v => typeof v === 'number' && Number.isSafeInteger(v) && Number(v) >= 0;
const positive: Check = v => natural(v) && Number(v) > 0;
const bool: Check = v => typeof v === 'boolean';
const hash: Check = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const nullable = (check: Check): Check => v => v === null || check(v);
const oneOf = (values: readonly unknown[]): Check => v => values.includes(v);
const array = (check: Check, max = 200): Check => v => Array.isArray(v) && v.length <= max && v.every(check);
const object = (shape: Record<string, Check>): Check => v => isPlainObject(v) &&
  Object.keys(v).length === Object.keys(shape).length && Object.entries(shape).every(([key, check]) => Object.hasOwn(v, key) && check(v[key]));

const ref = object({ artifactId: id, contentHash: hash, sizeBytes: natural });
const attachment = object({ artifactId: id, contentHash: hash, sizeBytes: natural, truncated: bool, redacted: bool });
const source = oneOf(WORK_RECORDING_SOURCES);
const coverage = oneOf(WORK_RECORDING_COVERAGES);
const messageRow = object({
  id, projectId: id, runId: id, attemptId: id, sessionId: id, parentSessionId: nullable(id), source,
  sequence: positive, kind: oneOf(WORK_RECORDING_MESSAGE_KINDS), role: oneOf(WORK_RECORDING_MESSAGE_ROLES),
  contentRef: ref, toolCallId: nullable(hash), parentToolCallId: nullable(hash), attachments: array(attachment, 32),
  occurredAtUtcMs: natural, recordedAtUtcMs: natural, truncated: bool, redacted: bool,
  watermark: nullable(natural), coverage, missingReasons: array(text, 32),
});
const manifestRow = object({
  id, projectId: id, runId: id, attemptId: id, sessionId: id, parentSessionId: nullable(id), source,
  version: positive, manifestRef: nullable(ref), watermark: nullable(natural), finalSequence: nullable(natural),
  sequenceReconciliation: oneOf(WORK_RECORDING_SEQUENCE_RECONCILIATIONS), coverage,
  missingReasons: array(text, 32), diagnostics: array(text, 32),
  scope: object({ covers: array(text, 16), excludes: array(text, 16) }),
  truncation: object({ applied: bool, reasons: array(text, 32) }),
  redaction: object({ applied: bool, reasons: array(text, 32) }),
  unknownEventCount: nullable(natural), finalized: bool,
});

function malformed(operation: HostOperation): never {
  throw new HostProtocolError('response_malformed', operation, 'Work 公开记录响应不符合线协议', { details: { reason: 'work_recording_malformed' } });
}
function validate(operation: HostOperation, value: unknown, check: Check): void {
  if (isPlainObject(value) && value.schemaVersion !== WIRE_MESSAGE_SCHEMA_VERSION) {
    throw new HostProtocolError('unsupported_schema_version', operation, '不支持的查询响应版本');
  }
  if (!check(value)) malformed(operation);
}

export function validateWorkRecordingListWire(value: unknown): WorkRecordingPage {
  const operation = 'execution.recording.list';
  validate(operation, value, object({ schemaVersion: v => v === WIRE_MESSAGE_SCHEMA_VERSION,
    scope: v => v === 'work-recording', recordType: oneOf(['messages', 'manifests']),
    // 行形状在下方按 recordType 复核（两种行形状互斥）。
    records: array(() => true), nextCursor: nullable(v => typeof v === 'string' && /^plcur_v1_/.test(v)),
    limit: v => positive(v) && Number(v) <= 200 }));
  const result = value as WorkRecordingPage;
  const rowCheck = result.recordType === 'messages' ? messageRow : manifestRow;
  if (result.records.length > result.limit || !result.records.every(row => rowCheck(row))) malformed(operation);
  return result;
}

export function validateWorkRecordingBodyWire(value: unknown): WorkRecordingBody {
  const operation = 'execution.recording.body.get';
  validate(operation, value, object({ schemaVersion: v => v === WIRE_MESSAGE_SCHEMA_VERSION,
    scope: v => v === 'work-recording-body', artifact: ref,
    content: v => typeof v === 'string' && v.length <= MAX_WORK_SESSION_EVIDENCE_RESPONSE_BYTES
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v) }));
  const wire = value as Omit<WorkRecordingBody, 'content'> & { content: string };
  const content = Buffer.from(wire.content, 'base64');
  if (content.length !== wire.artifact.sizeBytes
    || createHash('sha256').update(content).digest('hex') !== wire.artifact.contentHash) malformed(operation);
  return { ...wire, content };
}
