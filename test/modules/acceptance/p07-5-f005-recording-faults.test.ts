/**
 * P07-5 / F-005 Recorder 背压、输出上限与持久化失败的跨层故障回归（真实执行接线）。
 *
 * 与 P07-2 单元/进程级边界测试的分工：本文件经 F-002 演练夹具（真实 Host 子进程、
 * 真实 SQLite/Git/文件、公开 Core 命令建立的 Run/Task）注入记录链路故障，核对
 * 配置上限、已落盘字节/水位与实际进程停止的业务终态：
 *
 * 1. [case:queue-backpressure-bounded-stop] 慢消费者 + 真实 PiRunnerEventChannel
 *    （生产协议常量 64 事件/64KiB、满即 fail-closed）：溢出折算 terminal
 *    failed(event_queue_backpressure) 有界停止，前缀完整落盘，Task 不误报通过；
 * 2. [case:output-limit-bounded-stop] 请求输出上限收窄后大输出受控停止，保留
 *    失败前缀与诚实清单；
 * 3. [case:file-write-failure-fail-closed] 真实 staging 目录权限注入（EACCES，
 *    记录注入层为文件端口而非真实磁盘耗尽）：required 记录故障 fail-closed，
 *    已收代码与可验证前缀保留，后续执行隔离；
 * 4. [case:index-persistence-failure] SQLite 记录索引持久化失败（BEFORE INSERT
 *    触发器受控注入）：水位不越过持久前缀，重复故障处理幂等有界。
 *
 * 纪律：模型输出由 FakeRuntime 替代；Git/SQLite/文件/进程全部真实；证据仅在
 * SHIPLOOP_P07_EVIDENCE_DIR 显式提供时导出，不向仓库工作树写运行产物。
 */
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PI_RUNNER_BUFFER_BYTES, PI_RUNNER_BUFFER_EVENTS } from '../../../packages/host/src/runtime/pi-runner-protocol.ts';
import { openSqliteStorageSession, type SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { openDrillFixture, type DrillFixture } from '../../helpers/p07-5/drill-fixture.ts';
import { waitFor } from '../../helpers/p07-1/fault-barrier-host.ts';
import { readSessionArtifact, readSessionManifest, recordingScript, saveScenarioEvidence } from '../../helpers/p07-5/recording-faults.ts';

const fixtures: DrillFixture[] = [];
let probe: SqliteStorageSession | undefined;
afterEach(async () => {
  try { probe?.close(); } catch { /* already closed */ }
  probe = undefined;
  for (const f of fixtures.splice(0)) expect(await f.cleanup()).toMatchObject({ status: 'passed' });
});
const one = (f: DrillFixture, sql: string, ...args: unknown[]) => f.q(sql, ...args) as Record<string, any>;
const rows = (f: DrillFixture, sql: string, ...args: unknown[]): Array<Record<string, any>> => {
  probe ??= openSqliteStorageSession({ path: f.dbPath });
  return probe.database.prepare(sql).all(...args as never[]) as Array<Record<string, any>>;
};
const runStatus = (f: DrillFixture, runId: string) => one(f, 'SELECT status FROM runs WHERE id = ?', runId).status;
const runTerminal = (f: DrillFixture, runId: string) =>
  !['queued', 'running', 'pausing', 'cancelling'].includes(runStatus(f, runId));
const dumpRunState = (f: DrillFixture, runId: string): Record<string, unknown> => ({
  run: runStatus(f, runId),
  attempts: attemptsOf(f, f.projectA.taskIds[0]!),
  runtimeStarts: f.runtimeStarts(),
  channelFacts: f.recordingChannelFacts(),
  sessions: rows(f, 'SELECT id, status, recording_watermark, recording_gaps FROM sessions'),
  tasks: rows(f, 'SELECT id, status FROM tasks'),
});
const attemptsOf = (f: DrillFixture, taskId: string) =>
  rows(f, 'SELECT id, status, session_id FROM attempts WHERE task_id = ? ORDER BY number', taskId);
const sessionIdOf = (f: DrillFixture, taskId: string) =>
  one(f, 'SELECT session_id AS sid FROM attempts WHERE task_id = ? ORDER BY number ASC LIMIT 1', taskId).sid;
/** 等待首个 Attempt 的会话绑定（认领先于会话分配，早读会得到 null）。 */
const awaitFirstSessionId = async (f: DrillFixture, taskId: string): Promise<string> => {
  const attemptId = one(f, 'SELECT id FROM attempts WHERE task_id = ? ORDER BY number ASC LIMIT 1', taskId).id;
  await waitFor(() => {
    const sid = one(f, 'SELECT session_id AS sid FROM attempts WHERE id = ?', attemptId).sid;
    return typeof sid === 'string' && sid.length > 0;
  }, 'attempt session assigned', 60_000);
  return one(f, 'SELECT session_id AS sid FROM attempts WHERE id = ?', attemptId).sid as string;
};
const messageCount = (f: DrillFixture, sessionId: string) =>
  one(f, 'SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?', sessionId).n;
const sessionState = (f: DrillFixture, sessionId: string) =>
  one(f, 'SELECT recording_watermark AS w, recording_gaps AS gaps FROM sessions WHERE id = ?', sessionId);

describe.skipIf(process.platform !== 'darwin')('P07-5 F-005 recording fault matrix (real execution wiring)', () => {
  it('[case:queue-backpressure-bounded-stop] 慢消费者经真实有界通道溢出后有界停止并保留可验证前缀', async () => {
    const f = await openDrillFixture({ prefix: 'shiploop-p07f005-bp-' });
    fixtures.push(f);
    const startedAt = Date.now();
    const { runId } = await f.startRun('a');
    await f.spawnDrillHost({
      label: 'f005-backpressure',
      recording: { channel: { slowConsumer: true } },
      script: recordingScript({ prefixMessages: 80 }),
    });
    try {
      await waitFor(() => runTerminal(f, runId), 'run reaches a terminal state after queue overflow', 180_000);
    } catch (error) {
      throw new Error(`${(error as Error).message}\nrun state: ${JSON.stringify(dumpRunState(f, runId))}`);
    }
    const attempts = attemptsOf(f, f.projectA.taskIds[0]!);
    expect(['failed', 'paused']).toContain(runStatus(f, runId));
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(attempts.length).toBeLessThanOrEqual(4);
    expect(attempts.every(a => a.status === 'failed')).toBe(true);

    /* 队列事实：真实通道上限、峰值与溢出（每次 Attempt 一行）。 */
    const channelFacts = f.recordingChannelFacts();
    expect(channelFacts.length).toBe(attempts.length);
    for (const fact of channelFacts) {
      expect(fact['bounds']).toEqual({ events: PI_RUNNER_BUFFER_EVENTS, bytes: PI_RUNNER_BUFFER_BYTES });
      expect(fact['overflow']).toBe(true);
      expect(fact['highWaterEvents'] as number).toBe(PI_RUNNER_BUFFER_EVENTS);
      expect(fact['highWaterBytes'] as number).toBeLessThanOrEqual(PI_RUNNER_BUFFER_BYTES);
      expect(fact['lastAcceptedSequence']).toBe(PI_RUNNER_BUFFER_EVENTS);
    }

    /* 记录前缀：水位 = 已接受前缀 = 已落盘消息数；清单如实保存。 */
    const sessionId = sessionIdOf(f, f.projectA.taskIds[0]!);
    expect(sessionState(f, sessionId).w).toBe(PI_RUNNER_BUFFER_EVENTS);
    expect(messageCount(f, sessionId)).toBe(PI_RUNNER_BUFFER_EVENTS);
    const manifest = await readSessionManifest(f, f.projectA.projectId, sessionId);
    expect(manifest).not.toBeNull();
    const parsed = JSON.parse(manifest!.content) as Record<string, any>;
    expect(parsed.stats.eventsPersisted).toBe(PI_RUNNER_BUFFER_EVENTS);
    expect(parsed.result.reason).toBe('event_queue_backpressure');
    expect(parsed.coverage).toBe('complete');
    /* 已落盘字节与清单声明一致，且在累计磁盘额度内。 */
    const bytes = one(f, 'SELECT COALESCE(SUM(size_bytes), 0) AS n FROM artifacts'
      + " WHERE storage_locator LIKE ? AND status = 'ready'", `sessions/${sessionId}/event-log/%`).n;
    expect(bytes).toBe(parsed.stats.bytesPersisted);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(8_000_000);

    /* required 语义：Task 不误报通过、后继不解锁；已收代码保留。 */
    expect(one(f, 'SELECT status FROM tasks WHERE id = ?', f.projectA.taskIds[0]!).status).not.toBe('passed');
    expect(one(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.projectA.dependentTaskId).n).toBe(0);
    const workspace = f.workspaceRow('a')!;
    expect(readFileSync(join(workspace.canonical_path, f.runtimeTarget.path), 'utf8')).toBe(f.runtimeTarget.content);
    /* 进程事实：Runtime 启动数与 Attempt 数一致（重复故障处理不放大执行）。 */
    expect(f.runtimeStarts()).toHaveLength(attempts.length);
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(180_000);
    const evidence = await f.collectDrillEvidence('f005-queue-backpressure', 'after', { runId });
    saveScenarioEvidence('f005-queue-backpressure', {
      identity: evidence.identity, budget: evidence.budget, timings: evidence.timings,
      channelBounds: { events: PI_RUNNER_BUFFER_EVENTS, bytes: PI_RUNNER_BUFFER_BYTES },
      queuePeak: channelFacts.map(fact => ({ highWaterEvents: fact['highWaterEvents'], highWaterBytes: fact['highWaterBytes'] })),
      manifest: { watermark: parsed.watermark, bytesPersisted: parsed.stats.bytesPersisted, coverage: parsed.coverage },
      diskBudgetBytes: 8_000_000, elapsedMs, attempts: attempts.length,
      runtimeStarts: f.runtimeStarts().length,
    });
  }, 240_000);

  it('[case:output-limit-bounded-stop] 大输出超过请求上限受控停止并保留失败前缀', async () => {
    const f = await openDrillFixture({ prefix: 'shiploop-p07f005-out-' });
    fixtures.push(f);
    const startedAt = Date.now();
    const { runId } = await f.startRun('a');
    const maxOutputBytes = 900;
    await f.spawnDrillHost({
      label: 'f005-output-limit',
      recording: { limits: { maxOutputBytes } },
      script: recordingScript({ prefixMessages: 6, writeTarget: false }),
    });
    await waitFor(() => runTerminal(f, runId), 'run bounded-stops after the output limit', 180_000);
    const attempts = attemptsOf(f, f.projectA.taskIds[0]!);
    expect(['failed', 'paused']).toContain(runStatus(f, runId));
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(attempts.length).toBeLessThanOrEqual(4);
    expect(attempts.every(a => a.status === 'failed')).toBe(true);
    const sessionId = sessionIdOf(f, f.projectA.taskIds[0]!);

    /* 结算证据如实记录输出超限原因（真实 runtime-settlement 制品）。 */
    const settlement = await readSessionArtifact(f, f.projectA.projectId, `sessions/${sessionId}/runtime-settlement.json`);
    const settled = JSON.parse(settlement.content) as Record<string, any>;
    expect(settled.execution.result.reason).toBe('output_limit_exceeded');

    /* 前缀与水位：失败前完整落盘，清单不虚构完成。 */
    const persisted = messageCount(f, sessionId);
    expect(persisted).toBeGreaterThanOrEqual(1);
    expect(persisted).toBeLessThan(6);
    expect(sessionState(f, sessionId).w).toBe(persisted);
    const manifest = await readSessionManifest(f, f.projectA.projectId, sessionId);
    expect(manifest).not.toBeNull();
    const parsed = JSON.parse(manifest!.content) as Record<string, any>;
    expect(parsed.watermark).toBe(persisted);
    expect(parsed.stats.eventsPersisted).toBe(persisted);
    expect(parsed.result.reason).toBe('output_limit_exceeded');
    /* 配置上限事实：收窄后的请求上限进入清单 effectiveLimits。 */
    expect(parsed.effectiveLimits?.request?.maxOutputBytes).toBe(maxOutputBytes);
    expect(one(f, 'SELECT status FROM tasks WHERE id = ?', f.projectA.taskIds[0]!).status).not.toBe('passed');
    expect(one(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.projectA.dependentTaskId).n).toBe(0);
    const elapsedMs = Date.now() - startedAt;
    const evidence = await f.collectDrillEvidence('f005-output-limit', 'after', { runId });
    saveScenarioEvidence('f005-output-limit', {
      identity: evidence.identity, budget: evidence.budget, timings: evidence.timings,
      outputLimit: { configuredRequestMaxOutputBytes: maxOutputBytes, productionDefault: 8_000_000 },
      persistedPrefixEvents: persisted, elapsedMs, attempts: attempts.length,
      runtimeStarts: f.runtimeStarts().length,
    });
    expect(f.runtimeStarts()).toHaveLength(attempts.length);
    expect(elapsedMs).toBeLessThan(180_000);
  }, 240_000);

  it('[case:file-write-failure-fail-closed] 真实文件写入失败保留前缀与代码并隔离后续执行', async () => {
    const f = await openDrillFixture({ prefix: 'shiploop-p07f005-fs-' });
    fixtures.push(f);
    const stagingDir = join(f.dataRoot, 'staging', f.projectA.projectId);
    const { runId } = await f.startRun('a');
    const child = await f.spawnDrillHost({
      label: 'f005-file-write',
      script: recordingScript({ prefixMessages: 40, gate: 'inject_fs', suffixMessages: 24 }),
    });
    const taskId = f.projectA.taskIds[0]!;
    await waitFor(() => attemptsOf(f, taskId).length >= 1, 'first attempt starts', 120_000);
    const sessionId = await awaitFirstSessionId(f, taskId);
    await waitFor(() => messageCount(f, sessionId) >= 32, 'first chunk persisted before the fault', 60_000);
    /* 受控注入层：真实 staging 目录权限（EACCES）——不是真实磁盘耗尽。 */
    chmodSync(stagingDir, 0o500);
    try {
      f.releaseGate(child, 'inject_fs');
      await waitFor(() => {
        const gaps = String(sessionState(f, sessionId).gaps ?? '');
        return gaps.includes('recording_failed:') || attemptsOf(f, taskId).some(a => a.status === 'failed' || a.status === 'interrupted');
      }, 'recording failure observed', 120_000);

      /* 前缀保留：索引水位不动，公开正文仍可核验。 */
      expect(sessionState(f, sessionId).w).toBe(32);
      expect(messageCount(f, sessionId)).toBe(32);
      const prefixBody = await readSessionArtifact(f, f.projectA.projectId, `sessions/${sessionId}/messages/%`);
      expect(prefixBody.sizeBytes).toBeGreaterThan(0);
      /* 已收代码保留在工作区。 */
      const workspace = f.workspaceRow('a')!;
      expect(readFileSync(join(workspace.canonical_path, f.runtimeTarget.path), 'utf8')).toBe(f.runtimeTarget.content);
      /* required 语义：Task 不误报通过、后继不解锁。 */
      expect(one(f, 'SELECT status FROM tasks WHERE id = ?', taskId).status).not.toBe('passed');
      expect(one(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.projectA.dependentTaskId).n).toBe(0);

      /* 结算同样无法写证据文件时监督 fail-closed：先恢复权限，再以 Host 重启
       * 收尾悬挂 Attempt（恢复路径不再重放业务），核对隔离事实。 */
      chmodSync(stagingDir, 0o700);
      /* 单写入者：先优雅关闭首个 Host（close 屏障），再重启接管恢复。 */
      child.send({ kind: 'close' });
      const closed = await child.exited;
      expect(child.isAlive()).toBe(false);
      await f.spawnDrillHost({ label: 'f005-file-write-restart' });
      await waitFor(() => ['failed', 'interrupted'].includes(String(attemptsOf(f, taskId)[0]!.status)),
        'interrupted attempt closed by startup recovery', 120_000);
      const first = attemptsOf(f, taskId)[0]!;
      expect(['failed', 'interrupted']).toContain(first.status);
      const leaseStates = rows(f, 'SELECT state FROM workspace_leases').map(row => row.state as string);
      expect(leaseStates.length).toBeGreaterThan(0);
      expect(leaseStates.some(state => state === 'quarantined' || state === 'retained')).toBe(true);
      /* 隔离后不重复执行业务：依赖仍不解锁，无新增 Attempt/Runtime 启动。 */
      await new Promise(resolve => setTimeout(resolve, 2_000));
      expect(attemptsOf(f, taskId)).toHaveLength(1);
      expect(one(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.projectA.dependentTaskId).n).toBe(0);
      expect(f.runtimeStarts()).toHaveLength(1);
      const evidence = await f.collectDrillEvidence('f005-file-write', 'after', { runId });
      saveScenarioEvidence('f005-file-write', {
        identity: evidence.identity, budget: evidence.budget, timings: evidence.timings,
        injection: { layer: 'artifact-staging-directory-chmod', mode: '0o500', errno: 'EACCES',
          note: '受控文件端口写失败注入，不宣称为真实磁盘耗尽' },
        prefix: { watermark: 32, messages: 32 }, attemptStatus: first.status,
        leaseStates, firstChildExit: { code: closed.code, signal: closed.signal },
        tasks: evidence.business.tasks,
      });
    } finally {
      chmodSync(stagingDir, 0o700);
    }
  }, 300_000);

  it('[case:index-persistence-failure] 记录索引持久化失败时有界停止且水位不越过持久前缀', async () => {
    const f = await openDrillFixture({ prefix: 'shiploop-p07f005-idx-' });
    fixtures.push(f);
    const faultProbe = openSqliteStorageSession({ path: f.dbPath });
    const { runId } = await f.startRun('a');
    const child = await f.spawnDrillHost({
      label: 'f005-index-fault',
      script: recordingScript({ prefixMessages: 40, gate: 'inject_idx', suffixMessages: 24 }),
    });
    const taskId = f.projectA.taskIds[0]!;
    await waitFor(() => attemptsOf(f, taskId).length >= 1, 'first attempt starts', 120_000);
    const sessionId = await awaitFirstSessionId(f, taskId);
    await waitFor(() => messageCount(f, sessionId) >= 32, 'prefix indexed before the fault', 60_000);
    /* 受控注入层：SQLite 记录索引 BEFORE INSERT 触发器（仅阻断 recording_manifests）。 */
    faultProbe.database.exec("CREATE TRIGGER p07f005_block_manifests BEFORE INSERT ON recording_manifests"
      + " BEGIN SELECT RAISE(ABORT, 'p07f005 controlled index fault'); END");
    try {
      f.releaseGate(child, 'inject_idx');
      await waitFor(() => runTerminal(f, runId), 'run bounded-stops after the index fault', 180_000);
      const attempts = attemptsOf(f, taskId);
      expect(attempts.length).toBeGreaterThanOrEqual(1);
      expect(attempts.length).toBeLessThanOrEqual(4);
      expect(attempts.every(a => a.status === 'failed')).toBe(true);

      /* 水位与索引不越过持久前缀：Session 水位停留在注入前值。 */
      expect(sessionState(f, sessionId).w).toBe(32);
      expect(messageCount(f, sessionId)).toBe(32);
      /* 前缀正文可核验（真实文件 + 实测哈希）。 */
      const chunk = await readSessionArtifact(f, f.projectA.projectId, `sessions/${sessionId}/event-log/%`);
      expect(chunk.sizeBytes).toBeGreaterThan(0);
      /* 诚实失败清单已发布（文件层可用），索引无法推进：按 artifacts 索引读取。 */
      const manifest = await readSessionManifest(f, f.projectA.projectId, sessionId);
      expect(manifest).not.toBeNull();
      const parsed = JSON.parse(manifest!.content) as Record<string, any>;
      expect(parsed.coverage).toBe('failed');
      expect(parsed.gaps).toEqual(expect.arrayContaining(['recording_failed:watermark_progress_failed']));
      /* 结算证据如实记录记录失败原因。 */
      const settlement = await readSessionArtifact(f, f.projectA.projectId, `sessions/${sessionId}/runtime-settlement.json`);
      const settled = JSON.parse(settlement.content) as Record<string, any>;
      expect(settled.recording.failure).toBe('watermark_progress_failed');
      expect(settled.recording.watermark).toBe(32);
      /* required 语义与重复故障处理：每次重试同样有界失败，不误报通过。 */
      expect(one(f, 'SELECT status FROM tasks WHERE id = ?', taskId).status).not.toBe('passed');
      expect(one(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.projectA.dependentTaskId).n).toBe(0);
      expect(f.runtimeStarts()).toHaveLength(attempts.length);
      const evidence = await f.collectDrillEvidence('f005-index-fault', 'after', { runId });
      saveScenarioEvidence('f005-index-fault', {
        identity: evidence.identity, budget: evidence.budget, timings: evidence.timings,
        injection: { layer: 'sqlite-recording-manifests-before-insert-trigger' },
        watermark: 32, manifestCoverage: parsed.coverage, attempts: attempts.length,
        runtimeStarts: f.runtimeStarts().length,
      });
    } finally {
      faultProbe.database.exec('DROP TRIGGER IF EXISTS p07f005_block_manifests');
      faultProbe.close();
    }
  }, 300_000);
});
