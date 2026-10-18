import { describe, expect, it } from 'vitest';
import { fixture } from '../../helpers/p03-6/stopping-fixture.ts';

describe('F-010 active Attempt supervision', () => {
  it('cancels a hanging execution and persists cancellation before retention', async () => {
    const f = await fixture();
    try {
      const { context } = await f.start();
      const outcome = await f.service.cancel(f.identity);
      if (!outcome?.retained && f.retain.mock.results[0]) await f.retain.mock.results[0].value;
      expect(outcome).toMatchObject({ stopConfirmed: true, persisted: true, retained: true });
      expect(f.cancel).toHaveBeenCalled();
      expect(context.controller.signal.aborted).toBe(true);
      expect(f.query('SELECT status, error_kind FROM attempts')).toEqual({ status: 'cancelled', error_kind: null });
      expect(f.retain).toHaveBeenCalledOnce();
      expect(f.retain.mock.calls[0]).toMatchObject([{ reason: 'cancelled', evidenceRef: expect.any(String) }]);
      expect(f.resources.read(f.identity).leases).toEqual([]);
      expect(f.workspaces.readWorkspace(f.projectId, f.featureId)?.status).toBe('retained');
      expect(await f.service.close()).toEqual({ closed: true, pendingAttemptIds: [] });
    } finally { await f.dispose(); }
  });
});
