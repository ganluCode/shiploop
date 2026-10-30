import { createOfflineRestoreService } from '../../packages/host/src/runtime/offline-restore.ts';
import { startHost } from '../../packages/host/src/runtime/host-startup.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../packages/core/src/ports/runtime-capabilities.ts';
import { runBarrierChild } from './host/child-runtime.ts';

await runBarrierChild({
  scenario: {
    name: 'offline-restore',
    async onGo({ config, closeRequested }) {
      const dataRoot = String(config.dataRoot);
      if (config.mode === 'host') {
        const host = await startHost({ dataRoot, env: {}, lockTimeoutMs: 0,
          capabilityCatalog: createStaticRuntimeCapabilityCatalog([]) });
        try {
          process.send!({ kind: 'host_ready', hostInstanceId: host.hostInstanceId, dataRootIdentity: host.dataRootIdentity,
            isolated: host.core.dataRestoreIsolation, recovery: host.core.workExecution.recoveryState() });
          await closeRequested;
        } finally { await host.close(); }
        return;
      }
      const service = createOfflineRestoreService({ dataRoot,
        async boundary(point) {
          if (point === config.boundary) {
            process.send!({ kind: 'boundary', point });
            await closeRequested;
            throw new Error('test-interrupted');
          }
        },
      });
      const result = config.mode === 'prepare'
        ? await service.prepare({ operationId: String(config.operationId), packagePath: String(config.packagePath) })
        : await service.confirm({ operationId: String(config.operationId), confirmation: config.confirmation });
      process.send!({ kind: 'result', result });
    },
  },
});
