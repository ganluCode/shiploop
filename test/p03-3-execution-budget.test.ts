/**
 * P03-3 / F-001：执行预算运行时校验与纯预算判定（ports/execution-budget）。
 *
 * 验收面（纯函数，无 I/O）：
 * - Batch 预算上限（maxRuns/maxTotalAttempts/maxRuntimeStarts/maxNoProgressRuns/
 *   绝对 UTC deadline）与 Run 尝试/时间上限、Task maxCodeAttempts 的结构化校验：
 *   必需预算缺失、非有限值、非安全整数、越界与不一致限制均带字段定位与
 *   reason 码拒绝；
 * - 预算快照形态自带 schemaVersion=1 门槛：未知/未来版本明确拒绝（版本不兼容
 *   fail-closed，不静默误读）；
 * - 纯预算判定覆盖各上限临界值（used==limit 恰好耗尽、used==limit-1 余一次）与
 *   deadline 恰好到达（now==deadline 即耗尽）；
 * - 未知 token/cost 用量保留未知（remaining/exhausted 为 null，不用零费用证明
 *   仍有额度）；未配置资源上限不产生该维度（不虚构 0 限额）；
 * - maxCodeAttempts 默认含首次共三次（DEFAULT_TASK_MAX_CODE_ATTEMPTS=3，
 *   最多两次代码修复）；maxAttemptsPerTask 保持总 Attempt 上限语义，两者同时
 *   生效按 min 解析，且显式区分绑定方。
 */
import { describe, expect, it } from 'vitest';
import {
  BATCH_MAX_NO_PROGRESS_RUNS_MAX,
  BATCH_MAX_RUNS_MAX,
  BATCH_MAX_RUNTIME_STARTS_MAX,
  BATCH_MAX_TOTAL_ATTEMPTS_MAX,
  BUDGET_SNAPSHOT_SCHEMA_VERSION,
  DEFAULT_TASK_MAX_CODE_ATTEMPTS,
  evaluateBatchBudgetReservation,
  evaluateRunBudgetReservation,
  evaluateTaskCodeAttemptReservation,
  RUN_MAX_ATTEMPTS_MAX,
  RUN_TIME_LIMIT_MS_MAX,
  RUN_TIME_LIMIT_MS_MIN,
  resolveTaskAttemptCaps,
  TASK_MAX_CODE_ATTEMPTS_MAX,
  validateBatchBudgetLimits,
  validateExecutionBudgetProposal,
  validateExecutionBudgetSnapshot,
  validateRunBudgetLimits,
} from '../packages/core/src/ports/execution-budget.ts';
import { StorageError } from '../packages/core/src/ports/errors.ts';
import type { ValidationContext } from '../packages/core/src/ports/validation.ts';

const CONTEXT: ValidationContext = { operation: 'ExecutionBudget.test' };

function isBudgetError(error: unknown): error is StorageError {
  return error instanceof StorageError && error.kind === 'validation';
}

/** 断言结构化拒绝：字段定位 + reason 码（脱敏：不回显无关正文）。 */
function expectBudgetError(
  run: () => unknown,
  field: string,
  reason: string,
): StorageError {
  try {
    run();
  } catch (error) {
    expect(isBudgetError(error), `expected StorageError(validation), got ${String(error)}`).toBe(true);
    const storageError = error as StorageError;
    expect(storageError.details?.field).toBe(field);
    expect(storageError.details?.reason).toBe(reason);
    return storageError;
  }
  throw new Error('expected a validation StorageError to be thrown');
}

function validBatchBudget(): Record<string, unknown> {
  return {
    maxRuns: 3,
    maxTotalAttempts: 12,
    maxRuntimeStarts: 6,
    maxNoProgressRuns: 2,
    deadlineUtcMs: 1_900_000_060_000,
  };
}

function validRunLimits(): Record<string, unknown> {
  return { maxAttemptsPerRun: 4, runTimeLimitMs: 3_600_000 };
}

