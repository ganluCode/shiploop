/** Trusted offline assembly: real Pi adapter/protocol, controlled session, no model or tool calls. */
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import { runPiWorkRunner } from '../../packages/host/src/runtime/pi-runner.ts';
import { createPiRuntimeAdapter } from '../../packages/host/src/runtime/pi-adapter.ts';

const mode = process.env.SHIPLOOP_TEST_PI_MODE;
let listener: ((event: unknown) => void) | undefined;
let finish!: () => void;
const gate = new Promise<void>(resolve => { finish = resolve; });
const registration = createPiRuntimeAdapter({
  providers: [{ providerId: 'provider', models: ['model'] }], permissionGrants: [], isolationModes: ['trusted_project'],
  assembly: { agentDir: process.cwd(), resolveWorkingDirectory: () => process.cwd(),
    credentialRef: { kind: 'trusted-resolution', id: 'offline-test' },
    inputReader: { read: async () => 'offline bound input' },
    resourceLoader: {} as NonNullable<CreateAgentSessionOptions['resourceLoader']> },
  sessionFactory: async () => ({
    sessionId: 'offline-pi-session',
    subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
    async prompt() {
      listener?.({ type: 'message_end', message: { id: 'message-1', role: 'assistant', content: [{ text: 'Pi Work evidence' }],
        usage: { input: 5, output: 2 } } });
      if (mode === 'crash' || mode === 'cancel') await gate;
      listener?.({ type: 'agent_settled' });
    },
    async waitForIdle() {}, async abort() { finish(); }, dispose() {},
  }),
});
await runPiWorkRunner({ adapter: registration.adapter, input: process.stdin,
  write: bytes => new Promise<void>((resolve, reject) => {
    process.stdout.write(bytes, error => {
      if (error) { reject(error); return; }
      resolve();
      const frame = JSON.parse(Buffer.from(bytes).toString()) as { kind: string; body: { sequence?: number } };
      if (mode === 'crash' && frame.kind === 'event' && frame.body.sequence === 2) process.exit(7);
    });
  }) });
