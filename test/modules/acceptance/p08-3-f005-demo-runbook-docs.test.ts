/**
 * P08-3 / F-005 文档核验：非 Nezha 存量演示运行手册
 * （`docs/acceptance/p08-3-existing-demo-runbook.md`）与结果报告模板
 * （`docs/acceptance/p08-3-demo-report-template.md`）。
 *
 * 这里只守护文档事实，不执行演示、不打开真实资源：
 *
 *  1) 手册给出可复现流程（准备快照、需求范围、获准策略、检查范围、清理责任），
 *     并把代码交付、Task 局部验证、Feature 门禁、Phase 真实 Git/SQLite/Host/进程
 *     集成验收、真实 Pi live 分成不同层级；Nezha completed、测试数量或成功日志
 *     不得被当成产品验收。
 *  2) 失败处置覆盖已有失败、脏文件、缺失依赖、停止未确认、身份冲突和无法安全
 *     提交；`not_run` 不折算通过，真实 Pi 执行是独立授权项。
 *  3) 模板字段覆盖代码 commit/tree、工具版本、实际命令与退出码、项目/操作身份、
 *     证据路径、通过/失败/not_run 计数、遗留问题和真实 Pi live 授权状态，并禁止
 *     凭据与完整认证内容。
 *  4) 文档引用的入口与测试路径都真实存在，引用 npm 脚本都真实登记；仓库当前
 *     没有 `accept:p08` 阶段入口，文档不得声称阶段集成已执行。
 *
 * 定位：F-005 只交付文档与本守护；不新增产品实现、不修改 P08-4 阶段报告。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAppCliArgs } from '../../../packages/cli/src/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNBOOK_PATH = 'docs/acceptance/p08-3-existing-demo-runbook.md';
const TEMPLATE_PATH = 'docs/acceptance/p08-3-demo-report-template.md';
const F005_INDEX_PATH = 'test/index/phases/P08/features/P08-3/tasks/F-005.json';
const FEATURE_INDEX_PATH = 'test/index/phases/P08/features/P08-3/feature.json';

const runbook = readFileSync(resolve(REPO_ROOT, RUNBOOK_PATH), 'utf-8');
const template = readFileSync(resolve(REPO_ROOT, TEMPLATE_PATH), 'utf-8');
const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')) as {
  readonly scripts: Readonly<Record<string, string>>;
  readonly engines?: Readonly<Record<string, string>>;
  readonly packageManager?: string;
};

/** 文档中以代码片段登记的仓库相对路径前缀。 */
const REPO_PATH_PREFIXES = [
  'test/',
  'scripts/',
  'packages/',
  'docs/',
  'acceptance/',
  'package.json',
  'package-lock.json',
] as const;

function codeSpans(doc: string): readonly string[] {
  return [...doc.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!.trim());
}

function referencedRepoPaths(doc: string): readonly string[] {
  return [...new Set(codeSpans(doc).filter(
    (span) => REPO_PATH_PREFIXES.some((prefix) => span.startsWith(prefix))
      && !span.includes('*')
      && !span.includes('<'),
  ))];
}

/** 极简 shell 风格分词：只用于手册里的单行 sh 示例（无转义/单引号）。 */
function tokenize(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of commandLine) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current.length > 0) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  expect(quoted, `引号不配对：${commandLine}`).toBe(false);
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** 提取手册 sh 代码块中的 `node packages/cli/dist/bin.js …` 示例调用。 */
function documentedCliInvocations(): string[][] {
  const blocks = [...runbook.matchAll(/```sh\n([\s\S]*?)```/g)];
  const invocations: string[][] = [];
  for (const block of blocks) {
    for (const line of block[1]!.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      if (!trimmed.startsWith('node packages/cli/dist/bin.js')) continue;
      invocations.push(tokenize(trimmed.slice('node packages/cli/dist/bin.js'.length).trim()));
    }
  }
  return invocations;
}

function bindPlaceholders(tokens: readonly string[]): string[] {
  const bindings: Record<string, string> = {
    '<repository-path>': '.',
    '<displayName>': 'legacy-demo',
    '<projectId>': '3f1c9a52-7b6e-4d3a-9f21-8c0d5e6a7b14',
    '<plan-file>': 'baseline-plan.json',
    '<revision>': '1',
  };
  return tokens.map((token) => bindings[token] ?? token);
}

