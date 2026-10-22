import { describe, expect, it } from 'vitest';
import {
  RUNTIME_FALLBACK_SCHEMA_VERSION,
  decideRuntimeFallback,
  validateRuntimeFallbackPlan,
  type RuntimeFallbackDecision,
  type RuntimeFallbackStopDecision,
  type RuntimeFallbackSwitchDecision,
} from '../../../packages/core/src/application/runtime-fallback.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createSqliteRuntimeFallbackSwitchService } from '../../../packages/core/src/adapters/sqlite/runtime-fallback-switch.ts';
import { createWorkResourceStopVerifier } from '../../../packages/core/src/application/work-resource-stop.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteExecutionAccess } from '../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';

const preferred = { runtime: 'runtime-a', provider: 'provider-a', model: 'model-a' };
const backup = { runtime: 'runtime-b', provider: 'provider-b', model: 'model-b' };
const secondBackup = { runtime: 'runtime-c', provider: 'provider-c', model: 'model-c' };

const capabilities = createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'runtime-a', providers: [{ providerId: 'provider-a', models: ['model-a'] }] },
  { runtimeId: 'runtime-b', providers: [{ providerId: 'provider-b', models: ['model-b'] }] },
  { runtimeId: 'runtime-c', providers: [{ providerId: 'provider-c', models: ['model-c'] }] },
]);

function plan(overrides: Record<string, unknown> = {}) {
  return validateRuntimeFallbackPlan({
    schemaVersion: RUNTIME_FALLBACK_SCHEMA_VERSION,
    preferred: { strategy: preferred, source: 'task.preferred', approved: true },
    fallbacks: [
      { strategy: backup, source: 'task.fallbacks[0]', approved: true },
      { strategy: secondBackup, source: 'task.fallbacks[1]', approved: true },
    ],
    policy: {
      switchOn: ['quota_blocked', 'transient_connection', 'authentication'],
    },
    ...overrides,
  });
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    plan: plan(),
    failure: { category: 'quota_blocked', reason: 'rate_limit_exhausted' },
    nowUtcMs: 10_000,
    capabilities,
    ...overrides,
  };
}

function selected(result: RuntimeFallbackDecision): RuntimeFallbackSwitchDecision {
  expect(result.mode).toBe('switch');
  if (result.mode !== 'switch') throw new Error('expected switch decision');
  return result;
}

function stopped(result: RuntimeFallbackDecision): RuntimeFallbackStopDecision {
  expect(result.mode).toBe('stop');
  if (result.mode !== 'stop') throw new Error('expected stop decision');
  return result;
}

