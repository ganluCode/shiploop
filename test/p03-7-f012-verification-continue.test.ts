/**
 * P03-7 / F-012：人工批准后的授权显式「验证继续」命令（task.verification.continue）。
 *
 * 聚焦验收点（FR-4）：
 * - 批准后显式继续只推进当前验证收尾（Attempt verifying → succeeded、Task passed、
 *   Run 恢复），不创建新 Attempt、不调用 Runtime（runtimeCalled=false）；
 * - 陈旧观察（observationDigest/codeDigest 漂移）与身份不一致 → conflict，要求
 *   重验/重新批准；
 * - 幂等：同 commandId 重放返回同一回执，不重复副作用；不同 commandId 的重复
 *   继续被拒绝（状态栅栏）；
 * - 授权：缺少 execution.start 能力的主体被拒绝（不泄漏存在性细节）。
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openBudgetFixture, NOW } from './helpers/p03-3/budget-fixture.ts';
import type { BudgetFixture } from './helpers/p03-3/budget-fixture.ts';
import { createCommandService } from '../packages/core/src/application/command-service.ts';
import { createExecutionPreviewService } from '../packages/core/src/application/execution-preview.ts';
import { createExecutionStartService } from '../packages/core/src/application/execution-start.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqlitePlanAccess } from '../packages/core/src/adapters/sqlite/plan-store.ts';
import { createSqliteAttemptAccess } from '../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createSqliteAttemptLifecycleStore } from '../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteVerificationStore } from '../packages/core/src/adapters/sqlite/verification-store.ts';
import { createRepositoryInspector } from '../packages/core/src/adapters/fs/repository-inspector.ts';
import { createBaselineWorkspaceReader } from '../packages/core/src/adapters/fs/baseline-workspace.ts';
import { createWorkWorkspaceAuthority } from '../packages/core/src/adapters/fs/work-workspace.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import { TRUSTED_PROJECT_PERMISSIONS_READER } from '../packages/core/src/ports/execution-input-prepare.ts';
import { createRestrictedPrincipal } from './helpers/p02-2/index.ts';
import { publishPreparedInputFixture } from './helpers/p03-4/task-dag-state-fixture.ts';
import { CODE_ATTEMPT_SETTLEMENT_PREFIX } from '../packages/core/src/ports/code-attempt-budget.ts';
import { assertVerificationReuseIdentity } from '../packages/core/src/application/task-verification-continue.ts';
import type { CommandReceipt } from '../packages/core/src/ports/commands.ts';

const CODE_DIGEST = 'cd'.repeat(32);
const OBSERVATION_DIGEST = 'ef'.repeat(32);

interface Seeded {
  readonly attemptId: string;
  readonly batchId: string;
  readonly runId: string;
  readonly executionBatchId: string;
  readonly taskRevision: number;
}

/** 种子：verifying Attempt（真实批准一致）+ passed 批次 + 预算结算 + Run 等待批准。 */
function seedApprovalWaiting(fixture: BudgetFixture): Seeded {
  const db = fixture.session.database;
  const ids = { runId: (db.prepare('SELECT id FROM runs').get() as { id: string }).id };
  const batch = db.prepare('SELECT id, config_snapshot FROM execution_batches').get() as
    { id: string; config_snapshot: string };
  const attemptId = 'attempt-continue-1';
  const batchId = 'verification-continue-1';
  /* 完整合法的准备快照（真实 ready 制品组；Attempt 行读取时 fail-closed 校验）。 */
  const snapshot = publishPreparedInputFixture(fixture, { batchId: batch.id, runId: ids.runId }, 't-1');
  db.prepare(`INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id,
    number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest,
    input_ref, diagnostic_ref, status, execution_stage, started_at, ended_at, duration_ms, exit_code, code_ref)
    VALUES (?, ?, ?, ?, ?, ?, 't-1', 1, 'owner-1', 'host-1', 1, ?, ?, ?, ?, 't-1-code',
      'verifying', 'verification', ?, NULL, 0, 0, 't-1-code')`)
    .run(attemptId, NOW, NOW, fixture.projectId, fixture.featureId, ids.runId, NOW + 1000,
      JSON.stringify(snapshot), snapshot.digests.snapshotDigest, snapshot.group.snapshot.artifactId, NOW);
  db.prepare(`UPDATE tasks SET status = 'running', execution_version = 1, attempt_counter = 1,
    code_attempts_used = 1 WHERE id = 't-1'`).run();
  const checkSnapshot = JSON.stringify([{
    checkKey: 'tests', scope: 'task', kind: 'command', argv: ['npm', 'test'],
    cwdRef: null, environmentRef: null, timeout: 60000, required: true, requirementRefs: [],
  }]);
  const selection = JSON.stringify({
    schemaVersion: 1, mode: 'candidates', reason: '固定测试选择', selectedCheckKeys: ['tests'],
  });
  db.prepare(`INSERT INTO verification_batches (id, created_at, project_id, updated_at, feature_id, run_id,
    task_id, attempt_id, execution_version, operation, code_digest, policy_digest, environment_summary,
    check_snapshot, selection, status, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, 't-1', ?, 1, 'tests', ?, ?, '{}', ?, ?,
      'passed', ?, ?)`)
    .run(batchId, NOW, fixture.projectId, NOW, fixture.featureId, ids.runId, attemptId,
      CODE_DIGEST, snapshot.approval.checkPolicyDigest, checkSnapshot, selection, NOW, NOW + 1);
  db.prepare(`INSERT INTO check_results (id, created_at, project_id, updated_at, batch_id, check_key,
    argv_json, timeout_ms, required, status, exit_code, signal, timed_out, started_at, ended_at)
    VALUES ('check-continue-1', ?, ?, ?, ?, 'tests', '["tests"]', 1000, 1, 'passed', 0, NULL, 0, ?, ?)`)
    .run(NOW, fixture.projectId, NOW, batchId, NOW, NOW + 1);
  db.prepare(`INSERT INTO task_attempt_reservations (id, created_at, project_id, revision, updated_at,
    batch_id, run_id, task_id, attempt_key, classification, classified_by, reason)
    VALUES ('reservation-continue-1', ?, ?, 1, ?, ?, ?, 't-1', ?, 'code', 'core', ?)`)
    .run(NOW, fixture.projectId, NOW, batch.id, ids.runId, attemptId,
      CODE_ATTEMPT_SETTLEMENT_PREFIX + JSON.stringify({ outcome: 'passed', observationDigest: OBSERVATION_DIGEST }));
  db.prepare(`UPDATE runs SET status = 'paused', reason = 'approval' WHERE id = ?`).run(ids.runId);
  const task = db.prepare('SELECT revision FROM tasks WHERE id = ?').get('t-1') as { revision: number };
  return { attemptId, batchId, runId: ids.runId, executionBatchId: batch.id, taskRevision: task.revision };
}

