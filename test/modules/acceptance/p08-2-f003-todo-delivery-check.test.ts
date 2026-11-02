/**
 * P08-2 / F-003 Todo CLI 交付结果局部契约检查器测试（真实临时项目 + 真实子进程）。
 *
 * 守护对象：`scripts/acceptance/p08-todo-delivery-check.ts`（检查器核心与默认
 * 进程/文件端口）与 `test/helpers/p08-2/todo-fixture-cli.mjs`（参考实现夹具）。
 *
 * 覆盖（全部为真实临时目录内真实子进程与真实文件系统，无网络、无模型、无 Host）：
 * 1) 参考实现九类行为全部通过：空列表、新增/列表、完成、重复完成确定性、删除、
 *    跨进程持久化（每次调用都是全新进程）、四类失败非零且保全数据、测试产物；
 * 2) 违约交付被逐项抓住：空标题/未知 ID/无效命令静默成功、写失败吞掉、读失败
 *    折算空列表成功、失败破坏已有数据、新增不落盘；
 * 3) 项目测试只按退出码判定：测试命令打印成功文字但退出码非 0 时必须失败，
 *    声明的测试文件缺失或类别覆盖不足时 fail-closed；
 * 4) 检查目标校验 fail-closed（数据目录越界/绝对路径/.. 逃逸/未知类别），
 *    命令不可运行、输出不可解释均不折算为通过；
 * 5) 报告只含稳定结果码：不含临时项目绝对路径；作用域与 outOfScope 显式声明
 *    真实 Host、SQLite 竞争、进程停止与 Git 集成留给阶段集成检查；
 * 6) 测试索引、Feature 索引、test/stages.json 与 README 导航同步登记。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  P08_TODO_CHECK_OUT_OF_SCOPE,
  P08_TODO_CHECK_SCOPE,
  TodoDeliveryCheckError,
  checkTodoDelivery,
  createProcessTodoCheckPorts,
  validateTodoDeliveryTarget,
} from '../../../scripts/acceptance/p08-todo-delivery-check.ts';
import type {
  TodoDeliveryCheckReport,
  TodoDeliveryTarget,
  TodoListInterpreter,
} from '../../../scripts/acceptance/p08-todo-delivery-check.ts';
import { P08_TODO_REQUIRED_CATEGORIES } from '../../../scripts/acceptance/p08-todo-requirements.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_CLI = readFileSync(resolve(REPO_ROOT, 'test/helpers/p08-2/todo-fixture-cli.mjs'), 'utf8');
const TEST_FILE = 'test/modules/acceptance/p08-2-f003-todo-delivery-check.test.ts';
const DOC_PATH = 'docs/p08-2-todo-delivery-check.md';

const TEST_FILES_BY_CATEGORY: ReadonlyArray<{ readonly file: string; readonly category: string }> = [
  { file: 'test/todo-add.test.mjs', category: 'add' },
  { file: 'test/todo-list.test.mjs', category: 'list' },
  { file: 'test/todo-complete.test.mjs', category: 'complete' },
  { file: 'test/todo-delete.test.mjs', category: 'delete' },
  { file: 'test/todo-persistence.test.mjs', category: 'persistence' },
  { file: 'test/todo-empty-title.test.mjs', category: 'empty-title' },
  { file: 'test/todo-unknown-id.test.mjs', category: 'unknown-id' },
  { file: 'test/todo-invalid-command.test.mjs', category: 'invalid-command' },
  { file: 'test/todo-data-io.test.mjs', category: 'data-io-failure' },
];

/** 解析夹具 list 输出的解释器（模拟交付接线为真实交付格式声明的解析）。 */
const interpretFixtureList: TodoListInterpreter = (stdout): readonly { id: string; title: string; completed: boolean }[] | null => {
  const lines = stdout.split('\n').map(line => line.trim()).filter(line => line !== '');
  if (lines.length === 0) return null;
  if (lines.length === 1 && lines[0] === '(empty)') return [];
  const items: { id: string; title: string; completed: boolean }[] = [];
  for (const line of lines) {
    const match = /^(\S+) \| (.*) \| (done|open)$/.exec(line);
    if (!match) return null;
    items.push({ id: match[1]!, title: match[2]!, completed: match[3] === 'done' });
  }
  return items;
};

interface ProjectContext {
  readonly projectRoot: string;
  readonly dataDirectory: string;
  readonly sandboxPath: string;
}

