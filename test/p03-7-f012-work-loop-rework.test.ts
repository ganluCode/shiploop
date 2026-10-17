/**
 * P03-7 / F-012：全真实组装纵向——同一 worktree 有界增量返工。
 *
 * 验收点 1 的端到端形态：FakeRuntime 首次执行写入文件 → 确定性代码检查失败
 * （真实 VerificationBatch 定版）→ 受信验证收尾（F-012 completion 入口）→
 * Task 回 pending、Run 回 running、占用释放 → 既有调度在同一 worktree 上
 * 认领新 Attempt（F-011 返工快照绑定直接上一 Attempt）→ FakeRuntime 再次
 * 启动（runtime_starts=2），首跑写入的文件仍然可见（同 worktree 证据）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBindingFixture, BINDING_NOW } from './helpers/p03-6/input-binding-fixture.ts';
import type { BindingFixture } from './helpers/p03-6/input-binding-fixture.ts';
import { openFakeCoreApplication } from '../packages/core/src/adapters/testing.ts';
import type { CoreApplication } from '../packages/core/src/adapters/composition.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import { createCommandProcessAdapter } from '../packages/core/src/adapters/process/command-process.ts';
import { createSqliteVerificationStore } from '../packages/core/src/adapters/sqlite/verification-store.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import {
  RUNTIME_RESULT_SCHEMA_VERSION, RUNTIME_STOP_EVIDENCE_SCHEMA_VERSION,
} from '../packages/core/src/ports/runtime-execution.ts';

const CODE_DIGEST = 'cd'.repeat(32);
const HEAD = 'b'.repeat(40);

let fixture: BindingFixture | undefined;
let core: CoreApplication | undefined;
afterEach(async () => {
  if (core) { await core.workExecution.close(); core.close(); core = undefined; }
  fixture?.close(); fixture = undefined;
});

const query = (sql: string, ...params: unknown[]) => fixture!.query(sql, ...params) as Record<string, unknown>;

/** 真实定版失败批次：一条必需检查 failed(exitCode=1)，输出证据为真实制品。 */
async function seedFailedBatch(attempt: { id: string; execution_version: number; input_snapshot: string }) {
  const db = fixture!.session.database;
  const snapshot = JSON.parse(attempt.input_snapshot) as { approval: { checkPolicyDigest: string } };
  const output = await fixture!.publisher.publishArtifact({
    projectId: fixture!.projectId, kind: 'verification_output', mediaType: 'text/plain',
    expectedHash: createHash('sha256').update('FAIL src/marker.test.ts\n1 failed\n').digest('hex'),
    locator: `verification/${attempt.id}/tests-output.txt`,
    content: [Buffer.from('FAIL src/marker.test.ts\n1 failed\n', 'utf8')],
  });
  const verification = createSqliteVerificationStore(fixture!.session, { nowUtcMs: () => BINDING_NOW });
  const atomic = createSqliteAtomicCommandStore(fixture!.session, { nowUtcMs: () => BINDING_NOW });
  const batchId = 'verification-rework-1';
  await atomic.transact('F-012.seed-failed-verification', transaction => {
    verification.createVerificationBatchInTransaction(transaction, {
      batchId, projectId: fixture!.projectId, featureId: fixture!.featureId, runId: fixture!.runId,
      taskId: 't-1', attemptId: attempt.id, executionVersion: attempt.execution_version,
      operation: 'task.verify.checks', codeDigest: CODE_DIGEST,
      policyDigest: snapshot.approval.checkPolicyDigest,
      environmentSummary: { runner: 'node', nodeVersion: 'v22.19.0', platform: 'darwin' },
      checkSnapshot: [{ checkKey: 'tests', scope: 'task', kind: 'command', argv: ['npm', 'test'],
        cwdRef: null, environmentRef: null, timeout: 60_000, required: true, requirementRefs: [] }],
      selection: { schemaVersion: 1, mode: 'candidates', reason: '受影响范围选择', selectedCheckKeys: ['tests'] },
      startedAtUtcMs: BINDING_NOW,
    });
    verification.saveCheckResultInTransaction(transaction, {
      resultId: 'vres-rework-1', projectId: fixture!.projectId, batchId, checkKey: 'tests',
      status: 'failed', exitCode: 1, signal: null, timedOut: false,
      outputArtifactId: output.artifact.id, outputTail: '1 failed',
      startedAtUtcMs: BINDING_NOW, endedAtUtcMs: BINDING_NOW + 1000,
    });
    verification.finalizeVerificationBatchInTransaction(transaction, {
      projectId: fixture!.projectId, batchId, expectedRevision: 1, status: 'failed',
    });
  });
  return { batchId, policyDigest: snapshot.approval.checkPolicyDigest };
}

