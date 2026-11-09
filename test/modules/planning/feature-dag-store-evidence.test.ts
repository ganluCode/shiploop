import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteFeatureDagStore } from '../../../packages/core/src/adapters/sqlite/feature-dag-store.ts';
import { createSqliteIntegrationPlanQueryStore } from '../../../packages/core/src/adapters/sqlite/integration-plan-query-store.ts';
import { createSqliteIntegrationPlanStore } from '../../../packages/core/src/adapters/sqlite/integration-plan-store.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { StorageError } from '../../../packages/core/src/ports/errors.ts';
import type { IntegrationPlanInput, IntegrationResult } from '../../../packages/core/src/ports/integration-plan.ts';
import { evaluateFeatureDag } from '../../../packages/core/src/ports/feature-dag.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const T0 = 1_700_100_000_000;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const BASELINE = 'c'.repeat(40);
const BASELINE_2 = 'd'.repeat(40);
const DIGEST_A = '1'.repeat(64);
const DIGEST_B = '2'.repeat(64);
const VERIFY_DIGEST = '3'.repeat(64);

interface Box {
  readonly session: ReturnType<typeof openSqliteStorageSession>;
  readonly path: string;
  readonly sandbox: ReturnType<typeof createTempSandbox>;
}

function openBox(): Box {
  const sandbox = createTempSandbox('shiploop-f004-dag-');
  const path = join(sandbox.path, 'state.db');
  const session = openSqliteStorageSession({ path });
  return { session, path, sandbox };
}

async function seed(box: Box, options: { readonly edges?: readonly [string, string][] } = {}): Promise<void> {
  await migrateSqliteStorage(box.session, { nowUtcMs: () => T0 });
  box.session.transactWrite('f004.seed', (db) => {
    db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('project-a', ?, 1, ?, 'A', 'active', '[]')").run(T0, T0);
    db.prepare("INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, description, labels) VALUES ('phase-a', ?, 'project-a', 1, ?, 'Phase A', 'open', NULL, '[]')").run(T0, T0);
    const feature = db.prepare("INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, description, labels, source_refs, plan_digest) VALUES (?, ?, 'project-a', 1, ?, 'phase-a', ?, 'completed', 'approved', NULL, '[]', '[]', NULL)");
    for (const id of ['feature-a', 'feature-b', 'feature-c']) feature.run(id, T0, T0, id);
    db.prepare("INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, runtime_starts, no_progress_runs, deadline_at) VALUES ('batch-a', ?, 'project-a', 1, ?, 'phase-a', 'feature-c', '{\"featureIds\":[\"feature-c\"]}', '{}', 'succeeded', 1, '{}', 0, 0, 0, 0, ?)").run(T0, T0, T0 + 1000);
    for (const [featureId, dependsOnId] of options.edges ?? []) {
      db.prepare(
        'INSERT INTO feature_dependencies (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id, code_baseline_ref) VALUES (?, ?, ' + "'project-a', 1, ?, 'phase-a', ?, ?, NULL)",
      ).run(`edge-${featureId}-${dependsOnId}`, T0, T0, featureId, dependsOnId);
    }
  });
}

