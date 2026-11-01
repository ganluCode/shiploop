/**
 * P07-5 / F-005 记录尾部残缺、重复事件、停止未确认隔离、best_effort 显式配置
 * 与 Host 重启的跨层回归（真实执行接线）。
 *
 * 1. [case:tail-truncated-stop-unconfirmed] 终态先到而事件尾部挂起：required
 *    记录收尾有界（events_tail_timeout 缺口），停止核验未确认保持隔离，重启后
 *    恢复入口拒绝放行；
 * 2. [case:duplicate-and-missing-events] 重复事件/用量与丢失序列：稳定身份去重、
 *    缺口如实入清单，required 不以 partial 冒充通过；
 * 3. [case:best-effort-explicit-partial] 用户显式 best_effort 配置：同一故障形态
 *    下运行继续交付、清单如实 partial 展示——不替代 required 必需检查；
 * 4. [case:restart-prefix-no-double-execution] Host 记录中崩溃重启：水位不越过
 *    持久前缀、未知 live 缺口不被抹除；按恢复契约隔离（工作区/租约
 *    quarantined），resume 预判不可执行且被门控拒绝，零重复执行/计账。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { connectToHost, type HostClient } from '../../../packages/host/src/index.ts';
import { openSqliteStorageSession, type SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { openDrillFixture, type DrillFixture } from '../../helpers/p07-5/drill-fixture.ts';
import { waitFor } from '../../helpers/p07-1/fault-barrier-host.ts';
import { readSessionArtifact, readSessionManifest, recordingScript, saveScenarioEvidence } from '../../helpers/p07-5/recording-faults.ts';

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
const runStatus = (f: DrillFixture, runId: string) => one(f, 'SELECT status FROM runs WHERE id = ?', runId).status;
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
async function connect(f: DrillFixture) {
  const client = await connectToHost({ canonicalRoot: f.dataRoot,
    timeouts: { submitBudgetMs: 120_000, appRequestMs: 60_000 } });
  clients.push(client);
  return client;
}

describe.skipIf(process.platform !== 'darwin')('P07-5 F-005 recording recovery and isolation (real execution wiring)', () => {
  it('[case:tail-truncated-stop-unconfirmed] 终态先到而记录尾部残缺时有界收尾且停止未确认保持隔离', async () => {
    const f = await openDrillFixture({ prefix: 'shiploop-p07f005-tail-' });
    fixtures.push(f);
    const startedAt = Date.now();
    const { runId } = await f.startRun('a');
    const child = await f.spawnDrillHost({
      label: 'f005-tail',
      script: recordingScript({
        prefixMessages: 3,
        lifecycle: { events: { endGate: 'hold_tail' } },
      }),
    });
    const taskId = f.projectA.taskIds[0]!;
    await waitFor(() => attemptsOf(f, taskId).length >= 1, 'first attempt starts', 120_000);
    const sessionId = await awaitFirstSessionId(f, taskId);
    /* 尾部等待有界：结果先到、事件流悬挂，Recorder 以缺口收尾（≈2s tail 预算）。 */
    await waitFor(() => {
      const gaps = String(sessionState(f, sessionId).gaps ?? '');
      const watermark = sessionState(f, sessionId).w;
      return gaps.includes('recording_failed:') || (watermark !== null && watermark >= 3);
    }, 'recording finalizes the truncated tail within the bounded budget', 120_000);
    await waitFor(() => !['executing', 'preparing', 'verifying'].includes(attemptsOf(f, taskId)[0]!.status),
      'attempt settles with unconfirmed stop', 120_000);
    const attempt = attemptsOf(f, taskId)[0]!;
    expect(attempt.status).toBe('failed');
    /* 放行尾部门闩：迟到停止证据不再改写已定案状态。 */
    f.releaseGate(child, 'hold_tail');
    await new Promise(resolve => setTimeout(resolve, 300));

    /* 前缀与清单：事件核算按真实序列（write_file 不出事件；tool_command 计
     * tool_started/tool_finished 2 个事件；3 条消息 → 序列 1..5）。门闩只悬挂
     * 流结束，全部前缀事件已按序持久化；水位不越过持久前缀，缺口如实。 */
    const watermarkFact = sessionState(f, sessionId);
    expect(watermarkFact.w).toBe(5);
    expect(messageCount(f, sessionId)).toBe(5);
    const manifest = await readSessionManifest(f, f.projectA.projectId, sessionId);
    expect(manifest).not.toBeNull();
    const parsed = JSON.parse(manifest!.content) as Record<string, any>;
    expect(parsed.watermark).toBe(5);
    expect(parsed.gaps).toEqual(expect.arrayContaining([expect.stringMatching(/tail|recording_failed/)]));

    /* 停止未确认保持隔离：工作区不被释放，重启后恢复入口拒绝放行。 */
    const workspaceStatus = () => one(f, 'SELECT status FROM managed_workspaces WHERE feature_id = ?', f.projectA.featureId).status;
    await waitFor(() => ['quarantined', 'retained'].includes(workspaceStatus()), 'workspace isolated after unconfirmed stop', 30_000);
    expect(one(f, 'SELECT status FROM tasks WHERE id = ?', taskId).status).not.toBe('passed');
    expect(one(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.projectA.dependentTaskId).n).toBe(0);
    /* 单写入者：先优雅关闭首个 Host，再重启接管恢复。 */
    child.send({ kind: 'close' });
    await child.exited;
    expect(child.isAlive()).toBe(false);
    await f.spawnDrillHost({ label: 'f005-tail-restart' });
    const client = await connect(f);
    const recovery = await client.getRunRecovery(f.projectA.projectId, runId);
    /* 停止证据未确认：工作区保持隔离（quarantined/retained），不放行续跑。 */
    expect(recovery.startup.workspace).not.toBeNull();
    expect(['quarantined', 'retained']).toContain(recovery.startup.workspace!.status);
    const resumeReceipt = await client.resumeExecution({ projectId: f.projectA.projectId, runId,
      expectedRevision: one(f, 'SELECT revision FROM runs WHERE id = ?', runId).revision });
    /* 恢复入口不放行：回执拒绝（依赖被失败 Task 阻断），不重启执行。 */
    expect(resumeReceipt).toMatchObject({ status: 'rejected' });
    const resumeError = (resumeReceipt as { error?: { code?: string; details?: { reason?: string } } }).error;
    expect(['conflict', 'resource_busy']).toContain(resumeError?.code);
    expect(attemptsOf(f, taskId)).toHaveLength(1);
    expect(f.runtimeStarts()).toHaveLength(1);
    const elapsedMs = Date.now() - startedAt;
    const evidence = await f.collectDrillEvidence('f005-tail-unconfirmed', 'after', { runId });
    saveScenarioEvidence('f005-tail-unconfirmed', {
      identity: evidence.identity, budget: evidence.budget, timings: evidence.timings,
      manifest: { watermark: parsed.watermark, gaps: parsed.gaps },
      eventAccounting: { toolEvents: 2, messages: 3, persistedPrefix: 5 },
      workspace: { status: workspaceStatus() }, elapsedMs,
      note: '尾部等待 2s 有界收尾（events_tail_timeout）；前缀 5 事件全部落盘；停止核验未确认 → 隔离保持，恢复入口拒绝',
    });
  }, 300_000);

  it('[case:duplicate-and-missing-events] 重复事件与用量按稳定身份去重，丢失序列如实入缺口', async () => {
    const f = await openDrillFixture({ prefix: 'shiploop-p07f005-dup-' });
    fixtures.push(f);
    const { runId } = await f.startRun('a');
    await f.spawnDrillHost({
      label: 'f005-duplicate',
      script: recordingScript({
        prefixMessages: 3,
        writeTarget: false,
        lifecycle: { events: { drop: [5], duplicate: [6] } },
        usageSteps: [{ inputTokens: 10, outputTokens: 5, costUsdMicros: 100 }],
      }),
    });
    const taskId = f.projectA.taskIds[0]!;
    await waitFor(() => attemptsOf(f, taskId).length >= 1, 'first attempt starts', 120_000);
    const sessionId = await awaitFirstSessionId(f, taskId);
    await waitFor(() => {
      const first = attemptsOf(f, taskId)[0]!;
      return ['failed', 'interrupted'].includes(first.status);
    }, 'required recording stops on the incomplete scope', 180_000);

    const manifest = await readSessionManifest(f, f.projectA.projectId, sessionId);
    expect(manifest).not.toBeNull();
    const parsed = JSON.parse(manifest!.content) as Record<string, any>;
    /* 真实接线语义：RuntimeSession 会话层强制事件序列严格单调，重投的重复
     * 序列在进入 Recorder 去重前即按协议失败收口（sequence_not_monotonic →
     * event_stream_failed）。Recorder 级稳定 eventId 去重由 p07-2 单元回归
     * 覆盖；本处核对跨层有界失败与诚实前缀（drop 5 留缺口，重复重投 6 被
     * 会话层拦截，故 seq 6 的 usage 仅进入一次计账）。事件核算：tool_started/
     * tool_finished 占 1、2，三条消息占 3、4、5（5 丢失），usage 占 6。 */
    expect(parsed.gaps).toEqual(expect.arrayContaining(['missing_sequences:5', 'recording_failed:event_stream_failed']));
    expect(parsed.stats.eventsReceived).toBe(5);
    expect(parsed.stats.eventsPersisted).toBe(5);
    expect(parsed.watermark).toBe(6);
    /* 重复 usage 事件未再次计账：仅已持久前缀中的第一次观察进入用量。 */
    expect(parsed.usage.observations.counted).toBe(1);
    expect(parsed.usage.observations.totals).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsdMicros: 100, complete: true });
    /* 索引水位与公开正文：1-4、6 落盘，5 缺失；水位不越过持久前缀。 */
    expect(sessionState(f, sessionId).w).toBe(6);
    expect(messageCount(f, sessionId)).toBe(5);
    const sequences = rows(f, 'SELECT sequence FROM session_messages WHERE session_id = ? ORDER BY sequence', sessionId)
      .map(row => row.sequence as number);
    expect(sequences).toEqual([1, 2, 3, 4, 6]);
    /* 结算证据：记录失败与协议归因互相独立、如实保存。 */
    const settlement = await readSessionArtifact(f, f.projectA.projectId, `sessions/${sessionId}/runtime-settlement.json`);
    const settled = JSON.parse(settlement.content) as Record<string, any>;
    expect(settled.recording.failure).toBe('event_stream_failed');
    expect(settled.recording.watermark).toBe(6);
    expect(settled.execution.failure).toMatchObject({ kind: 'protocol', reason: 'runtime_events_failed' });
    /* required 不以 partial 冒充通过：Task/依赖状态如实。 */
    expect(one(f, 'SELECT status FROM tasks WHERE id = ?', taskId).status).not.toBe('passed');
    expect(one(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.projectA.dependentTaskId).n).toBe(0);
    const evidence = await f.collectDrillEvidence('f005-duplicate-missing', 'after', { runId });
    saveScenarioEvidence('f005-duplicate-missing', {
      identity: evidence.identity, budget: evidence.budget, timings: evidence.timings,
      manifest: { watermark: parsed.watermark, stats: parsed.stats, gaps: parsed.gaps,
        usageTotals: parsed.usage.observations.totals },
      persistedSequences: sequences,
      note: '会话层单调序列防线把重复序列折算为有界协议失败；Recorder 稳定身份去重由 p07-2 单元回归覆盖',
    });
  }, 240_000);

  it('[case:best-effort-explicit-partial] 用户显式 best_effort 配置继续交付并如实展示 partial 清单', async () => {
    const f = await openDrillFixture({ prefix: 'shiploop-p07f005-be-' });
    fixtures.push(f);
    const { runId } = await f.startRun('a');
    await f.spawnDrillHost({
      label: 'f005-best-effort',
      recording: { mode: 'best_effort' },
      script: recordingScript({
        prefixMessages: 3,
        lifecycle: { events: { drop: [5], duplicate: [6] } },
        usageSteps: [{ inputTokens: 10, outputTokens: 5, costUsdMicros: 100 }],
      }),
    });
    const taskId = f.projectA.taskIds[0]!;
    /* 交付继续：Task 级提交完成（演练子进程不装配 Feature 级收尾，Run 保持
     * running 是夹具已知形态，不作为交付判据）。 */
    await waitFor(() => one(f, 'SELECT status FROM tasks WHERE id = ?', taskId).status === 'passed'
      && one(f, 'SELECT status FROM tasks WHERE id = ?', f.projectA.dependentTaskId).status === 'passed',
    'best_effort delivery continues for both tasks', 240_000);
    /* 交付继续：Task 通过、依赖解锁并完成（与 required 同故障形态的对照）。 */
    expect(one(f, 'SELECT status FROM tasks WHERE id = ?', taskId).status).toBe('passed');
    expect(one(f, 'SELECT status FROM tasks WHERE id = ?', f.projectA.dependentTaskId).status).toBe('passed');
    const sessionId = sessionIdOf(f, taskId);
    /* partial 展示：清单如实 partial + 显式记录模式，缺口不因模式消失。 */
    const manifest = await readSessionManifest(f, f.projectA.projectId, sessionId);
    expect(manifest).not.toBeNull();
    const parsed = JSON.parse(manifest!.content) as Record<string, any>;
    expect(parsed.recordingMode).toBe('best_effort');
    expect(parsed.coverage).not.toBe('complete');
    expect(parsed.gaps).toEqual(expect.arrayContaining(['best_effort_partial']));
    const client = await connect(f);
    const manifests = await client.listWorkRecordings(f.projectA.projectId, { sessionId, recordType: 'manifests' });
    const latest = manifests.records.at(-1);
    expect(latest).toMatchObject({ coverage: 'partial' });
    const evidence = await f.collectDrillEvidence('f005-best-effort', 'after', { runId });
    saveScenarioEvidence('f005-best-effort', {
      identity: evidence.identity, budget: evidence.budget, timings: evidence.timings,
      config: { workRecordingMode: 'best_effort', source: 'explicit user assembly option' },
      manifest: { recordingMode: parsed.recordingMode, coverage: parsed.coverage, gaps: parsed.gaps },
      delivered: { task: 'passed', dependent: 'passed' },
      note: 'best_effort 为用户显式配置的独立验证；required 必需检查由同故障形态的 required 用例承担',
    });
  }, 300_000);

  it('[case:restart-prefix-no-double-execution] Host 崩溃重启后保留持久前缀且隔离期拒绝续跑不重复执行', async () => {
    const f = await openDrillFixture({ prefix: 'shiploop-p07f005-restart-' });
    fixtures.push(f);
    const { runId } = await f.startRun('a');
    const first = await f.spawnDrillHost({
      label: 'f005-restart-first',
      script: recordingScript({ prefixMessages: 40, gate: 'hold_restart', suffixMessages: 4 }),
    });
    const taskId = f.projectA.taskIds[0]!;
    await waitFor(() => attemptsOf(f, taskId).length >= 1, 'first attempt starts', 120_000);
    const sessionId = await awaitFirstSessionId(f, taskId);
    await waitFor(() => messageCount(f, sessionId) >= 32 && sessionState(f, sessionId).w === 32,
      'durable prefix indexed before the crash', 60_000);
    const before = one(f, 'SELECT attempts_created, runtime_starts FROM execution_batches');
    const oldGaps = sessionState(f, sessionId).gaps;
    await f.collectDrillEvidence('f005-restart', 'before', { runId });
    expect(first.kill('SIGKILL')).toBe(true);
    expect((await first.exited).signal).toBe('SIGKILL');

    /* 重启：中断 Attempt、Run 交由启动恢复接管（interrupted/restart_recovery）；
     * 记录中会话（started、manifest 未终结）按恢复契约隔离，不自动续跑。 */
    await f.spawnDrillHost({ label: 'f005-restart-second' });
    await waitFor(() => attemptsOf(f, taskId)[0]!.status === 'interrupted', 'attempt marked interrupted', 120_000);
    await waitFor(() => runStatus(f, runId) === 'interrupted', 'run interrupted after crash', 120_000);
    /* 水位不越过持久前缀：重启后旧会话水位/消息数/已落盘块均保持在崩溃时事实。 */
    expect(sessionState(f, sessionId).w).toBe(32);
    expect(messageCount(f, sessionId)).toBe(32);
    const chunk = f.q(
      'SELECT COUNT(*) AS n FROM artifacts WHERE storage_locator LIKE ? AND status = \'ready\'',
      `sessions/${sessionId}/event-log/%`,
    ) as Record<string, any>;
    expect(chunk.n).toBeGreaterThanOrEqual(1);
    expect(one(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.projectA.dependentTaskId).n).toBe(0);

    /* 隔离事实：工作区与三组租约全部 quarantined；旧会话 started、缺口未被抹除。 */
    expect(one(f, 'SELECT status FROM managed_workspaces WHERE feature_id = ?', f.projectA.featureId).status).toBe('quarantined');
    const leaseStates = rows(f, 'SELECT resource_kind, state FROM workspace_leases').map(row => `${row.resource_kind}:${row.state}`);
    expect(leaseStates).toEqual(['global:quarantined', 'project:quarantined', 'workspace:quarantined']);
    expect(one(f, 'SELECT status FROM sessions WHERE id = ?', sessionId).status).toBe('started');
    expect(sessionState(f, sessionId).gaps).toBe(oldGaps);

    /* 恢复诊断：execution.resume 预判不可执行（隔离占用/工作区隔离），
     * 不虚构续跑入口；只读诊断在隔离期仍可用。 */
    const client = await connect(f);
    const recovery = await client.getRunRecovery(f.projectA.projectId, runId);
    const resumeStep = recovery.startup.nextSteps.find(step => step.action === 'execution.resume');
    expect(resumeStep).toMatchObject({ executable: false });
    expect(resumeStep!.blockedBy).toEqual(expect.arrayContaining(['workspace_quarantined', 'quarantined_occupancy']));
    expect(recovery.startup.workspace).toMatchObject({ status: 'quarantined' });

    /* 显式 resume 被隔离期门控拒绝（resource_busy/startup_recovery），
     * 不创建新 Attempt、不启动 Runtime、不解锁依赖、预算零增量（不重复计账/执行）。 */
    const resumeRequest = { projectId: f.projectA.projectId, runId,
      expectedRevision: one(f, 'SELECT revision FROM runs WHERE id = ?', runId).revision };
    const resumeError = await client.resumeExecution(resumeRequest)
      .then(receipt => { throw new Error(`隔离期 resume 意外成功: ${JSON.stringify(receipt)}`); },
        (error: { code?: string; details?: { reason?: string } }) => error);
    expect(resumeError.code).toBe('resource_busy');
    expect(resumeError.details).toMatchObject({ reason: 'startup_recovery' });
    /* 等待可能的异步收尾后核对：隔离不重复执行、不重复计账。 */
    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect(attemptsOf(f, taskId)).toHaveLength(1);
    expect(f.runtimeStarts()).toHaveLength(1);
    expect(one(f, 'SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?', f.projectA.dependentTaskId).n).toBe(0);
    const after = one(f, 'SELECT attempts_created, runtime_starts FROM execution_batches');
    expect(after).toEqual(before);
    /* 重启后的补录/重探不抹除旧会话未知 live 缺口与水位。 */
    expect(sessionState(f, sessionId).w).toBe(32);
    expect(sessionState(f, sessionId).gaps).toBe(oldGaps);
    const prefixBody = await readSessionArtifact(f, f.projectA.projectId, `sessions/${sessionId}/event-log/%`);
    expect(prefixBody.sizeBytes).toBeGreaterThan(0);
    const evidence = await f.collectDrillEvidence('f005-restart', 'after', { runId });
    saveScenarioEvidence('f005-restart', {
      identity: evidence.identity, budget: evidence.budget, timings: evidence.timings,
      prefix: { sessionId, watermark: 32, messages: 32, gaps: oldGaps },
      quarantine: { leases: leaseStates, workspace: 'quarantined',
        resumeBlockedBy: resumeStep!.blockedBy },
      noDoubleExecution: { attempts: 1, runtimeStarts: 1, budgetDelta: 0 },
      note: '记录中崩溃按恢复契约隔离：水位/缺口保留，resume 预判不可执行且被门控拒绝，零重复执行/计账',
    });
  }, 360_000);
});