/** 在真实临时沙箱中生成一个待检的“交付项目”：todo.mjs + 九类测试 + 测试入口。 */
function buildFixtureProject(root: string): ProjectContext {
  const projectRoot = join(root, 'project');
  mkdirSync(join(projectRoot, 'data'), { recursive: true });
  mkdirSync(join(projectRoot, 'test'), { recursive: true });
  writeFileSync(join(projectRoot, 'todo.mjs'), FIXTURE_CLI);
  for (const entry of TEST_FILES_BY_CATEGORY) {
    writeFileSync(
      join(projectRoot, entry.file),
      `// requirement: ${entry.category}\nimport assert from 'node:assert/strict';\nassert.ok(true);\n`,
    );
  }
  const files = TEST_FILES_BY_CATEGORY.map(entry => entry.file.split('/').pop()!);
  writeFileSync(join(projectRoot, 'test/run.mjs'), [
    "import { existsSync, readFileSync } from 'node:fs';",
    `const files = ${JSON.stringify(files)};`,
    'for (const file of files) {',
    '  if (!existsSync(`test/${file}`)) { console.error(`missing test: ${file}`); process.exit(1); }',
    "  if (readFileSync(`test/${file}`, 'utf8').trim() === '') { console.error(`empty test: ${file}`); process.exit(1); }",
    '}',
    'console.log(`todo tests: ${files.length} passing`);',
    "if (process.env.TODO_FIXTURE_TESTS_FAIL === '1') process.exit(1);",
    '',
  ].join('\n'));
  return { projectRoot, dataDirectory: join(projectRoot, 'data'), sandboxPath: root };
}

interface TargetOverrides {
  readonly dataDirectory?: string;
  readonly todoCommand?: readonly string[];
  readonly declaredTests?: readonly { readonly file: string; readonly categories: readonly string[] }[];
}

function targetOf(project: ProjectContext, overrides: TargetOverrides = {}): TodoDeliveryTarget {
  return {
    projectRoot: project.projectRoot,
    dataDirectory: overrides.dataDirectory ?? project.dataDirectory,
    todoCommand: overrides.todoCommand ?? [process.execPath, 'todo.mjs'],
    testCommand: [process.execPath, 'test/run.mjs'],
    declaredTests: overrides.declaredTests ?? TEST_FILES_BY_CATEGORY.map(entry => ({ file: entry.file, categories: [entry.category] })),
  };
}

async function runCheck(
  project: ProjectContext,
  options: { readonly faults?: string; readonly testsFail?: boolean; readonly overrides?: TargetOverrides } = {},
): Promise<TodoDeliveryCheckReport> {
  const target = targetOf(project, options.overrides);
  const ports = createProcessTodoCheckPorts(target, {
    timeoutMs: 15_000,
    todoEnv: options.faults ? { TODO_FIXTURE_FAULTS: options.faults } : {},
    testEnv: options.testsFail ? { TODO_FIXTURE_TESTS_FAIL: '1' } : {},
  });
  return checkTodoDelivery(target, interpretFixtureList, ports);
}

const byId = (report: TodoDeliveryCheckReport, id: string) => report.checks.find(check => check.id === id)!;

