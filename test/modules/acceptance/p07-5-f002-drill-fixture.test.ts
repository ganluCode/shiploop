/**
 * P07-5 / F-002 故障演练夹具回归（仅测试；对应 .dag_context.json F-002 验收）。
 *
 * 覆盖验收面：
 * - 两个项目、带依赖任务、可核对工作区文件，全部经公开 Core 命令建立；
 *   SQLite 仅只读观察（probe）；真实临时 Git/SQLite/隔离 HOME/TMPDIR。
 * - 有界屏障：就绪（ready/host_ready）、暂停写入（FakeRuntime gate）、
 *   进入验证（真实检查进程启动 + drill_barrier）、进入提交（批次通过后/
 *   条件 post-commit 钩子：commit 落盘而回执未持久化）。
 * - 并发事实：两个真实请求的重叠/争用由记录的时间窗与共享文件交错证明，
 *   不用固定 sleep 代替竞争证据。
 * - 采集接口：身份绑定（run/commit/inputDigest/scenario）、业务行快照、
 *   预算与 deadline、Git HEAD/tree/status、进程身份与退出、制品摘要、
 *   命令退出码；合成敏感哨兵 fail-closed 脱敏。
 * - 清理：部分初始化、超时、取消、cleanup_unconfirmed 均有回归；
 *   cleanup_unconfirmed 保留现场并阻止验收（dispose 抛错）。
 * - 重复创建独立资源；耗时（准备/迁移/进程等待/清理）被记录。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openDrillFixture,
  type DrillCleanupFacts,
  type DrillFixture,
} from '../../helpers/p07-5/drill-fixture.ts';

const fixtures: DrillFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    const result = await fixture.cleanup();
    if (!result.status || result.status === 'pending') {
      throw new Error(`drill 夹具清理未收尾: ${JSON.stringify(result)}`);
    }
    if (result.status !== 'passed') {
      throw new Error(`cleanup_unconfirmed: ${JSON.stringify(result)}`);
    }
  }
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(process.platform !== 'darwin')('P07-5 / F-002 drill fixture', () => {
  it('[case:p07-f002-projects-via-public-commands] builds two projects with dependent tasks and verifiable workspace files through public commands', async () => {
    const fixture = await openDrillFixture({ prefix: 'shiploop-p07f002-pp-' });
    fixtures.push(fixture);

    /* 两个项目：不同 projectId、不同真实仓库；t-2 依赖 t-1（持久事实）。 */
    const a = fixture.projectA;
    const b = fixture.projectB;
    expect(a.projectId).not.toBe(b.projectId);
    expect(a.repositoryPath).not.toBe(b.repositoryPath);
    for (const project of [a, b]) {
      const firstTaskId = project.taskIds[0]!;
      const task1 = fixture.q('SELECT id, status FROM tasks WHERE feature_id = ? AND id = ?', project.featureId, firstTaskId) as Record<string, unknown> | undefined;
      expect(task1).toBeDefined();
      const task2 = fixture.q(
        'SELECT depends_on_id FROM task_dependencies WHERE feature_id = ? AND task_id = ?',
        project.featureId, project.dependentTaskId,
      ) as { depends_on_id: string } | undefined;
      expect(task2).toBeDefined();
      expect(task2!.depends_on_id).toBe(firstTaskId);
      /* 需求制品真实存在且带摘要（经公开制品发布器写入）。 */
      for (const taskId of project.taskIds) {
        const artifactId = project.requirementArtifactIds[taskId]!;
        const row = fixture.q(
          'SELECT kind, content_hash, size_bytes FROM artifacts WHERE project_id = ? AND id = ?',
          project.projectId, artifactId,
        ) as { kind: string; content_hash: string; size_bytes: number } | undefined;
        expect(row).toMatchObject({ kind: 'requirement' });
        expect(row!.content_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(row!.size_bytes).toBeGreaterThan(0);
      }
    }

    /* 真实资源核验：SQLite 文件真实（WAL 魔数不要求，但文件存在且非空）、
     * Git 仓库真实（rev-parse HEAD/status 可用）、隔离 HOME/TMPDIR。 */
    expect(existsSync(fixture.dbPath)).toBe(true);
    expect(statSync(fixture.dbPath).size).toBeGreaterThan(0);
    expect(fixture.gitFacts('a').head).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture.gitFacts('b').head).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture.homeDir.startsWith('/')).toBe(true);
    expect(fixture.homeDir).not.toBe(process.env.HOME ?? '');

    /* 公开命令启动真实 Run：预算与 deadline 持久化。 */
    const started = await fixture.startRun('a');
    expect(started.runId).toMatch(/^[0-9a-f-]{36}$/);
    const budget = fixture.q(
      'SELECT eb.attempts_created, eb.runtime_starts, eb.budget_snapshot, eb.deadline_at'
      + ' FROM execution_batches eb JOIN runs r ON r.batch_id = eb.id WHERE r.id = ?',
      started.runId,
    ) as Record<string, unknown> | undefined;
    expect(budget).toBeDefined();
    expect(budget!.deadline_at).not.toBeNull();
    expect(typeof budget!.budget_snapshot).toBe('string');

    const evidence = await fixture.collectDrillEvidence('p07-f002-public-setup', 'after', { runId: started.runId });
    expect(evidence.budget).not.toBeNull();
    expect(evidence.budget!.deadlineAt).not.toBeNull();
    expect(evidence.business.runs.length).toBeGreaterThan(0);
  }, 120_000);

  it('[case:p07-f002-pause-write-boundary] pauses the runtime before the workspace write and proves the boundary without sleeps', async () => {
    const fixture = await openDrillFixture({ prefix: 'shiploop-p07f002-pw-' });
    fixtures.push(fixture);
    await fixture.startRun('a');

    const child = await fixture.spawnDrillHost({ label: 'p07f002-pause-write', pauseWrite: true });
    await waitFor(() => fixture.runtimeStarts().length === 1, 'Runtime 启动（暂停写入门闩前）', 40_000);

    /* 受管工作区就绪，但目标文件尚未写入：门闩屏障证明「尚未写入」。 */
    await waitFor(() => fixture.workspaceRow('a') !== undefined, '受管工作区就绪', 40_000);
    const workspace = fixture.workspaceRow('a')!;
    const targetPath = join(workspace.canonical_path, ...fixture.runtimeTarget.path.split('/'));
    await waitFor(() => existsSync(targetPath) === false && fixture.runtimeStarts().length === 1, '目标文件尚未写入', 5_000);

    const before = await fixture.collectDrillEvidence('p07-f002-pause-write', 'before');
    const attempt = fixture.q('SELECT status, execution_stage FROM attempts ORDER BY number DESC LIMIT 1') as Record<string, unknown>;
    expect(String(attempt.status)).toMatch(/^(preparing|executing|dispatched)$/);
    expect(before.git.some(fact => fact.repository === 'a' && fact.headBeyondBase === false)).toBe(true);

    /* 在可证明边界终止自有进程（SIGKILL），随后协作清理核验停止。 */
    expect(child.kill('SIGKILL')).toBe(true);
    const exit = await child.exited;
    expect(exit.signal).toBe('SIGKILL');
    const after = await fixture.collectDrillEvidence('p07-f002-pause-write', 'after');
    expect(after.identity.scenarioId).toBe('p07-f002-pause-write');
    expect(after.identity.attempt).toBe(before.identity.attempt + 1);
    expect(existsSync(targetPath)).toBe(false);
  }, 120_000);

  it('[case:p07-f002-verification-entry-boundary] stops the host exactly after the real verifier command starts', async () => {
    const fixture = await openDrillFixture({ prefix: 'shiploop-p07f002-ve-' });
    fixtures.push(fixture);
    await fixture.startRun('a');

    const child = await fixture.spawnDrillHost({
      label: 'p07f002-verify-entry',
      verifierHold: true,
      barriers: { verificationEntry: true },
    });
    const barrier = await fixture.awaitBarrier(child, 'entered_verification', 90_000);
    expect(barrier.taskId).toBe(fixture.projectA.taskIds[0]);

    /* 屏障触发时：真实检查进程已启动（自写标记），Task 未通过、无 Git 提交。 */
    const marker = fixture.verifierMarker();
    expect(marker).toBeDefined();
    expect(marker!.pid).toBeGreaterThan(1);
    const task = fixture.q('SELECT status FROM tasks WHERE feature_id = ? AND id = ?', fixture.projectA.featureId, fixture.projectA.taskIds[0]!) as { status: string };
    expect(task.status).not.toBe('passed');
    const gitOps = fixture.q(
      'SELECT COUNT(*) AS n FROM git_operations go JOIN attempts at2 ON at2.id = go.attempt_id WHERE at2.project_id = ?',
      fixture.projectA.projectId,
    ) as { n: number };
    expect(gitOps.n).toBe(0);

    const evidence = await fixture.collectDrillEvidence('p07-f002-verify-entry', 'before');
    expect(evidence.processes.some(fact => fact.label === 'verifier-check')).toBe(true);

    expect(child.kill('SIGKILL')).toBe(true);
    await child.exited;
    const after = await fixture.collectDrillEvidence('p07-f002-verify-entry', 'after');
    expect(after.business.tasks.every(t => t.status !== 'passed' || t.taskId !== fixture.projectA.taskIds[0])).toBe(true);
    /* 自有进程清理核验标记 PID 缺席；监督器可能在 Host 死亡后已自行收尾
     * （产品停止升级语义），两种事实均为真实边界证据。 */
    const cleanup = await fixture.cleanup();
    expect(cleanup.status).toBe('passed');
    expect(alive(marker!.pid)).toBe(false);
  }, 120_000);

  it('[case:p07-f002-commit-entry-boundary] proves commit-durable-receipt-lost at the commit entry boundary', async () => {
    const fixture = await openDrillFixture({ prefix: 'shiploop-p07f002-ce-' });
    fixtures.push(fixture);
    await fixture.startRun('a');

    const child = await fixture.spawnDrillHost({
      label: 'p07f002-commit-entry',
      barriers: { verificationEntry: true, commitEntry: true },
    });
    await fixture.awaitBarrier(child, 'entered_verification', 90_000);
    /* 植入条件 post-commit 钩子（可信测试故障点）：真实 commit 落盘后阻塞回执事务。 */
    fixture.plantCommitBoundary('a');
    fixture.releaseBarrier(child, 'entered_verification');
    await fixture.awaitBarrier(child, 'entered_commit', 90_000);
    fixture.releaseBarrier(child, 'entered_commit');

    /* 钩子标记出现 = commit 已落盘、回执尚未持久化。 */
    await waitFor(() => fixture.gitMarker('a') !== undefined, 'post-commit 钩子标记（commit 已落盘）', 30_000);
    const gitMarker = fixture.gitMarker('a')!;
    const facts = fixture.gitFacts('a');
    expect(facts.head).toBe(gitMarker.head);
    expect(facts.headBeyondBase).toBe(true);

    expect(child.kill('SIGKILL')).toBe(true);
    await child.exited;
    const evidence = await fixture.collectDrillEvidence('p07-f002-commit-entry', 'after');
    const attempt = evidence.business.attempts.at(-1)!;
    const receipt = fixture.q('SELECT status, actual_commit FROM git_operations WHERE attempt_id = ?', attempt.attemptId) as Record<string, unknown> | undefined;
    /* 回执丢失：无 succeeded 回执或无 actual_commit；Task 未通过。 */
    expect(receipt === undefined || receipt.actual_commit === null || receipt.status !== 'succeeded').toBe(true);
    const task = fixture.q('SELECT status FROM tasks WHERE feature_id = ? AND id = ?', fixture.projectA.featureId, fixture.projectA.taskIds[0]!) as { status: string };
    expect(task.status).not.toBe('passed');
  }, 150_000);

  it('[case:p07-f002-concurrency-facts] records real overlap and lock contention without fixed sleeps', async () => {
    const fixture = await openDrillFixture({ prefix: 'shiploop-p07f002-cc-' });
    fixtures.push(fixture);

    /* 两个真实写入进程并发运行：时间窗重叠 + 共享文件交错行。 */
    const sharedLog = join(fixture.markerDir, 'concurrency-shared.log');
    const writerScript = (id: string) => [
      `const fs=require('node:fs')`,
      `const path=${JSON.stringify(sharedLog)}`,
      `for(let i=0;i<8;i++){fs.appendFileSync(path, ${JSON.stringify(id)}+' '+Date.now()+'\\n');`,
      `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60)}`,
    ].join(';');
    const facts = await fixture.runConcurrent('drill-writers', [
      { id: 'w1', run: () => fixture.runCommand('w1', [process.execPath, '-e', writerScript('w1')], { timeoutMs: 10_000 }) },
      { id: 'w2', run: () => fixture.runCommand('w2', [process.execPath, '-e', writerScript('w2')], { timeoutMs: 10_000 }) },
    ]);
    expect(facts.participants).toHaveLength(2);
    const pair = facts.pairs[0]!;
    expect(pair.overlapped).toBe(true);
    expect(pair.overlapMillis).toBeGreaterThan(0);
    const lines = readFileSync(sharedLog, 'utf8').split('\n').filter(Boolean);
    expect(lines.some(line => line.startsWith('w1 '))).toBe(true);
    expect(lines.some(line => line.startsWith('w2 '))).toBe(true);

    /* 公共元数据锁真实争用：第一持有期内第二请求被拒（重叠窗口事实）。 */
    const lockFacts = await fixture.publicLockContentionFacts('a');
    expect(lockFacts.first.acquired).toBe(true);
    expect(lockFacts.first.heldMs).toBeGreaterThan(0);
    expect(lockFacts.second.acquired).toBe(false);
    expect(lockFacts.second.rejectedReason).toBe('resource_busy');
    expect(lockFacts.second.attemptedDuringHold).toBe(true);
    expect(lockFacts.concurrentlyHeld).toBe(false);
  }, 60_000);

  it('[case:p07-f002-evidence-identity-redaction] binds evidence identity and fails closed on sensitive content', async () => {
    const fixture = await openDrillFixture({ prefix: 'shiploop-p07f002-ev-' });
    fixtures.push(fixture);
    const run = await fixture.startRun('a');

    const evidence = await fixture.collectDrillEvidence('p07-f002-identity', 'before', { runId: run.runId });
    expect(evidence.identity).toMatchObject({
      schemaVersionBrand: 'p07-5-drill',
      runId: run.runId,
      scenarioId: 'p07-f002-identity',
    });
    expect(evidence.identity.testedCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(evidence.identity.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    /* 同一夹具同输入摘要稳定；不同 runId 不改变输入摘要。 */
    const again = await fixture.collectDrillEvidence('p07-f002-identity', 'after', { runId: run.runId });
    expect(again.identity.inputDigest).toBe(evidence.identity.inputDigest);
    expect(again.identity.attempt).toBe(evidence.identity.attempt + 1);

    /* 序列化证据不包含合成哨兵、开发机路径或真实 HOME。 */
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(fixture.sensitiveSentinelValue);
    expect(serialized).not.toContain(fixture.bearerSentinelValue);
    const describe = JSON.stringify(fixture.describeFacts());
    expect(describe).not.toContain(fixture.sensitiveSentinelValue);
    expect(describe).not.toContain(fixture.bearerSentinelValue);

    /* 采集错误 fail-closed：未知场景身份拒绝。 */
    await expect(fixture.collectDrillEvidence('Bad_Scenario', 'before')).rejects.toThrow(/invalid_scenario/);
    /* 证据日志对哨兵内容 fail-closed（脱敏边界）。 */
    expect(() => fixture.evidence.record('drill.leak.probe', { token: fixture.sensitiveSentinelValue }))
      .toThrow();
  }, 60_000);

  it('[case:p07-f002-timeout-cancel-commands] records bounded timeout escalation and cancel exits for controlled commands', async () => {
    const fixture = await openDrillFixture({ prefix: 'shiploop-p07f002-tc-' });
    fixtures.push(fixture);

    /* 超时：挂起命令有界停止（升级核验），记录 timedOut。 */
    const hang = await fixture.runCommand('hang', [process.execPath, '-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},500)"], { timeoutMs: 800 });
    expect(hang.exitCode).not.toBe(0);
    expect(hang.timedOut).toBe(true);
    expect(hang.stopConfirmed).toBe(true);
    expect(hang.escalated.length).toBeGreaterThan(0);

    /* 取消：运行中强杀，退出信号被记录。 */
    const cancel = fixture.spawnCommand('cancel-target', [process.execPath, '-e', "require('node:fs').writeFileSync('started','1');setInterval(()=>{},500)"], { cwd: fixture.markerDir });
    await waitFor(() => existsSync(join(fixture.markerDir, 'started')), '取消目标已启动', 5_000);
    cancel.kill('SIGKILL');
    const cancelled = await cancel.exited;
    expect(cancelled.signal).toBe('SIGKILL');
    const facts = fixture.commandFacts();
    expect(facts.some(fact => fact.label === 'hang' && fact.timedOut)).toBe(true);
    expect(facts.some(fact => fact.label === 'cancel-target' && fact.signal === 'SIGKILL')).toBe(true);
  }, 60_000);

  it('[case:p07-f002-cleanup-unconfirmed] retains the scene and blocks acceptance when stop confirmation fails', async () => {
    const fixture = await openDrillFixture({ prefix: 'shiploop-p07f002-cu-' });
    fixtures.push(fixture);
    await fixture.startRun('a');
    const child = await fixture.spawnDrillHost({ label: 'p07f002-cleanup' });
    await waitFor(() => fixture.runtimeStarts().length === 1, 'Runtime 启动', 40_000);
    child.send({ kind: 'close' });
    await child.exited;

    const failed: DrillCleanupFacts = await fixture.cleanup({ confirmStopped: () => false });
    expect(failed.status).toBe('failed');
    expect(failed.processStopped).toBe(true);
    expect(failed.resourcesRemoved).toBe(false);
    expect(failed.retainedRoot).not.toBeNull();
    expect(existsSync(failed.retainedRoot!)).toBe(true);
    expect(String(failed.reason)).toContain('停止确认回调返回 false');

    /* cleanup_unconfirmed 阻止验收：dispose 抛错且现场保留。 */
    await expect(fixture.dispose()).rejects.toThrow(/清理未确认/);
    expect(existsSync(failed.retainedRoot!)).toBe(true);
    /* 测试收尾兜底：强制清理自有资源（仅测试环境，不作为验收路径）。 */
    await fixture.forceDispose();
    expect(existsSync(failed.retainedRoot!)).toBe(false);
    /* 已强制清理：从 afterEach 清单移除，避免重复清理。 */
    const index = fixtures.indexOf(fixture);
    if (index >= 0) fixtures.splice(index, 1);
    const final = await fixture.cleanup();
    expect(final.status).toBe('passed');
  }, 120_000);

  it('[case:p07-f002-partial-init-regression] keeps structured facts for partial initialization and cleans only the owned root', async () => {
    const roots: string[] = [];
    let captured: Error | undefined;
    try {
      await openDrillFixture({ prefix: 'shiploop-p07f002-pi-', stopAfter: 'project-a', observeRoot: (root) => roots.push(root) });
    } catch (error) {
      captured = error as Error;
    }
    expect(captured).toBeDefined();
    expect(captured!.name).toBe('DrillFixturePartialInitError');
    const partial = captured as InstanceType<typeof import('../../helpers/p07-5/drill-fixture.ts').DrillFixturePartialInitError>;
    expect(partial.stage).toBe('project-a');
    expect(partial.prepared).toContain('sandbox');
    expect(partial.prepared).toContain('application');
    expect(partial.prepared).not.toContain('complete');
    /* 部分初始化尽力清理自有临时根。 */
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) expect(existsSync(root)).toBe(false);
  }, 60_000);

  it('[case:p07-f002-independent-repeat-creation] gives repeated creations isolated resources', async () => {
    const first = await openDrillFixture({ prefix: 'shiploop-p07f002-r1-' });
    fixtures.push(first);
    const second = await openDrillFixture({ prefix: 'shiploop-p07f002-r2-' });
    fixtures.push(second);

    expect(first.root).not.toBe(second.root);
    expect(first.dbPath).not.toBe(second.dbPath);
    expect(first.projectA.projectId).not.toBe(second.projectA.projectId);
    /* 独立资源事实：各自真实仓库位于各自临时根内（内容确定性提交 SHA 可相同）。 */
    expect(first.projectA.repositoryPath.startsWith(first.root)).toBe(true);
    expect(second.projectA.repositoryPath.startsWith(second.root)).toBe(true);
    expect(first.projectA.repositoryPath).not.toBe(second.projectA.repositoryPath);
    expect(first.gitFacts('a').head).toMatch(/^[0-9a-f]{40}$/);
    expect(second.gitFacts('a').head).toMatch(/^[0-9a-f]{40}$/);

    /* 项目制品互不可见（项目隔离事实）。 */
    const cross = first.q(
      'SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ?',
      second.projectA.projectId,
    ) as { n: number };
    expect(cross.n).toBe(0);

    const firstCleanup = await first.cleanup();
    expect(firstCleanup.status).toBe('passed');
    expect(existsSync(second.root)).toBe(true);
    const secondCleanup = await second.cleanup();
    expect(secondCleanup.status).toBe('passed');
  }, 60_000);

  it('[case:p07-f002-timings-recorded] records preparation, migration, process-wait and cleanup durations', async () => {
    const fixture = await openDrillFixture({ prefix: 'shiploop-p07f002-tm-' });
    fixtures.push(fixture);
    await fixture.startRun('a');
    const child = await fixture.spawnDrillHost({ label: 'p07f002-timing' });
    await waitFor(() => fixture.runtimeStarts().length === 1, 'Runtime 启动', 40_000);
    await fixture.collectDrillEvidence('p07-f002-timings', 'before');
    child.send({ kind: 'close' });
    await child.exited;
    const cleanup = await fixture.cleanup();
    expect(cleanup.status).toBe('passed');

    const timings = fixture.timings;
    for (const key of ['prepareResourcesMs', 'migrationMs', 'processWaitMs', 'cleanupMs']) {
      expect(Number.isFinite(timings[key])).toBe(true);
      expect(timings[key] as number).toBeGreaterThanOrEqual(0);
    }
    expect(timings.prepareResourcesMs as number).toBeGreaterThan(0);
    expect(timings.processWaitMs as number).toBeGreaterThan(0);
    const evidence = fixture.lastEvidence();
    expect(evidence).not.toBeNull();
    expect(evidence!.timings.prepareResourcesMs).toBeGreaterThan(0);
  }, 120_000);
});