describe('P04-3 F-004 冻结备用链纯决策', () => {
  it('只从已冻结且已批准的有序候选中选择，并返回独立策略快照', () => {
    const result = selected(decideRuntimeFallback(input()));
    expect(result).toMatchObject({
      mode: 'switch',
      nextExecution: 'new_attempt',
      triggerCategory: 'quota_blocked',
      strategySource: 'task.fallbacks[0]',
      strategySnapshot: { ...backup },
      attemptCreated: false,
      occupancyReleased: false,
      nativeHistoryMigrated: false,
    });
    expect(result.candidateEvaluations).toHaveLength(1);
    expect(result.strategySnapshot).not.toBe(backup);
  });

  it('能力或授权失败时跳过候选，不能靠换模型绕过缺陷或未授权', () => {
    const result = selected(decideRuntimeFallback(input({
      authorization: { 'task.fallbacks[0]': 'denied' },
      capabilities: createStaticRuntimeCapabilityCatalog([
        { runtimeId: 'runtime-a', providers: [{ providerId: 'provider-a', models: ['model-a'] }] },
        { runtimeId: 'runtime-b', providers: [{ providerId: 'provider-b', models: ['other-model'] }] },
        { runtimeId: 'runtime-c', providers: [{ providerId: 'provider-c', models: ['model-c'] }] },
      ]),
    })));
    expect(result.mode).toBe('switch');
    expect(result.strategySnapshot).toEqual(secondBackup);
    expect(result.candidateEvaluations).toEqual([
      expect.objectContaining({ source: 'task.fallbacks[0]', outcome: 'unavailable', reason: 'authorization_denied' }),
      expect.objectContaining({ source: 'task.fallbacks[1]', outcome: 'selected' }),
    ]);
  });

  it.each([
    ['configuration', 'category_not_switchable'],
    ['protocol', 'category_not_switchable'],
    ['tool_failure', 'category_not_switchable'],
  ] as const)('禁止类别 %s 独立停止', (category, reason) => {
    const result = decideRuntimeFallback(input({ failure: { category, reason: 'terminal' } }));
    expect(result).toMatchObject({ mode: 'stop', stopReason: reason, triggerCategory: category });
  });

  it('限流、认证和连接故障只有显式政策允许才切换；连接未耗尽时不切换', () => {
    expect(decideRuntimeFallback(input({
      plan: plan({ policy: { switchOn: [] } }),
    }))).toMatchObject({ mode: 'stop', stopReason: 'category_not_switchable' });
    expect(stopped(decideRuntimeFallback(input({
      failure: { category: 'transient_connection', reason: 'temporary' },
      sameAttemptRetryExhausted: false,
    }))).stopReason).toBe('same_attempt_retry_not_exhausted');
    expect(decideRuntimeFallback(input({
      failure: { category: 'transient_connection', reason: 'temporary' },
      sameAttemptRetryExhausted: true,
    })).mode).toBe('switch');
  });

  it('可信恢复时间未到会跳过候选；未知时间不猜冷却窗口且记录真实请求依据', () => {
    const future = selected(decideRuntimeFallback(input({
      plan: validateRuntimeFallbackPlan({
        ...plan(),
        fallbacks: [
          { strategy: backup, source: 'task.fallbacks[0]', approved: true, trustedRecoveryAtUtcMs: 20_000 },
          { strategy: secondBackup, source: 'task.fallbacks[1]', approved: true },
        ],
      }),
    })));
    expect(future.strategySnapshot).toEqual(secondBackup);
    expect(future.candidateEvaluations[0]).toMatchObject({ reason: 'trusted_recovery_not_ready' });
    expect(future.decisionBasis.recoveryTime).toBe('trusted_time_not_reached');

    const unknown = selected(decideRuntimeFallback(input({
      trustedRecoveryAtUtcMs: null,
    })));
    expect(unknown.strategySnapshot).toEqual(backup);
    expect(unknown.decisionBasis).toMatchObject({ recoveryTime: 'unknown_real_request' });
    expect(JSON.stringify(unknown)).not.toContain('hi');
  });

  it('无候选、全链失败分别给出停止原因，且决策无执行副作用', () => {
    expect(stopped(decideRuntimeFallback(input({
      plan: validateRuntimeFallbackPlan({ ...plan(), fallbacks: [] }),
    }))).stopReason).toBe('no_candidate');
    const result = decideRuntimeFallback(input({
      authorization: { 'task.fallbacks[0]': 'denied', 'task.fallbacks[1]': 'denied' },
    }));
    expect(result).toMatchObject({ mode: 'stop', stopReason: 'all_candidates_unavailable' });
    expect(result).not.toHaveProperty('attemptId');
    expect(result).not.toHaveProperty('releaseOccupancy');
  });

  it('冻结链和策略校验拒绝未批准候选、重复候选与未知字段', () => {
    expect(() => validateRuntimeFallbackPlan({
      ...plan(),
      fallbacks: [{ strategy: backup, source: 'task.fallbacks[0]', approved: false }],
    })).toThrow();
    expect(() => validateRuntimeFallbackPlan({
      ...plan(),
      fallbacks: [
        { strategy: backup, source: 'task.fallbacks[0]', approved: true },
        { strategy: backup, source: 'task.fallbacks[1]', approved: true },
      ],
    })).toThrow();
    expect(() => validateRuntimeFallbackPlan({ ...plan(), unexpected: true })).toThrow();
    expect(() => decideRuntimeFallback(input({ authorization: { 'task.fallbacks[0]': 'unknown' } }))).toThrow();
  });

  it('未知故障类别保持未知并停止，不进入备用链', () => {
    const result = decideRuntimeFallback(input({ failure: { category: 'unknown', reason: 'unknown' } }));
    expect(result).toMatchObject({ mode: 'stop', stopReason: 'category_not_switchable', triggerCategory: 'unknown' });
  });
});

