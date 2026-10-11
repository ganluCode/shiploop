/**
 * P03-1 / F-008：未执行草稿的实质计划修订——纯规则契约（无 I/O、无真实库）。
 *
 * 验收面：
 * - 实质修订影响面（可核对冻结面）：整体替换计划成员与边、既有 Task 保留
 *   稳定身份与既有策略副本（不因当前默认配置或 complexity 编辑自动更换
 *   executionConfig）、新 Task 才走创建策略选择、更新 planDigest 并使旧摘要
 *   批准不可继续生效、草稿修订后仍是草稿（不自动批准/启动执行）、同事务
 *   活动执行输入保护（fail-closed）；
 * - 批准有效性规则可独立测试：批准绑定 planDigest，实质变化（摘要改变）使
 *   旧摘要批准失效并回到 draft，摘要不变（含纯标签变化）不失效；
 * - 命令/能力/事件白名单与实现同源（feature.plan.revise / feature.plan.revised），
 *   信封 expectedRevision 唯一权威来源（payload 内出现即未知键）；
 * - 事件为脱敏恒定 payload（{revised:true}），公开映射同源；
 * - 事务替换原语输入严格未知键拒绝（identity/状态/批准/revision 不经输入面）。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FEATURE_PLAN_REVISE_OPERATION,
  NO_ACTIVE_EXECUTION_INPUTS_PROBE,
  PLAN_REVISE_IMPACT,
  decidePlanApprovalValidity,
} from '../packages/core/src/application/feature-plan-revise.ts';
import {
  APP_CAPABILITIES,
  COMMAND_OPERATION_SPECS,
  COMMAND_OPERATIONS,
  validateCommandEnvelope,
} from '../packages/core/src/ports/commands.ts';
import type { PublicError } from '../packages/core/src/ports/commands.ts';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import type { StorageError } from '../packages/core/src/ports/errors.ts';
import {
  FEATURE_PLAN_REVISED_EVENT_TYPE,
  PLAN_EVENT_TYPES,
  validatePlanEventAppend,
  validateReplaceFeaturePlanInput,
} from '../packages/core/src/ports/plan-store.ts';
import { FEATURE_PLAN_IMPORTED_EVENT_TYPE } from '../packages/core/src/ports/plan-store.ts';
import {
  PLAN_DEPENDENCY_EDGES_MAX_COUNT,
  PLAN_TASKS_MAX_COUNT,
  validateFeaturePlanInput,
} from '../packages/core/src/ports/feature-plan.ts';
import {
  EXECUTION_CONFIG_MAX_BYTES,
  FEATURE_PLAN_STATUSES,
} from '../packages/core/src/ports/plan-store.ts';

const PROJECT_ID = '0f0d9c36-765a-4b62-a6b9-38a5ff4f4bf1';
const FEATURE_ID = 'f-1';
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

/** 三 Task 链草稿计划（纯校验通过；t-2←t-3 依赖）。 */
function chainPlan(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: { title: '示例', description: null, labels: [], sourceRefs: [] },
    tasks: [
      { id: 't-1', title: '一', acceptance: { criteria: ['a'] } },
      { id: 't-2', title: '二', acceptance: { criteria: ['b'] }, dependsOn: ['t-1'] },
      { id: 't-3', title: '三', acceptance: { criteria: ['c'] }, dependsOn: ['t-2'] },
    ],
  };
}

