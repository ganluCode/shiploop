/**
 * P03-1 / F-007：纯标签 CAS 编辑的纯规则契约（无 I/O、无真实库）。
 *
 * 验收面：
 * - 纯标签编辑影响面（标签是元数据）：不改变 planDigest/planStatus/计划内容/
 *   Task 策略，不使既有计划批准（approved 语义）、Task 通过结果或活动输入
 *   （Batch/Run 固定 ID 集与摘要快照）失效，标签不向父子实体传播；
 * - 复用既有标签规范化与数量/长度上限（LABEL_MAX_LENGTH=64、LABELS_MAX_COUNT=50）；
 * - 请求混入需求/依赖/状态等非标签字段一律拒绝（严格未知键），纯标签操作与
 *   实质计划编辑是可区分的契约（不同命令操作/能力位）；
 * - 事务写入输入只接受 entityType/projectId/id/labels/expectedRevision；
 * - 标签编辑事件为脱敏恒定 payload（{labelsUpdated:true}），公开映射同源。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PLAN_LABELS_EDIT_IMPACT,
  PLAN_LABELS_UPDATE_OPERATION,
} from '../packages/core/src/application/plan-labels-update.ts';
import {
  APP_CAPABILITIES,
  COMMAND_OPERATIONS,
  COMMAND_OPERATION_SPECS,
  validateCommandEnvelope,
} from '../packages/core/src/ports/commands.ts';
import type { PublicError } from '../packages/core/src/ports/commands.ts';
import {
  FEATURE_LABELS_UPDATED_EVENT_TYPE,
  PHASE_LABELS_UPDATED_EVENT_TYPE,
  PUBLIC_STATE_EVENT_TYPES,
  TASK_LABELS_UPDATED_EVENT_TYPE,
  mapStateEvent,
} from '../packages/core/src/ports/events.ts';
import {
  PLAN_ENTITY_TYPES,
  PLAN_EVENT_TYPES,
  validatePlanEventAppend,
  validatePlanLabelsFields,
  validateUpdatePlanEntityLabelsInput,
} from '../packages/core/src/ports/plan-store.ts';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageError } from '../packages/core/src/ports/errors.ts';
import {
  LABELS_MAX_COUNT,
  LABEL_MAX_LENGTH,
} from '../packages/core/src/ports/validation.ts';

const PROJECT_ID = '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf1';
const NOW_ISO = '2026-10-11T00:00:00.000Z';

/** 同步校验错误断言（返回 StorageError 便于继续断言脱敏细节）。 */
function validationFailure(run: () => unknown, field: string, reason?: string | RegExp): StorageError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`expected StorageError(validation) at ${field}, but call succeeded`);
  }
  if (!isStorageError(thrown, 'validation')) {
    throw thrown;
  }
  expect(thrown.details?.field).toBe(field);
  if (reason !== undefined) {
    if (reason instanceof RegExp) {
      expect(String(thrown.details?.reason)).toMatch(reason);
    } else {
      expect(thrown.details?.reason).toBe(reason);
    }
  }
  return thrown;
}

describe('F-007 纯标签编辑影响面（approved 语义与活动输入不失效的纯规则）', () => {
  it('标签是元数据：不改摘要/批准语义/计划内容/策略、不使批准与活动输入失效、不传播', () => {
    expect(PLAN_LABELS_EDIT_IMPACT).toEqual({
      changesPlanDigest: false,
      changesPlanStatus: false,
      changesPlanContent: false,
      changesTaskStrategy: false,
      invalidatesPlanApproval: false,
      invalidatesTaskResults: false,
      invalidatesActiveInputs: false,
      propagatesToParentOrChild: false,
    });
    expect(Object.isFrozen(PLAN_LABELS_EDIT_IMPACT)).toBe(true);
  });
});

