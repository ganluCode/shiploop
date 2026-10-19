/**
 * P03-10 / F-013 三 Task 最终验收与收尾重试纵向演示。
 *
 * 复用真实临时 Git/SQLite/Artifact、Host 和 retryFinal CLI，证明三个已通过
 * 的 Task 可以保留历史并独立于失败的 Feature 全量检查；重试只创建受限
 * finalization Run，不启动编码 Runtime，并通过 Feature 报告核对全过程事实。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { runAppCli, type AppCliIo } from '../../../packages/cli/src/app-execute.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import { reportQueries } from '../../helpers/p03-10/report-fixture.ts';
import {
  historicalRunWorkKey,
  prepareEligibleFixture,
  row,
  tableRows,
  type EligibleFinalizationFixture,
} from '../../helpers/p03-9/finalization-retry-fixture.ts';
import {
  createFinalizationPorts,
  defaultCheckDefinitions,
  fixtureBudget,
  startFinalizationHost,
} from '../../helpers/p03-9/finalization-host.ts';

interface CliOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: {
    ok: boolean;
    command: string | null;
    result?: Record<string, unknown>;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
}

function collectIo(): { io: AppCliIo; stdout: () => string; stderr: () => string } {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function runApp(args: readonly string[], dataRoot: string): Promise<CliOutcome> {
  const collected = collectIo();
  const result = await runAppCli({ args: [...args, '--data-root', dataRoot], env: {}, io: collected.io });
  let envelope = result.envelope as CliOutcome['envelope'] | undefined;
  if (envelope === undefined) {
    try { envelope = JSON.parse(collected.stdout()) as CliOutcome['envelope']; } catch { /* use fallback */ }
  }
  return {
    exitCode: result.exitCode,
    stdout: collected.stdout(),
    stderr: collected.stderr(),
    envelope: envelope ?? { ok: false, command: null },
  };
}

function retryArgs(f: EligibleFinalizationFixture, historicalRunId: string): string[] {
  return [
    'execution', 'retry-final', f.box.featureId,
    '--project', f.box.projectId,
    '--historical-run', historicalRunId,
    '--work-key', historicalRunWorkKey(f, historicalRunId),
    '--json',
  ];
}