/** 带验证继续依赖的命令服务（与 budgetServices 同构 + F-012 组装）。 */
function continueCommands(fixture: BudgetFixture, evidenceGuard?: () => Promise<void>) {
  const nowUtcMs = () => NOW;
  const preview = createExecutionPreviewService({
    views: createSqlitePlanAccess(fixture.session, { nowUtcMs }),
    inspector: createRepositoryInspector(),
    workspace: createBaselineWorkspaceReader(),
    permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
    nowMs: nowUtcMs,
  });
  return createCommandService({
    atomicStore: createSqliteAtomicCommandStore(fixture.session, { nowUtcMs }),
    repositoryInspector: createRepositoryInspector(),
    capabilityCatalog: createStaticRuntimeCapabilityCatalog([
      { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }] },
    ]),
    executionPreview: preview,
    executionStart: createExecutionStartService({
      preview, permissions: TRUSTED_PROJECT_PERMISSIONS_READER, nowMs: nowUtcMs,
    }),
    executionDispatchSignal: { signalRunDispatched: () => undefined },
    nowUtcMs,
    taskVerificationContinue: {
      verifyCurrentEvidence: evidenceGuard ?? (async () => undefined),
      attempts: createSqliteAttemptAccess(fixture.session),
      verification: createSqliteVerificationStore(fixture.session, { nowUtcMs }),
      lifecycle: createSqliteAttemptLifecycleStore(fixture.session, {
        workspaceAuthority: createWorkWorkspaceAuthority({ authorizedRoots: [fixture.box.root] }),
        nowUtcMs,
      }),
    },
  });
}

