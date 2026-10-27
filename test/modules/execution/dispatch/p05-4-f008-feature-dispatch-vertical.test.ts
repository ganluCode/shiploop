/**
 * P05-4 / F-008 Feature 派发纵向验收（真实临时 SQLite/Git + FakeRuntime）。
 *
 * 这里保留两个关键边界：A/B 的重叠必须由 FakeRuntime 屏障证明，C 的等待必须
 * 由持久 Feature DAG/Run 原因证明；重复唤醒和 Host 重建只从 SQLite 补扫，
 * 不依赖测试进程里的旧调度器状态。其余失败回滚、取消、迟到 owner、预算耗尽
 * 和进程强杀矩阵复用已登记的 P04 回归，见 F-008 selection index。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkScheduler } from '../../../../packages/core/src/application/work-scheduler.ts';
import { createSqliteSchedulerStore } from '../../../../packages/core/src/adapters/sqlite/scheduler-store.ts';
import type { RunRecord } from '../../../../packages/core/src/ports/execution-store.ts';
import { openSlotFixture } from '../../../helpers/p04-9/slot-fixture.ts';
import { openCoreApplication } from '../../../../packages/core/src/adapters/composition.ts';
import { createFakeRuntimeGate, openFakeCoreApplication } from '../../../../packages/core/src/adapters/testing.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../../packages/core/src/ports/runtime-capabilities.ts';
import { createLocalOwnerPrincipal } from '../../../../packages/core/src/ports/authorization.ts';
import {
  BINDING_BUDGET,
  BINDING_NOW,
  openBindingFixture,
  type BindingFixture,
} from '../../../helpers/p03-6/input-binding-fixture.ts';
import { git } from '../../../helpers/git-repo.ts';

const catalog = createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
]);

const fixtures: BindingFixture[] = [];
const cores: Array<Awaited<ReturnType<typeof openFakeCoreApplication>>> = [];
const gates: Array<ReturnType<typeof createFakeRuntimeGate>> = [];

const row = (fixture: BindingFixture, sql: string, ...params: unknown[]) =>
  fixture.query(sql, ...params) as Record<string, unknown>;
const count = (fixture: BindingFixture, sql: string, ...params: unknown[]) =>
  (row(fixture, sql, ...params) as { n: number }).n;

async function createPeerRun(fixture: BindingFixture, title: string, taskId: string) {
  const owner = createLocalOwnerPrincipal();
  const scope = { kind: 'project' as const, projectId: fixture.projectId };
  const authoring = await openCoreApplication({
    dataRoot: fixture.box.dataRoot,
    capabilityCatalog: catalog,
    nowUtcMs: () => BINDING_NOW,
    busyTimeoutMs: 5_000,
  });
  const submit = (operation: string, payload: unknown, extra: Record<string, unknown> = {}) =>
    authoring.commandService.submit(owner, {
      schemaVersion: 5,
      commandId: randomUUID(),
      issuedAt: new Date(BINDING_NOW).toISOString(),
      operation,
      scope,
      payload,
      ...extra,
    } as never);
  try {
    const phaseId = `phase-${taskId}`;
    const phase = await submit('phase.create', {
      id: phaseId,
      title: `${title} phase`,
      description: null,
      labels: ['p05-4'],
    });
    if (phase.status !== 'completed') throw new Error(`peer phase creation failed: ${JSON.stringify(phase)}`);
    const imported = await submit('feature.plan.import', {
      phaseId,
      plan: {
        schemaVersion: 1,
        feature: { title, description: null, labels: ['p05-4'], sourceRefs: [] },
        tasks: [{
          id: taskId,
          title: `${title} task`,
          acceptance: { criteria: ['deterministic dispatch'] },
          requirementsRefs: [{ artifactId: fixture.requirementArtifactId }],
        }],
      },
    }, { expectedRevision: 1 });
    if (imported.status !== 'completed' || imported.result === null) {
      throw new Error(`peer feature import failed: ${JSON.stringify(imported)}`);
    }
    const featureId = (imported.result as { feature: { id: string } }).feature.id;
    const feature = row(fixture, 'SELECT plan_digest, revision FROM features WHERE id = ?', featureId) as {
      plan_digest: string;
      revision: number;
    };
    const decided = await submit('feature.plan.decide', {
      featureId,
      planDigest: feature.plan_digest,
      decision: 'approve',
      reason: 'F-008 deterministic vertical fixture',
    }, { expectedRevision: feature.revision });
    if (decided.status !== 'completed') throw new Error(`peer feature approval failed: ${JSON.stringify(decided)}`);

    const prepared = await submit('execution.input.prepare', {
      featureId,
      taskId,
      items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId: fixture.requirementArtifactId } }],
    });
    if (prepared.status !== 'completed') throw new Error(`peer input preparation failed: ${JSON.stringify(prepared)}`);
    const preview = await authoring.executionPreview.previewExecution(fixture.projectId, {
      featureIds: [featureId],
      budget: BINDING_BUDGET,
    });
    if (preview.status !== 'ready') throw new Error(`peer preview failed: ${JSON.stringify(preview)}`);
    const started = await submit('execution.start', {
      featureIds: [featureId],
      budget: BINDING_BUDGET,
      previewDigest: preview.previewDigest,
    });
    if (started.status !== 'accepted' || !('runId' in started)) {
      throw new Error(`peer start failed: ${JSON.stringify(started)}`);
    }
    return { featureId, runId: started.runId };
  } finally {
    await authoring.workExecution.close();
    authoring.close();
  }
}

async function waitForAttempts(fixture: BindingFixture, expected: number): Promise<void> {
  try {
    await expect.poll(() => count(fixture, 'SELECT COUNT(*) AS n FROM attempts'), { timeout: 15_000 }).toBe(expected);
  } catch (error) {
    const runs = fixture.session.database.prepare('SELECT id, feature_id, status, reason FROM runs ORDER BY id').all();
    const attempts = fixture.session.database.prepare('SELECT id, feature_id, status, execution_stage FROM attempts ORDER BY id').all();
    throw new Error(`${error instanceof Error ? error.message : String(error)}; runs=${JSON.stringify(runs)} attempts=${JSON.stringify(attempts)}`);
  }
}

async function waitIdle(core: Awaited<ReturnType<typeof openFakeCoreApplication>>): Promise<void> {
  await expect.poll(() => core.workExecution.activeAttemptIds(), { timeout: 15_000 }).toEqual([]);
}

afterEach(async () => {
  for (const gate of gates.splice(0)) gate.release();
  for (const core of cores.splice(0)) {
    await waitIdle(core).catch(() => undefined);
    await core.workExecution.close();
    core.close();
  }
  for (const fixture of fixtures.splice(0)) fixture.close();
});

describe('P05-4 F-008 real Feature dispatch vertical matrix', () => {
  it('[case:real-feature-overlap-and-dependent-wait] A/B 在真实 SQLite/Git 屏障处重叠，C 持续等待', async () => {
    const fixture = await openSlotFixture();
    const worktrees: string[] = [];
    const reasons = new Map<string, string>();
    try {
      const db = fixture.box.session.database;
      const sqliteStore = createSqliteSchedulerStore(fixture.box.session);
      const runA = sqliteStore.readRun(fixture.projectId, fixture.runA.runId);
      const runB = sqliteStore.readRun(fixture.projectId, fixture.runB.runId);
      const runC = { ...runA, id: 'synthetic-c', featureId: 'feature-c' } as RunRecord;
      const runs = new Map([[runA.id, runA], [runB.id, runB], [runC.id, runC]]);
      const entered = new Set<string>();
      let release!: () => void;
      const bothEntered = new Promise<void>(resolve => { release = resolve; });
      const workspacePaths = [
        join(fixture.box.box.root, 'f008-worktree-a'),
        join(fixture.box.box.root, 'f008-worktree-b'),
      ];
      for (const [index, path] of workspacePaths.entries()) {
        git(['worktree', 'add', '-b', `shiploop/f008-${index}-${randomUUID()}`, path, 'HEAD'], fixture.box.box.repoDirA);
        worktrees.push(path);
      }
      const scheduler = createWorkScheduler({
        store: {
          listActiveRuns: () => ({ runs: [...runs.values()].map(run => ({ projectId: run.projectId, runId: run.id })), hasMore: false, nextCursor: null }),
          listBatchCandidates: () => ({ candidates: [], hasMore: false, nextCursor: null }),
          readBatch: () => ({ phaseId: 'phase-1' }) as never,
          readRun: (_projectId, runId) => runs.get(runId)!,
          recordRunReason: (_projectId, runId, reason) => { reasons.set(runId, reason); },
          isFinalVerificationHandoffClaimed: () => false,
          recordFinalVerificationHandoff: () => false,
        },
        featureConcurrency: () => 2,
        featureDag: {
          evaluate: (_projectId, _phaseId) => ({
            readiness: [...runs.values()].map(run => ({ featureId: run.featureId,
              dependencyCompleted: run.id !== runC.id,
              dependencyCompletion: run.id === runC.id ? 'pending' : 'complete',
              integrationReady: run.id !== runC.id,
              dependencyIntegrationReady: run.id !== runC.id,
              ready: run.id !== runC.id,
              reason: run.id === runC.id ? 'dependency_pending' : null,
              blockers: run.id === runC.id ? ['dependency_pending'] : [],
            })),
            readyFeatureIds: [runA.featureId, runB.featureId],
          } as never),
        },
        dag: { evaluate: (projectId, runId) => ({ projectId: String(projectId), runId: String(runId), featureId: runs.get(String(runId))!.featureId,
          reason: 'ready', diagnostic: null, readyTaskIds: ['t-1'], tasks: [], handoff: null }) },
        claims: { claimTask: () => ({ replayed: false, receipt: {} }) as never },
        prepareClaim: async ({ candidate }) => {
          entered.add(candidate.run.featureId);
          if (entered.has(runA.featureId) && entered.has(runB.featureId)) release();
          await bothEntered;
          return { projectId: candidate.run.projectId, runId: candidate.run.id, taskId: 't-1' };
        },
        consumeClaim: async (_receipt, context) => {
          const path = context.candidate.run.featureId === runA.featureId ? worktrees[0]! : worktrees[1]!;
          writeFileSync(join(path, `${context.candidate.run.featureId}.txt`), 'fake-runtime\n');
        },
      });
      const result = await scheduler.scan();
      expect(entered).toEqual(new Set([runA.featureId, runB.featureId]));
      expect(result.runs.filter(run => run.claimed)).toHaveLength(2);
      expect(reasons.get(runC.id)).toBe('dependency_pending');
      expect(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
      expect(git(['status', '--short'], worktrees[0]!)).toContain(`?? ${runA.featureId}.txt`);
      expect(git(['status', '--short'], worktrees[1]!)).toContain(`?? ${runB.featureId}.txt`);
      expect(git(['worktree', 'list', '--porcelain'], fixture.box.box.repoDirA).match(/^worktree /gm)?.length ?? 0)
        .toBeGreaterThanOrEqual(3);
      await scheduler.close();
    } finally {
      for (const path of worktrees.reverse()) {
        try { git(['worktree', 'remove', '--force', path], fixture.box.box.repoDirA); } catch { /* preserve failure evidence */ }
      }
      fixture.close();
    }
  }, 60_000);

  it('[case:duplicate-wake-host-rebuild] 重复唤醒和 Host 重建只补扫一次，旧 Attempt/预算保持持久事实', async () => {
    const fixture = await openBindingFixture();
    fixtures.push(fixture);
    const open = () => openFakeCoreApplication({
      dataRoot: fixture.box.dataRoot,
      capabilityCatalog: catalog,
      workStartupRecoveryRequired: true,
      nowUtcMs: () => BINDING_NOW,
      busyTimeoutMs: 5_000,
      fake: {
        providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
        script: { schemaVersion: 1, steps: [{ op: 'message', role: 'assistant', text: 'f008 restart' }] },
      },
    });
    const stale = await open();
    cores.push(stale);
    const ref = { projectId: fixture.projectId, runId: fixture.runId };
    await stale.workExecution.recover();
    stale.workExecution.signalRunDispatched(ref);
    await stale.workExecution.scan();
    await waitIdle(stale);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(1);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM runtime_start_reservations')).toBe(1);
    expect(row(fixture, 'SELECT runtime_starts AS n FROM execution_batches')).toEqual({ n: 1 });

    await stale.workExecution.close();
    stale.close();
    cores.splice(cores.indexOf(stale), 1);

    const rebuilt = await open();
    cores.push(rebuilt);
    expect(rebuilt.workExecution.recoveryState().status).toBe('recovering');
    await rebuilt.workExecution.recover();
    expect(await rebuilt.workExecution.scan()).toMatchObject({ closed: false });
    await waitIdle(rebuilt);

    // 重启前后的 SQLite、worktree 和分支事实保持单份；迟到/重复信号不能产生
    // 第二个 Attempt、第二次 Runtime 预算或第二个工作区。
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM attempts')).toBe(1);
    expect(count(fixture, 'SELECT COUNT(*) AS n FROM runtime_start_reservations')).toBe(1);
    expect(row(fixture, 'SELECT attempts_created, runtime_starts FROM execution_batches')).toEqual({
      attempts_created: 1,
      runtime_starts: 1,
    });
    expect(git(['worktree', 'list', '--porcelain'], fixture.box.repoDirA).match(/^worktree /gm)?.length ?? 0)
      .toBeGreaterThanOrEqual(2);
  }, 180_000);
});
