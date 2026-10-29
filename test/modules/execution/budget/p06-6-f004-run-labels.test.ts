import { describe, expect, it } from 'vitest';
import { validateExecutionRunInsertInput } from '../../../../packages/core/src/ports/execution-store.ts';
import { SQLITE_MIGRATIONS } from '../../../../packages/core/src/adapters/sqlite/migrations.ts';
import * as schema from '../../../../packages/core/src/adapters/sqlite/schema.ts';
import { getTableColumns } from 'drizzle-orm';
import { openBudgetFixture } from '../../../helpers/p03-3/budget-fixture.ts';

const baseRun = {
  projectId: 'project-1',
  batchId: 'batch-1',
  featureId: 'feature-1',
  runId: 'run-1',
  purpose: 'execute',
  inputSnapshot: { schemaVersion: 1, purpose: 'execute' },
  configSnapshot: { schemaVersion: 1 },
  status: 'queued',
  scopeDigest: 'a'.repeat(64),
  workKey: 'work-1',
  dispatchOrdinal: 1,
  maxAttemptsPerRun: 1,
  runTimeLimitMs: 1000,
  reason: null,
};

describe('F-004 Run labels', () => {
  it('validates and normalizes an explicit creation label field before SQL', () => {
    const validated = validateExecutionRunInsertInput({
      ...baseRun,
      labels: [' Alpha ', 'alpha', 'e\u0301'],
    }, 'test.run.insert');

    expect(validated.labels).toEqual(['alpha', 'é']);
  });

  it('persists creation labels independently of execution snapshots and exposes them via RunRecord', async () => {
    const fixture = await openBudgetFixture();
    try {
      const original = fixture.startEnvelope() as { readonly payload: Record<string, unknown> } & Record<string, unknown>;
      const envelope = {
        ...original,
        payload: { ...original.payload, labels: [' Alpha ', 'alpha', 'e\u0301'] },
      } as never;
      const receipt = await fixture.services.commands.submit(fixture.owner, envelope);
      expect(receipt.status).toBe('accepted');
      const runId = (receipt as { runId: string }).runId;
      const row = fixture.session.database.prepare(
        'SELECT labels, input_snapshot, scope_digest FROM runs WHERE id = ?',
      ).get(runId) as { labels: string; input_snapshot: string; scope_digest: string };
      expect(JSON.parse(row.labels)).toEqual(['alpha', 'é']);
      expect(JSON.parse(row.input_snapshot)).not.toHaveProperty('labels');
      expect(row.scope_digest).toBe(JSON.parse(row.input_snapshot).previewDigest);
      const record = fixture.atomic.transact('read-run-labels', (tx) => tx.getExecutionRun(fixture.projectId, runId));
      expect(record.labels).toEqual(['alpha', 'é']);
    } finally {
      fixture.close();
    }
  });

  it('rejects invalid creation labels without creating a Run', async () => {
    const fixture = await openBudgetFixture();
    try {
      const original = fixture.startEnvelope() as { readonly payload: Record<string, unknown> } & Record<string, unknown>;
      const envelope = {
        ...original,
        payload: { ...original.payload, labels: ['   '] },
      } as never;
      await expect(fixture.services.commands.submit(fixture.owner, envelope)).rejects.toMatchObject({
        code: 'invalid_input',
      });
      expect((fixture.session.database.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it('adds the labels column through the latest migration and Drizzle schema', () => {
    expect(SQLITE_MIGRATIONS.at(-1)?.version).toBe(53);
  });
});