describe('P03-3 / F-001 Batch 预算上限结构化校验', () => {
  it('合法预算通过并返回规范化新对象（不与输入共享引用）', () => {
    const input = validBatchBudget();
    const budget = validateBatchBudgetLimits(input, CONTEXT);
    expect(budget).toEqual(validBatchBudget());
    expect(budget).not.toBe(input);
  });

  it.each([
    'maxRuns',
    'maxTotalAttempts',
    'maxRuntimeStarts',
    'maxNoProgressRuns',
    'deadlineUtcMs',
  ] as const)('必需预算缺失：%s 拒绝（required）', (field) => {
    const input = validBatchBudget();
    delete input[field];
    expectBudgetError(() => validateBatchBudgetLimits(input, CONTEXT), `budget.${field}`, 'required');
  });

  it.each([
    'maxRuns',
    'maxTotalAttempts',
    'maxRuntimeStarts',
    'maxNoProgressRuns',
    'deadlineUtcMs',
  ] as const)('非有限值：(%s as Infinity/NaN) 拒绝（not_finite）', (field) => {
    for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const input = { ...validBatchBudget(), [field]: value };
      expectBudgetError(() => validateBatchBudgetLimits(input, CONTEXT), `budget.${field}`, 'not_finite');
    }
  });

  it.each([
    'maxRuns',
    'maxTotalAttempts',
    'maxRuntimeStarts',
    'maxNoProgressRuns',
    'deadlineUtcMs',
  ] as const)('非安全整数：%s = 2^53 拒绝（not_safe_integer）', (field) => {
    const input = { ...validBatchBudget(), [field]: 2 ** 53 };
    expectBudgetError(() => validateBatchBudgetLimits(input, CONTEXT), `budget.${field}`, 'not_safe_integer');
  });

  it.each([
    ['maxRuns', 0],
    ['maxRuns', BATCH_MAX_RUNS_MAX + 1],
    ['maxTotalAttempts', 0],
    ['maxTotalAttempts', BATCH_MAX_TOTAL_ATTEMPTS_MAX + 1],
    ['maxRuntimeStarts', 0],
    ['maxRuntimeStarts', BATCH_MAX_RUNTIME_STARTS_MAX + 1],
    ['maxNoProgressRuns', 0],
    ['maxNoProgressRuns', BATCH_MAX_NO_PROGRESS_RUNS_MAX + 1],
    ['deadlineUtcMs', 0],
    ['deadlineUtcMs', -1],
  ] as const)('越界：%s=%s 拒绝（out_of_range）', (field, value) => {
    const input = { ...validBatchBudget(), [field]: value };
    expectBudgetError(() => validateBatchBudgetLimits(input, CONTEXT), `budget.${field}`, 'out_of_range');
  });

  it.each([
    ['maxRuns', 1.5],
    ['maxRuns', '3'],
    ['maxTotalAttempts', null],
  ] as const)('非整数/类型非法：%s=%s 拒绝（not_integer / invalid_type）', (field, value) => {
    const input = { ...validBatchBudget(), [field]: value };
    const reason = typeof value === 'number' ? 'not_integer' : 'invalid_type';
    expectBudgetError(() => validateBatchBudgetLimits(input, CONTEXT), `budget.${field}`, reason);
  });

  it('未知键与非对象输入拒绝', () => {
    expectBudgetError(
      () => validateBatchBudgetLimits({ ...validBatchBudget(), extra: 1 }, CONTEXT),
      'budget',
      'unknown_key',
    );
    expectBudgetError(() => validateBatchBudgetLimits('budget', CONTEXT), 'budget', 'invalid_type');
  });

  it('可选 token/cost 总额上限：合法值通过；非有限、非正数拒绝；cost 允许小数', () => {
    const withResources = {
      ...validBatchBudget(),
      maxTokenTotal: 1_000_000,
      maxCostTotal: 12.5,
    };
    expect(validateBatchBudgetLimits(withResources, CONTEXT)).toEqual(withResources);
    expectBudgetError(
      () => validateBatchBudgetLimits({ ...validBatchBudget(), maxTokenTotal: Number.POSITIVE_INFINITY }, CONTEXT),
      'budget.maxTokenTotal',
      'not_finite',
    );
    expectBudgetError(
      () => validateBatchBudgetLimits({ ...validBatchBudget(), maxTokenTotal: 2 ** 53 }, CONTEXT),
      'budget.maxTokenTotal',
      'not_safe_integer',
    );
    expectBudgetError(
      () => validateBatchBudgetLimits({ ...validBatchBudget(), maxTokenTotal: 0 }, CONTEXT),
      'budget.maxTokenTotal',
      'out_of_range',
    );
    expectBudgetError(
      () => validateBatchBudgetLimits({ ...validBatchBudget(), maxCostTotal: -0.5 }, CONTEXT),
      'budget.maxCostTotal',
      'out_of_range',
    );
    expectBudgetError(
      () => validateBatchBudgetLimits({ ...validBatchBudget(), maxCostTotal: Number.NaN }, CONTEXT),
      'budget.maxCostTotal',
      'not_finite',
    );
  });
});

