// Explicit acceptance assembly over the built Host. Only model behavior is Fake.
import { homedir, tmpdir } from 'node:os';
import { startFakeHost } from '../../../packages/host/dist/testing.js';
import { startHost } from '../../../packages/host/dist/index.js';
import { attachThreeTaskProbe, threeTaskRuntime } from './three-task-probe.mjs';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/dist/index.js';
import { createCommandProcessAdapter } from '../../../packages/core/dist/adapters/process/command-process.js';

const config = JSON.parse(process.argv[2]);
const providers = [{ providerId: 'fake-provider', models: ['fake-model'] }];
const options = {
  dataRoot: config.dataRoot,
  env: process.env,
  capabilityCatalog: createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers }]),
};
const host = config.chain ? await startHost({ ...options, workRuntimeFactory: threeTaskRuntime(config) }) : await startFakeHost({
  ...options,
  fake: {
    providers,
    script: config.script,
    commandProcess: createCommandProcessAdapter(),
    ...(config.toolCommands ? { toolCommands: config.toolCommands } : {}),
  },
});
const closeProbe = config.chain ? attachThreeTaskProbe(host, config) : async () => {};
let closing;
function close() {
  closing ??= closeProbe().then(() => host.close()).then(() => { if (process.connected) process.disconnect(); });
  return closing;
}
process.on('message', message => { if (message?.kind === 'close') void close(); });
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
process.on('disconnect', () => void close());
setTimeout(() => void close(), 120_000).unref();
process.send?.({ kind: 'ready', pid: process.pid, cwd: process.cwd(), home: homedir(), tmpdir: tmpdir() });
