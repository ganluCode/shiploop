/**
 * P03-4 / F-009 调度诊断与 Attempt 审计 CLI 纯面层（参数解析、结构化视图、帮助）。
 *
 * 定位：只测纯函数层（`parseAppCliArgs` / `app/schedule.ts` 视图投影 /
 * `getAppCliHelp`），不接触真实 Host、SQLite、文件或网络：
 * - `execution schedule/attempts/diagnostics` 命令身份与参数映射在解析层可得；
 *   非法 runId/attemptId/taskId、非法分页参数在任何 I/O 之前以稳定 reason 拒绝，
 *   错误不回显参数值；
 * - 结构化视图区分 all_passed 待 Feature 最终验收、Runtime 结果待验证
 *   （verifying）、准备失败（failed+preflight）、审批等待
 *   （waiting_approval/manualBlock）与资源隔离（resource_busy/quarantined）；
 *   accepted、无 ready 或执行文本成功一律不显示为交付成功
 *   （completion.featureVerified/delivered 恒 false）；
 * - 帮助信息说明本 Feature（P03-4）尚无完整执行/验证闭环。
 *
 * 纵向（真实临时 Host + CLI 执行路径）见 `p03-4-cli-schedule-vertical.test.ts`；
 * 正式构建入口验收见 `p03-4-cli-schedule-built.test.ts`。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APP_CLI_COMMAND_IDS,
  AppCliParseError,
  getAppCliHelp,
  parseAppCliArgs,
} from '../../../packages/cli/src/index.ts';
import {
  buildExecutionAttemptsView,
  buildExecutionDiagnosticsView,
  buildExecutionScheduleView,
  formatExecutionAttemptsView,
  formatExecutionDiagnosticsView,
  formatExecutionScheduleView,
} from '../../../packages/cli/src/app/schedule.ts';
import type {
  AttemptDiagnosticsResult,
  AttemptListResult,
  RunScheduleStatusResult,
} from '../../../packages/host/src/index.ts';

const PROJECT_ID = randomUUID();
const FEATURE_ID = randomUUID();
const BATCH_ID = randomUUID();
const RUN_ID = randomUUID();
const ATTEMPT_ID = randomUUID();
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
 * 线形状夹具（HostClient 已校验结果的等价形态；纯投影不改写事实）
 * ------------------------------------------------------------------ */

function scheduleResult(overrides: {
  readonly scheduleReason?: RunScheduleStatusResult['schedule']['reason'];
  readonly diagnostic?: string | null;
  readonly readyTaskIds?: readonly string[];
  readonly handoff?: 'feature_final_verification' | null;
  readonly tasks?: RunScheduleStatusResult['tasks'];
  readonly occupancy?: RunScheduleStatusResult['occupancy'];
} = {}): RunScheduleStatusResult {
  return {
    schemaVersion: 5,
    scope: 'run-schedule',
    run: {
      id: RUN_ID,
      projectId: PROJECT_ID,
      batchId: BATCH_ID,
      featureId: FEATURE_ID,
      purpose: 'execute',
      workKey: 'work-1',
      dispatchOrdinal: 1,
      status: 'queued',
      reason: 'scheduler_not_assembled',
      startedAt: null,
      endedAt: null,
      createdAt: '2026-10-14T00:00:00.000Z',
    },
    schedule: {
      reason: overrides.scheduleReason ?? 'ready',
      diagnostic: overrides.diagnostic ?? null,
      readyTaskIds: overrides.readyTaskIds ?? [TASK_ID],
      handoff: overrides.handoff ?? null,
    },
    tasks:
      overrides.tasks ??
      [
        {
          taskId: TASK_ID,
          status: 'pending',
          reason: 'ready',
          dependencyIds: [],
          executionVersion: 0,
          manualBlock: false,
          latestAttempt: null,
        },
      ],
    occupancy: overrides.occupancy ?? [],
  };
}