describe('P04-3 F-005 Core 备用 Runtime 切换', () => {
  it.each(['normal', 'quarantined'])('[case:fallback-slot-%s] 确认旧执行停止后创建新 Attempt、启动预占并保护重复命令，隔离槽位禁止切换', async slotState => {
    const f = await openClaimFixture();
    const stopVerifier = createWorkResourceStopVerifier({
      process: { recoverStop: async () => ({ confirmed: true }) },
      finalize: async () => true,
    });
    try {
      const old = f.store().claimTask(f.input()).receipt.attempt;
      const resources = createSqliteWorkResourceAccess(f.box.session, {
        workspaceAuthority: f.authority, stopVerifier, nowUtcMs: () => NOW,
      });
      const execution = createSqliteExecutionAccess(f.box.session, { nowUtcMs: () => NOW });
      const identity = { projectId: old.projectId, attemptId: old.id, owner: old.owner,
        hostInstanceId: old.hostInstanceId, executionVersion: old.executionVersion };
      f.box.session.transactWrite('prepare-old-runtime', () => {
        execution.reserveRuntimeStartInTransaction({ projectId: old.projectId, batchId: f.ids.batchId,
          runId: old.runId, startKey: old.id });
        resources.beginLaunchInTransaction(identity);
        resources.confirmLaunchInTransaction(identity, {
          launchId: '10000000-0000-4000-8000-000000000101', pid: 101, processGroupId: 101, startTime: 'start-101',
        });
      });
      const stopEvidence = await stopVerifier.verify(resources.read(identity));
      expect(stopEvidence).not.toBeNull();
      f.box.session.database.prepare("UPDATE attempts SET status = 'failed', ended_at = ? WHERE id = ?").run(NOW + 1, old.id);
      f.box.session.database.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(old.taskId);
      const service = createSqliteRuntimeFallbackSwitchService(f.box.session, {
        workspaceAuthority: f.authority, stopVerifier, nowUtcMs: () => NOW + 2,
      });
      const base = {
        switchKey: '10000000-0000-4000-8000-000000000102', projectId: old.projectId, runId: old.runId, taskId: old.taskId,
        oldAttempt: { attemptId: old.id, owner: old.owner, hostInstanceId: old.hostInstanceId, executionVersion: old.executionVersion },
        newOwner: 'owner-2', newHostInstanceId: 'host-2', workspace: f.workspace, leaseUntilUtcMs: NOW + 1000,
        stopEvidence, authorized: true,
        decision: { mode: 'switch' as const, triggerCategory: 'quota_blocked' as const,
          previousFailures: [{ category: 'quota_blocked' as const, reason: 'rate_limit_exhausted' }],
          strategySource: 'task.fallbacks[0]', strategySnapshot: backup },
        policyVersion: 'policy-v1', capabilityEvidence: {
          catalogDigest: 'a'.repeat(64), registryDigest: 'b'.repeat(64), authorizationDigest: 'c'.repeat(64),
        },
        inputSnapshot: f.input().inputSnapshot,
      };
      expect(() => service.switch({ ...base, authorized: false })).toThrow(/fallback_not_authorized/);
      for (const status of ['paused', 'pausing', 'cancelling', 'interrupted']) {
        f.box.session.database.prepare("UPDATE runs SET status = ?, reason = 'user_pause'").run(status);
        expect(() => service.switch(base)).toThrow(/run_not_active/);
        expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM attempts').get()).toEqual({ count: 1 });
      }
      f.box.session.database.prepare("UPDATE runs SET status = 'paused', reason = 'runtime_failed'").run();
      expect(() => service.switch({ ...base, leaseUntilUtcMs: NOW + 1 })).toThrow(/Invalid fallback lease/);
      expect(f.box.session.database.prepare('SELECT status, reason FROM runs').get())
        .toEqual({ status: 'paused', reason: 'runtime_failed' });
      if (slotState === 'quarantined') {
        f.box.session.database.prepare("UPDATE execution_slot_claims SET state = 'quarantined', reason = 'uncertain'").run();
        const before = f.snapshot();
        const slots = f.box.session.database.prepare('SELECT * FROM execution_slot_claims').all();
        const claims = f.box.session.database.prepare('SELECT * FROM run_dispatch_claims').all();
        expect(() => service.switch(base)).toThrow(expect.objectContaining({ kind: 'conflict' }));
        expect(f.snapshot()).toEqual(before);
        expect(f.box.session.database.prepare('SELECT * FROM execution_slot_claims').all()).toEqual(slots);
        expect(f.box.session.database.prepare('SELECT * FROM run_dispatch_claims').all()).toEqual(claims);
        return;
      }
      const result = service.switch(base);
      expect(result.receipt.dispatch).toMatchObject({ claimVersion: 2 });
      expect(f.box.session.database.prepare("SELECT count(*) AS n FROM execution_slot_claims WHERE state = 'held'").get()).toEqual({ n: 1 });
      expect(f.box.session.database.prepare('SELECT state, claim_version FROM run_dispatch_claims ORDER BY claim_version').all())
        .toEqual([{ state: 'released', claim_version: 1 }, { state: 'held', claim_version: 2 }]);
      const newResources = createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => NOW + 2 });
      const next = result.receipt.attempt;
      expect(f.box.session.transactWrite('test.fallback-launch', () => newResources.beginLaunchInTransaction({
        projectId: next.projectId, attemptId: next.id, owner: next.owner, hostInstanceId: next.hostInstanceId,
        executionVersion: next.executionVersion,
      })).authorized).toBe(true);
      expect(f.box.session.database.prepare('SELECT status, reason FROM runs').get())
        .toEqual({ status: 'running', reason: null });
      expect(result.disposition).toBe('applied');
      expect(result.receipt.attempt.executionVersion).toBe(old.executionVersion + 1);
      expect(f.box.session.database.prepare('SELECT attempts_created, runtime_starts FROM execution_batches').get())
        .toEqual({ attempts_created: 2, runtime_starts: 2 });
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM attempts').get()).toEqual({ count: 2 });
      expect(service.switch(base).disposition).toBe('replayed');
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM attempts').get()).toEqual({ count: 2 });
    } finally {
      f.box.close();
    }
  });

  it('全链不可用时通过 Core 原子暂停保留运行现场', async () => {
    const f = await openClaimFixture();
    try {
      const service = createSqliteRuntimeFallbackSwitchService(f.box.session, {
        workspaceAuthority: f.authority,
        stopVerifier: { inspect: () => { throw new Error('stop is not a switch'); } },
        nowUtcMs: () => NOW,
      });
      const result = service.stop({
        pause: { projectId: f.ids.projectId, targetKind: 'run', targetId: f.ids.runId, expectedRevision: 1 },
        reason: 'all_candidates_unavailable',
      });
      expect(result).toEqual({ disposition: 'stopped', paused: true, reason: 'all_candidates_unavailable' });
      expect(f.box.session.database.prepare('SELECT status FROM runs WHERE id = ?').get(f.ids.runId)).toEqual({ status: 'paused' });
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS count FROM attempts').get()).toEqual({ count: 0 });
    } finally {
      f.box.close();
    }
  });
});
