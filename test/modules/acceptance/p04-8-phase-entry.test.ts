import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveP04Args, runP04Acceptance } from '../../../scripts/acceptance/p04-accept.ts';
import { loadP04AcceptanceConfig } from '../../../scripts/acceptance/p04-config.ts';
import { runBoundedProcess } from '../../../scripts/acceptance/p02-accept.ts';
import type { P02BoundedRunOutcome } from '../../../scripts/acceptance/p02-accept.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const COMMIT = 'a'.repeat(40);
it('full-gate requires an explicit flag and runs the original engineering command', async () => {
  expect(resolveP04Args(['--full-gate']).fullGate).toBe(true);
  expect(resolveP04Args([]).fullGate).toBeUndefined();
  const opts = options();
  const seen: string[][] = [];
  await runP04Acceptance({ ...opts, fullGate: true, runProcess: async (_command, args) => {
    seen.push([...args]); return PASS;
  } });
  expect(seen[0]).toEqual(['scripts/verify.ts', '--step-timeout-ms', '3600000']);
  await expect(runP04Acceptance({ ...opts, observe: true, runProcess: async () => PASS })).rejects.toThrow(/不匹配/);
});
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const PASS: P02BoundedRunOutcome = { kind: 'exit', exitCode: 0, signal: null, durationMs: 1,
  timedOut: false, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
  stdoutTruncated: false, stderrTruncated: false, spawnError: null, stoppedVerified: true };
function options() {
  const reportRoot = mkdtempSync(join(tmpdir(), 'p048-entry-'));
  dirs.push(reportRoot);
  return { repoRoot: ROOT, reportRoot, runId: 'p048-entry-test', exec: (cmd: string, args: readonly string[]) => {
    if (cmd === 'git' && args.join(' ') === 'rev-parse HEAD') return COMMIT;
    if (cmd === 'git' && args[0] === 'status' && args.includes('--porcelain')) return '';
    if (cmd === 'git' && args[0] === 'rev-parse') return 'b'.repeat(40);
    if (cmd === 'git' && args[0] === 'branch') return 'feat/p04/p04-acceptance';
    if (cmd === 'node') return process.version;
    if (cmd === 'npm') return '10.9.3';
    return 'tool-version';
  } };
}

it('[case:failure-retains-prefix] preserves the successful gate evidence when integration fails', async () => {
  const opts = options();
  let calls = 0;
  const result = await runP04Acceptance({ ...opts, runProcess: async () => ({ ...PASS, exitCode: ++calls === 1 ? 0 : 17 }) });
  expect(calls).toBe(2);
  expect(result.exitCode).not.toBe(0);
  expect(result.reportWritten, result.problems.join('\n')).toBe(true);
  const first = join(result.stepRunDir, 'steps/01-engineering-gate.json');
  expect(JSON.parse(readFileSync(first, 'utf8')).exitCode).toBe(0);
  expect(existsSync(join(result.stepRunDir, 'logs/01-engineering-gate.log'))).toBe(true);
  expect(result.steps.map(step => step.exitCode)).toEqual([0, 17]);
});