describe('F-007 标签字段纯校验（复用规范化与 64/50 上限、严格未知键）', () => {
  it('合法标签编辑字段：trim/NFC/ASCII 小写/实体内去重复用既有规则', () => {
    expect(
      validatePlanLabelsFields({ entityType: 'task', id: 't-1', labels: [' Team ', 'team', 'CORE'] }, 'plan.labels.update'),
    ).toEqual({ entityType: 'task', id: 't-1', labels: ['team', 'core'] });
    expect(
      validatePlanLabelsFields({ entityType: 'phase', id: 'phase-1', labels: [] }, 'plan.labels.update'),
    ).toEqual({ entityType: 'phase', id: 'phase-1', labels: [] });
  });

  it('entityType 限定 phase/feature/task；id 复用稳定 ID 规则', () => {
    expect([...PLAN_ENTITY_TYPES]).toEqual(['phase', 'feature', 'task']);
    validationFailure(
      () => validatePlanLabelsFields({ entityType: 'project', id: 'p-1', labels: [] }, 'plan.labels.update'),
      'entityType',
    );
    validationFailure(
      () => validatePlanLabelsFields({ entityType: 'task', id: 'bad id', labels: [] }, 'plan.labels.update'),
      'id',
    );
    // labels 必须显式提交（编辑以完整标签集合为准；缺省不静默清空）。
    validationFailure(
      () => validatePlanLabelsFields({ entityType: 'task', id: 't-1' }, 'plan.labels.update'),
      'labels',
    );
  });

  it('非法标签按既有规则拒绝（空/空白、非字符串、长度>64、数量>50）', () => {
    validationFailure(
      () => validatePlanLabelsFields({ entityType: 'task', id: 't-1', labels: ['  '] }, 'plan.labels.update'),
      'labels[0]',
    );
    validationFailure(
      () => validatePlanLabelsFields({ entityType: 'task', id: 't-1', labels: [123] }, 'plan.labels.update'),
      'labels[0]',
    );
    validationFailure(
      () =>
        validatePlanLabelsFields(
          { entityType: 'feature', id: 'f-1', labels: ['x'.repeat(LABEL_MAX_LENGTH + 1)] },
          'plan.labels.update',
        ),
      'labels[0]',
    );
    validationFailure(
      () =>
        validatePlanLabelsFields(
          {
            entityType: 'feature',
            id: 'f-1',
            labels: Array.from({ length: LABELS_MAX_COUNT + 1 }, (_v, index) => `l${index}`),
          },
          'plan.labels.update',
        ),
      'labels',
    );
    // 上限边界通过。
    expect(
      validatePlanLabelsFields(
        {
          entityType: 'feature',
          id: 'f-1',
          labels: ['x'.repeat(LABEL_MAX_LENGTH), ...Array.from({ length: LABELS_MAX_COUNT - 1 }, (_v, i) => `l${i}`)],
        },
        'plan.labels.update',
      ).labels,
    ).toHaveLength(LABELS_MAX_COUNT);
  });

  it('需求/依赖/状态/批准/标题等非标签字段混入一律拒绝（不建立第二编辑面）', () => {
    for (const forbiddenKey of [
      'requirementsRefs',
      'dependsOn',
      'acceptance',
      'status',
      'planStatus',
      'planDigest',
      'title',
      'description',
      'complexity',
      'executionConfig',
      'expectedRevision',
      'projectId',
    ]) {
      validationFailure(
        () =>
          validatePlanLabelsFields(
            { entityType: 'task', id: 't-1', labels: [], [forbiddenKey]: forbiddenKey === 'requirementsRefs' ? [] : 'x' },
            'plan.labels.update',
          ),
        'input',
        new RegExp(`包含未知字段 ${forbiddenKey}`),
      );
    }
  });

  it('事务写入输入只接受 entityType/projectId/id/labels/expectedRevision（≥1 整数）', () => {
    expect(
      validateUpdatePlanEntityLabelsInput(
        { entityType: 'phase', projectId: PROJECT_ID, id: 'phase-1', labels: ['a'], expectedRevision: 3 },
        'PlanStore.updatePlanEntityLabels',
      ),
    ).toEqual({
      entityType: 'phase',
      projectId: PROJECT_ID,
      id: 'phase-1',
      labels: ['a'],
      expectedRevision: 3,
    });
    for (const expectedRevision of [undefined, 0, -1, 1.5, '1']) {
      validationFailure(
        () =>
          validateUpdatePlanEntityLabelsInput(
            { entityType: 'phase', projectId: PROJECT_ID, id: 'phase-1', labels: [], expectedRevision },
            'PlanStore.updatePlanEntityLabels',
          ),
        'expectedRevision',
      );
    }
    validationFailure(
      () =>
        validateUpdatePlanEntityLabelsInput(
          { entityType: 'phase', projectId: PROJECT_ID, id: 'phase-1', labels: [], expectedRevision: 1, status: 'open' },
          'PlanStore.updatePlanEntityLabels',
        ),
      'input',
      /包含未知字段 status/,
    );
    validationFailure(
      () =>
        validateUpdatePlanEntityLabelsInput(
          { entityType: 'phase', projectId: 'bad project id', id: 'phase-1', labels: [], expectedRevision: 1 },
          'PlanStore.updatePlanEntityLabels',
        ),
      'projectId',
    );
  });
});

