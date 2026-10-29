import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { collectP06TrustedTests, resolveP06Args, runP06Acceptance } from '../../../scripts/acceptance/p06-accept.ts';
import { runBoundedProcess } from '../../../scripts/acceptance/p02-accept.ts';
import { runP06Process } from '../../../scripts/acceptance/p06-process.ts';
import { P06_ENTRY_STEP_ORDER, P06_FEATURES } from '../../../scripts/acceptance/p06-config.ts';
import { verifyP06ReportDirectory } from '../../../scripts/acceptance/p06-report.ts';

const repoRoot = process.cwd();
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const prerequisites = { approvedBy: 'test-owner', features: P06_FEATURES.map(feature => ({ feature, commit, delivered: true, interfacesSatisfied: true })) };
const probe = (command: string, args: readonly string[]) => command === 'git'
  ? args[0] === 'status' ? '' : args[0] === 'merge-base' ? '' : commit
  : command === 'npm' ? '10.9.3' : 'v22.19.0';

it('[case:entry-preflight] rejects invalid inputs, dirty source and repeated IDs before spawning scenarios', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p06-entry-preflight-'));
  let starts = 0;
  const runProcess: typeof runBoundedProcess = async () => { starts++; throw new Error('must not start'); };
  try {
    expect(() => resolveP06Args(['--step-timeout-ms', 'Infinity'])).toThrow();
    expect(() => resolveP06Args(['--run-id', '../old'])).toThrow();
    expect(() => resolveP06Args(['--run-id', 'same', '--run-id', 'again'])).toThrow();
    await expect(runP06Acceptance({ repoRoot, reportRoot: root, prerequisites, expectedCommit: '0'.repeat(40), probe, runProcess })).rejects.toThrow('commit');
    await expect(runP06Acceptance({ repoRoot, reportRoot: root, prerequisites, probe: (cmd, args) => cmd === 'git' && args[0] === 'status' ? ' M user.txt' : probe(cmd, args), runProcess })).rejects.toThrow('dirty');
    await expect(runP06Acceptance({ repoRoot, reportRoot: root, prerequisites: { ...prerequisites, features: [] }, probe, runProcess })).rejects.toThrow('prerequisite');
    expect(starts).toBe(0);
    expect(readFileSync(join(repoRoot, 'package.json'), 'utf8')).toContain('"accept:p06"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('[case:ordered-evidence-fail-closed] preserves step order and never turns zero subprocess exits into missing scene evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p06-entry-order-'));
  const calls: string[][] = [];
  const runProcess: typeof runBoundedProcess = async (_command, args) => {
    calls.push([...args]);
    return { kind: 'exit', exitCode: 0, signal: null, durationMs: 1, timedOut: false, stdout: '', stderr: '',
      stdoutTruncated: false, stderrTruncated: false, stdoutBytes: 0, stderrBytes: 0, spawnError: null, stoppedVerified: true };
  };
  try {
    const result = await runP06Acceptance({ repoRoot, reportRoot: root, runId: 'first', prerequisites, probe, runProcess });
    expect(result.steps.map(s => s.stepId)).toEqual(P06_ENTRY_STEP_ORDER);
    expect(calls).toHaveLength(3); // Manual gate is an observation, never a fake success command.
    expect(result.steps[3].status).toBe('not_run');
    expect(result.exitCode).toBe(1);
    expect(result.report?.offlineConclusion).toBe('fail');
    expect(result.report?.exitCode).toBe(result.exitCode);
    expect(result.report?.files.some(file => file.path === 'entry/steps.json')).toBe(true);
    expect(result.report?.commands.filter(command => command.scenarioId.startsWith('entry/')).map(command => command.scenarioId)).toEqual(P06_ENTRY_STEP_ORDER.slice(0, 3).map(id => `entry/${id}`));
    expect(verifyP06ReportDirectory(result.reportDir, result.identity).ok).toBe(true);
    const before = readFileSync(join(result.reportDir, 'report.json'));
    await expect(runP06Acceptance({ repoRoot, reportRoot: root, runId: 'first', prerequisites, probe, runProcess })).rejects.toThrow('exists');
    expect(readFileSync(join(result.reportDir, 'report.json'))).toEqual(before);
    const second = await runP06Acceptance({ repoRoot, reportRoot: root, runId: 'second', prerequisites, probe, runProcess });
    expect(second.identity.runId).not.toBe(result.identity.runId);
    expect(second.workDir).not.toBe(result.workDir);
    expect(collectP06TrustedTests(repoRoot).files.length).toBeGreaterThan(20);
    expect(existsSync(join(result.workDir, 'entry-result.json'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('[case:timeout-halts-owned-process] uses the real bounded runner and leaves later steps not_run after a timeout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p06-entry-timeout-'));
  let starts = 0;
  try {
    const result = await runP06Acceptance({ repoRoot, reportRoot: root, runId: 'timeout', prerequisites, probe,
      stepTimeoutMs: 1000, overallTimeoutMs: 5000,
      runProcess: async (_cmd, _args, options) => {
        starts++;
        return runP06Process(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options);
      } });
    expect(starts).toBe(1);
    expect(result.steps[0]).toMatchObject({ status: 'fail', timedOut: true, stoppedVerified: true });
    expect(result.steps.slice(1).every(s => s.status === 'not_run')).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.cleanup.processesGone).toBe(true);
    expect(result.cleanup.resourcesRemoved).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);

it('[case:process-tree-and-output-budget] stops its own parent/child group, preserves an unrelated process and caps captured output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p06-process-tree-'));
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    const pidFile = join(root, 'child.pid');
    const code = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(process.argv[1],String(c.pid));process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000)";
    const result = await runP06Process(process.execPath, ['-e', code, pidFile], { cwd: root, env: {}, timeoutMs: 1000, maxOutputBytes: 1024 });
    expect(result).toMatchObject({ kind: 'timeout', timedOut: true, stoppedVerified: true, stdoutTruncated: true, stdoutBytes: 4096 });
    expect(Buffer.byteLength(result.stdout)).toBe(1024);
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
  } finally {
    unrelated.kill('SIGKILL');
    await new Promise<void>(resolve => { if (unrelated.exitCode !== null || unrelated.signalCode !== null) resolve(); else unrelated.once('close', () => resolve()); });
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

it('[case:uncertain-stop-retains-resources] retains an unconfirmed resource root and binds cleanup failure into the report', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p06-entry-retain-'));
  let retained: string | undefined;
  try {
    const result = await runP06Acceptance({ repoRoot, reportRoot: root, runId: 'uncertain', prerequisites, probe,
      runProcess: async () => ({ kind: 'exit', exitCode: 0, signal: null, durationMs: 1, timedOut: false, stdout: '', stderr: '', stdoutTruncated: false,
        stderrTruncated: false, stdoutBytes: 0, stderrBytes: 0, spawnError: null, stoppedVerified: false }) });
    retained = result.resourceRoot;
    expect(result.cleanup).toEqual({ processesGone: false, resourcesRemoved: false });
    expect(existsSync(join(retained, '.owner'))).toBe(true);
    expect(result.steps.slice(1).every(s => s.status === 'not_run')).toBe(true);
    expect(result.report?.offlineConclusion).toBe('fail');
    expect(result.report?.checks.filter(c => c.execution === 'offline').every(c => c.reason === 'entry_step_or_cleanup_failed')).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(verifyP06ReportDirectory(result.reportDir, result.identity).ok).toBe(true);
  } finally {
    // This executor was a test double and launched no process; the test owns both new directories.
    if (retained) rmSync(retained, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
