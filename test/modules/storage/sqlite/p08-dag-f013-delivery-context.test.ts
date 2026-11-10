/**
 * P08 / F-013：DAG 交付展示上下文与集成/修复通知事件的真实 SQLite 投影。
 *
 * 覆盖（真实临时 SQLite，非 mock；迁移后直接种子冻结事实）：
 * - 交付展示上下文只读端口：稳定层级编码/名称/branchName/Phase 展示事实，
 *   批量有界、缺失折叠、跨项目 undefined、持久行损坏 fail-closed；
 * - features.delivery.get 一致读视图的 DAG 上下文：冻结起点 SHA（受管工作区
 *   base_commit）、直接前置交付 SHA/证据（后继权威计划投影）、作为后继的
 *   集成身份/状态/merge order、后继阻塞原因（权威计划 status/blockReasons）；
 * - phases.graph.get 视图携带 phase/feature 展示编码；
 * - integration.plan.updated 事件只在真实状态转换的事务内写入（创建/状态
 *   变化），同状态幂等重放不产生新事件；通知投影为订阅事件幂等创建单条
 *   delivery（重复扫描不重复投递）；
 * - git.repair.updated：authorize 首次授权/幂等重放与 hold 的真实事件边界。
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteQueryStore } from '../../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteDeliveryDisplayContextStore } from '../../../../packages/core/src/adapters/sqlite/delivery-display-context-store.ts';
import { createSqliteIntegrationPlanAccess } from '../../../../packages/core/src/adapters/sqlite/integration-plan-store.ts';
import { createSqliteNotificationDeliveryStore } from '../../../../packages/core/src/adapters/sqlite/notification-delivery-store.ts';
import { createSqliteGitAgentRepairStore } from '../../../../packages/core/src/adapters/sqlite/git-agent-repair-store.ts';
import { createGitAgentRepairService } from '../../../../packages/core/src/application/git-agent-repair.ts';
import { migrateSqliteStorage } from '../../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession, type SqliteStorageSession } from '../../../../packages/core/src/adapters/sqlite/session.ts';
import { createTempSandbox } from '../../../helpers/temp-sandbox.ts';
import { isStorageError } from '../../../../packages/core/src/ports/errors.ts';
import { INTEGRATION_PLAN_STATUS_EVENT_TYPE, GIT_REPAIR_STATUS_EVENT_TYPE } from '../../../../packages/core/src/ports/events.ts';
import { openIntegrationFixture } from '../../../helpers/p05-7-integration-vertical.ts';
import { computeGitAgentRepairBaselineDigest, createGitAgentRepairRequest } from '../../../../packages/core/src/ports/git-agent-repair.ts';
import { stableStringify } from '../../../../packages/core/src/ports/feature-plan.ts';
import { NOW, BUDGET } from '../../../helpers/p03-3/budget-fixture.ts';
import type { ExecutionBudgetProposal } from '../../../../packages/core/src/ports/execution-budget.ts';

const NOW_MS = 1_700_005_000_000;
const PROJECT = '12345678-1234-4123-8234-1234567890aa';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_I = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);
const SHA = (letter: string) => letter.repeat(40);

interface Harness {
  readonly session: SqliteStorageSession;
  readonly cleanup: () => void;
}

function seedDagProject(db: SqliteStorageSession['database']): void {
  db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES (?, ?, 1, ?, 'DAG 项目', 'active', '[]')")
    .run(PROJECT, NOW_MS, NOW_MS);
  db.prepare("INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, labels) VALUES ('phase-1', ?, ?, 1, ?, 'P07 修复', 'open', '[]')")
    .run(NOW_MS, PROJECT, NOW_MS);
  const insertFeature = db.prepare(
    "INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, plan_digest, labels, source_refs, delivery_status, branch_name) VALUES (?, ?, ?, 1, ?, 'phase-1', ?, ?, 'approved', ?, '[]', '[]', ?, ?)",
  );
  insertFeature.run('feature-a', NOW_MS, PROJECT, NOW_MS, 'A 基线', 'completed', DIGEST, 'succeeded', 'feat/p07/f01-a-baseline');
  insertFeature.run('feature-b', NOW_MS, PROJECT, NOW_MS, 'B 并行', 'completed', DIGEST, 'succeeded', 'feat/p07/f02-b-parallel');
  insertFeature.run('feature-c', NOW_MS, PROJECT, NOW_MS, 'C 集成收尾', 'running', DIGEST, 'not_requested', 'feat/p07/f03-c-closeout');
  insertFeature.run('feature-e', NOW_MS, PROJECT, NOW_MS, 'E 后继', 'draft', null, 'not_requested', null);
  // 展示编码由 entity_display_codes 迁移触发器在插入时自动固化：
  // phase-1 → P01；feature-a/b/c/e → P01-F01..P01-F04。
  const insertEdge = db.prepare(
    "INSERT INTO feature_dependencies (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id, code_baseline_ref) VALUES (?, ?, ?, 1, ?, 'phase-1', ?, ?, NULL)",
  );
  insertEdge.run('edge-ca', NOW_MS, PROJECT, NOW_MS, 'feature-c', 'feature-a');
  insertEdge.run('edge-cb', NOW_MS, PROJECT, NOW_MS, 'feature-c', 'feature-b');
  insertEdge.run('edge-ec', NOW_MS, PROJECT, NOW_MS, 'feature-e', 'feature-c');
  // feature-c 的受管编码工作区：冻结起点 = 集成提交（完整 FK/触发器身份链）。
  db.prepare(
    "INSERT INTO repository_bindings (id, created_at, project_id, revision, updated_at, canonical_path, git_common_dir, repo_identity, binding_revision) VALUES ('binding-1', ?, ?, 1, ?, '/private/repo', '/private/git', 'repo-1', 1)",
  ).run(NOW_MS, PROJECT, NOW_MS);
  db.prepare(
    "INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, deadline_at) VALUES ('batch-ws', ?, ?, 1, ?, 'phase-1', 'feature-c', '{\"featureIds\":[\"feature-c\"]}', '{}', 'succeeded', 1, '{}', 0, ?)",
  ).run(NOW_MS, PROJECT, NOW_MS, NOW_MS + 10_000);
  db.prepare(
    "INSERT INTO runs (id, created_at, project_id, revision, updated_at, batch_id, feature_id, purpose, input_snapshot, config_snapshot, status, scope_digest, work_key, dispatch_ordinal, max_attempts_per_run, run_time_limit_ms, attempts_created) VALUES ('run-ws', ?, ?, 1, ?, 'batch-ws', 'feature-c', 'execute', '{}', '{}', 'succeeded', ?, 'run-ws', 1, 1, 1000, 0)",
  ).run(NOW_MS, PROJECT, NOW_MS, DIGEST);
  db.prepare(
    `INSERT INTO tasks (id, created_at, project_id, revision, updated_at, feature_id, title, status,
       complexity, description, labels, acceptance, requirements_refs, execution_config, config_source, config_source_key, execution_version)
     VALUES ('task-ws', ?, ?, 1, ?, 'feature-c', 'C 编码 Task', 'passed', NULL, NULL, '[]',
       '{\"criteria\":[\"done\"]}', '[]', '{}', 'manual', NULL, 1)`,
  ).run(NOW_MS, PROJECT, NOW_MS);
  db.prepare(
    `INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status, media_type, version,
       expected_hash, content_hash, size_bytes, storage_locator)
     VALUES ('input-ws', ?, ?, ?, 'execution-input', 'ready', 'application/json', 1, ?, ?, 10, 'inputs/input-ws')`,
  ).run(NOW_MS, NOW_MS, PROJECT, DIGEST, DIGEST);
  db.prepare(
    `INSERT INTO attempts (id, created_at, updated_at, project_id, feature_id, run_id, task_id,
       number, owner_id, host_instance_id, execution_version, lease_until, input_snapshot, input_digest, input_ref,
       status, execution_stage, started_at, ended_at)
     VALUES ('attempt-ws', ?, ?, ?, 'feature-c', 'run-ws', 'task-ws', 1, 'owner-1', 'host-1', 1, ?, ?, ?, 'input-ws', 'succeeded', 'verification', ?, ?)`,
  ).run(NOW_MS, NOW_MS, PROJECT, NOW_MS + 1000,
    JSON.stringify({ schemaVersion: 1, projectId: PROJECT, featureId: 'feature-c', taskId: 'task-ws',
      digests: { snapshotDigest: DIGEST }, group: { snapshot: { artifactId: 'input-ws', version: 1, contentHash: DIGEST,
        sizeBytes: 10, locator: 'inputs/input-ws', mediaType: 'application/json' } } }),
    DIGEST, NOW_MS, NOW_MS);
  db.prepare(
    `INSERT INTO managed_workspaces (id, created_at, project_id, revision, updated_at, feature_id, repository_binding_id,
       repository_binding_revision, repo_identity, canonical_path, git_common_dir, branch, base_commit, head_commit, code_digest,
       status, preparation_operation_id, owner_id, host_instance_id, execution_version, run_id, attempt_id)
     VALUES ('ws-c', ?, ?, 1, ?, 'feature-c', 'binding-1', 1, 'repo-1', '/private/worktree', '/private/git',
       'feat/p07/f03-c-closeout', ?, ?, ?, 'ready', 'prep-1', 'owner-1', 'host-1', 1, 'run-ws', 'attempt-ws')`,
  ).run(NOW_MS, PROJECT, NOW_MS, SHA_I, SHA_I, DIGEST);
  db.prepare(
    "INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, deadline_at) VALUES ('batch-1', ?, ?, 1, ?, 'phase-1', 'feature-c', '{\"featureIds\":[\"feature-c\"]}', '{}', 'succeeded', 1, '{}', 0, ?), ('batch-2', ?, ?, 1, ?, 'phase-1', 'feature-e', '{\"featureIds\":[\"feature-e\"]}', '{}', 'queued', 1, '{}', 0, ?)",
  ).run(NOW_MS, PROJECT, NOW_MS, NOW_MS + 10_000, NOW_MS, PROJECT, NOW_MS, NOW_MS + 10_000);
}

interface SeededPlans {
  readonly planC: { integrationId: string; inputDigest: string };
  readonly planE: { integrationId: string; blockReasons: readonly string[] };
}

/** 经真实 store 创建集成计划（身份/摘要由端口计算，避免手工伪造漂移）。 */
function seedIntegrationPlans(session: SqliteStorageSession): SeededPlans {
  const access = createSqliteIntegrationPlanAccess(session, { nowUtcMs: () => NOW_MS });
  return session.transactWrite('seed-integration-plans', () => {
    const planC = access.createIntegrationPlanInTransaction({
      projectId: PROJECT, phaseId: 'phase-1', batchId: 'batch-1', successorFeatureId: 'feature-c',
      targetBaseline: SHA_I,
      predecessors: [
        { projectId: PROJECT, phaseId: 'phase-1', featureId: 'feature-a', dependencyPassed: true,
          delivery: { commitSha: SHA_A, evidenceId: 'evidence-a', evidenceDigest: DIGEST },
          coveredInputIds: ['input-a'], ancestorVerified: true },
        { projectId: PROJECT, phaseId: 'phase-1', featureId: 'feature-b', dependencyPassed: true,
          delivery: { commitSha: SHA_B, evidenceId: 'evidence-b', evidenceDigest: DIGEST },
          coveredInputIds: ['input-b'], ancestorVerified: true },
      ],
      approvedInputs: [{ inputId: 'input-a', digest: DIGEST }, { inputId: 'input-b', digest: DIGEST }],
      mergeOrder: ['feature-a', 'feature-b'], verificationScope: ['typecheck'],
      strategySummary: { conflictPolicy: 'deterministic-only' }, integrationResult: null,
    });
    // 冻结后写入通过结果（组合验证证据齐备）→ integration_passed。
    const frozenC = access.freezeIntegrationPlanInTransaction({
      projectId: PROJECT, integrationId: planC.integrationId, expectedRevision: planC.revision,
    });
    const passed = access.updateIntegrationPlanResultInTransaction({
      projectId: PROJECT, integrationId: planC.integrationId, expectedRevision: frozenC.revision,
      integrationResult: {
        commitSha: SHA_I, treeSha: SHA('e'), inputDigest: planC.inputDigest,
        verificationEvidence: { evidenceId: 'evidence-i', evidenceDigest: DIGEST },
      },
      operationId: 'operation-i', ownerId: 'owner-i', ownerVersion: 1,
    });
    const planE = access.createIntegrationPlanInTransaction({
      projectId: PROJECT, phaseId: 'phase-1', batchId: 'batch-2', successorFeatureId: 'feature-e',
      targetBaseline: SHA_I,
      predecessors: [
        { projectId: PROJECT, phaseId: 'phase-1', featureId: 'feature-c', dependencyPassed: true,
          delivery: { commitSha: SHA_I, evidenceId: 'evidence-c', evidenceDigest: DIGEST },
          coveredInputIds: ['input-c'], ancestorVerified: true },
      ],
      approvedInputs: [{ inputId: 'input-c', digest: DIGEST }],
      mergeOrder: ['feature-c'], verificationScope: ['typecheck'],
      strategySummary: { conflictPolicy: 'deterministic-only' }, integrationResult: null,
    });
    return {
      planC: { integrationId: passed.integrationId, inputDigest: passed.inputDigest },
      planE: { integrationId: planE.integrationId, blockReasons: planE.blockReasons },
    };
  });
}

