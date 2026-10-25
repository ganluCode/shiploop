import { describe, expect, it } from 'vitest';
import {
  validateIntegrationStartCommandResultWire,
  validateIntegrationReconcileCommandResultWire,
} from '../../../packages/host/src/client/app-wire.ts';
import {
  buildIntegrationStartCliView,
  buildIntegrationReconcileCliView,
  formatIntegrationReconcileView,
} from '../../../packages/cli/src/app/delivery.ts';

const base = {
  featureId: 'feature-1',
  runId: 'run-1',
  batchId: 'batch-1',
  gitOperationId: 'operation-1',
  reason: 'integration facts matched',
  deliveryStatus: 'succeeded' as const,
  runtimeCalled: false as const,
  executionStarted: false as const,
};

describe('P05-7 F-007 integration Host/CLI projection', () => {
  it('[case:integration-start-wire-and-cli] keeps a started integration pending until Core verification evidence exists', () => {
    const result = validateIntegrationStartCommandResultWire({
      ...base,
      outcome: 'pending_verification',
      reason: null,
      deliveryStatus: null,
      executionStarted: true,
    });
    expect(buildIntegrationStartCliView(result)).toMatchObject({ state: 'pending', canStartSuccessor: false });
  });

  it('[case:integration-reconcile-wire-four-states] accepts Core reconciliation states without treating blocked or unknown as success', () => {
    for (const outcome of ['pending', 'blocked', 'unknown', 'matched'] as const) {
      const result = validateIntegrationReconcileCommandResultWire({ ...base, outcome });
      expect(result.outcome).toBe(outcome);
    }
  });

  it('[case:integration-reconcile-wire-rejects-secret-or-path-fields] rejects extension fields instead of silently exposing them', () => {
    expect(() => validateIntegrationReconcileCommandResultWire({
      ...base,
      outcome: 'matched',
      worktreePath: '/private/worktree',
    })).toThrow();
  });

  it('[case:integration-successor-gate] requires matched and succeeded before successor start is allowed', () => {
    const matched = buildIntegrationReconcileCliView({ ...base, outcome: 'matched' });
    const blocked = buildIntegrationReconcileCliView({ ...base, outcome: 'blocked', deliveryStatus: null });
    const unknown = buildIntegrationReconcileCliView({ ...base, outcome: 'unknown' });

    expect(matched).toMatchObject({ state: 'matched', canStartSuccessor: true });
    expect(blocked).toMatchObject({ state: 'blocked', canStartSuccessor: false });
    expect(unknown).toMatchObject({ state: 'unknown', canStartSuccessor: false });
    expect(formatIntegrationReconcileView(unknown)).toContain('state=unknown');
    expect(formatIntegrationReconcileView(unknown)).toContain('successorStart=false');
  });
});
