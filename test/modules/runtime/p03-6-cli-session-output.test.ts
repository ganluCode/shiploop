/**
 * P03-6 / F-013 Work Session 状态/证据与取消接受 CLI 纯面层（参数映射、
 * 结构化输出、帮助）。
 *
 * 定位：只测纯函数层（`parseAppCliArgs` / `app/work-session.ts` 视图投影 /
 * `getAppCliHelp`），不接触真实 Host、SQLite、文件或网络：
 * - execution sessions/session/session-evidence/cancel 按实际 Host 公共契约
 *   （execution.sessions.list / execution.session.get /
 *   execution.session.evidence.get / execution.attempt.cancel）映射参数；
 *   非法 ID/分页、缺失/同现父级选择、缺 --confirm 在任何 I/O 前以稳定 reason
 *   拒绝（退出码 2）；取消缺明确确认绝不发出请求；
 * - 结构化输出显示 Run/Task/Attempt/Session、实际 Runtime、执行阶段、错误
 *   原因、停止状态、覆盖缺口与制品引用；accepted/cancel accepted/Runtime
 *   completed/stopped confirmed 与 Task/Feature 验收分别表达；未装配 Verifier
 *   时明确等待能力；Synthetic 用量不展示为真实消费；缺失退出/耗时不填零；
 * - 帮助说明 Fake 测试专用、可信项目非强隔离、执行结束不代表验收以及本项
 *   尚无完整 Run 恢复。
 *
 * 纵向（Fake 测试 Host + CLI 执行路径）见 `p03-6-cli-session-vertical.test.ts`；
 * 正式构建入口验收见 `p03-6-cli-session-built.test.ts`。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APP_CLI_COMMAND_IDS,
  AppCliParseError,
  buildAttemptCancelView,
  buildWorkSessionDetailView,
  buildWorkSessionEvidenceView,
  buildWorkSessionListView,
  formatAttemptCancelView,
  formatWorkSessionDetailView,
  formatWorkSessionEvidenceView,
  formatWorkSessionListView,
  getAppCliHelp,
  parseAppCliArgs,
} from '../../../packages/cli/src/index.ts';
import type { HostClient } from '../../../packages/host/src/index.ts';

type WorkSessionListResult = Awaited<ReturnType<HostClient['listWorkSessions']>>;
type WorkSessionDetailResult = Awaited<ReturnType<HostClient['getWorkSession']>>;
type WorkSessionEvidenceContent = Awaited<ReturnType<HostClient['readWorkSessionEvidence']>>;

const PROJECT_ID = randomUUID();
const RUN_ID = randomUUID();
const ATTEMPT_ID = randomUUID();
const COMMAND_ID = randomUUID();
const TASK_ID = 't-1';
const DIGEST = 'a'.repeat(64);

function expectParseError(
  args: readonly string[],
  reason: string,
  field?: string,
): AppCliParseError {
  try {
    parseAppCliArgs(args, {});
  } catch (error) {
    expect(error, `expected AppCliParseError for ${JSON.stringify(args)}`).toBeInstanceOf(
      AppCliParseError,
    );
    const parseError = error as AppCliParseError;
    expect(parseError.reason).toBe(reason);
    if (field !== undefined) {
      expect(parseError.field).toBe(field);
    }
    return parseError;
  }
  throw new Error(`expected parse failure for ${JSON.stringify(args)}`);
}

/* ------------------------------------------------------------------ *
 * A. 参数映射（实际 Host 公共契约；不猜测草案命令）
 * ------------------------------------------------------------------ */