it('[case:fixed-plan-isolated-env] uses fixed argv/cwd, bounded sequential execution and a fresh credential-free environment', async () => {
  const opts = options();
  const before = { npm_config_prefix: process.env.npm_config_prefix, npm_execpath: process.env.npm_execpath, NODE_OPTIONS: process.env.NODE_OPTIONS, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  Object.assign(process.env, { npm_config_prefix: '/wrong/repo', npm_execpath: '/wrong/npm', NODE_OPTIONS: '--require /wrong/preload', OPENAI_API_KEY: 'synthetic-credential' });
  const seen: string[][] = [];
  let resources = '';
  let active = false;
  try {
    const result = await runP04Acceptance({ ...opts, runProcess: async (command, args, execution) => {
      expect(active).toBe(false); active = true;
      expect(command).toBe(process.execPath);
      expect(execution.cwd).toBe(ROOT);
      expect(execution.timeoutMs).toBeGreaterThan(0);
      expect(execution.timeoutMs).toBeLessThanOrEqual(3_600_000);
      expect(execution.env!.npm_execpath).toBeUndefined();
      expect(execution.env!.NODE_OPTIONS).toBeUndefined();
      expect(execution.env!.OPENAI_API_KEY).toBeUndefined();
      expect(execution.env!.npm_config_prefix).toBe(ROOT);
      expect(execution.env!.HOME).not.toBe(process.env.HOME);
      resources = dirname(execution.env!.HOME!);
      expect(existsSync(resources)).toBe(true);
      seen.push([...args]); active = false;
      return PASS;
    } });
    expect(seen[0]).toEqual(['scripts/verify.ts', '--step-timeout-ms', '3600000', '--checks-only']);
    expect(seen[1]![0]).toBe('scripts/run-tests.ts');
    expect(seen[1]!.slice(1).length).toBeGreaterThan(0);
    expect(seen.flat().some(arg => arg.includes('accept:p04') || arg.includes('p04-accept.ts'))).toBe(false);
    expect(existsSync(resources)).toBe(false);
    expect(result.reportWritten, result.problems.join('\n')).toBe(true);
    const report = JSON.parse(readFileSync(join(result.runDir!, 'report.json'), 'utf8'));
    expect(report.git.commit).toBe(COMMIT);
    expect(report.tools.node).toBe(process.version);
    expect(report.tools.npm).toBe('10.9.3');
    expect(report.commands.map((cmd: { exitCode: number }) => cmd.exitCode)).toEqual([0, 0]);
    expect(result.phaseAccepted).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(report.conclusion).toBe('fail');
    expect(report.checks.some((check: { status: string }) => check.status === 'not_run')).toBe(true);
  } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

it('[case:observe-no-rerun] observes verified evidence repeatedly without executing or overwriting steps', async () => {
  const opts = options();
  let calls = 0;
  const runProcess = async () => { calls++; return PASS; };
  const first = await runP04Acceptance({ ...opts, runProcess });
  const original = readFileSync(join(first.stepRunDir, 'run.json'), 'utf8');
  for (let count = 0; count < 2; count++) {
    const observed = await runP04Acceptance({ ...opts, observe: true, runProcess });
    expect(observed.steps.map(step => step.exitCode)).toEqual([0, 0]);
    expect(observed.exitCode).toBe(first.exitCode);
  }
  expect(calls).toBe(2);
  expect(readFileSync(join(first.stepRunDir, 'run.json'), 'utf8')).toBe(original);
  await expect(runP04Acceptance({ ...opts, runProcess })).rejects.toThrow(/目录已存在/);
  expect(calls).toBe(2);
  writeFileSync(join(first.stepRunDir, 'steps/01-engineering-gate.json'), '{}');
  await expect(runP04Acceptance({ ...opts, observe: true, runProcess })).rejects.toThrow(/哈希|sha256|水位/);
  expect(calls).toBe(2);
});

it('[case:identity-mismatch] refuses changed commit and changed configuration before reusing evidence', async () => {
  const opts = options();
  const first = await runP04Acceptance({ ...opts, runProcess: async () => PASS });
  const runProcess = vi.fn(async () => PASS);
  await expect(runP04Acceptance({ ...opts, observe: true, exec: (command, args) => command === 'git' && args.join(' ') === 'rev-parse HEAD' ? 'c'.repeat(40) : opts.exec(command, args), runProcess })).rejects.toThrow(/不匹配/);
  const config = loadP04AcceptanceConfig(join(ROOT, 'acceptance/p04.config.json'));
  config.maxCommandOutputBytes *= 2;
  await expect(runP04Acceptance({ ...opts, config, observe: true, runProcess })).rejects.toThrow(/不匹配/);
  expect(runProcess).not.toHaveBeenCalled();
  expect(existsSync(join(first.stepRunDir, 'state.json'))).toBe(true);
});

it('[case:timeout-not-run] keeps unknown timeout exit null and records subsequent steps as not_run', async () => {
  const opts = options();
  const runProcess = vi.fn(async () => ({ ...PASS, kind: 'timeout' as const, exitCode: null, signal: 'SIGKILL', timedOut: true }));
  const result = await runP04Acceptance({ ...opts, runProcess });
  expect(runProcess).toHaveBeenCalledTimes(1);
  expect(result.exitCode).not.toBe(0);
  expect(result.steps.map(step => [step.status, step.exitCode])).toEqual([['fail', null], ['not_run', null]]);
  expect(result.reportWritten).toBe(true);
  const evidence = JSON.parse(readFileSync(join(result.runDir!, 'evidence/checks/P04-FR2-BOUNDED-ENTRY/extra/entry-steps.json'), 'utf8'));
  expect(evidence.steps[1].status).toBe('not_run');
  expect(evidence.steps[1].exitCode).toBeNull();
});

it('[case:stop-uncertain] retains its resources and reports cleanup uncertain if stop cannot be confirmed', async () => {
  const opts = options();
  let resources = '';
  const result = await runP04Acceptance({ ...opts, runProcess: async (_command, _args, execution) => {
    resources = dirname(execution.env!.HOME!);
    return { ...PASS, stoppedVerified: false };
  } });
  expect(result.exitCode).not.toBe(0);
  expect(existsSync(resources)).toBe(true);
  const report = JSON.parse(readFileSync(join(result.runDir!, 'report.json'), 'utf8'));
  expect(report.cleanup.confirmed).toBe(false);
  expect(report.cleanup.processesGone).toBe(false);
});

it('[case:report-write-failure] preserves successful step evidence if the report root becomes unwritable', async () => {
  const opts = options();
  const result = await runP04Acceptance({ ...opts, runProcess: async () => {
    if (!existsSync(join(opts.reportRoot, 'reports'))) writeFileSync(join(opts.reportRoot, 'reports'), 'blocked');
    return PASS;
  } });
  expect(result.exitCode).not.toBe(0);
  expect(result.reportWritten).toBe(false);
  expect(result.problems.join('\n')).toMatch(/报告写入失败/);
  expect(JSON.parse(readFileSync(join(result.stepRunDir, 'steps/01-engineering-gate.json'), 'utf8')).exitCode).toBe(0);
});

it('[case:invalid-preflight] rejects wrong commit, dirty code, invalid config and wrong tools without running commands', async () => {
  const opts = options();
  const runProcess = vi.fn(async () => PASS);
  await expect(runP04Acceptance({ ...opts, expectedCommit: 'd'.repeat(40), runProcess })).rejects.toThrow(/commit 不匹配/);
  await expect(runP04Acceptance({ ...opts, exec: (cmd, args) => args.join(' ') === 'status --porcelain' ? ' M source.ts' : opts.exec(cmd, args), runProcess })).rejects.toThrow(/工作树/);
  await expect(runP04Acceptance({ ...opts, config: { ...loadP04AcceptanceConfig(join(ROOT, 'acceptance/p04.config.json')), requiredChecks: [] }, runProcess })).rejects.toThrow(/requiredChecks/);
  await expect(runP04Acceptance({ ...opts, exec: (cmd, args) => cmd === 'npm' ? '1.0.0' : opts.exec(cmd, args), runProcess })).rejects.toThrow(/版本不匹配/);
  expect(runProcess).not.toHaveBeenCalled();
  expect(existsSync(join(opts.reportRoot, 'runs'))).toBe(false);
});

function isolatedRepo() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'p048-entry-repo-')));
  dirs.push(repo);
  for (const file of ['package.json', 'package-lock.json', 'acceptance/p04.config.json', 'acceptance/p04.checklist.json', 'acceptance/p04.entry.json',
    'scripts/acceptance/p04-accept.ts', 'scripts/acceptance/p04-config.ts', 'scripts/acceptance/p04-report.ts', 'scripts/acceptance/p04-steps.ts', 'scripts/acceptance/p04-integration-report.ts', 'scripts/verify.ts', 'scripts/run-tests.ts']) {
    mkdirSync(dirname(join(repo, file)), { recursive: true }); cpSync(join(ROOT, file), join(repo, file));
  }
  const sample = 'test/modules/acceptance/sample.test.ts';
  mkdirSync(dirname(join(repo, sample)), { recursive: true }); writeFileSync(join(repo, sample), 'sample');
  for (let number = 1; number <= 9; number++) {
    const target = join(repo, `test/index/phases/P04/features/P04-${number}/tasks/F-001.json`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ schema_version: 2, task_id: 'F-001', projects: [{ id: 'shiploop', tests: [{ file: sample, all: true }] }] }));
  }
  // P04-9 补充 Feature 的合集声明与 Task 索引必须一致，且入口冻结映射引用的 Task 都已登记。
  const supplementTasks = ['F-001', 'F-002', 'F-003', 'F-004', 'F-005', 'F-006', 'F-007', 'F-008', 'F-009', 'F-010'];
  for (const taskId of supplementTasks) {
    const target = join(repo, `test/index/phases/P04/features/P04-9/tasks/${taskId}.json`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ schema_version: 2, task_id: taskId, projects: [{ id: 'shiploop', tests: [{ file: sample, all: true }] }] }));
  }
  writeFileSync(join(repo, 'test/index/phases/P04/features/P04-9/feature.json'), JSON.stringify({ schema_version: 1, kind: 'feature', phase: 'P04', feature: 'P04-9', scope: 'entry fixture', tasks: supplementTasks.map(taskId => ({ task_id: taskId, index: `test/index/phases/P04/features/P04-9/tasks/${taskId}.json` })) }));
  return repo;
}

