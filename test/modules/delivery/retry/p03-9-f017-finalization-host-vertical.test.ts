/**
 * P03-9 / F-017 finalization-only Host/CLI 端到端回归。
 *
 * 真实临时 Git/SQLite/Artifact + 真实 Host + runAppCli → HostClient → Core；
 * 检查执行使用确定性受信 Verifier（零模型）。覆盖：仅最终检查失败后的显式
 * retryFinal 只执行缺失收尾、零重复编码、旧 Run 终态保留、workKey/预算计数、
 * 提交失败/回执缺失/人审解除、证据失效、预算与控制拒绝及并发去重。
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { runAppCli, type AppCliIo } from '../../../../packages/cli/src/app-execute.ts';
import type { RunningHost } from '../../../../packages/host/src/runtime/index.ts';
import { git } from '../../../helpers/git-repo.ts';
import {
  changeSource,
  historicalRunWorkKey,
  prepareEligibleFixture,
  row,
  tableRows,
  type EligibleFinalizationFixture,
} from '../../../helpers/p03-9/finalization-retry-fixture.ts';
import { deriveArtifactFinalRelativePath } from '../../../../packages/core/src/ports/artifact-files.ts';
import {
  bindEvidenceToCurrentSource,
  createFinalizationPorts,
  defaultCheckDefinitions,
  fixtureBudget,
  startFinalizationHost,
  type FinalizationBehavior,
  type FinalizationHost,
  type FinalizationPorts,
} from '../../../helpers/p03-9/finalization-host.ts';

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
  const result = await runAppCli({
    args: [...args, '--data-root', dataRoot],
    env: {},
    io: collected.io,
  });
  let envelope = result.envelope as CliOutcome['envelope'] | undefined;
  if (envelope === undefined) {
    try {
      envelope = JSON.parse(collected.stdout()) as CliOutcome['envelope'];
    } catch {
      envelope = undefined;
    }
  }
  return {
    exitCode: result.exitCode,
    stdout: collected.stdout(),
    stderr: collected.stderr(),
    envelope: envelope ?? ({ ok: false } as CliOutcome['envelope']),
  };
}

function okResult(outcome: CliOutcome, command: string): Record<string, unknown> {
  expect(outcome.exitCode, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
  expect(outcome.envelope.ok).toBe(true);
  expect(outcome.envelope.command).toBe(command);
  return outcome.envelope.result as Record<string, unknown>;
}

function failureOf(outcome: CliOutcome): { code: string; details?: Record<string, unknown> } {
  expect(outcome.envelope.ok, outcome.stdout).toBe(false);
  expect(outcome.envelope.error, outcome.stdout).toBeDefined();
  return { code: outcome.envelope.error!.code, details: outcome.envelope.error!.details };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 45_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时: ${label}`);
    await delay(25);
  }
}

function runStatus(f: EligibleFinalizationFixture, runId: string): string {
  return (row<{ status: string }>(f, 'SELECT status FROM runs WHERE id = ?', runId))?.status ?? '<missing>';
}

function featureStatus(f: EligibleFinalizationFixture): string {
  return (row<{ status: string }>(f, 'SELECT status FROM features WHERE id = ?', f.box.featureId))!.status;
}

function runtimeStarts(f: EligibleFinalizationFixture): number {
  return row<{ n: number }>(f, 'SELECT runtime_starts AS n FROM execution_batches WHERE id = ?', f.ids.batchId)!.n;
}

function commitCount(f: EligibleFinalizationFixture): number {
  return Number(git(['rev-list', '--count', 'HEAD'], f.box.box.repoDirA, { home: f.box.box.homeDir }).trim());
}

function oldRunSnapshot(f: EligibleFinalizationFixture, runId: string) {
  return row<{ status: string; reason: string | null; revision: number; work_key: string; dispatch_ordinal: number }>(
    f, 'SELECT status, reason, revision, work_key, dispatch_ordinal FROM runs WHERE id = ?', runId,
  );
}


function injectFailedFeatureBatch(f: EligibleFinalizationFixture): void {
  const db = f.box.session.database;
  const batch = db.prepare(
    "SELECT * FROM verification_batches WHERE operation = 'FeatureVerification.full' ORDER BY rowid DESC LIMIT 1",
  ).get() as Record<string, unknown>;
  if (batch === undefined) throw new Error('feature verification batch missing');
  const id = `failed-final-${randomUUID()}`;
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
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', 1, NULL, 0, ?, ?, 'injected failure', ?, ?)`).run(
      `failed-final-${randomUUID()}`, 1_900_000_100_500, 1_900_000_100_500, check.project_id, id,
      check.check_key, check.argv_json, check.cwd_ref, check.environment_ref, check.timeout_ms,
      check.required, check.output_artifact_id, check.output_digest, check.started_at, check.ended_at,
    );
  }
}

function retryArgs(f: EligibleFinalizationFixture, oldRunId: string, commandId?: string): string[] {
  const args = [
    'execution', 'retry-final', f.box.featureId,
    '--project', f.box.projectId,
    '--historical-run', oldRunId,
    '--work-key', historicalRunWorkKey(f, oldRunId),
    '--json',
  ];
  if (commandId !== undefined) args.push('--command-id', commandId);
  return args;
}

const running: RunningHost[] = [];
const fixtures: EligibleFinalizationFixture[] = [];

afterEach(async () => {
  for (const host of running.splice(0)) {
    try {
      await host.close();
    } catch (error) {
      /* 保持测试失败原因可见，但尝试关闭已创建资源。 */
      process.stderr.write(`F-017 host close: ${(error as Error).message}\n`);
    }
  }
  for (const f of fixtures.splice(0)) f.box.close();
});

