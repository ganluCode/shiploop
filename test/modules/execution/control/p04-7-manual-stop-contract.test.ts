import { describe, expect, it } from 'vitest';
import {
  EXECUTION_STOP_MANUAL_ACTIONS,
  validateExecutionStopManualPayload,
} from '../../../../packages/core/src/ports/execution-stop-manual.ts';
import { validateCommandEnvelope } from '../../../../packages/core/src/ports/commands.ts';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';

function payload(action: string): Record<string, unknown> {
  return { stopOperationId: OPERATION_ID, action, evidenceRef: null };
}

describe('P04-7 / F-006 execution stop manual contract', () => {
  it('accepts only the five bounded actions and preserves null evidence', () => {
    for (const action of EXECUTION_STOP_MANUAL_ACTIONS) {
      expect(validateExecutionStopManualPayload(payload(action))).toEqual({
        stopOperationId: OPERATION_ID,
        action,
        evidenceRef: null,
      });
    }
  });

  it('rejects unknown actions and unknown payload keys', () => {
    expect(() => validateExecutionStopManualPayload(payload('force_kill'))).toThrow();
    expect(() => validateExecutionStopManualPayload({ ...payload('acknowledge'), pid: 42 })).toThrow();
  });

  it('validates the command envelope as a project scoped CAS command', () => {
    const envelope = validateCommandEnvelope({
      schemaVersion: 5,
      operation: 'execution.stop.manual',
      commandId: '22222222-2222-4222-8222-222222222222',
      issuedAt: '2026-10-20T12:00:00.000Z',
      scope: { kind: 'project', projectId: OPERATION_ID },
      expectedRevision: 3,
      payload: payload('retry_probe'),
    });
    expect(envelope.operation).toBe('execution.stop.manual');
    expect(envelope.expectedRevision).toBe(3);
  });
});
