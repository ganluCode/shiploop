import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildP07ExecutionPlan, resolveP07Args, validateP07TestReceipt, runP07Acceptance, type P07AcceptanceOptions } from '../../../scripts/acceptance/p07-accept.ts';
import { P07_PREREQUISITE_FEATURES } from '../../../scripts/acceptance/p07-config.ts';
import { P07_SCENE_CHECKS } from '../../../scripts/acceptance/p07-plan.ts';
import { runP07Process, type P07ProcessRunner } from '../../../scripts/acceptance/p07-process.ts';
import { hashP07Input, redactP07EvidenceText, type P07OverrideFacts } from '../../../scripts/acceptance/p07-evidence.ts';
import { verifyP07ReportDirectory } from '../../../scripts/acceptance/p07-report.ts';
import { openBudgetFixture, BUDGET } from '../../helpers/p03-3/budget-fixture.ts';
import { openReportHost } from '../../helpers/p03-10/report-host.ts';
import { waitFor } from '../../helpers/p07-1/fault-barrier-host.ts';

it('[case:p07-entry-partition] executes each selected file once and retains full verify engineering requirements', () => {
  const normal = 'test/modules/recovery/p07-1-f001-budget-cleanup.test.ts';
  const scene = 'test/modules/acceptance/p07-5-f003-verifier-crash.test.ts';
  const plan = buildP07ExecutionPlan([normal, scene], false);
  expect(plan.flatMap(step => step.tests)).toEqual([normal, scene]);
  expect(plan.map(step => step.id)).toEqual(['p07-prerequisites', 'p07-trusted-scope', 'p07-recovery-scenarios', 'p07-boundaries', 'p07-engineering']);
  expect(plan.at(-1)?.args).toEqual(['scripts/verify.ts', '--checks-only']);
  const full = buildP07ExecutionPlan([normal, scene], true);
  expect(full.filter(step => step.tests.length)).toHaveLength(1);
  expect(full.find(step => step.tests.length)?.args.slice(0, 1)).toEqual(['test']);
  expect(full.some(step => step.id === 'p07-recovery-scenarios')).toBe(false);
});

it('[case:p07-entry-zero-tests] rejects zero tests, skipped selected files, wrong paths and failed assertions despite exit zero', () => {
  const file = 'test/modules/acceptance/example.test.ts';
  const receipt = { numTotalTests: 1, numPassedTests: 1, success: true, testResults: [
    { name: join(process.cwd(), file), status: 'passed', assertionResults: [{ status: 'passed', title: 'real assertion' }] },
  ] };
  expect(() => validateP07TestReceipt(receipt, [file], process.cwd())).not.toThrow();
  expect(() => validateP07TestReceipt({ ...receipt, numTotalTests: 0 }, [file], process.cwd())).toThrow('zero');
  expect(() => validateP07TestReceipt({ ...receipt, testResults: [] }, [file], process.cwd())).toThrow('missing');
  expect(() => validateP07TestReceipt({ ...receipt, success: false }, [file], process.cwd())).toThrow();
});

it('[case:p07-entry-cli-closed] rejects executor/probe injection, live options, unsafe run IDs and invalid budgets', () => {
  for (const args of [['--run-process', 'fake'], ['--probe', 'fake'], ['--live-authorized', 'x'], ['--run-id', '../x'], ['--step-timeout-ms', 'Infinity']]) {
    expect(() => resolveP07Args(args)).toThrow();
  }
  expect(resolveP07Args(['--full-regression', '--run-id', 'unique'])).toMatchObject({ fullRegression: true, runId: 'unique' });
});

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const prerequisites = { approvedBy: 'controller-test', features: P07_PREREQUISITE_FEATURES.map(feature => ({
  feature, commit, delivered: true, interfacesSatisfied: true, deliveryEvidence: ['local-fixture-receipt'], publicInterfaces: ['Core/Host/CLI'],
})) };
const probe = (command: string, args: readonly string[]) => command === 'git'
  ? args[0] === 'status' || args[0] === 'merge-base' ? '' : commit
  : command === 'npm' ? '10.9.3' : 'v22.19.0';
const outcome = { kind: 'exit' as const, exitCode: 0, signal: null, durationMs: 1, timedOut: false, stdout: '', stderr: '',
  stdoutTruncated: false, stderrTruncated: false, stdoutBytes: 0, stderrBytes: 0, spawnError: null, stoppedVerified: true };
