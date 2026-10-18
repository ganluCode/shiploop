/**
 * F-001 确定性业务计划摘要（planDigest）行为回归（纯函数，无 I/O）。
 *
 * 覆盖（F-001 验收）：
 * - 规范化后的相同业务计划在 JSON 键序、Task 输入顺序、依赖边输入顺序、引用输入
 *   顺序变化时摘要一致；
 * - 需求引用、验收、业务描述、依赖、标题、complexity 等已约定执行依据变化时摘要
 *   改变；验收条目顺序视为业务顺序，变化亦改变摘要；
 * - 纯标签变化、revision/时间戳/策略来源说明（无法进入计划 payload 的字段）不改变
 *   业务摘要；缺省形态（null/省略/空数组）归一到同一摘要；
 * - 摘要是 64 位小写十六进制 SHA-256，等于对领域前缀 + 规范化业务 JSON 的 SHA-256；
 *   规范化 JSON 只含业务字段（不含 labels/信封字段），本身是可解析的 JSON。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PLAN_DIGEST_DOMAIN,
  canonicalFeaturePlanBusinessJson,
  computeFeaturePlanDigest,
  validateFeaturePlanInput,
} from '../../../packages/core/src/ports/feature-plan.ts';

function baseInput(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: {
      title: '摘要契约',
      description: '业务描述。',
      labels: ['draft'],
      sourceRefs: [{ artifactId: 'art-1', contentHash: 'a'.repeat(64) }, { artifactId: 'art-2' }],
    },
    tasks: [
      {
        id: 't-1',
        title: '第一项',
        description: '业务正文一。',
        labels: ['x'],
        complexity: 'low',
        acceptance: { criteria: ['验收一', '验收二'] },
        requirementsRefs: [{ artifactId: 'art-3' }],
      },
      {
        id: 't-2',
        title: '第二项',
        complexity: 'high',
        acceptance: { criteria: ['验收三'] },
        dependsOn: ['t-1'],
      },
    ],
  };
}

function digestOf(input: Record<string, unknown>): string {
  return validateFeaturePlanInput(input).planDigest;
}

describe('F-001 摘要顺序无关性', () => {
  it('JSON 键序、任务顺序、依赖边顺序、引用顺序变化摘要一致', () => {
    const base = digestOf(baseInput());
    const permuted = digestOf({
      tasks: [
        {
          dependsOn: ['t-1'],
          acceptance: { criteria: ['验收三'] },
          complexity: 'high',
          title: '第二项',
          id: 't-2',
        },
        {
          requirementsRefs: [{ artifactId: 'art-3' }],
          acceptance: { criteria: ['验收一', '验收二'] },
          complexity: 'low',
          labels: ['x'],
          description: '业务正文一。',
          title: '第一项',
          id: 't-1',
        },
      ],
      feature: {
        sourceRefs: [{ artifactId: 'art-2' }, { contentHash: 'a'.repeat(64), artifactId: 'art-1' }],
        labels: ['draft'],
        description: '业务描述。',
        title: '摘要契约',
      },
      schemaVersion: 1,
    });
    expect(permuted).toBe(base);
  });

  it('缺省形态归一：省略与 null、空数组与缺省、重复引用去重后摘要一致', () => {
    const base = digestOf({
      schemaVersion: 1,
      feature: { title: '归一' },
      tasks: [{ id: 't-1', title: 'a', description: null, complexity: null, acceptance: { criteria: ['c'] } }],
    });
    const omitted = digestOf({
      schemaVersion: 1,
      feature: { title: '归一', description: null, labels: [], sourceRefs: [] },
      tasks: [{ id: 't-1', title: 'a', acceptance: { criteria: ['c'] }, requirementsRefs: [], dependsOn: [], labels: [] }],
    });
    expect(omitted).toBe(base);

    const dedupRefs = digestOf({
      schemaVersion: 1,
      feature: { title: '归一', sourceRefs: [{ artifactId: 's-1' }, { artifactId: 's-1' }] },
      tasks: [{ id: 't-1', title: 'a', acceptance: { criteria: ['c'] } }],
    });
    const singleRef = digestOf({
      schemaVersion: 1,
      feature: { title: '归一', sourceRefs: [{ artifactId: 's-1' }] },
      tasks: [{ id: 't-1', title: 'a', acceptance: { criteria: ['c'] } }],
    });
    expect(dedupRefs).toBe(singleRef);
    expect(dedupRefs).not.toBe(base);
  });
});

describe('F-001 摘要业务敏感性', () => {
  it('已约定执行依据变化改变摘要', () => {
    const base = digestOf(baseInput());
    const cases: Array<[string, Record<string, unknown>]> = [
      ['Feature 标题', { feature: { title: '摘要契约改', description: '业务描述。', labels: ['draft'], sourceRefs: [{ artifactId: 'art-1', contentHash: 'a'.repeat(64) }, { artifactId: 'art-2' }] } }],
      ['Feature 业务描述', { feature: { title: '摘要契约', description: '业务描述改。', labels: ['draft'], sourceRefs: [{ artifactId: 'art-1', contentHash: 'a'.repeat(64) }, { artifactId: 'art-2' }] } }],
      ['Feature 来源引用', { feature: { title: '摘要契约', description: '业务描述。', labels: ['draft'], sourceRefs: [{ artifactId: 'art-1', contentHash: 'b'.repeat(64) }, { artifactId: 'art-2' }] } }],
      ['Task 标题', { tasks: [{ id: 't-1', title: '第一项改', description: '业务正文一。', complexity: 'low', acceptance: { criteria: ['验收一', '验收二'] }, requirementsRefs: [{ artifactId: 'art-3' }] }, { id: 't-2', title: '第二项', complexity: 'high', acceptance: { criteria: ['验收三'] }, dependsOn: ['t-1'] }], feature: baseInput().feature }],
      ['Task 业务描述', { tasks: [{ id: 't-1', title: '第一项', description: '业务正文一改。', complexity: 'low', acceptance: { criteria: ['验收一', '验收二'] }, requirementsRefs: [{ artifactId: 'art-3' }] }, { id: 't-2', title: '第二项', complexity: 'high', acceptance: { criteria: ['验收三'] }, dependsOn: ['t-1'] }], feature: baseInput().feature }],
      ['Task 复杂度', { tasks: [{ id: 't-1', title: '第一项', description: '业务正文一。', complexity: 'medium', acceptance: { criteria: ['验收一', '验收二'] }, requirementsRefs: [{ artifactId: 'art-3' }] }, { id: 't-2', title: '第二项', complexity: 'high', acceptance: { criteria: ['验收三'] }, dependsOn: ['t-1'] }], feature: baseInput().feature }],
      ['验收内容', { tasks: [{ id: 't-1', title: '第一项', description: '业务正文一。', complexity: 'low', acceptance: { criteria: ['验收一', '验收二改'] }, requirementsRefs: [{ artifactId: 'art-3' }] }, { id: 't-2', title: '第二项', complexity: 'high', acceptance: { criteria: ['验收三'] }, dependsOn: ['t-1'] }], feature: baseInput().feature }],
      ['验收条数', { tasks: [{ id: 't-1', title: '第一项', description: '业务正文一。', complexity: 'low', acceptance: { criteria: ['验收一'] }, requirementsRefs: [{ artifactId: 'art-3' }] }, { id: 't-2', title: '第二项', complexity: 'high', acceptance: { criteria: ['验收三'] }, dependsOn: ['t-1'] }], feature: baseInput().feature }],
      ['需求引用', { tasks: [{ id: 't-1', title: '第一项', description: '业务正文一。', complexity: 'low', acceptance: { criteria: ['验收一', '验收二'] }, requirementsRefs: [{ artifactId: 'art-3', contentHash: 'c'.repeat(64) }] }, { id: 't-2', title: '第二项', complexity: 'high', acceptance: { criteria: ['验收三'] }, dependsOn: ['t-1'] }], feature: baseInput().feature }],
      ['依赖边', { tasks: [{ id: 't-1', title: '第一项', description: '业务正文一。', complexity: 'low', acceptance: { criteria: ['验收一', '验收二'] }, requirementsRefs: [{ artifactId: 'art-3' }] }, { id: 't-2', title: '第二项', complexity: 'high', acceptance: { criteria: ['验收三'] } }], feature: baseInput().feature }],
      ['任务 ID', { tasks: [{ id: 't-0', title: '第一项', description: '业务正文一。', complexity: 'low', acceptance: { criteria: ['验收一', '验收二'] }, requirementsRefs: [{ artifactId: 'art-3' }] }, { id: 't-2', title: '第二项', complexity: 'high', acceptance: { criteria: ['验收三'] }, dependsOn: ['t-0'] }], feature: baseInput().feature }],
    ];
    for (const [label, patch] of cases) {
      const input = { ...baseInput(), ...patch } as Record<string, unknown>;
      expect(digestOf(input), label).not.toBe(base);
    }
  });

  it('验收条目顺序是业务顺序：倒序改变摘要', () => {
    const base = digestOf(baseInput());
    const reversed = digestOf({
      ...baseInput(),
      tasks: [
        { id: 't-1', title: '第一项', description: '业务正文一。', complexity: 'low', acceptance: { criteria: ['验收二', '验收一'] }, requirementsRefs: [{ artifactId: 'art-3' }] },
        { id: 't-2', title: '第二项', complexity: 'high', acceptance: { criteria: ['验收三'] }, dependsOn: ['t-1'] },
      ],
    });
    expect(reversed).not.toBe(base);
  });

  it('纯标签变化不改变业务摘要（Feature 与 Task 标签均不参与摘要）', () => {
    const base = digestOf(baseInput());
    const baseTasks = baseInput().tasks as Record<string, unknown>[];
    const relabeled = digestOf({
      ...baseInput(),
      feature: { ...(baseInput().feature as Record<string, unknown>), labels: [] },
      tasks: [
        { ...baseTasks[0], labels: ['y', 'z'] },
        { ...baseTasks[1], labels: ['anything'] },
      ],
    });
    expect(relabeled).toBe(base);
  });

  it('revision/时间戳/策略来源说明无法进入计划 payload（未知键拒绝），因此不可能影响摘要', () => {
    for (const forbidden of ['revision', 'expectedRevision', 'createdAtUtcMs', 'updatedAtUtcMs', 'configSource', 'configSourceKey', 'executionConfig', 'strategySourceNote']) {
      const input = { ...baseInput(), [forbidden]: 1 };
      expect(() => validateFeaturePlanInput(input), forbidden).toThrowError(/FeaturePlan|unknown|未知|字段/);
    }
  });
});

describe('F-001 摘要构造', () => {
  it('摘要等于对领域前缀 + 规范化业务 JSON 的 SHA-256（64 位小写十六进制）', () => {
    const plan = validateFeaturePlanInput(baseInput());
    const canonical = canonicalFeaturePlanBusinessJson(plan);
    expect(() => JSON.parse(canonical)).not.toThrow();
    const manual = createHash('sha256')
      .update(`${PLAN_DIGEST_DOMAIN}\n${canonical}`, 'utf8')
      .digest('hex');
    expect(plan.planDigest).toBe(manual);
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(computeFeaturePlanDigest(plan)).toBe(plan.planDigest);
  });

  it('规范化业务 JSON 只含业务字段，不含标签/信封/策略来源字段', () => {
    const plan = validateFeaturePlanInput(baseInput());
    const parsed = JSON.parse(canonicalFeaturePlanBusinessJson(plan)) as {
      feature: Record<string, unknown>;
      tasks: Array<Record<string, unknown>>;
    };
    expect(Object.keys(parsed.feature).sort()).toEqual(['description', 'sourceRefs', 'title']);
    expect([...parsed.tasks].map((task) => Object.keys(task).sort())).toEqual([
      ['acceptance', 'complexity', 'dependsOn', 'description', 'id', 'requirementsRefs', 'title'],
      ['acceptance', 'complexity', 'dependsOn', 'description', 'id', 'requirementsRefs', 'title'],
    ]);
  });

  it('任务在规范化 JSON 中按稳定 ID 排序，依赖与引用按身份排序', () => {
    const plan = validateFeaturePlanInput({
      schemaVersion: 1,
      feature: { title: '排序', sourceRefs: [{ artifactId: 's-2' }, { artifactId: 's-1' }] },
      tasks: [
        { id: 't-b', title: 'b', acceptance: { criteria: ['x'] }, requirementsRefs: [{ artifactId: 'r-2' }, { artifactId: 'r-1' }] },
        { id: 't-a', title: 'a', acceptance: { criteria: ['y'] }, dependsOn: ['t-b', 't-c'] },
        { id: 't-c', title: 'c', acceptance: { criteria: ['z'] } },
      ],
    });
    const parsed = JSON.parse(canonicalFeaturePlanBusinessJson(plan)) as {
      feature: { sourceRefs: Array<{ artifactId: string }> };
      tasks: Array<{ id: string; dependsOn: string[]; requirementsRefs: Array<{ artifactId: string }> }>;
    };
    expect(parsed.tasks.map((task) => task.id)).toEqual(['t-a', 't-b', 't-c']);
    expect(parsed.tasks[0]?.dependsOn).toEqual(['t-b', 't-c']);
    expect(parsed.tasks[1]?.requirementsRefs.map((ref) => ref.artifactId)).toEqual(['r-1', 'r-2']);
    expect(parsed.feature.sourceRefs.map((ref) => ref.artifactId)).toEqual(['s-1', 's-2']);
  });

  it('零 Task 草稿仍有确定性摘要，且与最小任务计划不同', () => {
    const empty = digestOf({ schemaVersion: 1, feature: { title: '空' }, tasks: [] });
    const minimal = digestOf({ schemaVersion: 1, feature: { title: '空' }, tasks: [{ id: 't-1', title: 'a', acceptance: { criteria: ['c'] } }] });
    expect(empty).toMatch(/^[0-9a-f]{64}$/);
    expect(empty).not.toBe(minimal);
  });
});