it('[case:missing-interface] rejects missing runners, invalid ordering and empty indexes before any subprocess', async () => {
  const opts = options();
  const repoRoot = isolatedRepo();
  const runProcess = vi.fn(async () => PASS);
  const runner = join(repoRoot, 'scripts/run-tests.ts');
  const original = readFileSync(runner);
  rmSync(runner);
  await expect(runP04Acceptance({ ...opts, repoRoot, runProcess })).rejects.toThrow(/入口缺失/);
  writeFileSync(runner, original);
  writeFileSync(join(repoRoot, 'acceptance/p04.entry.json'), JSON.stringify({ schemaVersion: 1, stepOrder: ['p04-integration', 'engineering-gate'] }));
  await expect(runP04Acceptance({ ...opts, repoRoot, runProcess })).rejects.toThrow(/配置无效/);
  cpSync(join(ROOT, 'acceptance/p04.entry.json'), join(repoRoot, 'acceptance/p04.entry.json'));
  const index = join(repoRoot, 'test/index/phases/P04/features/P04-1/tasks/F-001.json');
  writeFileSync(index, JSON.stringify({ schema_version: 2, projects: [{ id: 'shiploop', tests: [] }] }));
  await expect(runP04Acceptance({ ...opts, repoRoot, runProcess })).rejects.toThrow(/空测试索引/);
  expect(runProcess).not.toHaveBeenCalled();
});

