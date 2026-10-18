// Explicit acceptance assembly over the built Host. Only model behavior is Fake.
import { homedir, tmpdir } from 'node:os';
import { startFakeHost } from '../../../packages/host/dist/testing.js';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/dist/index.js';
import { createCommandProcessAdapter } from '../../../packages/core/dist/adapters/process/command-process.js';

const config = JSON.parse(process.argv[2]);
const providers = [{ providerId: 'fake-provider', models: ['fake-model'] }];
const host = await startFakeHost({
  dataRoot: config.dataRoot,
  env: process.env,
  capabilityCatalog: createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers }]),
  fake: {
    providers,
    script: config.script,
    commandProcess: createCommandProcessAdapter(),
    ...(config.toolCommands ? { toolCommands: config.toolCommands } : {}),
  },
});
let closing;
function close() {
  closing ??= host.close().then(() => { if (process.connected) process.disconnect(); });
  return closing;
}
process.on('message', message => { if (message?.kind === 'close') void close(); });
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
process.on('disconnect', () => void close());
setTimeout(() => void close(), 120_000).unref();
process.send?.({ kind: 'ready', pid: process.pid, cwd: process.cwd(), home: homedir(), tmpdir: tmpdir() });
