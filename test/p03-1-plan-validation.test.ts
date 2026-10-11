/**
 * F-001 单 Feature 草稿计划输入的运行时校验行为回归（纯函数，无 I/O）。
 *
 * 覆盖（F-001 验收）：
 * - 合法三 Task 链通过纯校验：规范化输出（labels/描述/缺省数组）、任务数、可执行标志
 *   与摘要形态；零 Task 计划可校验为草稿但明确不可执行；
 * - 结构负例：非对象/未知 schemaVersion/未知键（含 payload 携带 expectedRevision 的
 *   CAS 纪律负例、归属字段不得进入计划 payload）、缺 Feature/Task 名称、缺完整
 *   acceptance、非法 complexity/标签、引用形态非法；
 * - 边界：任务数、依赖边数、标题/描述/验收正文长度、验收条数、引用数量的边界值与
 *   越界值均有断言（边界值通过、越界拒绝）；
 * - 同 Feature DAG 负例：重复 ID、缺依赖、跨 Feature 依赖（externalTasks 解析上下文）、
 *   自依赖、重复依赖、环，全部返回带字段或节点定位的脱敏错误；
 * - 错误不回显输入正文（details 只有 field/reason/定位键/receivedType）。
 *
 * 本套件不触库、不生成 Run/审批/模型调用；归属与引用存在性重核属 F-005 事务提交。
 */
import { describe, expect, it } from 'vitest';
import { StorageError, isStorageError } from '../packages/core/src/ports/errors.ts';
import {
  FEATURE_PLAN_SCHEMA_VERSION,
  PLAN_ACCEPTANCE_CRITERIA_MAX_COUNT,
  PLAN_ACCEPTANCE_STATEMENT_MAX_LENGTH,
  PLAN_DEPENDENCY_EDGES_MAX_COUNT,
  PLAN_FEATURE_SOURCE_REFS_MAX_COUNT,
  PLAN_TASK_REQUIREMENTS_REFS_MAX_COUNT,
  PLAN_TASKS_MAX_COUNT,
  PLAN_TITLE_MAX_LENGTH,
  validateFeaturePlanInput,
} from '../packages/core/src/ports/feature-plan.ts';
import { DESCRIPTION_MAX_LENGTH } from '../packages/core/src/ports/validation.ts';

void FEATURE_PLAN_SCHEMA_VERSION;
void PLAN_ACCEPTANCE_CRITERIA_MAX_COUNT;
void PLAN_ACCEPTANCE_STATEMENT_MAX_LENGTH;
void PLAN_DEPENDENCY_EDGES_MAX_COUNT;
void PLAN_FEATURE_SOURCE_REFS_MAX_COUNT;
void PLAN_TASK_REQUIREMENTS_REFS_MAX_COUNT;
void PLAN_TASKS_MAX_COUNT;
void PLAN_TITLE_MAX_LENGTH;

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function validPlanInput(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: '计划导入契约',
      description: '单个 Feature 的草稿计划输入。',
      labels: ['P03', 'p03'],
      sourceRefs: [{ artifactId: 'art-req-1', contentHash: 'a'.repeat(64) }],
    },
    tasks: [
      {
        id: 't-1',
        title: '建立校验模块',
        description: '端口层纯校验。',
        labels: ['Core'],
        complexity: 'medium',
        acceptance: { criteria: ['导出的校验函数可被测试调用', '错误携带字段定位'] },
        requirementsRefs: [{ artifactId: 'art-req-t1' }],
      },
      {
        id: 't-2',
        title: '建立 DAG 校验',
        complexity: 'low',
        acceptance: { criteria: ['环检测返回节点定位'] },
        requirementsRefs: [{ artifactId: 'art-req-t2' }, { artifactId: 'art-req-t3' }],
        dependsOn: ['t-1'],
      },
      {
        id: 't-3',
        title: '建立摘要计算',
        complexity: 'high',
        acceptance: { criteria: ['相同业务计划摘要一致', '业务依据变化摘要改变'] },
        dependsOn: ['t-2'],
      },
    ],
  };
}