describe('F-007 plan.labels.update 命令契约（与实质计划编辑可区分）', () => {
  const validEnvelope = (changes: Record<string, unknown> = {}) => ({
    schemaVersion: 3,
    commandId: randomUUID(),
    operation: 'plan.labels.update',
    scope: { kind: 'project', projectId: PROJECT_ID },
    expectedRevision: 2,
    issuedAt: NOW_ISO,
    payload: { entityType: 'feature', id: 'feature-1', labels: ['A', 'a'] },
    ...changes,
  });

  it('操作/能力位冻结：project scope 更新类、能力位 plan.labels.write，与 feature.plan.import 分离', () => {
    expect(PLAN_LABELS_UPDATE_OPERATION).toBe('plan.labels.update');
    expect(COMMAND_OPERATIONS).toContain('plan.labels.update');
    expect(COMMAND_OPERATION_SPECS['plan.labels.update']).toEqual({
      scopeKind: 'project',
      mutation: 'update',
      capability: 'plan.labels.write',
    });
    expect(APP_CAPABILITIES).toContain('plan.labels.write');
  });

  it('信封校验：expectedRevision 唯一权威来源（payload 内出现即未知键拒绝），标签规范化', () => {
    const envelope = validateCommandEnvelope(validEnvelope());
    if (envelope.operation !== 'plan.labels.update') {
      throw new Error(`unexpected operation ${envelope.operation}`);
    }
    expect(envelope.expectedRevision).toBe(2);
    expect(envelope.payload).toEqual({ entityType: 'feature', id: 'feature-1', labels: ['a'] });

    // 更新类缺 expectedRevision 拒绝。
    const noRevision = validEnvelope();
    delete (noRevision as Record<string, unknown>).expectedRevision;
    expectPublicInvalid(() => validateCommandEnvelope(noRevision), 'expectedRevision');
    // payload 内 expectedRevision 按未知键拒绝（单一 CAS 权威）。
    expectPublicInvalid(
      () =>
        validateCommandEnvelope(
          validEnvelope({ payload: { entityType: 'feature', id: 'feature-1', labels: [], expectedRevision: 2 } }),
        ),
      'payload.expectedRevision',
    );
  });

  it('请求混入需求/依赖/状态/标题等字段 → invalid_input 定位 payload.<key> 且无业务语义', () => {
    for (const [key, value] of [
      ['requirementsRefs', []],
      ['dependsOn', ['t-1']],
      ['acceptance', { criteria: ['x'] }],
      ['status', 'passed'],
      ['planStatus', 'approved'],
      ['title', '改标题'],
      ['description', '改描述'],
    ] as const) {
      expectPublicInvalid(
        () =>
          validateCommandEnvelope(
            validEnvelope({ payload: { entityType: 'task', id: 't-1', labels: [], [key]: value } }),
          ),
        `payload.${key}`,
      );
    }
  });

  it('非法 entityType/id/标签 → invalid_input 定位 payload.* 字段', () => {
    expectPublicInvalid(
      () => validateCommandEnvelope(validEnvelope({ payload: { entityType: 'project', id: 'p', labels: [] } })),
      'payload.entityType',
    );
    expectPublicInvalid(
      () => validateCommandEnvelope(validEnvelope({ payload: { entityType: 'task', id: 'bad id', labels: [] } })),
      'payload.id',
    );
    expectPublicInvalid(
      () => validateCommandEnvelope(validEnvelope({ payload: { entityType: 'task', id: 't-1', labels: [''] } })),
      'payload.labels[0]',
    );
  });
});