const save = (file: string, value: unknown) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
function syntheticFacts(): P07OverrideFacts {
  const rows = [{ id: 'test-run', status: 'completed' }];
  return {
    sqlite: { source: 'controller-test-double', tables: [{ name: 'runs', rows, count: 1, digest: hashP07Input(rows) }] },
    git: { repositories: [{ repository: 'controller-test', head: 'a'.repeat(40), tree: 'b'.repeat(40), branch: 'main', baseCommit: 'c'.repeat(40), headBeyondBase: true, statusEntries: [], worktreePath: null, workspaceGone: false }] },
    process: { owned: true, descendantsChecked: true, processes: [] },
    artifact: { artifacts: [{ projectId: 'p', artifactId: 'a', kind: 'test', contentHash: 'd'.repeat(64), sizeBytes: 10 }] },
    budget: { budget: { runId: 'test-run', attemptsCreated: 1, runtimeStarts: 1, deadlineAt: 1900000000000 } },
    notification: { channelIds: ['local-results'], deliveries: [{ id: 'd', eventId: 'e', channelId: 'local-results', status: 'delivered', attemptCount: 1 }], results: [{ deliveryId: 'd', attempt: 1, outcome: 'succeeded' }], taskRerunObserved: false },
    archive: { operations: [{ operation: 'project.archive', projectId: 'p', outcome: 'completed' }], recordsRetained: true },
  };
}
function executor(product?: unknown, mutate?: (step: string) => Partial<typeof outcome>): P07ProcessRunner {
  return async (_command, args, options) => {
    const receipt = args.find(arg => arg.startsWith('--outputFile.json='))?.slice('--outputFile.json='.length);
    const step = receipt?.split('/').at(-1)?.replace('-tests.json', '') ?? (args[0] === 'scripts/build-host-lock.ts' ? 'p07-prerequisites' : 'engineering');
    if (receipt) {
      const material = JSON.parse(readFileSync(join(receipt, '../inputs.json'), 'utf8')).material;
      const tests = step === 'p07-recovery-scenarios' ? material.executed.filter((file: string) => P07_SCENE_CHECKS[file])
        : material.fullRegression ? material.executed : material.executed.filter((file: string) => !P07_SCENE_CHECKS[file]);
      save(receipt, { numTotalTests: tests.length, numPassedTests: tests.length, success: true,
        testResults: tests.map((file: string) => ({ name: join(process.cwd(), file), status: 'passed', assertionResults: [{ title: file.endsWith('p07-5-f010-report.test.ts') ? '[case:p07-f010-real-drill-report]' : 'controller assertion', status: 'passed' }] })) });
      for (const [file, checkId] of Object.entries(P07_SCENE_CHECKS)) if (tests.includes(file)) {
        save(join(options.env!.SHIPLOOP_P07_ENTRY_SOURCE!, 'captures', `${hashP07Input(file)}.json`), {
          identity: JSON.parse(options.env!.SHIPLOOP_P07_ENTRY_IDENTITY!), file, title: file.endsWith('p07-5-f010-report.test.ts') ? '[case:p07-f010-real-drill-report]' : 'controller assertion', checkId, passed: true, assertions: 1,
          observations: [{ facts: syntheticFacts(), removed: true }],
          products: product && file.endsWith('p07-5-f010-report.test.ts') ? [product] : [],
        });
      }
    }
    return { ...outcome, ...mutate?.(step) };
  };
}
function options(root: string, runId: string, runProcess: P07ProcessRunner): P07AcceptanceOptions {
  return { repoRoot: process.cwd(), reportRoot: root, runId, testing: { prerequisites, probe, platform: 'darwin', runProcess } };
}