describe('F-013 Work Session/取消参数映射', () => {
  it('sessions/session/session-evidence/cancel 的命令身份与参数映射可得', () => {
    expect(APP_CLI_COMMAND_IDS).toContain('execution.sessions');
    expect(APP_CLI_COMMAND_IDS).toContain('execution.session');
    expect(APP_CLI_COMMAND_IDS).toContain('execution.session-evidence');
    expect(APP_CLI_COMMAND_IDS).toContain('execution.cancel');

    const byRun = parseAppCliArgs(
      ['execution', 'sessions', '--project', PROJECT_ID, '--run', RUN_ID, '--limit', '10', '--cursor', 'plcur_v1_x', '--json'],
      {},
    );
    expect(byRun).toMatchObject({
      commandId: 'execution.sessions',
      projectId: PROJECT_ID,
      runId: RUN_ID,
      limit: 10,
      cursor: 'plcur_v1_x',
      json: true,
    });
    const byTask = parseAppCliArgs(['execution', 'sessions', '--project', PROJECT_ID, '--task', TASK_ID], {});
    expect(byTask).toMatchObject({ commandId: 'execution.sessions', projectId: PROJECT_ID, taskId: TASK_ID });

    expect(parseAppCliArgs(['execution', 'session', ATTEMPT_ID, '--project', PROJECT_ID], {})).toMatchObject({
      commandId: 'execution.session',
      attemptId: ATTEMPT_ID,
    });
    expect(
      parseAppCliArgs(
        ['execution', 'session-evidence', ATTEMPT_ID, '--project', PROJECT_ID, '--artifact', 'art-1'],
        {},
      ),
    ).toMatchObject({ commandId: 'execution.session-evidence', attemptId: ATTEMPT_ID, artifactId: 'art-1' });
    expect(
      parseAppCliArgs(['execution', 'cancel', ATTEMPT_ID, '--project', PROJECT_ID, '--confirm'], {}),
    ).toMatchObject({
      commandId: 'execution.cancel',
      operation: 'execution.attempt.cancel',
      attemptId: ATTEMPT_ID,
      confirm: true,
    });
  });

  it('非法 ID/分页与非法父级选择在任何 I/O 之前以稳定 reason 拒绝', () => {
    expectParseError(['execution', 'session', 'not-a-uuid', '--project', PROJECT_ID], 'invalid_attempt_id');
    expectParseError(['execution', 'session', ATTEMPT_ID, '--project', 'not-a-uuid'], 'invalid_project_id');
    expectParseError(
      ['execution', 'sessions', '--project', PROJECT_ID, '--run', 'not-a-uuid'],
      'invalid_run_id',
      'runId',
    );
    expectParseError(
      ['execution', 'sessions', '--project', PROJECT_ID, '--task', 'bad id'],
      'invalid_plan_id',
      'taskId',
    );
    expectParseError(['execution', 'sessions', '--project', PROJECT_ID], 'missing_required_option', 'parent');
    expectParseError(
      ['execution', 'sessions', '--project', PROJECT_ID, '--run', RUN_ID, '--task', TASK_ID],
      'conflicting_options',
    );
    expectParseError(
      ['execution', 'sessions', '--project', PROJECT_ID, '--run', RUN_ID, '--limit', '0'],
      'invalid_limit',
      'limit',
    );
    expectParseError(
      ['execution', 'sessions', '--project', PROJECT_ID, '--run', RUN_ID, '--limit', '201'],
      'invalid_limit',
      'limit',
    );
    expectParseError(
      ['execution', 'sessions', '--project', PROJECT_ID, '--run', RUN_ID, '--cursor', ''],
      'invalid_cursor',
      'cursor',
    );
    expectParseError(
      ['execution', 'session-evidence', ATTEMPT_ID, '--project', PROJECT_ID, '--artifact', 'bad/artifact'],
      'invalid_artifact_id',
      'artifactId',
    );
  });

  it('取消缺明确确认本地拒绝（不发取消请求）；非法命令 ID 同样拒绝', () => {
    expectParseError(['execution', 'cancel', ATTEMPT_ID, '--project', PROJECT_ID], 'confirmation_required', 'confirm');
    expectParseError(
      ['execution', 'cancel', ATTEMPT_ID, '--project', PROJECT_ID, '--confirm', '--command-id', 'not-a-uuid'],
      'invalid_command_id',
      'command-id',
    );
    expectParseError(
      ['execution', 'cancel', 'not-a-uuid', '--project', PROJECT_ID, '--confirm'],
      'invalid_attempt_id',
    );
    const ok = parseAppCliArgs(
      ['execution', 'cancel', ATTEMPT_ID, '--project', PROJECT_ID, '--confirm', '--command-id', COMMAND_ID],
      {},
    );
    expect(ok).toMatchObject({ explicitCommandId: COMMAND_ID, confirm: true });
    // 摘要/身份供回执重放：同一 --command-id 可重建原信封（视图层不生成命令身份）。
    expect(DIGEST).toHaveLength(64);
  });
});