describe('P03-3 / F-001 Run 尝试与时间上限结构化校验', () => {
  it('合法 Run 上限通过并规范化', () => {
    const limits = validateRunBudgetLimits(validRunLimits(), CONTEXT);
    expect(limits).toEqual(validRunLimits());
  });

  it.each(['maxAttemptsPerRun', 'runTimeLimitMs'] as const)('必需上限缺失：%s 拒绝', (field) => {
    const input = validRunLimits();
    delete input[field];
    expectBudgetError(() => validateRunBudgetLimits(input, CONTEXT), `run.${field}`, 'required');
  });

  it.each([
    ['maxAttemptsPerRun', 0],
    ['maxAttemptsPerRun', RUN_MAX_ATTEMPTS_MAX + 1],
    ['maxAttemptsPerRun', Number.POSITIVE_INFINITY],
    ['maxAttemptsPerRun', 2 ** 53],
    ['runTimeLimitMs', 0],
    ['runTimeLimitMs', RUN_TIME_LIMIT_MS_MIN - 1],
    ['runTimeLimitMs', RUN_TIME_LIMIT_MS_MAX + 1],
    ['runTimeLimitMs', Number.NaN],
  ] as const)('Run 上限非法值拒绝：%s=%s', (field, value) => {
    const input = { ...validRunLimits(), [field]: value };
    expect(() => validateRunBudgetLimits(input, CONTEXT)).toThrow(StorageError);
  });

  it('未知键拒绝', () => {
    expectBudgetError(
      () => validateRunBudgetLimits({ ...validRunLimits(), wallClock: 1 }, CONTEXT),
      'run',
      'unknown_key',
    );
  });
});

describe('P03-3 / F-001 跨层一致性与绝对 deadline', () => {
  it('一致的 Batch+Run 提案通过', () => {
    const proposal = validateExecutionBudgetProposal(
      { batch: validBatchBudget(), run: validRunLimits() },
      CONTEXT,
    );
    expect(proposal.batch.maxRuns).toBe(3);
    expect(proposal.run.maxAttemptsPerRun).toBe(4);
  });

  it('无进展 Run 上限超过总 Run 上限：不一致拒绝', () => {
    const error = expectBudgetError(
      () =>
        validateExecutionBudgetProposal(
          { batch: { ...validBatchBudget(), maxNoProgressRuns: 4, maxRuns: 3 }, run: validRunLimits() },
          CONTEXT,
        ),
      'budget.maxNoProgressRuns',
      'inconsistent_limits',
    );
    expect(error.message).toContain('maxRuns');
  });

  it('总尝试上限低于 Run 上限（每 Run 至少预算一次尝试）：不一致拒绝', () => {
    expectBudgetError(
      () =>
        validateExecutionBudgetProposal(
          { batch: { ...validBatchBudget(), maxTotalAttempts: 2, maxRuns: 3 }, run: validRunLimits() },
          CONTEXT,
        ),
      'budget.maxTotalAttempts',
      'inconsistent_limits',
    );
  });

  it('Runtime 启动上限低于 Run 上限（每 Run 至少预算一次启动意图）：不一致拒绝', () => {
    expectBudgetError(
      () =>
        validateExecutionBudgetProposal(
          { batch: { ...validBatchBudget(), maxRuntimeStarts: 2, maxRuns: 3 }, run: validRunLimits() },
          CONTEXT,
        ),
      'budget.maxRuntimeStarts',
      'inconsistent_limits',
    );
  });

  it('单 Run 尝试上限超过整批总尝试上限：不一致拒绝', () => {
    expectBudgetError(
      () =>
        validateExecutionBudgetProposal(
          { batch: { ...validBatchBudget(), maxTotalAttempts: 3 }, run: { ...validRunLimits(), maxAttemptsPerRun: 4 } },
          CONTEXT,
        ),
      'run.maxAttemptsPerRun',
      'inconsistent_limits',
    );
  });

  it('提供参考时间时 deadline 已到达/过期：拒绝（deadline_passed）；未来 deadline 通过', () => {
    const now = 1_900_000_000_000;
    expectBudgetError(
      () =>
        validateExecutionBudgetProposal(
          { batch: { ...validBatchBudget(), deadlineUtcMs: now }, run: validRunLimits() },
          CONTEXT,
          { referenceNowUtcMs: now },
        ),
      'budget.deadlineUtcMs',
      'deadline_passed',
    );
    expectBudgetError(
      () =>
        validateExecutionBudgetProposal(
          { batch: { ...validBatchBudget(), deadlineUtcMs: now - 1 }, run: validRunLimits() },
          CONTEXT,
          { referenceNowUtcMs: now },
        ),
      'budget.deadlineUtcMs',
      'deadline_passed',
    );
    const future = validateExecutionBudgetProposal(
      { batch: { ...validBatchBudget(), deadlineUtcMs: now + 1 }, run: validRunLimits() },
      CONTEXT,
      { referenceNowUtcMs: now },
    );
    expect(future.batch.deadlineUtcMs).toBe(now + 1);
  });

  it('参考时间自身非法（非有限/非安全整数）拒绝', () => {
    expectBudgetError(
      () =>
        validateExecutionBudgetProposal(
          { batch: validBatchBudget(), run: validRunLimits() },
          CONTEXT,
          { referenceNowUtcMs: Number.POSITIVE_INFINITY },
        ),
      'referenceNowUtcMs',
      'not_finite',
    );
    expectBudgetError(
      () =>
        validateExecutionBudgetProposal(
          { batch: validBatchBudget(), run: validRunLimits() },
          CONTEXT,
          { referenceNowUtcMs: 2 ** 53 },
        ),
      'referenceNowUtcMs',
      'not_safe_integer',
    );
  });
});

