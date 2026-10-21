/**
 * P04-5 / F-007 Work 公开记录 CLI 纯面层（参数映射、结构化/文本视图、帮助）。
 *
 * 定位：只测纯函数层（`parseAppCliArgs` / `app/work-recording.ts` 视图投影 /
 * `getAppCliHelp`），不接触真实 Host、SQLite、文件或网络：
 * - execution recordings / recording-body 按实际 Host 公共契约
 *   （execution.recording.list / execution.recording.body.get）映射参数；
 *   父级 Run/Attempt/Session 三选一，缺失/同现均本地拒绝；recordType 只接受
 *   messages|manifests；非法 ID/分页在任何 I/O 之前以稳定 reason 拒绝；
 * - 结构化/文本输出展示消息/工具/错误/最终结果的来源（source）、顺序
 *   （sequence）、父子关系（toolCallId/parentToolCallId，公开哈希）、coverage、
 *   watermark、missingReasons 与分页结果；投影只消费结构化查询结果，
 *   不被 logger 文本驱动；
 * - coverage=complete 只描述公开记录投影，不显示为 Task/Feature 验收通过；
 *   制品引用只有稳定身份（artifactId/hash/size），不出现 locator 或内部路径。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AppCliParseError,
  buildWorkRecordingBodyView,
  buildWorkRecordingListView,
  formatWorkRecordingBodyView,
  formatWorkRecordingListView,
  getAppCliHelp,
  parseAppCliArgs,
} from '../../../packages/cli/src/index.ts';
import type { HostClient } from '../../../packages/host/src/index.ts';

type WorkRecordingListResult = Awaited<ReturnType<HostClient['listWorkRecordings']>>;
type WorkRecordingBodyResult = Awaited<ReturnType<HostClient['readWorkRecordingBody']>>;
type WorkRecordingMessageRow = Extract<WorkRecordingListResult['records'][number], { sequence: number }>;
type WorkRecordingManifestRow = Exclude<WorkRecordingListResult['records'][number], { sequence: number }>;

const PROJECT_ID = randomUUID();
const RUN_ID = randomUUID();
const ATTEMPT_ID = randomUUID();
const SESSION_ID = 'recording-session';

function expectParseError(args: readonly string[], reason: string, field?: string): AppCliParseError {
  try {
    parseAppCliArgs(args, {});
  } catch (error) {
    expect(error, `expected AppCliParseError for ${JSON.stringify(args)}`).toBeInstanceOf(AppCliParseError);
    const parseError = error as AppCliParseError;
    expect(parseError.reason).toBe(reason);
    if (field !== undefined) {
      expect(parseError.field).toBe(field);
    }
    return parseError;
  }
  throw new Error(`expected parse failure for ${JSON.stringify(args)}`);
}

const messageRow: WorkRecordingMessageRow = {
  id: 'message-1',
  projectId: PROJECT_ID,
  runId: RUN_ID,
  attemptId: ATTEMPT_ID,
  sessionId: SESSION_ID,
  parentSessionId: null,
  source: 'recovered',
  sequence: 3,
  kind: 'tool_finished',
  role: 'tool',
  contentRef: { artifactId: 'artifact-body', contentHash: 'a'.repeat(64), sizeBytes: 12 },
  toolCallId: 'b'.repeat(64),
  parentToolCallId: 'c'.repeat(64),
  attachments: [
    { artifactId: 'artifact-att', contentHash: 'd'.repeat(64), sizeBytes: 4, truncated: true, redacted: false },
  ],
  occurredAtUtcMs: 100,
  recordedAtUtcMs: 101,
  truncated: false,
  redacted: true,
  watermark: 3,
  coverage: 'partial',
  missingReasons: ['sequence_gap', 'recording_detail_redacted'],
};

const manifestRow: WorkRecordingManifestRow = {
  id: 'manifest-1',
  projectId: PROJECT_ID,
  runId: RUN_ID,
  attemptId: ATTEMPT_ID,
  sessionId: SESSION_ID,
  parentSessionId: null,
  source: 'mixed',
  version: 2,
  manifestRef: { artifactId: 'artifact-m', contentHash: 'e'.repeat(64), sizeBytes: 9 },
  watermark: 7,
  finalSequence: 7,
  sequenceReconciliation: 'match',
  coverage: 'partial',
  missingReasons: ['missing_sequences:8'],
  diagnostics: ['recording_detail_redacted'],
  scope: { covers: ['public_events', 'public_tools'], excludes: ['hidden_reasoning'] },
  truncation: { applied: true, reasons: ['body_truncated'] },
  redaction: { applied: false, reasons: [] },
  unknownEventCount: 1,
  finalized: false,
};

function listResult(recordType: 'messages' | 'manifests'): WorkRecordingListResult {
  return {
    schemaVersion: 5,
    scope: 'work-recording',
    recordType,
    records: recordType === 'messages' ? [messageRow] : [manifestRow],
    nextCursor: 'plcur_v1_next',
    limit: 50,
  } as WorkRecordingListResult;
}

describe('F-007 recordings/recording-body 参数映射', () => {
  it('[case:recording-list-parse] 三种父级与分页参数按实际 Host 契约映射', () => {
    const bySession = parseAppCliArgs(
      ['execution', 'recordings', '--project', PROJECT_ID, '--session', SESSION_ID,
        '--record-type', 'messages', '--limit', '5', '--cursor', 'plcur_v1_x', '--json'],
      {},
    );
    expect(bySession).toMatchObject({
      commandId: 'execution.recordings',
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      recordType: 'messages',
      limit: 5,
      cursor: 'plcur_v1_x',
      json: true,
    });
    expect(parseAppCliArgs(
      ['execution', 'recordings', '--project', PROJECT_ID, '--run', RUN_ID, '--record-type', 'manifests'],
      {},
    )).toMatchObject({ commandId: 'execution.recordings', runId: RUN_ID, recordType: 'manifests' });
    expect(parseAppCliArgs(
      ['execution', 'recordings', '--project', PROJECT_ID, '--attempt', ATTEMPT_ID, '--record-type', 'messages'],
      {},
    )).toMatchObject({ commandId: 'execution.recordings', attemptId: ATTEMPT_ID, recordType: 'messages' });
  });

  it('[case:recording-list-parent-xor] 父级缺失/多选与非法值在任何 I/O 之前拒绝', () => {
    expectParseError(
      ['execution', 'recordings', '--project', PROJECT_ID, '--record-type', 'messages'],
      'missing_required_option', 'parent',
    );
    expectParseError(
      ['execution', 'recordings', '--project', PROJECT_ID, '--session', SESSION_ID, '--run', RUN_ID, '--record-type', 'messages'],
      'conflicting_options',
    );
    expectParseError(
      ['execution', 'recordings', '--project', PROJECT_ID, '--attempt', ATTEMPT_ID, '--session', SESSION_ID, '--record-type', 'messages'],
      'conflicting_options',
    );
    expectParseError(
      ['execution', 'recordings', '--project', PROJECT_ID, '--session', SESSION_ID],
      'missing_required_option', 'recordType',
    );
    expectParseError(
      ['execution', 'recordings', '--project', PROJECT_ID, '--session', SESSION_ID, '--record-type', 'everything'],
      'invalid_record_type', 'recordType',
    );
    expectParseError(
      ['execution', 'recordings', '--project', PROJECT_ID, '--session', '../etc/passwd', '--record-type', 'messages'],
      'invalid_session_id', 'sessionId',
    );
  });

  it('[case:recording-body-parse] 正文命令映射 --artifact 与父级三选一', () => {
    const parsed = parseAppCliArgs(
      ['execution', 'recording-body', '--project', PROJECT_ID, '--attempt', ATTEMPT_ID, '--artifact', 'artifact-body', '--json'],
      {},
    );
    expect(parsed).toMatchObject({
      commandId: 'execution.recording-body',
      projectId: PROJECT_ID,
      attemptId: ATTEMPT_ID,
      artifactId: 'artifact-body',
      json: true,
    });
    expectParseError(
      ['execution', 'recording-body', '--project', PROJECT_ID, '--session', SESSION_ID],
      'missing_required_option', 'artifactId',
    );
    expectParseError(
      ['execution', 'recording-body', '--project', PROJECT_ID, '--session', SESSION_ID, '--run', RUN_ID, '--artifact', 'a-1'],
      'conflicting_options',
    );
  });

  it('[case:recording-help] 帮助包含两个新命令的用法', () => {
    const overview = getAppCliHelp('execution');
    expect(overview).toContain('execution recordings --project <id> (--run <runId> | --attempt <attemptId> | --session <sessionId>)');
    expect(overview).toContain('execution recording-body --project <id> (--run <runId> | --attempt <attemptId> | --session <sessionId>) --artifact <id>');
    expect(getAppCliHelp('execution.recordings')).toContain('usage: shiploop execution recordings --project <id>');
    expect(getAppCliHelp('execution.recordings')).toContain('不代表 Task/Feature 验收通过');
    expect(getAppCliHelp('execution.recording-body')).toContain('usage: shiploop execution recording-body --project <id>');
    expect(getAppCliHelp('execution.recording-body')).toContain('不泄漏存在性');
  });
});

describe('F-007 Work 公开记录视图投影', () => {
  it('[case:recording-message-view] 消息行展示来源/顺序/父子关系/覆盖缺口/水位与分页', () => {
    const view = buildWorkRecordingListView(listResult('messages'), { sessionId: SESSION_ID });
    expect(view).toMatchObject({
      operation: 'execution.recording.list',
      parent: { sessionId: SESSION_ID },
      recordType: 'messages',
      nextCursor: 'plcur_v1_next',
      limit: 50,
    });
    expect(view.records[0]).toBe(messageRow);
    const text = formatWorkRecordingListView(view);
    expect(text).toContain('execution recordings');
    expect(text).toContain(`session=${SESSION_ID}`);
    expect(text).toContain('sequence=3');
    expect(text).toContain('kind=tool_finished');
    expect(text).toContain('role=tool');
    expect(text).toContain('source=recovered');
    expect(text).toContain('tool=bbbbbbbbbbbb');
    expect(text).toContain('parentTool=cccccccccccc');
    expect(text).toContain('attachments=1(truncated,intact)');
    expect(text).toContain('watermark=3');
    expect(text).toContain('coverage=partial');
    expect(text).toContain('missing=sequence_gap,recording_detail_redacted');
    expect(text).toContain('redacted=true');
    expect(text).toContain('nextCursor=plcur_v1_next');
    // 结构化视图只有稳定身份：不出现 locator/内部路径字段。
    expect(JSON.stringify(view)).not.toContain('locator');
    // 覆盖度不是验收：note 明确记录完整不代表 Task/Feature 通过。
    expect(text).toContain('不代表 Task/Feature 验收通过');
  });

  it('[case:recording-manifest-view] manifest 行展示版本/水位/最终序列/范围与诊断', () => {
    const view = buildWorkRecordingListView(listResult('manifests'), { sessionId: SESSION_ID });
    expect(view.recordType).toBe('manifests');
    const text = formatWorkRecordingListView(view);
    expect(text).toContain('manifest#v2');
    expect(text).toContain('source=mixed');
    expect(text).toContain('watermark=7');
    expect(text).toContain('finalSequence=7');
    expect(text).toContain('reconciliation=match');
    expect(text).toContain('coverage=partial');
    expect(text).toContain('finalized=false');
    expect(text).toContain('diagnostics=recording_detail_redacted');
    expect(text).toContain('covers=public_events|public_tools');
    expect(text).toContain('excludes=hidden_reasoning');
    expect(text).toContain('missing=missing_sequences:8');
  });

  it('[case:recording-body-view] 正文按可解码性输出 utf8 或 base64，不伪造文本', () => {
    const utf8 = buildWorkRecordingBodyView({
      schemaVersion: 5,
      scope: 'work-recording-body',
      artifact: { artifactId: 'artifact-body', contentHash: 'a'.repeat(64), sizeBytes: 12 },
      content: new TextEncoder().encode('{"public":"body"}'),
    } as WorkRecordingBodyResult);
    expect(utf8).toMatchObject({
      operation: 'execution.recording.body.get',
      contentEncoding: 'utf8',
      content: '{"public":"body"}',
    });
    expect(formatWorkRecordingBodyView(utf8)).toContain('contentEncoding=utf8');
    expect(formatWorkRecordingBodyView(utf8)).toContain('artifact=artifact-body');

    const binary = buildWorkRecordingBodyView({
      schemaVersion: 5,
      scope: 'work-recording-body',
      artifact: { artifactId: 'artifact-bin', contentHash: 'a'.repeat(64), sizeBytes: 4 },
      content: new Uint8Array([0xff, 0xfe, 0x00, 0x81]),
    } as WorkRecordingBodyResult);
    expect(binary.contentEncoding).toBe('base64');
    expect(binary.content).toBe(Buffer.from([0xff, 0xfe, 0x00, 0x81]).toString('base64'));
    expect(formatWorkRecordingBodyView(binary)).toContain('contentEncoding=base64');
  });
});
