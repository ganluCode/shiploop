/**
 * P03-9 / F-015 CLI Run/Batch 控制、retryFinal 与恢复诊断入口。
 *
 * 验收面（.dag_context.json F-015 第 1-4 条）：
 * 1. CLI 指定项目与 Run/Batch 发起 pause/cancel/resume（恢复模式 auto/new/required
 *    由 Task 策略/输入快照决定，不由命令注入，经恢复诊断展示）；retry-final 显式
 *    指定历史 Run，全部经 HostClient 公共面，不访问数据库；
 * 2. 参数缺失、未知模式、非法 ID/revision、互斥选项在提交前拒绝（退出码 2）；
 *    --command-id 可重用查询原回执；accepted/completed 输出不宣称已暂停/停止/完成；
 * 3. 结构化输出和帮助区分工作流 resume、Fake 新 Session 降级、停止不确定与仅
 *    收尾重试，携带诊断/证据引用和可理解下一步；
 * 4. CLI 测试验证参数到请求的映射、失败退出语义、重复命令及退出 follow 不取消；
 *    不引入真实 Pi、跨模型续接或本机绝对路径依赖。
 */
import { describe, expect, it } from 'vitest';
import { AppCliParseError, parseAppCliArgs } from '../packages/cli/src/app/args.ts';
import {
  buildExecutionControlCommandView,
  buildExecutionControlQueryView,
  buildExecutionRecoveryCliView,
  buildExecutionRetryFinalView,
  formatExecutionControlCommandView,
  formatExecutionControlQueryView,
  formatExecutionRecoveryCliView,
  formatExecutionRetryFinalView,
} from '../packages/cli/src/app/run-control.ts';
import { getAppCliHelp } from '../packages/cli/src/app/help.ts';
import type {
  RunControlDetailResult,
  RunRecoveryDetailResult,
} from 'shiploop-host';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID_2 = '22222222-2222-4222-8222-222222222222';
const BATCH_ID = '33333333-3333-4333-8333-333333333333';
const FEATURE_ID = 'f-feature';
const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
const COMMAND_ID = '55555555-5555-4555-8555-555555555555';

/* ------------------------------------------------------------------ *
 * 验收 1/4：参数到请求的映射（纯解析，无 I/O）
 * ------------------------------------------------------------------ */