describe('P03-3 / F-001 预算快照版本门槛', () => {
  it('schemaVersion=1 快照通过（batch+run 上限一起校验）', () => {
    const snapshot = validateExecutionBudgetSnapshot(
      { schemaVersion: BUDGET_SNAPSHOT_SCHEMA_VERSION, batch: validBatchBudget(), run: validRunLimits() },
      CONTEXT,
    );
    expect(snapshot.schemaVersion).toBe(BUDGET_SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.batch.maxRuns).toBe(3);
  });

  it.each([0, 2, -1] as const)('预算快照 schemaVersion=%s：版本不兼容拒绝', (version) => {
    expectBudgetError(
      () =>
        validateExecutionBudgetSnapshot(
          { schemaVersion: version, batch: validBatchBudget(), run: validRunLimits() },
          CONTEXT,
        ),
      'budgetSnapshot.schemaVersion',
      'unsupported_schema_version',
    );
  });

  it.each(['1', null, undefined, 1.5] as const)('预算快照 schemaVersion=%s：非法拒绝', (version) => {
    const input: Record<string, unknown> = {
      batch: validBatchBudget(),
      run: validRunLimits(),
    };
    if (version !== undefined) {
      input.schemaVersion = version;
    }
    expectBudgetError(
      () => validateExecutionBudgetSnapshot(input, CONTEXT),
      'budgetSnapshot.schemaVersion',
      'invalid_schema_version',
    );
  });

  it('快照未知键拒绝；内部上限仍走同一校验（缺必需字段拒绝）', () => {
    expectBudgetError(
      () =>
        validateExecutionBudgetSnapshot(
          { schemaVersion: 1, batch: validBatchBudget(), run: validRunLimits(), extra: true },
          CONTEXT,
        ),
      'budgetSnapshot',
      'unknown_key',
    );
    const brokenBatch = validBatchBudget();
    delete brokenBatch.maxRuns;
    expectBudgetError(
      () =>
        validateExecutionBudgetSnapshot(
          { schemaVersion: 1, batch: brokenBatch, run: validRunLimits() },
          CONTEXT,
        ),
      'budgetSnapshot.batch.maxRuns',
      'required',
    );
  });
});