function continueEnvelope(fixture: BudgetFixture, seeded: Seeded,
  overrides: Record<string, unknown> = {}, envelopeExtra: Record<string, unknown> = {}) {
  return fixture.envelope('task.verification.continue', {
    taskId: 't-1', attemptId: seeded.attemptId, verificationBatchId: seeded.batchId,
    codeDigest: CODE_DIGEST, observationDigest: OBSERVATION_DIGEST, ...overrides,
  }, { scope: fixture.scope, expectedRevision: seeded.taskRevision, ...envelopeExtra });
}

function rejectedReason(receipt: CommandReceipt): string | undefined {
  if (receipt.status !== 'rejected') throw new Error(`expected rejected, got ${JSON.stringify(receipt)}`);
  return (receipt.error.details as { reason?: string } | undefined)?.reason;
}

/** continue 的 PublicError 直接抛出（不经 rejected 回执）；断言冲突原因。 */
async function expectConflict(run: Promise<unknown>, reason: string, label: string) {
  try {
    await run;
  } catch (error) {
    const err = error as { code?: string; details?: { reason?: string } };
    expect(err.code, label).toBe('conflict');
    expect(err.details?.reason, label).toBe(reason);
    return;
  }
  throw new Error(`预期冲突（${label}: ${reason}），实际成功`);
}

const currentTaskRevision = (fixture: BudgetFixture) =>
  (fixture.session.database.prepare('SELECT revision FROM tasks WHERE id = ?').get('t-1') as { revision: number }).revision;