function openHarness(): Harness & SeededPlans {
  const sandbox = createTempSandbox('shiploop-p08-f013-');
  const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
  migrateSqliteStorage(session, { nowUtcMs: () => NOW_MS });
  seedDagProject(session.database);
  const plans = seedIntegrationPlans(session);
  return { session, cleanup: () => { session.close(); sandbox.cleanup(); }, ...plans };
}

const integrationFixtures: Awaited<ReturnType<typeof openIntegrationFixture>>[] = [];
afterEach(() => { for (const fixture of integrationFixtures.splice(0)) fixture.close(); });

describe('P08 F-013 delivery display context projection (SQLite)', () => {
  it('[case:f013-display-context-store] reads stable codes, titles and branch names with bounded batches', () => {
    const harness = openHarness();
    try {
      const store = createSqliteDeliveryDisplayContextStore(harness.session);
      expect(store.readFeatureDeliveryDisplay(PROJECT, 'feature-c')).toEqual({
        featureId: 'feature-c', displayCode: 'P01-F03', title: 'C 集成收尾',
        branchName: 'feat/p07/f03-c-closeout', phaseId: 'phase-1', phaseDisplayCode: 'P01', phaseTitle: 'P07 修复',
      });
      expect(store.readFeatureDeliveryDisplay(PROJECT, 'feature-e')?.displayCode).toBe('P01-F04');
      expect(store.readFeatureDeliveryDisplay(PROJECT, 'missing-feature')).toBeUndefined();
      expect(store.readFeatureDeliveryDisplay('12345678-1234-4123-8234-1234567890bb', 'feature-c')).toBeUndefined();
      const batch = store.listFeatureDeliveryDisplays(PROJECT, ['feature-a', 'feature-b', 'feature-e', 'missing']);
      expect(batch.get('feature-a')?.displayCode).toBe('P01-F01');
      expect(batch.get('feature-e')?.branchName).toBe(null);
      expect(batch.has('missing')).toBe(false);
      try {
        store.listFeatureDeliveryDisplays(PROJECT, new Array(200).fill('feature-a'));
        expect.unreachable('batch limit must reject');
      } catch (error) {
        expect(isStorageError(error, 'validation')).toBe(true);
      }
    } finally {
      harness.cleanup();
    }
  });

  it('[case:f013-feature-delivery-dag-view] projects frozen base, predecessor deliveries, integrations and successor blockers', () => {
    const harness = openHarness();
    try {
      const planC = harness.planC;
      const planE = harness.planE;
      const view = createSqliteQueryStore(harness.session).readFeatureDeliveryView(PROJECT, 'feature-c');
      expect(view).toBeDefined();
      expect(view!.feature).toMatchObject({
        title: 'C 集成收尾', branchName: 'feat/p07/f03-c-closeout',
        phaseId: 'phase-1', phaseTitle: 'P07 修复', displayCode: 'P01-F03', phaseDisplayCode: 'P01',
      });
      expect(view!.dag.frozenBaseCommit).toBe(SHA_I);
      expect(view!.dag.predecessors.map(entry => [entry.displayCode, entry.commitSha, entry.evidenceId])).toEqual([
        ['P01-F01', SHA_A, 'evidence-a'], ['P01-F02', SHA_B, 'evidence-b'],
      ]);
      expect(view!.dag.integrations).toHaveLength(1);
      expect(view!.dag.integrations[0]).toMatchObject({
        integrationId: planC.integrationId, status: 'integration_passed',
        mergeOrder: ['feature-a', 'feature-b'], commitSha: SHA_I, evidenceId: 'evidence-i',
      });
      expect(view!.dag.successors).toEqual([
        {
          featureId: 'feature-e', displayCode: 'P01-F04', title: 'E 后继',
          integrationId: planE.integrationId, status: 'dependency_passed', blockReasons: planE.blockReasons,
        },
      ]);
      // 无工作区/无后继的 Feature：冻结起点与后继保持空，不虚构事实；
      // 直接前置与作为后继的计划仍按持久事实展示。
      const plain = createSqliteQueryStore(harness.session).readFeatureDeliveryView(PROJECT, 'feature-e');
      expect(plain!.dag.frozenBaseCommit).toBeNull();
      expect(plain!.dag.successors).toEqual([]);
      expect(plain!.dag.predecessors.map(entry => [entry.featureId, entry.displayCode, entry.commitSha])).toEqual([
        ['feature-c', 'P01-F03', SHA_I],
      ]);
      expect(plain!.dag.integrations.map(entry => [entry.integrationId, entry.status])).toEqual([
        [planE.integrationId, 'dependency_passed'],
      ]);
    } finally {
      harness.cleanup();
    }
  });

  it('[case:f013-phase-graph-codes] carries phase and feature display codes in one view', () => {
    const harness = openHarness();
    try {
      const view = createSqliteQueryStore(harness.session).readPhaseGraphView(PROJECT, 'phase-1');
      expect(view?.phaseDisplayCode).toBe('P01');
      expect(view?.featureDisplayCodes?.get('feature-c')).toBe('P01-F03');
      expect(view?.featureDisplayCodes?.get('feature-e')).toBe('P01-F04');
    } finally {
      harness.cleanup();
    }
  });
});

