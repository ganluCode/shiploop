/**
 * P04-9 / F-009 派发队列与执行槽位 CLI 纯面层（参数解析、结构化视图、帮助）。
 *
 * 定位：只测纯函数层（`parseAppCliArgs` / `app/schedule.ts` 视图投影 /
 * `getAppCliHelp`），不接触真实 Host、SQLite、文件或网络：
 * - `execution dispatch` 是只读查询：只接受 `--project` 与既有分页
 *   `--limit/--cursor`；不接受 owner/version/capacity/release 等可写参数，
 *   也不接受位置参数，非法参数在任何 I/O 之前以稳定 reason 拒绝；
 * - 结构化视图原样保留槽位摘要（容量/活动/隔离/跨项目布尔）与派发事实
 *   （认领、槽位、活动/最近 Attempt），并给出可理解等待/隔离原因；
 * - completion 恒不声明验收/交付：Runtime 正常返回或 Attempt succeeded
 *   不等于验证通过；
 * - 文本输出展示槽位占用、占槽者与阻塞原因，未知值显示 none，不打印路径
 *   或凭据。
 *
 * 真实 Host/Client 纵向见 `p04-9-f009-dispatch-host-wiring.test.ts`，正式构建
 * CLI 入口场景见 `p04-9-f009-dispatch-built.test.ts`。
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
  buildExecutionDispatchView,
  formatExecutionDispatchView,
} from '../../../packages/cli/src/app/schedule.ts';
import type {
  DispatchQueueListResult,
  PublicDispatchQueueRecord,
} from '../../../packages/host/src/index.ts';

const PROJECT_ID = randomUUID();
const FEATURE_ID = randomUUID();
const RUN_ID = randomUUID();
const RUN_ID_B = randomUUID();
const CLAIM_ID = randomUUID();
const SLOT_ID = randomUUID();
const ATTEMPT_ID = randomUUID();
const ISO = '2026-10-22T10:00:00.000Z';
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
 * 线形状夹具（HostClient 已校验结果；纯投影不改写事实）
 * ------------------------------------------------------------------ */

function claimView(
  overrides: Partial<NonNullable<PublicDispatchQueueRecord['claim']>> = {},
): NonNullable<PublicDispatchQueueRecord['claim']> {
  return {
    claimId: CLAIM_ID,
    claimVersion: 1,
    origin: 'dispatch',
    resumedFromClaimId: null,
    resumedFromClaimVersion: null,
    ownerId: 'owner-1',
    hostInstanceId: 'host-1',
    state: 'held',
    acquiredAt: ISO,
    leaseUntil: ISO,
    settledAt: null,
    reason: null,
    ...overrides,
  };
}

function slotView(
  overrides: Partial<NonNullable<PublicDispatchQueueRecord['slot']>> = {},
): NonNullable<PublicDispatchQueueRecord['slot']> {
  return {
    slotId: SLOT_ID,
    slotIndex: 1,
    claimId: CLAIM_ID,
    claimVersion: 1,
    ownerId: 'owner-1',
    hostInstanceId: 'host-1',
    state: 'held',
    acquiredAt: ISO,
    leaseUntil: ISO,
    releasedAt: null,
    reason: null,
    ...overrides,
  };
}

function dispatchRecord(
  overrides: Partial<PublicDispatchQueueRecord> = {},
): PublicDispatchQueueRecord {
  return {
    runId: RUN_ID,
    projectId: PROJECT_ID,
    featureId: FEATURE_ID,
    runStatus: 'queued',
    runReason: null,
    dispatchOrdinal: 1,
    state: 'running',
    blockingReason: null,
    claim: claimView(),
    slot: slotView(),
    activeAttempt: {
      id: ATTEMPT_ID,
      taskId: 't-1',
      number: 1,
      status: 'executing',
      executionStage: 'runtime',
      ownerId: 'owner-1',
      executionVersion: 1,
      startedAt: ISO,
      endedAt: null,
      exitCode: null,
      durationMs: null,
    },
    latestAttempt: {
      id: ATTEMPT_ID,
      taskId: 't-1',
      number: 1,
      status: 'executing',
      executionStage: 'runtime',
      ownerId: 'owner-1',
      executionVersion: 1,
      startedAt: ISO,
      endedAt: null,
      exitCode: null,
      durationMs: null,
    },
    attemptCount: 1,
    createdAt: ISO,
    startedAt: null,
    endedAt: null,
    pauseRequestedAt: null,
    ...overrides,
  };
}