describe('F-012 task.verification.continue 授权显式继续', () => {
  it('当前代码/环境必须可证：漂移、缺失和未知环境均拒绝复用', () => {
    const saved = { codeDigest: CODE_DIGEST,
      environmentSummary: { runner: 'node', nodeVersion: process.version, platform: process.platform } };
    expect(() => assertVerificationReuseIdentity(saved, CODE_DIGEST)).not.toThrow();
    expect(() => assertVerificationReuseIdentity(saved, null)).toThrow();
    expect(() => assertVerificationReuseIdentity(saved, 'ab'.repeat(32))).toThrow();
    for (const environmentSummary of [{}, { ...saved.environmentSummary, nodeVersion: 'v0' },
      { ...saved.environmentSummary, platform: 'unknown' }, { ...saved.environmentSummary, toolchain: 'unverified' }]) {
      expect(() => assertVerificationReuseIdentity({ ...saved, environmentSummary }, CODE_DIGEST)).toThrow();
    }
  });

  it('现场或证据变化时拒绝继续，检查在写事务外且不修改已保存状态', async () => {
    const fixture = await openBudgetFixture();
    try {
      await fixture.start();
      const seeded = seedApprovalWaiting(fixture);
      let calls = 0;
      const commands = continueCommands(fixture, async () => {
        calls++;
        expect(fixture.session.database.inTransaction).toBe(false);
        const { PublicError } = await import('../packages/core/src/ports/commands.ts');
        throw new PublicError('conflict', 'task.verification.continue', undefined,
          { details: { reason: 'verification_evidence_stale' } });
      });
      await expectConflict(commands.submit(fixture.owner, continueEnvelope(fixture, seeded) as never),
        'verification_evidence_stale', '现场重核');
      expect(calls).toBe(1);
      expect(fixture.session.database.prepare('SELECT status FROM attempts WHERE id = ?').get(seeded.attemptId))
        .toEqual({ status: 'verifying' });
    } finally { fixture.close(); }
  });

  it('验证收尾成功不能覆盖已经请求的 Run 暂停', async () => {
    const fixture = await openBudgetFixture();
    try {
      await fixture.start();
      const seeded = seedApprovalWaiting(fixture);
      fixture.session.database.prepare("UPDATE runs SET status = 'pausing', reason = 'user_pause' WHERE id = ?")
        .run(seeded.runId);
      await continueCommands(fixture).submit(fixture.owner, continueEnvelope(fixture, seeded) as never);
      expect(fixture.session.database.prepare('SELECT status, reason FROM runs WHERE id = ?').get(seeded.runId))
        .toEqual({ status: 'pausing', reason: 'user_pause' });
    } finally { fixture.close(); }
  });

  it('批准后显式继续只推进验证收尾：不创建 Attempt、不调用 Runtime、Run 恢复', async () => {
    const fixture = await openBudgetFixture();
    try {
      await fixture.start();
      const seeded = seedApprovalWaiting(fixture);
      const commands = continueCommands(fixture);
      const before = {
        attempts: (fixture.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n,
        starts: (fixture.session.database.prepare('SELECT COUNT(*) AS n FROM runtime_start_reservations').get() as { n: number }).n,
      };

      const receipt = await commands.submit(fixture.owner, continueEnvelope(fixture, seeded) as never);

      expect(receipt.status).toBe('completed');
      const result = (receipt as { status: 'completed'; result: Record<string, unknown> }).result;
      expect(result).toMatchObject({
        taskId: 't-1', attemptId: seeded.attemptId, verificationBatchId: seeded.batchId,
        disposition: 'applied', status: 'succeeded', runtimeCalled: false, executionStarted: false,
      });
      expect(fixture.session.database.prepare('SELECT status FROM attempts WHERE id = ?').get(seeded.attemptId))
        .toEqual({ status: 'succeeded' });
      expect(fixture.session.database.prepare('SELECT status FROM tasks WHERE id = ?').get('t-1'))
        .toEqual({ status: 'passed' });
      expect(fixture.session.database.prepare('SELECT status, reason FROM runs WHERE id = ?').get(seeded.runId))
        .toEqual({ status: 'running', reason: null });
      /* 无重复副作用：不新增 Attempt、不预占 Runtime 启动。 */
      expect((fixture.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n)
        .toBe(before.attempts);
      expect((fixture.session.database.prepare('SELECT COUNT(*) AS n FROM runtime_start_reservations').get() as { n: number }).n)
        .toBe(before.starts);
    } finally { fixture.close(); }
  });

  it('幂等：同 commandId 重放返回同一回执；不同 commandId 的重复继续被状态栅栏拒绝', async () => {
    const fixture = await openBudgetFixture();
    try {
      await fixture.start();
      const seeded = seedApprovalWaiting(fixture);
      const commands = continueCommands(fixture);
      const envelope = continueEnvelope(fixture, seeded);
      const first = await commands.submit(fixture.owner, envelope as never);
      expect(first.status).toBe('completed');
      /* 同 commandId 重放：回执一致，状态不二次推进。 */
      const replayed = await commands.submit(fixture.owner, envelope as never);
      expect(replayed.status).toBe('completed');
      expect((replayed as { commandId: string }).commandId).toBe(envelope.commandId);
      expect(fixture.session.database.prepare('SELECT status FROM tasks WHERE id = ?').get('t-1'))
        .toEqual({ status: 'passed' });
      /* 不同 commandId 的重复继续：Attempt 已脱离 verifying，conflict 拒绝。 */
      await expectConflict(
        commands.submit(fixture.owner, continueEnvelope(fixture, { ...seeded, taskRevision: currentTaskRevision(fixture) },
          {}, { commandId: randomUUID() }) as never),
        'attempt_not_awaiting_verification_release', '重复继续');
      expect(fixture.session.database.prepare('SELECT status FROM tasks WHERE id = ?').get('t-1'))
        .toEqual({ status: 'passed' });
    } finally { fixture.close(); }
  });

  it('陈旧观察与身份漂移拒绝：observationDigest/codeDigest/批次身份不一致均 conflict', async () => {
    const fixture = await openBudgetFixture();
    try {
      await fixture.start();
      const seeded = seedApprovalWaiting(fixture);
      const commands = continueCommands(fixture);
      const cases: { name: string; overrides: Record<string, unknown>; reason: string }[] = [
        { name: '陈旧观察摘要', overrides: { observationDigest: 'ab'.repeat(32) }, reason: 'observation_digest_mismatch' },
        { name: '代码摘要漂移', overrides: { codeDigest: 'ab'.repeat(32) }, reason: 'verification_batch_identity_mismatch' },
        { name: '批次 Attempt 身份错误', overrides: { attemptId: 'attempt-other' }, reason: 'not_found' },
        { name: '陈旧 Task 修订', overrides: {}, reason: 'task_revision_conflict' },
      ];
      for (const entry of cases) {
        const extra = entry.name === '陈旧 Task 修订' ? { expectedRevision: 99 } : {};
        if (entry.reason === 'not_found') {
          await expect(
            commands.submit(fixture.owner, continueEnvelope(fixture, seeded, entry.overrides, extra) as never),
          ).rejects.toThrow(/not.found|不存在|Attempt/i);
          continue;
        }
        await expectConflict(
          commands.submit(fixture.owner, continueEnvelope(fixture, seeded, entry.overrides, extra) as never),
          entry.reason, entry.name);
      }
      /* 全部拒绝无状态推进。 */
      expect(fixture.session.database.prepare('SELECT status FROM tasks WHERE id = ?').get('t-1'))
        .toEqual({ status: 'running' });
      expect(fixture.session.database.prepare('SELECT status FROM attempts WHERE id = ?').get(seeded.attemptId))
        .toEqual({ status: 'verifying' });
    } finally { fixture.close(); }
  });

  it('人工阻塞未解除时继续被忽略（不解除阻塞、不放行）', async () => {
    const fixture = await openBudgetFixture();
    try {
      await fixture.start();
      const seeded = seedApprovalWaiting(fixture);
      const commands = continueCommands(fixture);
      fixture.session.database.prepare(`UPDATE tasks SET manual_block = 1 WHERE id = 't-1'`).run();

      const receipt = await commands.submit(fixture.owner, continueEnvelope(fixture, seeded) as never);

      expect(receipt.status).toBe('completed');
      const result = (receipt as { status: 'completed'; result: Record<string, unknown> }).result;
      /* 预算结算已在第一次提交幂等记录：同观察重放被吸收（replayed），保持等待。 */
      expect(result).toMatchObject({ disposition: 'replayed', status: 'verifying', waitingFor: 'approval' });
      expect(fixture.session.database.prepare('SELECT status, manual_block FROM tasks WHERE id = ?').get('t-1'))
        .toEqual({ status: 'running', manual_block: 1 });
      expect(fixture.session.database.prepare('SELECT status FROM attempts WHERE id = ?').get(seeded.attemptId))
        .toEqual({ status: 'verifying' });
    } finally { fixture.close(); }
  });

  it('缺少 execution.start 能力的主体被拒绝', async () => {
    const fixture = await openBudgetFixture();
    try {
      await fixture.start();
      const seeded = seedApprovalWaiting(fixture);
      const commands = continueCommands(fixture);
      const restricted = createRestrictedPrincipal({ capabilities: ['project.read'], projectScope: { kind: 'all' } });

      await expect(commands.submit(restricted, continueEnvelope(fixture, seeded) as never))
        .rejects.toThrow(/forbidden|授权被拒绝/);
      expect(fixture.session.database.prepare('SELECT status FROM attempts WHERE id = ?').get(seeded.attemptId))
        .toEqual({ status: 'verifying' });
    } finally { fixture.close(); }
  });
});