it('[case:nonempty-report-and-symlink] refuses pre-existing report content and symlink destinations before executing', async () => {
  const opts = options();
  const runProcess = vi.fn(async () => PASS);
  const report = join(opts.reportRoot, 'reports', opts.runId);
  mkdirSync(report, { recursive: true }); writeFileSync(join(report, 'old-success'), 'keep');
  await expect(runP04Acceptance({ ...opts, runProcess })).rejects.toThrow(/目录已存在/);
  expect(readFileSync(join(report, 'old-success'), 'utf8')).toBe('keep');
  const other = options();
  mkdirSync(join(other.reportRoot, 'runs'));
  symlinkSync(opts.reportRoot, join(other.reportRoot, 'runs', other.runId));
  await expect(runP04Acceptance({ ...other, runProcess })).rejects.toThrow(/符号链接/);
  expect(runProcess).not.toHaveBeenCalled();
});

it('[case:post-step-drift] reports commit drift after the last command as a blocking issue', async () => {
  const opts = options();
  let calls = 0;
  const result = await runP04Acceptance({ ...opts, runProcess: async () => { calls++; return PASS; },
    exec: (cmd, args) => calls === 2 && cmd === 'git' && args.join(' ') === 'rev-parse HEAD' ? 'e'.repeat(40) : opts.exec(cmd, args) });
  expect(result.exitCode).not.toBe(0);
  expect(result.problems.join('\n')).toMatch(/执行期间变化/);
  expect(JSON.parse(readFileSync(join(result.runDir!, 'report.json'), 'utf8')).openIssues).toContainEqual(expect.objectContaining({ id: 'P04-CODE-DRIFT', blocking: true }));
});

it('[case:owned-report-output-is-not-source-drift] ignores only this invocation\'s untracked evidence directory between steps', async () => {
  const isolated = isolatedRepo();
  mkdirSync(join(isolated, 'artifacts'));
  const reportRoot = mkdtempSync(join(isolated, 'artifacts', 'p048-owned-'));
  dirs.push(reportRoot);
  const runId = 'p048-owned-output';
  let statusCalls = 0;
  const opts = options();
  const result = await runP04Acceptance({ ...opts, repoRoot: isolated, reportRoot, runId, runProcess: async () => PASS,
    exec: (command, args) => {
      if (command === 'git' && ['status --porcelain', 'status --porcelain --untracked-files=all'].includes(args.join(' '))) {
        statusCalls++;
        return statusCalls === 1 ? '' : `?? ${relative(isolated, join(reportRoot, 'runs', runId, 'step-run', 'run.json'))}`;
      }
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return COMMIT;
      if (command === 'git' && args[0] === 'rev-parse') return 'b'.repeat(40);
      if (command === 'git' && args[0] === 'branch') return 'feat/p04/p04-acceptance';
      if (command === 'node') return process.version;
      if (command === 'npm') return '10.9.3';
      return 'tool-version';
    } });
  expect(result.steps.map(step => step.exitCode)).toEqual([0, 0]);
  expect(result.problems.join('\n')).not.toMatch(/受测代码在步骤间变化/);
  const report = JSON.parse(readFileSync(join(result.runDir!, 'report.json'), 'utf8'));
  expect(report.git.worktree).toBe('clean');
});