function injectFailedFeatureBatch(f: EligibleFinalizationFixture): void {
  const db = f.box.session.database;
  const batch = db.prepare(
    "SELECT * FROM verification_batches WHERE operation = 'FeatureVerification.full' ORDER BY rowid DESC LIMIT 1",
  ).get() as Record<string, unknown> | undefined;
  if (batch === undefined) throw new Error('feature verification batch missing');
  const id = `f013-failed-${randomUUID()}`;
  db.prepare(`INSERT INTO verification_batches
    (id, created_at, updated_at, revision, project_id, feature_id, run_id, task_id, attempt_id,
     execution_version, operation, code_digest, policy_digest, environment_summary, check_snapshot,
     selection, status, started_at, ended_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?)`).run(
    id, 1_900_000_100_500, 1_900_000_100_500, batch.project_id, batch.feature_id, batch.run_id,
    batch.task_id, batch.attempt_id, batch.execution_version, batch.operation, batch.code_digest,
    batch.policy_digest, batch.environment_summary, batch.check_snapshot, batch.selection,
    batch.started_at, batch.ended_at,
  );
  const checks = db.prepare('SELECT * FROM check_results WHERE batch_id = ?')
    .all(batch.id as string) as Record<string, unknown>[];
  for (const check of checks) {
    db.prepare(`INSERT INTO check_results
      (id, created_at, updated_at, revision, project_id, batch_id, check_key, argv_json, cwd_ref,
       environment_ref, timeout_ms, required, status, exit_code, signal, timed_out,
       output_artifact_id, output_digest, output_tail, started_at, ended_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', 1, NULL, 0, ?, ?, 'F-013 injected failure', ?, ?)`).run(
      `f013-check-${randomUUID()}`, 1_900_000_100_500, 1_900_000_100_500, check.project_id, id,
      check.check_key, check.argv_json, check.cwd_ref, check.environment_ref, check.timeout_ms,
      check.required, check.output_artifact_id, check.output_digest, check.started_at, check.ended_at,
    );
  }
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 45_000) throw new Error(`等待超时: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const hosts: RunningHost[] = [];
const fixtures: EligibleFinalizationFixture[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const f of fixtures.splice(0)) f.box.close();
});

test('[case:f013-three-task-finalization-retry] 三 Task 通过后最终失败，retryFinal 仅收尾并保留报告历史', async () => {
  const definitions = defaultCheckDefinitions();
  const f = await prepareEligibleFixture({
    taskCount: 3,
    budget: { ...fixtureBudget(8), run: { maxAttemptsPerRun: 8, runTimeLimitMs: 3_600_000 } },
    checkDefinitions: definitions,
  });
  fixtures.push(f);
  const ports = createFinalizationPorts(f, definitions, { feature: 'failed' });
  const started = await startFinalizationHost(f, ports);
  hosts.push(started.host);

  const oldRunId = f.ids.runId;
  const tasksBefore = tableRows(f, 'SELECT * FROM tasks ORDER BY id');
  const attemptsBefore = row<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM attempts')!.n;
  const runtimeStartsBefore = row<{ n: number }>(
    f, 'SELECT runtime_starts AS n FROM execution_batches WHERE id = ?', f.ids.batchId,
  )!.n;
  injectFailedFeatureBatch(f);

  const failed = await runApp(retryArgs(f, oldRunId), f.box.box.dataRoot);
  expect(failed.exitCode, `${failed.stdout}\n${failed.stderr}`).toBe(0);
  expect(failed.envelope.ok).toBe(true);
  const failedResult = failed.envelope.result!;
  const failedRunId = String(failedResult.newRunId);
  expect(failedResult).toMatchObject({
    retryFinal: true,
    historicalRunId: oldRunId,
    runtimeStarts: 0,
    attemptsCreated: 0,
  });
  expect(failedResult.missingSteps).toContain('feature_verification');
  expect(failedResult.missingSteps).not.toContain('task_revalidation');
  await waitFor(() => row<{ status: string }>(f, 'SELECT status FROM runs WHERE id = ?', failedRunId)?.status === 'failed', 'Feature 全量检查失败');

  const failedReport = await reportQueries(f.box).getFeatureReport(
    createLocalOwnerPrincipal(),
    { projectId: f.box.projectId, featureId: f.box.featureId },
  );
  expect(failedReport.tasks).toHaveLength(3);
  expect(failedReport.tasks.map(task => task.current.status)).toEqual(['passed', 'passed', 'passed']);
  expect(failedReport.verifications.some(batch => batch.status === 'failed')).toBe(true);
  expect(failedReport.outcome.status).not.toBe('completed');
  expect(row<{ status: string }>(f, 'SELECT status FROM runs WHERE id = ?', oldRunId)?.status).toBe('failed');
  expect(tableRows(f, 'SELECT * FROM tasks ORDER BY id')).toEqual(tasksBefore);
  expect(row<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM attempts')!.n).toBe(attemptsBefore);
  expect(row<{ n: number }>(f, 'SELECT runtime_starts AS n FROM execution_batches WHERE id = ?', f.ids.batchId)!.n)
    .toBe(runtimeStartsBefore);
  expect(started.starts).toEqual([]);
  expect(ports.calls.feature.map(input => input.checkKeys)).toEqual([['tests']]);

  ports.setBehavior({ feature: 'passed' });
  const recovered = await runApp(retryArgs(f, failedRunId), f.box.box.dataRoot);
  expect(recovered.exitCode, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
  const recoveredResult = recovered.envelope.result!;
  const recoveredRunId = String(recoveredResult.newRunId);
  expect(recoveredResult).toMatchObject({
    retryFinal: true,
    historicalRunId: failedRunId,
    runtimeStarts: 0,
    attemptsCreated: 0,
  });
  await waitFor(
    () => row<{ status: string }>(f, 'SELECT status FROM runs WHERE id = ?', recoveredRunId)?.status === 'succeeded'
      && row<{ status: string }>(f, 'SELECT status FROM features WHERE id = ?', f.box.featureId)?.status === 'completed',
    '仅收尾重试成功',
  );

  const report = await reportQueries(f.box).getFeatureReport(
    createLocalOwnerPrincipal(),
    { projectId: f.box.projectId, featureId: f.box.featureId },
  );
  expect(report.tasks).toHaveLength(3);
  expect(report.tasks.every(task => task.current.status === 'passed')).toBe(true);
  expect(report.verifications.filter(batch => batch.operation === 'FeatureVerification.full')).toHaveLength(4);
  expect(report.outcome.status).toBe('completed');
  expect(report.counts.runs).toBe(3);
  expect(report.counts.attempts).toBe(attemptsBefore);
  expect(tableRows(f, 'SELECT status FROM runs ORDER BY dispatch_ordinal').map(run => run.status))
    .toEqual(['failed', 'failed', 'succeeded']);
  expect(row<{ n: number }>(f, 'SELECT runtime_starts AS n FROM execution_batches WHERE id = ?', f.ids.batchId)!.n)
    .toBe(runtimeStartsBefore);
  expect(started.starts).toEqual([]);
  expect(ports.calls.revalidate).toEqual([]);
  expect(ports.calls.feature.map(input => input.checkKeys)).toEqual([['tests'], ['tests']]);
});
