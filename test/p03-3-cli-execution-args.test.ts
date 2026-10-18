/**
 * P03-3 / F-012 执行授权 CLI 纯面层（参数映射、预算输入校验与结构化输出）。
 *
 * 定位：只测纯函数层（`parseAppCliArgs` / `app/execution.ts` 预算文档解析与
 * 结果视图 / `getAppCliHelp`），不接触真实 Host、SQLite、文件或网络：
 * - `execution preview/start/budget/revise` 命令身份与参数映射在解析层可得；
 *   固定单 Feature、完整有限预算、commandId、previewDigest 一一映射到既有
 *   HostClient 输入（不发请求由纵向用例复核）；
 * - 参数校验覆盖缺少预算、非法日期/整数、有效并发大于一、冲突参数与缺失
 *   确认：全部在任何 I/O 之前以稳定 reason 拒绝，错误不回显参数值；
 * - 结构化输出区分 accepted、尚未执行、预算耗尽与业务完成，显示真实
 *   Batch/Run ID 与剩余额度；accepted 的提交成功输出/退出码不被描述为
 *   Feature 已验收通过；
 * - 预览不是授权、prepare 不升级为授权：帮助与视图保持未执行边界事实。
 *
 * 纵向（真实临时 Host + CLI）见 `p03-3-cli-execution-vertical.test.ts`。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APP_CLI_COMMANDS,
  APP_CLI_COMMAND_IDS,
  AppCliParseError,
  getAppCliHelp,
  parseAppCliArgs,
} from '../packages/cli/src/index.ts';
import {
  buildExecutionBudgetView,
  buildExecutionPreviewView,
  buildExecutionReviseView,
  buildExecutionStartView,
  deriveExecutionState,
  formatExecutionBudgetView,
  formatExecutionPreviewView,
  formatExecutionReviseView,
  formatExecutionStartView,
  parseExecutionBudgetDocument,
} from '../packages/cli/src/app/execution.ts';
import type {
  ExecutionBudgetStatusResult,
  BudgetRevisionListResult,
  ExecutionPreviewResult,
} from '../packages/host/src/index.ts';

const PROJECT_ID = randomUUID();
const FEATURE_ID = randomUUID();
const BATCH_ID = randomUUID();
const COMMAND_ID = randomUUID();
const DIGEST = 'a'.repeat(64);
const SECRET_VALUE = 'sk-never-echo-please';

const DEADLINE_ISO = '2099-06-01T00:00:00.000Z';
const DEADLINE_MS = Date.parse(DEADLINE_ISO);
const HOUR_MS = 3_600_000;

function budgetDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    batch: {
      maxRuns: 2,
      maxTotalAttempts: 4,
      maxRuntimeStarts: 3,
      maxNoProgressRuns: 2,
      deadlineUtcMs: DEADLINE_ISO,
    },
    run: { maxAttemptsPerRun: 2, runTimeLimitMs: HOUR_MS },
    ...overrides,
  };
}

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
    const parsed = error as AppCliParseError;
    expect(parsed.code).toBe('invalid_input');
    expect(parsed.reason).toBe(reason);
    if (field !== undefined) {
      expect(parsed.field).toBe(field);
    }
    expect(parsed.message).not.toContain(PROJECT_ID);
    expect(parsed.message).not.toContain(BATCH_ID);
    expect(parsed.message).not.toContain(SECRET_VALUE);
    return parsed;
  }
  throw new Error(`expected parse error ${reason} for args ${JSON.stringify(args)}`);
}

function expectBudgetError(
  value: Record<string, unknown>,
  reason: string,
  field?: string,
): AppCliParseError {
  try {
    parseExecutionBudgetDocument(value, {
      command: 'execution',
      commandId: 'execution.start',
      json: true,
    });
  } catch (error) {
    expect(error, `expected budget parse error ${reason}`).toBeInstanceOf(AppCliParseError);
    const parsed = error as AppCliParseError;
    expect(parsed.code).toBe('invalid_input');
    expect(parsed.reason).toBe(reason);
    if (field !== undefined) {
      expect(parsed.field).toBe(field);
    }
    expect(parsed.message).not.toContain(SECRET_VALUE);
    return parsed;
  }
  throw new Error(`expected budget parse error ${reason}`);
}

/* ------------------------------------------------------------------ *
 * 命令面与参数映射
 * ------------------------------------------------------------------ */