describe('F-005 运行手册：可复现流程与分层验收边界', () => {
  it('覆盖准备快照、需求范围、获准策略、检查范围与清理责任', () => {
    for (const token of [
      'macOS',
      'Node',
      '22.19.0',
      'npm',
      '10.9.3',
      '准备快照',
      'HEAD',
      'tree',
      'status',
      '脏文件',
      '已有检查',
      '已知失败',
      '需求范围',
      '批准路径',
      '获准策略',
      '显式确认',
      '禁止自动提交',
      '检查范围',
      '定向检查',
      '清理责任',
      '临时仓库',
      '用户自有仓库',
    ]) {
      expect(runbook, token).toContain(token);
    }
    expect(runbook).toContain(packageJson.engines?.node ?? '22.19.0');
    expect(runbook).toContain(packageJson.packageManager ?? 'npm@10.9.3');
  });

  it('把代码交付、Task 局部验证、Feature 门禁、Phase 集成与真实 Pi live 分层描述', () => {
    for (const token of [
      '代码交付',
      'Task 局部',
      'Feature 门禁',
      'task_union',
      'Phase',
      '真实 Git',
      'SQLite',
      'Host',
      '进程',
      '集成验收',
      '真实 Pi',
      '独立授权',
    ]) {
      expect(runbook, token).toContain(token);
    }
    for (const token of ['不是产品验收', 'Nezha completed', '测试数量', '成功日志']) {
      expect(runbook, token).toContain(token);
    }
  });

  it('失败处置覆盖已有失败、脏文件、缺失依赖、停止未确认、身份冲突与无法安全提交', () => {
    for (const token of [
      'known_failure',
      'baselineGaps',
      'unresolved',
      '脏文件',
      '缺失依赖',
      'not_run',
      '停止未确认',
      '身份冲突',
      '无法安全提交',
      'original_dirty_file_was_committed',
      'project_not_active',
      'revision',
    ]) {
      expect(runbook, token).toContain(token);
    }
  });

  it('明确 not_run 不折算通过，且真实 Pi 执行是独立授权项', () => {
    for (const token of ['not_run', '不折算', '通过', '真实 Pi', '授权']) {
      expect(runbook, token).toContain(token);
    }
    expect(runbook).toMatch(/not_run[^\n]{0,40}不(折算|记为)/);
  });

  it('描述归档后拒绝派发与重开保留身份、历史和证据', () => {
    for (const token of [
      'project archive',
      'project restore',
      'archived',
      '拒绝',
      '重开',
      'projectId',
      '检查历史',
      '证据',
    ]) {
      expect(runbook, token).toContain(token);
    }
  });
});

describe('F-005 报告模板：必填身份、命令证据与计数', () => {
  it('要求记录代码 commit/tree、工具版本、命令与退出码、项目与操作身份、证据路径', () => {
    for (const token of [
      'commit',
      'tree',
      'Node',
      'npm',
      '退出码',
      'projectId',
      '操作身份',
      '证据',
      '日志',
      '时间',
    ]) {
      expect(template, token).toContain(token);
    }
  });

  it('要求记录通过/失败/not_run 计数、遗留问题与真实 Pi live 授权状态', () => {
    for (const token of [
      'passed',
      'failed',
      'not_run',
      'inconclusive',
      '计数',
      '遗留问题',
      'live',
      '授权',
      '签署',
    ]) {
      expect(template, token).toContain(token);
    }
  });

  it('禁止记录凭据或完整认证内容，且报告不保存开发机绝对路径', () => {
    for (const token of ['凭据', '令牌', 'OAuth', '认证', '绝对路径', '禁止']) {
      expect(template, token).toContain(token);
    }
  });

  it('手册与模板不含真实凭据、令牌或开发机绝对路径', () => {
    for (const doc of [runbook, template]) {
      expect(doc).not.toMatch(/\/Users\//);
      expect(doc).not.toMatch(/\/home\/[a-z]/);
      expect(doc).not.toMatch(/[A-Za-z]:\\\\/);
      expect(doc).not.toMatch(/ghp_[A-Za-z0-9]/);
      expect(doc).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
      expect(doc).not.toContain('PRIVATE KEY');
      expect(doc).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{8,}/);
    }
  });
});

