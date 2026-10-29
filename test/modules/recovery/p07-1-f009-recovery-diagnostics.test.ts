/**
 * P07-1 / F-009：默认 Core、HostClient 和 CLI 的结构化恢复诊断与显式操作资格。
 *
 * 验收面（.dag_context.json F-009）：
 * 1. 复用既有 execution.run.recovery.get / execution.resume：默认装配可见本次
 *    恢复阶段、paused/interrupted/quarantined 实体、缺口、证据引用、Git
 *    outcome、停止状态与可执行/被阻塞的下一步；诊断资格不作为授权凭据；
 * 2. 相同持久事实经 Core 查询、真实 loopback HostClient 与 CLI JSON 返回一致
 *    身份与原因；连续查询零副作用（revision/事件/占用/预算/Attempt 不变）；
 * 3. 用公开入口构造正常恢复项目后查询并显式继续；跨项目/伪造身份/未知证据
 *    版本明确拒绝，不回退 owner、不暴露凭据或任意路径；
 * 4. 下一步只由持久结构化事实派生；无强制接管开关，未知进程/锁只有诊断。
 *
 * 真实 Host/SQLite/Git/受控进程；零模型请求。平台进程探测场景仅 darwin。
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost, type RunningHost } from '../../../packages/host/src/index.ts';
import { connectToHost, type HostClient } from '../../../packages/host/src/index.ts';
import { createQueryService } from '../../../packages/core/src/application/query-service.ts';
import type { QueryService } from '../../../packages/core/src/application/query-service.ts';
import { createConfigurationService } from '../../../packages/core/src/application/configuration-service.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { computeDataRootIdentity } from '../../../packages/core/src/ports/path-service.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { openBindingFixture, type BindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';
import { createLocalOwnerPrincipal, createRestrictedPrincipal } from '../../helpers/p02-2/principals.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import { openFaultBarrierFixture, waitFor, type FaultBarrierFixture } from '../../helpers/p07-1/fault-barrier-host.ts';
import { git } from '../../helpers/git-repo.ts';

const owner = createLocalOwnerPrincipal();

/** 与生产同入口的只读 QueryService 装配（真实 SQLite 门面；固定时钟不读钟）。 */
function assembleQueries(session: SqliteStorageSession, dataRoot: string): QueryService {
  const queryStore = createSqliteQueryStore(session);
  const stateStore = createSqliteStateStore(session);
  return createQueryService({
    projectReads: queryStore,
    snapshots: queryStore,
    eventReads: queryStore,
    stateStore,
    configurationService: createConfigurationService({
      stateStore,
      capabilityCatalog: createStaticRuntimeCapabilityCatalog([]),
    }),
    planReads: queryStore,
    executionBudgetReads: queryStore,
    scheduleReads: queryStore,
    workspaceReads: queryStore,
    workSessionReads: queryStore,
    taskEvidenceReads: queryStore,
    gitOperationReads: queryStore,
    featureDeliveryReads: queryStore,
    executionControlReads: queryStore,
    artifacts: createSqliteArtifactStore(session),
    artifactFiles: createArtifactFileStore({ dataRoot }),
    dataRootIdentity: computeDataRootIdentity(dataRoot),
    nowUtcMs: () => 1_900_000_500_000,
  });
}

async function runCliJson(args: readonly string[], dataRoot: string): Promise<Record<string, unknown>> {
  let stdout = '';
  const result = await runAppCli({ args: [...args, '--data-root', dataRoot], env: {}, io: { stdout: text => { stdout += text; }, stderr: () => undefined } });
  expect(result.exitCode, stdout).toBe(0);
  const envelope = JSON.parse(stdout) as { ok: boolean; result?: Record<string, unknown> };
  expect(envelope.ok).toBe(true);
  return envelope.result as Record<string, unknown>;
}

