/**
 * P04-5 / F-007 Work 公开记录 wire 校验器（纯函数；无 I/O）。
 *
 * 校验面（.dag_context.json F-007）：
 * - execution.recording.list / execution.recording.body.get 的响应形状：未知
 *   字段、错误 scope、错误 schema 版本、畸形游标、records 超出 limit、行形状
 *   与 recordType 不符均拒绝（response_malformed / unsupported_schema_version）；
 * - 未知字段保持 null 或显式 partial 语义，公开行不携带 locator/内部路径；
 * - 正文 base64 解码后重新核对 size/hash；不符即拒绝，不返回错位正文。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HostProtocolError, validateAppQueryResponse } from '../../../packages/host/src/index.ts';

function expectWireError(body: unknown, code: string): void {
  try {
    validateAppQueryResponse('execution.recording.list', body);
  } catch (error) {
    expect(error).toBeInstanceOf(HostProtocolError);
    expect((error as HostProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`expected wire rejection: ${code}`);
}

const messageRow = {
  id: 'message-1', projectId: 'p-1', runId: 'r-1', attemptId: 'a-1', sessionId: 's-1',
  parentSessionId: null, source: 'recovered', sequence: 1, kind: 'message', role: 'assistant',
  contentRef: { artifactId: 'art-1', contentHash: 'a'.repeat(64), sizeBytes: 3 },
  toolCallId: 'b'.repeat(64), parentToolCallId: null,
  attachments: [{ artifactId: 'art-2', contentHash: 'c'.repeat(64), sizeBytes: 4, truncated: false, redacted: true }],
  occurredAtUtcMs: 100, recordedAtUtcMs: 101, truncated: false, redacted: false,
  watermark: 1, coverage: 'partial', missingReasons: ['sequence_gap'],
};
const manifestRow = {
  id: 'manifest-1', projectId: 'p-1', runId: 'r-1', attemptId: 'a-1', sessionId: 's-1',
  parentSessionId: null, source: 'native', version: 1,
  manifestRef: { artifactId: 'art-m', contentHash: 'd'.repeat(64), sizeBytes: 5 },
  watermark: 2, finalSequence: 2, sequenceReconciliation: 'match', coverage: 'complete',
  missingReasons: [], diagnostics: ['recording_in_progress'],
  scope: { covers: ['public_events'], excludes: ['hidden_reasoning'] },
  truncation: { applied: false, reasons: [] }, redaction: { applied: true, reasons: ['configured_literal_redaction'] },
  unknownEventCount: 0, finalized: true,
};
const messagePage = { schemaVersion: 5, scope: 'work-recording', recordType: 'messages',
  records: [messageRow], nextCursor: null, limit: 50 };
const manifestPage = { schemaVersion: 5, scope: 'work-recording', recordType: 'manifests',
  records: [manifestRow], nextCursor: 'plcur_v1_x', limit: 50 };

describe('F-007 execution.recording.list wire', () => {
  it('[case:wire-recording-list] 消息与 manifest 页面按冻结形状通过并保留原值', () => {
    const messages = validateAppQueryResponse('execution.recording.list', messagePage);
    expect(messages).toMatchObject({ scope: 'work-recording', recordType: 'messages', limit: 50 });
    expect(messages.records[0]).toMatchObject({ sequence: 1, coverage: 'partial', watermark: 1 });
    const manifests = validateAppQueryResponse('execution.recording.list', manifestPage);
    expect(manifests.records[0]).toMatchObject({ version: 1, finalized: true, coverage: 'complete' });
    expect(manifests.nextCursor).toBe('plcur_v1_x');
  });

  it('[case:wire-recording-strict] 未知字段/错误 scope/版本/游标/超限与行形状不符均拒绝', () => {
    expectWireError({ ...messagePage, records: [{ ...messageRow, locator: 'sessions/s-1/1.json' }] }, 'response_malformed');
    expectWireError({ ...messagePage, extra: 1 }, 'response_malformed');
    expectWireError({ ...messagePage, scope: 'work-recording-body' }, 'response_malformed');
    expectWireError({ ...messagePage, schemaVersion: 999 }, 'unsupported_schema_version');
    expectWireError({ ...messagePage, nextCursor: 'not-a-cursor' }, 'response_malformed');
    expectWireError({ ...messagePage, records: [messageRow, { ...messageRow, id: 'message-2' }], limit: 1 }, 'response_malformed');
    // 行形状必须与 recordType 一致：manifest 行混入 messages 页即拒绝。
    expectWireError({ ...messagePage, records: [manifestRow] }, 'response_malformed');
    // 工具身份只接受公开哈希或 null：原始 provider 工具串拒绝。
    expectWireError({ ...messagePage, records: [{ ...messageRow, toolCallId: 'toolu_01ABC' }] }, 'response_malformed');
    expectWireError({ ...messagePage, recordType: 'everything' }, 'response_malformed');
  });
});

describe('F-007 execution.recording.body.get wire', () => {
  const content = Buffer.from('{"public":"body"}', 'utf8');
  const bodyWire = {
    schemaVersion: 5, scope: 'work-recording-body',
    artifact: { artifactId: 'art-1', contentHash: createHash('sha256').update(content).digest('hex'), sizeBytes: content.length },
    content: content.toString('base64'),
  };

  it('[case:wire-recording-body] 解码正文并核对 size/hash 后返回', () => {
    const body = validateAppQueryResponse('execution.recording.body.get', bodyWire);
    expect(body.artifact).toMatchObject({ artifactId: 'art-1', sizeBytes: content.length });
    expect(Buffer.from(body.content).toString('utf8')).toBe('{"public":"body"}');
  });

  it('[case:wire-recording-body-integrity] hash/size 不符、非 base64、未知字段与坏 scope 拒绝', () => {
    expect(() => validateAppQueryResponse('execution.recording.body.get',
      { ...bodyWire, content: Buffer.from('tampered').toString('base64') })).toThrow(HostProtocolError);
    expect(() => validateAppQueryResponse('execution.recording.body.get',
      { ...bodyWire, artifact: { ...bodyWire.artifact, sizeBytes: 2 } })).toThrow(HostProtocolError);
    expect(() => validateAppQueryResponse('execution.recording.body.get',
      { ...bodyWire, content: '!!!!not-base64!!!!' })).toThrow(HostProtocolError);
    expect(() => validateAppQueryResponse('execution.recording.body.get',
      { ...bodyWire, artifact: { ...bodyWire.artifact, locator: 'sessions/s-1/1.json' } })).toThrow(HostProtocolError);
    expect(() => validateAppQueryResponse('execution.recording.body.get',
      { ...bodyWire, scope: 'work-recording' })).toThrow(HostProtocolError);
    try {
      validateAppQueryResponse('execution.recording.body.get', { ...bodyWire, schemaVersion: 999 });
      throw new Error('expected unsupported_schema_version');
    } catch (error) {
      expect((error as HostProtocolError).code).toBe('unsupported_schema_version');
    }
  });
});
