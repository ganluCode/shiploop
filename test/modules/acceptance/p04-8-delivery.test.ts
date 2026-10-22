import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { runBoundedProcess } from '../../../scripts/acceptance/p02-accept.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string): string => readFileSync(resolve(ROOT, file), 'utf8');
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

// 在复制的项目内加载真实入口；只替换阶段步骤，不安装依赖、不运行大组门禁。
const PROBE = `
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runP04Acceptance } from './scripts/acceptance/p04-accept.ts';
import { runBoundedProcess } from './scripts/acceptance/p02-accept.ts';
const repoRoot = dirname(fileURLToPath(import.meta.url));
const [mode, reportRoot, expectedCommit] = process.argv.slice(2);
const seen = [];
const pass = { kind: 'exit', exitCode: 0, signal: null, durationMs: 1, timedOut: false,
  stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false,
  stderrTruncated: false, spawnError: null, stoppedVerified: true };
const options = { repoRoot, reportRoot, expectedCommit, runId: 'delivery-' + mode,
  runProcess: async (command, args, options) => {
    // 捕获的计划允许全量入口，但永远不把它交给 OS 执行。
    if (command !== process.execPath || options.cwd !== repoRoot ||
      (seen.length === 0 ? args[0] !== 'scripts/verify.ts' :
        args[0] !== 'scripts/run-tests.ts' || args.length < 2 ||
        args.slice(1).some(arg => !/^test\\/modules\\/.+\\.test\\.(ts|js)$/.test(arg))))
      throw new Error('unexpected stage argv/cwd');
    seen.push(args);
    if (mode === 'timeout') return { ...pass, kind: 'timeout', exitCode: null, signal: 'SIGKILL', timedOut: true };
    if (mode === 'stop-uncertain') return { ...pass, stoppedVerified: false };
    const code = mode === 'failure' && seen.length === 2 ? 17 : 0;
    return runBoundedProcess(process.execPath, ['-e', 'process.exit(' + code + ')'], options);
  }
};
const result = await runP04Acceptance(options);
if (!result.reportWritten) throw new Error(JSON.stringify(result));
const report = JSON.parse(readFileSync(join(result.runDir, 'report.json'), 'utf8'));
const stepPath = join(result.stepRunDir, 'steps/01-engineering-gate.json');
const original = readFileSync(stepPath, 'utf8');
let rejection = null;
if (mode === 'directory-reuse' || mode === 'corrupt-evidence') {
  if (mode === 'corrupt-evidence') writeFileSync(stepPath, '{}');
  try { await runP04Acceptance({ ...options, observe: mode === 'corrupt-evidence' }); }
  catch (error) { rejection = error.message; }
}
process.stdout.write(JSON.stringify({ result, report, seen, rejection,
  originalRetained: readFileSync(stepPath, 'utf8') === original,
  resourcesRetained: existsSync(join(reportRoot, 'runs', options.runId, 'resources')) }) + '\\n');
`;

