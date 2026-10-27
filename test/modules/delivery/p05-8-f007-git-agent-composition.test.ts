import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import type { CoreApplicationOptions } from '../../../packages/core/src/adapters/composition.ts';
import type { FeatureDeliveryDependencies } from '../../../packages/core/src/application/feature-delivery-commands.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import type { RuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { openDeliveryVertical } from '../../helpers/p03-8/delivery-vertical.ts';

function catalog(): RuntimeCapabilityCatalog {
  return createStaticRuntimeCapabilityCatalog([
    { runtimeId: 'fake', providers: [{ providerId: 'script', models: ['deterministic'] }] },
  ]);
}

function trustedDelivery(): FeatureDeliveryDependencies {
  return {
    verify: async () => ({ passed: true, reason: 'scripted_verification' }),
    readIntent: input => ({
      projectId: input.projectId,
      featureId: input.featureId,
      runId: input.runId,
      operationId: input.operationId!,
      codeDigest: 'a'.repeat(64),
    }),
    commit: { commit: async () => { throw new Error('commit is not reached by this assembly probe'); } },
    reconciliation: { reconcile: async () => { throw new Error('reconciliation is not reached by this assembly probe'); } },
  };
}

describe('P05-8 F-007 trusted composition root', () => {
  it('[case:git-agent-repair-capability-is-core-owned]', async () => {
    const sandbox = createTempSandbox('shiploop-p058-f007-core-');
    let app: Awaited<ReturnType<typeof openCoreApplication>> | undefined;
    try {
      app = await openCoreApplication({ dataRoot: sandbox.path, capabilityCatalog: catalog() });

      // Core always owns the durable repair authorization/query boundary. A Runtime
      // or delivery adapter is not inferred from the capability catalog alone.
      expect(app.gitAgentRepair).toBeDefined();
      expect(app.workExecution).toBeDefined();
      expect(existsSync(join(sandbox.path, 'core.sqlite'))).toBe(true);
    } finally {
      if (app !== undefined) app.close();
      sandbox.cleanup();
    }
  });

  it('[case:feature-delivery-requires-explicit-trusted-factory]', async () => {
    const sandbox = createTempSandbox('shiploop-p058-f007-trusted-');
    let factoryCalls = 0;
    let app: Awaited<ReturnType<typeof openCoreApplication>> | undefined;
    try {
      app = await openCoreApplication({
        dataRoot: sandbox.path,
        capabilityCatalog: catalog(),
        featureDeliveryFactory: (context: Parameters<NonNullable<CoreApplicationOptions['featureDeliveryFactory']>>[0]) => {
          factoryCalls += 1;
          expect(context.atomicStore).toBeDefined();
          return trustedDelivery();
        },
      });

      expect(factoryCalls).toBe(1);
      expect(app.gitAgentRepair).toBeDefined();
      // The injected delivery adapter is the only route that can make the
      // feature finalization command available; no model/runtime is loaded here.
      expect(app.commandService).toBeDefined();
    } finally {
      if (app !== undefined) app.close();
      sandbox.cleanup();
    }
  });

  it('[case:trusted-composition-runs-scripted-work-and-controlled-commit]', async () => {
    const vertical = await openDeliveryVertical({ taskCommits: true, finalChanges: true });
    const before = vertical.head();
    try {
      await vertical.approve();
      const receipt = await vertical.finalize();

      expect(receipt).toMatchObject({
        status: 'completed',
        result: { outcome: 'completed', runtimeCalled: false, executionStarted: false },
      });
      expect(vertical.head()).not.toBe(before);
      expect(vertical.operations.getGitOperation(vertical.fixture.projectId, vertical.operationId))
        .toMatchObject({ status: 'succeeded', deliveryStatus: 'succeeded' });
      expect(vertical.counts().runtimeCalls).toBeGreaterThan(0);
      expect(vertical.counts().verificationCalls).toBe(1);
      expect(vertical.db.prepare("SELECT COUNT(*) AS n FROM git_operations WHERE status = 'succeeded' AND operation_type = 'feature_final_commit'").get())
        .toEqual({ n: 1 });
    } finally {
      await vertical.close();
    }
  }, 180_000);

  it('[case:untrusted-delivery-assembly-fails-closed]', async () => {
    const sandbox = createTempSandbox('shiploop-p058-f007-invalid-');
    await expect(openCoreApplication({
      dataRoot: sandbox.path,
      capabilityCatalog: catalog(),
      featureDeliveryFactory: () => undefined as unknown as FeatureDeliveryDependencies,
    })).rejects.toMatchObject({ kind: 'validation', details: expect.objectContaining({ reason: 'delivery_adapters_required' }) });
    // A failed trusted assembly must close the opened session and never expose a
    // partially usable application. The data root itself may already exist because
    // validation of the factory result needs the SQLite atomic store.
    expect(existsSync(join(sandbox.path, 'core.sqlite'))).toBe(true);
    rmSync(sandbox.path, { recursive: true, force: true });
  });
});