function planInput(options: {
  readonly successor: 'feature-b' | 'feature-c';
  readonly predecessors?: readonly ('feature-a' | 'feature-b')[];
  readonly targetBaseline?: string;
  readonly deliveryA?: { readonly commitSha: string; readonly evidenceDigest: string } | null;
  readonly deliveryB?: { readonly commitSha: string; readonly evidenceDigest: string } | null;
}): IntegrationPlanInput {
  const shape = {
    predecessors: options.predecessors ?? (options.successor === 'feature-b' ? ['feature-a'] : ['feature-a', 'feature-b']),
    inputs: (options.predecessors ?? (options.successor === 'feature-b' ? ['feature-a'] : ['feature-a', 'feature-b']))
      .map((featureId) => (featureId === 'feature-a' ? 'input-a' : 'input-b')),
  };
  const deliveries = {
    'feature-a': options.deliveryA === undefined
      ? { commitSha: SHA_A, evidenceId: 'delivery-a', evidenceDigest: DIGEST_A }
      : options.deliveryA === null ? null
        : { commitSha: options.deliveryA.commitSha, evidenceId: 'delivery-a', evidenceDigest: options.deliveryA.evidenceDigest },
    'feature-b': options.deliveryB === undefined
      ? { commitSha: SHA_B, evidenceId: 'delivery-b', evidenceDigest: DIGEST_B }
      : options.deliveryB === null ? null
        : { commitSha: options.deliveryB.commitSha, evidenceId: 'delivery-b', evidenceDigest: options.deliveryB.evidenceDigest },
  };
  return {
    projectId: 'project-a', phaseId: 'phase-a', batchId: 'batch-a', successorFeatureId: options.successor,
    targetBaseline: options.targetBaseline ?? BASELINE,
    predecessors: shape.predecessors.map((featureId) => ({
      projectId: 'project-a', phaseId: 'phase-a', featureId, dependencyPassed: true,
      delivery: deliveries[featureId as 'feature-a' | 'feature-b'],
      coveredInputIds: featureId === 'feature-a' ? ['input-a'] : ['input-b'],
      ancestorVerified: true,
    })),
    approvedInputs: shape.inputs.map((inputId, index) => ({ inputId, digest: `${index + 1}`.repeat(64) })),
    mergeOrder: shape.predecessors,
    verificationScope: ['typecheck'],
    strategySummary: { conflictPolicy: 'deterministic-only' },
    integrationResult: null,
  };
}

const COMPLETE_RESULT: IntegrationResult = {
  commitSha: 'e'.repeat(40), treeSha: 'f'.repeat(40),
  verificationEvidence: { evidenceId: 'verify-a', evidenceDigest: VERIFY_DIGEST },
  llmNoConflictText: null,
};

function passPlan(box: Box, options: Parameters<typeof planInput>[0], at: number): string {
  const atomic = createSqliteAtomicCommandStore(box.session, { nowUtcMs: () => at });
  const created = atomic.transact('integration.create', (tx) => tx.createIntegrationPlan(planInput(options)));
  const frozen = atomic.transact('integration.freeze', (tx) => tx.freezeIntegrationPlan({ projectId: 'project-a', integrationId: created.integrationId, expectedRevision: created.revision }));
  const result = atomic.transact('integration.result', (tx) => tx.updateIntegrationPlanResult({
    projectId: 'project-a', integrationId: created.integrationId, expectedRevision: frozen.revision,
    integrationResult: COMPLETE_RESULT,
  }));
  expect(result.status).toBe('integration_passed');
  return created.integrationId;
}