/** 以交错键序构造同一业务计划（JSON 键序不影响校验与摘要）。 */
function permutedKeyOrderPlan(): Record<string, unknown> {
  return {
    tasks: [
      { dependsOn: ['t-2'], acceptance: { criteria: ['相同业务计划摘要一致', '业务依据变化摘要改变'] }, complexity: 'high', title: '建立摘要计算', id: 't-3' },
      { title: '建立校验模块', requirementsRefs: [{ artifactId: 'art-req-t1' }], acceptance: { criteria: ['导出的校验函数可被测试调用', '错误携带字段定位'] }, description: '端口层纯校验。', labels: ['Core'], id: 't-1', complexity: 'medium' },
      { dependsOn: ['t-1'], requirementsRefs: [{ artifactId: 'art-req-t3' }, { artifactId: 'art-req-t2' }], acceptance: { criteria: ['环检测返回节点定位'] }, complexity: 'low', title: '建立 DAG 校验', id: 't-2' },
    ],
    feature: { sourceRefs: [{ contentHash: 'a'.repeat(64), artifactId: 'art-req-1' }], labels: ['P03', 'p03'], description: '单个 Feature 的草稿计划输入。', title: '计划导入契约' },
    schemaVersion: 1,
  };
}

/** n 个任务的链式计划（t-1 无依赖，其余依赖前一个）。 */
function chainPlanInput(count: number): Record<string, unknown> {
  const tasks: Record<string, unknown>[] = [];
  for (let index = 1; index <= count; index += 1) {
    tasks.push({
      id: `t-${index.toString().padStart(3, '0')}`,
      title: `任务 ${index}`,
      acceptance: { criteria: [`验收 ${index}`] },
      ...(index > 1 ? { dependsOn: [`t-${(index - 1).toString().padStart(3, '0')}`] } : {}),
    });
  }
  return { schemaVersion: 1, feature: { title: '批量计划' }, tasks };
}

/** 50 个无依赖任务 + k 个各依赖 4 个前置的任务；返回 (input, edgeCount)。 */
function widePlanInput(dependentTasks: number, extraFirstDeps: string[] = []): { input: Record<string, unknown>; edges: number } {
  const sources: Record<string, unknown>[] = [];
  for (let index = 1; index <= 50; index += 1) {
    sources.push({ id: `a-${index.toString().padStart(2, '0')}`, title: `源任务 ${index}`, acceptance: { criteria: [`验收 a${index}`] } });
  }
  const dependents: Record<string, unknown>[] = [];
  let edges = 0;
  for (let index = 1; index <= dependentTasks; index += 1) {
    const deps = index === 1 ? [`a-01`, `a-02`, `a-03`, `a-04`, ...extraFirstDeps] : [`a-05`, `a-06`, `a-07`, `a-08`];
    edges += deps.length;
    dependents.push({ id: `b-${index.toString().padStart(2, '0')}`, title: `下游任务 ${index}`, acceptance: { criteria: [`验收 b${index}`] }, dependsOn: deps });
  }
  return { input: { schemaVersion: 1, feature: { title: '宽计划' }, tasks: [...sources, ...dependents] }, edges };
}

function expectValidationFailure(fn: () => unknown): StorageError {
  try {
    fn();
  } catch (error) {
    expect(isStorageError(error, 'validation'), `expected StorageError(validation), got ${String(error)}`).toBe(true);
    return error as StorageError;
  }
  throw new Error('expected a validation StorageError to be thrown');
}

/* ------------------------------------------------------------------ *
 * 合法输入
 * ------------------------------------------------------------------ */