it('[case:p07-entry-success-report] publishes verified offline success with real product data, unique IDs, scope bindings and an independent pending owner gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p07-entry-success-'));
  const fixture = await openBudgetFixture(BUDGET);
  let host: Awaited<ReturnType<typeof openReportHost>> | undefined;
  try {
    await fixture.start(); host = await openReportHost(fixture);
    const report = await host.client.getFeatureReport(fixture.projectId, fixture.featureId);
    const product = JSON.parse(redactP07EvidenceText(JSON.stringify({ schemaVersion: 1, source: 'features.report.get', mode: 'offline-fixture',
      projectId: fixture.projectId, featureId: fixture.featureId, report }), [process.cwd(), process.execPath], fixture.box.root));
    const result = await runP07Acceptance(options(root, 'success', executor(product)));
    expect(result.report, JSON.stringify(result.report?.blockingIssues)).toMatchObject({ offlineConclusion: 'pass', conclusion: 'fail' });
    expect(result).toMatchObject({ exitCode: 1, phaseAccepted: false, reportVerified: true, cleanup: { processesGone: true, resourcesRemoved: true } });
    expect(result.report?.checks.find(check => check.execution === 'manual')).toMatchObject({ status: 'not_run', reason: 'owner_pending' });
    expect(result.report?.checks.find(check => check.group === 'deferred')).toMatchObject({ status: 'not_run' });
    expect(result.report?.knownGaps).toContain('full_history_not_run');
    expect(result.report?.files).toContainEqual(expect.objectContaining({ path: 'entry/run.json' }));
    expect(verifyP07ReportDirectory(result.reportDir, result.identity).ok).toBe(true);
    const previous = readFileSync(join(result.reportDir, 'report.json'));
    await expect(runP07Acceptance(options(root, 'success', executor(product)))).rejects.toThrow('run_exists');
    expect(readFileSync(join(result.reportDir, 'report.json'))).toEqual(previous);
    const second = await runP07Acceptance({ ...options(root, 'second', executor(product)), fullRegression: true });
    expect(second.workDir).not.toBe(result.workDir);
    expect(second.report?.offlineConclusion).toBe('pass');
    expect(second.report?.executionScope).toMatchObject({ mode: 'full', fullHistoryStatus: 'pass', fullHistoryStepId: 'p07-trusted-scope' });
    expect(result.report?.executionScope).toMatchObject({ mode: 'phase', fullHistoryStatus: 'not_run' });
    expect(second.identity.inputDigest).not.toBe(result.identity.inputDigest);
    expect(second.steps.some(step => step.id === 'p07-recovery-scenarios')).toBe(false);
  } finally { await host?.close(); fixture.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);

