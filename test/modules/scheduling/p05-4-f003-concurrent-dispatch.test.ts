import { describe, expect, it } from 'vitest';
import { createSqliteExecutionSlotAccess } from '../../../packages/core/src/adapters/sqlite/execution-slots.ts';
import { isStorageError } from '../../../packages/core/src/ports/errors.ts';
import { resolveApprovedBatchConcurrency } from '../../../packages/core/src/ports/feature-dispatch.ts';
import { acquireInput, openSlotFixture } from '../../helpers/p04-9/slot-fixture.ts';

function rejection(run: () => unknown): { kind: string; reason: unknown } {
  try {
    run();
  } catch (error) {
    if (!isStorageError(error)) throw error;
    return { kind: error.kind, reason: error.details?.reason };
  }
  throw new Error('expected a structured rejection');
}

describe('P05-4 F-003 concurrent Feature dispatch admission', () => {
  it('[case:approved-policy-drift-rejected] Batch 快照并发字段漂移或越界时 fail-closed', () => {
    expect(resolveApprovedBatchConcurrency({ schemaVersion: 1 })).toBe(1);
    expect(resolveApprovedBatchConcurrency({ concurrency: { maxConcurrentWorks: 4, maxConcurrentFeatures: 4 } })).toBe(4);
    expect(() => resolveApprovedBatchConcurrency({ concurrency: { maxConcurrentWorks: 2, maxConcurrentFeatures: 3 } }))
      .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'batch_concurrency_invalid' }) }));
    expect(() => resolveApprovedBatchConcurrency({ concurrency: { maxConcurrentWorks: 17 } }))
      .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'batch_concurrency_unsupported' }) }));
    expect(() => resolveApprovedBatchConcurrency({ concurrency: { maxConcurrentWorks: 0 } }))
      .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'batch_concurrency_invalid' }) }));
  });


  it('[case:approved-finite-capacity] 批准的有限容量允许多个不同 Feature 占用槽位', async () => {
    const f = await openSlotFixture();
    try {
      const access = createSqliteExecutionSlotAccess(f.box.session, { capacity: 2, nowUtcMs: () => f.now() });
      const first = f.box.session.transactWrite('test.multi-slot-a', () => access.acquireInTransaction(acquireInput(f, 'A')));
      const second = f.box.session.transactWrite('test.multi-slot-b', () => access.acquireInTransaction(acquireInput(f, 'B')));
      expect([first.slotIndex, second.slotIndex].sort()).toEqual([0, 1]);
      expect(f.slotRows()).toHaveLength(2);
      expect(rejection(() => f.box.session.transactWrite('test.multi-slot-over-capacity', () => access.acquireInTransaction({
        ...acquireInput(f, 'A'), claimId: f.claimA, ownerId: 'other-owner', hostInstanceId: 'other-host',
      })))).toMatchObject({ kind: 'ownership' });
    } finally {
      f.close();
    }
  });
});