/* ------------------------------------------------------------------ *
 * 线形状夹具（HostClient 已校验结果的等价形态；纯投影不改写事实）
 * ------------------------------------------------------------------ */

function attemptRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ATTEMPT_ID,
    projectId: PROJECT_ID,
    featureId: 'f-1',
    runId: RUN_ID,
    taskId: TASK_ID,
    number: 1,
    owner: 'owner-1',
    hostInstanceId: randomUUID(),
    executionVersion: 1,
    status: 'verifying',
    executionStage: 'runtime',
    inputDigest: DIGEST,
    inputRef: 'inp-1',
    sessionId: 'sess-1',
    invocationId: 'inv-1',
    errorKind: null,
    diagnosticRef: null,
    startedAt: '2026-10-13T00:00:00.000Z',
    endedAt: '2026-10-13T00:00:05.000Z',
    durationMs: 5000,
    exitCode: null,
    usageSummary: null,
    ...overrides,
  };
}

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sess-1',
    status: 'stopped',
    kind: 'work',
    purpose: 'work',
    title: null,
    runtime: 'fake',
    adapterVersion: 'fake-1',
    executionStage: 'runtime',
    nativeRef: null,
    inputRef: 'inp-1',
    resultRef: 'res-1',
    lastActivityAt: '2026-10-13T00:00:05.000Z',
    startedAt: '2026-10-13T00:00:00.000Z',
    endedAt: '2026-10-13T00:00:04.000Z',
    stoppedAt: '2026-10-13T00:00:05.000Z',
    recordingWatermark: 12,
    recordingGaps: ['evt.9 missing'],
    revision: 2,
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:05.000Z',
    ...overrides,
  };
}

function runtimeResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    terminal: 'completed',
    reason: null,
    exitCode: 0,
    signal: null,
    durationMs: 4200,
    usage: { basis: 'synthetic', inputTokens: 10, outputTokens: 5, costUsdMicros: null },
    lastEventSequence: 12,
    ...overrides,
  };
}

function settlementEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'runtime-settlement',
    result: runtimeResult(),
    failure: null,
    recording: { complete: true, manifestRef: 'man-1', failure: null, gaps: ['evt.9 missing'], watermark: 12 },
    stop: {
      evidence: {
        schemaVersion: 1,
        confirmed: true,
        checkedAtUtc: '2026-10-13T00:00:05.000Z',
        detail: 'process_gone',
      },
      failure: null,
    },
    control: { reason: 'user_cancelled', cancel: 'accepted' },
    ...overrides,
  };
}

function detailResult(overrides: Record<string, unknown> = {}): WorkSessionDetailResult {
  return {
    attempt: attemptRow(),
    executionState: 'awaiting_verification',
    session: sessionRow(),
    resultEvidence: settlementEvidence(),
    occupancy: [
      {
        id: 'lease-1',
        attemptId: ATTEMPT_ID,
        runId: RUN_ID,
        resourceKind: 'workspace',
        resourceKey: 'hash-key',
        state: 'held',
        leaseUntil: '2026-10-13T01:00:00.000Z',
        processIdentity: true,
      },
    ],
    evidence: [
      {
        artifactId: 'res-1',
        kind: 'runtime-settlement',
        mediaType: 'application/json',
        status: 'ready',
        contentHash: DIGEST,
        sizeBytes: 128,
        version: 1,
      },
    ],
    evidenceTruncated: false,
    diagnostics: [],
    diagnosticsTruncated: false,
    ...overrides,
  } as unknown as WorkSessionDetailResult;
}

/* ------------------------------------------------------------------ *
 * B. 状态/证据结构化输出（五类表达互不折算；未知不填零）
 * ------------------------------------------------------------------ */