describe('F-001 合法计划通过纯校验', () => {
  it('三 Task 链通过校验并返回规范化结果', () => {
    const plan = validateFeaturePlanInput(validPlanInput(), { operation: 'Test.planImport' });
    expect(plan.schemaVersion).toBe(1);
    expect(plan.taskCount).toBe(3);
    expect(plan.executable).toBe(true);
    expect(plan.tasks.map((task) => task.id)).toEqual(['t-1', 't-2', 't-3']);
    expect(plan.tasks[1]?.dependsOn).toEqual(['t-1']);
    expect(plan.dependencyEdgeCount).toBe(2);
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.feature.title).toBe('计划导入契约');
    // 标签规范化：去重 + ASCII 小写；非 ASCII 保留。
    expect(plan.feature.labels).toEqual(['p03']);
    expect(plan.tasks[0]?.labels).toEqual(['core']);
  });

  it('缺省字段归一：labels/dependsOn/requirementsRefs/sourceRefs 为空数组，省略与 null 描述为 null', () => {
    const plan = validateFeaturePlanInput({
      schemaVersion: 1,
      feature: { title: '最小计划', description: null },
      tasks: [{ id: 't-only', title: '唯一任务', acceptance: { criteria: ['一条验收'] }, description: '   ', complexity: null }],
    });
    expect(plan.feature.description).toBeNull();
    expect(plan.feature.labels).toEqual([]);
    expect(plan.feature.sourceRefs).toEqual([]);
    const [task] = plan.tasks;
    expect(task?.description).toBeNull();
    expect(task?.complexity).toBeNull();
    expect(task?.labels).toEqual([]);
    expect(task?.requirementsRefs).toEqual([]);
    expect(task?.dependsOn).toEqual([]);
  });

  it('JSON 键序与任务输入顺序变化不改变规范化结果与摘要', () => {
    const a = validateFeaturePlanInput(validPlanInput());
    const b = validateFeaturePlanInput(permutedKeyOrderPlan());
    expect(b.planDigest).toBe(a.planDigest);
    expect(b.tasks.map((task) => task.id)).toEqual(a.tasks.map((task) => task.id));
    // 验收条目保持输入顺序（有序清单），仅在规范化层做 trim。
    expect(b.tasks[0]?.acceptance.criteria).toEqual(a.tasks[0]?.acceptance.criteria);
  });
});

describe('F-001 零 Task 草稿', () => {
  it('无 Task 的计划可校验为草稿，但明确不可执行', () => {
    const plan = validateFeaturePlanInput({ schemaVersion: 1, feature: { title: '空草稿' }, tasks: [] });
    expect(plan.taskCount).toBe(0);
    expect(plan.executable).toBe(false);
    expect(plan.dependencyEdgeCount).toBe(0);
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
    // 空草稿与省略 tasks 键同义。
    const omitted = validateFeaturePlanInput({ schemaVersion: 1, feature: { title: '空草稿' } });
    expect(omitted.taskCount).toBe(0);
    expect(omitted.planDigest).toBe(plan.planDigest);
  });
});

/* ------------------------------------------------------------------ *
 * 结构负例（字段定位）
 * ------------------------------------------------------------------ */