function cleanProject() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'p048-delivery-')));
  directories.push(root);
  const repo = join(root, 'project');
  const copy = (file: string) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    cpSync(join(ROOT, file), join(repo, file), { recursive: true });
  };
  for (const path of ['package.json', 'package-lock.json', 'packages/core/package.json', 'acceptance',
    'scripts/acceptance', 'scripts/verify.ts', 'scripts/run-tests.ts', 'test/index/phases/P04']) copy(path);
  // 保留真正的 P04 索引及所有被引用的测试文件，只用于入口范围校验，不执行这些文件。
  const visit = (path: string) => {
    for (const entry of readdirSync(join(ROOT, path), { withFileTypes: true })) {
      const file = `${path}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (/F-\d+\.json$/.test(entry.name)) {
        const index = JSON.parse(read(file));
        for (const project of index.projects) for (const test of project.tests) copy(test.file);
      }
    }
  };
  visit('test/index/phases/P04');
  writeFileSync(join(repo, 'delivery-probe.mjs'), PROBE);
  // 禁用继承 Git 配置/hooks/signing，只在自有临时仓库建立可核验基线。
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
    { cwd: repo, env, encoding: 'utf8', timeout: 10_000 }).trim();
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=P04 offline fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'offline fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  expect(git(['status', '--porcelain'])).toBe('');
  return { root, repo, commit, env };
}

for (const mode of ['normal', 'failure', 'timeout', 'corrupt-evidence', 'directory-reuse', 'stop-uncertain']) {
  it(`[case:clean-${mode}] 干净临时项目的 ${mode} 结果可定位且不递归启动阶段`, async () => {
    const project = cleanProject();
    const run = (args: string[]) => runBoundedProcess(process.execPath, args,
      { cwd: project.root, env: project.env, timeoutMs: 20_000, maxOutputBytes: 1_048_576 });
    if (mode === 'normal') {
      // 从无关 cwd 发现 package scripts，并执行复制入口的帮助，不进入阶段。
      const manifest = JSON.parse(readFileSync(join(project.repo, 'package.json'), 'utf8'));
      expect(manifest.scripts['accept:p04']).toBe('node scripts/acceptance/p04-accept.ts');
      expect(manifest.scripts['accept:p04:live']).toBe('node scripts/acceptance/p04-live.ts');
      const help = await run([join(project.repo, 'scripts/acceptance/p04-accept.ts'), '--help']);
      expect(help.exitCode, help.stderr).toBe(0);
      expect(help.stdout).toContain('usage: accept:p04');
      const live = await run([join(project.repo, 'scripts/acceptance/p04-live.ts')]);
      expect(live.exitCode, live.stderr).toBe(2);
      expect(JSON.parse(live.stdout)).toMatchObject({ status: 'not_run', realCalls: 0 });
    }
    const execution = await run([join(project.repo, 'delivery-probe.mjs'), mode, join(project.root, 'evidence'), project.commit]);
    expect(execution.exitCode, execution.stderr).toBe(0);
    const probe = JSON.parse(execution.stdout);
    const { result, report } = probe;
    expect(result.reportWritten, result.problems.join('\n')).toBe(true);
    expect(result.exitCode).toBe(1); // live/manual 等必需项未完成，正常探针也不能放行 Phase。
    expect(result.phaseAccepted).toBe(false);
    expect(report.git.commit).toBe(project.commit);
    expect(report.git.worktree).toBe('clean');
    expect(JSON.stringify(report)).not.toContain(process.execPath);
    const exportedStep = readFileSync(join(result.runDir, 'evidence/checks/P04-FR2-BOUNDED-ENTRY/steps/01-engineering-gate.json'), 'utf8');
    expect(exportedStep).not.toContain(process.execPath);
    expect(report.counts.pass + report.counts.fail + report.counts.not_run).toBe(report.counts.total);
    expect(report.checks.some((check: { execution: string; status: string }) => check.execution === 'live' && check.status === 'not_run')).toBe(true);
    expect(report.checks.some((check: { manualStatus?: string }) => check.manualStatus === 'pending')).toBe(true);
    expect(probe.seen.flat().some((arg: string) => arg.includes('p04-accept.ts') || arg.includes('accept:p04'))).toBe(false);
    if (mode === 'failure') expect(result.steps.map((step: { exitCode: number | null }) => step.exitCode)).toEqual([0, 17]);
    else if (mode === 'timeout') {
      expect(probe.seen).toHaveLength(1);
      expect(result.steps.map((step: { status: string; exitCode: number | null }) => [step.status, step.exitCode])).toEqual([['fail', null], ['not_run', null]]);
    } else if (mode === 'stop-uncertain') {
      expect(probe.seen).toHaveLength(1);
      expect(probe.resourcesRetained).toBe(true);
      expect(report.cleanup).toMatchObject({ confirmed: false, processesGone: false });
    } else {
      expect(result.steps.map((step: { exitCode: number | null }) => step.exitCode)).toEqual([0, 0]);
      expect(probe.resourcesRetained).toBe(false);
      expect(report.cleanup).toMatchObject({ confirmed: true, processesGone: true });
    }
    if (mode === 'corrupt-evidence') {
      expect(probe.rejection).toMatch(/哈希|sha256|水位/);
      expect(probe.seen).toHaveLength(2); // 观察拒绝后没有第三次执行。
    } else if (mode === 'directory-reuse') {
      expect(probe.rejection).toMatch(/目录已存在/);
      expect(probe.originalRetained).toBe(true);
      expect(probe.seen).toHaveLength(2);
    }
  }, 30_000);
}


it('[case:delivery-gates] 交付包保留五层独立结论和未签署的 P04 放行门槛', () => {
  const report = read('docs/p04-8-f010-delivery-report.md');
  const checklist = read('docs/p04-8-f010-manual-checklist.md');
  for (const layer of ['定向测试', 'Feature 索引合集', 'Phase 完整工程/集成', '真实 live', '负责人确认']) {
    expect(report).toContain(layer);
    expect(checklist).toContain(layer);
  }
  for (const field of ['负责人身份', '批准时间', '理由', '结论']) {
    expect(checklist).toMatch(new RegExp(`${field}[：:]\\s*待填写`));
  }
  expect(checklist).toContain('P04 未放行');
  expect(checklist).toContain('P05');
  expect(report).toContain('not_run');
  expect(report).toContain('pending');
});

it('[case:delivery-versions-evidence] 交付清单绑定锁定工具、两种证据索引和未运行门槛计数', () => {
  const report = read('docs/p04-8-f010-delivery-report.md');
  const lock = JSON.parse(read('package-lock.json'));
  for (const name of ['@earendil-works/pi-coding-agent', 'typescript', 'vitest', 'better-sqlite3', 'drizzle-orm']) {
    expect(report).toContain(lock.packages[`node_modules/${name}`].version);
  }
  for (const reference of ['acceptance/p04.config.json', 'acceptance/p04.entry.json', 'acceptance/p04.checklist.json',
    'evidenceManifest', 'evidence-index.json', 'not_run=3', 'pending=1', 'Core Work', '强 OS 沙箱']) {
    expect(report).toContain(reference);
  }
});

it('[case:delivery-matrix] 最终矩阵的六种场景和业务测试导航均可独立定位', () => {
  const matrix = read('docs/p04-8-f010-fault-matrix.md');
  for (const mode of ['normal', 'failure', 'timeout', 'corrupt-evidence', 'directory-reuse', 'stop-uncertain']) {
    expect(matrix).toContain(`clean-${mode}`);
  }
  const references = [...matrix.matchAll(/`(test\/modules\/[^`]+\.test\.ts)`/g)].map(match => match[1]);
  expect(new Set(references).size).toBeGreaterThanOrEqual(8);
  for (const file of references) expect(existsSync(join(ROOT, file)), file).toBe(true);
  const report = read('docs/p04-8-f010-delivery-report.md');
  for (const match of report.matchAll(/\]\(([^)]+\.md)\)/g)) {
    expect(existsSync(resolve(ROOT, 'docs', match[1])), match[1]).toBe(true);
  }
});