/** 合法替换输入基线（与 chainPlan 对应的最终成员/边集合）。 */
function replaceInput(changes: Record<string, unknown> = {}): Record<string, unknown> {
  const plan = validateFeaturePlanInput(chainPlan());
  return {
    projectId: PROJECT_ID,
    featureId: FEATURE_ID,
    expectedRevision: 1,
    feature: {
      title: plan.feature.title,
      description: plan.feature.description,
      labels: [...plan.feature.labels],
      sourceRefs: [],
      planDigest: plan.planDigest,
      planStatus: 'draft',
    },
    tasks: plan.tasks.map(task => ({
      id: task.id,
      title: task.title,
      description: task.description,
      labels: [...task.labels],
      ...(task.complexity === null ? {} : { complexity: task.complexity }),
      acceptance: { criteria: [...task.acceptance.criteria] },
      requirementsRefs: [],
      executionConfig: { schemaVersion: 2, runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
      configSource: 'global_default',
      configSourceKey: null,
    })),
    dependencies: plan.tasks.flatMap(task => task.dependsOn.map(dependsOn => ({ taskId: task.id, dependsOnId: dependsOn }))),
    ...changes,
  };
}

describe('F-008 实质修订影响面（纯规则冻结面）', () => {
  it('整体替换成员/边，既有身份与策略保留，新 Task 才选策略，更新摘要并使旧摘要批准失效', () => {
    expect(PLAN_REVISE_IMPACT).toEqual({
      replacesPlanMembersWholesale: true,
      keepsExistingTaskStableIdentity: true,
      keepsExistingTaskStrategy: true,
      selectsStrategyForNewTasksOnly: true,
      updatesPlanDigest: true,
      invalidatesPriorDigestApprovals: true,
      keepsDraftPlansDraft: true,
      requiresSameTransactionActivityGuard: true,
      propagatesToParentOrChild: false,
      createsExecutionEntities: false,
    });
    expect(Object.isFrozen(PLAN_REVISE_IMPACT)).toBe(true);
  });

  it('生产无 Run 装配的默认探测明确为「无执行实体表」边界，不是查询失败兜底', () => {
    expect(NO_ACTIVE_EXECUTION_INPUTS_PROBE({ projectId: PROJECT_ID, featureId: FEATURE_ID })).toEqual({
      active: false,
    });
  });
});

describe('F-008 批准有效性规则（批准绑定 planDigest；可独立测试）', () => {
  const DIGEST_A = 'a'.repeat(64);
  const DIGEST_B = 'b'.repeat(64);

  it('实质变化（摘要改变）：旧摘要批准不可继续生效，planStatus 回到 draft', () => {
    expect(
      decidePlanApprovalValidity({ planStatusBefore: 'approved', planDigestBefore: DIGEST_A, planDigestAfter: DIGEST_B }),
    ).toEqual({ substantiveChange: true, planStatusAfter: 'draft', priorDigestApprovalStillValid: false });
    expect(
      decidePlanApprovalValidity({
        planStatusBefore: 'pending_approval',
        planDigestBefore: DIGEST_A,
        planDigestAfter: DIGEST_B,
      }),
    ).toEqual({ substantiveChange: true, planStatusAfter: 'draft', priorDigestApprovalStillValid: false });
  });

  it('摘要不变（含纯标签变化经由修订载荷）：批准不失效，planStatus 保持', () => {
    expect(
      decidePlanApprovalValidity({ planStatusBefore: 'approved', planDigestBefore: DIGEST_A, planDigestAfter: DIGEST_A }),
    ).toEqual({ substantiveChange: false, planStatusAfter: 'approved', priorDigestApprovalStillValid: true });
    expect(
      decidePlanApprovalValidity({ planStatusBefore: 'draft', planDigestBefore: DIGEST_A, planDigestAfter: DIGEST_A }),
    ).toEqual({ substantiveChange: false, planStatusAfter: 'draft', priorDigestApprovalStillValid: false });
  });

  it('空摘要草稿 → 有摘要：实质变化；有摘要 → 空摘要：实质变化（清空计划同样是实质修订）', () => {
    expect(
      decidePlanApprovalValidity({ planStatusBefore: 'draft', planDigestBefore: null, planDigestAfter: DIGEST_A }),
    ).toEqual({ substantiveChange: true, planStatusAfter: 'draft', priorDigestApprovalStillValid: false });
    expect(
      decidePlanApprovalValidity({ planStatusBefore: 'draft', planDigestBefore: DIGEST_A, planDigestAfter: null }),
    ).toEqual({ substantiveChange: true, planStatusAfter: 'draft', priorDigestApprovalStillValid: false });
  });

  it('planStatus 枚举取值受限（复用冻结枚举）', () => {
    expect([...FEATURE_PLAN_STATUSES]).toEqual(['draft', 'pending_approval', 'approved']);
  });
});

describe('F-008 命令/能力/事件白名单同源', () => {
  it('feature.plan.revise 进入命令白名单（project scope + update + 专属能力位）', () => {
    expect(FEATURE_PLAN_REVISE_OPERATION).toBe('feature.plan.revise');
    expect(COMMAND_OPERATIONS).toContain('feature.plan.revise');
    expect(COMMAND_OPERATION_SPECS['feature.plan.revise']).toEqual({
      scopeKind: 'project',
      mutation: 'update',
      capability: 'feature.plan.revise',
    });
    expect(APP_CAPABILITIES).toContain('feature.plan.revise');
  });

  it('feature.plan.revised 进入计划事件白名单（聚合恒为 feature，payload 恒 {revised:true}）', () => {
    expect(FEATURE_PLAN_REVISED_EVENT_TYPE).toBe('feature.plan.revised');
    expect(PLAN_EVENT_TYPES).toContain(FEATURE_PLAN_REVISED_EVENT_TYPE);
    expect(
      validatePlanEventAppend({
        projectId: PROJECT_ID,
        eventType: FEATURE_PLAN_REVISED_EVENT_TYPE,
        aggregateType: 'feature',
        aggregateId: FEATURE_ID,
        aggregateRevision: 2,
        payload: { revised: true },
      }, 'PlanStoreTest.appendPlanEvent'),
    ).toMatchObject({ eventType: FEATURE_PLAN_REVISED_EVENT_TYPE, payload: { revised: true } });
    // 聚合类型/脱敏 payload 形状偏离即拒绝。
    validationFailure(
      () =>
        validatePlanEventAppend(
          {
            projectId: PROJECT_ID,
            eventType: FEATURE_PLAN_REVISED_EVENT_TYPE,
            aggregateType: 'task',
            aggregateId: 't-1',
            aggregateRevision: 2,
            payload: { revised: true },
          },
          'PlanStoreTest.appendPlanEvent',
        ),
      'aggregateType',
    );
    validationFailure(
      () =>
        validatePlanEventAppend(
          {
            projectId: PROJECT_ID,
            eventType: FEATURE_PLAN_REVISED_EVENT_TYPE,
            aggregateType: 'feature',
            aggregateId: FEATURE_ID,
            aggregateRevision: 2,
            payload: { imported: true },
          },
          'PlanStoreTest.appendPlanEvent',
        ),
      'payload',
    );
    // 既有导入事件不受影响（两类契约可区分）。
    expect(FEATURE_PLAN_IMPORTED_EVENT_TYPE).toBe('feature.plan.imported');
  });
});

describe('F-008 修订信封与 payload 校验（纯校验器）', () => {
  const envelope = (changes: Record<string, unknown> = {}) => ({
    schemaVersion: 5,
    commandId: randomUUID(),
    operation: 'feature.plan.revise',
    scope: { kind: 'project', projectId: PROJECT_ID },
    expectedRevision: 1,
    issuedAt: NOW_ISO,
    payload: { featureId: FEATURE_ID, plan: chainPlan() },
    ...changes,
  });

  it('合法信封：project scope + expectedRevision（Feature 聚合）+ featureId/plan payload', () => {
    const validated = validateCommandEnvelope(envelope());
    expect(validated).toMatchObject({
      operation: 'feature.plan.revise',
      scope: { kind: 'project', projectId: PROJECT_ID },
      expectedRevision: 1,
    });
    expect(validated.payload).toMatchObject({ featureId: FEATURE_ID });
  });

  it('payload 严格未知键拒绝：planRevision/status/approval/revision 等混入即 invalid_input', () => {
    const expectInvalid = (thrown: unknown, field: string): void => {
      expect(thrown).toMatchObject({ code: 'invalid_input' });
      expect((thrown as PublicError).details?.field).toBe(field);
    };
    for (const [key, value] of [
      ['planStatus', 'approved'],
      ['status', 'draft'],
      ['revision', 2],
      ['expectedRevision', 2],
      ['approval', { approved: true }],
      ['phaseId', 'phase-1'],
    ] as const) {
      try {
        validateCommandEnvelope(
          envelope({ payload: { featureId: FEATURE_ID, plan: chainPlan(), [key]: value } }),
        );
        throw new Error(`expected PublicError for payload.${key}`);
      } catch (error) {
        expectInvalid(error, `payload.${key}`);
      }
    }
  });

  it('featureId 复用稳定 ID 规则；plan 必须是 JSON 对象', () => {
    const thrownOf = (run: () => unknown): unknown =>
      run();
    let badId: unknown;
    try {
      thrownOf(() => validateCommandEnvelope(envelope({ payload: { featureId: 'bad id', plan: chainPlan() } })));
      throw new Error('expected failure');
    } catch (error) {
      badId = error;
    }
    expect(badId).toMatchObject({ code: 'invalid_input' });
    expect((badId as PublicError).details?.field).toBe('payload.featureId');

    let badPlan: unknown;
    try {
      thrownOf(() => validateCommandEnvelope(envelope({ payload: { featureId: FEATURE_ID, plan: [] } })));
      throw new Error('expected failure');
    } catch (error) {
      badPlan = error;
    }
    expect(badPlan).toMatchObject({ code: 'invalid_input' });
    expect((badPlan as PublicError).details?.field).toBe('payload.plan');
  });
});

describe('F-008 替换原语输入纯校验（严格未知键、结构/边界/依赖语义）', () => {
  it('合法替换输入通过（最终成员/边集合 + Feature 业务面 + 修订后 planStatus）', () => {
    const valid = validateReplaceFeaturePlanInput(replaceInput(), 'PlanStoreTest.replaceFeaturePlan');
    expect(valid.projectId).toBe(PROJECT_ID);
    expect(valid.featureId).toBe(FEATURE_ID);
    expect(valid.expectedRevision).toBe(1);
    expect(valid.feature.planStatus).toBe('draft');
    expect(valid.tasks.map(task => task.id)).toEqual(['t-1', 't-2', 't-3']);
    expect(valid.dependencies).toEqual([
      { taskId: 't-2', dependsOnId: 't-1' },
      { taskId: 't-3', dependsOnId: 't-2' },
    ]);
  });

  it('顶层/嵌套严格未知键拒绝（mode/status/created/成员身份字段不经输入面）', () => {
    validationFailure(
      () => validateReplaceFeaturePlanInput(replaceInput({ planStatus: 'draft' }), 'PlanStoreTest.replaceFeaturePlan'),
      'input',
    );
    validationFailure(
      () => validateReplaceFeaturePlanInput(replaceInput({ status: 'draft' }), 'PlanStoreTest.replaceFeaturePlan'),
      'input',
    );
    validationFailure(
      () =>
        validateReplaceFeaturePlanInput(
          replaceInput({ feature: { ...((replaceInput() as { feature: Record<string, unknown> }).feature), status: 'draft' } }),
          'PlanStoreTest.replaceFeaturePlan',
        ),
      'feature',
    );
    validationFailure(
      () =>
        validateReplaceFeaturePlanInput(
          replaceInput({
            tasks: [
              ...((replaceInput() as { tasks: Record<string, unknown>[] }).tasks).slice(0, 2),
              { ...((replaceInput() as { tasks: Record<string, unknown>[] }).tasks)[2], mode: 'keep' },
            ],
          }),
          'PlanStoreTest.replaceFeaturePlan',
        ),
      'tasks[2]',
    );
  });

  it('expectedRevision 必须 ≥1 安全整数；planStatus 限冻结枚举', () => {
    validationFailure(
      () => validateReplaceFeaturePlanInput(replaceInput({ expectedRevision: 0 }), 'PlanStoreTest.replaceFeaturePlan'),
      'expectedRevision',
    );
    validationFailure(
      () => validateReplaceFeaturePlanInput(replaceInput({ expectedRevision: 1.5 }), 'PlanStoreTest.replaceFeaturePlan'),
      'expectedRevision',
    );
    validationFailure(
      () =>
        validateReplaceFeaturePlanInput(
          replaceInput({
            feature: { ...((replaceInput() as { feature: Record<string, unknown> }).feature), planStatus: 'approved!' },
          }),
          'PlanStoreTest.replaceFeaturePlan',
        ),
      'feature.planStatus',
    );
  });

  it('重复 Task ID、自依赖、重复边、指向集合外任务的边一律拒绝', () => {
    const base = replaceInput() as { tasks: Record<string, unknown>[]; dependencies: Record<string, unknown>[] };
    validationFailure(
      () =>
        validateReplaceFeaturePlanInput(
          replaceInput({ tasks: [...base.tasks, { ...base.tasks[0]! }] }),
          'PlanStoreTest.replaceFeaturePlan',
        ),
      'tasks[3].id',
    );
    validationFailure(
      () =>
        validateReplaceFeaturePlanInput(
          replaceInput({ dependencies: [{ taskId: 't-1', dependsOnId: 't-1' }] }),
          'PlanStoreTest.replaceFeaturePlan',
        ),
      'dependencies[0].dependsOnId',
    );
    validationFailure(
      () =>
        validateReplaceFeaturePlanInput(
          replaceInput({ dependencies: [...base.dependencies, { taskId: 't-2', dependsOnId: 't-1' }] }),
          'PlanStoreTest.replaceFeaturePlan',
        ),
      'dependencies[2]',
    );
    validationFailure(
      () =>
        validateReplaceFeaturePlanInput(
          replaceInput({ dependencies: [...base.dependencies, { taskId: 't-x', dependsOnId: 't-1' }] }),
          'PlanStoreTest.replaceFeaturePlan',
        ),
      'dependencies[2].taskId',
    );
  });

  it('成员数/边数复用计划边界常量（越界拒绝，防御纵深）', () => {
    // 任务数越界：PLAN_TASKS_MAX_COUNT+1 个成员。
    const manyTaskPlan = validateFeaturePlanInput({
      schemaVersion: 1,
      feature: { title: 'x' },
      tasks: Array.from({ length: PLAN_TASKS_MAX_COUNT }, (_v, index) => ({
        id: `t-${index}`,
        title: `任务${index}`,
        acceptance: { criteria: ['a'] },
      })),
    });
    const tasks = manyTaskPlan.tasks.map(task => ({
      id: task.id,
      title: task.title,
      description: null,
      labels: [] as string[],
      acceptance: { criteria: [...task.acceptance.criteria] },
      requirementsRefs: [] as unknown[],
      executionConfig: {},
      configSource: 'global_default',
      configSourceKey: null,
    }));
    validationFailure(
      () =>
        validateReplaceFeaturePlanInput(
          replaceInput({ tasks: [...tasks, { ...tasks[0]!, id: 't-extra' }] }),
          'PlanStoreTest.replaceFeaturePlan',
        ),
      'tasks',
    );
    // 边数越界：21 个成员全序对 = 210 条边 > PLAN_DEPENDENCY_EDGES_MAX_COUNT。
    const denseEdges: { taskId: string; dependsOnId: string }[] = [];
    for (let i = 1; i < 21; i += 1) {
      for (let j = 0; j < i; j += 1) {
        denseEdges.push({ taskId: `t-${i}`, dependsOnId: `t-${j}` });
      }
    }
    expect(denseEdges).toHaveLength(210);
    validationFailure(
      () =>
        validateReplaceFeaturePlanInput(
          replaceInput({ tasks: tasks.slice(0, 21), dependencies: denseEdges }),
          'PlanStoreTest.replaceFeaturePlan',
        ),
      'dependencies',
    );
  });

  it('策略副本形态受限（普通 JSON 对象 + 字节上限），来源说明非空', () => {
    const base = replaceInput() as { tasks: Record<string, unknown>[] };
    validationFailure(
      () =>
        validateReplaceFeaturePlanInput(
          replaceInput({ tasks: [{ ...base.tasks[0]!, executionConfig: 'not-object' }, ...base.tasks.slice(1)] }),
          'PlanStoreTest.replaceFeaturePlan',
        ),
      'tasks[0].executionConfig',
    );
    validationFailure(
      () =>
        validateReplaceFeaturePlanInput(
          replaceInput({
            tasks: [
              { ...base.tasks[0]!, executionConfig: { blob: 'x'.repeat(EXECUTION_CONFIG_MAX_BYTES) } },
              ...base.tasks.slice(1),
            ],
          }),
          'PlanStoreTest.replaceFeaturePlan',
        ),
      'tasks[0].executionConfig',
    );
    validationFailure(
      () =>
        validateReplaceFeaturePlanInput(
          replaceInput({ tasks: [{ ...base.tasks[0]!, configSource: '  ' }, ...base.tasks.slice(1)] }),
          'PlanStoreTest.replaceFeaturePlan',
        ),
      'tasks[0].configSource',
    );
  });
});