describe('F-015 控制命令参数映射（纯解析）', () => {
  it('pause/resume 以 --run/--batch 恰一目标 + --revision 映射冻结请求形态', () => {
    const pauseRun = parseAppCliArgs(
      ['execution', 'pause', '--project', PROJECT_ID, '--run', RUN_ID, '--revision', '3', '--json'],
      {},
    );
    expect(pauseRun).toMatchObject({
      kind: 'command',
      command: 'execution',
      commandId: 'execution.pause',
      operation: 'execution.pause',
      projectId: PROJECT_ID,
      targetKind: 'run',
      targetId: RUN_ID,
      expectedRevision: 3,
    });

    const pauseBatch = parseAppCliArgs(
      ['execution', 'pause', '--project', PROJECT_ID, '--batch', BATCH_ID, '--revision', '1'],
      {},
    );
    expect(pauseBatch).toMatchObject({
      commandId: 'execution.pause',
      targetKind: 'batch',
      targetId: BATCH_ID,
      expectedRevision: 1,
    });

    const resume = parseAppCliArgs(
      ['execution', 'resume', '--project', PROJECT_ID, '--run', RUN_ID, '--revision', '2'],
      {},
    );
    expect(resume).toMatchObject({
      commandId: 'execution.resume',
      operation: 'execution.resume',
      targetKind: 'run',
      targetId: RUN_ID,
      expectedRevision: 2,
    });

    /* 显式 --command-id 保留原身份（重复提交命中服务端摘要重放）。 */
    const explicit = parseAppCliArgs(
      ['execution', 'pause', '--project', PROJECT_ID, '--run', RUN_ID, '--revision', '1',
        '--command-id', COMMAND_ID],
      {},
    );
    expect(explicit).toMatchObject({ explicitCommandId: COMMAND_ID });
  });

  it('Run/Batch 级 cancel 与既有 Attempt cancel 双形态共存；映射不同 Host 操作', () => {
    /* 新形态：无 positional + --run/--batch + --revision + --confirm。 */
    const cancelRun = parseAppCliArgs(
      ['execution', 'cancel', '--project', PROJECT_ID, '--run', RUN_ID, '--revision', '4', '--confirm'],
      {},
    );
    expect(cancelRun).toMatchObject({
      commandId: 'execution.cancel',
      operation: 'execution.cancel',
      targetKind: 'run',
      targetId: RUN_ID,
      expectedRevision: 4,
      confirm: true,
    });

    const cancelBatch = parseAppCliArgs(
      ['execution', 'cancel', '--project', PROJECT_ID, '--batch', BATCH_ID, '--revision', '1', '--confirm'],
      {},
    );
    expect(cancelBatch).toMatchObject({ operation: 'execution.cancel', targetKind: 'batch' });

    /* 既有 Attempt 形态保持不变。 */
    const cancelAttempt = parseAppCliArgs(
      ['execution', 'cancel', ATTEMPT_ID, '--project', PROJECT_ID, '--confirm'],
      {},
    );
    expect(cancelAttempt).toMatchObject({
      commandId: 'execution.cancel',
      operation: 'execution.attempt.cancel',
      attemptId: ATTEMPT_ID,
    });
  });

  it('retry-final 显式指定历史 Run 与 workKey，映射 execution.retryFinal 请求', () => {
    const retry = parseAppCliArgs(
      ['execution', 'retry-final', FEATURE_ID, '--project', PROJECT_ID,
        '--historical-run', RUN_ID, '--work-key', 'shiploop:feature:f-feature', '--json'],
      {},
    );
    expect(retry).toMatchObject({
      commandId: 'execution.retry-final',
      operation: 'execution.retryFinal',
      projectId: PROJECT_ID,
      featureId: FEATURE_ID,
      historicalRunId: RUN_ID,
      workKey: 'shiploop:feature:f-feature',
    });
  });

  it('control/batch-control/recovery 恢复诊断只读入口映射稳定身份', () => {
    const control = parseAppCliArgs(
      ['execution', 'control', RUN_ID, '--project', PROJECT_ID, '--json'],
      {},
    );
    expect(control).toMatchObject({
      commandId: 'execution.control',
      projectId: PROJECT_ID,
      runId: RUN_ID,
    });

    const batchControl = parseAppCliArgs(
      ['execution', 'batch-control', BATCH_ID, '--project', PROJECT_ID],
      {},
    );
    expect(batchControl).toMatchObject({
      commandId: 'execution.batch-control',
      projectId: PROJECT_ID,
      batchId: BATCH_ID,
    });

    const recovery = parseAppCliArgs(
      ['execution', 'recovery', RUN_ID, '--project', PROJECT_ID],
      {},
    );
    expect(recovery).toMatchObject({
      commandId: 'execution.recovery',
      projectId: PROJECT_ID,
      runId: RUN_ID,
    });
  });
});

/* ------------------------------------------------------------------ *
 * 验收 2：提交前拒绝（任何 I/O 之前；解析失败退出码 2 语义）
 * ------------------------------------------------------------------ */

