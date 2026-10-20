/** F-005 real signal/control bridge, without provider calls or external tools. */
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import { runPiWorkRunner } from '../../packages/host/src/runtime/pi-runner.ts';
import { createPiRuntimeAdapter } from '../../packages/host/src/runtime/pi-adapter.ts';

let finish!: () => void;
const idle = new Promise<void>(resolve => { finish = resolve; });
let listener: ((event: unknown) => void) | undefined;
const registration = createPiRuntimeAdapter({
  providers: [{ providerId: 'provider', models: ['model'] }],
  permissionGrants: ['fs.read'], isolationModes: ['trusted_project'],
  assembly: { agentDir: process.cwd(), resolveWorkingDirectory: () => process.cwd(),
    credentialRef: { kind: 'trusted-resolution', id: 'test-only' },
    inputReader: { read: async () => 'bound input' },
    resourceLoader: {} as NonNullable<CreateAgentSessionOptions['resourceLoader']>,
  },
  sessionFactory: async () => ({
    subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
    async prompt() {
      listener?.({ type: 'message_end', message: { id: 'ready', role: 'assistant', content: [{ text: 'runner-ready' }],
        usage: { input: 5, output: 2 } } });
      await idle;
    },
    async abort() { finish(); },
    async waitForIdle() { await idle; },
    dispose() {},
  }),
});
await runPiWorkRunner({ adapter: registration.adapter, input: process.stdin, write: bytes => new Promise<void>((resolve, reject) => {
  process.stdout.write(bytes, error => error ? reject(error) : resolve());
}) });