it.each([' M tracked.ts', '?? unrelated/new.ts', '?? artifacts/sibling-run/new.json'])
  ('[case:owned-output-does-not-hide-drift] still rejects %s after startup', async changed => {
    const opts = options();
    let started = false;
    const result = await runP04Acceptance({ ...opts,
      runProcess: async () => { started = true; return PASS; },
      exec: (command, args) => command === 'git' && args[0] === 'status' && started
        ? changed : opts.exec(command, args),
    });
    expect(result.exitCode).toBe(1);
    expect(result.steps[1]!.status).toBe('fail');
    expect(result.problems.join('\n')).toMatch(/受测代码在步骤间变化/);
  });

it('[case:real-exit-code] propagates a real bounded child exit without executing an engineering gate', async () => {
  const opts = options();
  const result = await runP04Acceptance({ ...opts, runProcess: (_cmd, _args, execution) => runBoundedProcess(process.execPath, ['-e', 'process.exit(23)'], execution) });
  expect(result.steps[0]!.exitCode).toBe(23);
  expect(result.steps[1]!.status).toBe('not_run');
  expect(result.exitCode).not.toBe(0);
});

it('[case:overall-budget] exhausts the shared budget without starting the remaining integration step', async () => {
  const opts = options();
  const actualNow = Date.now;
  let offset = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => actualNow() + offset);
  try {
    const runProcess = vi.fn(async () => { offset = 3_000; return PASS; });
    const result = await runP04Acceptance({ ...opts, stepTimeoutMs: 1_000, overallTimeoutMs: 2_000, runProcess });
    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(result.steps[1]!.notRunReason).toBe('budget_exhausted');
    expect(result.exitCode).not.toBe(0);
    expect(result.problems.join('\n')).toMatch(/总.*预算耗尽/);
  } finally { clock.mockRestore(); }
});

it('[case:unknown-exit] retains a missing exit code as null instead of fabricating success', async () => {
  const result = await runP04Acceptance({ ...options(), runProcess: async () => ({ ...PASS, exitCode: null }) });
  expect(result.exitCode).not.toBe(0);
  expect(result.steps[0]!.exitCode).toBeNull();
  expect(result.steps[0]!.endKind).toBe('unknown');
  expect(result.steps[1]!.status).toBe('not_run');
});

it('[case:observe-report-integrity] rejects changed report content without rerunning commands', async () => {
  const opts = options();
  const result = await runP04Acceptance({ ...opts, runProcess: async () => PASS });
  const reportPath = join(result.runDir!, 'report.json');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  report.tools.npm = 'changed-tool-version';
  writeFileSync(reportPath, JSON.stringify(report));
  const runProcess = vi.fn(async () => PASS);
  await expect(runP04Acceptance({ ...opts, observe: true, runProcess })).rejects.toThrow(/报告证据损坏/);
  expect(runProcess).not.toHaveBeenCalled();
});

it('[case:cleanup-failure] does not infer cleanup success when its owned directory cannot be removed as expected', async () => {
  const opts = options();
  let calls = 0;
  const result = await runP04Acceptance({ ...opts, runProcess: async (_cmd, _args, execution) => {
    if (++calls === 2) rmSync(dirname(execution.env!.HOME!), { recursive: true });
    return PASS;
  } });
  expect(result.exitCode).not.toBe(0);
  expect(result.problems.join('\n')).toMatch(/资源清理失败/);
  expect(JSON.parse(readFileSync(join(result.runDir!, 'report.json'), 'utf8')).cleanup.confirmed).toBe(false);
});

it('[case:finite-cli] accepts only finite declared options and requires explicit run identity for observation', () => {
  expect(resolveP04Args(['--run-id', 'sample', '--observe', '--expected-commit', COMMIT])).toEqual({ runId: 'sample', observe: true, expectedCommit: COMMIT });
  for (const args of [['--command', 'echo'], ['--step-timeout-ms', 'Infinity'], ['--step-timeout-ms', '1e4'], ['--run-id'], ['--run-id', '../x'], ['--observe'], ['--help', '--unknown'], ['--run-id', 'x', '--run-id', 'y']]) expect(() => resolveP04Args(args)).toThrow();
});