describe('F-007 标签编辑脱敏事件（恒定 payload，公开映射同源）', () => {
  it('三类实体各有冻结事件类型，进入计划域与公开事件白名单', () => {
    expect(PHASE_LABELS_UPDATED_EVENT_TYPE).toBe('phase.labels.updated');
    expect(FEATURE_LABELS_UPDATED_EVENT_TYPE).toBe('feature.labels.updated');
    expect(TASK_LABELS_UPDATED_EVENT_TYPE).toBe('task.labels.updated');
    for (const eventType of [
      PHASE_LABELS_UPDATED_EVENT_TYPE,
      FEATURE_LABELS_UPDATED_EVENT_TYPE,
      TASK_LABELS_UPDATED_EVENT_TYPE,
    ]) {
      expect(PLAN_EVENT_TYPES).toContain(eventType);
      expect(PUBLIC_STATE_EVENT_TYPES).toContain(eventType);
    }
  });

  it('事件追加校验：aggregateType 与事件类型绑定、payload 恒 {labelsUpdated:true}', () => {
    for (const [eventType, aggregateType, aggregateId] of [
      [PHASE_LABELS_UPDATED_EVENT_TYPE, 'phase', 'phase-1'],
      [FEATURE_LABELS_UPDATED_EVENT_TYPE, 'feature', 'feature-1'],
      [TASK_LABELS_UPDATED_EVENT_TYPE, 'task', 't-1'],
    ] as const) {
      expect(
        validatePlanEventAppend(
          {
            projectId: PROJECT_ID,
            eventType,
            aggregateType,
            aggregateId,
            aggregateRevision: 2,
            payload: { labelsUpdated: true },
          },
          'PlanStore.appendPlanEvent',
        ),
      ).toEqual({
        projectId: PROJECT_ID,
        eventType,
        aggregateType,
        aggregateId,
        aggregateRevision: 2,
        payload: { labelsUpdated: true },
      });
      // 聚合类型不匹配 / payload 形状越界 → 校验拒绝。
      expect(() =>
        validatePlanEventAppend(
          {
            projectId: PROJECT_ID,
            eventType,
            aggregateType: 'phase' === aggregateType ? 'feature' : 'phase',
            aggregateId,
            aggregateRevision: 2,
            payload: { labelsUpdated: true },
          },
          'PlanStore.appendPlanEvent',
        ),
      ).toThrow();
      expect(() =>
        validatePlanEventAppend(
          {
            projectId: PROJECT_ID,
            eventType,
            aggregateType,
            aggregateId,
            aggregateRevision: 2,
            payload: { labelsUpdated: true, labels: ['泄漏'] },
          },
          'PlanStore.appendPlanEvent',
        ),
      ).toThrow();
      expect(() =>
        validatePlanEventAppend(
          {
            projectId: PROJECT_ID,
            eventType,
            aggregateType,
            aggregateId,
            aggregateRevision: 2,
            payload: { labelsUpdated: false },
          },
          'PlanStore.appendPlanEvent',
        ),
      ).toThrow();
    }
  });

  it('mapStateEvent 公开映射：类型/聚合/恒定 payload 一致，越界 payload 显式 corrupt', () => {
    const baseRow = {
      id: randomUUID(),
      sequence: 7,
      eventType: TASK_LABELS_UPDATED_EVENT_TYPE,
      aggregateType: 'task',
      aggregateId: 't-1',
      aggregateRevision: 2,
      projectId: PROJECT_ID,
      payload: { labelsUpdated: true },
      occurredAtUtcMs: Date.parse(NOW_ISO),
    };
    expect(mapStateEvent(baseRow)).toEqual({
      schemaVersion: 1,
      eventId: baseRow.id,
      sequence: 7,
      type: 'task.labels.updated',
      scope: { kind: 'project', projectId: PROJECT_ID },
      aggregate: { type: 'task', id: 't-1', revision: 2 },
      occurredAt: NOW_ISO,
      payload: { labelsUpdated: true },
    });
    let thrown: unknown;
    try {
      mapStateEvent({ ...baseRow, payload: { labelsUpdated: true, labels: ['秘密'] } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'corrupt_state' });
    // 聚合类型与事件类型不一致 → 显式失败（不猜测）。
    expect(() => mapStateEvent({ ...baseRow, aggregateType: 'phase' })).toThrow();
  });
});

function expectPublicInvalid(run: () => unknown, field: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`expected PublicError(invalid_input) at ${field}, but call succeeded`);
  }
  const error = thrown as PublicError;
  expect(error.code).toBe('invalid_input');
  expect(error.details?.field).toBe(field);
}
