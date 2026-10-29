/**
 * P07-1 / F-001 真实 Host 故障屏障夹具自测（屏障证据面）。
 *
 * 验收（.dag_context.json F-001）对应：
 * - 正常放行：FakeRuntime 写入 → 真实 Verifier 检查命令进程启动并通过 →
 *   公开 taskVerificationCompletion 收尾 → 真实 git commit 回执持久化、
 *   Task passed；全程经公开 Core/Host 入口，无补写业务表；
 * - Runner 边界：受控工具进程持续写 heartbeat/worker.pid，强杀 Host 后仍
 *   实际写入（不以固定 sleep 或状态轮询代替写入证明）；
 * - Verifier 边界：真实检查命令进程自写启动标记并挂起，批次保持 running、
 *   未定版未提交；强杀 Host 后结构化快照证明边界位置，而非日志文本。
 *
 * 每个场景采集故障前后结构化证据（含代码版本关联），finally 有限回收并
 * 核验受控进程树缺席；cleanup_unconfirmed 作为独立失败抛出。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openFaultBarrierFixture,
  waitFor,
  type FaultBarrierFixture,
} from '../../helpers/p07-1/fault-barrier-host.ts';

const fixtures: FaultBarrierFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    const result = await fixture.cleanup();
    if (!result.ok) {
      throw new Error(`cleanup_unconfirmed: ${JSON.stringify(result.cleanupUnconfirmed)}`);
    }
  }
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function killHost(fixture: FaultBarrierFixture, label: string): Promise<void> {
  const child = fixture.children.at(-1)!;
  expect(child.label).toBe(label);
  expect(child.kill('SIGKILL')).toBe(true);
  const exit = await child.exited;
  expect(exit.signal).toBe('SIGKILL');
}

async function waitForWorkspace(fixture: FaultBarrierFixture): Promise<{ id: string; canonical_path: string; status: string; branch: string; base_commit: string }> {
  await waitFor(() => fixture.workspaceRow() !== undefined, '受管工作区就绪', 40_000);
  return fixture.workspaceRow()!;
}

function attemptRow(fixture: FaultBarrierFixture): Record<string, any> {
  return fixture.q('SELECT id, task_id, status, execution_stage, exit_code, diagnostic_ref FROM attempts ORDER BY number DESC LIMIT 1');
}

describe.skipIf(process.platform !== 'darwin')('P07-1 / F-001 fault barrier fixture evidence', () => {
  it('[case:p07-f001-normal-passthrough] releases all three boundaries normally: verifier command runs, commit receipt persists, task passes', async () => {
    const fixture = await openFaultBarrierFixture({ prefix: 'shiploop-p07f001-n-' });
    fixtures.push(fixture);
    const child = await fixture.spawnHost(fixture.buildChildConfig('normal'), 'p07f001-normal');
    await waitFor(() => fixture.runtimeStarts().length === 1, 'Runtime 启动', 40_000);

    /* Verifier 边界先行证明：真实检查命令进程自写启动标记。 */
    await waitFor(() => fixture.verifierMarker() !== undefined, '真实 Verifier 命令已启动', 90_000);
    const marker = fixture.verifierMarker()!;
    expect(marker.pid).toBeGreaterThan(1);
    const before = await collectAt(fixture, 'normal', 'before');
    const verifierResult = await child.waitMessage('verifier_result', 30_000);
    expect(verifierResult).toMatchObject({ kind: 'verifier_result', status: 'passed' });
    const completion = await child.waitMessage('verifier_completion', 30_000);
    expect(completion).toMatchObject({ kind: 'verifier_completion', outcome: 'passed', stopConfirmed: true });

    /* Git 副作用 + 业务回执都完成：Task passed 由持久事实证明。 */
    await waitFor(() => fixture.q('SELECT status FROM tasks')?.status === 'passed', 'Task 通过（真实提交回执后）', 30_000);
    const attempt = attemptRow(fixture);
    expect(attempt).toMatchObject({ status: 'succeeded', exit_code: 0 });
    expect(attempt.diagnostic_ref).toEqual(expect.any(String));
    const receipt = fixture.q('SELECT operation_type, status, actual_commit FROM git_operations WHERE attempt_id = ?', attempt.id);
    expect(receipt).toMatchObject({ operation_type: 'task_commit', status: 'succeeded' });
    expect(receipt.actual_commit).toEqual(expect.any(String));

    const after = await collectAt(fixture, 'normal', 'after');
    /* 结构化证据：提交后 HEAD 超出基线，回执与预算快照绑定场景与代码版本。 */
    expect(after.gitFacts).toMatchObject({ headBeyondBase: true });
    expect(after.gitFacts!.head).toBe(receipt.actual_commit);
    expect(after.operations.gitOperations).toEqual([
      { operation_type: 'task_commit', status: 'succeeded', has_actual_commit: 1, reason_code: null },
    ]);
    expect(after.budget).toMatchObject({ attempts_created: 1, runtime_starts: 1 });
    expect(after.codeVersion.repoHead).toMatch(/^[0-9a-f]{40}$/);
    expect(before.gitFacts).toMatchObject({ headBeyondBase: false });

    /* 协作关闭（正常放行路径的收尾证明）。 */
    child.send({ kind: 'close' });
    const exit = await child.exited;
    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
    /* 正常路径无 hold 屏障：git 钩子标记不应存在。 */
    expect(fixture.gitMarker()).toBeUndefined();
    const cleanup = await fixture.cleanup();
    expect(cleanup).toMatchObject({ ok: true, removedTempRoot: true });
    expect(alive(marker.pid)).toBe(false);
  }, 120_000);

  it('[case:p07-f001-runner-barrier-kill] SIGKILLs the Host while the Runner tool is actively writing and proves the boundary by structured facts', async () => {
    const fixture = await openFaultBarrierFixture({ prefix: 'shiploop-p07f001-r-' });
    fixtures.push(fixture);
    const child = await fixture.spawnHost(fixture.buildChildConfig('runner-barrier'), 'p07f001-runner');
    await waitFor(() => fixture.runtimeStarts().length === 1, 'Runtime 启动', 40_000);
    const workspace = await waitForWorkspace(fixture);
    await waitFor(() => existsSync(join(workspace.canonical_path, 'worker.pid')), '受控工具进程登记 worker.pid', 30_000);
    const workerPid = Number(readFileSync(join(workspace.canonical_path, 'worker.pid'), 'utf8'));
    expect(workerPid).toBeGreaterThan(1);
    const heartbeat = join(workspace.canonical_path, 'heartbeat.txt');
    await waitFor(() => existsSync(heartbeat) && statSync(heartbeat).size > 0, 'Runner 正在写入 heartbeat');

    const before = await collectAt(fixture, 'runner-barrier', 'before');
    expect((before.processes.markers as { workers: number[] }).workers).toContain(workerPid);
    expect(before.gitFacts).toMatchObject({ headBeyondBase: false });

    await killHost(fixture, 'p07f001-runner');
    /* Host 已死不是停止证据：旧工具进程继续真实写入。 */
    expect(alive(workerPid)).toBe(true);
    const sizeAtKill = statSync(heartbeat).size;
    await waitFor(() => statSync(heartbeat).size > sizeAtKill, 'Host 死后 Runner 工具仍在写文件');

    const after = await collectAt(fixture, 'runner-barrier', 'after');
    expect(after.entities.attempt).toMatchObject({ status: expect.stringMatching(/^(preparing|executing)$/) });
    expect(after.entities.task).toMatchObject({ status: 'running' });
    expect(after.gitFacts).toMatchObject({ headBeyondBase: false });
    /* Verifier 与 Git 边界均未到达：无检查进程、无提交副作用。 */
    expect((after.processes.markers as { verifier: number | null }).verifier).toBeNull();
    expect(fixture.verifierMarker()).toBeUndefined();
    expect(after.operations.gitOperations).toEqual([]);
    expect(after.codeVersion).toEqual(before.codeVersion);

    const cleanup = await fixture.cleanup();
    expect(cleanup).toMatchObject({ ok: true, removedTempRoot: true });
    expect(alive(workerPid)).toBe(false);
  }, 120_000);

  it('[case:p07-f001-verifier-barrier-kill] SIGKILLs the Host after the real verifier command started but before the batch settled', async () => {
    const fixture = await openFaultBarrierFixture({ prefix: 'shiploop-p07f001-v-' });
    fixtures.push(fixture);
    const child = await fixture.spawnHost(fixture.buildChildConfig('verifier-barrier'), 'p07f001-verifier');
    await waitFor(() => fixture.runtimeStarts().length === 1, 'Runtime 启动', 40_000);
    await waitFor(() => fixture.verifierMarker() !== undefined, '真实 Verifier 命令已启动', 90_000);
    const marker = fixture.verifierMarker()!;
    expect(alive(marker.pid)).toBe(true);

    /* 边界证明：批次已创建、running、未定版；不是只看 verifying 状态。 */
    await waitFor(() => {
      const batch = fixture.q('SELECT status FROM verification_batches');
      return batch !== undefined && batch.status === 'running';
    }, '验证批次已创建且未定版', 30_000);
    const attempt = attemptRow(fixture);
    expect(attempt).toMatchObject({ status: 'verifying', execution_stage: 'verification' });
    expect(fixture.q('SELECT COUNT(*) AS n FROM check_results')).toEqual({ n: 0 });

    const before = await collectAt(fixture, 'verifier-barrier', 'before');
    expect((before.processes.markers as { verifier: number | null }).verifier).toBe(marker.pid);
    await killHost(fixture, 'p07f001-verifier');
    /* Host 死后检查进程仍在 hold：真实孤儿，占位证明。 */
    expect(alive(marker.pid)).toBe(true);

    const after = await collectAt(fixture, 'verifier-barrier', 'after');
    expect(after.entities.attempt).toMatchObject({ id: attempt.id, status: 'verifying' });
    expect(after.entities.task).toMatchObject({ status: 'running' });
    expect(after.entities.verificationBatch).toMatchObject({ status: 'running' });
    /* 无提交副作用：Git 边界未到达。 */
    expect(after.gitFacts).toMatchObject({ headBeyondBase: false });
    expect(after.operations.gitOperations).toEqual([]);
    /* 业务回执未持久化：Task 未通过、无已完成批次。 */
    expect(fixture.q("SELECT status FROM tasks WHERE status = 'passed'")).toBeUndefined();

    const cleanup = await fixture.cleanup();
    expect(cleanup).toMatchObject({ ok: true, removedTempRoot: true });
    expect(alive(marker.pid)).toBe(false);
  }, 120_000);
});

async function collectAt(fixture: FaultBarrierFixture, scenario: string, phase: 'before' | 'after') {
  const evidence = await fixture.collectEvidence(scenario, phase);
  const path = join(fixture.evidenceDir, `${scenario}.jsonl`);
  expect(existsSync(path)).toBe(true);
  const lines = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  expect(lines.some(item => item.scenario === scenario && item.phase === phase)).toBe(true);
  return evidence;
}