describe('P03-3 / F-001 Task 尝试上限解析与兼容规则', () => {
  it('默认 maxCodeAttempts 含首次共三次（DEFAULT_TASK_MAX_CODE_ATTEMPTS=3）', () => {
    expect(DEFAULT_TASK_MAX_CODE_ATTEMPTS).toBe(3);
    const caps = resolveTaskAttemptCaps({}, CONTEXT);
    expect(caps).toEqual({
      maxCodeAttempts: 3,
      maxAttemptsPerTask: null,
      effectiveMaxCodeAttempts: 3,
      rule: 'code_cap_default',
    });
  });

  it('仅显式 maxCodeAttempts：代码尝试上限即该值', () => {
    expect(resolveTaskAttemptCaps({ maxCodeAttempts: 5 }, CONTEXT)).toEqual({
      maxCodeAttempts: 5,
      maxAttemptsPerTask: null,
      effectiveMaxCodeAttempts: 5,
      rule: 'code_cap_only',
    });
  });

  it('仅 maxAttemptsPerTask：保持总 Attempt 上限语义，代码上限 = min(默认3, 总上限)', () => {
    expect(resolveTaskAttemptCaps({ maxAttemptsPerTask: 2 }, CONTEXT)).toEqual({
      maxCodeAttempts: 3,
      maxAttemptsPerTask: 2,
      effectiveMaxCodeAttempts: 2,
      rule: 'total_cap_binds',
    });
    // 总上限高于默认代码上限：代码上限仍为默认 3，总上限只约束全部 Attempt。
    expect(resolveTaskAttemptCaps({ maxAttemptsPerTask: 7 }, CONTEXT)).toEqual({
      maxCodeAttempts: 3,
      maxAttemptsPerTask: 7,
      effectiveMaxCodeAttempts: 3,
      rule: 'code_cap_default_bounded_by_total',
    });
  });

  it('两者同时生效按 min 解析并显式标记绑定方（旧字段语义不被重解释）', () => {
    expect(resolveTaskAttemptCaps({ maxCodeAttempts: 5, maxAttemptsPerTask: 7 }, CONTEXT)).toEqual({
      maxCodeAttempts: 5,
      maxAttemptsPerTask: 7,
      effectiveMaxCodeAttempts: 5,
      rule: 'code_cap_binds',
    });
    expect(resolveTaskAttemptCaps({ maxCodeAttempts: 7, maxAttemptsPerTask: 5 }, CONTEXT)).toEqual({
      maxCodeAttempts: 7,
      maxAttemptsPerTask: 5,
      effectiveMaxCodeAttempts: 5,
      rule: 'total_cap_binds',
    });
    expect(resolveTaskAttemptCaps({ maxCodeAttempts: 4, maxAttemptsPerTask: 4 }, CONTEXT)).toEqual({
      maxCodeAttempts: 4,
      maxAttemptsPerTask: 4,
      effectiveMaxCodeAttempts: 4,
      rule: 'equal',
    });
  });

  it.each([
    ['maxCodeAttempts', 0, 'out_of_range'],
    ['maxCodeAttempts', TASK_MAX_CODE_ATTEMPTS_MAX + 1, 'out_of_range'],
    ['maxCodeAttempts', Number.POSITIVE_INFINITY, 'not_finite'],
    ['maxCodeAttempts', 2 ** 53, 'not_safe_integer'],
    ['maxCodeAttempts', 1.5, 'not_integer'],
    ['maxAttemptsPerTask', 0, 'out_of_range'],
    ['maxAttemptsPerTask', 2 ** 53, 'not_safe_integer'],
    ['maxAttemptsPerTask', 1.5, 'not_integer'],
  ] as const)('Task 上限非法值拒绝：%s=%s（reason=%s）', (field, value, reason) => {
    expectBudgetError(() => resolveTaskAttemptCaps({ [field]: value }, CONTEXT), field, reason);
  });

  it('null 视为未提供（非「清除」语义之外的第三态）；未知键拒绝', () => {
    expect(resolveTaskAttemptCaps({ maxCodeAttempts: null, maxAttemptsPerTask: null }, CONTEXT).rule).toBe(
      'code_cap_default',
    );
    expectBudgetError(() => resolveTaskAttemptCaps({ codeAttempts: 3 }, CONTEXT), 'input', 'unknown_key');
  });
});

