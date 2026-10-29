/**
 * P07-1 / F-001 真实 Host 故障屏障夹具自测（有限预算与清理纪律）。
 *
 * 验收（.dag_context.json F-001）对应：
 * - Git 提交边界：条件 post-commit 钩子（可信测试故障点）在真实 commit 落盘
 *   后阻塞回执事务；强杀 Host 后结构化事实证明「commit 已发生、业务回执
 *   尚未持久化」；
 * - 超时行为：检查命令 hold 不放行时，检查超时在有限预算内有界定版批次，
 *   Host 不被杀死；Verifier 等待预算耗尽只跳过验证，Host 仍可协作关闭；
 * - 清理失败：wait 政策进程在预算内无法确认停止时，cleanup_unconfirmed
 *   作为独立失败保留，临时根不删除。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '../../helpers/git-repo.ts';
import {
  openFaultBarrierFixture,
  spawnIgnoringTerminator,
  waitFor,
  type FaultBarrierFixture,
} from '../../helpers/p07-1/fault-barrier-host.ts';

const fixtures: FaultBarrierFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    const result = await fixture.cleanup();
    if (!result.ok) {
      // cleanup_unconfirmed 是独立失败：不被业务断言吞掉，也不静默强清现场。
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

function attemptRow(fixture: FaultBarrierFixture): Record<string, any> {
  return fixture.q('SELECT id, task_id, status, execution_stage FROM attempts ORDER BY number DESC LIMIT 1');
}

describe.skipIf(process.platform !== 'darwin')('P07-1 / F-001 fault barrier fixture budgets and cleanup', () => {
  it('[case:p07-f001-git-barrier-kill] SIGKILLs the Host after the real commit landed but before the receipt transaction persisted', async () => {
    const fixture = await openFaultBarrierFixture({ gitBarrier: true, prefix: 'shiploop-p07f001-g-' });
    fixtures.push(fixture);
    expect(existsSync(fixture.gitHoldPath)).toBe(true);
    const child = await fixture.spawnHost(fixture.buildChildConfig('git-barrier'), 'p07f001-git');
    await waitFor(() => fixture.runtimeStarts().length === 1, 'Runtime 启动', 40_000);
    await waitFor(() => fixture.verifierMarker() !== undefined, '真实 Verifier 命令已启动', 90_000);
    /* 真实 Git 副作用先行证明：post-commit 钩子只在 commit 落盘后运行。 */
    await waitFor(() => fixture.gitMarker() !== undefined, 'post-commit 钩子已触发（commit 已落盘）', 90_000);
    const marker = fixture.gitMarker()!;
    const workspace = fixture.workspaceRow()!;
    expect(marker.head).not.toBe(workspace.base_commit);
    expect(git(['rev-parse', 'HEAD'], workspace.canonical_path).trim()).toBe(marker.head);

    /* 业务回执尚未持久化：operation 行仍无 actual_commit，Task 未通过。 */
    const attempt = attemptRow(fixture);
    expect(attempt).toMatchObject({ status: 'verifying', execution_stage: 'verification' });
    const pending = fixture.q('SELECT status, actual_commit FROM git_operations WHERE attempt_id = ?', attempt.id);
    expect(pending).toMatchObject({ status: 'pending' });
    expect(pending.actual_commit).toBeNull();
    expect(fixture.q('SELECT status FROM tasks')).toMatchObject({ status: 'running' });

    const before = await fixture.collectEvidence('git-barrier', 'before');
    expect(before.gitFacts).toMatchObject({ head: marker.head, headBeyondBase: true });
    await killHost(fixture, 'p07f001-git');

    const after = await fixture.collectEvidence('git-barrier', 'after');
    expect(after.gitFacts).toMatchObject({ head: marker.head, headBeyondBase: true });
    expect(after.entities.attempt).toMatchObject({ id: attempt.id, status: 'verifying' });
    expect(after.entities.task).toMatchObject({ status: 'running' });
    const receiptAfter = fixture.q('SELECT status, actual_commit FROM git_operations WHERE attempt_id = ?', attempt.id);
    /* commit 已发生但回执未写：强杀后仍未成功，不自动补写。 */
    expect(receiptAfter.status).not.toBe('succeeded');
    expect(receiptAfter.actual_commit).toBeNull();

    const cleanup = await fixture.cleanup();
    expect(cleanup).toMatchObject({ ok: true, removedTempRoot: true });
    expect(alive(marker.pid)).toBe(false);
  }, 150_000);

  it('[case:p07-f001-check-timeout] bounds a never-released verifier hold by the check timeout and keeps the Host servicable without faking a verdict', async () => {
    const fixture = await openFaultBarrierFixture({ prefix: 'shiploop-p07f001-t-' });
    fixtures.push(fixture);
    writeFileSync(fixture.verifierHoldPath, 'hold\n');
    const child = await fixture.spawnHost(fixture.buildChildConfig('check-timeout'), 'p07f001-check-timeout');
    await waitFor(() => fixture.runtimeStarts().length === 1, 'Runtime 启动', 40_000);
    await waitFor(() => fixture.verifierMarker() !== undefined, '检查命令已启动', 90_000);
    const marker = fixture.verifierMarker()!;

    /* A timeout is a durable infrastructure error, with real process absence. */
    const startedAt = Date.now();
    await waitFor(() => !alive(marker.pid), '检查超时后有界停止检查进程', 30_000);
    expect(Date.now() - startedAt).toBeLessThan(30_000);
    const reported = await child.waitMessage(['verifier_error', 'verifier_result'], 30_000);
    expect(reported).toMatchObject({ kind: 'verifier_result', status: 'error',
      checks: [{ checkKey: 'tests', status: 'error', reason: 'timed_out' }] });
    expect(fixture.q('SELECT status FROM verification_batches')).toMatchObject({ status: 'error' });
    expect(fixture.q('SELECT status, timed_out FROM check_results')).toEqual({ status: 'error', timed_out: 1 });
    expect(fixture.q('SELECT status FROM tasks')).toMatchObject({ status: 'running' });
    expect(attemptRow(fixture)).toMatchObject({ status: 'verifying' });
    expect(fixture.q('SELECT COUNT(*) AS n FROM git_operations')).toEqual({ n: 0 });

    /* Host 未被杀死：协作关闭成功证明仍可服务。 */
    child.send({ kind: 'close' });
    const exit = await child.exited;
    expect(exit.code).toBe(0);

    const cleanup = await fixture.cleanup();
    expect(cleanup).toMatchObject({ ok: true, removedTempRoot: true });
  }, 150_000);

  it('[case:p07-f001-verifier-wait-timeout] skips verification after the bounded attempt wait and keeps the Host cooperatively closable', async () => {
    const fixture = await openFaultBarrierFixture({ prefix: 'shiploop-p07f001-w-' });
    fixtures.push(fixture);
    const config = fixture.buildChildConfig('verifier-wait-timeout', {
      /* Runtime 被门闩挂起超过 Verifier 等待预算（6s），之后定时放行，证明：
       * 等待预算耗尽只跳过验证，不挂死 Host，也不伪称已验证。 */
      gates: ['hold'],
      script: {
        schemaVersion: 1,
        steps: [
          { op: 'message', role: 'assistant', text: 'P07-1 F-001 verifier wait budget' },
          { op: 'await_gate', name: 'hold' },
        ],
        result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 1, usage: null },
      },
      gateRelease: { name: 'hold', afterMs: 12_000 },
    });
    const child = await fixture.spawnHost(config, 'p07f001-wait-timeout');
    await waitFor(() => fixture.runtimeStarts().length === 1, 'Runtime 启动', 40_000);
    const skipped = await child.waitMessage('verifier_skipped', 30_000);
    expect(skipped).toMatchObject({ kind: 'verifier_skipped', reason: 'attempt_wait_timeout' });
    /* 门闩定时放行后 Runtime 正常结束：Attempt 到达 verifying，但没有批次
     * （Verifier 已按预算跳过），Task 不通过、无 Git 副作用。 */
    await waitFor(() => attemptRow(fixture)?.status === 'verifying', 'Runtime 放行后到达验证边界', 40_000);
    expect(fixture.q('SELECT COUNT(*) AS n FROM verification_batches')).toEqual({ n: 0 });
    expect(fixture.q('SELECT status FROM tasks')).toMatchObject({ status: 'running' });
    expect(fixture.verifierMarker()).toBeUndefined();
    const evidence = await fixture.collectEvidence('verifier-wait-timeout', 'after');
    expect(evidence.gitFacts).toMatchObject({ headBeyondBase: false });
    expect(evidence.entities.verificationBatch).toBeUndefined();

    child.send({ kind: 'close' });
    const exit = await child.exited;
    expect(exit.code).toBe(0);
    const cleanup = await fixture.cleanup();
    expect(cleanup).toMatchObject({ ok: true, removedTempRoot: true });
  }, 150_000);

  it('[case:p07-f001-cleanup-unconfirmed] reports an unconfirmable wait-policy process as an independent cleanup failure and retains the temp root', async () => {
    const fixture = await openFaultBarrierFixture({ prefix: 'shiploop-p07f001-c-' });
    fixtures.push(fixture);
    const terminator = spawnIgnoringTerminator('p07f001-cleanup-failure');
    try {
      expect(alive(terminator.pid)).toBe(true);
      /* wait 政策：只用协作信号；进程忽略 SIGTERM，预算内无法确认停止。 */
      fixture.registerControlled({ pid: terminator.pid, label: 'wait-policy-holder', policy: 'wait' });
      const result = await fixture.cleanup();
      expect(result.ok).toBe(false);
      expect(result.cleanupUnconfirmed).toEqual(expect.arrayContaining([
        expect.stringContaining('wait-policy-holder'),
      ]));
      expect(result.removedTempRoot).toBe(false);
      /* 现场保留：临时根与证据目录仍在，供排障；进程仍真实存活。 */
      expect(existsSync(fixture.evidenceDir)).toBe(true);
      expect(alive(terminator.pid)).toBe(true);
    } finally {
      terminator.stop();
      await waitFor(() => !alive(terminator.pid), 'terminator 最终退出', 10_000);
      await fixture.forceDispose();
    }
    expect(alive(terminator.pid)).toBe(false);
    expect(existsSync(join(fixture.fixture.box.root, 'p07-1-evidence'))).toBe(false);
  }, 60_000);
});
