/**
 * P07-5 / F-006 双存储不一致演练（真实 Host 子进程 + 真实 SQLite/Git/文件）。
 *
 * 差异化于 F-005 的崩溃隔离回归：本文件聚焦 Core 登记、原生正文与 Recorder
 * 持久水位三者不一致时的「先核对、再决策」边界：
 *
 * 1. [case:p07-f006-native-progress-uncommitted] 原生档案有进展而 Core 结果未
 *    提交：先核对 Git HEAD/tree、进程普查与持久水位（均留证据），再按政策
 *    暂停/拒绝——脚本声明的终态 completed 不得推断 Task passed，工具副作用
 *    只发生一次，预算/用量零增量；
 * 2. [case:p07-f006-registered-body-missing] Core 已登记而原生正文缺失（事件
 *    正文制品被删）：重启后事实不被虚构（水位/缺口原样），恢复入口保持
 *    拒绝，Task 不通过，无重复执行；正文缺失被如实暴露而非重建。
 *
 * 未执行真实模型续聊（live not_run）；不引入 Durable 生产依赖。
 */
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectToHost, type HostClient } from '../../../packages/host/src/index.ts';
import { openSqliteStorageSession, type SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { DRILL_RUNTIME_TARGET, openDrillFixture, type DrillFixture } from '../../helpers/p07-5/drill-fixture.ts';
import { waitFor } from '../../helpers/p07-1/fault-barrier-host.ts';
import { readSessionArtifact, recordingScript, saveScenarioEvidence } from '../../helpers/p07-5/recording-faults.ts';

const fixtures: DrillFixture[] = [];
const clients: HostClient[] = [];
let probe: SqliteStorageSession | undefined;
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  try { probe?.close(); } catch { /* already closed */ }
  probe = undefined;
  for (const f of fixtures.splice(0)) expect(await f.cleanup()).toMatchObject({ status: 'passed' });
});
const one = (f: DrillFixture, sql: string, ...args: unknown[]) => f.q(sql, ...args) as Record<string, any>;
const rows = (f: DrillFixture, sql: string, ...args: unknown[]): Array<Record<string, any>> => {
  probe ??= openSqliteStorageSession({ path: f.dbPath });
  return probe.database.prepare(sql).all(...args as never[]) as Array<Record<string, any>>;
};
const attemptsOf = (f: DrillFixture, taskId: string) =>
  rows(f, 'SELECT id, status FROM attempts WHERE task_id = ? ORDER BY number', taskId);
const messageCount = (f: DrillFixture, sessionId: string) =>
  one(f, 'SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?', sessionId).n;
const sessionState = (f: DrillFixture, sessionId: string) =>
  one(f, 'SELECT recording_watermark AS w, recording_gaps AS gaps FROM sessions WHERE id = ?', sessionId);
const budgetOf = (f: DrillFixture, runId: string) =>
  one(f, 'SELECT b.attempts_created, b.runtime_starts FROM execution_batches b JOIN runs r ON r.batch_id = b.id WHERE r.id = ?', runId);
async function connect(f: DrillFixture) {
  const client = await connectToHost({ canonicalRoot: f.dataRoot,
    timeouts: { submitBudgetMs: 120_000, appRequestMs: 60_000 } });
  clients.push(client);
  return client;
}

/** 崩溃前置：跑到 gate（原生已有持久进展），强杀 Host 后返回现场事实。 */
async function crashAtNativeProgress(f: DrillFixture, gate: string) {
  const { runId } = await f.startRun('a');
  const child = await f.spawnDrillHost({ label: `f006-${gate}`, script: recordingScript({ prefixMessages: 40, gate, suffixMessages: 4 }) });
  const taskId = f.projectA.taskIds[0]!;
  await waitFor(() => attemptsOf(f, taskId).length >= 1, 'first attempt starts', 120_000);
  const attemptId = one(f, 'SELECT id FROM attempts WHERE task_id = ? ORDER BY number ASC LIMIT 1', taskId).id as string;
  await waitFor(() => {
    const sid = one(f, 'SELECT session_id AS sid FROM attempts WHERE id = ?', attemptId).sid;
    return typeof sid === 'string' && sid.length > 0;
  }, 'attempt session assigned', 60_000);
  const sessionId = one(f, 'SELECT session_id AS sid FROM attempts WHERE id = ?', attemptId).sid as string;
  await waitFor(() => sessionState(f, sessionId).w >= 32 && messageCount(f, sessionId) >= 32,
    'durable native prefix persisted before crash', 120_000);
  const before = await f.collectDrillEvidence('f006-native-drift', 'before', { runId });
  expect(child.kill('SIGKILL')).toBe(true);
  expect((await child.exited).signal).toBe('SIGKILL');
  return { runId, taskId, attemptId, sessionId, before };
}