describe('F-012 执行授权命令面（execution preview/start/budget/revise）', () => {
  it('命令身份齐全、唯一、形态沿用点分 CLI 路径；不新增 run/work 顶层命令', () => {
    for (const id of [
      'execution.preview',
      'execution.start',
      'execution.budget',
      'execution.revise',
    ] as const) {
      expect([...APP_CLI_COMMAND_IDS]).toContain(id);
    }
    expect(new Set(APP_CLI_COMMAND_IDS).size).toBe(APP_CLI_COMMAND_IDS.length);
    expect([...APP_CLI_COMMANDS]).toContain('execution');
    expect([...APP_CLI_COMMANDS]).not.toContain('run');
    expect([...APP_CLI_COMMANDS]).not.toContain('work');
    for (const id of APP_CLI_COMMAND_IDS) {
      expect(id).toMatch(
        /^(project|config|receipt|events|baseline|phase|feature|task|execution|workspace|git)\.[a-z-]+$/,
      );
    }
  });

  it('execution preview：固定单 Feature、完整预算文件、可选 commandId 在解析层可得', () => {
    const parsed = parseAppCliArgs([
      'execution', 'preview', FEATURE_ID,
      '--project', PROJECT_ID,
      '--input', 'budget.json',
      '--command-id', COMMAND_ID,
    ]);
    expect(parsed).toMatchObject({
      kind: 'command',
      commandId: 'execution.preview',
      operation: 'execution.preview',
      projectId: PROJECT_ID,
      featureId: FEATURE_ID,
      inputFile: 'budget.json',
      explicitCommandId: COMMAND_ID,
    });
  });

  it('execution start：明确确认 + previewDigest 的新授权形态可得', () => {
    const parsed = parseAppCliArgs([
      'execution', 'start', FEATURE_ID,
      '--project', PROJECT_ID,
      '--input', 'budget.json',
      '--preview-digest', DIGEST,
      '--confirm',
      '--command-id', COMMAND_ID,
    ]);
    expect(parsed).toMatchObject({
      commandId: 'execution.start',
      operation: 'execution.start',
      projectId: PROJECT_ID,
      featureId: FEATURE_ID,
      inputFile: 'budget.json',
      previewDigest: DIGEST,
      confirm: true,
      explicitCommandId: COMMAND_ID,
    });
  });

  it('execution start：同父 Batch 显式重试形态（--retry-batch）可得', () => {
    const parsed = parseAppCliArgs([
      'execution', 'start', FEATURE_ID,
      '--project', PROJECT_ID,
      '--retry-batch', BATCH_ID,
      '--confirm',
    ]);
    expect(parsed).toMatchObject({
      commandId: 'execution.start',
      retryBatchId: BATCH_ID,
      confirm: true,
    });
  });

  it('execution budget：Batch 预算状态与修订历史查询（可选分页）在解析层可得', () => {
    const parsed = parseAppCliArgs([
      'execution', 'budget', BATCH_ID,
      '--project', PROJECT_ID,
      '--limit', '10',
      '--cursor', 'plcur_v1_x',
    ]);
    expect(parsed).toMatchObject({
      commandId: 'execution.budget',
      projectId: PROJECT_ID,
      batchId: BATCH_ID,
      limit: 10,
      cursor: 'plcur_v1_x',
    });
  });

  it('execution revise：expectedRevision 与理由必填、预算文件在解析层可得', () => {
    const parsed = parseAppCliArgs([
      'execution', 'revise', BATCH_ID,
      '--project', PROJECT_ID,
      '--revision', '2',
      '--reason', '扩大执行预算',
      '--input', 'budget.json',
    ]);
    expect(parsed).toMatchObject({
      commandId: 'execution.revise',
      operation: 'execution.budget.revise',
      projectId: PROJECT_ID,
      batchId: BATCH_ID,
      revision: 2,
      reason: '扩大执行预算',
      inputFile: 'budget.json',
    });
  });
});

/* ------------------------------------------------------------------ *
 * 参数校验（输入错误在任何 I/O 之前拒绝；纵向复核不发请求）
 * ------------------------------------------------------------------ */