describe('P08-2 F-003 Todo 交付局部契约检查器', () => {
  it('[case:p08-2-f003-reference-delivery-passes] 参考实现九类行为全部通过且报告可追溯', async () => {
    const sandbox = createTempSandbox('shiploop-p08-todo-check-');
    try {
      const project = buildFixtureProject(sandbox.path);
      const report = await runCheck(project);
      expect(report.passed).toBe(true);
      expect(report.scope).toBe(P08_TODO_CHECK_SCOPE);
      expect(report.summary).toEqual({ total: 11, failed: 0 });
      expect(report.checks.map(check => check.id)).toEqual([
        'list-empty', 'add-list', 'complete', 'complete-repeat', 'delete', 'persistence',
        'failure-empty-title', 'failure-unknown-id', 'failure-invalid-command', 'failure-data-io', 'project-tests',
      ]);
      expect(report.checks.every(check => check.status === 'pass' && check.reasons.length === 0)).toBe(true);
      // 报告不含临时项目绝对路径/输出正文，只含稳定结果码。
      const serialized = JSON.stringify(report);
      expect(serialized.includes(sandbox.path)).toBe(false);
      expect(serialized.includes('todo.json')).toBe(false);
      // 阶段集成边界显式声明（验收标准 5）。
      expect(P08_TODO_CHECK_OUT_OF_SCOPE.map(item => item.id)).toEqual(
        ['real-host', 'sqlite-concurrency', 'process-stop', 'git-integration'],
      );
      expect(report.outOfScope).toEqual(P08_TODO_CHECK_OUT_OF_SCOPE);
    } finally {
      sandbox.cleanup();
    }
  });

  it('[case:p08-2-f003-invalid-input-guards] 空标题/未知 ID/无效命令的静默成功被逐项抓住，其余行为不受影响', async () => {
    const sandbox = createTempSandbox('shiploop-p08-todo-check-');
    try {
      const project = buildFixtureProject(sandbox.path);
      const report = await runCheck(project, { faults: 'accept-empty-title,silent-unknown-id,silent-invalid-command' });
      expect(report.passed).toBe(false);
      expect(byId(report, 'failure-empty-title').reasons).toContain('silent_success');
      expect(byId(report, 'failure-empty-title').reasons).toContain('data_modified');
      expect(byId(report, 'failure-unknown-id').reasons).toContain('silent_success');
      expect(byId(report, 'failure-invalid-command').reasons).toContain('silent_success');
      // 正常行为与持久化在违约交付下仍应通过，说明失败定位到具体类别。
      for (const id of ['list-empty', 'add-list', 'complete', 'complete-repeat', 'delete', 'persistence', 'failure-data-io', 'project-tests']) {
        expect(byId(report, id).status, id).toBe('pass');
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('[case:p08-2-f003-persistence-guard] 新增不落盘与数据目录无文件形式的交付被持久化检查抓住', async () => {
    const sandbox = createTempSandbox('shiploop-p08-todo-check-');
    try {
      const project = buildFixtureProject(sandbox.path);
      const report = await runCheck(project, { faults: 'no-persist' });
      expect(report.passed).toBe(false);
      expect(byId(report, 'add-list').reasons).toContain('item_missing');
      expect(byId(report, 'persistence').reasons).toContain('data_not_file_backed');
    } finally {
      sandbox.cleanup();
    }
  });

  it('[case:p08-2-f003-data-io-guards] 读失败折算空列表成功与写失败被吞掉均失败，注入解除后数据可读', async () => {
    const sandbox = createTempSandbox('shiploop-p08-todo-check-');
    try {
      const project = buildFixtureProject(sandbox.path);
      const report = await runCheck(project, { faults: 'silent-read-failure,swallow-write-failure' });
      expect(report.passed).toBe(false);
      const reasons = byId(report, 'failure-data-io').reasons;
      expect(reasons).toContain('silent_success');
      expect(reasons).toContain('silent_empty_success');
      expect(reasons).not.toContain('restored_data_changed');
      expect(reasons).not.toContain('restored_unreadable');
      for (const id of ['list-empty', 'add-list', 'complete', 'complete-repeat', 'delete', 'persistence', 'project-tests']) {
        expect(byId(report, id).status, id).toBe('pass');
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it('[case:p08-2-f003-corruption-guard] 失败操作破坏已有数据被数据保全断言抓住', async () => {
    const sandbox = createTempSandbox('shiploop-p08-todo-check-');
    try {
      const project = buildFixtureProject(sandbox.path);
      const report = await runCheck(project, { faults: 'corrupt-on-failure' });
      expect(report.passed).toBe(false);
      expect(byId(report, 'failure-empty-title').reasons).toContain('data_modified');
    } finally {
      sandbox.cleanup();
    }
  });

  it('[case:p08-2-f003-project-tests-guard] 项目测试只按退出码判定，成功文字与缺失文件/类别缺口不折算通过', async () => {
    const sandbox = createTempSandbox('shiploop-p08-todo-check-');
    try {
      const project = buildFixtureProject(sandbox.path);
      // 测试命令打印 "N passing" 但退出码非 0：不得依据日志成功文字放行。
      const logOnly = await runCheck(project, { testsFail: true });
      expect(logOnly.passed).toBe(false);
      expect(byId(logOnly, 'project-tests').reasons).toEqual(['project_tests_exit_nonzero']);
      for (const id of ['add-list', 'complete', 'delete', 'persistence', 'failure-data-io']) {
        expect(byId(logOnly, id).status, id).toBe('pass');
      }
      // 声明了不存在的测试文件。
      const ghostManifest = await runCheck(project, {
        overrides: {
          declaredTests: [
            ...TEST_FILES_BY_CATEGORY.map(entry => ({ file: entry.file, categories: [entry.category] })),
            { file: 'test/todo-ghost-declared.test.mjs', categories: ['add'] },
          ],
        },
      });
      expect(ghostManifest.passed).toBe(false);
      expect(byId(ghostManifest, 'project-tests').reasons).toContain('test_files_missing');
      // 类别覆盖不足与未知类别在目标校验阶段 fail-closed。
      expect(() => validateTodoDeliveryTarget(targetOf(project, {
        declaredTests: TEST_FILES_BY_CATEGORY.filter(entry => entry.category !== 'delete')
          .map(entry => ({ file: entry.file, categories: [entry.category] })),
      }))).toThrowError(TodoDeliveryCheckError);
      expect(() => validateTodoDeliveryTarget(targetOf(project, {
        declaredTests: [
          { file: 'test/todo-add.test.mjs', categories: [...P08_TODO_REQUIRED_CATEGORIES] },
          { file: 'test/todo-extra.test.mjs', categories: ['not-a-category'] },
        ],
      }))).toThrowError(/未知行为类别/);
    } finally {
      sandbox.cleanup();
    }
  });

  it('[case:p08-2-f003-fail-closed-targets] 目标越界/命令不可运行/输出不可解释均不折算为通过', async () => {
    const sandbox = createTempSandbox('shiploop-p08-todo-check-');
    try {
      const project = buildFixtureProject(sandbox.path);
      // 数据目录逃出项目根、绝对路径测试文件与 .. 逃逸均拒绝。
      expect(() => validateTodoDeliveryTarget(targetOf(project, { dataDirectory: join(sandbox.path, 'outside-data') })))
        .toThrowError(/dataDirectory/);
      expect(() => validateTodoDeliveryTarget(targetOf(project, {
        declaredTests: [{ file: '/etc/passwd', categories: [...P08_TODO_REQUIRED_CATEGORIES] }],
      }))).toThrowError(/相对路径/);
      expect(() => validateTodoDeliveryTarget(targetOf(project, {
        declaredTests: [{ file: '../escape.test.mjs', categories: [...P08_TODO_REQUIRED_CATEGORIES] }],
      }))).toThrowError(/相对路径/);
      // CLI 无法启动：所有行为检查失败，不产生通过结论。
      const unrunnable = await runCheck(project, { overrides: { todoCommand: ['/definitely-missing-todo-binary'] } });
      expect(unrunnable.passed).toBe(false);
      for (const id of ['list-empty', 'add-list', 'complete', 'delete', 'persistence', 'failure-empty-title']) {
        expect(byId(unrunnable, id).reasons, id).toContain('todo_unrunnable');
      }
      // list 输出不可解释：不得猜测降级为通过。
      const target = targetOf(project);
      const opaque = await checkTodoDelivery(target, () => null, createProcessTodoCheckPorts(target));
      expect(opaque.passed).toBe(false);
      expect(byId(opaque, 'list-empty').reasons).toContain('list_uninterpretable');
      expect(byId(opaque, 'add-list').reasons).toContain('list_uninterpretable');
    } finally {
      sandbox.cleanup();
    }
  });

  it('[case:p08-2-f003-scope-and-index-registration] 检查范围边界与索引/stages/README 登记同步', () => {
    const index = JSON.parse(
      readFileSync(join(REPO_ROOT, 'test/index/phases/P08/features/P08-2/tasks/F-003.json'), 'utf8'),
    ) as { schema_version: number; task_id: string; projects: { id: string; tests: { file: string; all: boolean; level: string }[] }[] };
    expect(index.schema_version).toBe(2);
    expect(index.task_id).toBe('F-003');
    expect(index.projects).toHaveLength(1);
    expect(index.projects[0]!.id).toBe('shiploop');
    const selected = index.projects[0]!.tests.find(test => test.file === TEST_FILE);
    expect(selected?.all).toBe(true);
    expect(selected?.level).toBe('unit');
    expect(existsSync(join(REPO_ROOT, TEST_FILE))).toBe(true);
    expect(index.projects[0]!.tests.some(test => test.file === 'test/modules/acceptance/p08-2-f001-todo-requirements.test.ts')).toBe(true);

    const feature = JSON.parse(
      readFileSync(join(REPO_ROOT, 'test/index/phases/P08/features/P08-2/feature.json'), 'utf8'),
    ) as { tasks: { task_id: string; index: string }[] };
    expect(feature.tasks).toContainEqual({
      task_id: 'F-003',
      index: 'test/index/phases/P08/features/P08-2/tasks/F-003.json',
    });

    const stages = JSON.parse(readFileSync(join(REPO_ROOT, 'test/stages.json'), 'utf8')) as { light: string[] };
    expect(stages.light).toContain(TEST_FILE);
    expect(readFileSync(join(REPO_ROOT, 'README.md'), 'utf8')).toContain(DOC_PATH);
    expect(readFileSync(join(REPO_ROOT, 'test/README.md'), 'utf8')).toContain('index/phases/P08/features/P08-2/tasks/F-003.json');
  });
});