async function openCase(options: {
  readonly budget?: ReturnType<typeof fixtureBudget>;
  readonly approvalStatus?: 'approved' | 'pending' | 'rejected';
  readonly behavior?: FinalizationBehavior;
  readonly bindSource?: string;
} = {}): Promise<{
  f: EligibleFinalizationFixture;
  dataRoot: string;
  start: FinalizationHost;
  ports: FinalizationPorts;
}> {
  const f = await prepareEligibleFixture({
    taskCount: 1,
    budget: options.budget ?? fixtureBudget(4),
    checkDefinitions: defaultCheckDefinitions(),
    ...(options.approvalStatus === undefined ? {} : { approvalStatus: options.approvalStatus }),
  });
  fixtures.push(f);
  if (options.bindSource !== undefined) await bindEvidenceToCurrentSource(f, options.bindSource);
  const ports = createFinalizationPorts(f, defaultCheckDefinitions(), options.behavior ?? {});
  const start = await startFinalizationHost(f, ports);
  running.push(start.host);
  return { f, dataRoot: f.box.box.dataRoot, start, ports };
}


function hook(f: EligibleFinalizationFixture, body: string): void {
  const dir = join(f.inspection.repository.gitCommonDir, 'hooks');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pre-commit');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function removeHook(f: EligibleFinalizationFixture): void {
  rmSync(join(f.inspection.repository.gitCommonDir, 'hooks', 'pre-commit'), { force: true });
}

async function approvePlan(f: EligibleFinalizationFixture): Promise<void> {
  const feature = row<{ plan_digest: string; revision: number }>(
    f, 'SELECT plan_digest, revision FROM features WHERE id = ?', f.box.featureId,
  )!;
  const receipt = await f.box.submit('feature.plan.decide', {
    featureId: f.box.featureId,
    planDigest: feature.plan_digest,
    decision: 'approve',
    reason: 'F-017 check policy re-approval',
  }, { scope: f.box.scope, expectedRevision: feature.revision });
  if (receipt.status !== 'completed') throw new Error(`approvePlan failed: ${JSON.stringify(receipt)}`);
}