describe('P03-3 / F-001 纯预算判定：临界值与 deadline 恰好到达', () => {
  const budget = validateBatchBudgetLimits(
    { ...validBatchBudget(), maxRuns: 3, maxTotalAttempts: 12, maxRuntimeStarts: 6, maxNoProgressRuns: 2 },
    CONTEXT,
  );

  it('各计数恰为 limit-1：允许且各维度恰余一次', () => {
    const decision = evaluateBatchBudgetReservation(
      budget,
      { runsCreated: 2, attemptsCreated: 11, runtimeStarts: 5, noProgressRuns: 1 },
      budget.deadlineUtcMs - 1,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).toEqual([]);
    expect(decision.dimensions.maxRuns).toEqual({
      limit: 3,
      used: 2,
      remaining: 1,
      exhausted: false,
    });
    expect(decision.dimensions.maxTotalAttempts.remaining).toBe(1);
    expect(decision.dimensions.maxRuntimeStarts.remaining).toBe(1);
    expect(decision.dimensions.maxNoProgressRuns.remaining).toBe(1);
    expect(decision.dimensions.deadlineUtcMs.remaining).toBe(1);
    expect(decision.unconfirmedDimensions).toEqual([]);
  });

  it.each([
    ['maxRuns', { runsCreated: 3 }],
    ['maxTotalAttempts', { attemptsCreated: 12 }],
    ['maxRuntimeStarts', { runtimeStarts: 6 }],
    ['maxNoProgressRuns', { noProgressRuns: 2 }],
  ] as const)('计数恰好到达上限（%s）：拒绝新预占', (dimension, patch) => {
    const decision = evaluateBatchBudgetReservation(
      budget,
      {
        runsCreated: 0,
        attemptsCreated: 0,
        runtimeStarts: 0,
        noProgressRuns: 0,
        ...patch,
      },
      budget.deadlineUtcMs - 1,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual([
      {
        dimension,
        reason: 'counter_exhausted',
        limit: decision.dimensions[dimension].limit,
        used: decision.dimensions[dimension].used,
      },
    ]);
    expect(decision.dimensions[dimension].exhausted).toBe(true);
    expect(decision.dimensions[dimension].remaining).toBe(0);
  });

  it('多个维度同时耗尽：reasons 逐一列出（不互相掩盖）', () => {
    const decision = evaluateBatchBudgetReservation(
      budget,
      { runsCreated: 3, attemptsCreated: 12, runtimeStarts: 6, noProgressRuns: 2 },
      budget.deadlineUtcMs - 1,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((reason) => reason.dimension)).toEqual([
      'maxRuns',
      'maxTotalAttempts',
      'maxRuntimeStarts',
      'maxNoProgressRuns',
    ]);
  });

  it('deadline 恰好到达（now == deadline）即耗尽；now == deadline-1 仍允许', () => {
    const atDeadline = evaluateBatchBudgetReservation(
      budget,
      { runsCreated: 0, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0 },
      budget.deadlineUtcMs,
    );
    expect(atDeadline.allowed).toBe(false);
    expect(atDeadline.reasons).toEqual([
      {
        dimension: 'deadlineUtcMs',
        reason: 'deadline_reached',
        limit: budget.deadlineUtcMs,
        used: budget.deadlineUtcMs,
      },
    ]);
    expect(atDeadline.dimensions.deadlineUtcMs.exhausted).toBe(true);

    const beforeDeadline = evaluateBatchBudgetReservation(
      budget,
      { runsCreated: 0, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0 },
      budget.deadlineUtcMs - 1,
    );
    expect(beforeDeadline.allowed).toBe(true);
    expect(beforeDeadline.dimensions.deadlineUtcMs.exhausted).toBe(false);
  });

  it('非法用量（负数/非有限/非安全整数/非法 now）拒绝，不用默认 0 兜底', () => {
    for (const usage of [
      { runsCreated: -1, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0 },
      { runsCreated: Number.POSITIVE_INFINITY, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0 },
      { runsCreated: 2 ** 53, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0 },
    ]) {
      expect(() => evaluateBatchBudgetReservation(budget, usage, budget.deadlineUtcMs - 1)).toThrow(StorageError);
    }
    expect(() =>
      evaluateBatchBudgetReservation(
        budget,
        { runsCreated: 0, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0 },
        Number.NaN,
      ),
    ).toThrow(StorageError);
  });
});

describe('P03-3 / F-001 未知 token/cost 用量保留未知', () => {
  it('配置资源上限但用量未知：维度未知（remaining/exhausted=null），不进入 reasons，也不证明仍有额度', () => {
    const budget = validateBatchBudgetLimits(
      { ...validBatchBudget(), maxTokenTotal: 1_000_000, maxCostTotal: 12.5 },
      CONTEXT,
    );
    const unknownUsage = evaluateBatchBudgetReservation(
      budget,
      { runsCreated: 0, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0, tokenUsed: null, costUsed: null },
      budget.deadlineUtcMs - 1,
    );
    expect(unknownUsage.allowed).toBe(true);
    expect(unknownUsage.unconfirmedDimensions).toEqual(['maxTokenTotal', 'maxCostTotal']);
    expect(unknownUsage.dimensions.maxTokenTotal).toEqual({
      limit: 1_000_000,
      used: null,
      remaining: null,
      exhausted: null,
    });
    expect(unknownUsage.dimensions.maxCostTotal?.exhausted).toBeNull();
    // 未知用量绝不能被解释为 0 余量或已确认在额度内。
    expect(unknownUsage.dimensions.maxTokenTotal?.remaining).not.toBe(1_000_000);
    expect(unknownUsage.reasons).toEqual([]);

    // 未提供用量字段（undefined）同样是未知，不是 0。
    const omitted = evaluateBatchBudgetReservation(
      budget,
      { runsCreated: 0, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0 },
      budget.deadlineUtcMs - 1,
    );
    expect(omitted.unconfirmedDimensions).toEqual(['maxTokenTotal', 'maxCostTotal']);
  });

  it('已知用量按上限比较：恰好到达耗尽；小数 cost 正常比较', () => {
    const budget = validateBatchBudgetLimits(
      { ...validBatchBudget(), maxTokenTotal: 100, maxCostTotal: 1.5 },
      CONTEXT,
    );
    const exhausted = evaluateBatchBudgetReservation(
      budget,
      { runsCreated: 0, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0, tokenUsed: 100, costUsed: 1.5 },
      budget.deadlineUtcMs - 1,
    );
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.reasons.map((reason) => reason.dimension)).toContain('maxTokenTotal');
    expect(exhausted.reasons.map((reason) => reason.dimension)).toContain('maxCostTotal');
    expect(exhausted.unconfirmedDimensions).toEqual([]);

    const within = evaluateBatchBudgetReservation(
      budget,
      { runsCreated: 0, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0, tokenUsed: 99.5, costUsed: 0.5 },
      budget.deadlineUtcMs - 1,
    );
    expect(within.allowed).toBe(true);
    expect(within.dimensions.maxTokenTotal?.remaining).toBeCloseTo(0.5, 10);
    expect(within.dimensions.maxCostTotal?.remaining).toBeCloseTo(1.0, 10);
  });

  it('未配置资源上限：不产生该维度（不虚构 0 限额，也不报未知）', () => {
    const decision = evaluateBatchBudgetReservation(
      budget4ResoureceNone(),
      { runsCreated: 0, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0, tokenUsed: 50 },
      1,
    );
    expect(decision.dimensions.maxTokenTotal).toBeUndefined();
    expect(decision.dimensions.maxCostTotal).toBeUndefined();
    expect(decision.unconfirmedDimensions).toEqual([]);

    function budget4ResoureceNone() {
      return validateBatchBudgetLimits(validBatchBudget(), CONTEXT);
    }
  });

  it('负用量与非有限用量拒绝（不做钳制或默认 0）', () => {
    const budget = validateBatchBudgetLimits({ ...validBatchBudget(), maxTokenTotal: 100 }, CONTEXT);
    for (const bad of [
      { runsCreated: 0, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0, tokenUsed: -1 },
      { runsCreated: 0, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0, tokenUsed: Number.POSITIVE_INFINITY },
      { runsCreated: 0, attemptsCreated: 0, runtimeStarts: 0, noProgressRuns: 0, costUsed: Number.NaN },
    ]) {
      expect(() => evaluateBatchBudgetReservation(budget, bad, budget.deadlineUtcMs - 1)).toThrow(StorageError);
    }
  });
});