describe('F-005 文档引用的入口与测试路径必须真实存在', () => {
  it('手册与模板引用的每个仓库路径都存在', () => {
    const referenced = [...new Set([
      ...referencedRepoPaths(runbook),
      ...referencedRepoPaths(template),
    ])];
    expect(referenced.length).toBeGreaterThanOrEqual(15);
    for (const path of referenced) {
      expect(existsSync(resolve(REPO_ROOT, path)), `${path} 不存在`).toBe(true);
    }
  });

  it('手册引用的真实入口覆盖 P08-3 夹具、证据封套、增量与生命周期测试及索引', () => {
    for (const path of [
      'test/helpers/p08-3/legacy-todo-fixture.ts',
      'scripts/acceptance/p08-existing-demo.ts',
      'test/modules/acceptance/p08-3-f001-baseline-snapshot.test.ts',
      'test/modules/acceptance/p08-3-f001-existing-demo-fixture.test.ts',
      'test/modules/acceptance/p08-3-f002-evidence-envelope.test.ts',
      'test/modules/acceptance/p08-3-f003-existing-demo-incremental.test.ts',
      'test/modules/acceptance/p08-3-f004-existing-demo-lifecycle.test.ts',
      'test/modules/acceptance/p08-3-f004-lifecycle-contract.test.ts',
      'test/index/phases/P08/features/P08-3/feature.json',
      'test/index/phases/P08/features/P08-3/tasks/F-005.json',
      'docs/acceptance/phase-test-scope.md',
    ]) {
      expect(runbook, path).toContain(path);
    }
  });

  it('手册引用的 npm 脚本都在 package.json 中真实登记，且不声称存在阶段入口', () => {
    const referencedScripts = [...new Set(
      [...runbook.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((match) => match[1]!),
    )];
    expect(referencedScripts.length).toBeGreaterThanOrEqual(4);
    for (const script of referencedScripts) {
      expect(packageJson.scripts[script], script).toBeTypeOf('string');
    }
    expect(packageJson.scripts['accept:p08']).toBe('node scripts/acceptance/p08-accept.ts');
    expect(runbook).toContain('没有');
    expect(runbook).toContain('`accept:p08`');
  });

  it('手册的 dist CLI 示例都经真实参数解析面接受', () => {
    const invocations = documentedCliInvocations();
    expect(invocations.length).toBeGreaterThanOrEqual(6);
    for (const invocation of invocations) {
      const bound = bindPlaceholders(invocation);
      const parsed = parseAppCliArgs(bound, {}, { cwd: REPO_ROOT });
      expect('commandId' in parsed, JSON.stringify(bound)).toBe(true);
    }
  });
});

describe('F-005 当前实现边界如实登记', () => {
  it('手册声明阶段集成、真实 Pi 增量与负责人签署仍是 not_run，不修改 P08-4 报告', () => {
    for (const token of [
      '阶段集成',
      'not_run',
      '真实 Pi',
      '负责人',
      '签署',
      'P08-4',
    ]) {
      expect(runbook, token).toContain(token);
    }
    expect(runbook).toContain('不修改');
  });

  it('F-005 任务索引登记本守护为 unit，且 Feature 索引包含 F-005', () => {
    const index = JSON.parse(readFileSync(resolve(REPO_ROOT, F005_INDEX_PATH), 'utf-8')) as {
      readonly schema_version: number;
      readonly task_id: string;
      readonly projects: readonly { readonly id: string; readonly tests: readonly { readonly file: string; readonly level: string; readonly all?: boolean }[] }[];
    };
    expect(index.schema_version).toBe(2);
    expect(index.task_id).toBe('F-005');
    const tests = index.projects.flatMap((project) => project.tests);
    expect(tests).toContainEqual(expect.objectContaining({
      file: 'test/modules/acceptance/p08-3-f005-demo-runbook-docs.test.ts',
      level: 'unit',
      all: true,
    }));
    const feature = JSON.parse(readFileSync(resolve(REPO_ROOT, FEATURE_INDEX_PATH), 'utf-8')) as {
      readonly tasks: readonly { readonly task_id: string; readonly index: string }[];
    };
    expect(feature.tasks).toContainEqual({ task_id: 'F-005', index: F005_INDEX_PATH });
  });
});
