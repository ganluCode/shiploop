import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { BUDGET, openBudgetFixture, type BudgetFixture } from '../../../helpers/p03-3/budget-fixture.ts';

const fixtures: BudgetFixture[] = [];
const RESUME_BUDGET = {
  ...BUDGET,
  batch: { ...BUDGET.batch, maxRuns: 10, maxTotalAttempts: 10, maxRuntimeStarts: 10 },
};

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function featureTarget(featureId: string) {
  return { featureId, runId: null, batchId: null };
}

function featureRevision(fixture: BudgetFixture): number {
  return (fixture.session.database.prepare('SELECT revision FROM features WHERE id = ?')
    .get(fixture.featureId) as { revision: number }).revision;
}

function runState(fixture: BudgetFixture, runId: string): { status: string; revision: number } {
  return fixture.session.database.prepare('SELECT status, revision FROM runs WHERE id = ?')
    .get(runId) as { status: string; revision: number };
}

describe('P05-5 F-006 Feature 范围控制', () => {
  it('[case:feature-pause-cas-and-replay] Feature 暂停只改变目标 Run，revision/CAS 与命令重放保持持久幂等', async () => {
    const fixture = await openBudgetFixture(BUDGET);
    fixtures.push(fixture);
    const started = await fixture.start();
    const revision = featureRevision(fixture);
    const commandId = randomUUID();
    const envelope = fixture.envelope('execution.pause', featureTarget(fixture.featureId), {
      commandId,
      scope: fixture.scope,
      expectedRevision: revision,
    });

    const first = await fixture.services.commands.submit(fixture.owner, envelope);
    expect(first.status).toBe('completed');
    if (first.status !== 'completed') throw new Error(`feature pause failed: ${JSON.stringify(first)}`);
    const firstResult = first.result;
    expect(firstResult).toMatchObject({ targetKind: 'feature', targetId: fixture.featureId, status: 'paused', revision: revision + 1 });
    expect(runState(fixture, started.runId).status).toBe('paused');
    expect(featureRevision(fixture)).toBe(revision + 1);

    const replay = await fixture.services.commands.submit(fixture.owner, envelope);
    expect(replay).toMatchObject({ status: 'completed', replayed: true, result: firstResult });
    expect(featureRevision(fixture)).toBe(revision + 1);

    const conflicting = fixture.services.commands.submit(fixture.owner, {
      ...envelope,
      payload: { ...featureTarget(fixture.featureId), featureId: '00000000-0000-4000-8000-000000000001' },
    });
    await expect(conflicting).rejects.toMatchObject({ code: 'conflict', details: { reason: 'idempotency_key_reuse' } });
    expect(featureRevision(fixture)).toBe(revision + 1);
  });

  it('[case:feature-resume-stale-and-occupancy] Feature 恢复使用 Feature revision，旧 revision 或隔离占用阻止重新派发', async () => {
    const fixture = await openBudgetFixture(RESUME_BUDGET);
    fixtures.push(fixture);
    const taskConfig = fixture.session.database.prepare('SELECT execution_config FROM tasks WHERE id = ?').get('t-1') as { execution_config: string };
    fixture.session.database.prepare('UPDATE tasks SET execution_config = ? WHERE id = ?')
      .run(JSON.stringify({ ...JSON.parse(taskConfig.execution_config), maxCodeAttempts: 3 }), 't-1');
    const preview = await fixture.services.preview.previewExecution(fixture.projectId, { featureIds: [fixture.featureId], budget: RESUME_BUDGET });
    if (preview.status !== 'ready') throw new Error(`resume fixture preview failed: ${JSON.stringify(preview)}`);
    const startedReceipt = await fixture.submit('execution.start', {
      featureIds: [fixture.featureId], budget: RESUME_BUDGET, previewDigest: preview.previewDigest,
    }, { scope: fixture.scope });
    if (startedReceipt.status !== 'accepted' || !('runId' in startedReceipt)) throw new Error(`resume fixture start failed: ${JSON.stringify(startedReceipt)}`);
    const started = { runId: startedReceipt.runId };
    const pauseRevision = featureRevision(fixture);
    const paused = await fixture.submit('execution.pause', featureTarget(fixture.featureId), {
      scope: fixture.scope,
      expectedRevision: pauseRevision,
    });
    expect(paused.status).toBe('completed');
    const currentRevision = featureRevision(fixture);

    const stale = await fixture.submit('execution.resume', featureTarget(fixture.featureId), {
      scope: fixture.scope,
      expectedRevision: pauseRevision,
    });
    expect(stale).toMatchObject({ status: 'rejected', error: { code: 'conflict' } });
    expect(runState(fixture, started.runId).status).toBe('paused');

    const resumed = fixture.atomic.transact('test.feature.resume', transaction => transaction.resumeExecution({
      projectId: fixture.projectId,
      targetKind: 'feature',
      targetId: fixture.featureId,
      expectedRevision: currentRevision,
      workspace: null,
    }));
    expect(resumed).toMatchObject({ outcome: 'resumed', targetKind: 'feature', targetId: fixture.featureId, runIds: [started.runId] });
    expect(runState(fixture, started.runId).status).toBe('queued');
    expect(featureRevision(fixture)).toBe(currentRevision + 1);
  });
});