describe('P03-3 / F-001 Run 级纯预算判定', () => {
  const limits = validateRunBudgetLimits({ maxAttemptsPerRun: 3, runTimeLimitMs: 3_600_000 }, CONTEXT);

  it('尝试计数临界：attemptsCreated == max-1 允许余一次；== max 拒绝', () => {
    const last = evaluateRunBudgetReservation(limits, { attemptsCreated: 2, startedAtUtcMs: null }, 1_000);
    expect(last.allowed).toBe(true);
    expect(last.dimensions.maxAttemptsPerRun).toEqual({ limit: 3, used: 2, remaining: 1, exhausted: false });

    const exhausted = evaluateRunBudgetReservation(limits, { attemptsCreated: 3, startedAtUtcMs: null }, 1_000);
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.reasons).toEqual([
      { dimension: 'maxAttemptsPerRun', reason: 'counter_exhausted', limit: 3, used: 3 },
    ]);
  });

  it('时间上限临界：elapsed == limit 恰好到达即拒绝；elapsed == limit-1 允许', () => {
    const startedAt = 1_900_000_000_000;
    const atLimit = evaluateRunBudgetReservation(limits, { attemptsCreated: 0, startedAtUtcMs: startedAt }, startedAt + limits.runTimeLimitMs);
    expect(atLimit.allowed).toBe(false);
    expect(atLimit.reasons).toEqual([
      { dimension: 'runTimeLimitMs', reason: 'deadline_reached', limit: limits.runTimeLimitMs, used: limits.runTimeLimitMs },
    ]);
    const before = evaluateRunBudgetReservation(limits, { attemptsCreated: 0, startedAtUtcMs: startedAt }, startedAt + limits.runTimeLimitMs - 1);
    expect(before.allowed).toBe(true);
    expect(before.dimensions.runTimeLimitMs.remaining).toBe(1);
  });

  it('未启动（startedAtUtcMs=null）：时间维度未知而非按 0 耗时放行证明', () => {
    const decision = evaluateRunBudgetReservation(limits, { attemptsCreated: 0, startedAtUtcMs: null }, 5_000_000);
    expect(decision.dimensions.runTimeLimitMs.used).toBeNull();
    expect(decision.dimensions.runTimeLimitMs.remaining).toBeNull();
    expect(decision.dimensions.runTimeLimitMs.exhausted).toBeNull();
  });

  it('非法状态（负计数/非法时间/now 早于启动时间之外仍拒绝非有限 now）拒绝', () => {
    expect(() => evaluateRunBudgetReservation(limits, { attemptsCreated: -1, startedAtUtcMs: null }, 1)).toThrow(StorageError);
    expect(() =>
      evaluateRunBudgetReservation(limits, { attemptsCreated: 0, startedAtUtcMs: Number.NaN }, 1),
    ).toThrow(StorageError);
    expect(() =>
      evaluateRunBudgetReservation(limits, { attemptsCreated: 0, startedAtUtcMs: 1_000 }, Number.POSITIVE_INFINITY),
    ).toThrow(StorageError);
  });
});

