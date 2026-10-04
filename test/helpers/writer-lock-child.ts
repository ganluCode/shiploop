/** F-004 only: real writer, IPC barrier before lock, Core opened only by winner. */
import { openCoreApplication } from '../../packages/core/src/adapters/composition.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../packages/core/src/ports/runtime-capabilities.ts';
import {
  openLockedWriter,
  resolveCanonicalDataRoot,
  isHostProtocolError,
} from '../../packages/host/src/index.ts';

const dataRoot = process.argv[2]!;
let writer: Awaited<ReturnType<typeof openLockedWriter>> | undefined;
process.send!({ kind: 'ready', pid: process.pid });
process.on('message', async (command) => {
  try {
    if (command === 'go') {
      const root = resolveCanonicalDataRoot({ dataRoot });
      writer = await openLockedWriter({ canonicalRoot: root.canonicalRoot, timeoutMs: 150 }, async () => {
        process.send!({ kind: 'opening', pid: process.pid });
        return openCoreApplication({
          dataRoot: root.canonicalRoot,
          capabilityCatalog: createStaticRuntimeCapabilityCatalog([
            { runtimeId: 'test', providers: [{ providerId: 'test', models: ['test'] }] },
          ]),
        });
      });
      process.send!({ kind: 'acquired', pid: process.pid });
    } else if (command === 'close') {
      await writer?.close();
      process.send!({ kind: 'closed', pid: process.pid });
      process.exit(0);
    }
  } catch (error) {
    process.send!({ kind: 'rejected', code: isHostProtocolError(error) ? error.code : 'unexpected' });
    process.exit(1);
  }
});
setTimeout(() => process.exit(9), 20_000).unref();