async function updateCheckDefinitions(
  f: EligibleFinalizationFixture,
  definitions: ReturnType<typeof defaultCheckDefinitions>,
): Promise<void> {
  const settings = row<{ revision: number }>(
    f, 'SELECT revision FROM project_settings WHERE project_id = ?', f.box.projectId,
  )!;
  const receipt = await f.box.submit('settings.project.update', {
    schemaVersion: 2,
    policies: {
      verification: {
        requireChecksBeforeDone: true,
        checkDefinitions: definitions,
        fullFallback: { checkRefs: definitions.map(definition => definition.checkKey) },
      },
    },
  }, { scope: f.box.scope, expectedRevision: settings.revision });
  if (receipt.status !== 'completed') throw new Error(`settings update failed: ${JSON.stringify(receipt)}`);
}

function runCount(f: EligibleFinalizationFixture): number {
  return row<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM runs')!.n;
}

function gitOperationStatuses(f: EligibleFinalizationFixture): string[] {
  return tableRows<{ status: string }>(f, 'SELECT status FROM git_operations ORDER BY rowid')
    .map(item => item.status);
}

describe('P03-9 / F-017 Host/CLI finalization-only end-to-end', () => {
  it('最终检查失败后 retryFinal 只执行缺失收尾；零编码、旧 Run 不变、workKey/历史保留', async () => {
    const { f, dataRoot, start, ports } = await openCase({ behavior: { feature: 'failed' } });
    const oldRunId = f.ids.runId;
    const oldRun = oldRunSnapshot(f, oldRunId);
    const tasksBefore = tableRows(f, 'SELECT * FROM tasks ORDER BY id');
    const attemptsBefore = row<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM attempts')!.n;
    const workKey = historicalRunWorkKey(f, oldRunId);
    const commitsBefore = commitCount(f);
    const startsBefore = runtimeStarts(f);

    /* 模拟最终检查失败：Task 证据仍有效，仅 Feature 全量批次失败。 */
    injectFailedFeatureBatch(f);

    const first = await runApp(retryArgs(f, oldRunId), dataRoot);
    const firstResult = okResult(first, 'execution.retry-final');
    const firstRunId = String(firstResult.newRunId);
    expect(firstResult).toMatchObject({
      retryFinal: true,
      historicalRunId: oldRunId,
      workKey,
      runtimeStarts: 0,
      attemptsCreated: 0,
    });
    expect(firstResult.missingSteps).toContain('feature_verification');
    expect(firstResult.missingSteps).not.toContain('task_revalidation');

    await waitFor(() => runStatus(f, firstRunId) === 'failed', '第一次收尾 Run 失败');
    expect(ports.calls.feature.map(input => input.checkKeys)).toEqual([['tests']]);
    ports.calls.feature.splice(0);
    expect(row(f, 'SELECT work_key, dispatch_ordinal FROM runs WHERE id = ?', firstRunId))
      .toMatchObject({ work_key: workKey, dispatch_ordinal: 2 });
    expect(runtimeStarts(f)).toBe(startsBefore);
    expect(start.starts).toEqual([]);
    expect(tableRows(f, 'SELECT * FROM tasks ORDER BY id')).toEqual(tasksBefore);
    expect(row(f, 'SELECT COUNT(*) AS n FROM attempts')!.n).toBe(attemptsBefore);
    expect(oldRunSnapshot(f, oldRunId)).toEqual(oldRun);

    /* 清除失败条件后再次显式重试；仍只做最终检查，不启动编码。 */
    ports.setBehavior({ feature: 'passed' });
    const second = await runApp(retryArgs(f, firstRunId), dataRoot);
    const secondResult = okResult(second, 'execution.retry-final');
    const secondRunId = String(secondResult.newRunId);
    expect(secondResult).toMatchObject({ historicalRunId: firstRunId, workKey, runtimeStarts: 0, attemptsCreated: 0 });
    await waitFor(
      () => runStatus(f, secondRunId) === 'succeeded' && featureStatus(f) === 'completed',
      '第二次收尾 Run 完成',
    );
    expect(ports.calls.revalidate).toEqual([]);
    expect(ports.calls.feature.map(input => input.checkKeys)).toEqual([['tests']]);
    expect(runtimeStarts(f)).toBe(startsBefore);
    expect(start.starts).toEqual([]);
    expect(tableRows(f, 'SELECT * FROM tasks ORDER BY id')).toEqual(tasksBefore);
    expect(row(f, 'SELECT COUNT(*) AS n FROM attempts')!.n).toBe(attemptsBefore);
    expect(oldRunSnapshot(f, oldRunId)).toEqual(oldRun);
    expect(commitCount(f)).toBe(commitsBefore);
    expect(row(f, 'SELECT status, delivery_status FROM features WHERE id = ?', f.box.featureId))
      .toMatchObject({ status: 'completed', delivery_status: 'succeeded' });
  }, 120_000);
  it('仅提交失败后 retryFinal 只重试缺失提交；一次提交、零重复检查/编码', async () => {
    const { f, dataRoot, start, ports } = await openCase({ bindSource: 'export const project = "commit-failure";\n' });
    const oldRunId = f.ids.runId;
    const oldRun = oldRunSnapshot(f, oldRunId);
    const workKey = historicalRunWorkKey(f, oldRunId);
    const attemptsBefore = row<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM attempts')!.n;
    const startsBefore = runtimeStarts(f);
    const commitsBefore = commitCount(f);

    hook(f, 'exit 1');
    const first = await runApp(retryArgs(f, oldRunId), dataRoot);
    const firstResult = okResult(first, 'execution.retry-final');
    const firstRunId = String(firstResult.newRunId);
    expect(firstResult.missingSteps).toContain('commit');
    await waitFor(() => runStatus(f, firstRunId) === 'failed', '提交失败 Run 落为 failed');
    expect(gitOperationStatuses(f)).toEqual(['failed']);
    expect(commitCount(f)).toBe(commitsBefore);
    expect(ports.calls.revalidate).toEqual([]);
    expect(ports.calls.feature).toEqual([]);
    expect(start.starts).toEqual([]);
    expect(runtimeStarts(f)).toBe(startsBefore);
    expect(oldRunSnapshot(f, oldRunId)).toEqual(oldRun);

    removeHook(f);
    const second = await runApp(retryArgs(f, firstRunId), dataRoot);
    const secondResult = okResult(second, 'execution.retry-final');
    const secondRunId = String(secondResult.newRunId);
    expect(secondResult.missingSteps).toContain('commit');
    await waitFor(
      () => runStatus(f, secondRunId) === 'succeeded' && featureStatus(f) === 'completed',
      '提交重试完成 Feature',
    );
    expect(ports.calls.revalidate).toEqual([]);
    expect(ports.calls.feature).toEqual([]);
    expect(start.starts).toEqual([]);
    expect(runtimeStarts(f)).toBe(startsBefore);
    expect(row(f, 'SELECT COUNT(*) AS n FROM attempts')!.n).toBe(attemptsBefore);
    expect(commitCount(f)).toBe(commitsBefore + 1);
    expect(gitOperationStatuses(f)).toEqual(['failed', 'succeeded']);

    /* 已完成的副作用不被再次执行。 */
    const again = await runApp(retryArgs(f, secondRunId), dataRoot);
    expect(again.exitCode).toBe(1);
    expect(failureOf(again).code).toBe('conflict');
    expect(commitCount(f)).toBe(commitsBefore + 1);
  }, 120_000);

  it('提交已发生但回执缺失时先核对真实 Git 事实，重试不重复提交', async () => {
    const { f, dataRoot, start, ports } = await openCase({ bindSource: 'export const project = "lost-receipt";\n' });
    const oldRunId = f.ids.runId;
    const workKey = historicalRunWorkKey(f, oldRunId);
    const startsBefore = runtimeStarts(f);
    const commitsBefore = commitCount(f);

    f.box.session.database.exec(`CREATE TRIGGER f017_receipt_fault BEFORE UPDATE ON git_operations
      WHEN NEW.status <> 'pending' BEGIN SELECT RAISE(ABORT, 'injected receipt fault'); END`);
    const first = await runApp(retryArgs(f, oldRunId), dataRoot);
    const firstResult = okResult(first, 'execution.retry-final');
    const firstRunId = String(firstResult.newRunId);
    await waitFor(() => runStatus(f, firstRunId) === 'failed', '回执缺失 Run 失败');
    expect(commitCount(f)).toBe(commitsBefore + 1);
    expect(gitOperationStatuses(f)).toEqual(['pending']);
    f.box.session.database.exec('DROP TRIGGER f017_receipt_fault');

    const second = await runApp(retryArgs(f, firstRunId), dataRoot);
    const secondResult = okResult(second, 'execution.retry-final');
    const secondRunId = String(secondResult.newRunId);
    await waitFor(
      () => runStatus(f, secondRunId) === 'succeeded' && featureStatus(f) === 'completed',
      '核对回执后完成 Feature',
    );
    expect(commitCount(f)).toBe(commitsBefore + 1);
    expect(gitOperationStatuses(f)).toContain('succeeded');
    expect(ports.calls.revalidate).toEqual([]);
    expect(ports.calls.feature).toEqual([]);
    expect(start.starts).toEqual([]);
    expect(runtimeStarts(f)).toBe(startsBefore);
    expect(workKey).toBe(historicalRunWorkKey(f, oldRunId));
  }, 120_000);

  it('等待人审解除：批准本身不启动，显式 resume 后才继续收尾', async () => {
    const { f, dataRoot, start, ports } = await openCase({ approvalStatus: 'pending' });
    const oldRunId = f.ids.runId;
    const workKey = historicalRunWorkKey(f, oldRunId);
    const startsBefore = runtimeStarts(f);
    const commitsBefore = commitCount(f);

    const created = await runApp(retryArgs(f, oldRunId), dataRoot);
    const createdResult = okResult(created, 'execution.retry-final');
    const runId = String(createdResult.newRunId);
    await waitFor(
      () => runStatus(f, runId) === 'paused' && featureStatus(f) === 'awaiting_approval',
      '收尾 Run 等待人审',
    );
    expect(gitOperationStatuses(f)).toEqual([]);
    expect(commitCount(f)).toBe(commitsBefore);
    expect(start.starts).toEqual([]);

    const item = row<{ id: string; revision: number; plan_digest: string; code_digest: string }>(
      f, "SELECT id, revision, plan_digest, code_digest FROM task_approval_items WHERE status = 'pending' LIMIT 1",
    )!;
    const approved = await runApp([
      'feature', 'final-approve', f.box.featureId, '--project', f.box.projectId,
      '--task', 't-1', '--item', item.id, '--digest', item.plan_digest,
      '--code-digest', item.code_digest, '--revision', String(item.revision),
      '--confirm', '--json',
    ], dataRoot);
    okResult(approved, 'feature.final-approve');
    await delay(1_200);
    expect(runStatus(f, runId)).toBe('paused');
    expect(commitCount(f)).toBe(commitsBefore);
    expect(gitOperationStatuses(f)).toEqual([]);
    expect(start.starts).toEqual([]);
    expect(workKey).toBe(historicalRunWorkKey(f, oldRunId));

    const currentRun = row<{ revision: number }>(f, 'SELECT revision FROM runs WHERE id = ?', runId)!;
    const resumed = await runApp([
      'execution', 'resume', '--project', f.box.projectId, '--run', runId,
      '--revision', String(currentRun.revision), '--json',
    ], dataRoot);
    okResult(resumed, 'execution.resume');
    await waitFor(
      () => runStatus(f, runId) === 'succeeded' && featureStatus(f) === 'completed',
      '人审解除后完成 Feature',
    );
    expect(ports.calls.revalidate).toEqual([]);
    expect(ports.calls.feature).toEqual([]);
    expect(start.starts).toEqual([]);
    expect(runtimeStarts(f)).toBe(startsBefore);
    expect(commitCount(f)).toBe(commitsBefore);
  }, 120_000);

  it('修改源码后重试必须重验相关 Task 与最终检查，不沿用历史 passed', async () => {
    const { f, dataRoot, start, ports } = await openCase({ behavior: { feature: 'failed' } });
    const oldRunId = f.ids.runId;
    const tasksBefore = tableRows(f, 'SELECT * FROM tasks ORDER BY id');
    const attemptsBefore = row<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM attempts')!.n;
    const startsBefore = runtimeStarts(f);
    changeSource(f);

    const created = await runApp(retryArgs(f, oldRunId), dataRoot);
    const createdResult = okResult(created, 'execution.retry-final');
    const runId = String(createdResult.newRunId);
    expect(createdResult.missingSteps).toContain('task_revalidation');
    expect(createdResult.revalidateTaskIds).toEqual(['t-1']);
    await waitFor(() => runStatus(f, runId) === 'failed', '源码变化后的重验 Run 失败');
    expect(ports.calls.revalidate.map(input => input.taskId)).toEqual(['t-1']);
    expect(ports.calls.revalidate[0]!.reasons).toContain('source_changed');
    expect(ports.calls.feature).toHaveLength(1);
    expect(tableRows(f, 'SELECT * FROM tasks ORDER BY id')).toEqual(tasksBefore);
    expect(row(f, 'SELECT COUNT(*) AS n FROM attempts')!.n).toBe(attemptsBefore);
    expect(start.starts).toEqual([]);
    expect(runtimeStarts(f)).toBe(startsBefore);
  }, 120_000);

  it('检查定义变化需先重新批准计划；批准后重验对应检查，不暗中编码', async () => {
    const f = await prepareEligibleFixture({
      taskCount: 1,
      budget: fixtureBudget(4),
      checkDefinitions: defaultCheckDefinitions(),
    });
    fixtures.push(f);
    const dataRoot = f.box.box.dataRoot;
    const updated = [{ ...defaultCheckDefinitions()[0]!, timeout: 61_000 }];
    await updateCheckDefinitions(f, updated);
    const oldRunId = f.ids.runId;
    const startsBefore = runtimeStarts(f);
    const runsBefore = runCount(f);
    const tasksBefore = tableRows(f, 'SELECT * FROM tasks ORDER BY id');

    /* 旧计划批准绑定旧检查政策：先拒绝，等待显式修复授权。 */
    const blockedPorts = createFinalizationPorts(f, updated, { feature: 'failed' });
    const blockedHost = await startFinalizationHost(f, blockedPorts);
    running.push(blockedHost.host);
    const rejected = await runApp(retryArgs(f, oldRunId), dataRoot);
    expect(rejected.exitCode).toBe(1);
    expect(failureOf(rejected).code).toBe('conflict');
    expect(runCount(f)).toBe(runsBefore);
    expect(row(f, 'SELECT status FROM runs WHERE id = ?', oldRunId)).toMatchObject({ status: 'failed' });

    await approvePlan(f);
    const created = await runApp(retryArgs(f, oldRunId), dataRoot);
    const createdResult = okResult(created, 'execution.retry-final');
    const runId = String(createdResult.newRunId);
    expect(createdResult.missingSteps).toContain('task_revalidation');
    await waitFor(() => runStatus(f, runId) === 'failed', '检查定义变化后的重验 Run 失败');
    expect(blockedPorts.calls.revalidate.map(input => input.taskId)).toEqual(['t-1']);
    expect(blockedPorts.calls.revalidate[0]!.reasons).toContain('check_definition_changed');
    expect(blockedPorts.calls.feature).toHaveLength(1);
    expect(tableRows(f, 'SELECT * FROM tasks ORDER BY id')).toEqual(tasksBefore);
    expect(blockedHost.starts).toEqual([]);
    expect(runtimeStarts(f)).toBe(startsBefore);
  }, 120_000);

  it('证据文件被破坏后重试重新检查，不能沿用旧 passed', async () => {
    const { f, dataRoot, start, ports } = await openCase({ behavior: { feature: 'failed' } });
    const oldRunId = f.ids.runId;
    const startsBefore = runtimeStarts(f);
    const attempt = row<{ code_ref: string }>(
      f, "SELECT code_ref FROM attempts WHERE task_id = 't-1' ORDER BY number DESC LIMIT 1",
    )!;
    const relative = deriveArtifactFinalRelativePath({ projectId: f.box.projectId, artifactId: attempt.code_ref });
    rmSync(join(f.box.box.dataRoot, ...relative.split('/')), { force: true });

    const created = await runApp(retryArgs(f, oldRunId), dataRoot);
    const createdResult = okResult(created, 'execution.retry-final');
    const runId = String(createdResult.newRunId);
    expect(createdResult.missingSteps).toContain('task_revalidation');
    await waitFor(() => runStatus(f, runId) === 'failed', '证据破坏后的重验 Run 失败');
    expect(ports.calls.revalidate.map(input => input.taskId)).toEqual(['t-1']);
    expect(ports.calls.revalidate[0]!.reasons).toContain('artifact_corrupt');
    expect(ports.calls.feature).toHaveLength(1);
    expect(start.starts).toEqual([]);
    expect(runtimeStarts(f)).toBe(startsBefore);
  }, 120_000);

  it('maxRuns 与无进展上限持久拒绝，不因重复最终失败绕过总预算', async () => {
    const maxRunsCase = await openCase({ budget: fixtureBudget(2), behavior: { feature: 'failed' } });
    injectFailedFeatureBatch(maxRunsCase.f);
    const first = await runApp(retryArgs(maxRunsCase.f, maxRunsCase.f.ids.runId), maxRunsCase.dataRoot);
    const firstRunId = String(okResult(first, 'execution.retry-final').newRunId);
    await waitFor(() => runStatus(maxRunsCase.f, firstRunId) === 'failed', 'maxRuns 场景首次收尾失败');
    const runsAtLimit = runCount(maxRunsCase.f);
    const rejected = await runApp(retryArgs(maxRunsCase.f, firstRunId), maxRunsCase.dataRoot);
    expect(rejected.exitCode).toBe(1);
    expect(failureOf(rejected).code).toBe('conflict');
    expect(runCount(maxRunsCase.f)).toBe(runsAtLimit);
    expect(row(maxRunsCase.f, 'SELECT runs_created, no_progress_runs FROM execution_batches WHERE id = ?', maxRunsCase.f.ids.batchId))
      .toMatchObject({ runs_created: 2, no_progress_runs: 1 });
    expect(maxRunsCase.start.starts).toEqual([]);

    const noProgressCase = await openCase({ budget: fixtureBudget(5, 2), behavior: { feature: 'failed' } });
    injectFailedFeatureBatch(noProgressCase.f);
    let runId = noProgressCase.f.ids.runId;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const receipt = await runApp(retryArgs(noProgressCase.f, runId), noProgressCase.dataRoot);
      runId = String(okResult(receipt, 'execution.retry-final').newRunId);
      await waitFor(() => runStatus(noProgressCase.f, runId) === 'failed', `无进展场景第 ${attempt + 1} 次失败`);
    }
    const runsBeforeReject = runCount(noProgressCase.f);
    const blocked = await runApp(retryArgs(noProgressCase.f, runId), noProgressCase.dataRoot);
    expect(blocked.exitCode).toBe(1);
    expect(failureOf(blocked).code).toBe('conflict');
    expect(runCount(noProgressCase.f)).toBe(runsBeforeReject);
    expect(row(noProgressCase.f, 'SELECT runs_created, no_progress_runs FROM execution_batches WHERE id = ?',
      noProgressCase.f.ids.batchId)).toMatchObject({ runs_created: 3, no_progress_runs: 2 });
    expect(noProgressCase.start.starts).toEqual([]);
  }, 120_000);

  it('deadline 到期与不可继续 Batch 分别拒绝，不创建 Run 或重置计数', async () => {
    const { f, dataRoot } = await openCase();
    const oldRunId = f.ids.runId;
    const beforeRuns = runCount(f);
    const budget = JSON.parse(row<{ budget_snapshot: string }>(
      f, 'SELECT budget_snapshot FROM execution_batches WHERE id = ?', f.ids.batchId,
    )!.budget_snapshot) as { batch: { deadlineUtcMs: number } };
    budget.batch.deadlineUtcMs = 1;
    f.box.session.database.prepare('UPDATE execution_batches SET deadline_at = 1, budget_snapshot = ? WHERE id = ?')
      .run(JSON.stringify(budget), f.ids.batchId);
    const expired = await runApp(retryArgs(f, oldRunId), dataRoot);
    expect(expired.exitCode).toBe(1);
    expect(failureOf(expired).code).toBe('conflict');
    expect(runCount(f)).toBe(beforeRuns);

    f.box.session.database.prepare('UPDATE execution_batches SET deadline_at = ?, status = ? WHERE id = ?')
      .run(1_900_003_700_000, 'cancelled', f.ids.batchId);
    const cancelled = await runApp(retryArgs(f, oldRunId), dataRoot);
    expect(cancelled.exitCode).toBe(1);
    expect(failureOf(cancelled).code).toBe('conflict');
    expect(runCount(f)).toBe(beforeRuns);
    expect(row(f, 'SELECT status FROM runs WHERE id = ?', oldRunId)).toMatchObject({ status: 'failed' });
  }, 120_000);

  it('并发重复 retryFinal 去重；取消后不自动继续', async () => {
    const { f, dataRoot, start } = await openCase({ approvalStatus: 'pending' });
    const oldRunId = f.ids.runId;
    const workKey = historicalRunWorkKey(f, oldRunId);
    const startsBefore = runtimeStarts(f);
    const commitsBefore = commitCount(f);
    const runsBefore = runCount(f);
    const leftId = randomUUID();
    const rightId = randomUUID();
    const [left, right] = await Promise.all([
      runApp(retryArgs(f, oldRunId, leftId), dataRoot),
      runApp(retryArgs(f, oldRunId, rightId), dataRoot),
    ]);
    const outcomes = [left, right];
    const successful = outcomes.filter(outcome => outcome.exitCode === 0);
    const rejected = outcomes.filter(outcome => outcome.exitCode !== 0);
    expect(successful, `${left.stdout}\n${right.stdout}`).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(failureOf(rejected[0]!).code).toBe('conflict');
    const success = okResult(successful[0]!, 'execution.retry-final');
    const runId = String(success.newRunId);
    expect(runCount(f)).toBe(runsBefore + 1);
    // 同 commandId 幂等重放：返回原 Run，不重复创建（与并发时序无关的确定性断言）。
    const replay = await runApp(retryArgs(f, oldRunId, left.exitCode === 0 ? leftId : rightId), dataRoot);
    expect(replay.exitCode, `${replay.stdout}\n${replay.stderr}`).toBe(0);
    expect(String(okResult(replay, 'execution.retry-final').newRunId)).toBe(runId);
    expect(runCount(f)).toBe(runsBefore + 1);
    expect(row(f, 'SELECT work_key, dispatch_ordinal FROM runs WHERE id = ?', runId))
      .toMatchObject({ work_key: workKey, dispatch_ordinal: 2 });

    await waitFor(
      () => runStatus(f, runId) === 'paused' && featureStatus(f) === 'awaiting_approval',
      '并发去重后的收尾 Run 等待人审',
    );
    const current = row<{ revision: number }>(f, 'SELECT revision FROM runs WHERE id = ?', runId)!;
    const cancelled = await runApp([
      'execution', 'cancel', '--project', f.box.projectId, '--run', runId,
      '--revision', String(current.revision), '--confirm', '--json',
    ], dataRoot);
    okResult(cancelled, 'execution.cancel');
    await waitFor(() => ['cancelled', 'cancelling'].includes(runStatus(f, runId)), '收尾 Run 进入取消');
    await delay(1_500);
    expect(['cancelled', 'cancelling']).toContain(runStatus(f, runId));
    expect(runCount(f)).toBe(runsBefore + 1);
    expect(row(f, 'SELECT COUNT(*) AS n FROM attempts')!.n).toBe(1);
    expect(featureStatus(f)).not.toBe('completed');
    expect(commitCount(f)).toBe(commitsBefore);
    expect(start.starts).toEqual([]);
    expect(runtimeStarts(f)).toBe(startsBefore);
  }, 120_000);

});
