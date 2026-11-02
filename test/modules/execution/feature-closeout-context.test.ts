import { expect, it } from 'vitest';
import { openDeliveryVertical } from '../../helpers/p03-8/delivery-vertical.ts';
import { BINDING_NOW } from '../../helpers/p03-6/input-binding-fixture.ts';
import { createSqliteFeatureCloseoutContext } from '../../../packages/core/src/adapters/sqlite/feature-closeout-context.ts';

it('derives scope from authoritative passed Task events, not arbitrary historical batches or files', async () => {
  // Metadata-only policy matches the existing Task verification seed; this test
  // never executes the placeholder command and is not a default Host proof.
  const policy = { checkDefinitions: [{ checkKey: 'tests', scope: 'task' as const, kind: 'command' as const,
    argv: ['npm', 'test'], cwdRef: null, environmentRef: null, timeout: 60_000, required: true, requirementRefs: [] }],
    fullFallback: { checkRefs: ['tests'] }, featureChecks: ['tests'] };
  const f = await openDeliveryVertical({ confirmProjectProfile: true, verificationPolicy: policy });
  try {
    const reader = createSqliteFeatureCloseoutContext(f.fixture.session, { resources: f.core.workResources, nowUtcMs: () => BINDING_NOW });
    const read = () => reader.read(f.fixture.projectId, f.fixture.runId);
    const context = read();
    expect(context.checkKeys).toEqual(['tests']);
    expect(context.proofs.map(proof => proof.taskId)).toEqual(['t-1', 't-2']);
    expect(context.key.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(read().key).toEqual(context.key);
    f.fixture.session.transactWrite('test.diagnosticOnly', () =>
      f.db.prepare("UPDATE runs SET reason='diagnostic_only',revision=revision+1 WHERE id=?").run(context.run.id));
    expect(read().key).toEqual(context.key);
    f.fixture.session.transactWrite('test.manualHold', () =>
      f.db.prepare('UPDATE tasks SET manual_block=1 WHERE project_id=? AND id=?').run(context.key.projectId, 't-1'));
    expect(read).toThrow();
    f.fixture.session.transactWrite('test.removeHold', () =>
      f.db.prepare('UPDATE tasks SET manual_block=0 WHERE project_id=? AND id=?').run(context.key.projectId, 't-1'));
    const wrongBatch = context.proofs.find(proof => proof.taskId === 't-2')!.verificationBatchId;
    f.fixture.session.transactWrite('test.corruptTerminalReference', () =>
      f.db.prepare(`INSERT INTO state_events(id,created_at,updated_at,sequence,occurred_at,project_id,event_type,aggregate_type,aggregate_id,aggregate_revision,payload)
        SELECT 'corrupt-terminal',created_at,updated_at,(SELECT max(sequence)+1 FROM state_events),occurred_at,project_id,event_type,aggregate_type,aggregate_id,aggregate_revision+100,
          json_set(payload,'$.resultRef',?) FROM state_events WHERE project_id=? AND aggregate_id='t-1'
          AND event_type='task.terminal' ORDER BY aggregate_revision DESC LIMIT 1`).run(wrongBatch, context.key.projectId));
    expect(read).toThrow();
  } finally { await f.close(); }
}, 90_000);
