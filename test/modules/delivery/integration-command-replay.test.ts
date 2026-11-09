import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createDeterministicIntegrationService } from '../../../packages/core/src/application/deterministic-integration.ts';
import { stableCanonicalJson } from '../../../packages/core/src/ports/command-receipts.ts';

function fixture() {
  const request = { projectId: 'project-1', operationId: 'a'.repeat(64),
    commandId: 'a1000000-0000-4000-8000-000000000001', expectedFeatureRevision: 1, inputDigest: 'b'.repeat(64) };
  const { commandId: _command, ...body } = request;
  const command = { operationId: request.operationId,
    requestDigest: createHash('sha256').update(stableCanonicalJson(body)).digest('hex') };
  const recorded = { outcome: 'unknown' as const, reason: 'stop_unconfirmed', workspace: null, steps: [] };
  const journal = { readCommand: vi.fn(() => command), read: vi.fn(() => recorded), claim: vi.fn(), append: vi.fn() };
  const readAuthorization = vi.fn(() => { throw new Error('authorization is no longer current'); });
  const verifyWriterStopped = vi.fn(async () => false);
  const workspace = { prepare: vi.fn(), merge: vi.fn(), cleanup: vi.fn() };
  const atomic = { transact: (_op: string, callback: (tx: any) => unknown) => callback({}) } as any;
  const service = createDeterministicIntegrationService({ atomic, journal, workspace, readAuthorization, verifyWriterStopped });
  return { service, request, recorded, journal, readAuthorization, verifyWriterStopped, workspace };
}

describe('integration command replay', () => {
  it('[case:integration-command-replay-after-cancellation] returns the original observation after cancellation or lease expiry without re-admitting a writer', async () => {
    const f = fixture();
    await expect(f.service.start(f.request)).resolves.toEqual(f.recorded);
    expect(f.readAuthorization).not.toHaveBeenCalled();
    expect(f.verifyWriterStopped).not.toHaveBeenCalled();
    expect(f.workspace.prepare).not.toHaveBeenCalled();
    expect(f.journal.claim).not.toHaveBeenCalled();
  });

  it('[case:integration-command-reuse-rejected] rejects changed input under the same command before touching authorization or Git', async () => {
    const f = fixture();
    await expect(f.service.start({ ...f.request, expectedFeatureRevision: 2 }))
      .rejects.toMatchObject({ details: { reason: 'idempotency_key_reuse' } });
    expect(f.readAuthorization).not.toHaveBeenCalled();
    expect(f.workspace.prepare).not.toHaveBeenCalled();
  });

  it('[case:integration-command-incomplete-needs-reconciliation] does not replay uncertain external I/O when only admission is durable', async () => {
    const f = fixture();
    f.journal.read.mockReturnValue(null as any);
    await expect(f.service.start(f.request)).rejects.toMatchObject({ details: { reason: 'reconciliation_required' } });
    expect(f.workspace.prepare).not.toHaveBeenCalled();
    expect(f.readAuthorization).not.toHaveBeenCalled();
  });
});