describe('F-012 同一 worktree 有界增量返工（全真实组装）', () => {
  it('代码检查失败 → 同 worktree 返工认领新 Attempt，首跑文件保留', async () => {
    fixture = await openBindingFixture();
    core = await openFakeCoreApplication({
      dataRoot: fixture.box.dataRoot,
      capabilityCatalog: createStaticRuntimeCapabilityCatalog([
        { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
      ]),
      nowUtcMs: () => BINDING_NOW,
      fake: {
        providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
        /* tool_command 步骤产生真实 OS 进程身份：停止证据（整组缺席普查）可证明，
         * 使 F-012 完成入口能按契约释放占用供同 worktree 返工。 */
        commandProcess: createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 1_000 }),
        toolCommands: { probe: { argv: ['/usr/bin/true'], timeoutMs: 5_000 } },
        script: { schemaVersion: 1, steps: [
          { op: 'write_file', path: 'src/marker.ts', content: 'export const marker = 1;\n' },
          { op: 'tool_command', name: 'probe' },
          { op: 'message', role: 'assistant', text: '首轮完成' },
        ] },
      },
    });

    /* 首轮：认领 → 准备（创建受管 worktree）→ FakeRuntime 执行完成。 */
    const first = await core.workExecution.scan();
    expect(first.runs).toMatchObject([{ claimed: true }]);
    await expect.poll(() => core!.workExecution.activeAttemptIds(), { timeout: 10_000 }).toEqual([]);
    const attempt = query('SELECT id, owner_id, host_instance_id, execution_version, input_snapshot FROM attempts') as unknown as {
      id: string; owner_id: string; host_instance_id: string; execution_version: number; input_snapshot: string;
    };
    expect(query('SELECT status, execution_stage FROM attempts WHERE id = ?', attempt.id))
      .toMatchObject({ status: 'verifying', execution_stage: 'verification' });
    const worktreePath = (query('SELECT canonical_path FROM managed_workspaces') as { canonical_path: string }).canonical_path;
    /* 首跑写入的文件在受管 worktree 中。 */
    expect(readFileSync(join(worktreePath, 'src/marker.ts'), 'utf8')).toBe('export const marker = 1;\n');
    expect((query('SELECT runtime_starts FROM execution_batches') as { runtime_starts: number }).runtime_starts).toBe(1);

    /* 真实失败批次定版 + 受信验证收尾：code_failure，预算剩余。 */
    const { batchId, policyDigest } = await seedFailedBatch(attempt);
    const completion = await core.taskVerificationCompletion.complete({
      identity: { projectId: fixture.projectId, attemptId: attempt.id, owner: attempt.owner_id,
        hostInstanceId: attempt.host_instance_id, executionVersion: attempt.execution_version },
      taskId: 't-1', runId: fixture.runId, verificationBatchId: batchId,
      observation: {
        runtime: {
          result: { schemaVersion: RUNTIME_RESULT_SCHEMA_VERSION, terminal: 'completed', reason: null,
            exitCode: 0, signal: null, durationMs: 10, usage: null, lastEventSequence: null },
          stopped: { schemaVersion: RUNTIME_STOP_EVIDENCE_SCHEMA_VERSION, confirmed: true,
            checkedAtUtc: new Date(BINDING_NOW).toISOString(), detail: null },
        },
        workspaceHeld: true,
        beforeIdentity: { headCommit: HEAD, codeDigest: CODE_DIGEST, executionDigest: policyDigest },
        afterIdentity: { headCommit: HEAD, codeDigest: CODE_DIGEST, executionDigest: policyDigest },
        testCounts: { tests: 1 },
      },
      failures: { tests: 'code' },
    });
    expect(completion.outcome).toBe('code_failure');
    expect(completion.receipt).toMatchObject({ disposition: 'applied', status: 'failed' });

    /* 预算/审批/控制门通过：Task 回 pending、Run 回 running、占用释放、证据保留。 */
    expect(query('SELECT status, code_attempts_used FROM tasks WHERE id = ?', 't-1'))
      .toMatchObject({ status: 'pending', code_attempts_used: 1 });
    expect(query('SELECT status, reason FROM runs WHERE id = ?', fixture.runId))
      .toEqual({ status: 'running', reason: null });
    expect((query('SELECT COUNT(*) AS n FROM workspace_leases') as { n: number }).n).toBe(0);
    expect(query('SELECT status, error_kind FROM attempts WHERE id = ?', attempt.id))
      .toMatchObject({ status: 'failed', error_kind: 'code_failure' });

    /* 既有调度重新认领：同一 worktree 上的有界增量返工。 */
    const second = await core.workExecution.scan();
    expect(second.runs, JSON.stringify(query('SELECT reason FROM runs'))).toMatchObject([{ claimed: true }]);
    await expect.poll(() => core!.workExecution.activeAttemptIds(), { timeout: 10_000 }).toEqual([]);

    const attempts = fixture.session.database.prepare(
      'SELECT id, status, execution_version, input_snapshot FROM attempts ORDER BY number').all() as
      { id: string; status: string; execution_version: number; input_snapshot: string }[];
    expect(attempts).toHaveLength(2);
    const reworkAttempt = attempts[1]!;
    expect(reworkAttempt.id).not.toBe(attempt.id);
    expect(reworkAttempt.execution_version).toBe(2);
    const snapshot = JSON.parse(reworkAttempt.input_snapshot) as {
      schemaVersion: number;
      rework: { attemptId: string; previousAttemptId: string; previousTaskId: string;
        scene: { worktreeId: string; headCommit: string; codeDigest: string };
        failureEvidenceRefs: readonly unknown[]; recovery: { selection: { mode: string }; decision: { mode: string } } };
    };
    /* F-011 返工快照：绑定直接上一 Attempt、现场身份、失败证据与真实恢复记录。 */
    expect(snapshot.schemaVersion).toBe(3);
    expect(snapshot.rework.attemptId).toBe(reworkAttempt.id);
    expect(snapshot.rework.previousAttemptId).toBe(attempt.id);
    expect(snapshot.rework.previousTaskId).toBe('t-1');
    expect(snapshot.rework.failureEvidenceRefs.length).toBeGreaterThan(0);
    expect(snapshot.rework.recovery).toMatchObject({ selection: { mode: 'new' }, decision: { mode: 'new' } });

    /* 同一 worktree：首跑写入的文件在返工 Attempt 启动后仍可见。 */
    expect(readFileSync(join(worktreePath, 'src/marker.ts'), 'utf8')).toBe('export const marker = 1;\n');
    expect((query('SELECT canonical_path FROM managed_workspaces') as { canonical_path: string }).canonical_path)
      .toBe(worktreePath);
    expect((query('SELECT runtime_starts FROM execution_batches') as { runtime_starts: number }).runtime_starts).toBe(2);
    expect(query('SELECT status, code_attempts_used FROM tasks WHERE id = ?', 't-1'))
      .toMatchObject({ status: 'running', code_attempts_used: 2 });
  }, 30_000);
});
