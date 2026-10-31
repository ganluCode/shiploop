/**
 * P07-4 / F-003 结果诊断 CLI 纯面层（参数映射、文本视图、帮助与过期展示修正）。
 *
 * 定位：只测纯函数层（`parseAppCliArgs` / `app/result-diagnostics.ts` 视图投影 /
 * `getAppCliHelp` / 取消视图），不接触真实 Host、SQLite、文件或网络：
 * - execution result-diagnostics 按实际 Host 公共契约
 *   （execution.result.diagnostics.list）映射参数；父级 Batch/Run/Attempt/
 *   Session 四选一（--batch/--run/--attempt/--session），缺失/同现均本地拒绝；
 *   非法 ID/分页在任何 I/O 之前以稳定 reason 拒绝；
 * - 文本清楚展示停止/阻塞原因（blockReasons）与需授权用户处理的动作
 *   （pendingActions）；三轴（runtime/task/feature）互不折算，未知指标显示
 *   unknown 不填零；引用只展示稳定身份；
 * - 修正被 F-001/F-002 能力替代的过期展示：不再固定宣称“未装配 Verifier /
 *   尚无完整 Run 恢复”；取消受理、停止确认和验收结果仍按持久事实分别表达。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AppCliParseError,
  RESULT_DIAGNOSTICS_VIEW_NOTE,
  buildAttemptCancelView,
  buildResultDiagnosticsView,
  formatAttemptCancelView,
  formatResultDiagnosticsView,
  getAppCliHelp,
  parseAppCliArgs,
} from '../../../packages/cli/src/index.ts';
import type { HostClient } from '../../../packages/host/src/index.ts';
import { WIRE_MESSAGE_SCHEMA_VERSION } from 'shiploop-core/protocol';

type ResultDiagnosticsListResult = Awaited<ReturnType<HostClient['listResultDiagnostics']>>;
type ResultDiagnosticsRecord = ResultDiagnosticsListResult['records'][number];

const PROJECT_ID = randomUUID();
const BATCH_ID = randomUUID();
const RUN_ID = randomUUID();
const ATTEMPT_ID = randomUUID();
const SESSION_ID = 'diagnostics-session';

function expectParseError(args: readonly string[], reason: string, field?: string): AppCliParseError {
  try {
    parseAppCliArgs(args, {});
  } catch (error) {
    expect(error, `expected AppCliParseError for ${JSON.stringify(args)}`).toBeInstanceOf(AppCliParseError);
    const parseError = error as AppCliParseError;
    expect(parseError.reason).toBe(reason);
    if (field !== undefined) expect(parseError.field).toBe(field);
    return parseError;
  }
  throw new Error(`expected parse failure for ${JSON.stringify(args)}`);
}

const record: ResultDiagnosticsRecord = {
  attemptId: ATTEMPT_ID,
  number: 3,
  taskId: 't-1',
  featureId: 'f-1',
  runId: RUN_ID,
  batchId: BATCH_ID,
  executionStage: 'runtime',
  rework: { previousAttemptId: 'a-prev' },
  recovery: { sourceAttemptId: null, selection: 'new' },
  runtime: {
    attemptStatus: 'failed',
    state: 'failed',
    sessionStatus: 'ended',
    resultKnown: true,
    exitCode: 17,
    startedAt: '2026-10-20T12:00:00.000Z',
    endedAt: '2026-10-20T12:01:40.000Z',
    durationMs: 100_000,
  },
  task: {
    taskStatus: 'running',
    manualBlockPending: true,
    verification: {
      batchId: 'verify-1',
      operation: 'FeatureVerification.full',
      status: 'failed',
      endedAt: '2026-10-20T12:02:00.000Z',
      checks: [{ checkKey: 'tests', status: 'failed', outputArtifactId: null }],
    },
  },
  feature: { featureStatus: 'running', deliveryStatus: 'not_requested' },
  blockReasons: ['manual_block_pending', 'run:user_cancel', 'stop:uncertain'],
  pendingActions: ['review_manual_block', 'confirm_stop_uncertainty', 'rework_task'],
  codeRef: 'code-1',
  diagnosticRef: null,
  resultArtifactId: 'result-1',
  resultEvidenceRef: 'evidence-1',
  checkRefs: [{ batchId: 'verify-1', operation: 'FeatureVerification.full', status: 'failed', endedAt: '2026-10-20T12:02:00.000Z' }],
  gitOperationRefs: [{ operationId: 'op-1', operationType: 'feature_final_commit', status: 'pending' }],
  recording: { complete: false, manifestRef: null, failure: null, gaps: ['historical_tail_missing'], watermark: 3 },
  recorder: {
    sessions: [{
      sessionId: SESSION_ID,
      version: 1,
      source: 'mixed',
      coverage: 'partial',
      watermark: 3,
      finalSequence: null,
      sequenceReconciliation: 'not_available',
      finalized: false,
      unknownEventCount: null,
      manifestRef: null,
      missingReasons: ['sequence_gap'],
      truncation: { applied: false, reasons: [] },
      redaction: { applied: false, reasons: [] },
    }],
    truncated: false,
  },
  usage: {
    basis: 'reported',
    coverage: 'partial',
    inputTokens: 30,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costMicros: null,
    currency: null,
  },
  issues: ['usage_partial', 'cache_unknown', 'recording_partial'],
};

const page: ResultDiagnosticsListResult = {
  schemaVersion: WIRE_MESSAGE_SCHEMA_VERSION,
  scope: 'result-diagnostics',
  parent: { kind: 'run', runId: RUN_ID },
  parentFacts: { kind: 'run', runId: RUN_ID, batchId: BATCH_ID, runStatus: 'failed', runReason: 'user_cancel' } as ResultDiagnosticsListResult['parentFacts'],
  records: [record],
  nextCursor: 'plcur_v1_test',
  limit: 50,
  eventWatermark: 7,
  usage: {
    basis: 'reported',
    coverage: 'partial',
    accounting: 'incremental',
    countedObservations: 1,
    inputTokens: 30,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costMicros: null,
    diagnostics: ['cache_semantics_unknown'],
  },
};

describe('F-003 结果诊断参数映射', () => {
  it('[case:cli-args-parents] 父级 Batch/Run/Attempt/Session 四选一映射到公共契约参数', () => {
    expect(parseAppCliArgs(['execution', 'result-diagnostics', '--project', PROJECT_ID, '--run', RUN_ID], {}))
      .toMatchObject({ commandId: 'execution.result-diagnostics', projectId: PROJECT_ID, runId: RUN_ID, json: false });
    expect(parseAppCliArgs(['execution', 'result-diagnostics', '--project', PROJECT_ID, '--batch', BATCH_ID, '--json'], {}))
      .toMatchObject({ commandId: 'execution.result-diagnostics', batchId: BATCH_ID, json: true });
    expect(parseAppCliArgs(['execution', 'result-diagnostics', '--project', PROJECT_ID, '--attempt', ATTEMPT_ID], {}))
      .toMatchObject({ attemptId: ATTEMPT_ID });
    expect(parseAppCliArgs(['execution', 'result-diagnostics', '--project', PROJECT_ID, '--session', SESSION_ID,
      '--limit', '10', '--cursor', 'plcur_v1_c'], {}))
      .toMatchObject({ workSessionId: SESSION_ID, limit: 10, cursor: 'plcur_v1_c' });
    expectParseError(['execution', 'result-diagnostics', '--project', PROJECT_ID], 'missing_required_option', 'parent');
    expectParseError(['execution', 'result-diagnostics', '--project', PROJECT_ID, '--run', RUN_ID, '--batch', BATCH_ID],
      'conflicting_options');
    expectParseError(['execution', 'result-diagnostics', '--project', PROJECT_ID, '--run', 'not-a-uuid'], 'invalid_run_id', 'runId');
    expectParseError(['execution', 'result-diagnostics', '--project', PROJECT_ID, '--run', RUN_ID, '--limit', '0'],
      'invalid_limit', 'limit');
    expectParseError(['execution', 'result-diagnostics', '--run', RUN_ID], 'missing_required_option', 'project');
    expectParseError(['execution', 'result-diagnostics', '--project', PROJECT_ID, '--run', RUN_ID, '--cursor', ''],
      'invalid_cursor', 'cursor');
  });
});

describe('F-003 结果诊断文本视图', () => {
  it('[case:cli-text-axes-actions] 文本展示停止原因与待处理动作、三轴互不折算、未知保持 unknown', () => {
    const view = buildResultDiagnosticsView(page);
    const text = formatResultDiagnosticsView(view);
    expect(text).toContain(`run=${RUN_ID}`);
    expect(text).toContain('scope: kind=run');
    expect(text).toContain('status=failed reason=user_cancel');
    expect(text).toContain('runtime: status=failed state=failed');
    expect(text).toContain('task: status=running manualBlockPending=true');
    expect(text).toContain('feature: status=running delivery=not_requested');
    expect(text).toContain('stop/block: reasons=manual_block_pending,run:user_cancel,stop:uncertain');
    expect(text).toContain('actions=review_manual_block,confirm_stop_uncertainty,rework_task');
    expect(text).toContain('rework=a-prev');
    expect(text).toContain('recovery=new(unknown)');
    expect(text).toContain('code=code-1 diag=unknown');
    expect(text).toContain('evidence=evidence-1');
    expect(text).toContain('gitOps=op-1(feature_final_commit,pending)');
    expect(text).toContain('gaps=historical_tail_missing');
    expect(text).toContain('recorder: sessions=1 truncated=false');
    expect(text).toContain('input=30 output=unknown');
    expect(text).toContain('issues: usage_partial,cache_unknown,recording_partial');
    expect(text).toContain('nextCursor=plcur_v1_test');
    expect(text).toContain(RESULT_DIAGNOSTICS_VIEW_NOTE);
    // 投影只消费结构化结果：记录与页级事实保持原值，null/缺口不被文本抹平。
    expect(view.records[0]).toBe(page.records[0]);
    expect(view.usage.diagnostics).toEqual(['cache_semantics_unknown']);
    expect(text).not.toContain('dataRoot');
    expect(text).not.toContain('/private/');
  });
});

describe('F-003 过期展示修正（Verifier/恢复已装配；受理/停止/验收分别表达）', () => {
  it('[case:cli-stale-display-corrected] 帮助与取消视图不再固定显示未装配/尚无恢复', () => {
    for (const scope of ['execution', 'execution.sessions', 'execution.session', 'execution.result-diagnostics'] as const) {
      const help = getAppCliHelp(scope);
      expect(help, scope).not.toContain('未装配 Verifier');
      expect(help, scope).not.toContain('尚无完整 Run 恢复');
    }
    const sessionHelp = getAppCliHelp('execution.session');
    expect(sessionHelp).toContain('独立 Verifier 已装配');
    expect(sessionHelp).toContain('验收结果按验证批次/最终验收持久事实表达');
    const blockHelp = getAppCliHelp('execution.sessions');
    expect(blockHelp).toContain('Run 恢复能力已装配');
    const diagnosticsHelp = getAppCliHelp('execution.result-diagnostics');
    expect(diagnosticsHelp).toContain('execution.result.diagnostics.list');
    expect(diagnosticsHelp).toContain('--batch <batchId> | --run <runId> | --attempt <attemptId> | --session <sessionId>');
    expect(diagnosticsHelp).toContain('nextCursor');
    expect(diagnosticsHelp).toContain('execution session-evidence/recording-body');
    // 取消受理、停止确认和验收结果仍按持久事实分别表达（不互相折算）。
    const cancel = buildAttemptCancelView(randomUUID(), false, { attemptId: ATTEMPT_ID, cancellationRequested: true }, {
      projectId: PROJECT_ID,
      attemptId: ATTEMPT_ID,
    });
    expect(cancel.acceptance).toMatchObject({
      commandAccepted: true,
      cancelAccepted: true,
      stoppedConfirmed: false,
      runtimeCompleted: null,
      taskAccepted: false,
      featureVerified: false,
      verifierAssembled: true,
    });
    const cancelHuman = formatAttemptCancelView(cancel);
    expect(cancelHuman).toContain('stopped=unconfirmed');
    expect(cancelHuman).toContain('verifierAssembled=true');
  });
});