describe.skipIf(process.platform !== 'darwin')('P07-5 F-006 dual-storage drift (real execution wiring)', () => {
  it('[case:p07-f006-native-progress-uncommitted] 原生进展未提交：先核对事实再按政策拒绝，不推断通过', async () => {
    const f = await openDrillFixture({ prefix: 'shiploop-p07f006-uncommitted-' });
    fixtures.push(f);
    const { runId, taskId, attemptId, sessionId, before } = await crashAtNativeProgress(f, 'hold_uncommitted');

    /* 先核对（崩溃后、决策前）：Git HEAD/tree 未漂移、进程已消失、持久水位=已落盘前缀。 */
    const afterCrash = await f.collectDrillEvidence('f006-native-drift', 'after', { runId });
    const gitA = afterCrash.git.find(facts => facts.repository === 'a')!;
    const gitBefore = before.git.find(facts => facts.repository === 'a')!;
    expect(gitA.head).toBe(gitBefore.head);
    expect(gitA.tree).toBe(gitBefore.tree);
    expect(afterCrash.processes.every(fact => !fact.alive)).toBe(true);
    const watermark = sessionState(f, sessionId).w as number;
    const messages = messageCount(f, sessionId);
    expect(watermark).toBe(32);
    expect(messages).toBe(32);
    /* Core 结果未提交：Attempt 未结算，脚本声明的终态 completed 从未到达。 */
    expect(one(f, 'SELECT status FROM attempts WHERE id = ?', attemptId).status).not.toBe('passed');
    expect(one(f, 'SELECT status FROM tasks WHERE id = ?', taskId).status).not.toBe('passed');
    expect(one(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.projectA.dependentTaskId).n).toBe(0);
    const budgetBefore = budgetOf(f, runId);

    /* 重启交给启动恢复：中断、隔离，不把原生进展文字推断为通过。 */
    await f.spawnDrillHost({ label: 'f006-uncommitted-restart' });
    await waitFor(() => attemptsOf(f, taskId)[0]!.status === 'interrupted', 'attempt interrupted', 120_000);
    await waitFor(() => one(f, 'SELECT status FROM runs WHERE id = ?', runId).status === 'interrupted', 'run interrupted', 120_000);
    expect(one(f, 'SELECT status FROM tasks WHERE id = ?', taskId).status).not.toBe('passed');
    expect(one(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.projectA.dependentTaskId).n).toBe(0);
    /* 持久水位与原生进展保持崩溃时事实：不虚构、不重复计账。 */
    expect(sessionState(f, sessionId).w).toBe(watermark);
    expect(messageCount(f, sessionId)).toBe(messages);
    expect(budgetOf(f, runId)).toEqual(budgetBefore);
    expect(attemptsOf(f, taskId)).toHaveLength(1);

    /* 恢复入口：预判不可执行且显式 resume 被隔离门控拒绝。 */
    const client = await connect(f);
    const recovery = await client.getRunRecovery(f.projectA.projectId, runId);
    const resumeStep = recovery.startup.nextSteps.find(step => step.action === 'execution.resume');
    expect(resumeStep).toMatchObject({ executable: false });
    expect(resumeStep!.blockedBy).toEqual(expect.arrayContaining(['workspace_quarantined', 'quarantined_occupancy']));
    const resumeError = await client.resumeExecution({ projectId: f.projectA.projectId, runId,
      expectedRevision: one(f, 'SELECT revision FROM runs WHERE id = ?', runId).revision })
      .then(receipt => { throw new Error(`隔离期 resume 意外成功: ${JSON.stringify(receipt)}`); },
        (error: { code?: string; details?: { reason?: string } }) => error);
    expect(resumeError.code).toBe('resource_busy');
    expect(resumeError.details).toMatchObject({ reason: 'startup_recovery' });

    /* 工具副作用只发生一次：工作区标记文件内容精确、未被重复写入。 */
    const worktree = afterCrash.git.find(facts => facts.repository === 'a')!.worktreePath;
    expect(worktree).toBeTruthy();
    const marker = await readFile(join(worktree!, DRILL_RUNTIME_TARGET.path), 'utf8');
    expect(marker).toBe(DRILL_RUNTIME_TARGET.content);
    const markerListed = afterCrash.git.find(facts => facts.repository === 'a')!.statusEntries
      .filter(entry => entry.includes(DRILL_RUNTIME_TARGET.path));
    expect(markerListed.length).toBe(1);
    saveScenarioEvidence('f006-native-progress-uncommitted', {
      identity: afterCrash.identity,
      checksFirst: { gitHead: gitA.head, processesAlive: 0, persistentWatermark: watermark, persistedMessages: messages },
      uncommitted: { attemptStatus: 'interrupted', taskStatus: one(f, 'SELECT status FROM tasks WHERE id = ?', taskId).status,
        dependentAttempts: 0, resumeBlockedBy: resumeStep!.blockedBy },
      noDoubleAccounting: { budget: budgetOf(f, runId), attempts: 1 },
      toolEffectOnce: { markerContent: marker },
      liveModelContinuation: 'not_run',
    });
  }, 360_000);

  it('[case:p07-f006-registered-body-missing] Core 已登记而原生正文缺失：事实保留、拒绝恢复、不虚构', async () => {
    const f = await openDrillFixture({ prefix: 'shiploop-p07f006-body-missing-' });
    fixtures.push(f);
    const { runId, taskId, attemptId, sessionId } = await crashAtNativeProgress(f, 'hold_body_missing');
    const watermark = sessionState(f, sessionId).w as number;
    const gaps = sessionState(f, sessionId).gaps;

    /* 演练缺失：Core 已登记（会话/水位行存在），删除原生事件正文制品文件。
     * 物理位置是 projects/<projectId>/artifacts/<artifactId>/content（locator 仅逻辑契约）。 */
    const bodyIds = rows(f, "SELECT id FROM artifacts WHERE project_id = ? AND storage_locator LIKE ?",
      f.projectA.projectId, `sessions/${sessionId}/event-log%`).map(row => String(row.id));
    expect(bodyIds.length).toBeGreaterThanOrEqual(1);
    for (const artifactId of bodyIds) {
      await rm(join(f.dataRoot, 'projects', f.projectA.projectId, 'artifacts', artifactId), { recursive: true, force: true });
    }
    await expect(readSessionArtifact(f, f.projectA.projectId, `sessions/${sessionId}/event-log/%`)).rejects.toThrow();

    /* 重启：启动恢复只登记中断/隔离事实，不重建正文、不虚构水位。 */
    await f.spawnDrillHost({ label: 'f006-body-missing-restart' });
    await waitFor(() => attemptsOf(f, taskId)[0]!.status === 'interrupted', 'attempt interrupted', 120_000);
    expect(one(f, 'SELECT status FROM sessions WHERE id = ?', sessionId).status).toBe('started');
    expect(sessionState(f, sessionId).w).toBe(watermark);
    expect(sessionState(f, sessionId).gaps).toBe(gaps);
    expect(one(f, 'SELECT status FROM tasks WHERE id = ?', taskId).status).not.toBe('passed');
    expect(one(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.projectA.dependentTaskId).n).toBe(0);
    expect(attemptsOf(f, taskId)).toHaveLength(1);
    /* 正文仍缺失（未重建）；已登记行不再提供可验证恢复来源。 */
    await expect(readSessionArtifact(f, f.projectA.projectId, `sessions/${sessionId}/event-log/%`)).rejects.toThrow();
    const client = await connect(f);
    const recovery = await client.getRunRecovery(f.projectA.projectId, runId);
    const resumeStep = recovery.startup.nextSteps.find(step => step.action === 'execution.resume');
    expect(resumeStep).toMatchObject({ executable: false });
    const evidence = await f.collectDrillEvidence('f006-body-missing', 'after', { runId });
    saveScenarioEvidence('f006-registered-body-missing', {
      identity: evidence.identity,
      registeredButMissing: { sessionId, persistedWatermark: watermark, deletedArtifactBodies: bodyIds.length },
      preservedFacts: { sessionStatus: 'started', watermark, gaps },
      resumeExecutable: false,
      liveModelContinuation: 'not_run',
    });
  }, 360_000);
});