describe('P07 DAG F-004 SQLite Feature DAG integration evidence projection', () => {
  it('[case:feature-dag-store-passed-evidence] projects fixed evidence from the authoritative plan in one read view', async () => {
    const box = openBox();
    try {
      await seed(box, { edges: [['feature-c', 'feature-a'], ['feature-c', 'feature-b']] });
      const integrationId = passPlan(box, { successor: 'feature-c' }, T0 + 100);
      const store = createSqliteFeatureDagStore(box.session);
      const input = store.readFeatureDag('project-a', 'phase-a');
      const evaluation = evaluateFeatureDag(input);
      // 输出按稳定节点/边顺序，携带持久 revision。
      expect(input.features.map((feature) => feature.id)).toEqual(['feature-a', 'feature-b', 'feature-c']);
      expect(input.features.map((feature) => feature.revision)).toEqual([1, 1, 1]);
      expect(input.existingEdges!.map((edge) => [edge.featureId, edge.dependsOnId, edge.revision])).toEqual([
        ['feature-c', 'feature-a', 1],
        ['feature-c', 'feature-b', 1],
      ]);
      // 证据投影固定 integrationId、成果 SHA、目标基线与证据摘要，不用分支/HEAD 推导。
      expect(input.features.find((feature) => feature.id === 'feature-a')?.integrationEvidence).toMatchObject({
        integrationId, commitSha: SHA_A, targetBaseline: BASELINE, evidenceDigest: DIGEST_A,
        status: 'passed', planRevision: 3,
      });
      expect(input.existingEdges!.find((edge) => edge.dependsOnId === 'feature-a')?.integrationEvidence).toMatchObject({
        integrationId, commitSha: SHA_A, status: 'passed',
      });
      const readiness = evaluation.readiness.find((item) => item.featureId === 'feature-c')!;
      expect(readiness).toMatchObject({
        dependencyCompleted: true, dependencyIntegrationReady: true, ready: true, reason: 'ready',
        dependencyStaleReasons: [], dependencyBlockReasons: [],
      });
      expect(evaluation.readyFeatureIds).toContain('feature-c');
      // Feature revision/status 变化不改变证据事实。
      box.session.database.prepare("UPDATE features SET status = 'draft', revision = 9 WHERE id = 'feature-a'").run();
      const reRead = store.readFeatureDag('project-a', 'phase-a');
      expect(reRead.features.find((feature) => feature.id === 'feature-a')?.integrationEvidence).toMatchObject({ commitSha: SHA_A });
      expect(reRead.features.find((feature) => feature.id === 'feature-a')?.revision).toBe(9);
    } finally {
      box.session.close();
      box.sandbox.cleanup();
    }
  });

  it('[case:feature-dag-store-missing-and-stale] keeps fail-closed reasons for missing, stale and blocked plans', async () => {
    const box = openBox();
    try {
      await seed(box, { edges: [['feature-c', 'feature-a'], ['feature-c', 'feature-b']] });
      const store = createSqliteFeatureDagStore(box.session);
      // 缺计划：不推导证据。
      const missing = evaluateFeatureDag(store.readFeatureDag('project-a', 'phase-a'))
        .readiness.find((item) => item.featureId === 'feature-c')!;
      expect(missing).toMatchObject({ dependencyCompleted: true, dependencyIntegrationReady: false, ready: false, reason: 'integration_not_ready' });
      expect(missing.dependencyStaleReasons).toEqual([]);
      // 阻塞：缺交付证据的计划在创建时即 blocked。
      const atomic = createSqliteAtomicCommandStore(box.session, { nowUtcMs: () => T0 + 200 });
      const blocked = atomic.transact('integration.create', (tx) => tx.createIntegrationPlan(planInput({ successor: 'feature-c', deliveryA: null })));
      expect(blocked.status).toBe('blocked');
      const blockedReadiness = evaluateFeatureDag(store.readFeatureDag('project-a', 'phase-a'))
        .readiness.find((item) => item.featureId === 'feature-c')!;
      expect(blockedReadiness).toMatchObject({ reason: 'integration_blocked', ready: false });
      expect(blockedReadiness.dependencyBlockReasons).toEqual(['missing_delivery_evidence']);
      // 过期：通过后由 owner 标记 stale，证据随即失效。
      const integrationId = passPlan(box, { successor: 'feature-c', targetBaseline: BASELINE_2 }, T0 + 300);
      const atomicLater = createSqliteAtomicCommandStore(box.session, { nowUtcMs: () => T0 + 400 });
      const current = atomicLater.transact('integration.get', (tx) => tx.getIntegrationPlan('project-a', integrationId));
      atomicLater.transact('integration.status', (tx) => tx.updateIntegrationPlanStatus({
        projectId: 'project-a', integrationId, expectedRevision: current.revision,
        status: 'stale', blockReasons: [], staleReasons: ['input_digest_changed'],
      }));
      const staleReadiness = evaluateFeatureDag(store.readFeatureDag('project-a', 'phase-a'))
        .readiness.find((item) => item.featureId === 'feature-c')!;
      expect(staleReadiness).toMatchObject({ reason: 'integration_stale', ready: false, dependencyIntegrationReady: false });
      expect(staleReadiness.dependencyStaleReasons).toEqual(['input_digest_changed']);
      const evidence = store.readFeatureDag('project-a', 'phase-a').existingEdges!
        .find((edge) => edge.dependsOnId === 'feature-a')?.integrationEvidence;
      expect(evidence!).toMatchObject({ integrationId, status: 'stale', staleReasons: ['input_digest_changed'] });
    } finally {
      box.session.close();
      box.sandbox.cleanup();
    }
  });

  it('[case:feature-dag-store-drift-and-authority] detects edge drift and follows the newest authoritative plan', async () => {
    const box = openBox();
    try {
      await seed(box, { edges: [['feature-c', 'feature-a'], ['feature-c', 'feature-b']] });
      const store = createSqliteFeatureDagStore(box.session);
      // 计划只覆盖 A，当前 DAG 边包含 A、B：证据漂移。
      const integrationId = passPlan(box, { successor: 'feature-c', predecessors: ['feature-a'] }, T0 + 100);
      const drift = evaluateFeatureDag(store.readFeatureDag('project-a', 'phase-a'))
        .readiness.find((item) => item.featureId === 'feature-c')!;
      expect(drift).toMatchObject({ reason: 'integration_drift', ready: false, dependencyCompleted: true });
      expect(drift.dependencyStaleReasons).toEqual(['dependency_edges_changed']);
      // 同一后继的较新权威计划覆盖旧事实（不按完成先后推导成果）。
      const newer = createSqliteAtomicCommandStore(box.session, { nowUtcMs: () => T0 + 500 });
      newer.transact('integration.create', (tx) => tx.createIntegrationPlan(planInput({ successor: 'feature-c', targetBaseline: BASELINE_2 })));
      const afterNewer = store.readFeatureDag('project-a', 'phase-a');
      const edgeEvidence = afterNewer.existingEdges!.find((edge) => edge.dependsOnId === 'feature-a')?.integrationEvidence;
      expect(edgeEvidence).toMatchObject({ status: 'pending', targetBaseline: BASELINE_2 });
      expect(edgeEvidence?.integrationId).not.toBe(integrationId);
      expect(evaluateFeatureDag(afterNewer).readiness.find((item) => item.featureId === 'feature-c')).toMatchObject({
        reason: 'integration_not_ready', ready: false,
      });
    } finally {
      box.session.close();
      box.sandbox.cleanup();
    }
  });

  it('[case:feature-dag-store-multi-consumer-aggregate] aggregates node evidence fail-closed across consumers', async () => {
    const box = openBox();
    try {
      await seed(box, { edges: [['feature-b', 'feature-a'], ['feature-c', 'feature-a'], ['feature-c', 'feature-b']] });
      const store = createSqliteFeatureDagStore(box.session);
      // 仅 B 的计划通过：B 就绪，A 的节点级证据保持缺失（部分集成不冒充完成）。
      const integrationB = passPlan(box, { successor: 'feature-b' }, T0 + 100);
      const partial = store.readFeatureDag('project-a', 'phase-a');
      expect(partial.features.find((feature) => feature.id === 'feature-a')?.integrationEvidence).toBeNull();
      expect(evaluateFeatureDag(partial).readiness.find((item) => item.featureId === 'feature-b')).toMatchObject({ ready: true, reason: 'ready' });
      expect(evaluateFeatureDag(partial).readiness.find((item) => item.featureId === 'feature-c')).toMatchObject({ reason: 'integration_not_ready' });
      void integrationB;
      // 两个消费方计划都通过：A 携带自身固定交付身份（多消费方不投影歧义字段）。
      passPlan(box, { successor: 'feature-c', targetBaseline: BASELINE_2 }, T0 + 200);
      const complete = store.readFeatureDag('project-a', 'phase-a');
      const nodeEvidence = complete.features.find((feature) => feature.id === 'feature-a')?.integrationEvidence;
      expect(nodeEvidence).toMatchObject({ commitSha: SHA_A, evidenceDigest: DIGEST_A, status: 'passed' });
      expect(nodeEvidence?.integrationId).toBeUndefined();
      expect(nodeEvidence?.targetBaseline).toBeUndefined();
      expect(evaluateFeatureDag(complete).readiness.find((item) => item.featureId === 'feature-c')).toMatchObject({ ready: true, reason: 'ready' });
    } finally {
      box.session.close();
      box.sandbox.cleanup();
    }
  });

  it('[case:feature-dag-store-corrupt-fail-closed] rejects tampered persisted plan facts', async () => {
    const box = openBox();
    try {
      await seed(box, { edges: [['feature-c', 'feature-a'], ['feature-c', 'feature-b']] });
      passPlan(box, { successor: 'feature-c' }, T0 + 100);
      const store = createSqliteFeatureDagStore(box.session);
      const db = box.session.database;
      // 持久 status 与冻结输入推导状态不一致：fail-closed corrupt。
      db.prepare("UPDATE integration_plans SET status = 'dependency_passed' WHERE successor_feature_id = 'feature-c'").run();
      try {
        expect(() => store.readFeatureDag('project-a', 'phase-a')).toThrowError(StorageError);
        try {
          store.readFeatureDag('project-a', 'phase-a');
        } catch (error) {
          expect(error).toMatchObject({ kind: 'corrupt', details: { reason: 'status_not_derivable' } });
        }
      } finally {
        db.prepare("UPDATE integration_plans SET status = 'integration_passed' WHERE successor_feature_id = 'feature-c'").run();
      }
      expect(() => store.readFeatureDag('project-a', 'phase-a')).not.toThrow();
      // 结果 JSON 结构损坏（CHECK 仅保证 json_valid，不保证端口形状）：fail-closed。
      db.prepare("UPDATE integration_plans SET integration_result = '{\"bogus\":1}' WHERE successor_feature_id = 'feature-c'").run();
      try {
        expect(() => store.readFeatureDag('project-a', 'phase-a')).toThrowError(StorageError);
      } finally {
        db.prepare("UPDATE integration_plans SET integration_result = ? WHERE successor_feature_id = 'feature-c'").run(JSON.stringify(COMPLETE_RESULT));
      }
      // 恢复后可正常读取；跨项目读取保持隔离。
      expect(() => store.readFeatureDag('project-a', 'phase-a')).not.toThrow();
      expect(() => store.readFeatureDag('project-b', 'phase-a')).toThrowError(StorageError);
    } finally {
      box.session.close();
      box.sandbox.cleanup();
    }
  });

  it('[case:integration-plan-query-phase-listing] lists phase plan views with stale reasons in stable order', async () => {
    const box = openBox();
    try {
      await seed(box, { edges: [['feature-c', 'feature-a'], ['feature-c', 'feature-b']] });
      const first = passPlan(box, { successor: 'feature-b' }, T0 + 100);
      const second = passPlan(box, { successor: 'feature-c', targetBaseline: BASELINE_2 }, T0 + 200);
      const atomic = createSqliteAtomicCommandStore(box.session, { nowUtcMs: () => T0 + 300 });
      const current = atomic.transact('integration.get', (tx) => tx.getIntegrationPlan('project-a', second));
      atomic.transact('integration.status', (tx) => tx.updateIntegrationPlanStatus({
        projectId: 'project-a', integrationId: second, expectedRevision: current.revision,
        status: 'stale', blockReasons: [], staleReasons: ['target_baseline_changed'],
      }));
      const query = createSqliteIntegrationPlanQueryStore(createSqliteIntegrationPlanStore(box.session));
      const views = query.listIntegrationPlanViewsByPhase('project-a', 'phase-a');
      expect(views.map((view) => view.plan.integrationId).sort()).toEqual([first, second].sort());
      const staleView = views.find((view) => view.plan.integrationId === second)!;
      expect(staleView.plan.status).toBe('stale');
      expect(staleView.plan.staleReasons).toEqual(['target_baseline_changed']);
      expect(staleView.predecessors.map((predecessor) => predecessor.commitSha)).toEqual([SHA_A, SHA_B]);
      expect(query.listIntegrationPlanViewsByPhase('project-b', 'phase-a')).toEqual([]);
      expect(query.listIntegrationPlanViewsByPhase('project-a', 'phase-missing')).toEqual([]);
    } finally {
      box.session.close();
      box.sandbox.cleanup();
    }
  });
});
