import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteFeatureDagStore } from '../../../packages/core/src/adapters/sqlite/feature-dag-store.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { evaluateFeatureDag } from '../../../packages/core/src/ports/feature-dag.ts';
import type { IntegrationPlanInput, IntegrationResult } from '../../../packages/core/src/ports/integration-plan.ts';
import { assertGitAvailable, commitAll, initGitRepo, git } from '../../helpers/git-repo.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

/**
 * P07 DAG / F-004：菱形 DAG（A→B、A→C、B+C→D）的真实临时 Git/SQLite 证据链。
 * 该场景按阶段验收范围登记为 Phase 集成用例：真实 git commit 作为固定交付成果，
 * SQLite 权威 integration plan 提供证据；断言证据不随仓库 HEAD 漂移。
 */
const T0 = 1_700_200_000_000;
const VERIFY_DIGEST = createHash('sha256').update('diamond-verify').digest('hex');

describe('P07 DAG F-004 diamond integration evidence chain', () => {
  it('[case:feature-dag-diamond-real-git-chain] gates B/C/D readiness on fixed evidence, not HEAD drift', async () => {
    assertGitAvailable();
    const sandbox = createTempSandbox('shiploop-f004-diamond-');
    const session = openSqliteStorageSession({ path: join(sandbox.path, 'state.db') });
    try {
      // 真实临时 Git 仓库：A/B/C 的交付成果均为真实 commit。
      const repo = join(sandbox.path, 'repo');
      initGitRepo(repo);
      git(['checkout', '-b', 'trunk'], repo);
      const write = (name: string, content: string): void => {
        writeFileSync(join(repo, name), content);
      };
      write('base.txt', 'base\n');
      const baseCommit = commitAll(repo, 'base');
      write('a.txt', 'A delivery\n');
      const deliveryA = commitAll(repo, 'feature-a delivery');
      write('b.txt', 'B delivery\n');
      const deliveryB = commitAll(repo, 'feature-b delivery');
      write('c.txt', 'C delivery\n');
      const deliveryC = commitAll(repo, 'feature-c delivery');

      await migrateSqliteStorage(session, { nowUtcMs: () => T0 });
      session.transactWrite('f004.diamond.seed', (db) => {
        db.prepare("INSERT INTO projects (id, created_at, revision, updated_at, display_name, status, labels) VALUES ('project-a', ?, 1, ?, 'A', 'active', '[]')").run(T0, T0);
        db.prepare("INSERT INTO phases (id, created_at, project_id, revision, updated_at, title, status, description, labels) VALUES ('phase-a', ?, 'project-a', 1, ?, 'Phase A', 'open', NULL, '[]')").run(T0, T0);
        const feature = db.prepare("INSERT INTO features (id, created_at, project_id, revision, updated_at, phase_id, title, status, plan_status, description, labels, source_refs, plan_digest) VALUES (?, ?, 'project-a', 1, ?, 'phase-a', ?, 'completed', 'approved', NULL, '[]', '[]', NULL)");
        for (const id of ['feature-a', 'feature-b', 'feature-c', 'feature-d']) feature.run(id, T0, T0, id);
        db.prepare("INSERT INTO execution_batches (id, created_at, project_id, revision, updated_at, phase_id, feature_id, scope_snapshot, config_snapshot, status, budget_revision, budget_snapshot, runs_created, attempts_created, runtime_starts, no_progress_runs, deadline_at) VALUES ('batch-a', ?, 'project-a', 1, ?, 'phase-a', 'feature-d', '{\"featureIds\":[\"feature-d\"]}', '{}', 'succeeded', 1, '{}', 0, 0, 0, 0, ?)").run(T0, T0, T0 + 1000);
        const edge = db.prepare('INSERT INTO feature_dependencies (id, created_at, project_id, revision, updated_at, phase_id, feature_id, depends_on_id, code_baseline_ref) VALUES (?, ?, ' + "'project-a', 1, ?, 'phase-a', ?, ?, NULL)");
        for (const [featureId, dependsOnId] of [
          ['feature-b', 'feature-a'], ['feature-c', 'feature-a'],
          ['feature-d', 'feature-b'], ['feature-d', 'feature-c'],
        ] as const) edge.run(`edge-${featureId}-${dependsOnId}`, T0, T0, featureId, dependsOnId);
      });

      const store = createSqliteFeatureDagStore(session);
      const blockedBefore = evaluateFeatureDag(store.readFeatureDag('project-a', 'phase-a'));
      expect(blockedBefore.readiness.find((item) => item.featureId === 'feature-b')).toMatchObject({ reason: 'integration_not_ready', ready: false });
      expect(blockedBefore.readiness.find((item) => item.featureId === 'feature-d')).toMatchObject({ reason: 'integration_not_ready', ready: false });

      const completeResult = (commitSha: string): IntegrationResult => ({
        commitSha, treeSha: git(['rev-parse', `${commitSha}^{tree}`], repo).trim(),
        verificationEvidence: { evidenceId: 'verify-diamond', evidenceDigest: VERIFY_DIGEST },
        llmNoConflictText: null,
      });
      const passPlan = (successor: 'feature-b' | 'feature-c' | 'feature-d', at: number, baseline: string, deliveries: Record<string, string>): string => {
        const atomic = createSqliteAtomicCommandStore(session, { nowUtcMs: () => at });
        const input: IntegrationPlanInput = {
          projectId: 'project-a', phaseId: 'phase-a', batchId: 'batch-a', successorFeatureId: successor,
          targetBaseline: baseline,
          predecessors: Object.keys(deliveries).map((featureId) => ({
            projectId: 'project-a', phaseId: 'phase-a', featureId, dependencyPassed: true,
            delivery: { commitSha: deliveries[featureId]!, evidenceId: `delivery-${featureId}`, evidenceDigest: createHash('sha256').update(`delivery-${featureId}`).digest('hex') },
            coveredInputIds: [`input-${featureId}`],
            ancestorVerified: true,
          })),
          approvedInputs: Object.keys(deliveries).map((featureId) => ({ inputId: `input-${featureId}`, digest: createHash('sha256').update(`input-${featureId}`).digest('hex') })),
          mergeOrder: Object.keys(deliveries),
          verificationScope: ['typecheck'],
          strategySummary: { conflictPolicy: 'deterministic-only' },
          integrationResult: null,
        };
        const created = atomic.transact('integration.create', (tx) => tx.createIntegrationPlan(input));
        const frozen = atomic.transact('integration.freeze', (tx) => tx.freezeIntegrationPlan({ projectId: 'project-a', integrationId: created.integrationId, expectedRevision: created.revision }));
        const result = atomic.transact('integration.result', (tx) => tx.updateIntegrationPlanResult({
          projectId: 'project-a', integrationId: created.integrationId, expectedRevision: frozen.revision,
          integrationResult: completeResult(deliveries[Object.keys(deliveries)[0]!]!),
        }));
        expect(result.status).toBe('integration_passed');
        return created.integrationId;
      };

      // A 集成进 B 基线：B 就绪；C/D 仍被各自证据阻塞。
      passPlan('feature-b', T0 + 100, baseCommit, { 'feature-a': deliveryA });
      const afterB = evaluateFeatureDag(store.readFeatureDag('project-a', 'phase-a'));
      expect(afterB.readiness.find((item) => item.featureId === 'feature-b')).toMatchObject({ ready: true, reason: 'ready' });
      expect(afterB.readiness.find((item) => item.featureId === 'feature-c')).toMatchObject({ reason: 'integration_not_ready' });
      expect(afterB.readiness.find((item) => item.featureId === 'feature-d')).toMatchObject({ reason: 'integration_not_ready' });
      // A 部分集成（B 通过、C 未通过）：节点级证据保持缺失。
      expect(store.readFeatureDag('project-a', 'phase-a').features.find((feature) => feature.id === 'feature-a')?.integrationEvidence).toBeNull();

      // A 集成进 C 基线：C 就绪，A 节点级证据聚合为真实交付 SHA（多消费方，不投影歧义字段）。
      passPlan('feature-c', T0 + 200, baseCommit, { 'feature-a': deliveryA });
      const afterC = store.readFeatureDag('project-a', 'phase-a');
      expect(evaluateFeatureDag(afterC).readiness.find((item) => item.featureId === 'feature-c')).toMatchObject({ ready: true, reason: 'ready' });
      expect(afterC.features.find((feature) => feature.id === 'feature-a')?.integrationEvidence).toMatchObject({
        commitSha: deliveryA,
        evidenceDigest: createHash('sha256').update('delivery-feature-a').digest('hex'),
        status: 'passed',
      });

      // B+C 集成进 D 基线：菱形收口，D 就绪。
      passPlan('feature-d', T0 + 300, baseCommit, { 'feature-b': deliveryB, 'feature-c': deliveryC });
      const final = evaluateFeatureDag(store.readFeatureDag('project-a', 'phase-a'));
      expect(final.readiness.find((item) => item.featureId === 'feature-d')).toMatchObject({
        ready: true, reason: 'ready', dependencyCompleted: true, dependencyIntegrationReady: true,
        dependencyStaleReasons: [], dependencyBlockReasons: [],
      });
      expect(final.readyFeatureIds).toEqual(['feature-a', 'feature-b', 'feature-c', 'feature-d']);

      // 仓库 HEAD 漂移后证据不变：不从当前 HEAD 或分支推导代码成果。
      git(['checkout', '-b', 'drift-branch'], repo);
      write('drift.txt', 'later head\n');
      const driftedHead = commitAll(repo, 'head moves after evidence');
      expect(driftedHead).not.toBe(baseCommit);
      const afterDrift = store.readFeatureDag('project-a', 'phase-a');
      expect(afterDrift.features.find((feature) => feature.id === 'feature-a')?.integrationEvidence).toMatchObject({ commitSha: deliveryA });
      expect(evaluateFeatureDag(afterDrift).readiness.find((item) => item.featureId === 'feature-d')).toMatchObject({ ready: true, reason: 'ready' });
    } finally {
      session.close();
      sandbox.cleanup();
    }
  });
});
