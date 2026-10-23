/**
 * P05-1 / F-003 一次性规划启动命令（planning.start）：定向启动与命令竞争测试。
 *
 * 覆盖（对应验收标准 1–5）：
 * - 草稿 Feature 首次规划：不需要已批准编码计划；accepted v7 回执携带
 *   batchId/runId/planningTaskId/candidateId；同事务原子写入单 Feature Batch、
 *   purpose=plan Run、planning Task/上下文、初始预算行、派发意图、事件与回执；
 *   不启动模型（runtime_starts=0、planning Task 恒 pending）；
 * - 幂等与竞争：同 commandId 同摘要重放复用原身份零额外消耗；同 commandId 异
 *   内容 conflict；同项目活动规划/编码（含 paused/interrupted 未确认停止）明确
 *   阻塞；旧 CAS/过期命令/失效输入/跨项目越权/终态 Feature 结构化拒绝；
 * - 预算：默认 maxRuns=1（提案超出拒绝）；deadline 已过拒绝；
 * - 派发：未装配唤醒端口时 Run 保留 queued + scheduler_not_assembled 可查询；
 *   唤醒抛错不回滚持久意图；业务/派发/回执写入注入失败整组回滚；
 * - 重开数据库后回执可重放（v7 持久往返）。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import { createPlanningStartService } from '../../../packages/core/src/application/planning-start.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { openSqliteStorageSession, type SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { EXECUTION_RUN_NOT_READY_REASON } from '../../../packages/core/src/ports/execution-start.ts';
import { PLANNING_RUN_PURPOSE, PLANNING_TASK_KIND } from '../../../packages/core/src/ports/planning-candidates.ts';
import { PLANNING_START_OPERATION } from '../../../packages/core/src/ports/planning-start.ts';
import { PublicError } from '../../../packages/core/src/ports/commands.ts';
import type { CommandReceipt, PlanningAcceptedCommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from '../../helpers/p02-2/index.ts';

const NOW = 1_900_100_000_000;
const PLANNING_BUDGET = {
  batch: {
    maxRuns: 1, maxTotalAttempts: 1, maxRuntimeStarts: 1, maxNoProgressRuns: 1,
    deadlineUtcMs: NOW + 3_600_000,
  },
  run: { maxAttemptsPerRun: 1, runTimeLimitMs: 3_600_000 },
};

interface PlanningFixture {
  readonly box: CommandsTestFixture;
  readonly projectId: string;
  readonly featureId: string;
  readonly featureRevision: number;
  readonly owner: ReturnType<typeof createLocalOwnerPrincipal>;
  readonly scope: { kind: 'project'; projectId: string };
  payload(overrides?: Record<string, unknown>): Record<string, unknown>;
  envelope(overrides?: Record<string, unknown>): Record<string, unknown>;
  submit(payloadOverrides?: Record<string, unknown>, envelopeOverrides?: Record<string, unknown>): Promise<CommandReceipt>;
  reopen(): void;
  close(): void;
  get session(): SqliteStorageSession;
  signals: { projectId: string; batchId: string; runId: string; featureId: string }[];
  setDispatchSignalMode(mode: 'record' | 'throw' | 'none'): void;
}

function servicesFor(session: SqliteStorageSession, fixture: { signals: unknown[]; dispatchSignalMode: { value: 'record' | 'throw' | 'none' } }) {
  const nowUtcMs = () => NOW;
  const planningStart = createPlanningStartService({ nowMs: nowUtcMs });
  return createCommandService({
    atomicStore: createSqliteAtomicCommandStore(session, { nowUtcMs }),
    repositoryInspector: createRepositoryInspector(),
    capabilityCatalog: createStaticRuntimeCapabilityCatalog([
      { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet', 'claude-sonnet-2'] }] },
    ]),
    planningStart,
    executionDispatchSignal: fixture.dispatchSignalMode.value === 'none' ? undefined : {
      signalRunDispatched: (input: unknown) => {
        if (fixture.dispatchSignalMode.value === 'throw') throw new Error('injected dispatch signal failure');
        fixture.signals.push(input);
      },
    },
    nowUtcMs,
  });
}

async function openPlanningFixture(): Promise<PlanningFixture> {
  const box = createCommandsTestFixture({ prefix: 'shiploop-p051-f003-' });
  try {
    const harness = await box.openTransactionalHarness();
    let session = harness.session;
    const signals: unknown[] = [];
    const dispatchSignalMode = { value: 'record' as 'record' | 'throw' | 'none' };
    let commands = servicesFor(session, { signals, dispatchSignalMode });
    const owner = createLocalOwnerPrincipal();
    const envelope = (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
      schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(NOW).toISOString(),
      operation, payload, ...extra,
    });
    const requireCompleted = async (promise: Promise<CommandReceipt>): Promise<unknown> => {
      const receipt = await promise;
      if (receipt.status !== 'completed') throw new Error(`fixture command failed: ${JSON.stringify(receipt)}`);
      return receipt.result;
    };
    const submitSetup = (operation: string, payload: unknown, extra: Record<string, unknown> = {}) =>
      commands.submit(owner, envelope(operation, payload, extra));
    const registered = await requireCompleted(submitSetup('project.register', {
      repositoryPath: box.repoDirA, displayName: 'P05-1 F-003', description: null, labels: [],
    }, { scope: { kind: 'registration' } })) as { project: { id: string } };
    const projectId = registered.project.id;
    const scope = { kind: 'project' as const, projectId };
    await requireCompleted(submitSetup('settings.global.create', {
      schemaVersion: 2, strategies: {
        defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
        purposeStrategies: { planner: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } },
      },
    }, { scope: { kind: 'global' } }));
    await requireCompleted(submitSetup('phase.create', { id: 'phase-1', title: 'P05-1', description: null, labels: [] }, { scope }));
    const imported = await requireCompleted(submitSetup('feature.plan.import', {
      phaseId: 'phase-1', plan: {
        schemaVersion: 1,
        feature: { title: '规划目标 Feature', description: null, labels: [], sourceRefs: [] },
        tasks: [{ id: 't-1', title: '既有草稿任务', acceptance: { criteria: ['草稿可规划'] }, dependsOn: [] }],
      },
    }, { scope, expectedRevision: 1 })) as { feature: { id: string; revision: number } };
    const featureId = imported.feature.id;
    const featureRow = session.database.prepare('SELECT revision FROM features WHERE id = ?').get(featureId) as { revision: number };

    const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      schemaVersion: 1,
      projectId,
      phaseId: 'phase-1',
      featureId,
      requirementRefs: [],
      constraints: ['不改变既有公开接口'],
      acceptance: { criteria: ['候选包含 Task 拆分与验收'] },
      strategy: { approvalMode: 'manual', taskLimit: null },
      budget: { ...PLANNING_BUDGET, batch: { ...PLANNING_BUDGET.batch }, run: { ...PLANNING_BUDGET.run } },
      ...overrides,
    });
    const startEnvelope = (envelopeOverrides: Record<string, unknown> = {}) => ({
      ...envelope(PLANNING_START_OPERATION, payload(), { scope, expectedRevision: featureRow.revision }),
      ...envelopeOverrides,
    });

    return {
      box, projectId, featureId, featureRevision: featureRow.revision, owner, scope,
      payload,
      envelope: startEnvelope,
      async submit(payloadOverrides = {}, envelopeOverrides = {}) {
        return commands.submit(owner, {
          ...startEnvelope(envelopeOverrides),
          payload: payload(payloadOverrides),
        });
      },
      reopen() {
        session.close();
        session = openSqliteStorageSession({ path: box.dbPath });
        commands = servicesFor(session, { signals, dispatchSignalMode });
      },
      close() { session.close(); box.cleanup(); },
      get session() { return session; },
      signals: signals as PlanningFixture['signals'],
      setDispatchSignalMode(mode) {
        dispatchSignalMode.value = mode;
        // 唤醒端口是否装配在服务创建时固化：模式变更后重建命令服务，使
        // schedulerAssembled 判定与真实装配一致。
        commands = servicesFor(session, { signals, dispatchSignalMode });
      },
    };
  } catch (error) {
    box.cleanup();
    throw error;
  }
}

function expectPublicError(error: unknown, code: string, reason?: string): void {
  expect(error).toBeInstanceOf(PublicError);
  const publicError = error as PublicError;
  expect(publicError.code).toBe(code);
  if (reason !== undefined) {
    expect((publicError.details as Record<string, unknown> | undefined)?.reason).toBe(reason);
  }
}

function rowCounts(db: SqliteStorageSession['database']): Record<string, number> {
  return Object.fromEntries([
    'execution_batches', 'runs', 'batch_budget_revisions', 'run_dispatch_intents',
    'planning_contexts', 'tasks', 'command_receipts', 'state_events', 'attempts',
  ].map((table) => [table, (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]));
}

describe('P05-1 / F-003 一次性规划启动命令', () => {
  it('[case:planning-start-accepts-draft-feature] 草稿 Feature 首次规划：accepted v7 回执 + 同事务原子写入全部事实', async () => {
    const fixture = await openPlanningFixture();
    try {
      const receipt = await fixture.submit();
      expect(receipt.status).toBe('accepted');
      expect(receipt.schemaVersion).toBe(7);
      expect(receipt.operation).toBe(PLANNING_START_OPERATION);
      const accepted = receipt as PlanningAcceptedCommandReceipt;
      expect(accepted.operationId).toBe(accepted.batchId);
      const db = fixture.session.database;
      const batch = db.prepare('SELECT * FROM execution_batches WHERE id = ?').get(accepted.batchId) as Record<string, unknown>;
      expect(batch).toMatchObject({ project_id: fixture.projectId, phase_id: 'phase-1', feature_id: fixture.featureId, status: 'queued', runs_created: 1, runtime_starts: 0, reason: null });
      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(accepted.runId) as Record<string, unknown>;
      expect(run).toMatchObject({ project_id: fixture.projectId, batch_id: accepted.batchId, feature_id: fixture.featureId, purpose: PLANNING_RUN_PURPOSE, status: 'queued', dispatch_ordinal: 1 });
      const context = db.prepare('SELECT * FROM planning_contexts WHERE candidate_id = ?').get(accepted.candidateId) as Record<string, unknown>;
      expect(context).toMatchObject({ project_id: fixture.projectId, phase_id: 'phase-1', feature_id: fixture.featureId, run_id: accepted.runId, planning_task_id: accepted.planningTaskId, status: 'open', decision: null, candidate_digest: null });
      const planningTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(accepted.planningTaskId) as Record<string, unknown>;
      expect(planningTask).toMatchObject({ kind: PLANNING_TASK_KIND, status: 'pending', config_source: 'global_default' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM batch_budget_revisions WHERE batch_id = ? AND version = 1 AND reason = ?').get(accepted.batchId, 'initial_authorization')).toEqual({ n: 1 });
      const intent = db.prepare('SELECT * FROM run_dispatch_intents WHERE run_id = ?').get(accepted.runId) as Record<string, unknown>;
      expect(intent).toMatchObject({ project_id: fixture.projectId, batch_id: accepted.batchId, source: 'start' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM command_receipts WHERE receipt_version = 7 AND candidate_id = ?').get(accepted.candidateId)).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM state_events WHERE event_type = 'execution.run.dispatched' AND aggregate_id = ?").get(accepted.runId)).toEqual({ n: 1 });
      // 不借用编码审批、不启动模型、不改计划实体。
      expect(db.prepare('SELECT plan_status, revision FROM features WHERE id = ?').get(fixture.featureId)).toMatchObject({ plan_status: 'draft', revision: fixture.featureRevision });
      expect(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
      expect(batch.runtime_starts).toBe(0);
      // 唤醒信号已发出一次（携带真实身份）。
      expect(fixture.signals).toEqual([{ projectId: fixture.projectId, batchId: accepted.batchId, runId: accepted.runId, featureId: fixture.featureId }]);
    } finally { fixture.close(); }
  });

  it('[case:planning-start-replay-idempotent] 同 commandId 同摘要重放返回原身份，零额外额度消耗与派发', async () => {
    const fixture = await openPlanningFixture();
    try {
      const first = await fixture.submit();
      const counts = rowCounts(fixture.session.database);
      const signals = fixture.signals.length;
      const commandId = (first as PlanningAcceptedCommandReceipt).commandId;
      const replayed = await fixture.submit({}, { commandId });
      expect(replayed).toMatchObject({ ...first, replayed: true });
      expect(rowCounts(fixture.session.database)).toEqual(counts);
      expect(fixture.signals).toHaveLength(signals);
    } finally { fixture.close(); }
  });

  it('[case:planning-start-command-reuse-conflict] 同 commandId 不同内容返回 conflict，零写入', async () => {
    const fixture = await openPlanningFixture();
    try {
      const first = await fixture.submit();
      const commandId = (first as PlanningAcceptedCommandReceipt).commandId;
      const counts = rowCounts(fixture.session.database);
      await expect(fixture.submit({ constraints: ['不同的约束内容'] }, { commandId })).rejects.toSatisfy(
        (error: unknown) => { expectPublicError(error, 'conflict', 'idempotency_key_reuse'); return true; },
      );
      expect(rowCounts(fixture.session.database)).toEqual(counts);
    } finally { fixture.close(); }
  });

  it('[case:planning-start-reopen-replay] 重开数据库后同 commandId 重放返回持久 v7 回执', async () => {
    const fixture = await openPlanningFixture();
    try {
      const first = await fixture.submit();
      const commandId = (first as PlanningAcceptedCommandReceipt).commandId;
      const counts = rowCounts(fixture.session.database);
      fixture.reopen();
      const replayed = await fixture.submit({}, { commandId });
      expect(replayed).toMatchObject({ ...first, replayed: true });
      expect(rowCounts(fixture.session.database)).toEqual(counts);
    } finally { fixture.close(); }
  });

  it('[case:planning-start-blocked-by-active-execution] 同项目活动编码 Run（含 paused/interrupted）明确阻塞且零写入', async () => {
    const fixture = await openPlanningFixture();
    try {
      const db = fixture.session.database;
      const insertActiveRun = (status: string, purpose: string): void => {
        const batchId = randomUUID();
        db.prepare(
          "INSERT INTO execution_batches (id, created_at, project_id, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, deadline_at, runs_created) VALUES (?, ?, ?, ?, 'phase-1', ?, ?, ?, ?, 1, ?, ?, 1)",
        ).run(batchId, NOW, fixture.projectId, NOW, fixture.featureId,
          JSON.stringify({ schemaVersion: 1, featureIds: [fixture.featureId] }), JSON.stringify({ schemaVersion: 1 }), status,
          JSON.stringify({ schemaVersion: 1, batch: { maxRuns: 2, maxTotalAttempts: 2, maxRuntimeStarts: 2, maxNoProgressRuns: 2, deadlineUtcMs: NOW + 1000 }, run: { maxAttemptsPerRun: 1, runTimeLimitMs: 1000 } }), NOW + 1000);
        db.prepare(
          "INSERT INTO runs (id, created_at, project_id, updated_at, batch_id, feature_id, purpose, input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, run_time_limit_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 3600000)",
        ).run(randomUUID(), NOW, fixture.projectId, NOW, batchId, fixture.featureId, purpose,
          JSON.stringify({ schemaVersion: 1 }), JSON.stringify({ schemaVersion: 1 }), status, 'ab'.repeat(32), `work-${batchId}`);
      };
      for (const [status, purpose] of [['running', 'execute'], ['paused', 'execute'], ['interrupted', 'execute']] as const) {
        const counts = rowCounts(db);
        insertActiveRun(status, purpose);
        await expect(fixture.submit()).rejects.toSatisfy((error: unknown) => {
          expectPublicError(error, 'conflict', 'execution_in_progress');
          return true;
        });
        // 拒绝是抛出型（零回执零创建）：只保留注入的活动 Run 及其 Batch。
        const after = rowCounts(db);
        expect(after.command_receipts).toBe(counts.command_receipts);
        expect(after.planning_contexts).toBe(counts.planning_contexts);
        expect(after.runs).toBe(counts.runs + 1);
        db.prepare('DELETE FROM runs WHERE purpose = ? AND status = ?').run(purpose, status);
        db.prepare('DELETE FROM execution_batches WHERE id NOT IN (SELECT batch_id FROM runs)').run();
      }
    } finally { fixture.close(); }
  });

  it('[case:planning-vs-planning-competition] 同项目活动规划阻塞第二次规划（不自动重复规划）', async () => {
    const fixture = await openPlanningFixture();
    try {
      const first = await fixture.submit();
      const counts = rowCounts(fixture.session.database);
      // 活动 plan Run 在项目 Work 门控上直接冲突（同 Feature 或同项目均阻塞）。
      await expect(fixture.submit()).rejects.toSatisfy((error: unknown) => {
        expectPublicError(error, 'conflict', 'execution_in_progress');
        return true;
      });
      expect(rowCounts(fixture.session.database)).toEqual(counts);
      // Run 与 Batch 均置终态但规划上下文仍 open：二次规划由活动规划上下文明确阻塞。
      fixture.session.database.prepare("UPDATE runs SET status = 'failed'").run();
      fixture.session.database.prepare("UPDATE execution_batches SET status = 'failed'").run();
      await expect(fixture.submit()).rejects.toSatisfy((error: unknown) => {
        expectPublicError(error, 'conflict', 'planning_in_progress');
        return true;
      });
      expect(rowCounts(fixture.session.database)).toEqual(counts);
      expect((first as PlanningAcceptedCommandReceipt).batchId).toBeTruthy();
    } finally { fixture.close(); }
  });

  it('[case:planning-start-stale-cas] 旧 CAS：expectedRevision 漂移固化 rejected 回执且零创建', async () => {
    const fixture = await openPlanningFixture();
    try {
      const receipt = await fixture.submit({}, { expectedRevision: fixture.featureRevision + 5 });
      expect(receipt.status).toBe('rejected');
      const error = (receipt as { error: { code: string; details: Record<string, unknown> } }).error;
      expect(error.details).toMatchObject({ reason: 'conflict', expectedRevision: fixture.featureRevision + 5, actualRevision: fixture.featureRevision });
      const counts = rowCounts(fixture.session.database);
      expect(counts.execution_batches).toBe(0);
      expect(counts.runs).toBe(0);
      expect(counts.planning_contexts).toBe(0);
      expect(counts.run_dispatch_intents).toBe(0);
      expect(counts.command_receipts).toBeGreaterThan(0);
    } finally { fixture.close(); }
  });

  it('[case:planning-start-expired-command] 过期命令：command_expired 且不落回执', async () => {
    const fixture = await openPlanningFixture();
    try {
      const counts = rowCounts(fixture.session.database);
      await expect(fixture.submit({}, { issuedAt: new Date(NOW - 4 * 60 * 1000).toISOString(), expiresAt: new Date(NOW - 1000).toISOString() })).rejects.toSatisfy(
        (error: unknown) => { expectPublicError(error, 'command_expired'); return true; },
      );
      expect(rowCounts(fixture.session.database)).toEqual(counts);
    } finally { fixture.close(); }
  });

  it('[case:planning-start-invalid-input] 失效输入：未知键/项目不匹配/预算越界/最大 Run 数/deadline 已过结构化拒绝', async () => {
    const fixture = await openPlanningFixture();
    try {
      const counts = rowCounts(fixture.session.database);
      await expect(fixture.submit({ unexpectedKey: true })).rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'invalid_input'); return true; });
      await expect(fixture.submit({ projectId: randomUUID() })).rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'invalid_input', 'project_mismatch'); return true; });
      await expect(fixture.submit({ strategy: { approvalMode: 'auto', taskLimit: null } })).rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'invalid_input'); return true; });
      await expect(fixture.submit({
        budget: { ...PLANNING_BUDGET, batch: { ...PLANNING_BUDGET.batch, maxRuns: 2, maxTotalAttempts: 2, maxRuntimeStarts: 2, maxNoProgressRuns: 2 } },
      })).rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'invalid_input', 'planning_max_runs_fixed'); return true; });
      await expect(fixture.submit({
        budget: { ...PLANNING_BUDGET, batch: { ...PLANNING_BUDGET.batch, deadlineUtcMs: NOW - 1 } },
      })).rejects.toSatisfy((error: unknown) => { expectPublicError(error, 'invalid_input', 'invalid_budget'); return true; });
      expect(rowCounts(fixture.session.database)).toEqual(counts);
    } finally { fixture.close(); }
  });

  it('[case:planning-start-cross-project-unauthorized] 跨项目/越权：不可见项目与跨项目 Feature 引用被拒绝', async () => {
    const fixture = await openPlanningFixture();
    try {
      const counts = rowCounts(fixture.session.database);
      const strangerProjectId = randomUUID();
      const strangerScope = { kind: 'project' as const, projectId: strangerProjectId };
      // scope 与负载指向同一不存在的项目：项目可见性把关（不泄漏存在性）。
      await expect(fixture.submit({ projectId: strangerProjectId }, { scope: strangerScope })).rejects.toSatisfy((error: unknown) => {
        expect(['not_found', 'forbidden']).toContain((error as PublicError).code);
        return true;
      });
      // scope 指向本项目但请求负载指向其他 Feature（同库不存在）→ 拒绝。
      await expect(fixture.submit({ featureId: 'feat-other-project' })).rejects.toBeInstanceOf(PublicError);
      // 负载项目与 scope 项目不一致：结构化拒绝。
      await expect(fixture.submit({ projectId: randomUUID() })).rejects.toSatisfy((error: unknown) => {
        expectPublicError(error, 'invalid_input', 'project_mismatch');
        return true;
      });
      expect(rowCounts(fixture.session.database)).toEqual(counts);
    } finally { fixture.close(); }
  });

  it('[case:planning-start-invalid-requirement-ref] 失效输入：需求制品缺失/未就绪明确失败', async () => {
    const fixture = await openPlanningFixture();
    try {
      const counts = rowCounts(fixture.session.database);
      await expect(fixture.submit({ requirementRefs: [{ artifactId: 'art-missing' }] })).rejects.toSatisfy((error: unknown) => {
        expect(['not_found', 'forbidden', 'conflict']).toContain((error as PublicError).code);
        return true;
      });
      expect(rowCounts(fixture.session.database)).toEqual(counts);
    } finally { fixture.close(); }
  });

  it('[case:planning-start-terminal-feature-blocked] 终态 Feature 不满足安全重规划条件', async () => {
    const fixture = await openPlanningFixture();
    try {
      const db = fixture.session.database;
      const revision = fixture.featureRevision + 1;
      db.prepare("UPDATE features SET status = 'completed', revision = ? WHERE id = ?").run(revision, fixture.featureId);
      const receipt = await fixture.submit({}, { expectedRevision: revision });
      expect(receipt.status).toBe('rejected');
      expect((receipt as { error: { details: Record<string, unknown> } }).error.details.reason).toBe('feature_terminal');
      const counts = rowCounts(db);
      expect(counts.execution_batches).toBe(0);
      expect(counts.planning_contexts).toBe(0);
    } finally { fixture.close(); }
  });

  it('[case:planning-start-unconfigured-runtime-queued] 未配置 Runtime：Run 保留 queued + 可查询排队原因，accepted 不是规划完成', async () => {
    const fixture = await openPlanningFixture();
    try {
      fixture.setDispatchSignalMode('none');
      const receipt = await fixture.submit();
      expect(receipt.status).toBe('accepted');
      const accepted = receipt as PlanningAcceptedCommandReceipt;
      const db = fixture.session.database;
      const run = db.prepare('SELECT status, reason FROM runs WHERE id = ?').get(accepted.runId) as { status: string; reason: string | null };
      expect(run).toEqual({ status: 'queued', reason: EXECUTION_RUN_NOT_READY_REASON });
      const intent = db.prepare('SELECT reason FROM run_dispatch_intents WHERE run_id = ?').get(accepted.runId) as { reason: string | null };
      expect(intent.reason).toBe(EXECUTION_RUN_NOT_READY_REASON);
      // accepted 不代表规划完成：planning Task 仍 pending，上下文仍 open。
      expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get(accepted.planningTaskId)).toEqual({ status: 'pending' });
      expect(db.prepare('SELECT status FROM planning_contexts WHERE candidate_id = ?').get(accepted.candidateId)).toEqual({ status: 'open' });
      expect(fixture.signals).toHaveLength(0);
    } finally { fixture.close(); }
  });

  it('[case:planning-start-signal-loss-keeps-intent] 唤醒丢失/抛错不回滚已提交的持久意图', async () => {
    const fixture = await openPlanningFixture();
    try {
      fixture.setDispatchSignalMode('throw');
      const receipt = await fixture.submit();
      expect(receipt.status).toBe('accepted');
      const accepted = receipt as PlanningAcceptedCommandReceipt;
      const db = fixture.session.database;
      expect(db.prepare('SELECT COUNT(*) AS n FROM run_dispatch_intents WHERE run_id = ?').get(accepted.runId)).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM planning_contexts WHERE candidate_id = ?').get(accepted.candidateId)).toEqual({ n: 1 });
    } finally { fixture.close(); }
  });

  it('[case:planning-start-atomic-rollback] 业务/派发/回执写入注入失败时整组回滚', async () => {
    const fixture = await openPlanningFixture();
    try {
      const db = fixture.session.database;
      const before = rowCounts(db);
      const faultTables = ['tasks', 'planning_contexts', 'run_dispatch_intents', 'command_receipts'];
      for (const table of faultTables) {
        const triggerName = `f003_fault_${table}`;
        db.exec(`CREATE TEMP TRIGGER ${triggerName} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'p02-2 injected fault: ${table}_before_insert'); END`);
        try {
          await expect(fixture.submit()).rejects.toBeInstanceOf(Error);
          expect(rowCounts(db)).toEqual(before);
        } finally {
          db.exec(`DROP TRIGGER ${triggerName}`);
        }
      }
      // 触发器移除后同一命令可正常提交（失败未留下半条记录或幂等残留）。
      const receipt = await fixture.submit();
      expect(receipt.status).toBe('accepted');
    } finally { fixture.close(); }
  });

  it('[case:planning-start-maxruns-one-and-no-refund-shape] 单次规划固定 maxRuns=1：Batch 预算快照冻结 maxRuns=1', async () => {
    const fixture = await openPlanningFixture();
    try {
      const receipt = await fixture.submit();
      const accepted = receipt as PlanningAcceptedCommandReceipt;
      const batch = fixture.session.database.prepare('SELECT budget_snapshot, runs_created FROM execution_batches WHERE id = ?').get(accepted.batchId) as { budget_snapshot: string; runs_created: number };
      const snapshot = JSON.parse(batch.budget_snapshot) as { batch: { maxRuns: number; maxTotalAttempts: number; maxRuntimeStarts: number } };
      expect(snapshot.batch.maxRuns).toBe(1);
      expect(batch.runs_created).toBe(1);
    } finally { fixture.close(); }
  });
});