describe('F-013 Runtime 结果/等待验证结构化输出', () => {
  it('详情显示 Run/Task/Attempt/Session、实际 Runtime、阶段、错误原因、停止状态、缺口与制品引用', () => {
    const view = buildWorkSessionDetailView(
      detailResult({
        resultEvidence: settlementEvidence({ failure: { kind: 'runtime_failed', reason: 'exit_1' } }),
      }),
    );
    expect(view.identity).toMatchObject({
      projectId: PROJECT_ID,
      runId: RUN_ID,
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      attemptNumber: 1,
      sessionId: 'sess-1',
      resultRef: 'res-1',
    });
    expect(view.runtime).toEqual({ id: 'fake', adapterVersion: 'fake-1' });
    expect(view.execution).toMatchObject({ state: 'awaiting_verification', executionStage: 'runtime' });
    expect(view.error).toEqual({ kind: 'runtime_failed', reason: 'exit_1' });
    expect(view.stop).toMatchObject({ state: 'confirmed', confirmed: true });
    expect(view.recording).toMatchObject({ complete: true, watermark: 12, gaps: ['evt.9 missing'] });
    expect(view.evidence.map((ref) => ref.artifactId)).toEqual(['res-1']);
    const human = formatWorkSessionDetailView(view);
    expect(human).toContain(`run=${RUN_ID}`);
    expect(human).toContain(`task=${TASK_ID}`);
    expect(human).toContain(`attempt=${ATTEMPT_ID}#1`);
    expect(human).toContain('session=sess-1');
    expect(human).toContain('runtime=fake');
    expect(human).toContain('stage=runtime');
    expect(human).toContain('reason=exit_1');
    expect(human).toContain('stop: state=confirmed');
    expect(human).toContain('gaps=evt.9 missing');
    expect(human).toContain('res-1(runtime-settlement,ready)');
  });

  it('accepted/cancel accepted/Runtime completed/stopped confirmed 与 Task/Feature 验收分别表达', () => {
    const settled = buildWorkSessionDetailView(detailResult());
    expect(settled.acceptance).toMatchObject({
      cancelAccepted: true,
      runtimeCompleted: true,
      stoppedConfirmed: true,
      awaitingVerification: true,
      verifierAssembled: false,
      taskAccepted: false,
      featureVerified: false,
    });
    // 取消接受（control.cancel=accepted）与停止确认分开：停止未核验时不得冒充。
    const unconfirmed = buildWorkSessionDetailView(
      detailResult({
        resultEvidence: settlementEvidence({
          stop: { evidence: { schemaVersion: 1, confirmed: false, checkedAtUtc: '2026-10-13T00:00:05.000Z', detail: null }, failure: null },
        }),
      }),
    );
    expect(unconfirmed.acceptance).toMatchObject({
      cancelAccepted: true,
      stoppedConfirmed: false,
      taskAccepted: false,
      featureVerified: false,
    });
    expect(unconfirmed.stop.state).toBe('unconfirmed');
    // 无停止观察保持 unknown，不推断确认。
    const noStop = buildWorkSessionDetailView(
      detailResult({
        resultEvidence: settlementEvidence({ stop: { evidence: null, failure: null }, control: null }),
      }),
    );
    expect(noStop.stop).toMatchObject({ state: 'unknown', confirmed: null });
    expect(noStop.acceptance).toMatchObject({ cancelAccepted: false, stoppedConfirmed: false });

    const cancel = buildAttemptCancelView(COMMAND_ID, false, { attemptId: ATTEMPT_ID, cancellationRequested: true }, {
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
      verifierAssembled: false,
    });
    const cancelHuman = formatAttemptCancelView(cancel);
    expect(cancelHuman).toContain('command=accepted');
    expect(cancelHuman).toContain('cancel=accepted');
    expect(cancelHuman).toContain('stopped=unconfirmed');
    expect(cancelHuman).toContain('runtimeCompleted=unknown');
  });

  it('Synthetic 用量不展示为真实消费；缺失退出/耗时保持 null 不填零', () => {
    const synthetic = buildWorkSessionDetailView(detailResult());
    expect(synthetic.runtimeResult?.usage).toEqual({
      basis: 'synthetic',
      inputTokens: 10,
      outputTokens: 5,
      costUsdMicros: null,
      realConsumption: false,
    });
    expect(formatWorkSessionDetailView(synthetic)).toContain('synthetic_token_not_real_consumption');

    const reported = buildWorkSessionDetailView(
      detailResult({
        resultEvidence: settlementEvidence({
          result: runtimeResult({ usage: { basis: 'reported', inputTokens: 1, outputTokens: 2, costUsdMicros: 300 } }),
        }),
      }),
    );
    expect(reported.runtimeResult?.usage?.realConsumption).toBe(true);

    const unknown = buildWorkSessionDetailView(
      detailResult({
        resultEvidence: settlementEvidence({
          result: runtimeResult({ exitCode: null, durationMs: null, usage: null, terminal: 'cancelled' }),
        }),
      }),
    );
    expect(unknown.runtimeResult).toMatchObject({ exitCode: null, durationMs: null, usage: null, completed: false });
    const human = formatWorkSessionDetailView(unknown);
    expect(human).toContain('exit=unknown');
    expect(human).toContain('durationMs=unknown');
    expect(human).toContain('usage=unknown');
    expect(human).not.toContain('exit=0');
  });

  it('列表与证据正文视图保留稳定身份、缺口/制品引用与正文编码', () => {
    const list = buildWorkSessionListView(
      {
        schemaVersion: 5,
        scope: 'work-session-list',
        records: [
          {
            sessionId: 'sess-1',
            projectId: PROJECT_ID,
            featureId: 'f-1',
            runId: RUN_ID,
            taskId: TASK_ID,
            attemptId: ATTEMPT_ID,
            attemptNumber: 1,
            status: 'stopped',
            executionStage: 'runtime',
            executionState: 'awaiting_verification',
            runtime: 'fake',
            adapterVersion: 'fake-1',
            inputRef: 'inp-1',
            resultRef: 'res-1',
            lastActivityAt: '2026-10-13T00:00:05.000Z',
            startedAt: null,
            endedAt: null,
            stoppedAt: null,
            recordingWatermark: null,
            recordingGapCount: null,
          },
        ],
        nextCursor: null,
        limit: 50,
      } as unknown as WorkSessionListResult,
      { runId: RUN_ID },
    );
    expect(list.records).toHaveLength(1);
    expect(list.parent).toEqual({ runId: RUN_ID });
    const human = formatWorkSessionListView(list);
    expect(human).toContain('session=sess-1');
    expect(human).toContain(`run=${RUN_ID}`);
    expect(human).toContain('runtime=fake');
    expect(human).toContain('watermark=unknown');
    expect(human).toContain('resultRef=res-1');

    const evidence = buildWorkSessionEvidenceView({
      schemaVersion: 5,
      scope: 'work-session-evidence',
      artifact: {
        artifactId: 'res-1',
        kind: 'runtime-settlement',
        mediaType: 'application/json',
        contentHash: DIGEST,
        sizeBytes: 2,
        version: 1,
      },
      content: new TextEncoder().encode('{}'),
    } as unknown as WorkSessionEvidenceContent);
    expect(evidence).toMatchObject({ contentEncoding: 'utf8', content: '{}' });
    expect(formatWorkSessionEvidenceView(evidence)).toContain('artifact=res-1');
  });

  it('取消回执 result 形状 fail-closed（目标不一致即拒绝，不折算取消接受）', () => {
    expect(() =>
      buildAttemptCancelView(COMMAND_ID, false, { attemptId: 'other', cancellationRequested: true }, {
        projectId: PROJECT_ID,
        attemptId: ATTEMPT_ID,
      }),
    ).toThrow(TypeError);
    expect(() =>
      buildAttemptCancelView(COMMAND_ID, false, { attemptId: ATTEMPT_ID, cancellationRequested: false }, {
        projectId: PROJECT_ID,
        attemptId: ATTEMPT_ID,
      }),
    ).toThrow(TypeError);
  });
});

/* ------------------------------------------------------------------ *
 * C. 帮助边界（Fake 测试专用 / 非强隔离 / 执行结束≠验收 / 无完整 Run 恢复）
 * ------------------------------------------------------------------ */

describe('F-013 帮助边界声明', () => {
  it('execution/session/cancel 帮助说明 Fake 测试专用、可信项目非强隔离、执行结束不代表验收、本项尚无完整 Run 恢复', () => {
    for (const scope of ['execution', 'execution.sessions', 'execution.session', 'execution.session-evidence', 'execution.cancel'] as const) {
      const help = getAppCliHelp(scope);
      expect(help, scope).toContain('Fake 测试专用');
      expect(help, scope).toContain('可信项目模式不提供强 OS 隔离');
      expect(help, scope).toContain('执行结束不代表验收');
      expect(help, scope).toContain('本项尚无完整 Run 恢复');
      expect(help, scope).toContain('cancel accepted');
    }
  });
});
