/** Real Runner + detached Fake MCP group. SIGKILL deliberately bypasses fixture cleanup. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { RuntimeExecutionRequest } from '../../../packages/core/src/index.ts';
import { runPiWorkRunner } from '../../../packages/host/src/runtime/pi-runner.ts';
import { mcpWorkFixture } from '../p06-4/pi-mcp-fixture.ts';

const bytes = readFileSync(0);
const request = JSON.parse(bytes.toString('utf8')) as RuntimeExecutionRequest;
const fixture = await mcpWorkFixture({ projectId: request.projectId, server: { spawnChild: true, holdOnStdinEnd: true } });
let finish!: () => void;
const idle = new Promise<void>(resolve => { finish = resolve; });
const adapter = fixture.adapter(async () => ({
  subscribe: () => () => {},
  prompt: async () => {
    writeFileSync(process.argv[2]!, JSON.stringify({ root: fixture.box.path,
      registryPath: join(fixture.box.path, 'registry.json'), registration: fixture.registrations[0],
      childPid: Number(readFileSync(join(fixture.box.path, 'child.pid'), 'utf8')) }));
    await idle;
  },
  waitForIdle: async () => idle,
  abort: async () => { finish(); }, dispose: () => {},
}));
await runPiWorkRunner({ adapter, input: Readable.from([bytes]), write: data => new Promise<void>((resolve, reject) => {
  process.stdout.write(data, error => error ? reject(error) : resolve());
}) });
if (fixture.registry.list(fixture.registrations[0]!).length > 0) throw new Error('Runner retained MCP registration');
fixture.box.cleanup();