it('[case:delivery-index] Feature 索引完整登记现有 Task，所有选择均指向真实测试', () => {
  const base = 'test/index/phases/P04/features/P04-8';
  const feature = JSON.parse(read(`${base}/feature.json`));
  const indexes = readdirSync(resolve(ROOT, base, 'tasks')).filter(name => /^F-\d+\.json$/.test(name)).sort();
  expect(feature.tasks.map((task: { index: string }) => task.index).sort()).toEqual(indexes.map(name => `${base}/tasks/${name}`));
  expect(feature.tasks.map((task: { task_id: string }) => task.task_id)).toContain('F-010');
  for (const task of feature.tasks) {
    const index = JSON.parse(read(task.index));
    expect(index.task_id).toBe(task.task_id);
    expect(index.schema_version).toBe(2);
    for (const project of index.projects) for (const test of project.tests) {
      expect(test.file).toMatch(/^test\/modules\/.+\.test\.(ts|js)$/);
      expect(existsSync(resolve(ROOT, test.file)), test.file).toBe(true);
      // 参数化标题在收集阶段展开，case 存在性由 Nezha 的 Vitest adapter 核验。
      expect(test.all === true || (Array.isArray(test.cases) && test.cases.length > 0 &&
        test.cases.every((id: unknown) => typeof id === 'string' && /^[\w-]+$/.test(id)))).toBe(true);
    }
  }
});