describe('F-012 执行授权参数校验（缺少预算/非法日期与整数/有效并发/冲突参数/缺失确认）', () => {
  it('缺少预算（缺 --input 或预算字段不全）→ missing_budget', () => {
    expectParseError(
      ['execution', 'preview', FEATURE_ID, '--project', PROJECT_ID],
      'missing_budget',
    );
    expectParseError(
      ['execution', 'start', FEATURE_ID, '--project', PROJECT_ID, '--preview-digest', DIGEST, '--confirm'],
      'missing_budget',
    );
    expectParseError(
      ['execution', 'revise', BATCH_ID, '--project', PROJECT_ID, '--revision', '1', '--reason', 'x'],
      'missing_budget',
    );
    expectBudgetError({ run: { maxAttemptsPerRun: 2, runTimeLimitMs: HOUR_MS } }, 'missing_budget', 'batch');
    expectBudgetError(
      budgetDocument({ batch: { maxRuns: 2 } }),
      'missing_budget',
    );
  });

  it('非法日期（deadline 非 epoch 毫秒整数/非 ISO-8601 UTC）→ invalid_budget_date', () => {
    expectBudgetError(
      budgetDocument({ batch: { maxRuns: 2, maxTotalAttempts: 4, maxRuntimeStarts: 3, maxNoProgressRuns: 2, deadlineUtcMs: 'not-a-date' } }),
      'invalid_budget_date',
      'batch.deadlineUtcMs',
    );
    expectBudgetError(
      budgetDocument({ batch: { maxRuns: 2, maxTotalAttempts: 4, maxRuntimeStarts: 3, maxNoProgressRuns: 2, deadlineUtcMs: '2026-13-45T00:00:00Z' } }),
      'invalid_budget_date',
      'batch.deadlineUtcMs',
    );
    expectBudgetError(
      budgetDocument({ batch: { maxRuns: 2, maxTotalAttempts: 4, maxRuntimeStarts: 3, maxNoProgressRuns: 2, deadlineUtcMs: 0 } }),
      'invalid_budget_date',
      'batch.deadlineUtcMs',
    );
  });

  it('非法整数/越界（计数与上限）→ invalid_integer / integer_out_of_range', () => {
    expectBudgetError(
      budgetDocument({ batch: { maxRuns: 1.5, maxTotalAttempts: 4, maxRuntimeStarts: 3, maxNoProgressRuns: 2, deadlineUtcMs: DEADLINE_ISO } }),
      'invalid_integer',
      'batch.maxRuns',
    );
    expectBudgetError(
      budgetDocument({ run: { maxAttemptsPerRun: '2', runTimeLimitMs: HOUR_MS } }),
      'invalid_integer',
      'run.maxAttemptsPerRun',
    );
    expectBudgetError(
      budgetDocument({ run: { maxAttemptsPerRun: 0, runTimeLimitMs: HOUR_MS } }),
      'integer_out_of_range',
      'run.maxAttemptsPerRun',
    );
    expectBudgetError(
      budgetDocument({ run: { maxAttemptsPerRun: 2, runTimeLimitMs: 10 } }),
      'integer_out_of_range',
      'run.runTimeLimitMs',
    );
  });

  it('有效并发大于一 → concurrency_not_supported（本版本单并发）', () => {
    expectBudgetError(
      budgetDocument({ concurrency: { maxConcurrentWorks: 2 } }),
      'concurrency_not_supported',
      'concurrency.maxConcurrentWorks',
    );
    expectBudgetError(
      budgetDocument({ concurrency: { maxConcurrentWorks: 1.5 } }),
      'invalid_integer',
      'concurrency.maxConcurrentWorks',
    );
  });

  it('冲突参数（重试形态与新授权预算/预览摘要同现）→ conflicting_options', () => {
    expectParseError(
      ['execution', 'start', FEATURE_ID, '--project', PROJECT_ID, '--retry-batch', BATCH_ID, '--input', 'budget.json', '--confirm'],
      'conflicting_options',
    );
    expectParseError(
      ['execution', 'start', FEATURE_ID, '--project', PROJECT_ID, '--retry-batch', BATCH_ID, '--preview-digest', DIGEST, '--confirm'],
      'conflicting_options',
    );
  });

  it('缺失确认（start 无 --confirm）→ confirmation_required', () => {
    expectParseError(
      ['execution', 'start', FEATURE_ID, '--project', PROJECT_ID, '--input', 'budget.json', '--preview-digest', DIGEST],
      'confirmation_required',
      'confirm',
    );
    expectParseError(
      ['execution', 'start', FEATURE_ID, '--project', PROJECT_ID, '--retry-batch', BATCH_ID],
      'confirmation_required',
      'confirm',
    );
  });

  it('非法 previewDigest/未知预算键/形态错误均稳定拒绝且不回显值', () => {
    expectParseError(
      ['execution', 'start', FEATURE_ID, '--project', PROJECT_ID, '--input', 'budget.json', '--preview-digest', 'zz', '--confirm'],
      'invalid_preview_digest',
      'preview-digest',
    );
    expectBudgetError(
      budgetDocument({ batch: { maxRuns: 2, maxTotalAttempts: 4, maxRuntimeStarts: 3, maxNoProgressRuns: 2, deadlineUtcMs: DEADLINE_ISO, [SECRET_VALUE]: 1 } }),
      'unknown_input_field',
    );
    expectBudgetError({ batch: [], run: { maxAttemptsPerRun: 2, runTimeLimitMs: HOUR_MS } }, 'invalid_budget', 'batch');
    expectBudgetError(budgetDocument({ surprise: true }), 'unknown_input_field');
  });
});

