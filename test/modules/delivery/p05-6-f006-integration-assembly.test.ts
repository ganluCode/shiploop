import { describe, expect, it } from 'vitest';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

function catalog() {
  return createStaticRuntimeCapabilityCatalog([{ runtimeId: 'pi', providers: [{ providerId: 'test', models: ['model'] }] }]);
}

describe('P05-6 F-006 production integration assembly', () => {
  it('[case:integration-assembly-fail-closed] leaves generation unavailable without trusted facts', async () => {
    const sandbox = createTempSandbox('shiploop-p05-6-f006-assembly-');
    const app = await openCoreApplication({ dataRoot: `${sandbox.path}/data`, capabilityCatalog: catalog() });
    try {
      expect(app.integrationPlanGeneration).toBeUndefined();
      expect(app.integrationPlanControl.assertSuccessorStart).toBeTypeOf('function');
    } finally {
      app.close();
      sandbox.cleanup();
    }
  });

  it('[case:integration-assembly-invalid-facts-close-session] rejects malformed factory facts and permits reopening the same SQLite root', async () => {
    const sandbox = createTempSandbox('shiploop-invalid-integration-facts-');
    const options = { dataRoot: `${sandbox.path}/data`, capabilityCatalog: catalog() };
    try {
      for (const result of [null, { batches: {}, predecessors: {} },
        { batches: { readApprovedBatch() {} }, predecessors: { readEvidence() {} }, scheduler: null }]) {
        await expect(openCoreApplication({ ...options, integrationPlanFactory: () => result }))
          .rejects.toMatchObject({ kind: 'validation', details: { field: 'integrationPlanFactory' } });
        const reopened = await openCoreApplication(options);
        try { expect(reopened.integrationPlanGeneration).toBeUndefined(); }
        finally { reopened.close(); }
      }
    } finally { sandbox.cleanup(); }
  });

  it('[case:integration-assembly-trusted-facts] assembles generation and control over one plan store', async () => {
    const sandbox = createTempSandbox('shiploop-p05-6-f006-assembly-trusted-');
    const app = await openCoreApplication({
      dataRoot: `${sandbox.path}/data`,
      capabilityCatalog: catalog(),
      integrationPlanFactory: () => ({
        batches: { readApprovedBatch: () => undefined },
        predecessors: { readEvidence: () => undefined },
      }),
    });
    try {
      expect(app.integrationPlanGeneration?.generate).toBeTypeOf('function');
      expect(app.integrationPlanControl.refresh).toBeTypeOf('function');
    } finally {
      app.close();
      sandbox.cleanup();
    }
  });
});
