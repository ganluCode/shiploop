/**
 * P07-5 / F-012 公开闭环恢复演示（FR-1）。
 *
 * 单一代表性端到端闭环：经真实 Host 客户端创建并启动带依赖的工作（输入准备 →
 * 预览 → 显式授权启动），在提交边界强杀自有 Host 子进程，重启先核验旧进程与
 * Git/工作区事实再显式恢复；恢复后依赖正确解锁、验证通过并真实提交，最终
 * Feature 交付；随后经公开 CLI 备份 → 独立核验 → 离线恢复到隔离目标，读取
 * 对应业务记录与制品；期间注入通知渠道故障，确认失败重投不重跑任务。
 *
 * 纪律（与 F-003/F-007/F-009 相同）：
 * - SQLite、Git、Host 与受控进程全部真实参与；FakeRuntime 只替代模型输出；
 *   通知渠道故障与检查进程 hold 是仅有的两个受控故障点，默认装配的恢复、
 *   备份/恢复、结果查询与通知能力不经测试内重新装配补齐；
 * - 四项不变量在检查点同时成立：故障后代码保留（tracked/untracked 字节不变）、
 *   预算/deadline 不清零（快照不变、计数累计）、依赖不误解锁（被依赖 Task
 *   通过前被阻塞 Task 零 Attempt）、通知失败不重跑任务（Runtime 启动数/
 *   Attempt/Git HEAD 在重投前后不变）；
 * - 关键失败路径显式核验：陈旧 revision 恢复拒绝、旧身份迟到结果被 fencing；
 *   缺必需前置（夹具阶段失败、屏障未达成、通知事实未出现）都会让本演示失败，
 *   不跳过后宣称通过。
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectToHost, type HostClient } from '../../../packages/host/src/index.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { processRows } from '../../helpers/process-matrix.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import { openDrillFixture, DRILL_BUDGET, type DrillFixture } from '../../helpers/p07-5/drill-fixture.ts';
import { waitFor } from '../../helpers/p07-1/fault-barrier-host.ts';
import { git } from '../../helpers/git-repo.ts';
import Database from 'better-sqlite3';

const fixtures: DrillFixture[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const f of fixtures.splice(0)) expect(await f.cleanup()).toMatchObject({ status: 'passed' });
});
const q = (f: DrillFixture, sql: string, ...args: unknown[]) => f.q(sql, ...args) as Record<string, any>;
const budget = (f: DrillFixture) => q(f, 'SELECT attempts_created, runtime_starts, deadline_at, budget_snapshot FROM execution_batches');
const latest = (f: DrillFixture) => q(f, 'SELECT * FROM attempts ORDER BY created_at DESC, number DESC LIMIT 1');
async function connect(f: DrillFixture) {
  const client = await connectToHost({ canonicalRoot: f.dataRoot,
    timeouts: { submitBudgetMs: 120_000, appRequestMs: 60_000 } });
  clients.push(client);
  return client;
}
async function cliJson(args: string[]) {
  let stdout = '';
  const result = await runAppCli({ args: [...args, '--json'], env: {},
    io: { stdout: value => { stdout += value; }, stderr: () => undefined } });
  return { exitCode: result.exitCode, body: JSON.parse(stdout) as Record<string, any> };
}
async function capture(f: DrillFixture, scenario: string, phase: 'before' | 'after', runId: string) {
  const evidence = await f.collectDrillEvidence(scenario, phase, { runId });
  if (process.env.SHIPLOOP_P07_EVIDENCE_DIR) {
    mkdirSync(process.env.SHIPLOOP_P07_EVIDENCE_DIR, { recursive: true });
    const probe = openSqliteStorageSession({ path: f.dbPath });
    let rows: Record<string, unknown>;
    try {
      rows = Object.fromEntries(['attempts', 'tasks', 'runs', 'managed_workspaces', 'workspace_leases',
        'repository_bindings', 'execution_batches', 'run_dispatch_claims', 'execution_slot_claims', 'verification_processes',
        'notification_deliveries', 'notification_delivery_results']
        .map(table => [table, probe.database.prepare(`SELECT * FROM ${table}`).all()]));
    } finally { probe.close(); }
    const observed = (await processRows()).filter(row => evidence.processes.some(p => p.pid === row.pid));
    const serialized = JSON.stringify({ ...evidence, rows, observed }, null, 2).replaceAll(f.root, '<fixture>');
    expect(serialized).not.toContain(f.sensitiveSentinelValue);
    expect(serialized).not.toContain(f.bearerSentinelValue);
    writeFileSync(join(process.env.SHIPLOOP_P07_EVIDENCE_DIR,
      `${scenario}-${runId}-${evidence.identity.attempt}.json`), serialized);
  }
  return evidence;
}
function fenceLateResults(f: DrillFixture, old: Record<string, any>) {
  const session = openSqliteStorageSession({ path: f.dbPath });
  try {
    const lifecycle = createSqliteAttemptLifecycleStore(session, {
      workspaceAuthority: createWorkWorkspaceAuthority({ authorizedRoots: [f.root] }), nowUtcMs: Date.now,
    });
    const identity = { projectId: old.project_id, runId: old.run_id, taskId: old.task_id,
      attemptId: old.id, owner: old.owner_id, hostInstanceId: old.host_instance_id, executionVersion: old.execution_version };
    const before = q(f, 'SELECT status, execution_version, revision FROM tasks WHERE id = ?', old.task_id);
    for (const fields of [{}, { owner: 'stale-owner' }, { hostInstanceId: 'stale-host' },
      { executionVersion: old.execution_version + 10 }]) {
      expect(lifecycle.apply({ ...identity, ...fields, notificationId: `late-${randomUUID()}`,
        kind: 'runtime_completed', exitCode: 0, evidenceRef: old.input_ref }))
        .toMatchObject({ disposition: 'ignored', reason: 'stale_execution_identity' });
    }
    expect(q(f, 'SELECT status, execution_version, revision FROM tasks WHERE id = ?', old.task_id)).toEqual(before);
  } finally { session.close(); }
}
async function waitForBackupSettled(dataRoot: string, operationId: string): Promise<void> {
  await waitFor(() => {
    const journal = join(dataRoot, 'backups', 'operations', `${operationId}.json`);
    if (!existsSync(journal)) return false;
    return (JSON.parse(readFileSync(journal, 'utf8')) as { status: string }).status !== 'running';
  }, '备份操作落定', 60_000);
}
const sha256 = (value: Uint8Array | Buffer | string): string => createHash('sha256').update(value).digest('hex');

describe.skipIf(process.platform !== 'darwin')('P07-5 F-012 公开闭环恢复演示', () => {
  it('[case:p07-fr1-closed-loop-demo] Host 启动带依赖工作→提交边界强杀→重启核验后显式恢复→备份恢复读取→通知失败续投，四项不变量同时成立', async () => {
    execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { timeout: 60_000 });
    const f = await openDrillFixture({ prefix: 'shiploop-p07f012-', taskCount: 3 });
    fixtures.push(f);
    const { projectId, featureId } = f.projectA;
    const [passedId, currentId, blockedId] = f.projectA.taskIds;
    expect(blockedId).toBeDefined();

    /* ---- 阶段一：经真实 Host 创建并启动带依赖的工作（通知渠道受控故障已激活）。 ---- */
    f.plantNotificationFault();
    const first = await f.spawnDrillHost({ label: 'f012-closed-loop', progressWrites: true,
      barriers: { commitEntry: true, taskId: currentId }, notificationFault: true });
    const client = await connect(f);
    for (const taskId of f.projectA.taskIds) {
      const prepared = await client.prepareExecutionInput({ projectId, featureId, taskId,
        items: [{ purpose: taskId === passedId ? 'requirements' : 'spec',
          source: { kind: 'artifact', artifactId: f.projectA.requirementArtifactIds[taskId]! } }] });
      expect(prepared).toMatchObject({ status: 'completed' });
    }
    const preview = await client.previewExecution({ projectId, featureIds: [featureId], budget: DRILL_BUDGET });
    expect(preview).toMatchObject({ status: 'completed' });
    const previewDigest = (preview as { result: { previewDigest: string } }).result.previewDigest;
    const started = await client.startExecution({ projectId, featureIds: [featureId], budget: DRILL_BUDGET, previewDigest });
    expect(started).toMatchObject({ status: 'accepted' });
    const runId = (started as { runId: string }).runId;

    /* ---- 阶段二：推进到第二个 Task 的提交边界（第一个 Task 已真实通过并提交）。 ---- */
    const boundary = await f.awaitBarrier(first, 'entered_commit', 150_000);
    expect(boundary.taskId).toBe(currentId);
    await waitFor(() => q(f, `SELECT coverage, finalized FROM recording_manifests
      WHERE attempt_id = (SELECT id FROM attempts WHERE task_id = ? ORDER BY number DESC LIMIT 1)
      ORDER BY version DESC LIMIT 1`, currentId)?.finalized === 1,
    'Recorder 在安全恢复边界前发布最终 manifest', 20_000);
    expect(q(f, 'SELECT status FROM tasks WHERE id = ?', passedId)).toEqual({ status: 'passed' });
    expect(q(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', blockedId)).toEqual({ n: 0 });
    const workspace = q(f, 'SELECT * FROM managed_workspaces WHERE feature_id = ?', featureId);
    const trackedBefore = readFileSync(join(workspace.canonical_path, 'progress.txt'), 'utf8');
    const untrackedBefore = readFileSync(join(workspace.canonical_path, 'pending-2.txt'), 'utf8');
    expect(git(['status', '--porcelain'], workspace.canonical_path)).toContain(' M progress.txt');
    /* 通知故障已产生持久失败记录：第一个 Task 的终态事件进入有界重试。 */
    await waitFor(() => f.notificationFacts().deliveries.some(d => d.status === 'retry_scheduled'), '通知失败进入有界重试', 60_000);
    const failedDelivery = f.notificationFacts().deliveries.find(d => d.status === 'retry_scheduled')!;
    expect(failedDelivery.attemptCount).toBeGreaterThanOrEqual(1);
    const old = latest(f);
    const before = budget(f);
    await capture(f, 'f012-closed-loop', 'before', runId);

    /* ---- 阶段三：提交边界强杀自有 Host → 重启核验旧进程与 Git → 显式恢复。 ---- */
    expect(first.kill('SIGKILL')).toBe(true);
    expect((await first.exited).signal).toBe('SIGKILL');
    const restart = await f.spawnDrillHost({ label: 'f012-restart', notificationFault: true,
      closeTimeoutMs: 420_000, watchdogMs: 470_000 });
    /* 旧客户端绑定已被强杀的 Host 端口；重启后必须新建客户端，不复用旧连接。 */
    await client.close();
    expect(q(f, 'SELECT status FROM attempts WHERE id = ?', old.id)).toEqual({ status: 'interrupted' });
    expect(q(f, 'SELECT status FROM runs WHERE id = ?', runId)).toEqual({ status: 'paused' });
    expect(q(f, 'SELECT status FROM managed_workspaces WHERE id = ?', workspace.id)).toEqual({ status: 'retained' });
    /* 不变量 1：故障后代码保留（tracked 修改与 untracked 文件字节不变）。 */
    expect(readFileSync(join(workspace.canonical_path, 'progress.txt'), 'utf8')).toBe(trackedBefore);
    expect(readFileSync(join(workspace.canonical_path, 'pending-2.txt'), 'utf8')).toBe(untrackedBefore);
    /* 不变量 2：预算/deadline 不清零（快照与绝对 deadline 原样保留）。 */
    expect(budget(f)).toEqual(before);
    /* 不变量 3：依赖不误解锁（被依赖 Task 未通过前，被阻塞 Task 零 Attempt）。 */
    expect(q(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', blockedId)).toEqual({ n: 0 });
    const client2 = await connect(f);
    const recovery = await client2.getRunRecovery(projectId, runId);
    expect(recovery.startup.workspace).toMatchObject({ status: 'retained' });
    /* 关键失败路径 1：陈旧 revision 的恢复请求被拒绝（回执 rejected/conflict，不重放成功）。 */
    const refused = await client2.resumeExecution({ projectId, runId,
      expectedRevision: q(f, 'SELECT revision FROM runs WHERE id = ?', runId).revision + 10 });
    expect(refused).toMatchObject({ status: 'rejected', error: { code: 'conflict' } });
    expect(refused.replayed).toBe(false);
    /* 显式恢复（经 Host）：恰好一次新认领，预算计数累计、deadline 不变。 */
    const resumeRevision = q(f, 'SELECT revision FROM runs WHERE id = ?', runId).revision;
    const resumed = await client2.resumeExecution({ projectId, runId, expectedRevision: resumeRevision });
    expect(resumed).toMatchObject({ status: 'completed' });
    /* 同命令重放返回同一回执（replayed），不产生第二次认领。 */
    expect(await client2.resumeExecution({ projectId, runId, expectedRevision: resumeRevision },
      { commandId: resumed.commandId, issuedAt: resumed.issuedAt })).toMatchObject({ replayed: true, status: 'completed' });
    await capture(f, 'f012-closed-loop', 'after', runId);
    /* 显式恢复恰好创建一次新认领（同 Task 新 Attempt，编号累计）。 */
    await waitFor(() => {
      const row = latest(f);
      return row !== undefined && row.task_id === currentId && row.number === old.number + 1;
    }, '显式恢复创建新 Attempt', 60_000);
    /* 关键失败路径 2：旧身份迟到结果被 fencing，不覆盖当前业务状态。 */
    fenceLateResults(f, old);
    await waitFor(() => {
      const row = budget(f);
      return row.attempts_created === before.attempts_created + 1 && row.runtime_starts === before.runtime_starts + 1;
    }, '预算计数累计且 deadline 不变', 120_000);
    expect(budget(f)).toEqual({ ...before, attempts_created: before.attempts_created + 1, runtime_starts: before.runtime_starts + 1 });

    /* ---- 阶段四：恢复闭环推进到全部 Task 通过（验证通过 → 真实提交 → 依赖解锁）。 ---- */
    await waitFor(() => q(f, 'SELECT status FROM tasks WHERE id = ?', blockedId).status === 'passed', '依赖解锁后最后一个 Task 通过', 180_000);
    for (const taskId of f.projectA.taskIds) {
      expect(q(f, 'SELECT status FROM tasks WHERE id = ?', taskId)).toEqual({ status: 'passed' });
    }
    expect(q(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', blockedId)).toEqual({ n: 1 });
    const commits = q(f, 'SELECT COUNT(*) AS n FROM git_operations WHERE actual_commit IS NOT NULL').n as number;
    expect(commits).toBeGreaterThanOrEqual(3);
    expect(f.gitFacts('a').headBeyondBase).toBe(true);
    const finalBudget = budget(f);
    expect(finalBudget.attempts_created).toBe(4);
    expect(finalBudget.runtime_starts).toBe(4);
    expect(finalBudget.deadline_at).toBe(before.deadline_at);
    expect(finalBudget.budget_snapshot).toEqual(before.budget_snapshot);
    expect(f.runtimeStarts()).toHaveLength(4);
    /* 当前闭环在 Host 关闭前仍保留运行态；离线恢复目标会按恢复门禁保留暂停态，
     * 两者都不能被解释成 Feature 已交付。 */
    expect(q(f, 'SELECT status FROM runs WHERE id = ?', runId)).toEqual({ status: 'running' });
    const featureReport = await client2.getFeatureReport(projectId, featureId);
    expect(featureReport.feature).toMatchObject({ featureId });
    expect(featureReport.runs.find(row => row.id === runId)).toMatchObject({ status: 'running' });

    /* ---- 阶段五：通知失败续投（受控渠道恢复健康 + 到期推进），不重跑任务。 ---- */
    const businessBaseline = {
      attempts: q(f, 'SELECT COUNT(*) AS n FROM attempts').n,
      runtimeStarts: f.runtimeStarts().length,
      head: f.gitFacts('a').head,
      budgetRow: budget(f),
    };
    f.releaseNotificationFault();
    for (let round = 0; round < 8; round++) {
      const rows = f.notificationFacts().deliveries;
      if (rows.length > 0 && rows.every(row => row.status === 'delivered')) break;
      const snapshot = JSON.stringify(rows.map(row => [row.id, row.status, row.attemptCount]));
      f.forceDeliveriesDue(rows.filter(row => row.status !== 'delivered' && row.status !== 'exhausted').map(row => row.id));
      await waitFor(() => JSON.stringify(f.notificationFacts().deliveries.map(row => [row.id, row.status, row.attemptCount])) !== snapshot,
        `通知续投进展（第 ${round + 1} 轮）`, 30_000);
    }
    const delivered = f.notificationFacts().deliveries;
    expect(delivered.length).toBeGreaterThanOrEqual(3);
    expect(delivered.every(row => row.status === 'delivered' && row.channelId === 'local-results')).toBe(true);
    const recovered = delivered.find(row => row.id === failedDelivery.id)!;
    /* 故障期间可能已发生有界重试；恢复健康后到期续投恰好成功一次，不重跑任务。 */
    expect(recovered.attemptCount).toBeGreaterThan(failedDelivery.attemptCount);
    const recoveredResults = f.notificationFacts().results.filter(row => row.deliveryId === recovered.id);
    expect(recoveredResults.at(-1)).toMatchObject({ outcome: 'succeeded' });
    expect(recoveredResults.slice(0, -1).every(row => row.outcome === 'failed')).toBe(true);
    /* 不变量 4：通知重投全程不重跑任务（Runtime 启动数、Attempt、Git HEAD、预算不变）。 */
    expect(q(f, 'SELECT COUNT(*) AS n FROM attempts').n).toBe(businessBaseline.attempts);
    expect(f.runtimeStarts()).toHaveLength(businessBaseline.runtimeStarts);
    expect(f.gitFacts('a').head).toBe(businessBaseline.head);
    expect(budget(f)).toEqual(businessBaseline.budgetRow);
    /* 恢复后的结果经公开 Host/CLI 可查询。 */
    const list = await client2.listNotifications(projectId, { status: 'delivered' });
    expect(list.records).toHaveLength(delivered.length);
    const notificationCli = await cliJson(['notifications', 'get', recovered.id, '--project', projectId, '--data-root', f.dataRoot]);
    expect(notificationCli.exitCode).toBe(0);
    expect(JSON.stringify(notificationCli.body)).toContain('delivered');

    /* ---- 阶段六：公开 CLI 备份 → 核验 → 离线恢复到隔离目标 → 读取记录与制品。 ---- */
    const backupId = `p07-f012-${randomUUID().slice(0, 8)}`;
    const created = await cliJson(['backup', 'create', '--backup-id', backupId, '--data-root', f.dataRoot]);
    expect(created.exitCode, JSON.stringify(created.body)).toBe(0);
    expect(created.body).toMatchObject({ ok: true, result: { status: 'accepted', backupId } });
    const operationId = created.body.result.operationId as string;
    await waitForBackupSettled(f.dataRoot, operationId);
    const operation = await cliJson(['backup', 'operation', operationId, '--data-root', f.dataRoot]);
    expect(operation.body).toMatchObject({ ok: true, result: { status: 'completed', backupId } });
    const manifestDigest = operation.body.result.manifestDigest as string;
    const backupGet = await cliJson(['backup', 'get', backupId, '--data-root', f.dataRoot]);
    expect(backupGet.body).toMatchObject({ ok: true, result: { status: 'complete', manifestDigest } });
    const backupVerify = await cliJson(['backup', 'verify', '--backup-id', backupId, '--manifest-digest', manifestDigest, '--data-root', f.dataRoot]);
    expect(backupVerify.exitCode, JSON.stringify(backupVerify.body)).toBe(0);
    expect(backupVerify.body).toMatchObject({ ok: true, result: { report: { status: 'complete', backupId } } });

    /* 关闭重启 Host（优雅 close 屏障）后离线恢复；目标根独立，不混入原数据根。 */
    restart.send({ kind: 'close' });
    await restart.waitMessage('closed', 60_000);
    await restart.exited;
    const restoreTarget = join(f.root, 'p07-f012-restore-target');
    mkdirSync(restoreTarget, { recursive: true, mode: 0o700 });
    const packagePath = join(f.dataRoot, 'backups', backupId);
    const restoreVerify = await cliJson(['restore', 'verify', '--data-root', restoreTarget, '--package', packagePath]);
    expect(restoreVerify.exitCode, JSON.stringify(restoreVerify.body)).toBe(0);
    const restorePrepare = await cliJson(['restore', 'prepare', '--data-root', restoreTarget, '--package', packagePath,
      '--operation-id', 'p07-f012-restore']);
    expect(restorePrepare.exitCode, JSON.stringify(restorePrepare.body)).toBe(0);
    const confirmation = restorePrepare.body.result.confirmation as Record<string, unknown>;
    const confirmationFile = join(f.root, 'p07-f012-confirmation.json');
    writeFileSync(confirmationFile, JSON.stringify(confirmation), { mode: 0o600 });
    const restoreConfirm = await cliJson(['restore', 'confirm', '--data-root', restoreTarget,
      '--operation-id', 'p07-f012-restore', '--confirmation-file', confirmationFile]);
    expect(restoreConfirm.exitCode, JSON.stringify(restoreConfirm.body)).toBe(0);
    expect(restoreConfirm.body).toMatchObject({ ok: true, result: { status: 'published', backupId } });

    /* 恢复目标中的业务记录与制品和备份前事实一致（只读核对，不回写）。 */
    const restored = new Database(join(restoreTarget, 'core.sqlite'), { readonly: true, fileMustExist: true });
    try {
      expect(restored.prepare<[string, string], { n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status = ?').get(projectId, 'passed'))
        .toEqual({ n: 3 });
      expect(restored.prepare('SELECT status FROM runs WHERE id = ?').get(runId)).toEqual({ status: 'paused' });
      expect(restored.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 4 });
      expect(restored.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM notification_deliveries WHERE status = ?').get('delivered'))
        .toEqual({ n: delivered.length });
      expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally { restored.close(); }
    const requirementArtifactId = f.projectA.requirementArtifactIds[passedId]!;
    const liveHash = q(f, 'SELECT content_hash AS h FROM artifacts WHERE id = ?', requirementArtifactId).h as string;
    const artifactRead = await createArtifactFileStore({ dataRoot: restoreTarget })
      .openFinalRead({ projectId, artifactId: requirementArtifactId });
    const chunks: Buffer[] = [];
    for await (const chunk of artifactRead.stream) chunks.push(Buffer.from(chunk));
    expect(sha256(Buffer.concat(chunks))).toBe(liveHash);
    expect(existsSync(join(f.dataRoot, 'core.sqlite'))).toBe(true);
    await capture(f, 'f012-closed-loop', 'after', runId);
  }, 480_000);
});
