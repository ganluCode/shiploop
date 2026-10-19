// Explicit acceptance assembly over the built Host. Only model behavior is Fake.
import { homedir, tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
let delivery;
function deliveryError(operation, error) {
  const diagnostic = { operation, error: String(error), stack: error.stack, details: error.details };
  writeFileSync(join(config.chain.root, 'chain-delivery-error.json'), JSON.stringify(diagnostic));
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
  throw error;
}
async function callDelivery(operation, callback) {
  try { return await callback(); } catch (error) { return deliveryError(operation, error); }
}
const host = config.chain ? await startHost({ ...options, workRuntimeFactory: threeTaskRuntime(config),
  featureDeliveryFactory: () => ({
    verify: input => callDelivery('verify', () => delivery.verify(input)),
    readIntent: input => {
      try { return delivery.readIntent(input); } catch (error) { return deliveryError('readIntent', error); }
    },
    commit: { commit: input => callDelivery('commit', () => delivery.commit.commit(input)) },
    reconciliation: { reconcile: input => callDelivery('reconcile', () => delivery.reconciliation.reconcile(input)) },
  }),
}) : await startFakeHost({
  ...options,
  fake: {
    providers,
    script: config.script,
    commandProcess: createCommandProcessAdapter(),
    ...(config.toolCommands ? { toolCommands: config.toolCommands } : {}),
  },
});
const closeProbe = config.chain ? attachThreeTaskProbe(host, config, dependencies => { delivery = dependencies; }) : async () => {};
let closing;
function close() {
  closing ??= closeProbe().then(() => host.close()).then(() => { if (process.connected) process.disconnect(); });
  return closing;
}
process.on('message', message => { if (message?.kind === 'close') void close(); });
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
process.on('disconnect', () => void close());
setTimeout(() => void close(), config.chain ? 300_000 : 120_000).unref();
process.send?.({ kind: 'ready', pid: process.pid, cwd: process.cwd(), home: homedir(), tmpdir: tmpdir() });
