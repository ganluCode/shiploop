import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { openFakeCoreApplication } from '../../../packages/core/src/adapters/testing.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { PI_RUNTIME_RECOVERY_DESCRIPTOR } from '../../../packages/host/src/runtime/pi-adapter.ts';
import { startHost, type RunningHost } from '../../../packages/host/src/runtime/host-startup.ts';
import { openBindingFixture, type BindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';
import { createTempSandbox, type TempSandbox } from '../../helpers/temp-sandbox.ts';

const piCatalog = () => createStaticRuntimeCapabilityCatalog([{
  runtimeId: 'pi',
  providers: [{ providerId: 'provider', models: ['model'] }],
  contractVersion: 1,
  permissionGrants: ['fs.read'],
  isolationModes: ['trusted_project'],
}]);

const fakeCatalog = () => createStaticRuntimeCapabilityCatalog([{
  runtimeId: 'fake',
  providers: [{ providerId: 'provider', models: ['model'] }],
}]);

let fixture: BindingFixture | undefined;
let host: RunningHost | undefined;
let sandbox: TempSandbox | undefined;

// This file can be selected independently on a clean worktree, before npm run build.
beforeAll(() => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../../../scripts/build-host-lock.ts', import.meta.url))], { timeout: 60_000 });
});

afterEach(async () => {
  if (host) { await host.close(); host = undefined; }
  fixture?.close(); fixture = undefined;
  sandbox?.cleanup(); sandbox = undefined;
});

describe('F-007 recovery composition root', () => {
  it('[case:host-pi-recovery-assembly] installs the standard Pi recovery descriptor through Host without loading a Runtime executor', async () => {
    fixture = await openBindingFixture();
    host = await startHost({ dataRoot: fixture.box.dataRoot, platform: 'darwin', env: {}, capabilityCatalog: piCatalog() });

    expect(host.core.runtimeRecoveryCatalog.resolve('pi')).toEqual(PI_RUNTIME_RECOVERY_DESCRIPTOR);
    expect(host.core.runtimeRecoveryCatalog.resolve('pi')?.capabilities.executionRecovery.status).toBe('unsupported');
    expect(host.core.workRecoveryContinuation).toBeDefined();
    expect(host.core.runtimeRecovery).toBeDefined();
    expect(host.core.executionStart).toBeDefined();
    expect(host.core.workExecution).toBeDefined();
  });

  it('[case:fake-runtime-recovery-isolation] keeps FakeRuntime separate from Pi recovery evidence and retains Core control ports', async () => {
    sandbox = createTempSandbox('shiploop-f007-fake-');
    const app = await openFakeCoreApplication({ dataRoot: sandbox.path, capabilityCatalog: fakeCatalog(),
      fake: { providers: [{ providerId: 'provider', models: ['model'] }], script: { schemaVersion: 1, steps: [] } } });
    try {
      expect(app.runtimeRecoveryCatalog.resolve('pi')).toBeUndefined();
      expect(app.runtimeRecoveryCatalog.resolve('fake')).toBeUndefined();
      expect(app.runtimeRecovery).toBeDefined();
      expect(app.workRecoveryContinuation).toBeDefined();
      expect(app.executionStart).toBeDefined();
      expect(app.executionStopControl).toBeDefined();
      expect(app.verificationStops).toBeDefined();
    } finally {
      await app.workExecution.close();
      app.close();
    }
  });

  it('[case:core-recovery-source-assembly] accepts only the trusted source reader while keeping recovery a decision and query concern', async () => {
    const calls: string[] = [];
    sandbox = createTempSandbox('shiploop-f007-source-');
    const app = await openCoreApplication({ dataRoot: sandbox.path, capabilityCatalog: piCatalog(),
      runtimeRecoveryDescriptors: [PI_RUNTIME_RECOVERY_DESCRIPTOR], runtimeRecoverySources: {
        readCurrent() { calls.push('current'); return undefined; },
        readSource() { calls.push('source'); return undefined; },
      } });
    try {
      expect(app.runtimeRecoveryCatalog.resolve('pi')).toEqual(PI_RUNTIME_RECOVERY_DESCRIPTOR);
      expect(calls).toEqual([]);
      expect(app.workRecoveryContinuation).toBeDefined();
      expect(app.queryService).toBeDefined();
    } finally {
      app.close();
    }
  });
});