/* ------------------------------------------------------------------ *
 * 预算参数映射（用户输入 → HostClient 完整有限预算）
 * ------------------------------------------------------------------ */

describe('F-012 完整有限预算参数映射', () => {
  it('ISO-8601 UTC 日期映射为 epoch 毫秒整数；整数原样通过', () => {
    const mapped = parseExecutionBudgetDocument(budgetDocument(), {
      command: 'execution',
      commandId: 'execution.preview',
    });
    expect(mapped).toEqual({
      batch: {
        maxRuns: 2,
        maxTotalAttempts: 4,
        maxRuntimeStarts: 3,
        maxNoProgressRuns: 2,
        deadlineUtcMs: DEADLINE_MS,
      },
      run: { maxAttemptsPerRun: 2, runTimeLimitMs: HOUR_MS },
    });
    const integerDeadline = parseExecutionBudgetDocument(
      budgetDocument({ batch: { maxRuns: 2, maxTotalAttempts: 4, maxRuntimeStarts: 3, maxNoProgressRuns: 2, deadlineUtcMs: DEADLINE_MS } }),
      { command: 'execution', commandId: 'execution.preview' },
    );
    expect(integerDeadline.batch.deadlineUtcMs).toBe(DEADLINE_MS);
  });

  it('可选资源总额上限透传；concurrency=1 与缺省均接受且不进入 budget 请求体', () => {
    const mapped = parseExecutionBudgetDocument(
      budgetDocument({
        batch: {
          maxRuns: 2,
          maxTotalAttempts: 4,
          maxRuntimeStarts: 3,
          maxNoProgressRuns: 2,
          deadlineUtcMs: DEADLINE_ISO,
          maxTokenTotal: 1000,
          maxCostTotal: 12.5,
        },
        concurrency: { maxConcurrentWorks: 1 },
      }),
      { command: 'execution', commandId: 'execution.preview' },
    );
    expect(mapped.batch).toEqual({
      maxRuns: 2,
      maxTotalAttempts: 4,
      maxRuntimeStarts: 3,
      maxNoProgressRuns: 2,
      deadlineUtcMs: DEADLINE_MS,
      maxTokenTotal: 1000,
      maxCostTotal: 12.5,
    });
    expect(Object.hasOwn(mapped, 'concurrency')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 结构化输出（accepted / 尚未执行 / 预算耗尽 / 业务完成）
 * ------------------------------------------------------------------ */

const SUMMARY = {
  approval: { planDigest: DIGEST, checkPolicyDigest: DIGEST, decisionId: randomUUID() },
  plan: { planDigest: DIGEST, taskCount: 2, pendingTaskIds: ['t-1', 't-2'] },
  code: { headCommit: 'a'.repeat(40), workingTreeDigest: DIGEST, hasUncommittedChanges: false },
  checkPolicyDigest: DIGEST,
  tasks: [
    { taskId: 't-1', status: 'pending', strategyCopyDigest: DIGEST, strategyConfigSource: 'project' },
    { taskId: 't-2', status: 'pending', strategyCopyDigest: DIGEST, strategyConfigSource: 'project' },
  ],
  permissions: { tasks: [{ taskId: 't-1', digest: DIGEST }] },
  inputs: { refs: [] },
  budget: {
    batch: { maxRuns: 2, maxTotalAttempts: 4, maxRuntimeStarts: 3, maxNoProgressRuns: 2, deadlineUtcMs: DEADLINE_MS },
    run: { maxAttemptsPerRun: 2, runTimeLimitMs: HOUR_MS },
  },
  concurrency: { maxConcurrentWorks: 1, source: 'default' },
};

function previewResult(overrides: Record<string, unknown> = {}): ExecutionPreviewResult {
  return {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    scope: { featureIds: [FEATURE_ID] },
    status: 'ready',
    noWorkReason: null,
    blocked: [],
    previewDigest: DIGEST,
    summary: SUMMARY,
    runtimeExecution: false,
    generatedAtUtcMs: 1_900_000_000_000,
    ...overrides,
  } as unknown as ExecutionPreviewResult;
}

function budgetStatus(overrides: {
  readonly taskStatus?: string;
  readonly runStarted?: boolean;
  readonly exhausted?: boolean;
  readonly blockingReasons?: readonly unknown[];
} = {}): ExecutionBudgetStatusResult {
  return {
    schemaVersion: 1,
    scope: 'execution-budget',
    batch: {
      id: BATCH_ID,
      projectId: PROJECT_ID,
      phaseId: 'phase-1',
      featureId: FEATURE_ID,
      featureIds: [FEATURE_ID],
      status: 'active',
      budgetRevision: 1,
      budget: {
        schemaVersion: 1,
        batch: { maxRuns: 2, maxTotalAttempts: 4, maxRuntimeStarts: 3, maxNoProgressRuns: 2, deadlineUtcMs: DEADLINE_MS },
        run: { maxAttemptsPerRun: 2, runTimeLimitMs: HOUR_MS },
      },
      deadlineAtUtcMs: DEADLINE_MS,
      dimensions: {
        maxRuns: { limit: 2, used: 1, remaining: 1, exhausted: false },
        maxTotalAttempts: { limit: 4, used: 0, remaining: 4, exhausted: false },
        maxRuntimeStarts: { limit: 3, used: 0, remaining: 3, exhausted: false },
        maxNoProgressRuns: { limit: 2, used: 0, remaining: 2, exhausted: false },
        deadlineUtcMs: {
          limit: DEADLINE_MS,
          used: 1_900_000_000_000,
          remaining: DEADLINE_MS - 1_900_000_000_000,
          exhausted: overrides.exhausted === true,
        },
      },
      unconfirmedDimensions: [],
      runtimeStartsReserved: 0,
      usage: { tokenUsed: null, costUsed: null },
      reason: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    runs: [
      {
        id: randomUUID(),
        batchId: BATCH_ID,
        featureId: FEATURE_ID,
        purpose: 'execute',
        workKey: 'work-key',
        dispatchOrdinal: 1,
        status: 'queued',
        limits: { maxAttemptsPerRun: 2, runTimeLimitMs: HOUR_MS },
        dimensions: {
          maxAttemptsPerRun: { limit: 2, used: 0, remaining: 2, exhausted: false },
          runTimeLimitMs: { limit: HOUR_MS, used: null, remaining: null, exhausted: null },
        },
        attemptsCreated: 0,
        startedAt: overrides.runStarted === true ? '2026-01-01T00:01:00.000Z' : null,
        endedAt: null,
        elapsedMs: null,
        reason: 'scheduler_not_assembled',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    tasks: [
      {
        taskId: 't-1',
        status: overrides.taskStatus ?? 'pending',
        firstPassedAt: overrides.taskStatus === 'passed' ? '2026-01-01T00:02:00.000Z' : null,
        attempts: { used: 0, limit: 4, remaining: 4 },
        codeAttempts: { used: 0, limit: 3, remaining: 3 },
        caps: {
          maxCodeAttempts: 3,
          maxAttemptsPerTask: 4,
          effectiveMaxCodeAttempts: 3,
          rule: 'code_cap_binds',
        },
      },
    ],
    blockingReasons: overrides.blockingReasons ?? [],
  } as unknown as ExecutionBudgetStatusResult;
}

const REVISIONS: BudgetRevisionListResult = {
  schemaVersion: 1,
  scope: 'budget-revision-list',
  records: [
    {
      id: randomUUID(),
      batchId: BATCH_ID,
      version: 1,
      budget: {
        schemaVersion: 1,
        batch: { maxRuns: 2, maxTotalAttempts: 4, maxRuntimeStarts: 3, maxNoProgressRuns: 2, deadlineUtcMs: DEADLINE_MS },
        run: { maxAttemptsPerRun: 2, runTimeLimitMs: HOUR_MS },
      },
      deadlineAtUtcMs: DEADLINE_MS,
      approvedBy: 'principal-1',
      reason: 'initial_authorization',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  nextCursor: null,
  limit: 50,
} as unknown as BudgetRevisionListResult;

describe('F-012 结构化输出（区分 accepted/尚未执行/预算耗尽/业务完成）', () => {
  it('预览输出：ready 显示 previewDigest 与摘要，且明确预览不是授权、未启动执行', () => {
    const view = buildExecutionPreviewView(COMMAND_ID, false, previewResult());
    expect(view).toMatchObject({
      commandId: COMMAND_ID,
      replayed: false,
      operation: 'execution.preview',
      status: 'ready',
      previewDigest: DIGEST,
      authorization: { confirmed: false },
      execution: { started: false, runtimeExecution: false },
    });
    expect(view.summary).not.toBeNull();
    const human = formatExecutionPreviewView(view);
    expect(human).toContain(DIGEST);
    expect(human).toContain('不是授权');
  });

  it('预览输出：no_work 与 blocked 携带稳定原因，不虚构摘要', () => {
    const noWork = buildExecutionPreviewView(
      COMMAND_ID,
      false,
      previewResult({ status: 'no_work', noWorkReason: 'no_pending_tasks', previewDigest: null, summary: null }),
    );
    expect(noWork).toMatchObject({ status: 'no_work', noWorkReason: 'no_pending_tasks', previewDigest: null, summary: null });
    const blocked = buildExecutionPreviewView(
      COMMAND_ID,
      false,
      previewResult({
        status: 'blocked',
        previewDigest: null,
        summary: null,
        blocked: [{ kind: 'active_run', runId: randomUUID(), status: 'queued' }],
      }),
    );
    expect(blocked.status).toBe('blocked');
    expect(blocked.blocked).toHaveLength(1);
    expect(formatExecutionPreviewView(blocked)).toContain('active_run');
  });

  it('启动输出：accepted 显示真实 Batch/Run ID，提交成功输出不被描述为 Feature 已验收通过', () => {
    const runId = randomUUID();
    const view = buildExecutionStartView(
      {
        commandId: COMMAND_ID,
        replayed: false,
        featureIds: [FEATURE_ID],
        previewDigest: DIGEST,
        retryBatchId: null,
      },
      { operationId: BATCH_ID, batchId: BATCH_ID, runId },
    );
    expect(view).toMatchObject({
      status: 'accepted',
      executionState: 'accepted',
      batchId: BATCH_ID,
      runId,
      operationId: BATCH_ID,
      authorization: { confirmed: true, previewDigest: DIGEST, retryBatchId: null },
      completion: { featureVerified: false, businessCompleted: false },
    });
    const human = formatExecutionStartView(view);
    expect(human).toContain(BATCH_ID);
    expect(human).toContain(runId);
    expect(human).toContain('accepted');
    expect(human).not.toContain('已验收通过');
    expect(human).toMatch(/未(执行|验收)|不代表/);
  });

  it('预算查询输出：四态区分、真实 Batch/Run ID 与剩余额度，未知用量保持 null 不填零', () => {
    const notExecuted = buildExecutionBudgetView(budgetStatus(), REVISIONS);
    expect(notExecuted.executionState).toBe('not_executed');
    expect(notExecuted.states).toEqual({
      accepted: true,
      notExecuted: true,
      budgetExhausted: false,
      businessCompleted: false,
    });
    expect(notExecuted.budget.batch.id).toBe(BATCH_ID);
    expect(notExecuted.budget.runs[0]?.id).toBeTypeOf('string');
    expect(notExecuted.budget.batch.dimensions.maxRuns).toEqual({ limit: 2, used: 1, remaining: 1, exhausted: false });
    expect(notExecuted.budget.batch.usage).toEqual({ tokenUsed: null, costUsed: null });
    expect(notExecuted.revisions.records).toHaveLength(1);

    const exhausted = buildExecutionBudgetView(
      budgetStatus({
        exhausted: true,
        blockingReasons: [{ layer: 'batch', layerId: BATCH_ID, reason: 'budget_exhausted', dimension: 'maxRuns', limit: 1, used: 1 }],
      }),
      REVISIONS,
    );
    expect(exhausted.executionState).toBe('budget_exhausted');
    expect(exhausted.states.budgetExhausted).toBe(true);
    expect(formatExecutionBudgetView(exhausted)).toContain('budget_exhausted');

    const completed = buildExecutionBudgetView(budgetStatus({ taskStatus: 'passed', runStarted: true }), REVISIONS);
    expect(completed.executionState).toBe('business_completed');
    expect(completed.states.businessCompleted).toBe(true);

    const accepted = buildExecutionBudgetView(budgetStatus({ runStarted: true, taskStatus: 'in_progress' }), REVISIONS);
    expect(accepted.executionState).toBe('accepted');
    expect(accepted.states).toMatchObject({ notExecuted: false, businessCompleted: false });

    expect(deriveExecutionState(budgetStatus()).states.notExecuted).toBe(true);
  });

  it('预算修订输出：显示 Batch 身份、budgetRevision 与前后快照（修订需 expectedRevision 与理由）', () => {
    const view = buildExecutionReviseView(COMMAND_ID, true, {
      schemaVersion: 1,
      batchId: BATCH_ID,
      budgetRevision: 2,
      approvedBy: 'principal-1',
      reason: '扩大执行预算',
      revisedAt: '2026-01-01T00:03:00.000Z',
      previous: {
        version: 1,
        budget: { schemaVersion: 1, batch: {}, run: {} },
        deadlineAtUtcMs: DEADLINE_MS,
      },
      revised: {
        version: 2,
        budget: { schemaVersion: 1, batch: {}, run: {} },
        deadlineAtUtcMs: DEADLINE_MS,
      },
    });
    expect(view).toMatchObject({
      replayed: true,
      operation: 'execution.budget.revise',
      batchId: BATCH_ID,
      budgetRevision: 2,
      reason: '扩大执行预算',
    });
    expect(view.previous.version).toBe(1);
    expect(view.revised.version).toBe(2);
    const human = formatExecutionReviseView(view);
    expect(human).toContain(BATCH_ID);
    expect(human).toContain('2');
  });

  it('人类输出与帮助不泄漏秘密或开发机路径；帮助写明确认/授权边界', () => {
    const texts = [
      formatExecutionPreviewView(buildExecutionPreviewView(COMMAND_ID, false, previewResult())),
      formatExecutionBudgetView(buildExecutionBudgetView(budgetStatus(), REVISIONS)),
      getAppCliHelp('execution'),
      getAppCliHelp('execution.preview'),
      getAppCliHelp('execution.start'),
      getAppCliHelp('execution.budget'),
      getAppCliHelp('execution.revise'),
    ];
    for (const text of texts) {
      expect(text).not.toContain(SECRET_VALUE);
      expect(text).not.toMatch(/\/Users\//);
      expect(text).not.toMatch(/\/private\/var\//);
    }
    expect(getAppCliHelp('execution.start')).toContain('--confirm');
    expect(getAppCliHelp('execution.start')).toContain('不代表');
    expect(getAppCliHelp('execution.start')).toContain('previewDigest');
    expect(getAppCliHelp('execution.preview')).toContain('不是授权');
    expect(getAppCliHelp('execution.revise')).toContain('--revision');
    expect(getAppCliHelp('execution.revise')).toContain('--reason');
    expect(getAppCliHelp('execution.budget')).toContain('剩余额度');
  });
});
