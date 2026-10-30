/**
 * P07-1 / F-010 代表性闭环一：真实 Verifier 边界终止 Host 后经默认
 * Core/Host/CLI 完成「重启、查询、显式继续」的端到端闭环。
 *
 * 验收面（.dag_context.json F-010 第 1 条，Verifier 边界半边）：
 * - 生产 NodeTaskVerificationExecutor 批次已定版（passed）、Task 尚未提交的
 *   精确边界强杀真实 Host；重启后恢复核对完成（retained/paused），不自动通过；
 * - 同一持久事实经真实 loopback HostClient、CLI JSON（execution recovery）与
 *   同库 Core 只读查询三通道一致；连续查询零副作用；
 * - 显式继续经默认 CLI（execution resume）发起：新 Attempt 重新验证、真实
 *   Git 提交一次、Task passed；
 * - 最终一致性断言不依赖输出字符串：进程树缺席、SQLite 行（Attempt/回执/批次/
 *   预算）、Git commit 数恰好 +1、原 worktree 代码内容保留、Run 终态。
 *
 * 真实 Host/SQLite/Git/受控进程；零模型请求。平台进程探测场景仅 darwin。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { createLocalOwnerPrincipal } from '../../helpers/p02-2/principals.ts';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import {
  openFaultBarrierFixture,
  RUNTIME_TARGET,
  waitFor,
  type FaultBarrierFixture,
} from '../../helpers/p07-1/fault-barrier-host.ts';
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

const fixtures: FaultBarrierFixture[] = [];
const clients: HostClient[] = [];
let coreSession: SqliteStorageSession | undefined;
let bindingHost: RunningHost | undefined;

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  coreSession?.close();
  coreSession = undefined;
  for (const fixture of fixtures.splice(0)) {
    const result = await fixture.cleanup();
    if (!result.ok) {
      await fixture.forceDispose();
      throw new Error(`cleanup_unconfirmed: ${JSON.stringify(result)}`);
    }
  }
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const attempt = (f: FaultBarrierFixture) => f.q('SELECT * FROM attempts ORDER BY number DESC LIMIT 1');
const budget = (f: FaultBarrierFixture) =>
  f.q('SELECT attempts_created, runtime_starts, deadline_at, budget_snapshot FROM execution_batches');

describe.skipIf(process.platform !== 'darwin')('P07-1 F-010 representative closed loop: Verifier boundary', () => {
  it('[case:f010-verifier-boundary-loop] restarts, queries three channels and explicitly resumes through default Core/Host/CLI with cross-layer consistency', async () => {
    const f = await openFaultBarrierFixture({ prefix: 'shiploop-p07f010a-' });
    fixtures.push(f);
    const projectId = f.fixture.projectId;
    const runId = f.fixture.runId;

    /* 公开入口构造边界现场：验证批次已定版（passed），Task 提交前强杀 Host。 */
    const child = await f.spawnHost(f.buildChildConfig('normal', { verifierCompletionBarrier: true }), 'f010-verifier');
    await child.waitMessage('verifier_batch_finalized', 90_000);
    const oldAttempt = attempt(f);
    expect(oldAttempt).toMatchObject({ status: 'verifying', task_id: 't-1' });
    expect(f.q('SELECT status FROM verification_batches ORDER BY created_at DESC LIMIT 1')).toEqual({ status: 'passed' });
    const workspace = f.workspaceRow()!;
    const countAtKill = Number(git(['rev-list', '--count', 'HEAD'], workspace.canonical_path).trim());
    const budgetAtKill = budget(f);
    expect(budgetAtKill).toMatchObject({ attempts_created: 1, runtime_starts: 1 });
    await f.collectEvidence('f010-verifier-boundary-loop', 'before');
    expect(child.kill('SIGKILL')).toBe(true);
    expect((await child.exited).signal).toBe('SIGKILL');

    /* 重启：恢复核对完成（无未确认进程、批次完整）→ retained/paused，不自动通过。 */
    const restart = await f.spawnHost(f.buildChildConfig('normal'), 'f010-verifier-restart');
    await waitFor(() => f.q('SELECT status FROM attempts WHERE id = ?', oldAttempt.id)?.status === 'interrupted',
      '重启 fence 旧 Attempt', 60_000);
    await waitFor(() => (f.q('SELECT status FROM runs') as { status: string }).status === 'paused',
      '恢复核对完成 Run 转入 paused', 90_000);
    expect(f.q('SELECT status FROM managed_workspaces')).toEqual({ status: 'retained' });
    expect(f.q("SELECT COUNT(*) AS n FROM workspace_leases WHERE state IN ('held','quarantined')")).toEqual({ n: 0 });
    expect(f.q('SELECT status FROM tasks')).not.toEqual({ status: 'passed' });
    expect(f.q('SELECT COUNT(*) AS n FROM git_operations')).toEqual({ n: 0 });
    expect(budget(f)).toEqual(budgetAtKill);
    expect(f.runtimeStarts()).toHaveLength(1);

    /* 三通道查询：真实 loopback HostClient、CLI JSON 与同库 Core 只读装配。 */
    const client = await connectToHost({ canonicalRoot: f.fixture.box.dataRoot,
      timeouts: { submitBudgetMs: 120_000, appRequestMs: 60_000 } });
    clients.push(client);
    const viaClient = await client.getRunRecovery(projectId, runId);
    expect(viaClient.run).toMatchObject({ runId, status: 'paused' });
    expect(viaClient.startup.phase).toBe('recorded');
    expect(viaClient.startup.interruptedAttempts.map(entry => entry.attemptId)).toEqual([oldAttempt.id]);
    const observation = viaClient.startup.observations[0]!;
    expect(observation).toMatchObject({ attemptId: oldAttempt.id, stopConfirmed: true, attemptStatus: 'interrupted' });
    expect(viaClient.startup.workspace).toMatchObject({ status: 'retained', attemptId: oldAttempt.id });
    expect(viaClient.startup.pendingGitOperations).toEqual([]);
    expect(viaClient.startup.nextSteps).toEqual([
      { action: 'execution.resume', executable: true, blockedBy: [] },
    ]);

    const viaCli = await runCliJson(['execution', 'recovery', runId, '--project', projectId, '--json'],
      f.fixture.box.dataRoot) as unknown as {
      runId: string; status: string;
      startup: { phase: string; pendingGitOperations: unknown[]; nextSteps: unknown[]; workspace: { status: string } | null };
    };
    expect(viaCli).toMatchObject({ runId, status: 'paused' });
    expect(viaCli.startup.phase).toBe(viaClient.startup.phase);
    expect(viaCli.startup.pendingGitOperations).toEqual([]);
    expect(viaCli.startup.nextSteps).toEqual(JSON.parse(JSON.stringify(viaClient.startup.nextSteps)));
    expect(viaCli.startup.workspace?.status).toBe('retained');

    coreSession = openSqliteStorageSession({ path: f.fixture.box.dbPath });
    const viaCore = await assembleQueries(coreSession, f.fixture.box.dataRoot)
      .getRunRecovery(owner, { projectId, runId });
    expect(viaCore.run).toEqual(viaClient.run);
    expect(viaCore.startup).toEqual(viaClient.startup);

    /* 连续查询零副作用：持久事实与预算快照不变。 */
    const snapshot = () => JSON.stringify({
      runs: f.q('SELECT id, status, revision FROM runs'),
      attempts: f.q('SELECT COUNT(*) AS n FROM attempts'),
      events: f.q('SELECT COUNT(*) AS n FROM state_events'),
      leases: f.q('SELECT COUNT(*) AS n FROM workspace_leases'),
      budget: budget(f),
    });
    const beforeQueries = snapshot();
    const again = await client.getRunRecovery(projectId, runId);
    expect(JSON.parse(JSON.stringify(again))).toEqual(JSON.parse(JSON.stringify(viaClient)));
    expect(snapshot()).toBe(beforeQueries);

    /* 显式继续经默认 CLI：受信结算无回执积压，直接恢复调度。 */
    const revision = (f.q('SELECT revision FROM runs') as { revision: number }).revision;
    const resumed = await runCliJson(['execution', 'resume', '--project', projectId, '--run', runId,
      '--revision', String(revision), '--json'], f.fixture.box.dataRoot) as unknown as {
      operation: string; outcome: string; runIds: string[];
    };
    expect(resumed).toMatchObject({ operation: 'execution.resume', outcome: 'resumed' });
    expect(resumed.runIds).toContain(runId);

    /* 新 Attempt 完成真实验证与提交；最终状态跨层一致。 */
    await restart.waitMessage('verifier_completion', 150_000);
    await waitFor(() => (f.q("SELECT status FROM tasks WHERE id = 't-1'") as { status: string }).status === 'passed',
      '显式继续后 Task 通过', 60_000);
    /* 恢复保持解除：Run 不再处于 interrupted/paused，回到正常调度/终态。 */
    await waitFor(() => {
      const row = f.q('SELECT status, reason FROM runs') as { status: string; reason: string | null };
      return !['interrupted', 'paused'].includes(row.status) && row.reason !== 'restart_recovery';
    }, `恢复保持解除（实际 ${JSON.stringify(f.q('SELECT status, reason FROM runs'))}）`, 120_000);
    const finalRun = f.q('SELECT status, reason FROM runs') as { status: string; reason: string | null };
    expect(['queued', 'running', 'succeeded']).toContain(finalRun.status);
    expect(finalRun.reason).not.toBe('restart_recovery');

    /* SQLite：Attempt 序列、回执、验证批次与预算。 */
    expect(f.q("SELECT GROUP_CONCAT(status, ',') AS list FROM (SELECT status FROM attempts ORDER BY number)"))
      .toEqual({ list: 'interrupted,succeeded' });
    const newAttempt = f.q("SELECT id FROM attempts WHERE task_id = 't-1' AND status = 'succeeded'");
    const receipt = f.q('SELECT operation_type, status, actual_commit FROM git_operations WHERE attempt_id = ?', newAttempt.id);
    expect(receipt).toMatchObject({ operation_type: 'task_commit', status: 'succeeded' });
    const head = git(['rev-parse', 'HEAD'], workspace.canonical_path).trim();
    expect(receipt.actual_commit).toBe(head);
    expect(f.q('SELECT COUNT(*) AS n FROM verification_batches')).toEqual({ n: 2 });
    expect(f.q('SELECT COUNT(*) AS n FROM check_results')).toEqual({ n: 2 });

    /* Git：恰好一次新提交；worktree 代码内容保留且干净。 */
    expect(Number(git(['rev-list', '--count', 'HEAD'], workspace.canonical_path).trim())).toBe(countAtKill + 1);
    expect(readFileSync(join(workspace.canonical_path, RUNTIME_TARGET.path), 'utf8')).toBe(RUNTIME_TARGET.content);
    expect(git(['status', '--porcelain'], workspace.canonical_path).trim()).toBe('');

    /* 预算与身份：累计不清零，工作区实体不变，进程树缺席。 */
    const after = budget(f);
    expect(after).toEqual({ ...budgetAtKill, attempts_created: 2, runtime_starts: 2 });
    expect(f.q('SELECT id FROM managed_workspaces')).toEqual({ id: workspace.id });
    expect(f.runtimeStarts()).toHaveLength(2);
    const verifier = f.verifierMarker();
    if (verifier !== undefined) expect(alive(verifier.pid)).toBe(false);
    expect(f.workerPids().every(pid => !alive(pid))).toBe(true);
    await f.collectEvidence('f010-verifier-boundary-loop', 'after');

    /* 协作关闭重启 Host：正常收尾退出码 0。 */
    restart.send({ kind: 'close' });
    const exit = await restart.exited;
    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
  }, 300_000);
});
