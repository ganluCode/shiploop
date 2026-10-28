/** Real OS signal fixture: only local Fake MCP and a scripted SDK lifecycle. */
import { writeFileSync } from 'node:fs';
import { runPiWorkRunner } from '../../../packages/host/src/runtime/pi-runner.ts';
import { mcpWorkFixture } from './pi-mcp-fixture.ts';

const fixture = await mcpWorkFixture();
let finish!: () => void;
const idle = new Promise<void>(resolve => { finish = resolve; });
const adapter = fixture.adapter(async () => ({
  subscribe: () => () => {},
  prompt: async () => {
    writeFileSync(process.argv[2]!, JSON.stringify({ root: fixture.box.path, registration: fixture.registrations[0] }));
    await idle;
  },
  waitForIdle: async () => idle,
  abort: async () => { finish(); },
  dispose: () => {},
}));
await runPiWorkRunner({ adapter, input: process.stdin, write: bytes => new Promise<void>((resolve, reject) => {
  process.stdout.write(bytes, error => error ? reject(error) : resolve());
}) });
// Do not mask a product cleanup failure with test-only process termination.
if (fixture.registry.list(fixture.registrations[0]!).length > 0) throw new Error('Runner retained MCP registration');
fixture.box.cleanup();