function attemptRecord(overrides: Partial<AttemptListResult['records'][number]> = {}): AttemptListResult['records'][number] {
  return {
    id: ATTEMPT_ID,
    projectId: PROJECT_ID,
    featureId: FEATURE_ID,
    runId: RUN_ID,
    taskId: TASK_ID,
    number: 1,
    owner: 'owner-1',
    hostInstanceId: 'host-1',
    executionVersion: 1,
    leaseUntil: '2026-10-14T01:00:00.000Z',
    status: 'executing',
    executionStage: 'runtime',
    inputDigest: DIGEST,
    inputRef: 'artifact://input',
    sessionId: null,
    invocationId: null,
    codeRef: null,
    errorKind: null,
    diagnosticRef: null,
    startedAt: '2026-10-14T00:00:00.000Z',
    endedAt: null,
    durationMs: null,
    exitCode: null,
    usageSummary: null,
    revision: 2,
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:10:00.000Z',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * A. 参数解析（纯；任何 I/O 之前拒绝）
 * ------------------------------------------------------------------ */

describe('F-009 诊断子命令解析（纯面层）', () => {
  it('命令身份注册：execution.schedule/attempts/diagnostics', () => {
    expect(APP_CLI_COMMAND_IDS).toEqual(
      expect.arrayContaining([
        'execution.schedule',
        'execution.attempts',
        'execution.diagnostics',
      ]),
    );
  });

  it('execution schedule <runId> --project <id> 解析为只读查询意图', () => {
    const parsed = parseAppCliArgs(
      ['execution', 'schedule', RUN_ID, '--project', PROJECT_ID],
      {},
    );
    expect(parsed).toMatchObject({
      kind: 'command',
      command: 'execution',
      commandId: 'execution.schedule',
      projectId: PROJECT_ID,
      runId: RUN_ID,
      json: false,
    });
  });

  it('execution attempts <taskId> --project --limit --cursor 解析分页参数', () => {
    const parsed = parseAppCliArgs(
      [
        'execution', 'attempts', TASK_ID, '--project', PROJECT_ID,
        '--limit', '25', '--cursor', 'plcur_v1_abc', '--json',
      ],
      {},
    );
    expect(parsed).toMatchObject({
      kind: 'command',
      commandId: 'execution.attempts',
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      limit: 25,
      cursor: 'plcur_v1_abc',
      json: true,
    });
  });

  it('execution diagnostics <attemptId> --project 解析为诊断审计意图', () => {
    const parsed = parseAppCliArgs(
      ['execution', 'diagnostics', ATTEMPT_ID, '--project', PROJECT_ID],
      {},
    );
    expect(parsed).toMatchObject({
      kind: 'command',
      commandId: 'execution.diagnostics',
      projectId: PROJECT_ID,
      attemptId: ATTEMPT_ID,
    });
  });

  it('非法 ID 在连接前拒绝：runId/attemptId 必须 UUID v4，taskId 必须稳定 ID', () => {
    expectParseError(
      ['execution', 'schedule', 'not-a-uuid', '--project', PROJECT_ID],
      'invalid_run_id',
      'runId',
    );
    expectParseError(
      ['execution', 'diagnostics', 'not-a-uuid', '--project', PROJECT_ID],
      'invalid_attempt_id',
      'attemptId',
    );
    expectParseError(
      ['execution', 'attempts', 'bad id!', '--project', PROJECT_ID],
      'invalid_plan_id',
      'taskId',
    );
    expectParseError(
      ['execution', 'schedule', RUN_ID, '--project', 'not-a-uuid'],
      'invalid_project_id',
      'project',
    );
  });

  it('非法分页参数与未知参数在连接前拒绝（不回显值）', () => {
    expectParseError(
      ['execution', 'attempts', TASK_ID, '--project', PROJECT_ID, '--limit', '0'],
      'invalid_limit',
      'limit',
    );
    expectParseError(
      ['execution', 'attempts', TASK_ID, '--project', PROJECT_ID, '--limit', '201'],
      'invalid_limit',
      'limit',
    );
    expectParseError(
      ['execution', 'diagnostics', ATTEMPT_ID, '--project', PROJECT_ID, '--limit', 'abc'],
      'invalid_limit',
      'limit',
    );
    const unknown = expectParseError(
      ['execution', 'schedule', RUN_ID, '--project', PROJECT_ID, '--watch'],
      'unknown_argument',
    );
    expect(unknown.message).not.toContain('--watch');
  });

  it('缺少位置参数/--project 与多余位置参数拒绝', () => {
    expectParseError(['execution', 'schedule'], 'missing_positional', 'runId');
    expectParseError(
      ['execution', 'schedule', RUN_ID],
      'missing_required_option',
      'project',
    );
    expectParseError(
      ['execution', 'attempts', TASK_ID, 'extra', '--project', PROJECT_ID],
      'too_many_positionals',
    );
  });
});

/* ------------------------------------------------------------------ *
 * B. execution.schedule 结构化视图（就绪分类与不交付边界）
 * ------------------------------------------------------------------ */

describe('F-009 execution.schedule 结构化视图', () => {
  it('ready：稳定候选原样展示；completion 不声明验收/交付', () => {
    const view = buildExecutionScheduleView(scheduleResult());
    expect(view.operation).toBe('execution.run.schedule');
    expect(view.readiness.state).toBe('ready');
    expect(view.readiness.readyTaskIds).toEqual([TASK_ID]);
    expect(view.readiness.allPassedPendingFinalVerification).toBe(false);
    expect(view.completion).toMatchObject({ featureVerified: false, delivered: false });
    expect(view.completion.note).toContain('尚无完整执行/验证闭环');
  });

  it('all_passed + handoff：仅待 Feature 最终验收，不是交付成功', () => {
    const view = buildExecutionScheduleView(
      scheduleResult({
        scheduleReason: 'all_passed',
        readyTaskIds: [],
        handoff: 'feature_final_verification',
        tasks: [
          {
            taskId: TASK_ID,
            status: 'passed',
            reason: 'all_passed',
            dependencyIds: [],
            executionVersion: 3,
            manualBlock: false,
            latestAttempt: {
              id: ATTEMPT_ID,
              number: 2,
              status: 'succeeded',
              executionStage: 'cleanup',
              exitCode: 0,
              durationMs: 1200,
              startedAt: '2026-10-14T00:00:00.000Z',
              endedAt: '2026-10-14T00:01:00.000Z',
              errorKind: null,
            },
          },
        ],
      }),
    );
    expect(view.readiness.state).toBe('awaiting_feature_final_verification');
    expect(view.readiness.allPassedPendingFinalVerification).toBe(true);
    expect(view.completion.featureVerified).toBe(false);
    expect(view.completion.delivered).toBe(false);
    // 执行文本成功（exitCode=0）不折算为交付：人类行保持边界说明。
    const human = formatExecutionScheduleView(view);
    expect(human).toContain('readiness=awaiting_feature_final_verification');
    expect(human).toContain('不代表交付成功');
  });

  it('Runtime 结果待验证/准备失败/审批等待/资源隔离逐任务分类', () => {
    const view = buildExecutionScheduleView(
      scheduleResult({
        scheduleReason: 'resource_busy',
        readyTaskIds: [],
        tasks: [
          {
            taskId: 't-1',
            status: 'running',
            reason: 'resource_busy',
            dependencyIds: [],
            executionVersion: 1,
            manualBlock: false,
            latestAttempt: {
              id: ATTEMPT_ID,
              number: 1,
              status: 'verifying',
              executionStage: 'verification',
              exitCode: null,
              durationMs: null,
              startedAt: '2026-10-14T00:00:00.000Z',
              endedAt: null,
              errorKind: null,
            },
          },
          {
            taskId: 't-2',
            status: 'failed',
            reason: 'dependency_pending',
            dependencyIds: ['t-1'],
            executionVersion: 0,
            manualBlock: true,
            latestAttempt: {
              id: randomUUID(),
              number: 1,
              status: 'failed',
              executionStage: 'preflight',
              exitCode: null,
              durationMs: null,
              startedAt: null,
              endedAt: null,
              errorKind: 'input_prepare_failed',
            },
          },
        ],
        occupancy: [
          {
            id: 'lease-1',
            attemptId: ATTEMPT_ID,
            runId: RUN_ID,
            resourceKind: 'workspace',
            resourceKey: 'workspace:'.concat('b'.repeat(64)),
            state: 'quarantined',
            leaseUntil: '2026-10-14T02:00:00.000Z',
            processIdentity: true,
          },
          {
            id: 'lease-2',
            attemptId: ATTEMPT_ID,
            runId: RUN_ID,
            resourceKind: 'project',
            resourceKey: `project:${PROJECT_ID}:work`,
            state: 'held',
            leaseUntil: '2026-10-14T02:00:00.000Z',
            processIdentity: false,
          },
        ],
      }),
    );
    expect(view.readiness.state).toBe('blocked');
    expect(view.readiness.runtimeResultPendingVerificationTaskIds).toEqual(['t-1']);
    expect(view.readiness.preparationFailedTaskIds).toEqual(['t-2']);
    expect(view.readiness.waitingApprovalTaskIds).toEqual(['t-2']);
    expect(view.readiness.resourceBusyTaskIds).toEqual(['t-1']);
    expect(view.readiness.quarantinedResourceKeys).toHaveLength(1);
    expect(view.readiness.heldResourceKeys).toEqual([`project:${PROJECT_ID}:work`]);
    expect(view.completion).toMatchObject({ featureVerified: false, delivered: false });
  });

  it('waiting_approval 原因与 invalid_graph 降级', () => {
    const approval = buildExecutionScheduleView(
      scheduleResult({
        scheduleReason: 'waiting_approval',
        readyTaskIds: [],
        tasks: [
          {
            taskId: TASK_ID,
            status: 'pending',
            reason: 'waiting_approval',
            dependencyIds: [],
            executionVersion: 0,
            manualBlock: false,
            latestAttempt: null,
          },
        ],
      }),
    );
    expect(approval.readiness.state).toBe('blocked');
    expect(approval.readiness.waitingApprovalTaskIds).toEqual([TASK_ID]);

    const corrupt = buildExecutionScheduleView(
      scheduleResult({
        scheduleReason: 'invalid_graph',
        diagnostic: 'corrupt_persisted_view',
        readyTaskIds: [],
        tasks: [],
      }),
    );
    expect(corrupt.readiness.state).toBe('invalid_graph');
    expect(corrupt.readiness.readyTaskIds).toEqual([]);
    expect(corrupt.schedule.diagnostic).toBe('corrupt_persisted_view');
  });
});

/* ------------------------------------------------------------------ *
 * C. execution.attempts / execution.diagnostics 结构化视图
 * ------------------------------------------------------------------ */

describe('F-009 Attempt 审计与诊断视图', () => {
  it('attempts：归属/围栏身份/阶段原样展示；verifying 标为 Runtime 结果待验证', () => {
    const view = buildExecutionAttemptsView({
      schemaVersion: 5,
      scope: 'attempt-list',
      records: [
        attemptRecord({ status: 'verifying', executionStage: 'verification' }),
        attemptRecord({
          id: randomUUID(),
          number: 2,
          status: 'failed',
          executionStage: 'preflight',
          errorKind: 'input_prepare_failed',
        }),
        attemptRecord({ id: randomUUID(), number: 3, status: 'succeeded', executionStage: 'cleanup', exitCode: 0 }),
      ],
      nextCursor: 'plcur_v1_next',
      limit: 50,
    });
    expect(view.operation).toBe('execution.attempts.list');
    expect(view.projectId).toBe(PROJECT_ID);
    expect(view.taskId).toBe(TASK_ID);
    expect(view.records).toHaveLength(3);
    expect(view.records[0]?.classification).toMatchObject({
      runtimeResultPendingVerification: true,
      preparationFailed: false,
    });
    expect(view.records[1]?.classification.preparationFailed).toBe(true);
    // succeeded 只是 Attempt 级完成：不折算验收/交付。
    expect(view.records[2]?.classification.attemptSucceeded).toBe(true);
    expect(view.completion).toMatchObject({ featureVerified: false, delivered: false });
    const human = formatExecutionAttemptsView(view);
    expect(human).toContain(`attempt=${ATTEMPT_ID}#1`);
    expect(human).toContain(`run=${RUN_ID}`);
    expect(human).toContain('executionVersion=1');
    expect(human).toContain('runtime_result_pending_verification');
    expect(human).toContain('preparation_failed');
    expect(human).toContain('exit=unknown');
    expect(human).toContain('不代表交付成功');
  });

  it('diagnostics：固定原因/摘要/时间原样展示，分页游标透传', () => {
    const result: AttemptDiagnosticsResult = {
      schemaVersion: 5,
      scope: 'attempt-diagnostic-list',
      records: [
        {
          id: randomUUID(),
          projectId: PROJECT_ID,
          attemptId: ATTEMPT_ID,
          notificationDigest: DIGEST,
          reason: 'stale_execution_identity',
          occurredAt: '2026-10-14T00:05:00.000Z',
        },
      ],
      nextCursor: null,
      limit: 50,
    };
    const view = buildExecutionDiagnosticsView(result);
    expect(view.operation).toBe('execution.attempt.diagnostics');
    expect(view.records).toHaveLength(1);
    expect(view.records[0]?.reason).toBe('stale_execution_identity');
    expect(view.completion).toMatchObject({ featureVerified: false, delivered: false });
    const human = formatExecutionDiagnosticsView(view);
    expect(human).toContain(`attempt=${ATTEMPT_ID}`);
    expect(human).toContain('stale_execution_identity');
    expect(human).not.toContain(PROJECT_ID.concat('-secret'));
  });
});

/* ------------------------------------------------------------------ *
 * D. 帮助（本 Feature 尚无完整执行/验证闭环）
 * ------------------------------------------------------------------ */

describe('F-009 帮助边界', () => {
  it('execution 总帮助列出诊断子命令并声明无完整执行/验证闭环', () => {
    const help = getAppCliHelp('execution');
    expect(help).toContain('execution schedule <runId>');
    expect(help).toContain('execution attempts <taskId>');
    expect(help).toContain('execution diagnostics <attemptId>');
    expect(help).toContain('尚无完整执行/验证闭环');
    expect(help).toContain('不认领、不扣预算、不启动 Runtime');
  });

  it('各诊断子命令帮助说明只读边界与不交付纪律', () => {
    for (const scope of [
      'execution.schedule',
      'execution.attempts',
      'execution.diagnostics',
    ] as const) {
      const help = getAppCliHelp(scope);
      expect(help).toContain('只读');
      expect(help).toContain('尚无完整执行/验证闭环');
      expect(help).toContain('退出码');
    }
    expect(getAppCliHelp('execution.schedule')).toContain('all_passed');
    expect(getAppCliHelp('execution.attempts')).toContain('verifying');
    expect(getAppCliHelp('execution.diagnostics')).toContain('stale_execution_identity');
  });
});