describe('F-001 结构校验负例', () => {
  it('顶层必须是对象且键受白名单约束（含 CAS/归属纪律）', () => {
    for (const [label, value] of [
      ['非对象', 'nope'],
      ['数组', []],
      ['null', null],
    ] as const) {
      const error = expectValidationFailure(() => validateFeaturePlanInput(value));
      expect(error.details?.field).toBe('input');
      expect(label).toBeTruthy();
    }

    const missingVersion = expectValidationFailure(() => validateFeaturePlanInput({ feature: { title: 'x' }, tasks: [] }));
    expect(missingVersion.details?.field).toBe('schemaVersion');

    const badVersion = expectValidationFailure(() =>
      validateFeaturePlanInput({ schemaVersion: 2, feature: { title: 'x' }, tasks: [] }),
    );
    expect(badVersion.details?.field).toBe('schemaVersion');
    expect(String(badVersion.details?.reason)).toContain('1');

    // expectedRevision 的唯一权威来源是命令信封；payload 携带即拒绝（两个 CAS 权威来源）。
    const dualCas = expectValidationFailure(() =>
      validateFeaturePlanInput({ schemaVersion: 1, feature: { title: 'x' }, tasks: [], expectedRevision: 3 }),
    );
    expect(String(dualCas.details?.reason)).toContain('expectedRevision');

    // 归属字段（projectId/phaseId/featureId）不属于计划 payload，由命令信封与导入事务处理。
    for (const ownershipKey of ['projectId', 'phaseId', 'featureId', 'revision', 'createdAtUtcMs', 'updatedAtUtcMs']) {
      const error = expectValidationFailure(() =>
        validateFeaturePlanInput({ schemaVersion: 1, feature: { title: 'x' }, tasks: [], [ownershipKey]: 'p-1' }),
      );
      expect(String(error.details?.reason)).toContain(ownershipKey);
    }
  });

  it('Feature/Task 标题必填且有长度上限（边界值通过、越界拒绝）', () => {
    const boundaryTitle = '标'.repeat(200);
    const ok = validateFeaturePlanInput({
      schemaVersion: 1,
      feature: { title: boundaryTitle },
      tasks: [{ id: 't-1', title: boundaryTitle, acceptance: { criteria: ['ok'] } }],
    });
    expect(ok.feature.title).toBe(boundaryTitle);

    const featureOver = expectValidationFailure(() =>
      validateFeaturePlanInput({ schemaVersion: 1, feature: { title: '标'.repeat(201) }, tasks: [] }),
    );
    expect(featureOver.details?.field).toBe('feature.title');

    const taskBlank = expectValidationFailure(() =>
      validateFeaturePlanInput({ schemaVersion: 1, feature: { title: 'f' }, tasks: [{ id: 't-1', title: '   ', acceptance: { criteria: ['ok'] } }] }),
    );
    expect(taskBlank.details?.field).toBe('tasks[0].title');

    const taskMissing = expectValidationFailure(() =>
      validateFeaturePlanInput({ schemaVersion: 1, feature: { title: 'f' }, tasks: [{ id: 't-1', acceptance: { criteria: ['ok'] } }] }),
    );
    expect(taskMissing.details?.field).toBe('tasks[0].title');

    const taskOver = expectValidationFailure(() =>
      validateFeaturePlanInput({ schemaVersion: 1, feature: { title: 'f' }, tasks: [{ id: 't-1', title: '标'.repeat(201), acceptance: { criteria: ['ok'] } }] }),
    );
    expect(taskOver.details?.field).toBe('tasks[0].title');
  });

  it('任务数量边界：100 通过、101 拒绝', () => {
    const boundary = validateFeaturePlanInput(chainPlanInput(100));
    expect(boundary.taskCount).toBe(100);
    expect(boundary.dependencyEdgeCount).toBe(99);
    const error = expectValidationFailure(() => validateFeaturePlanInput(chainPlanInput(101)));
    expect(error.details?.field).toBe('tasks');
    expect(String(error.details?.reason)).toContain('100');
  });

  it('acceptance 必须完整：缺失/空清单/空白条目/超条数/超长正文均拒绝（边界值通过）', () => {
    const statement = '验'.repeat(2000);
    const boundary = validateFeaturePlanInput({
      schemaVersion: 1,
      feature: { title: 'f' },
      tasks: [{ id: 't-1', title: '边界任务', acceptance: { criteria: [statement] } }],
    });
    expect(boundary.tasks[0]?.acceptance.criteria).toEqual([statement]);
    const countBoundary = validateFeaturePlanInput({
      schemaVersion: 1,
      feature: { title: 'f' },
      tasks: [{ id: 't-1', title: '边界任务', acceptance: { criteria: Array.from({ length: 32 }, (_, index) => `c-${index}`) } }],
    });
    expect(countBoundary.tasks[0]?.acceptance.criteria).toHaveLength(32);

    const missing = expectValidationFailure(() =>
      validateFeaturePlanInput({ schemaVersion: 1, feature: { title: 'f' }, tasks: [{ id: 't-1', title: 'x' }] }),
    );
    expect(missing.details?.field).toBe('tasks[0].acceptance');

    const empty = expectValidationFailure(() =>
      validateFeaturePlanInput({ schemaVersion: 1, feature: { title: 'f' }, tasks: [{ id: 't-1', title: 'x', acceptance: { criteria: [] } }] }),
    );
    expect(empty.details?.field).toBe('tasks[0].acceptance.criteria');

    const blank = expectValidationFailure(() =>
      validateFeaturePlanInput({ schemaVersion: 1, feature: { title: 'f' }, tasks: [{ id: 't-1', title: 'x', acceptance: { criteria: ['  '] } }] }),
    );
    expect(blank.details?.field).toBe('tasks[0].acceptance.criteria[0]');

    const overCount = expectValidationFailure(() =>
      validateFeaturePlanInput({
        schemaVersion: 1,
        feature: { title: 'f' },
        tasks: [{ id: 't-1', title: 'x', acceptance: { criteria: Array.from({ length: 33 }, (_, index) => `c-${index}`) } }],
      }),
    );
    expect(overCount.details?.field).toBe('tasks[0].acceptance.criteria');
    expect(String(overCount.details?.reason)).toContain('32');

    const overLength = expectValidationFailure(() =>
      validateFeaturePlanInput({
        schemaVersion: 1,
        feature: { title: 'f' },
        tasks: [{ id: 't-1', title: 'x', acceptance: { criteria: ['验'.repeat(2001)] } }],
      }),
    );
    expect(overLength.details?.field).toBe('tasks[0].acceptance.criteria[0]');
  });

  it('description 边界：10000 码点通过、10001 拒绝（Feature 与 Task 共用规则）', () => {
    const boundary = '描'.repeat(DESCRIPTION_MAX_LENGTH);
    const ok = validateFeaturePlanInput({
      schemaVersion: 1,
      feature: { title: 'f', description: boundary },
      tasks: [{ id: 't-1', title: 'x', description: boundary, acceptance: { criteria: ['ok'] } }],
    });
    expect(ok.feature.description).toBe(boundary);
    expect(ok.tasks[0]?.description).toBe(boundary);

    for (const field of ['feature.description', 'tasks[0].description'] as const) {
      const input =
        field === 'feature.description'
          ? { schemaVersion: 1, feature: { title: 'f', description: '描'.repeat(DESCRIPTION_MAX_LENGTH + 1) }, tasks: [] }
          : { schemaVersion: 1, feature: { title: 'f' }, tasks: [{ id: 't-1', title: 'x', description: '描'.repeat(DESCRIPTION_MAX_LENGTH + 1), acceptance: { criteria: ['ok'] } }] };
      const error = expectValidationFailure(() => validateFeaturePlanInput(input));
      expect(error.details?.field).toBe(field);
    }
    // 码点计数：emoji 不被记为 2（UTF-16 长度是码点数的两倍，仍应通过）。
    const emojiDescription = '😀'.repeat(DESCRIPTION_MAX_LENGTH);
    const emojiOk = validateFeaturePlanInput({
      schemaVersion: 1,
      feature: { title: 'f', description: emojiDescription },
      tasks: [],
    });
    expect([...(emojiOk.feature.description ?? '')]).toHaveLength(DESCRIPTION_MAX_LENGTH);
    expect(emojiOk.feature.description?.length).toBe(DESCRIPTION_MAX_LENGTH * 2);
  });

  it('complexity 只接受 low/medium/high（复用配置复杂度取值），非法值拒绝', () => {
    for (const complexity of ['low', 'medium', 'high'] as const) {
      const plan = validateFeaturePlanInput({
        schemaVersion: 1,
        feature: { title: 'f' },
        tasks: [{ id: 't-1', title: 'x', complexity, acceptance: { criteria: ['ok'] } }],
      });
      expect(plan.tasks[0]?.complexity).toBe(complexity);
    }
    const error = expectValidationFailure(() =>
      validateFeaturePlanInput({ schemaVersion: 1, feature: { title: 'f' }, tasks: [{ id: 't-1', title: 'x', complexity: 'urgent', acceptance: { criteria: ['ok'] } }] }),
    );
    expect(error.details?.field).toBe('tasks[0].complexity');
    expect(String(error.details?.reason)).toContain('low');
  });

  it('标签复用统一规范化规则，非法标签拒绝', () => {
    const error = expectValidationFailure(() =>
      validateFeaturePlanInput({ schemaVersion: 1, feature: { title: 'f', labels: [7] }, tasks: [] }),
    );
    expect(error.details?.field).toBe('feature.labels[0]');

    const taskLabels = expectValidationFailure(() =>
      validateFeaturePlanInput({ schemaVersion: 1, feature: { title: 'f' }, tasks: [{ id: 't-1', title: 'x', labels: ['ok', ''], acceptance: { criteria: ['ok'] } }] }),
    );
    expect(taskLabels.details?.field).toBe('tasks[0].labels[1]');
  });

  it('引用形态：artifactId 必填稳定 ID，contentHash 可选 64 位摘要；数量边界通过/越界拒绝', () => {
    const hash = 'b'.repeat(64);
    const refs = Array.from({ length: 8 }, (_, index) => ({ artifactId: `art-${index}`, contentHash: hash }));
    const sourceRefs = Array.from({ length: 16 }, (_, index) => ({ artifactId: `src-${index}`, contentHash: hash }));
    const boundary = validateFeaturePlanInput({
      schemaVersion: 1,
      feature: { title: 'f', sourceRefs },
      tasks: [{ id: 't-1', title: 'x', requirementsRefs: refs, acceptance: { criteria: ['ok'] } }],
    });
    expect(boundary.tasks[0]?.requirementsRefs).toHaveLength(8);
    expect(boundary.feature.sourceRefs).toHaveLength(16);

    const badId = expectValidationFailure(() =>
      validateFeaturePlanInput({ schemaVersion: 1, feature: { title: 'f' }, tasks: [{ id: 't-1', title: 'x', requirementsRefs: [{ artifactId: '_bad' }], acceptance: { criteria: ['ok'] } }] }),
    );
    expect(badId.details?.field).toBe('tasks[0].requirementsRefs[0].artifactId');

    const badHash = expectValidationFailure(() =>
      validateFeaturePlanInput({ schemaVersion: 1, feature: { title: 'f' }, tasks: [{ id: 't-1', title: 'x', requirementsRefs: [{ artifactId: 'art-1', contentHash: 'XYZ' }], acceptance: { criteria: ['ok'] } }] }),
    );
    expect(badHash.details?.field).toBe('tasks[0].requirementsRefs[0].contentHash');

    const overTaskRefs = expectValidationFailure(() =>
      validateFeaturePlanInput({
        schemaVersion: 1,
        feature: { title: 'f' },
        tasks: [{ id: 't-1', title: 'x', requirementsRefs: Array.from({ length: 9 }, (_, index) => ({ artifactId: `art-${index}` })), acceptance: { criteria: ['ok'] } }],
      }),
    );
    expect(overTaskRefs.details?.field).toBe('tasks[0].requirementsRefs');
    expect(String(overTaskRefs.details?.reason)).toContain('8');

    const overSourceRefs = expectValidationFailure(() =>
      validateFeaturePlanInput({
        schemaVersion: 1,
        feature: { title: 'f', sourceRefs: Array.from({ length: 17 }, (_, index) => ({ artifactId: `src-${index}` })) },
        tasks: [],
      }),
    );
    expect(overSourceRefs.details?.field).toBe('feature.sourceRefs');
    expect(String(overSourceRefs.details?.reason)).toContain('16');

    // 缺失判断：undefined/null/[] 一律归一为缺失（空数组），不报错；必需性留给导入事务。
    for (const missingForm of [undefined, null, []]) {
      const plan = validateFeaturePlanInput({
        schemaVersion: 1,
        feature: { title: 'f', sourceRefs: missingForm },
        tasks: [{ id: 't-1', title: 'x', requirementsRefs: missingForm, acceptance: { criteria: ['ok'] } }],
      });
      expect(plan.feature.sourceRefs).toEqual([]);
      expect(plan.tasks[0]?.requirementsRefs).toEqual([]);
    }
  });

  it('任务 id 必须是稳定 ID', () => {
    const missing = expectValidationFailure(() =>
      validateFeaturePlanInput({ schemaVersion: 1, feature: { title: 'f' }, tasks: [{ title: 'x', acceptance: { criteria: ['ok'] } }] }),
    );
    expect(missing.details?.field).toBe('tasks[0].id');

    const invalid = expectValidationFailure(() =>
      validateFeaturePlanInput({ schemaVersion: 1, feature: { title: 'f' }, tasks: [{ id: '-nope', title: 'x', acceptance: { criteria: ['ok'] } }] }),
    );
    expect(invalid.details?.field).toBe('tasks[0].id');
  });
});

