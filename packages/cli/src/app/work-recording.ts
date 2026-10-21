/**
 * P04-5 / F-007 Work 公开记录 CLI 投影（纯面层；无 I/O）。
 *
 * 将 execution.recording.list / execution.recording.body.get 的结构化查询结果
 * 投影为 CLI 结构化/文本输出：
 * - 消息行展示来源（source）、顺序（sequence）、父子关系（toolCallId/
 *   parentToolCallId 的公开哈希前缀）、附件（truncated/redacted）、coverage、
 *   watermark、missingReasons 与分页结果；manifest 行展示版本、水位、最终序列、
 *   覆盖范围与受控诊断码；
 * - 投影只消费结构化查询结果（wire 已脱敏），不被 logger 文本驱动；制品引用
 *   只有稳定身份（artifactId/contentHash/sizeBytes），不出现 locator 或内部路径；
 * - coverage=complete 只描述公开记录投影，不代表 Task/Feature 验收通过；
 *   正文按可解码性输出 utf8 或原样 base64，不伪造文本。
 */
import type { HostClient } from 'shiploop-host';

type WorkRecordingListResult = Awaited<ReturnType<HostClient['listWorkRecordings']>>;
type WorkRecordingBodyResult = Awaited<ReturnType<HostClient['readWorkRecordingBody']>>;

export type WorkRecordingListRecord = WorkRecordingListResult['records'][number];
export type WorkRecordingMessageRow = Extract<WorkRecordingListRecord, { sequence: number }>;
export type WorkRecordingManifestRow = Exclude<WorkRecordingListRecord, { sequence: number }>;
export type WorkRecordingParent = { runId: string } | { attemptId: string } | { sessionId: string };

/** 覆盖度不是验收：note 明确记录完整不折算为 Task/Feature 通过。 */
export const WORK_RECORDING_VIEW_NOTE =
  'coverage/watermark 只描述公开记录投影：coverage=complete 不代表 Task/Feature 验收通过；' +
  'missingReasons/diagnostics 是受控 reason 码（未知内容已脱敏为 recording_detail_redacted）；' +
  '查询只读：不启动 Runtime、不改业务状态、不释放工作区。';

function known(value: number | string | boolean | null): string {
  return value === null ? 'unknown' : String(value);
}

function toolRef(value: string | null): string {
  return value === null ? 'none' : `${value.slice(0, 12)}…`;
}

export interface WorkRecordingListDisplay {
  readonly operation: 'execution.recording.list';
  readonly parent: WorkRecordingParent;
  readonly recordType: 'messages' | 'manifests';
  readonly records: readonly WorkRecordingListRecord[];
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly note: string;
}

export function buildWorkRecordingListView(
  result: WorkRecordingListResult,
  parent: WorkRecordingParent,
): WorkRecordingListDisplay {
  return {
    operation: 'execution.recording.list',
    parent,
    recordType: result.recordType,
    records: result.records,
    nextCursor: result.nextCursor,
    limit: result.limit,
    note: WORK_RECORDING_VIEW_NOTE,
  };
}

function formatMessageRow(row: WorkRecordingMessageRow): string {
  const attachments = row.attachments.length === 0
    ? 'none'
    : `${row.attachments.length}(${row.attachments.some(a => a.truncated) ? 'truncated,' : ''}` +
      `${row.attachments.some(a => a.redacted) ? 'redacted' : 'intact'})`;
  return `  sequence=${row.sequence} kind=${row.kind} role=${row.role} source=${row.source}` +
    ` id=${row.id} session=${row.sessionId}${row.parentSessionId === null ? '' : ` parentSession=${row.parentSessionId}`}` +
    ` tool=${toolRef(row.toolCallId)} parentTool=${toolRef(row.parentToolCallId)}` +
    ` attachments=${attachments} content=${row.contentRef.artifactId}(${row.contentRef.sizeBytes}B)` +
    ` truncated=${row.truncated} redacted=${row.redacted}` +
    ` watermark=${known(row.watermark)} coverage=${row.coverage}` +
    ` missing=${row.missingReasons.length === 0 ? 'none' : row.missingReasons.join(',')}`;
}

function formatManifestRow(row: WorkRecordingManifestRow): string {
  return `  manifest#v${row.version} source=${row.source} id=${row.id} session=${row.sessionId}` +
    `${row.parentSessionId === null ? '' : ` parentSession=${row.parentSessionId}`}` +
    ` manifestRef=${row.manifestRef === null ? 'none' : `${row.manifestRef.artifactId}(${row.manifestRef.sizeBytes}B)`}` +
    ` watermark=${known(row.watermark)} finalSequence=${known(row.finalSequence)}` +
    ` reconciliation=${row.sequenceReconciliation} coverage=${row.coverage} finalized=${row.finalized}` +
    ` unknownEvents=${known(row.unknownEventCount)}` +
    ` missing=${row.missingReasons.length === 0 ? 'none' : row.missingReasons.join(',')}` +
    ` diagnostics=${row.diagnostics.length === 0 ? 'none' : row.diagnostics.join(',')}` +
    ` covers=${row.scope.covers.length === 0 ? 'none' : row.scope.covers.join('|')}` +
    ` excludes=${row.scope.excludes.length === 0 ? 'none' : row.scope.excludes.join('|')}` +
    ` truncation=${row.truncation.applied ? row.truncation.reasons.join('|') : 'none'}` +
    ` redaction=${row.redaction.applied ? row.redaction.reasons.join('|') : 'none'}`;
}

export function formatWorkRecordingListView(view: WorkRecordingListDisplay): string {
  const parentEntry = Object.entries(view.parent)[0]!;
  const lines = [
    `shiploop execution recordings: ${parentEntry[0]}=${parentEntry[1]}` +
      ` recordType=${view.recordType} records=${view.records.length}` +
      ` nextCursor=${view.nextCursor ?? 'none'} limit=${view.limit}`,
  ];
  for (const row of view.records) {
    lines.push('sequence' in row ? formatMessageRow(row) : formatManifestRow(row));
  }
  lines.push(`  （${WORK_RECORDING_VIEW_NOTE}）`, '');
  return lines.join('\n');
}

export interface WorkRecordingBodyDisplay {
  readonly operation: 'execution.recording.body.get';
  readonly artifact: {
    readonly artifactId: string;
    readonly contentHash: string;
    readonly sizeBytes: number;
  };
  /** 正文编码：可严格解码为 UTF-8 时为 utf8，否则原样 base64（不伪造文本）。 */
  readonly contentEncoding: 'utf8' | 'base64';
  readonly content: string;
}

export function buildWorkRecordingBodyView(result: WorkRecordingBodyResult): WorkRecordingBodyDisplay {
  let contentEncoding: 'utf8' | 'base64' = 'utf8';
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(result.content);
  } catch {
    contentEncoding = 'base64';
    content = Buffer.from(result.content).toString('base64');
  }
  return { operation: 'execution.recording.body.get', artifact: result.artifact, contentEncoding, content };
}

export function formatWorkRecordingBodyView(view: WorkRecordingBodyDisplay): string {
  return [
    `shiploop execution recording-body: artifact=${view.artifact.artifactId}` +
      ` sizeBytes=${view.artifact.sizeBytes} contentHash=${view.artifact.contentHash}` +
      ` contentEncoding=${view.contentEncoding}`,
    view.content,
    '',
  ].join('\n');
}
