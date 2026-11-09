/**
 * P08-2 / F-001 Todo CLI 演示需求输入与验收契约冻结（纯本地文件/常量断言）。
 *
 * 守护对象：`acceptance/p08.todo-requirements.json`（冻结需求输入）、
 * `docs/phases/p08/p08-2-todo-requirements.md`（人读契约）与
 * `scripts/acceptance/p08-todo-requirements.ts`（fail-closed 校验入口）。
 *
 * 覆盖（全部为真实文件/真实校验函数断言，无 mock、无网络、无模型）：
 * 1) 需求行为目录同时覆盖新增/列表/完成/删除/跨进程持久化/空标题/未知 ID/
 *    无效命令/数据读写失败；失败行为声明非零退出且保全已有数据；
 * 2) 临时项目（os.tmpdir()+mkdtemp）、数据目录、凭据边界与清理责任稳定定义，
 *    且契约与文档均不含开发机绝对路径或凭据样式内容；
 * 3) 正常交付必须真实授权 Pi（provider/model、人工批准、预算）；FakeRuntime
 *    仅限五类确定性故障夹具；not_run 不折算通过；
 * 4) live 证据身份链绑定代码/测试/Task/Feature/Git 提交/运行证据六类制品，
 *    并可从 Feature 逐级追到测试结果；
 * 5) live 规划政策要求 ≥3 项有依赖 Task；validateTodoTaskPlan 对数量不足、
 *    无依赖、链长不足、重名、悬空依赖、自依赖与环 fail-closed；
 * 6) 契约漂移（版本/类别删减/政策弱化/绝对路径/凭据字段注入）一律拒绝；
 * 7) 测试索引、Feature 索引、test/stages.json 与 README 文档导航同步登记。
 *
 * 本 Task 不实现 Todo CLI 代码，不运行真实模型；真实规划/实现/live 验收由
 * 后续 Task 交付，保持 not_run。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  P08_TODO_CLEANUP_OUTCOMES,
  P08_TODO_FAULT_FIXTURES,
  P08_TODO_LINKED_ARTIFACTS,
  P08_TODO_MIN_TASKS,
  P08_TODO_REQUIREMENTS_PATH,
  P08_TODO_REQUIRED_CATEGORIES,
  P08TodoRequirementsError,
  findMachineDependencyHints,
  loadTodoDemoRequirements,
  validateTodoDemoRequirements,
  validateTodoTaskPlan,
} from '../../../scripts/acceptance/p08-todo-requirements.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DOC_PATH = 'docs/phases/p08/p08-2-todo-requirements.md';
const TEST_FILE = 'test/modules/acceptance/p08-2-f001-todo-requirements.test.ts';
const requirements = loadTodoDemoRequirements(REPO_ROOT);
const rawRequirements: unknown = JSON.parse(readFileSync(resolve(REPO_ROOT, P08_TODO_REQUIREMENTS_PATH), 'utf8'));
const doc = readFileSync(resolve(REPO_ROOT, DOC_PATH), 'utf8');
const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8');
const testReadme = readFileSync(resolve(REPO_ROOT, 'test/README.md'), 'utf8');
const stages = JSON.parse(readFileSync(resolve(REPO_ROOT, 'test/stages.json'), 'utf8')) as { light: string[] };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function rejectedRequirements(action: () => unknown): P08TodoRequirementsError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(P08TodoRequirementsError);
    return error as P08TodoRequirementsError;
  }
  throw new Error('expected P08TodoRequirementsError');
}

describe('P08-2 F-001 Todo 演示需求契约', () => {
  it('[case:p08-2-f001-requirement-coverage] 需求输入完整覆盖九类必需行为且失败行为非零退出并保全数据', () => {
    expect(new Set(requirements.behaviors.map(behavior => behavior.category))).toEqual(
      new Set<string>(P08_TODO_REQUIRED_CATEGORIES),
    );
    expect(requirements.requiredBehaviorCategories).toEqual([...P08_TODO_REQUIRED_CATEGORIES]);
    const ids = requirements.behaviors.map(behavior => behavior.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const behavior of requirements.behaviors) {
      expect(behavior.summary.trim()).not.toBe('');
      expect(behavior.invocation.trim()).not.toBe('');
      expect(behavior.observable.length).toBeGreaterThanOrEqual(2);
      for (const fact of behavior.observable) expect(fact.trim()).not.toBe('');
      expect(behavior.exitSemantics).toBeDefined();
      // 契约文档的行为表逐类别在场，人读与机器读一致。
      expect(doc, `文档缺少类别 ${behavior.category}`).toContain(behavior.category);
    }
    const failures = requirements.behaviors.filter(behavior => behavior.kind === 'failure');
    expect(failures.map(behavior => behavior.category).sort()).toEqual(
      ['data-io-failure', 'empty-title', 'invalid-command', 'unknown-id'],
    );
    for (const failure of failures) {
      expect(failure.dataPreserved).toBe(true);
      expect([...failure.observable, failure.exitSemantics ?? ''].join('\n')).toMatch(/非\s*0|非零/);
    }
    for (const normal of requirements.behaviors.filter(behavior => behavior.kind === 'normal')) {
      expect([...normal.observable, normal.exitSemantics ?? ''].join('\n')).toMatch(/退出码\s*0/);
    }
  });

  it('[case:p08-2-f001-machine-independent-boundaries] 临时项目/数据目录/凭据/清理边界稳定且不依赖开发机绝对路径', () => {
    expect(findMachineDependencyHints(rawRequirements)).toEqual([]);
    for (const forbidden of [/\/Users\//, /\$HOME/, /~\//, /^[A-Za-z]:[\\/]/]) {
      expect(doc.match(forbidden), `文档含开发机路径样式 ${forbidden}`).toBeNull();
    }

    const tempProject = requirements.tempProject;
    expect(tempProject.creation).toContain('os.tmpdir()');
    expect(tempProject.creation).toContain('mkdtemp');
    expect(tempProject.rootPrefix).not.toMatch(/[/\\]/);
    expect(tempProject.layout.projectRoot.startsWith('<tempRoot>')).toBe(true);
    expect(tempProject.layout.dataDirectory.startsWith(tempProject.layout.projectRoot)).toBe(true);
    expect(tempProject.layout.dataFiles).toContain('dataDirectory');
    expect(tempProject.isolation.length).toBeGreaterThanOrEqual(3);
    expect(tempProject.forbiddenLocations.length).toBeGreaterThanOrEqual(3);
    expect(tempProject.machineIndependence).toContain('开发机绝对路径');

    const cleanup = tempProject.cleanup;
    expect(cleanup.owner.trim()).not.toBe('');
    expect(new Set(cleanup.appliesTo)).toEqual(new Set<string>(P08_TODO_CLEANUP_OUTCOMES));
    expect(cleanup.requiredEvidence).toContain('临时根不存在');
    expect(cleanup.protects.trim()).not.toBe('');

    const credentials = requirements.credentials;
    expect(credentials.fixtureContainsSecrets).toBe(false);
    expect(credentials.forbiddenIn.length).toBeGreaterThanOrEqual(3);
    expect(credentials.missingCredentialPolicy).toContain('not_run');
  });

  it('[case:p08-2-f001-runtime-policy] 正常交付仅真实授权 Pi，FakeRuntime 限定五类确定性故障夹具', () => {
    const { normalDelivery, fakeRuntime } = requirements.runtimePolicy;
    expect(normalDelivery.runtime).toBe('pi');
    expect(normalDelivery.mode).toBe('real-authorized');
    expect(
      normalDelivery.required.some(item => /provider/.test(item) && /model/.test(item))
      && normalDelivery.required.some(item => item.includes('批准'))
      && normalDelivery.required.some(item => item.includes('预算')),
    ).toBe(true);

    expect(fakeRuntime.usage).toContain('禁止替代正常交付');
    expect(fakeRuntime.faultsAreDeterministic.trim()).not.toBe('');
    expect(fakeRuntime.allowedFaultFixtures.map(fixture => fixture.id).sort()).toEqual(
      [...P08_TODO_FAULT_FIXTURES].sort(),
    );
    for (const fixture of fakeRuntime.allowedFaultFixtures) expect(fixture.summary.trim()).not.toBe('');

    expect(requirements.runtimePolicy.notRunCountsAsPassed).toBe(false);
    expect(requirements.runtimePolicy.machineClaimNotPass).toContain('completed');

    // 人读契约同步声明同一分界。
    expect(doc).toContain('real-authorized');
    expect(doc).toContain('禁止替代正常交付');
    expect(doc).toContain('not_run');
  });

  it('[case:p08-2-f001-evidence-identity] live 证据身份链绑定六类制品并可逐级追溯', () => {
    const evidence = requirements.evidencePolicy;
    expect(evidence.liveReport).toContain('accept:p08:live');
    expect(evidence.liveReport).toContain('not_run');
    expect(evidence.linkedArtifacts.slice().sort()).toEqual([...P08_TODO_LINKED_ARTIFACTS].sort());
    expect(Object.keys(evidence.artifactMeanings).sort()).toEqual([...P08_TODO_LINKED_ARTIFACTS].sort());
    for (const meaning of Object.values(evidence.artifactMeanings)) expect(meaning.trim()).not.toBe('');
    for (const token of ['Feature', 'Task', 'Run/Attempt', 'Git 提交', '测试结果']) {
      expect(evidence.linkage).toContain(token);
    }
    expect(evidence.notRunCountsAsPassed).toBe(false);
    expect(evidence.reportsSanitized).toContain('开发机绝对路径');

    // 人读契约同步登记身份链与 not_run 语义。
    expect(doc).toContain('Feature → Task → Run/Attempt → Git 提交');
    expect(doc).toContain('`not_run` 不计入通过');
  });

  it('[case:p08-2-f001-planning-min-tasks] live 规划要求至少三项有依赖 Task 且 DAG 判定 fail-closed', () => {
    const planning = requirements.planningPolicy;
    expect(planning.minTasks).toBeGreaterThanOrEqual(P08_TODO_MIN_TASKS);
    expect(planning.dependencies.required).toBe(true);
    expect(planning.humanApproval).toContain('批准');
    expect(planning.scopeLocked).toContain('不得扩张');
    expect(planning.duplicateGuard.trim()).not.toBe('');

    expect(validateTodoTaskPlan([
      { id: 'T-1', dependsOn: [] },
      { id: 'T-2', dependsOn: ['T-1'] },
      { id: 'T-3', dependsOn: ['T-2'] },
    ])).toEqual({ taskCount: 3, longestChain: 3 });

    const rejectedPlans: unknown[] = [
      [],
      [{ id: 'T-1', dependsOn: [] }, { id: 'T-2', dependsOn: ['T-1'] }],
      [{ id: 'T-1', dependsOn: [] }, { id: 'T-2', dependsOn: [] }, { id: 'T-3', dependsOn: [] }],
      [{ id: 'T-1', dependsOn: [] }, { id: 'T-2', dependsOn: ['T-1'] }, { id: 'T-3', dependsOn: [] }],
      [{ id: 'T-1', dependsOn: [] }, { id: 'T-1', dependsOn: [] }, { id: 'T-2', dependsOn: ['T-1'] }],
      [{ id: 'T-1', dependsOn: [] }, { id: 'T-2', dependsOn: ['T-missing'] }, { id: 'T-3', dependsOn: ['T-2'] }],
      [{ id: 'T-1', dependsOn: ['T-1'] }, { id: 'T-2', dependsOn: [] }, { id: 'T-3', dependsOn: ['T-2'] }],
      [{ id: 'T-1', dependsOn: ['T-2'] }, { id: 'T-2', dependsOn: ['T-1'] }, { id: 'T-3', dependsOn: ['T-2'] }],
      [{ id: 'T-1', dependsOn: [], extra: true }, { id: 'T-2', dependsOn: 'T-1' }],
    ];
    for (const plan of rejectedPlans) {
      expect(() => validateTodoTaskPlan(plan)).toThrowError(/Task|依赖|数组/);
    }
    expect(doc).toContain('不少于 3 项有依赖的 Task');
    expect(doc).toContain('validateTodoTaskPlan');
  });

  it('[case:p08-2-f001-fail-closed] 契约漂移、政策弱化、机器路径与凭据字段注入一律拒绝', () => {
    const mutate = (recipe: (value: Record<string, unknown>) => void): void => {
      const draft = clone(rawRequirements) as Record<string, unknown>;
      recipe(draft);
      rejectedRequirements(() => validateTodoDemoRequirements(draft));
    };

    mutate(value => { value.schemaVersion = 2; });
    mutate(value => { value.kind = 'other'; });
    mutate(value => { value.status = 'draft'; });
    mutate(value => {
      value.behaviors = (value.behaviors as Record<string, unknown>[])
        .filter(behavior => behavior.category !== 'persistence');
    });
    mutate(value => {
      (value.behaviors as unknown[]).push(clone((value.behaviors as unknown[])[0]));
    });
    mutate(value => {
      const behaviors = value.behaviors as Record<string, unknown>[];
      const emptyTitle = behaviors.find(behavior => behavior.category === 'empty-title');
      emptyTitle!.dataPreserved = false;
    });
    mutate(value => { value.requiredBehaviorCategories = ['add']; });
    mutate(value => {
      const tempProject = value.tempProject as Record<string, unknown>;
      tempProject.creation = '临时项目固定位于 /Users/dev/shared-todo 目录';
    });
    mutate(value => {
      (value.tempProject as Record<string, unknown>).cleanup = {
        owner: '入口',
        appliesTo: ['success'],
        requiredEvidence: '尽力清理',
        protects: '无',
      };
    });
    mutate(value => {
      Object.assign(value.credentials as Record<string, unknown>, { apiKey: 'x' });
    });
    mutate(value => {
      (value.runtimePolicy as Record<string, unknown>).normalDelivery = {
        runtime: 'fake',
        mode: 'fake-any',
        required: [],
      };
    });
    mutate(value => {
      const fakeRuntime = (value.runtimePolicy as Record<string, unknown>).fakeRuntime as Record<string, unknown>;
      fakeRuntime.allowedFaultFixtures = (fakeRuntime.allowedFaultFixtures as Record<string, unknown>[])
        .filter(fixture => fixture.id !== 'auth-failure');
    });
    mutate(value => { (value.runtimePolicy as Record<string, unknown>).notRunCountsAsPassed = true; });
    mutate(value => { (value.planningPolicy as Record<string, unknown>).minTasks = 2; });
    mutate(value => {
      const evidence = value.evidencePolicy as Record<string, unknown>;
      evidence.linkedArtifacts = (evidence.linkedArtifacts as string[]).filter(item => item !== 'gitCommits');
    });
    mutate(value => { (value.evidencePolicy as Record<string, unknown>).notRunCountsAsPassed = true; });

    // 正版契约与漂移副本区分明确：原样重验仍通过。
    expect(() => validateTodoDemoRequirements(clone(rawRequirements))).not.toThrow();
  });

  it('[case:p08-2-f001-index-registration] Task/Feature 索引、stages 分组与 README 导航同步登记', () => {
    const index = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'test/index/phases/P08/features/P08-2/tasks/F-001.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(index.schema_version).toBe(2);
    expect(index.task_id).toBe('F-001');
    const projects = index.projects as { id: string; tests: { file: string; all: boolean; level: string }[] }[];
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe('shiploop');
    const selected = projects[0]!.tests.find(test => test.file === TEST_FILE);
    expect(selected).toBeDefined();
    expect(selected!.all).toBe(true);
    expect(selected!.level).toBe('unit');
    expect(existsSync(resolve(REPO_ROOT, TEST_FILE))).toBe(true);

    const feature = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'test/index/phases/P08/features/P08-2/feature.json'), 'utf8'),
    ) as { tasks: { task_id: string; index: string }[] };
    expect(feature.tasks).toContainEqual({
      task_id: 'F-001',
      index: 'test/index/phases/P08/features/P08-2/tasks/F-001.json',
    });

    expect(stages.light).toContain(TEST_FILE);
    expect(readme).toContain(DOC_PATH);
    expect(testReadme).toContain('index/phases/P08/features/P08-2/tasks/F-001.json');
  });
});