/* ------------------------------------------------------------------ *
 * 同 Feature DAG 校验
 * ------------------------------------------------------------------ */

describe('F-001 同 Feature DAG 校验', () => {
  it('重复任务 ID 返回节点定位错误', () => {
    const error = expectValidationFailure(() =>
      validateFeaturePlanInput({
        schemaVersion: 1,
        feature: { title: 'f' },
        tasks: [
          { id: 't-1', title: 'a', acceptance: { criteria: ['ok'] } },
          { id: 't-2', title: 'b', acceptance: { criteria: ['ok'] } },
          { id: 't-1', title: 'c', acceptance: { criteria: ['ok'] } },
        ],
      }),
    );
    expect(error.details?.field).toBe('tasks[2].id');
    expect(error.details?.taskId).toBe('t-1');
    expect(String(error.details?.reason)).toContain('重复');
  });

  it('依赖目标不在计划内：缺依赖错误；提供 externalTasks 解析时报告跨 Feature 依赖', () => {
    const input = {
      schemaVersion: 1,
      feature: { title: 'f' },
      tasks: [
        { id: 't-1', title: 'a', acceptance: { criteria: ['ok'] } },
        { id: 't-2', title: 'b', acceptance: { criteria: ['ok'] }, dependsOn: ['t-1', 't-ghost'] },
      ],
    };
    const missing = expectValidationFailure(() => validateFeaturePlanInput(input));
    expect(missing.details?.field).toBe('tasks[1].dependsOn[1]');
    expect(missing.details?.taskId).toBe('t-2');
    expect(missing.details?.dependsOnTaskId).toBe('t-ghost');
    expect(String(missing.details?.reason)).toContain('缺依赖');

    const cross = expectValidationFailure(() =>
      validateFeaturePlanInput(input, { externalTasks: new Map([['t-ghost', 'f-other']]) }),
    );
    expect(cross.details?.field).toBe('tasks[1].dependsOn[1]');
    expect(cross.details?.dependsOnTaskId).toBe('t-ghost');
    expect(String(cross.details?.reason)).toContain('跨 Feature');
  });

  it('自依赖与重复依赖返回节点定位错误', () => {
    const self = expectValidationFailure(() =>
      validateFeaturePlanInput({
        schemaVersion: 1,
        feature: { title: 'f' },
        tasks: [{ id: 't-1', title: 'a', acceptance: { criteria: ['ok'] }, dependsOn: ['t-1'] }],
      }),
    );
    expect(self.details?.field).toBe('tasks[0].dependsOn[0]');
    expect(self.details?.taskId).toBe('t-1');
    expect(String(self.details?.reason)).toContain('自依赖');

    const duplicate = expectValidationFailure(() =>
      validateFeaturePlanInput({
        schemaVersion: 1,
        feature: { title: 'f' },
        tasks: [
          { id: 't-1', title: 'a', acceptance: { criteria: ['ok'] } },
          { id: 't-2', title: 'b', acceptance: { criteria: ['ok'] }, dependsOn: ['t-1', 't-1'] },
        ],
      }),
    );
    expect(duplicate.details?.field).toBe('tasks[1].dependsOn[1]');
    expect(duplicate.details?.taskId).toBe('t-2');
    expect(duplicate.details?.dependsOnTaskId).toBe('t-1');
    expect(String(duplicate.details?.reason)).toContain('重复依赖');
  });

  it('依赖环返回环路径节点定位', () => {
    const error = expectValidationFailure(() =>
      validateFeaturePlanInput({
        schemaVersion: 1,
        feature: { title: 'f' },
        tasks: [
          { id: 't-1', title: 'a', acceptance: { criteria: ['ok'] }, dependsOn: ['t-3'] },
          { id: 't-2', title: 'b', acceptance: { criteria: ['ok'] }, dependsOn: ['t-1'] },
          { id: 't-3', title: 'c', acceptance: { criteria: ['ok'] }, dependsOn: ['t-2'] },
        ],
      }),
    );
    expect(error.details?.field).toBe('tasks.dependencies');
    const cycle = error.details?.cycle;
    expect(Array.isArray(cycle)).toBe(true);
    expect((cycle as string[]).length).toBeGreaterThanOrEqual(3);
    expect(new Set(cycle as string[]).size).toBe((cycle as string[]).length - 1);
    expect(String(error.details?.reason)).toContain('环');
  });

  it('依赖边数边界：200 条通过、201 条拒绝', () => {
    const boundary = widePlanInput(50);
    expect(boundary.edges).toBe(200);
    const plan = validateFeaturePlanInput(boundary.input);
    expect(plan.dependencyEdgeCount).toBe(200);

    const over = widePlanInput(50, ['b-02']);
    expect(over.edges).toBe(201);
    const error = expectValidationFailure(() => validateFeaturePlanInput(over.input));
    expect(error.details?.field).toBe('tasks.dependencies');
    expect(String(error.details?.reason)).toContain('200');
  });

  it('dependsOn 元素必须是字符串', () => {
    const error = expectValidationFailure(() =>
      validateFeaturePlanInput({
        schemaVersion: 1,
        feature: { title: 'f' },
        tasks: [
          { id: 't-1', title: 'a', acceptance: { criteria: ['ok'] } },
          { id: 't-2', title: 'b', acceptance: { criteria: ['ok'] }, dependsOn: [42] },
        ],
      }),
    );
    expect(error.details?.field).toBe('tasks[1].dependsOn[0]');
  });
});

/* ------------------------------------------------------------------ *
 * 脱敏
 * ------------------------------------------------------------------ */

describe('F-001 错误脱敏', () => {
  it('错误不回显输入正文，只携带字段/原因/定位与 receivedType', () => {
    const secretBody = '机密正文'.repeat(3000);
    expect(secretBody.length).toBeGreaterThan(DESCRIPTION_MAX_LENGTH);
    const error = expectValidationFailure(() =>
      validateFeaturePlanInput({
        schemaVersion: 1,
        feature: { title: 'f', description: secretBody },
        tasks: [],
      }),
    );
    const serialized = `${error.message}${JSON.stringify(error.details ?? {})}`;
    expect(serialized).not.toContain('机密正文');
    expect(Object.keys(error.details ?? {})).toEqual(
      expect.arrayContaining(['field', 'reason', 'receivedType']),
    );
  });
});