describe('P03-3 / F-001 Task 代码尝试纯判定', () => {
  it('临界值：used == cap-1 允许最后一次代码尝试；used == cap 拒绝', () => {
    const caps = resolveTaskAttemptCaps({ maxCodeAttempts: 3 }, CONTEXT);
    const last = evaluateTaskCodeAttemptReservation(caps, 2);
    expect(last).toEqual({ allowed: true, used: 2, remaining: 1, limit: 3 });
    const exhausted = evaluateTaskCodeAttemptReservation(caps, 3);
    expect(exhausted.allowed).toBe(false);
    expect(exhausted).toEqual({ allowed: false, used: 3, remaining: 0, limit: 3, reason: 'code_attempts_exhausted' });
  });

  it('默认上限（含首次共三次）与 min 兼容规则同样受判定约束', () => {
    const byTotal = resolveTaskAttemptCaps({ maxAttemptsPerTask: 2 }, CONTEXT);
    expect(evaluateTaskCodeAttemptReservation(byTotal, 1).allowed).toBe(true);
    expect(evaluateTaskCodeAttemptReservation(byTotal, 2).allowed).toBe(false);
    const byDefault = resolveTaskAttemptCaps({}, CONTEXT);
    expect(evaluateTaskCodeAttemptReservation(byDefault, 2).allowed).toBe(true);
    expect(evaluateTaskCodeAttemptReservation(byDefault, 3).allowed).toBe(false);
  });

  it('非法输入拒绝（负数/非有限/超过上限的计数不做钳制）', () => {
    const caps = resolveTaskAttemptCaps({}, CONTEXT);
    expect(() => evaluateTaskCodeAttemptReservation(caps, -1)).toThrow(StorageError);
    expect(() => evaluateTaskCodeAttemptReservation(caps, Number.POSITIVE_INFINITY)).toThrow(StorageError);
  });
});