it.each(['p07-prerequisites', 'p07-recovery-scenarios'])('[case:p07-entry-failure-%s] halts required later steps on preparation or scenario exit failure', async failedStep => {
  const root = mkdtempSync(join(tmpdir(), 'p07-entry-failure-'));
  try {
    const result = await runP07Acceptance(options(root, 'failure', executor(undefined, step => step === failedStep ? { exitCode: 7 } : {})));
    const index = result.steps.findIndex(step => step.id === failedStep);
    expect(result.steps[index]).toMatchObject({ status: 'fail', exitCode: 7 });
    expect(result.steps.slice(index + 1).every(step => step.status === 'not_run')).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.report?.offlineConclusion).toBe('fail');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('[case:p07-entry-zero-receipt-halts] preserves real exit zero while failing missing test execution and halting scenarios', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p07-entry-zero-'));
  try {
    const result = await runP07Acceptance(options(root, 'zero', async () => outcome));
    expect(result.steps[1]).toMatchObject({ status: 'fail', exitCode: 0, reason: 'zero_missing_or_failed_test_receipt' });
    expect(result.steps.slice(2).every(step => step.status === 'not_run')).toBe(true);
    expect(result.reportVerified).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('[case:p07-entry-missing-case-capture] rejects a missing case capture even when another case for the same check passed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p07-entry-missing-capture-'));
  try {
    const base = executor();
    const runner: P07ProcessRunner = async (command, args, opts) => {
      const result = await base(command, args, opts);
      if (args.includes('test/modules/acceptance/p07-5-f009-result-query-independence.test.ts')) {
        unlinkSync(join(opts.env!.SHIPLOOP_P07_ENTRY_SOURCE!, 'captures', `${hashP07Input('test/modules/acceptance/p07-5-f009-result-query-independence.test.ts')}.json`));
      }
      return result;
    };
    const result = await runP07Acceptance(options(root, 'missing', runner));
    expect(result.report?.checks.find(check => check.checkId === 'P07-T12-NOTIFICATION-INDEPENDENT-RETRY')).toMatchObject({ status: 'not_run', reason: 'required_scenarios_not_run' });
    expect(result.report?.offlineConclusion).toBe('fail');
    expect(result.exitCode).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('[case:p07-entry-uncertain-cleanup] retains the owned root when stopping is unconfirmed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p07-entry-stop-'));
  let retained: string | null = null;
  try {
    const result = await runP07Acceptance(options(root, 'stop', async () => ({ ...outcome, stoppedVerified: false })));
    retained = result.resourceRoot;
    expect(result.cleanup).toEqual({ processesGone: false, resourcesRemoved: false });
    expect(existsSync(join(retained!, '.owner'))).toBe(true);
    expect(result.steps.slice(1).every(step => step.status === 'not_run')).toBe(true);
    expect(result.exitCode).toBe(1);
  } finally { if (retained) rmSync(retained, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

it('[case:p07-entry-report-write-fails] records a diagnostic and cleans its resources when report publication throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p07-entry-publish-'));
  try {
    const input = options(root, 'publish', executor()); input.testing!.publish = () => { throw new Error('injected report write failure'); };
    await expect(runP07Acceptance(input)).rejects.toThrow('publication');
    expect(JSON.parse(readFileSync(join(root, 'runs/publish/diagnostic.json'), 'utf8'))).toMatchObject({ phaseAccepted: false, cleanup: { processesGone: true, resourcesRemoved: true } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('[case:p07-entry-preflight-and-drift] rejects wrong identities, dirty source, non-ancestors, wrong platforms and drift before spawning further work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p07-entry-preflight-'));
  let starts = 0;
  const runner: P07ProcessRunner = async () => { starts++; return outcome; };
  try {
    await expect(runP07Acceptance({ ...options(root, 'sha', runner), expectedCommit: 'f'.repeat(40) })).rejects.toThrow('commit_mismatch');
    const dirty = options(root, 'dirty', runner); dirty.testing!.probe = (cmd, args) => cmd === 'git' && args[0] === 'status' ? ' M source.ts' : probe(cmd, args);
    await expect(runP07Acceptance(dirty)).rejects.toThrow('dirty_source');
    const ancestor = options(root, 'ancestor', runner); ancestor.testing!.probe = (cmd, args) => { if (args[0] === 'merge-base') throw new Error('not an ancestor'); return probe(cmd, args); };
    await expect(runP07Acceptance(ancestor)).rejects.toThrow('prerequisite');
    const platform = options(root, 'platform', runner); platform.testing!.platform = 'linux';
    await expect(runP07Acceptance(platform)).rejects.toThrow('platform');
    expect(starts).toBe(0);
    const drift = options(root, 'drift', runner); let reads = 0;
    drift.testing!.probe = (cmd, args) => args[0] === 'status' && ++reads > 1 ? ' M source.ts' : probe(cmd, args);
    const result = await runP07Acceptance(drift);
    expect(result.steps.every(step => step.status === 'not_run')).toBe(true);
    expect(result.steps[0].reason).toBe('input_drift');
    expect(starts).toBe(0);
    await expect(runP07Acceptance({ ...options(root, 'bad-root', runner), reportRoot: join(process.cwd(), 'packages/core') })).rejects.toThrow('report_root');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('[case:p07-entry-timeout-and-cancel] stops real owned subprocesses on timeout or cancellation and preserves not_run successors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p07-entry-timeout-'));
  try {
    const timeout = await runP07Acceptance({ ...options(root, 'timeout', async (_cmd, _args, opts) =>
      runP07Process(process.execPath, ['-e', 'setInterval(()=>{},1000)'], opts)), stepTimeoutMs: 1000, overallTimeoutMs: 5000 });
    expect(timeout.steps[0]).toMatchObject({ status: 'fail', timedOut: true, stoppedVerified: true });
    expect(timeout.steps.slice(1).every(step => step.status === 'not_run')).toBe(true);
    const signal = new AbortController();
    const marker = join(root, 'ready');
    const runner: P07ProcessRunner = async (_cmd, _args, opts) => {
      const pending = runP07Process(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], 'ready');setInterval(()=>{},1000)", marker], opts);
      await waitFor(() => existsSync(marker), 'owned child ready', 5000); signal.abort(); return pending;
    };
    const cancelled = await runP07Acceptance({ ...options(root, 'cancel', runner), signal: signal.signal });
    expect(cancelled.steps[0]).toMatchObject({ status: 'fail', reason: 'cancelled', stoppedVerified: true });
    expect(cancelled.steps.slice(1).every(step => step.status === 'not_run')).toBe(true);
    expect(cancelled.cleanup).toEqual({ processesGone: true, resourcesRemoved: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);