let bindingFixture: BindingFixture | undefined;
let bindingHost: RunningHost | undefined;
const barrierFixtures: FaultBarrierFixture[] = [];
const clients: HostClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  const host = bindingHost;
  bindingHost = undefined;
  /* 产品恢复合法保留隔离租约；显式清理仅测试收尾（先撤占用再关 Host，
   * 与 p03-9-f005 同一纪律：quiesce 不因隔离租约无法确认而失败）。 */
  bindingFixture?.session.database.prepare('DELETE FROM workspace_leases').run();
  if (host !== undefined) {
    await host.close();
  }
  bindingFixture?.close();
  bindingFixture = undefined;
  for (const fixture of barrierFixtures.splice(0)) {
    const result = await fixture.cleanup();
    if (!result.ok) {
      await fixture.forceDispose();
      throw new Error(`cleanup_unconfirmed: ${JSON.stringify(result)}`);
    }
  }
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('P07-1 / F-009 启动恢复诊断（真实重启现场 + 三通道一致性 + 显式继续）', () => {
  it.skipIf(process.platform !== 'darwin')('[case:f009-restart-diagnostics-resume] 重启隔离现场可诊断、三通道一致、显式 resume 结算后诊断推进', async () => {
    const f = await openFaultBarrierFixture({ gitBarrier: true, prefix: 'shiploop-p07f009-' });
    barrierFixtures.push(f);
    const projectId = f.fixture.projectId;
    const runId = f.fixture.runId;

    /* 公开入口构造恢复项目：Task commit 已落盘、回执事务前强杀 Host。 */
    const child = await f.spawnHost(f.buildChildConfig('git-barrier'), 'f009-diagnose');
    await waitFor(() => f.gitMarker() !== undefined, 'Task commit 已落盘', 90_000);
    const marker = f.gitMarker()!;
    const workspace = f.q('SELECT * FROM managed_workspaces') as { canonical_path: string; git_common_dir: string };
    const oldAttempt = f.q('SELECT * FROM attempts ORDER BY number DESC LIMIT 1') as { id: string };
    const operation = f.q('SELECT * FROM git_operations WHERE attempt_id = ?', oldAttempt.id) as { id: string };
    expect(child.kill('SIGKILL')).toBe(true);
    expect((await child.exited).signal).toBe('SIGKILL');
    unlinkSync(f.gitHoldPath);
    await waitFor(() => !alive(marker.pid) && !existsSync(join(workspace.git_common_dir, 'index.lock')), '旧 Git/hook 停止');

    /* 重启诊断：默认装配隔离旧 Attempt 并记录持久观察。 */
    await f.spawnHost(f.buildChildConfig('normal'), 'f009-restart');
    await waitFor(() => f.q('SELECT status FROM attempts WHERE id = ?', oldAttempt.id)?.status === 'interrupted',
      '重启诊断隔离旧 Attempt', 60_000);
    await waitFor(() => {
      const row = f.q(`SELECT json_extract(payload, '$.evidenceRef') AS ref, json_extract(payload, '$.phase') AS phase
        FROM state_events WHERE event_type = 'work.recovery.updated' AND attempt_id = ?
        ORDER BY sequence DESC LIMIT 1`, oldAttempt.id) as { ref: string | null; phase: string } | undefined;
      return row !== undefined && row.ref !== null && row.phase === 'recorded';
    }, '启动恢复观察 Artifact 发布完成', 60_000);

    /* 三通道查询：真实 loopback HostClient、CLI JSON 与同库 Core 只读查询。 */
    const client = await connectToHost({ canonicalRoot: f.fixture.box.dataRoot,
      timeouts: { submitBudgetMs: 120_000, appRequestMs: 60_000 } });
    clients.push(client);
    const viaClient = await client.getRunRecovery(projectId, runId);
    expect(viaClient.run).toMatchObject({ runId });
    expect(['interrupted', 'paused']).toContain(viaClient.run.status);
    expect(typeof viaClient.run.reason).toBe('string');
    expect(viaClient.startup.phase).toBe('recorded');
    expect(viaClient.startup.interruptedAttempts.map(attempt => attempt.attemptId)).toEqual([oldAttempt.id]);
    const observation = viaClient.startup.observations[0]!;
    expect(observation).toMatchObject({
      attemptId: oldAttempt.id,
      taskId: 't-1',
      attemptStatus: 'interrupted',
      phase: 'recorded',
      stopConfirmed: true,
    });
    expect(observation.evidenceRef).toEqual(expect.any(String));
    expect(observation.gaps.length).toBeGreaterThan(0);
    expect(viaClient.startup.workspace).toMatchObject({ status: 'quarantined', attemptId: oldAttempt.id });
    expect(viaClient.startup.pendingGitOperations).toEqual([
      expect.objectContaining({ operationId: operation.id, kind: 'task_commit', status: 'pending', attemptId: oldAttempt.id }),
    ]);
    expect(viaClient.startup.leases.some(lease => lease.state === 'quarantined')).toBe(true);
    /* pending 回执走显式 resume 受信结算：不预判为不可提交，也不自动执行。 */
    expect(viaClient.startup.nextSteps).toEqual([
      { action: 'execution.resume', executable: true, blockedBy: [] },
    ]);

    const viaCli = await runCliJson(['execution', 'recovery', runId, '--project', projectId, '--json'],
      f.fixture.box.dataRoot) as unknown as {
      runId: string; status: string; reason: string | null;
      startup: { phase: string; pendingGitOperations: { operationId: string }[]; nextSteps: unknown[]; workspace: { status: string } | null };
    };
    expect(viaCli).toMatchObject({ runId, status: viaClient.run.status });
    expect(viaCli.startup.phase).toBe(viaClient.startup.phase);
    expect(viaCli.startup.pendingGitOperations.map(entry => entry.operationId))
      .toEqual(viaClient.startup.pendingGitOperations.map(entry => entry.operationId));
    expect(viaCli.startup.nextSteps).toEqual(JSON.parse(JSON.stringify(viaClient.startup.nextSteps)));
    expect(viaCli.startup.workspace?.status).toBe('quarantined');

    const coreSession = openSqliteStorageSession({ path: f.fixture.box.dbPath });
    try {
      const viaCore = await assembleQueries(coreSession, f.fixture.box.dataRoot)
        .getRunRecovery(owner, { projectId, runId });
      expect(viaCore.run).toEqual(viaClient.run);
      expect(viaCore.startup).toEqual(viaClient.startup);
    } finally {
      coreSession.close();
    }

    /* 连续查询零副作用：持久事实与预算逐字节不变。 */
    const snapshot = () => JSON.stringify({
      runs: f.q('SELECT id, status, reason, revision FROM runs'),
      attempts: f.q('SELECT COUNT(*) AS n FROM attempts'),
      events: f.q('SELECT COUNT(*) AS n FROM state_events'),
      leases: f.q("SELECT state, COUNT(*) AS n FROM workspace_leases WHERE state IN ('held','quarantined') GROUP BY state"),
      budget: f.q('SELECT attempts_created, runtime_starts, budget_snapshot, deadline_at FROM execution_batches'),
      workspaceRow: f.q('SELECT id, status, revision FROM managed_workspaces'),
    });
    const before = snapshot();
    const again = await client.getRunRecovery(projectId, runId);
    expect(JSON.parse(JSON.stringify(again))).toEqual(JSON.parse(JSON.stringify(viaClient)));
    expect(snapshot()).toBe(before);

    /* 显式继续：matched 回执受信结算，预算/历史保留，诊断随之推进。 */
    const resumed = await client.resumeExecution({ projectId, runId,
      expectedRevision: f.q('SELECT revision FROM runs').revision });
    expect(resumed).toMatchObject({ status: 'completed', replayed: false, result: { resumed: true } });
    await waitFor(() => (f.q('SELECT status FROM tasks WHERE id = ?', 't-1') as { status: string }).status === 'passed',
      '结算后新 Attempt 完成验证与提交', 150_000);
    expect(f.q('SELECT status FROM git_operations WHERE id = ?', operation.id)).toEqual({ status: 'succeeded' });
    const afterResume = await client.getRunRecovery(projectId, runId);
    expect(afterResume.startup.pendingGitOperations).toEqual([]);
    expect(afterResume.startup.workspace).toMatchObject({ status: expect.any(String) });
    expect(afterResume.startup.interruptedAttempts.map(attempt => attempt.attemptId)).toContain(oldAttempt.id);
    /* 活动执行期间不再预判可 resume；终态后由持久状态给出明确阻塞原因。 */
    const resumeStepAfter = afterResume.startup.nextSteps.find(step => step.action === 'execution.resume');
    expect(resumeStepAfter).toBeDefined();
    if (['queued', 'running', 'pausing', 'cancelling'].includes(afterResume.run.status)) {
      expect(resumeStepAfter).toMatchObject({ executable: false, blockedBy: ['run_active'] });
    } else if (['succeeded', 'failed'].includes(afterResume.run.status)) {
      expect(resumeStepAfter).toMatchObject({ executable: false, blockedBy: ['run_terminal'] });
    } else {
      expect(resumeStepAfter!.executable, JSON.stringify({
        status: afterResume.run.status,
        reason: afterResume.run.reason,
        blockedBy: resumeStepAfter?.blockedBy,
        leases: afterResume.startup.leases.map(lease => lease.state),
        workspace: afterResume.startup.workspace,
        attempts: afterResume.startup.interruptedAttempts.map(attempt => attempt.status),
      })).toBe(true);
    }
  }, 300_000);

  it.skipIf(process.platform !== 'darwin')('[case:f009-observation-readonly] 遗留执行观察只读诊断、越权拒绝与损坏 fail-closed', async () => {
    bindingFixture = await openBindingFixture();
    const f = bindingFixture;
    const claim = f.claimTask('t-1');
    f.session.database.prepare('UPDATE attempts SET status = ?, code_ref = ? WHERE id = ?')
      .run('executing', f.requirementArtifactId, claim.receipt.attempt.id);
    bindingHost = await startHost({ dataRoot: f.box.dataRoot, capabilityCatalog: f.box.capabilityCatalog, env: {} });
    await waitFor(() => (f.query('SELECT status FROM attempts WHERE id = ?', claim.receipt.attempt.id) as { status: string }).status === 'interrupted',
      '启动恢复隔离遗留执行', 60_000);
    await waitFor(() => {
      const row = f.query(`SELECT json_extract(payload, '$.phase') AS phase FROM state_events
        WHERE event_type = 'work.recovery.updated' AND attempt_id = ?
        ORDER BY sequence DESC LIMIT 1`, claim.receipt.attempt.id) as { phase: string } | undefined;
      return row?.phase === 'recorded';
    }, '恢复观察发布', 60_000);

    const queries = assembleQueries(f.session, f.box.dataRoot);
    const result = await queries.getRunRecovery(owner, { projectId: f.projectId, runId: f.runId });
    expect(result.run).toMatchObject({ runId: f.runId, status: 'interrupted', reason: 'restart_recovery' });
    expect(result.startup.phase).toBe('recorded');
    expect(result.startup.interruptedAttempts).toHaveLength(1);
    expect(result.startup.observations).toHaveLength(1);
    expect(result.startup.observations[0]).toMatchObject({
      attemptId: claim.receipt.attempt.id,
      taskId: 't-1',
      attemptNumber: claim.receipt.attempt.number,
      attemptStatus: 'interrupted',
      phase: 'recorded',
      stopConfirmed: false,
      processIdentityRecorded: false,
      verificationProcessesCount: 0,
    });
    expect(result.startup.observations[0]!.gaps).toEqual(expect.arrayContaining(['process_identity_missing', 'workspace_not_reconciled']));
    /* 本夹具无受管工作区行：工作区诊断显式 null，不虚构状态。 */
    expect(result.startup.workspace).toBeNull();
    expect(result.startup.pendingGitOperations).toEqual([]);
    expect(result.startup.leases.some(lease => lease.state === 'quarantined')).toBe(true);
    /* 无可结算回执：隔离占用是持久阻塞原因，不提供接管开关。 */
    expect(result.startup.nextSteps).toEqual([
      { action: 'execution.resume', executable: false,
        blockedBy: expect.arrayContaining(['quarantined_occupancy']) },
    ]);
    expect(result.startup.nextSteps[0]!.blockedBy.every(reason =>
      ['run_terminal', 'run_active', 'active_attempt', 'open_occupancy', 'quarantined_occupancy',
        'workspace_quarantined', 'stop_unconfirmed', 'startup_recovery_pending', 'finalization_absent'].includes(reason))).toBe(true);

    /* HostClient / CLI JSON 与 Core 查询一致身份与原因。 */
    const client = await connectToHost({ canonicalRoot: f.box.dataRoot });
    clients.push(client);
    const viaClient = await client.getRunRecovery(f.projectId, f.runId);
    expect(viaClient.run).toEqual(result.run);
    expect(viaClient.startup.phase).toBe(result.startup.phase);
    expect(viaClient.startup.observations.map(o => ({ attemptId: o.attemptId, gaps: o.gaps, stopConfirmed: o.stopConfirmed })))
      .toEqual(result.startup.observations.map(o => ({ attemptId: o.attemptId, gaps: [...o.gaps], stopConfirmed: o.stopConfirmed })));
    expect(viaClient.startup.nextSteps).toEqual(JSON.parse(JSON.stringify(result.startup.nextSteps)));
    const viaCli = await runCliJson(['execution', 'recovery', f.runId, '--project', f.projectId, '--json'],
      f.box.dataRoot) as unknown as {
      runId: string; status: string;
      startup: { phase: string; nextSteps: unknown[]; observations: { attemptId: string; stopConfirmed: boolean; gaps: string[] }[] };
    };
    expect(viaCli).toMatchObject({ runId: f.runId, status: result.run.status });
    expect(viaCli.startup.phase).toBe(result.startup.phase);
    expect(viaCli.startup.observations[0]).toMatchObject({
      attemptId: claim.receipt.attempt.id,
      stopConfirmed: false,
      gaps: expect.arrayContaining(['process_identity_missing', 'workspace_not_reconciled']),
    });
    expect(viaCli.startup.nextSteps).toEqual(JSON.parse(JSON.stringify(result.startup.nextSteps)));

    /* 连续查询零副作用（revision/事件/占用/预算/Attempt 不变）。 */
    const snapshot = () => JSON.stringify({
      run: f.query('SELECT status, reason, revision FROM runs WHERE id = ?', f.runId),
      attempts: f.query('SELECT COUNT(*) AS n FROM attempts'),
      events: f.query('SELECT COUNT(*) AS n FROM state_events'),
      leases: f.query('SELECT COUNT(*) AS n FROM workspace_leases'),
      budget: f.query('SELECT attempts_created, runtime_starts, budget_snapshot, deadline_at FROM execution_batches'),
    });
    const before = snapshot();
    const repeat = await queries.getRunRecovery(owner, { projectId: f.projectId, runId: f.runId });
    expect(JSON.parse(JSON.stringify(repeat))).toEqual(JSON.parse(JSON.stringify(result)));
    expect(snapshot()).toBe(before);

    /* 越权与存在性折叠：受限主体（无该项目可见性）forbidden；未知目标 not_found。 */
    const restricted = createRestrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: { kind: 'allowlist', projectIds: ['00000000-0000-4000-8000-000000000000'] },
    });
    await expect(queries.getRunRecovery(restricted, { projectId: f.projectId, runId: f.runId }))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(queries.getRunRecovery(owner, { projectId: f.projectId, runId: randomUUID() }))
      .rejects.toMatchObject({ code: 'not_found' });

    /* 未知证据版本 fail-closed：不猜测降级解释，不折算空结果。 */
    f.session.database.prepare(
      `UPDATE state_events SET payload = json_set(payload, '$.schemaVersion', 99)
       WHERE event_type = 'work.recovery.updated' AND attempt_id = ?
         AND json_extract(payload, '$.phase') = 'recorded'`,
    ).run(claim.receipt.attempt.id);
    await expect(queries.getRunRecovery(owner, { projectId: f.projectId, runId: f.runId }))
      .rejects.toMatchObject({ code: 'corrupt_state' });
    /* 启动恢复管道静止后再交给 afterEach 关闭（quiesce 可确认）。 */
    await waitFor(() => bindingHost!.core.workExecution.recoveryState().status !== 'recovering',
      '启动恢复管道静止', 60_000);
  }, 120_000);
});