describe('P08 F-013 integration and repair notification events (SQLite)', () => {
  it('[case:f013-integration-events-idempotent] writes status events only on real transitions', () => {
    const harness = openHarness();
    try {
      const access = createSqliteIntegrationPlanAccess(harness.session, { nowUtcMs: () => NOW_MS });
      const count = () =>
        (harness.session.database.prepare('SELECT COUNT(*) AS n FROM state_events WHERE event_type = ?').get(INTEGRATION_PLAN_STATUS_EVENT_TYPE) as { n: number }).n;
      const baseline = count();
      const created = harness.session.transactWrite('create-plan', () => access.createIntegrationPlanInTransaction({
        projectId: PROJECT, phaseId: 'phase-1', batchId: 'batch-2', successorFeatureId: 'feature-e',
        targetBaseline: SHA_I,
        predecessors: [{ projectId: PROJECT, phaseId: 'phase-1', featureId: 'feature-c', dependencyPassed: true,
          delivery: { commitSha: SHA_I, evidenceId: 'evidence-c', evidenceDigest: DIGEST }, coveredInputIds: ['input-n'], ancestorVerified: true }],
        approvedInputs: [{ inputId: 'input-n', digest: 'f'.repeat(64) }], mergeOrder: ['feature-c'], verificationScope: ['typecheck'],
        strategySummary: { conflictPolicy: 'deterministic-only' }, integrationResult: null,
      }));
      expect(created.status).toBe('dependency_passed');
      expect(count()).toBe(baseline + 1);
      // 同状态幂等重放：零事件。
      harness.session.transactWrite('same-status', () => access.updateIntegrationPlanStatusInTransaction({
        projectId: PROJECT, integrationId: created.integrationId, expectedRevision: created.revision,
        status: 'dependency_passed', blockReasons: [], staleReasons: [],
      }));
      expect(count()).toBe(baseline + 1);
      // 真实状态变化：事件 +1。
      harness.session.transactWrite('block-plan', () => access.updateIntegrationPlanStatusInTransaction({
        projectId: PROJECT, integrationId: created.integrationId, expectedRevision: created.revision,
        status: 'blocked', blockReasons: ['ancestor_not_verified'], staleReasons: [],
      }));
      expect(count()).toBe(baseline + 2);
      // 事件 payload 只含冻结身份与受控状态/原因。
      const row = harness.session.database
        .prepare('SELECT aggregate_type, aggregate_id, payload FROM state_events WHERE event_type = ? ORDER BY sequence DESC LIMIT 1')
        .get(INTEGRATION_PLAN_STATUS_EVENT_TYPE) as { aggregate_type: string; aggregate_id: string; payload: string };
      expect(row.aggregate_type).toBe('integration_plan');
      expect(JSON.parse(row.payload)).toMatchObject({
        schemaVersion: 1, integrationId: created.integrationId, successorFeatureId: 'feature-e',
        status: 'blocked', blockReasons: ['ancestor_not_verified'],
      });
    } finally {
      harness.cleanup();
    }
  });

  it('[case:f013-integration-notification-dedup] projects one delivery per event and never redelivers', () => {
    const harness = openHarness();
    try {
      const access = createSqliteIntegrationPlanAccess(harness.session, { nowUtcMs: () => NOW_MS });
      const created = harness.session.transactWrite('create-plan', () => access.createIntegrationPlanInTransaction({
        projectId: PROJECT, phaseId: 'phase-1', batchId: 'batch-2', successorFeatureId: 'feature-e',
        targetBaseline: SHA_I,
        predecessors: [{ projectId: PROJECT, phaseId: 'phase-1', featureId: 'feature-c', dependencyPassed: true,
          delivery: { commitSha: SHA_I, evidenceId: 'evidence-c', evidenceDigest: DIGEST }, coveredInputIds: ['input-n'], ancestorVerified: true }],
        approvedInputs: [{ inputId: 'input-n', digest: 'f'.repeat(64) }], mergeOrder: ['feature-c'], verificationScope: ['typecheck'],
        strategySummary: { conflictPolicy: 'deterministic-only' }, integrationResult: null,
      }));
      harness.session.transactWrite('block-plan', () => access.updateIntegrationPlanStatusInTransaction({
        projectId: PROJECT, integrationId: created.integrationId, expectedRevision: created.revision,
        status: 'blocked', blockReasons: ['ancestor_not_verified'], staleReasons: [],
      }));
      const integrationEventCount = (harness.session.database
        .prepare('SELECT COUNT(*) AS n FROM state_events WHERE event_type = ?')
        .get(INTEGRATION_PLAN_STATUS_EVENT_TYPE) as { n: number }).n;
      expect(integrationEventCount).toBeGreaterThanOrEqual(2);
      const store = createSqliteNotificationDeliveryStore({ session: harness.session, nowUtcMs: () => NOW_MS });
      const first = store.projectNotificationBatch({ channelId: 'local-results' });
      const integrationDeliveries = first.createdDeliveries.filter(delivery => delivery.eventType === INTEGRATION_PLAN_STATUS_EVENT_TYPE);
      expect(integrationDeliveries.length).toBe(integrationEventCount);
      for (const delivery of integrationDeliveries) {
        expect(delivery.summary).toMatchObject({ kind: 'integration_status' });
        expect(typeof (delivery.summary as { integrationId?: unknown }).integrationId).toBe('string');
        expect(JSON.stringify(delivery.summary)).not.toContain('/private');
      }
      // 同事件重复扫描：幂等，不重复投递有效卡片。
      const second = store.projectNotificationBatch({ channelId: 'local-results' });
      expect(second.createdDeliveries.filter(delivery => delivery.eventType === INTEGRATION_PLAN_STATUS_EVENT_TYPE)).toHaveLength(0);
      const total = (harness.session.database
        .prepare("SELECT COUNT(*) AS n FROM notification_deliveries WHERE event_id IN (SELECT id FROM state_events WHERE event_type = ?)")
        .get(INTEGRATION_PLAN_STATUS_EVENT_TYPE) as { n: number }).n;
      expect(total).toBe(integrationEventCount);
    } finally {
      harness.cleanup();
    }
  });

  it('[case:f013-repair-events] writes requested/blocked events at authorization and first hold', async () => {
    const { maxTokenTotal: _tokens, maxCostTotal: _cost, ...batch } = BUDGET.batch;
    const fixture = await openIntegrationFixture({ batch, run: BUDGET.run } as ExecutionBudgetProposal);
    integrationFixtures.push(fixture);
    const operation = fixture.operations.registerGitOperation(fixture.intent).operation;
    const failed = fixture.operations.finalizeGitOperation({
      projectId: fixture.box.projectId, operationId: fixture.intent.operationId, expectedRevision: operation.revision,
      status: 'failed', actualCommit: null, actualTree: null, exitCode: 1, durationMs: 10,
      reasonCode: 'merge_conflict', deliveryStatus: 'not_requested', settledAtUtcMs: NOW + 1,
      recoveryState: 'preserved', workspacePreserved: true,
    }).operation;
    fixture.box.session.database.prepare("UPDATE runs SET status = 'failed', ended_at = ? WHERE id = ?").run(NOW + 1, fixture.plan.runId);
    const hash = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
    const request = createGitAgentRepairRequest({
      projectId: fixture.box.projectId, phaseId: fixture.plan.phaseId, parentBatchId: fixture.plan.batchId,
      featureId: fixture.box.featureId, runId: fixture.plan.runId, repairId: 'repair-f013', commandId: 'command-f013',
      source: {
        projectId: fixture.box.projectId, phaseId: fixture.plan.phaseId, parentBatchId: fixture.plan.batchId,
        featureId: fixture.box.featureId, runId: fixture.plan.runId, integrationId: fixture.plan.integrationId,
        operationId: fixture.intent.operationId, operationType: 'integration', operationDigest: operation.intentDigest,
        failureKind: 'conflict', evidenceId: fixture.intent.operationId, evidenceDigest: hash(failed.receipt),
        inputDigest: fixture.plan.inputDigest,
      },
      target: { repoIdentity: fixture.plan.target.repoIdentity, baselineCommitSha: fixture.plan.target.baseCommit,
        baselineDigest: computeGitAgentRepairBaselineDigest({ repoIdentity: fixture.plan.target.repoIdentity, baselineCommitSha: fixture.plan.target.baseCommit }) },
      workspace: { workspaceId: fixture.plan.integrationId, workspaceDigest: hash({ repoIdentity: fixture.intent.repoIdentity,
        worktreePath: fixture.intent.worktreePath, inputDigest: fixture.plan.inputDigest, baselineCommitSha: fixture.intent.expectedHead }) },
      conflictFiles: ['src/conflict.ts'], writablePaths: ['src/conflict.ts'],
      intent: { intentId: 'requirements', digest: hash('intent') }, verification: { strategyId: 'combined-tests', digest: hash('verify') },
      budget: { remainingAttempts: 2, remainingTokens: 100, remainingRuntimeMs: 1000, deadlineUtcMs: NOW + 5000 },
    }, { nowUtcMs: NOW });
    const service = createGitAgentRepairService({
      atomic: fixture.box.atomic,
      store: createSqliteGitAgentRepairStore(fixture.box.session, { nowUtcMs: () => NOW + 2 }),
    });
    const events = () => (fixture.box.session.database
      .prepare('SELECT payload FROM state_events WHERE event_type = ? ORDER BY sequence')
      .all(GIT_REPAIR_STATUS_EVENT_TYPE) as { payload: string }[]).map(row => JSON.parse(row.payload) as Record<string, unknown>);
    service.authorize(request);
    expect(events()).toEqual([
      { schemaVersion: 1, repairId: 'repair-f013', featureId: fixture.box.featureId, status: 'requested', reason: null },
    ]);
    // 幂等重放：零新事件。
    service.authorize(request);
    expect(events()).toHaveLength(1);
    // 首次 hold：blocked 事件；再次 hold 不重复。
    const store = createSqliteGitAgentRepairStore(fixture.box.session, { nowUtcMs: () => NOW + 3 });
    fixture.box.atomic.transact('hold-f013', tx => store.hold(tx, fixture.box.projectId, 'repair-f013', 'stop_unconfirmed'));
    expect(events()[1]).toMatchObject({ status: 'blocked', reason: 'stop_unconfirmed' });
    fixture.box.atomic.transact('hold-f013-again', tx => store.hold(tx, fixture.box.projectId, 'repair-f013', 'budget_exhausted'));
    expect(events()).toHaveLength(2);
  });
});