function dispatchResult(
  overrides: Partial<DispatchQueueListResult> = {},
): DispatchQueueListResult {
  return {
    schemaVersion: 5,
    scope: 'dispatch-queue',
    slots: {
      capacity: 1,
      activeCount: 1,
      availableCount: 0,
      quarantinedCount: 0,
      projectActiveCount: 1,
      otherProjectActive: false,
    },
    records: [dispatchRecord()],
    nextCursor: null,
    limit: 50,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * A. 参数解析（纯；任何 I/O 之前拒绝）
 * ------------------------------------------------------------------ */

describe('F-009 execution dispatch 参数解析', () => {
  it('命令身份注册并解析最小只读查询意图', () => {
    expect(APP_CLI_COMMAND_IDS).toContain('execution.dispatch');
    const parsed = parseAppCliArgs(
      ['execution', 'dispatch', '--project', PROJECT_ID],
      {},
    );
    expect(parsed).toMatchObject({
      kind: 'command',
      command: 'execution',
      commandId: 'execution.dispatch',
      projectId: PROJECT_ID,
      json: false,
    });
    expect(parsed).not.toHaveProperty('limit');
    expect(parsed).not.toHaveProperty('cursor');
  });

  it('分页与 --json 原样映射（不引入新的写参数）', () => {
    const parsed = parseAppCliArgs(
      [
        'execution', 'dispatch', '--project', PROJECT_ID,
        '--limit', '25', '--cursor', 'plcur_v1_abc', '--json',
      ],
      {},
    );
    expect(parsed).toMatchObject({
      commandId: 'execution.dispatch',
      projectId: PROJECT_ID,
      limit: 25,
      cursor: 'plcur_v1_abc',
      json: true,
    });
  });

  it('固定 Batch 或 Feature selector 只能选择一个，并映射为只读查询参数', () => {
    expect(parseAppCliArgs(
      ['execution', 'dispatch', '--project', PROJECT_ID, '--batch', RUN_ID],
      {},
    )).toMatchObject({ batchId: RUN_ID });
    expect(parseAppCliArgs(
      ['execution', 'dispatch', '--project', PROJECT_ID, '--feature', FEATURE_ID],
      {},
    )).toMatchObject({ featureId: FEATURE_ID });
    expectParseError(
      ['execution', 'dispatch', '--project', PROJECT_ID, '--batch', RUN_ID, '--feature', FEATURE_ID],
      'conflicting_options',
    );
  });

  it('非法身份、分页与位置参数在连接前拒绝（不回显参数值）', () => {
    expectParseError(['execution', 'dispatch'], 'missing_required_option', 'project');
    expectParseError(
      ['execution', 'dispatch', '--project', 'not-a-uuid'],
      'invalid_project_id',
      'project',
    );
    for (const limit of ['0', '201', 'abc', '1.5']) {
      expectParseError(
        ['execution', 'dispatch', '--project', PROJECT_ID, '--limit', limit],
        'invalid_limit',
        'limit',
      );
    }
    expectParseError(
      ['execution', 'dispatch', '--project', PROJECT_ID, '--cursor', ''],
      'invalid_cursor',
      'cursor',
    );
    expectParseError(
      ['execution', 'dispatch', RUN_ID, '--project', PROJECT_ID],
      'too_many_positionals',
    );
  });

  it('拒绝任何新增控制参数：不允许设置 owner/version/capacity 或释放槽位', () => {
    for (const flag of ['--owner', '--version', '--capacity', '--release', '--state']) {
      const error = expectParseError(
        ['execution', 'dispatch', '--project', PROJECT_ID, flag, 'x'],
        'unknown_argument',
      );
      expect(error.message).not.toContain(flag);
    }
  });

  it('帮助说明只读查询、槽位/派发事实与不验收边界', () => {
    const help = getAppCliHelp('execution.dispatch');
    expect(help).toContain('execution.dispatch.list');
    expect(help).toContain('execution dispatch');
    expect(help).toContain('只读');
    expect(help).toContain('不等于验证通过');
    expect(getAppCliHelp('execution')).toContain('execution dispatch');
  });
});

/* ------------------------------------------------------------------ *
 * B. 结构化视图（等待/隔离原因与不交付边界）
 * ------------------------------------------------------------------ */

describe('F-009 execution dispatch 结构化视图', () => {
  it('原样保留槽位摘要与派发事实，并给出等待/隔离分类', () => {
    const result = dispatchResult({
      slots: {
        capacity: 1,
        activeCount: 2,
        availableCount: 0,
        quarantinedCount: 1,
        projectActiveCount: 2,
        otherProjectActive: true,
      },
      records: [
        dispatchRecord({
          runId: RUN_ID_B,
          state: 'waiting_slot',
          blockingReason: 'execution_slot_unavailable',
          claim: null,
          slot: null,
          activeAttempt: null,
          latestAttempt: null,
          attemptCount: 0,
        }),
        dispatchRecord({
          state: 'blocked',
          blockingReason: 'claim_quarantined',
          claim: claimView({ state: 'quarantined', reason: 'manual_verification' }),
          slot: slotView({ state: 'quarantined', reason: 'manual_verification' }),
        }),
        dispatchRecord({
          runId: randomUUID(),
          state: 'paused',
          blockingReason: 'run_paused',
          activeAttempt: null,
        }),
        dispatchRecord({ runId: randomUUID(), state: 'queued', claim: null, slot: null }),
      ],
    });
    const view = buildExecutionDispatchView(result);
    expect(view.operation).toBe('execution.dispatch.list');
    expect(view.slots).toEqual(result.slots);
    expect(view.records).toHaveLength(4);
    expect(view.records.map((entry) => entry.waitCategory)).toEqual([
      'slot',
      'isolation',
      'control',
      'none',
    ]);
    for (const entry of view.records) {
      if (entry.record.blockingReason === null) {
        expect(entry.blockingExplanation).toBeNull();
      } else {
        expect(entry.blockingExplanation).not.toBeNull();
        expect(entry.blockingExplanation!.length).toBeGreaterThan(0);
      }
    }
    // 事实原样透传：认领/槽位/Attempt 身份不被视图改写或补造。
    expect(view.records[1]?.record.claim).toEqual(result.records[1]?.claim);
    expect(view.records[1]?.record.slot).toEqual(result.records[1]?.slot);
    expect(view.records[2]?.record.activeAttempt).toBeNull();
    // completion 恒不声明验收/交付。
    expect(view.completion).toMatchObject({ featureVerified: false, delivered: false });
    expect(view.completion.note).toContain('不代表验证通过');
  });

  it('文本输出展示槽位占用、占槽者与阻塞原因，未知值显示 none', () => {
    const view = buildExecutionDispatchView(
      dispatchResult({
        slots: {
          capacity: 1,
          activeCount: 1,
          availableCount: 0,
          quarantinedCount: 0,
          projectActiveCount: 1,
          otherProjectActive: false,
        },
        records: [
          dispatchRecord(),
          dispatchRecord({
            runId: RUN_ID_B,
            state: 'waiting_slot',
            blockingReason: 'execution_slot_unavailable',
            claim: null,
            slot: null,
            activeAttempt: null,
            latestAttempt: null,
            attemptCount: 0,
          }),
        ],
      }),
    );
    const text = formatExecutionDispatchView(view);
    expect(text).toContain('execution dispatch');
    expect(text).toContain('capacity=1');
    expect(text).toContain('active=1');
    expect(text).toContain('available=0');
    expect(text).toContain(`run=${RUN_ID}`);
    expect(text).toContain(`claim=${CLAIM_ID}`);
    expect(text).toContain(`slot=${SLOT_ID}`);
    expect(text).toContain('owner=owner-1');
    expect(text).toContain('state=waiting_slot');
    expect(text).toContain('blocking=execution_slot_unavailable');
    expect(text).toContain('claim=none');
    expect(text).toContain('slot=none');
    expect(text).toContain('attempt=none');
    // 可理解原因与不验收边界必须出现在人类输出中。
    expect(text).toContain('等待执行槽位');
    expect(text).toContain('不代表验证通过');
  });

  it('视图不引入路径/凭据字段（仅脱敏事实）', () => {
    const view = buildExecutionDispatchView(dispatchResult());
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('/tmp/');
    expect(serialized).not.toContain('repositoryPath');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain(DIGEST);
  });
});
