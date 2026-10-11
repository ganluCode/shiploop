/**
 * F-003 公开事件封套映射与事件游标纯契约测试。
 *
 * 协议依据：docs/p02-2-commands-events-contract.md
 * - §8 快照水位：watermark = 一致读视图内 MAX(state_events.sequence)，空库 0，
 *   cursor 绑定数据根身份与 scope；
 * - §9.1 事件封套 schemaVersion=1（独立于线消息 2/配置 payload 2）：
 *   eventId/sequence/type/scope/aggregate/occurredAt/payload 逐字段映射，
 *   不添加 Run/Task/Attempt 身份，全局事件无 projectId；
 * - §9.2 六类事件白名单与 type/aggregate/project_id/payload 形状；
 *   未知持久类型显式失败（corrupt_state），永不伪造、不透传未知 payload 键；
 * - §9.3 游标 evcur_v1_<base64url>：{v:1,seq,root,sk}，非法一律
 *   invalid_input(invalid_cursor)，不当作从零读取；未来游标合法；
 *   补读分页默认 100、上限 500。
 *
 * 本套件只测纯数据与纯函数：不打开数据库、不发 HTTP、不起子进程。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isPublicError, PublicError } from '../packages/core/src/ports/commands.ts';
import {
  GLOBAL_SETTINGS_UPDATED_EVENT_TYPE,
  GLOBAL_SETTINGS_ID,
  PROJECT_METADATA_UPDATED_EVENT_TYPE,
  PROJECT_SETTINGS_UPDATED_EVENT_TYPE,
} from '../packages/core/src/ports/state-store.ts';
import {
  BASELINE_AUTHORIZED_EVENT_TYPE,
  BASELINE_CANCELLED_EVENT_TYPE,
  BASELINE_CHECK_COMPLETED_EVENT_TYPE,
  BASELINE_COMPLETED_EVENT_TYPE,
  BASELINE_STARTED_EVENT_TYPE,
  EVENT_CURSOR_PREFIX,
  EVENT_PAGE_DEFAULT_LIMIT,
  EVENT_PAGE_MAX_LIMIT,
  EVENT_READ_OPERATION,
  FEATURE_LABELS_UPDATED_EVENT_TYPE,
  FEATURE_PLAN_IMPORTED_EVENT_TYPE,
  FEATURE_PLAN_REVISED_EVENT_TYPE,
  PHASE_CREATED_EVENT_TYPE,
  PHASE_LABELS_UPDATED_EVENT_TYPE,
  PUBLIC_EVENT_SCHEMA_VERSION,
  PUBLIC_STATE_EVENT_TYPES,
  SETTINGS_GLOBAL_CREATED_EVENT_TYPE,
  SETTINGS_PROJECT_CREATED_EVENT_TYPE,
  TASK_LABELS_UPDATED_EVENT_TYPE,
  TASK_STRATEGY_UPDATED_EVENT_TYPE,
  FEATURE_PLAN_APPROVED_EVENT_TYPE,
  FEATURE_PLAN_REJECTED_EVENT_TYPE,
  EXECUTION_INPUT_PREPARED_EVENT_TYPE,
  createEventCursorBinding,
  createEventWatermark,
  decodeEventCursor,
  encodeEventCursor,
  mapStateEvent,
  mapStateEvents,
  normalizeMaxEventSequence,
  validateEventPageLimit,
  validateEventScope,
} from '../packages/core/src/ports/events.ts';

const PROJECT_A = '12345678-1234-4123-8234-1234567890ab';
const PROJECT_B = '12345678-1234-4123-8234-1234567890cd';
const EVENT_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const SETTINGS_ROW_ID = 'bbbbbbbb-2222-4333-9444-555555555555';
const OCCURRED_MS = 1_728_432_000_123; // 2024-10-09T00:00:00.123Z
const ROOT_A = 'a'.repeat(64);
const ROOT_B = 'b'.repeat(64);

type RowInput = Record<string, unknown>;

function binding(rootIdentity = ROOT_A, scope: { kind: 'global' } | { kind: 'project'; projectId: string } = {
  kind: 'project',
  projectId: PROJECT_A,
}) {
  return createEventCursorBinding({ rootIdentity, scope }, EVENT_READ_OPERATION);
}

function summaryPayload(overrides: RowInput = {}): RowInput {
  return {
    schemaVersion: 2,
    strategies: ['defaultStrategy', 'modelMap.low'],
    policies: ['executionLimits', 'verification'],
    ...overrides,
  };
}

function eventRow(overrides: RowInput = {}): RowInput {
  return {
    id: EVENT_ID,
    sequence: 7,
    eventType: PROJECT_METADATA_UPDATED_EVENT_TYPE,
    aggregateType: 'project',
    aggregateId: PROJECT_A,
    aggregateRevision: 3,
    projectId: PROJECT_A,
    payload: { changedFields: ['displayName', 'labels'] },
    occurredAtUtcMs: OCCURRED_MS,
    ...overrides,
  };
}

function expectPublicError(fn: () => unknown, code: string, reason?: string): PublicError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PublicError);
    const publicError = error as PublicError;
    expect(publicError.code).toBe(code);
    expect(publicError.operation).toBe(EVENT_READ_OPERATION);
    if (reason !== undefined) {
      expect(publicError.details?.reason).toBe(reason);
    }
    return publicError;
  }
  throw new Error(`expected PublicError(${code}) to be thrown`);
}

describe('F-003 冻结事件封套版本与 §9.2 事件白名单（P02-2 六类 + P02-3/F-007 五类基线事件）', () => {
  it('封套 schemaVersion=1，与线消息/配置 payload 版本独立', () => {
    expect(PUBLIC_EVENT_SCHEMA_VERSION).toBe(1);
  });

  it('白名单冻结为六类 + 五类基线事件 + 七类计划事件且与既有事件常量同源', () => {
    expect([...PUBLIC_STATE_EVENT_TYPES]).toEqual([
      'project.registered',
      PROJECT_METADATA_UPDATED_EVENT_TYPE,
      SETTINGS_GLOBAL_CREATED_EVENT_TYPE,
      SETTINGS_PROJECT_CREATED_EVENT_TYPE,
      GLOBAL_SETTINGS_UPDATED_EVENT_TYPE,
      PROJECT_SETTINGS_UPDATED_EVENT_TYPE,
      // P02-3 / F-007：§9.2 基线事件白名单扩展（随迁移 v4 生效，§9.3）。
      BASELINE_AUTHORIZED_EVENT_TYPE,
      BASELINE_STARTED_EVENT_TYPE,
      BASELINE_CHECK_COMPLETED_EVENT_TYPE,
      BASELINE_COMPLETED_EVENT_TYPE,
      BASELINE_CANCELLED_EVENT_TYPE,
      // P03-1 / F-004：计划域事件白名单扩展（phase.created，聚合为 Phase 自身）。
      PHASE_CREATED_EVENT_TYPE,
      // P03-1 / F-005：计划域事件白名单扩展（feature.plan.imported，聚合为导入创建的 Feature）。
      FEATURE_PLAN_IMPORTED_EVENT_TYPE,
      // P03-1 / F-007：纯标签 CAS 编辑事件（三目标实体各自一条，payload 恒 {labelsUpdated:true}）。
      PHASE_LABELS_UPDATED_EVENT_TYPE,
      FEATURE_LABELS_UPDATED_EVENT_TYPE,
      TASK_LABELS_UPDATED_EVENT_TYPE,
      // P03-1 / F-008：实质计划修订事件（聚合为目标 Feature，payload 恒 {revised:true}）。
      FEATURE_PLAN_REVISED_EVENT_TYPE,
      // P03-2 / F-001：Task 策略副本 CAS 编辑事件（聚合为目标 Task，payload 恒 {strategyUpdated:true}）。
      TASK_STRATEGY_UPDATED_EVENT_TYPE,
      // P03-2 / F-002：计划批准/拒绝决策事件（聚合为目标 Feature；批准/拒绝两类
      // 事件可区分，不把拒绝伪装为批准）。
      FEATURE_PLAN_APPROVED_EVENT_TYPE,
      FEATURE_PLAN_REJECTED_EVENT_TYPE,
      // P03-2 / F-006：执行输入制品组准备完成事件（聚合为目标 Task；准备输入
      // 不是启动执行，不携带制品正文/策略副本/执行语义）。
      EXECUTION_INPUT_PREPARED_EVENT_TYPE,
    ]);
    expect(PROJECT_METADATA_UPDATED_EVENT_TYPE).toBe('project.metadata_updated');
    expect(SETTINGS_GLOBAL_CREATED_EVENT_TYPE).toBe('settings.global_created');
    expect(SETTINGS_PROJECT_CREATED_EVENT_TYPE).toBe('settings.project_created');
    expect(BASELINE_AUTHORIZED_EVENT_TYPE).toBe('baseline.authorized');
    expect(BASELINE_CANCELLED_EVENT_TYPE).toBe('baseline.cancelled');
    expect(PHASE_CREATED_EVENT_TYPE).toBe('phase.created');
    expect(FEATURE_PLAN_IMPORTED_EVENT_TYPE).toBe('feature.plan.imported');
    expect(PHASE_LABELS_UPDATED_EVENT_TYPE).toBe('phase.labels.updated');
    expect(FEATURE_LABELS_UPDATED_EVENT_TYPE).toBe('feature.labels.updated');
    expect(TASK_LABELS_UPDATED_EVENT_TYPE).toBe('task.labels.updated');
    expect(TASK_STRATEGY_UPDATED_EVENT_TYPE).toBe('task.strategy.updated');
    expect(FEATURE_PLAN_APPROVED_EVENT_TYPE).toBe('feature.plan.approved');
    expect(FEATURE_PLAN_REJECTED_EVENT_TYPE).toBe('feature.plan.rejected');
    expect(EXECUTION_INPUT_PREPARED_EVENT_TYPE).toBe('execution.input.prepared');
  });
});

describe('F-003 mapStateEvent：持久行列 → 公开封套', () => {
  it('项目元数据事件：字段逐一映射，scope 携带 projectId', () => {
    const event = mapStateEvent(eventRow());
    expect(event).toEqual({
      schemaVersion: 1,
      eventId: EVENT_ID,
      sequence: 7,
      type: PROJECT_METADATA_UPDATED_EVENT_TYPE,
      scope: { kind: 'project', projectId: PROJECT_A },
      aggregate: { type: 'project', id: PROJECT_A, revision: 3 },
      occurredAt: '2024-10-09T00:00:00.123Z',
      payload: { changedFields: ['displayName', 'labels'] },
    });
  });

  it('全局配置事件：scope.kind=global 且无 projectId 键，aggregate id=global', () => {
    const event = mapStateEvent(
      eventRow({
        eventType: GLOBAL_SETTINGS_UPDATED_EVENT_TYPE,
        aggregateType: 'global_settings',
        aggregateId: GLOBAL_SETTINGS_ID,
        projectId: null,
        payload: summaryPayload(),
      }),
    );
    expect(event.scope).toEqual({ kind: 'global' });
    expect(Object.prototype.hasOwnProperty.call(event.scope, 'projectId')).toBe(false);
    expect(event.aggregate).toEqual({ type: 'global_settings', id: GLOBAL_SETTINGS_ID, revision: 3 });
    expect(event.payload).toEqual(summaryPayload());
  });

  it('六类事件的 type/aggregateType/projectId 形状全部可映射', () => {
    const cases: ReadonlyArray<[string, string, string | null, RowInput]> = [
      ['project.registered', 'project', PROJECT_A, { registered: true }],
      [PROJECT_METADATA_UPDATED_EVENT_TYPE, 'project', PROJECT_A, { changedFields: ['labels'] }],
      [SETTINGS_GLOBAL_CREATED_EVENT_TYPE, 'global_settings', null, summaryPayload()],
      [SETTINGS_PROJECT_CREATED_EVENT_TYPE, 'project_settings', PROJECT_A, summaryPayload()],
      [GLOBAL_SETTINGS_UPDATED_EVENT_TYPE, 'global_settings', null, summaryPayload()],
      [PROJECT_SETTINGS_UPDATED_EVENT_TYPE, 'project_settings', PROJECT_A, summaryPayload()],
    ];
    for (const [type, aggregateType, projectId, payload] of cases) {
      const event = mapStateEvent(
        eventRow({
          eventType: type,
          aggregateType,
          aggregateId: aggregateType === 'global_settings' ? GLOBAL_SETTINGS_ID : aggregateType === 'project' ? projectId : SETTINGS_ROW_ID,
          projectId,
          payload,
        }),
      );
      expect(event.type).toBe(type);
      expect(event.aggregate.type).toBe(aggregateType);
      expect(event.scope.kind).toBe(projectId === null ? 'global' : 'project');
    }
  });

  it('occurredAt 由毫秒转为以 Z 结尾的 ISO UTC，可往返且不混用聚合 revision', () => {
    const event = mapStateEvent(eventRow({ occurredAtUtcMs: 0 }));
    expect(event.occurredAt).toBe('1970-01-01T00:00:00.000Z');
    expect(Date.parse(event.occurredAt)).toBe(0);
    const withMillis = mapStateEvent(eventRow());
    expect(Date.parse(withMillis.occurredAt)).toBe(OCCURRED_MS);
    // 封套版本与聚合 revision 是两个独立字段。
    expect(withMillis.schemaVersion).toBe(1);
    expect(withMillis.aggregate.revision).toBe(3);
  });

  it('封套只含 §9.1 冻结字段，不添加 Run/Task/Attempt 等不存在的身份', () => {
    const event = mapStateEvent(eventRow());
    expect(Object.keys(event).sort()).toEqual(
      ['aggregate', 'eventId', 'occurredAt', 'payload', 'schemaVersion', 'scope', 'sequence', 'type'].sort(),
    );
    expect(JSON.stringify(event)).not.toMatch(/runId|taskId|attemptId|operationId/i);
  });

  it('不修改输入行', () => {
    const row = eventRow();
    const snapshot = JSON.parse(JSON.stringify(row)) as unknown;
    mapStateEvent(row);
    expect(row).toEqual(snapshot);
  });

  it('mapStateEvents 保持输入顺序映射（升序由读取侧 SQL 负责，映射不重排）', () => {
    const events = mapStateEvents([
      eventRow({ id: '11111111-1111-4111-8111-111111111111', sequence: 12 }),
      eventRow({ id: '22222222-2222-4222-8222-222222222222', sequence: 13 }),
    ]);
    expect(events.map((event) => event.sequence)).toEqual([12, 13]);
  });
});

describe('F-003 未知持久类型与行列结构损坏显式失败（永不伪造）', () => {
  it('白名单外 event_type → corrupt_state(unknown_event_type)，不猜测、不跳过', () => {
    const error = expectPublicError(
      () => mapStateEvent(eventRow({ eventType: 'task.attempt_finished' })),
      'corrupt_state',
      'unknown_event_type',
    );
    // 错误不回显行内容。
    expect(JSON.stringify(error.details)).not.toContain('task.attempt_finished');
  });

  const scopeMismatchRows: ReadonlyArray<readonly [string, RowInput]> = [
    ['项目事件 projectId 为 NULL', { eventType: 'project.registered', aggregateType: 'project', aggregateId: PROJECT_A, projectId: null, payload: { registered: true } }],
    ['项目元数据事件 aggregateType 错为 project_settings', { aggregateType: 'project_settings', aggregateId: SETTINGS_ROW_ID }],
    ['全局事件携带 projectId', { eventType: GLOBAL_SETTINGS_UPDATED_EVENT_TYPE, aggregateType: 'global_settings', aggregateId: GLOBAL_SETTINGS_ID, projectId: PROJECT_A }],
    ['全局事件 aggregateType 错为 project', { eventType: GLOBAL_SETTINGS_UPDATED_EVENT_TYPE, aggregateType: 'project', aggregateId: GLOBAL_SETTINGS_ID, projectId: null }],
    ['project 聚合 aggregateId 与 projectId 不一致', { aggregateId: SETTINGS_ROW_ID }],
    ['global_settings 聚合 aggregateId 非 global', { eventType: GLOBAL_SETTINGS_UPDATED_EVENT_TYPE, aggregateType: 'global_settings', aggregateId: SETTINGS_ROW_ID, projectId: null, payload: summaryPayload() }],
  ];
  for (const [label, overrides] of scopeMismatchRows) {
    it(`scope/聚合不一致 → corrupt_state(event_scope_mismatch)：${label}`, () => {
      expectPublicError(() => mapStateEvent(eventRow(overrides)), 'corrupt_state', 'event_scope_mismatch');
    });
  }

  const structuralCases: ReadonlyArray<readonly [string, RowInput]> = [
    ['id 不是 UUID v4', { id: 'evt_1' }],
    ['id 为数字', { id: 123 }],
    ['sequence 为 0', { sequence: 0 }],
    ['sequence 为负数', { sequence: -1 }],
    ['sequence 为小数', { sequence: 1.5 }],
    ['sequence 超过安全整数', { sequence: Number.MAX_SAFE_INTEGER + 1 }],
    ['sequence 为字符串', { sequence: '9' }],
    ['aggregateRevision 为 0', { aggregateRevision: 0 }],
    ['aggregateRevision 为小数', { aggregateRevision: 2.5 }],
    ['aggregateId 为空', { aggregateId: '' }],
    ['projectId 为数字', { projectId: 123 }],
    ['projectId 为非 UUID 字符串', { projectId: 'project-a' }],
    ['occurredAtUtcMs 为负数', { occurredAtUtcMs: -1 }],
    ['occurredAtUtcMs 为小数', { occurredAtUtcMs: 1.5 }],
    ['occurredAtUtcMs 为字符串', { occurredAtUtcMs: '1728403200123' }],
    ['eventType 为空串', { eventType: '' }],
    ['aggregateType 为空串', { aggregateType: '' }],
  ];
  for (const [label, overrides] of structuralCases) {
    it(`行列结构错误 → corrupt_state(corrupt_event_row)：${label}`, () => {
      expectPublicError(() => mapStateEvent(eventRow(overrides)), 'corrupt_state', 'corrupt_event_row');
    });
  }

  it('非对象输入、null、数组与未知列均按结构损坏拒绝', () => {
    for (const bad of [undefined, null, 'row', 42, true, []] as unknown[]) {
      expectPublicError(() => mapStateEvent(bad), 'corrupt_state', 'corrupt_event_row');
    }
    expectPublicError(
      () => mapStateEvent(eventRow({ unexpected: 'x' })),
      'corrupt_state',
      'corrupt_event_row',
    );
    expectPublicError(() => mapStateEvent({ ...eventRow(), id: undefined }), 'corrupt_state', 'corrupt_event_row');
  });
});

describe('F-003 持久 payload 脱敏白名单（未知/含值键不蒙混透传）', () => {
  it('registered 只接受 {registered:true}', () => {
    const ok = mapStateEvent(
      eventRow({
        eventType: 'project.registered',
        aggregateId: PROJECT_A,
        payload: { registered: true },
      }),
    );
    expect(ok.payload).toEqual({ registered: true });
  });

  const registeredBad: ReadonlyArray<[string, unknown]> = [
    ['registered=false', { registered: false }],
    ['registered=1', { registered: 1 }],
    ['携带额外键', { registered: true, extra: true }],
    ['空对象', {}],
  ];
  for (const [label, payload] of registeredBad) {
    it(`registered payload 违规（${label}）→ corrupt_state(event_payload_violation)`, () => {
      expectPublicError(
        () =>
          mapStateEvent(
            eventRow({
              eventType: 'project.registered',
              aggregateId: PROJECT_A,
              payload,
            }),
          ),
        'corrupt_state',
        'event_payload_violation',
      );
    });
  }

  it('changedFields 只接受非空、去重的已知字段名白名单', () => {
    const valid = ['displayName', 'description', 'labels'];
    for (const fields of [valid, ['displayName'], ['labels', 'description']]) {
      const event = mapStateEvent(eventRow({ payload: { changedFields: fields } }));
      expect(event.payload).toEqual({ changedFields: fields });
    }
  });

  const changedFieldsBad: ReadonlyArray<[string, unknown]> = [
    ['空数组', []],
    ['未知字段名', ['repositoryPath']],
    ['重复字段', ['labels', 'labels']],
    ['非字符串元素', ['labels', 3]],
    ['非数组', 'labels'],
    ['额外 payload 键', { changedFields: ['labels'], secret: 'x' }],
    ['缺 changedFields', {}],
  ];
  for (const [label, payload] of changedFieldsBad) {
    it(`changedFields 违规（${label}）→ corrupt_state(event_payload_violation)`, () => {
      expectPublicError(
        () => mapStateEvent(eventRow({ payload })),
        'corrupt_state',
        'event_payload_violation',
      );
    });
  }

  it('settingsChangeSummary：schemaVersion=2 + 字符串键名数组，不含值/凭据', () => {
    const event = mapStateEvent(
      eventRow({
        eventType: SETTINGS_PROJECT_CREATED_EVENT_TYPE,
        aggregateType: 'project_settings',
        aggregateId: SETTINGS_ROW_ID,
        payload: summaryPayload(),
      }),
    );
    expect(event.payload).toEqual(summaryPayload());
  });

  const summaryBad: ReadonlyArray<[string, unknown]> = [
    ['schemaVersion=1', summaryPayload({ schemaVersion: 1 })],
    ['schemaVersion=3（未知前向版本）', summaryPayload({ schemaVersion: 3 })],
    ['schemaVersion 为字符串', summaryPayload({ schemaVersion: '2' })],
    ['strategies 含非字符串', summaryPayload({ strategies: ['ok', 7] })],
    ['strategies 含空串', summaryPayload({ strategies: [''] })],
    ['policies 含非字符串', summaryPayload({ policies: [3] })],
    ['未知顶层键（伪装注入配置值/秘密）', summaryPayload({ apiKey: 'sk-x', defaultModel: 'm' })],
    ['缺 policies', { schemaVersion: 2, strategies: [] }],
    ['payload 为数组', []],
    ['payload 为 null', null],
    ['payload 为字符串', '{"schemaVersion":2}'],
  ];
  for (const [label, payload] of summaryBad) {
    it(`summary 违规（${label}）→ corrupt_state(event_payload_violation)`, () => {
      expectPublicError(
        () =>
          mapStateEvent(
            eventRow({
              eventType: GLOBAL_SETTINGS_UPDATED_EVENT_TYPE,
              aggregateType: 'global_settings',
              aggregateId: GLOBAL_SETTINGS_ID,
              projectId: null,
              payload,
            }),
          ),
        'corrupt_state',
        'event_payload_violation',
      );
    });
  }
});

describe('F-003 validateEventScope：事件查询 scope 运行时校验', () => {
  it('接受 global 与 project 形态', () => {
    expect(validateEventScope({ kind: 'global' })).toEqual({ kind: 'global' });
    expect(validateEventScope({ kind: 'project', projectId: PROJECT_A })).toEqual({
      kind: 'project',
      projectId: PROJECT_A,
    });
  });

  const badScopes: ReadonlyArray<[string, unknown, string]> = [
    ['非对象', 'global', 'scope'],
    ['null', null, 'scope'],
    ['未知 kind', { kind: 'registration' }, 'scope.kind'],
    ['project 缺 projectId', { kind: 'project' }, 'scope.projectId'],
    ['global 携带 projectId', { kind: 'global', projectId: PROJECT_A }, 'scope.projectId'],
    ['projectId 非稳定 ID', { kind: 'project', projectId: '../etc' }, 'scope.projectId'],
    ['未知键', { kind: 'global', extra: 1 }, 'scope.extra'],
  ];
  for (const [label, input, field] of badScopes) {
    it(`非法 scope（${label}）→ invalid_input 定位 ${field}`, () => {
      const error = expectPublicError(() => validateEventScope(input), 'invalid_input');
      expect(error.details?.field).toBe(field);
    });
  }
});

describe('F-003 游标绑定：数据根身份 64hex + scope 指纹', () => {
  it('rootIdentity 必须为 64 位小写 hex', () => {
    for (const bad of [undefined, null, 64, 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), `${'a'.repeat(64)}0`]) {
      expectPublicError(
        () => createEventCursorBinding({ rootIdentity: bad, scope: { kind: 'global' } }),
        'invalid_input',
      );
    }
    const good = createEventCursorBinding({ rootIdentity: ROOT_A, scope: { kind: 'global' } });
    expect(good.rootIdentity).toBe(ROOT_A);
    expect(good.scope).toEqual({ kind: 'global' });
  });

  it('scope 经同一运行时校验', () => {
    expectPublicError(
      () => createEventCursorBinding({ rootIdentity: ROOT_A, scope: { kind: 'project' } }),
      'invalid_input',
    );
  });
});

describe('F-003 §9.3 事件游标编解码与非法边界', () => {
  it('空库初始水位 seq=0 可签发并原样解析', () => {
    const cursor = encodeEventCursor(0, binding());
    expect(cursor.startsWith(EVENT_CURSOR_PREFIX)).toBe(true);
    const decoded = decodeEventCursor(cursor, binding());
    expect(decoded).toEqual({ version: 1, sequence: 0 });
  });

  it('合法恢复游标往返；编码确定性（同输入同串）', () => {
    const cursor = encodeEventCursor(42, binding());
    expect(decodeEventCursor(cursor, binding())).toEqual({ version: 1, sequence: 42 });
    expect(encodeEventCursor(42, binding())).toBe(cursor);
  });

  it('未来游标（seq 大于当前水位）合法：解析不依赖水位，不报错', () => {
    const cursor = encodeEventCursor(Number.MAX_SAFE_INTEGER, binding());
    expect(decodeEventCursor(cursor, binding()).sequence).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('游标不透明：不含 projectId、canonicalRoot 或完整 64hex 根身份', () => {
    const cursor = encodeEventCursor(9, binding(ROOT_A, { kind: 'project', projectId: PROJECT_A }));
    expect(cursor).not.toContain(PROJECT_A);
    expect(cursor).not.toContain(ROOT_A);
    // 明文 JSON 键名也不应出现在线消息中。
    expect(cursor.slice(EVENT_CURSOR_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  const invalidCursors: ReadonlyArray<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['数字', 123],
    ['对象', { v: 1 }],
    ['空串', ''],
    ['错误前缀', `v1_${Buffer.from('{}').toString('base64url')}`],
    ['只有前缀', EVENT_CURSOR_PREFIX],
    ['含非 base64url 字符', `${EVENT_CURSOR_PREFIX}abc!def`],
    ['base64 内容不是 JSON', `${EVENT_CURSOR_PREFIX}${Buffer.from('not-json').toString('base64url')}`],
    ['JSON 为数组', `${EVENT_CURSOR_PREFIX}${Buffer.from('[]').toString('base64url')}`],
    ['JSON 为 null', `${EVENT_CURSOR_PREFIX}${Buffer.from('null').toString('base64url')}`],
    ['缺 v', `${EVENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ seq: 1, root: 'a'.repeat(16), sk: 'a'.repeat(64) })).toString('base64url')}`],
    ['缺 seq', `${EVENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: 1, root: 'a'.repeat(16), sk: 'a'.repeat(64) })).toString('base64url')}`],
    ['缺 root', `${EVENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: 1, seq: 1, sk: 'a'.repeat(64) })).toString('base64url')}`],
    ['缺 sk', `${EVENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: 1, seq: 1, root: 'a'.repeat(16) })).toString('base64url')}`],
    ['未知键', `${EVENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: 1, seq: 1, root: 'a'.repeat(16), sk: 'a'.repeat(64), x: 1 })).toString('base64url')}`],
    ['未知版本 v=2', `${EVENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: 2, seq: 1, root: 'a'.repeat(16), sk: 'a'.repeat(64) })).toString('base64url')}`],
    ['v 为字符串', `${EVENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: '1', seq: 1, root: 'a'.repeat(16), sk: 'a'.repeat(64) })).toString('base64url')}`],
    ['seq 负数', `${EVENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: 1, seq: -1, root: 'a'.repeat(16), sk: 'a'.repeat(64) })).toString('base64url')}`],
    ['seq 小数', `${EVENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: 1, seq: 1.5, root: 'a'.repeat(16), sk: 'a'.repeat(64) })).toString('base64url')}`],
    ['seq 超安全整数', `${EVENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: 1, seq: Number.MAX_SAFE_INTEGER + 1, root: 'a'.repeat(16), sk: 'a'.repeat(64) })).toString('base64url')}`],
    ['seq 为字符串', `${EVENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: 1, seq: '1', root: 'a'.repeat(16), sk: 'a'.repeat(64) })).toString('base64url')}`],
    ['seq 为 null', `${EVENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: 1, seq: null, root: 'a'.repeat(16), sk: 'a'.repeat(64) })).toString('base64url')}`],
    ['root 非 hex', `${EVENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: 1, seq: 1, root: 'z'.repeat(16), sk: 'a'.repeat(64) })).toString('base64url')}`],
    ['root 长度不符', `${EVENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: 1, seq: 1, root: 'a'.repeat(15), sk: 'a'.repeat(64) })).toString('base64url')}`],
    ['sk 非 hex', `${EVENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: 1, seq: 1, root: 'a'.repeat(16), sk: 'z'.repeat(64) })).toString('base64url')}`],
  ];
  for (const [label, cursor] of invalidCursors) {
    it(`非法游标（${label}）→ invalid_input(invalid_cursor)，不得当从零读取`, () => {
      const error = expectPublicError(() => decodeEventCursor(cursor, binding()), 'invalid_input', 'invalid_cursor');
      expect(error.details?.field).toBe('cursor');
    });
  }

  it('篡改一个字符即拒绝（非规范编码不宽容）', () => {
    const cursor = encodeEventCursor(11, binding());
    const body = cursor.slice(EVENT_CURSOR_PREFIX.length);
    const tampered = EVENT_CURSOR_PREFIX + body.slice(0, -1) + (body.endsWith('A') ? 'B' : 'A');
    expectPublicError(() => decodeEventCursor(tampered, binding()), 'invalid_input', 'invalid_cursor');
    // 含填充的 base64 形态也拒绝。
    expectPublicError(
      () => decodeEventCursor(`${EVENT_CURSOR_PREFIX}${body}=`, binding()),
      'invalid_input',
      'invalid_cursor',
    );
  });

  it('root 不符（换数据根）→ invalid_cursor，不跨根续读', () => {
    const cursor = encodeEventCursor(5, binding(ROOT_A));
    expectPublicError(() => decodeEventCursor(cursor, binding(ROOT_B)), 'invalid_input', 'invalid_cursor');
  });

  it('scope 不符：global 游标不能在 project 订阅续读，项目 A 不能在项目 B 续读', () => {
    const globalCursor = encodeEventCursor(5, binding(ROOT_A, { kind: 'global' }));
    expectPublicError(
      () => decodeEventCursor(globalCursor, binding(ROOT_A, { kind: 'project', projectId: PROJECT_A })),
      'invalid_input',
      'invalid_cursor',
    );
    const projectACursor = encodeEventCursor(5, binding(ROOT_A, { kind: 'project', projectId: PROJECT_A }));
    expectPublicError(
      () => decodeEventCursor(projectACursor, binding(ROOT_A, { kind: 'project', projectId: PROJECT_B })),
      'invalid_input',
      'invalid_cursor',
    );
  });

  it('不同 scope/根产生不同游标；其他项目造成的 sequence 空隙与游标无关', () => {
    const a = encodeEventCursor(5, binding(ROOT_A, { kind: 'project', projectId: PROJECT_A }));
    const b = encodeEventCursor(5, binding(ROOT_A, { kind: 'project', projectId: PROJECT_B }));
    const g = encodeEventCursor(5, binding(ROOT_A, { kind: 'global' }));
    expect(new Set([a, b, g]).size).toBe(3);
  });
});

describe('F-003 §8 水位与 §9.3 补读分页上限', () => {
  it('normalizeMaxEventSequence：空库 null/缺省 → 0；数值核验', () => {
    expect(normalizeMaxEventSequence(null)).toBe(0);
    expect(normalizeMaxEventSequence(undefined)).toBe(0);
    expect(normalizeMaxEventSequence(0)).toBe(0);
    expect(normalizeMaxEventSequence(123)).toBe(123);
    for (const bad of [-1, 1.5, '123', Number.MAX_SAFE_INTEGER + 1]) {
      expectPublicError(() => normalizeMaxEventSequence(bad), 'corrupt_state', 'corrupt_watermark');
    }
  });

  it('createEventWatermark：{sequence,cursor} 形状且游标可在同一绑定解析', () => {
    const bind = binding();
    const watermark = createEventWatermark(0, bind);
    expect(watermark).toEqual({ sequence: 0, cursor: encodeEventCursor(0, bind) });
    expect(decodeEventCursor(watermark.cursor, bind).sequence).toBe(0);
    const later = createEventWatermark(99, bind);
    expect(decodeEventCursor(later.cursor, bind).sequence).toBe(99);
  });

  it('补读分页：默认 100、1..500；非法值 invalid_input 定位 limit', () => {
    expect(EVENT_PAGE_DEFAULT_LIMIT).toBe(100);
    expect(EVENT_PAGE_MAX_LIMIT).toBe(500);
    expect(validateEventPageLimit(undefined)).toBe(100);
    expect(validateEventPageLimit(1)).toBe(1);
    expect(validateEventPageLimit(500)).toBe(500);
    for (const bad of [0, 501, -1, 1.5, '100', null, true]) {
      const error = expectPublicError(() => validateEventPageLimit(bad), 'invalid_input');
      expect(error.details?.field).toBe('limit');
    }
  });
});

describe('F-003 模块纯度（import 无数据库/网络/文件副作用）', () => {
  it('events.ts 源码不导入基础设施与适配层，不使用计时器', () => {
    const modulePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'packages/core/src/ports/events.ts',
    );
    const source = readFileSync(modulePath, 'utf-8');
    expect(source).not.toMatch(/from 'node:(http|https|net|dgram|fs|child_process|worker_threads|os|path)'/);
    expect(source).not.toContain('better-sqlite3');
    expect(source).not.toContain('drizzle-orm');
    expect(source).not.toContain('adapters/');
    expect(source).not.toContain('pi-coding-agent');
    expect(source).not.toMatch(/setTimeout|setInterval/);
  });

  it('映射/游标失败都抛 PublicError（F-010/F-012 经同一公开错误面映射）', () => {
    expect(isPublicError(new PublicError('forbidden', EVENT_READ_OPERATION))).toBe(true);
    let caught: unknown;
    try {
      decodeEventCursor('evcur_v1_bad', binding());
    } catch (error) {
      caught = error;
    }
    expect(isPublicError(caught)).toBe(true);
  });
});