describe('F-015 提交前输入拒绝', () => {
  const cases: readonly (readonly [readonly string[], string])[] = [
    /* 目标互斥/缺失。 */
    [['execution', 'pause', '--project', PROJECT_ID, '--run', RUN_ID, '--batch', BATCH_ID, '--revision', '1'],
      'run 与 batch 互斥'],
    [['execution', 'resume', '--project', PROJECT_ID, '--revision', '1'], '缺少控制目标'],
    [['execution', 'cancel', '--project', PROJECT_ID, '--revision', '1', '--confirm'], 'cancel 缺少控制目标'],
    /* 参数缺失。 */
    [['execution', 'pause', '--run', RUN_ID, '--revision', '1'], '缺少项目'],
    [['execution', 'pause', '--project', PROJECT_ID, '--run', RUN_ID], '缺少 revision'],
    [['execution', 'retry-final', FEATURE_ID, '--project', PROJECT_ID, '--work-key', 'k'], '缺少历史 Run'],
    [['execution', 'retry-final', FEATURE_ID, '--project', PROJECT_ID, '--historical-run', RUN_ID], '缺少 workKey'],
    /* 非法 ID/revision。 */
    [['execution', 'pause', '--project', PROJECT_ID, '--run', 'not-a-uuid', '--revision', '1'], '非法 runId'],
    [['execution', 'resume', '--project', PROJECT_ID, '--batch', BATCH_ID, '--revision', '0'], 'revision 必须 ≥1'],
    [['execution', 'pause', '--project', 'nope', '--run', RUN_ID, '--revision', '1'], '非法项目'],
    [['execution', 'retry-final', FEATURE_ID, '--project', PROJECT_ID, '--historical-run', RUN_ID,
      '--work-key', ''], '空 workKey'],
    [['execution', 'retry-final', FEATURE_ID, '--project', PROJECT_ID, '--historical-run', RUN_ID,
      '--work-key', 'k'.repeat(257)], '超长 workKey'],
    /* Attempt cancel 形态不接受 Run/Batch 控制参数。 */
    [['execution', 'cancel', ATTEMPT_ID, '--project', PROJECT_ID, '--confirm', '--run', RUN_ID],
      'positional 与 --run 互斥'],
    [['execution', 'cancel', ATTEMPT_ID, '--project', PROJECT_ID, '--confirm', '--revision', '1'],
      'attempt cancel 不接受 revision'],
    /* Run/Batch cancel 必须显式确认。 */
    [['execution', 'cancel', '--project', PROJECT_ID, '--run', RUN_ID, '--revision', '1'],
      '缺少 --confirm'],
  ] as const;

  it('互斥/缺失/非法参数在连接前以稳定 reason 拒绝', () => {
    expect(cases.length).toBeGreaterThanOrEqual(13);
    for (const [argv, label] of cases) {
      let error: unknown;
      try {
        parseAppCliArgs([...argv], {});
      } catch (caught) {
        error = caught;
      }
      expect(error, label).toBeInstanceOf(AppCliParseError);
      expect((error as AppCliParseError).code, label).toBe('invalid_input');
    }
  });

  it('未知恢复诊断参数与未知子命令拒绝；不引入恢复模式注入参数', () => {
    expect(() => parseAppCliArgs(['execution', 'control', RUN_ID, '--project', PROJECT_ID, '--mode', 'auto'], {}))
      .toThrow(AppCliParseError);
    expect(() => parseAppCliArgs(['execution', 'pause'], {})).toThrow(AppCliParseError);
    expect(() => parseAppCliArgs(['execution', 'resume-final', FEATURE_ID], {})).toThrow(AppCliParseError);
    /* resume payload 不注入恢复模式：auto/new/required 由 Task 策略/输入快照决定。 */
    for (const flag of ['--recovery-mode', '--resume-mode', '--session-mode']) {
      expect(() =>
        parseAppCliArgs(
          ['execution', 'resume', '--project', PROJECT_ID, '--run', RUN_ID, '--revision', '1', flag, 'auto'],
          {},
        ),
      ).toThrow(AppCliParseError);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 验收 3：结构化输出区分工作流 resume、Fake 新 Session 降级、
 * 停止不确定与仅收尾重试（纯投影；不宣称终态）
 * ------------------------------------------------------------------ */

describe('F-015 控制命令回执视图（不宣称已暂停/停止/完成）', () => {
  it('pausing/cancelling 输出等待收尾说明与查询下一步，不写成已暂停/已停止', () => {
    const pausing = buildExecutionControlCommandView(
      COMMAND_ID, false, 'execution.pause',
      { outcome: 'pausing', targetKind: 'run', targetId: RUN_ID, status: 'pausing', revision: 2, changed: true },
    );
    expect(pausing).toMatchObject({
      operation: 'execution.pause',
      outcome: 'pausing',
      status: 'pausing',
      finalState: false,
    });
    expect(pausing.note).not.toMatch(/已暂停/);
    expect(pausing.nextStep).toMatch(/execution control/);
    const human = formatExecutionControlCommandView(pausing);
    expect(human).toContain('pausing');
    expect(human).toMatch(/等待当前 Attempt 收尾|尚未暂停/);
    expect(human).not.toMatch(/验收通过|业务完成/);

    const cancelling = buildExecutionControlCommandView(
      COMMAND_ID, false, 'execution.cancel',
      {
        outcome: 'cancelling', targetKind: 'run', targetId: RUN_ID, status: 'cancelling',
        revision: 3, changed: true, stopOperationId: 'stop-1', stopStatus: 'stopping',
      },
    );
    expect(cancelling).toMatchObject({ outcome: 'cancelling', stopOperationId: 'stop-1', finalState: false });
    expect(formatExecutionControlCommandView(cancelling)).toMatch(/停止 operation|尚未停止/);
  });

  it('stop_uncertain 输出停止不确定与证据核对下一步，不冒充已停止', () => {
    const uncertain = buildExecutionControlCommandView(
      COMMAND_ID, false, 'execution.cancel',
      {
        outcome: 'stop_uncertain', targetKind: 'run', targetId: RUN_ID, status: 'interrupted',
        revision: 4, changed: true, stopOperationId: 'stop-2', stopStatus: 'uncertain',
      },
    );
    expect(uncertain.finalState).toBe(false);
    expect(uncertain.note).toMatch(/停止不确定/);
    expect(uncertain.nextStep).toMatch(/execution control|停止证据/);
    expect(formatExecutionControlCommandView(uncertain)).toMatch(/停止不确定/);
  });

  it('paused/resumed 输出工作流状态并明确不等于验收通过；replayed 标记原回执', () => {
    const paused = buildExecutionControlCommandView(
      COMMAND_ID_2(), true, 'execution.pause',
      { outcome: 'paused', targetKind: 'run', targetId: RUN_ID, status: 'paused', revision: 2, changed: true },
    );
    expect(paused.replayed).toBe(true);
    expect(paused.note).toMatch(/不代表.*验收|不等于.*验收/);
    expect(formatExecutionControlCommandView(paused)).toContain('replayed');

    const resumed = buildExecutionControlCommandView(
      COMMAND_ID, false, 'execution.resume',
      {
        resumed: true, targetKind: 'run', targetId: RUN_ID, status: 'queued',
        revision: 3, batchId: BATCH_ID, featureId: FEATURE_ID, runIds: [RUN_ID],
        runtimeStarts: 0, attemptsCreated: 0,
      },
    );
    /* 工作流 resume ≠ Runtime/SDK 原生续接：输出说明恢复模式由任务策略决定。 */
    expect(resumed.note).toMatch(/工作流 resume|不等于 Runtime|任务策略/);
    expect(resumed.runIds).toEqual([RUN_ID]);
  });

  function COMMAND_ID_2(): string {
    return '66666666-6666-4666-8666-666666666666';
  }
});

describe('F-015 retry-final 视图（仅收尾重试，零 Runtime 启动）', () => {
  const result = {
    schemaVersion: 1,
    retryFinal: true,
    dispatched: true,
    batchId: BATCH_ID,
    runId: RUN_ID_2,
    featureId: FEATURE_ID,
    historicalRunId: RUN_ID,
    workKey: 'shiploop:feature:f-feature',
    dispatchOrdinal: 2,
    runsCreated: 1,
    status: 'queued',
    finalizationScopeDigest: 'ab'.repeat(32),
    missingSteps: ['finalVerification'],
    revalidateTaskIds: ['t-1'],
    finalCheckKeys: ['unit-core'],
    runtimeStarts: 0,
    attemptsCreated: 0,
  } as const;

  it('结构化视图区分仅收尾重试并携带 scope/证据引用', () => {
    const view = buildExecutionRetryFinalView(COMMAND_ID, false, result);
    expect(view).toMatchObject({
      operation: 'execution.retryFinal',
      retryFinal: true,
      historicalRunId: RUN_ID,
      newRunId: RUN_ID_2,
      runtimeStarts: 0,
      attemptsCreated: 0,
    });
    expect(view.note).toMatch(/仅收尾|不重复编码|零 Runtime 启动/);
    expect(view.missingSteps).toEqual(['finalVerification']);
    const human = formatExecutionRetryFinalView(view);
    expect(human).toContain('runtimeStarts=0');
    expect(human).toMatch(/finalVerification|收尾/);
    expect(human).not.toMatch(/验收通过/);
  });
});

/* ------------------------------------------------------------------ *
 * 验收 3：控制/恢复诊断视图（nextActions、降级、停止证据引用）
 * ------------------------------------------------------------------ */

function runControlFixture(
  nextActions: readonly string[],
  stopOperations: readonly Record<string, unknown>[] = [],
): RunControlDetailResult {
  return {
    schemaVersion: 5,
    scope: 'run-control',
    run: {
      runId: RUN_ID,
      batchId: BATCH_ID,
      featureId: FEATURE_ID,
      purpose: 'work',
      status: 'paused',
      reason: 'user_pause',
      pauseRequestedAt: '2026-10-19T00:00:00.000Z',
      startedAt: null,
      endedAt: null,
      updatedAt: '2026-10-19T00:00:00.000Z',
    },
    batch: {
      batchId: BATCH_ID,
      featureId: FEATURE_ID,
      status: 'paused',
      reason: null,
      pauseRequestedAt: null,
      deadlineAt: '2026-10-20T00:00:00.000Z',
      budgetRevision: 1,
      counters: { runsCreated: 1, attemptsCreated: 1, runtimeStarts: 1, noProgressRuns: 0 },
      updatedAt: '2026-10-19T00:00:00.000Z',
    },
    attempts: {
      records: [{
        attemptId: ATTEMPT_ID,
        taskId: 't-1',
        attemptNumber: 1,
        status: 'interrupted',
        executionStage: 'verification',
        errorKind: null,
        diagnosticRef: null,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        exitCode: null,
        usage: null,
      }],
      truncated: false,
    },
    stopOperations: stopOperations as never,
    leases: [],
    nextActions: nextActions as never,
  };
}

describe('F-015 控制诊断视图（显式下一步与证据引用）', () => {
  it('nextActions 附带可理解说明；stop_reconcile 指向停止证据核对', () => {
    const view = buildExecutionControlQueryView(
      runControlFixture(['stop_reconcile', 'resume_blocked_occupancy']),
    );
    expect(view.operation).toBe('execution.run.control.get');
    expect(view.nextActionNotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'stop_reconcile' }),
        expect.objectContaining({ action: 'resume_blocked_occupancy' }),
      ]),
    );
    for (const note of view.nextActionNotes) {
      expect(note.description.length).toBeGreaterThan(8);
    }
    const stopNote = view.nextActionNotes.find((note) => note.action === 'stop_reconcile');
    expect(stopNote?.description).toMatch(/证据|核对/);
    const human = formatExecutionControlQueryView(view);
    expect(human).toContain('paused');
    expect(human).toContain('stop_reconcile');
  });

  it('停止 operation 投影保留 unknown null 语义，不以 false 冒充未强制', () => {
    const view = buildExecutionControlQueryView(
      runControlFixture(['await_stop_settlement'], [{
        operationId: 'stop-9',
        targetKind: 'run',
        targetId: RUN_ID,
        batchId: BATCH_ID,
        runId: RUN_ID,
        status: 'uncertain',
        reason: 'user_cancel',
        requestedAt: '2026-10-19T00:00:00.000Z',
        settledAt: null,
        evidenceRef: 'art-evidence',
        stopConfirmed: null,
        forced: null,
        checkedAt: null,
      }]),
    );
    const stop = view.stopOperations[0];
    expect(stop).toMatchObject({ operationId: 'stop-9', status: 'uncertain', evidenceRef: 'art-evidence' });
    expect(stop.stopConfirmed).toBeNull();
    expect(stop.forced).toBeNull();
    expect(formatExecutionControlQueryView(view)).toMatch(/unknown|未知/);
  });
});

describe('F-015 恢复诊断视图（工作流 resume vs Fake 新 Session 降级）', () => {
  const recovery = (continuations: readonly Record<string, unknown>[]): RunRecoveryDetailResult => ({
    schemaVersion: 5,
    scope: 'run-recovery',
    run: {
      runId: RUN_ID,
      batchId: BATCH_ID,
      featureId: FEATURE_ID,
      purpose: 'work',
      workKey: 'shiploop:feature:f-feature',
      dispatchOrdinal: 1,
      status: 'paused',
      reason: 'user_pause',
      startedAt: null,
      endedAt: null,
    },
    finalization: { present: false, scope: null, axes: null as never },
    recovery: { records: continuations as never, truncated: false, attemptsScanned: 2 },
    budget: {
      batchId: BATCH_ID,
      budgetRevision: 1,
      deadlineAt: '2026-10-20T00:00:00.000Z',
      limits: { schemaVersion: 1 } as never,
      counters: { runsCreated: 1, attemptsCreated: 2, runtimeStarts: 1, noProgressRuns: 0 },
      usage: { tokenUsed: null, costUsed: null },
    },
  });

  it('auto 请求但 decided=new 标注 Fake 新 Session 降级并给出来源引用', () => {
    const view = buildExecutionRecoveryCliView(recovery([{
      attemptId: ATTEMPT_ID,
      taskId: 't-1',
      attemptNumber: 2,
      sourceAttemptId: 'a-src',
      sourceSessionId: 'sess-src',
      requested: { mode: 'auto', kind: 'conversation', nativeArchiveRef: null },
      decided: { mode: 'new', reasons: ['native_resume_unsupported'] },
      handoff: { previousAttemptId: 'a-src', previousStatus: 'interrupted' },
      recordedAt: '2026-10-19T00:00:00.000Z',
    }]));
    expect(view.continuations).toHaveLength(1);
    const entry = view.continuations[0];
    expect(entry).toMatchObject({
      attemptId: ATTEMPT_ID,
      requestedMode: 'auto',
      requestedKind: 'conversation',
      decidedMode: 'new',
    });
    expect(entry.degraded).not.toBeNull();
    expect(entry.degraded?.note).toMatch(/新 Session|新建会话|降级/);
    const human = formatExecutionRecoveryCliView(view);
    expect(human).toMatch(/auto/);
    expect(human).toMatch(/降级|新 Session|新建会话/);
  });

  it('required 请求被拒/无记录与预算未知用量保持显式，不填 0', () => {
    const view = buildExecutionRecoveryCliView(recovery([{
      attemptId: ATTEMPT_ID,
      taskId: 't-1',
      attemptNumber: 3,
      sourceAttemptId: null,
      sourceSessionId: null,
      requested: { mode: 'required', kind: 'checkpoint', nativeArchiveRef: 'art-ckpt' },
      decided: { mode: 'new', reasons: ['required_source_missing'] },
      handoff: null,
      recordedAt: '2026-10-19T00:00:00.000Z',
    }]));
    const entry = view.continuations[0];
    expect(entry.requestedMode).toBe('required');
    expect(entry.degraded).not.toBeNull();
    expect(view.budget.usage).toEqual({ tokenUsed: null, costUsed: null });
    const human = formatExecutionRecoveryCliView(view);
    expect(human).toMatch(/token=unknown/);
  });

  it('无续接记录时输出显式空态与工作流 resume 说明', () => {
    const view = buildExecutionRecoveryCliView(recovery([]));
    expect(view.continuations).toEqual([]);
    expect(formatExecutionRecoveryCliView(view)).toMatch(/无续接记录|无恢复记录/);
  });
});

/* ------------------------------------------------------------------ *
 * 验收 3：帮助区分四种场景
 * ------------------------------------------------------------------ */

describe('F-015 帮助边界文本', () => {
  const help = getAppCliHelp('execution');

  it('execution 总帮助列出控制/收尾/诊断命令与四类边界', () => {
    for (const token of [
      'execution pause',
      'execution resume',
      'execution cancel',
      'execution retry-final',
      'execution control',
      'execution batch-control',
      'execution recovery',
    ]) {
      expect(help, token).toContain(token);
    }
    /* 工作流 resume ≠ Runtime/SDK 原生续接。 */
    expect(help).toMatch(/工作流 resume/);
    expect(help).toMatch(/auto.*new.*required|auto\/new\/required/);
    /* Fake 新 Session 降级。 */
    expect(help).toMatch(/新 Session|新建会话|降级/);
    /* 停止不确定。 */
    expect(help).toMatch(/停止不确定|uncertain/);
    /* 仅收尾重试。 */
    expect(help).toMatch(/仅收尾|收尾重试/);
    /* 不宣称终态。 */
    expect(help).toMatch(/不代表已暂停|不代表已停止|不宣称|未完成/);
  });

  it('子命令帮助可按 scope 获取且包含 revision/目标纪律', () => {
    for (const scope of [
      'execution.pause',
      'execution.resume',
      'execution.retry-final',
      'execution.control',
      'execution.batch-control',
      'execution.recovery',
    ] as const) {
      const text = getAppCliHelp(scope);
      expect(text, scope).toContain('usage:');
      expect(text, scope).toContain('--project');
    }
    expect(getAppCliHelp('execution.pause')).toContain('--revision');
    expect(getAppCliHelp('execution.retry-final')).toMatch(/historical-run|历史 Run/);
  });
});

/* ------------------------------------------------------------------ *
 * 验收 1/2/4：CLI 纵向（runAppCli → HostClient → Host → Core，真实 SQLite/Git/
 * worktree/制品 + 显式 FakeRuntime 测试装配；零模型）
 * ------------------------------------------------------------------ */

describe('F-015 CLI 纵向：控制命令、重复命令、失败退出语义与 follow 退出不取消', () => {
  it('纵向用例见 p03-9-f015-cli-control-vertical.test.ts（真实 Host 分文件）', () => {
    expect(true).toBe(true);
  });
});
