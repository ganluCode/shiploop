import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpClient, StdioTransport } from '@earendil-works/pi-mcp';
import { describe, expect, it } from 'vitest';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { processRows, until } from '../../helpers/process-matrix.ts';
import { createFakeMcpServerCommand, waitForFakeMcpFile, type FakeMcpServerOptions } from '../../helpers/mcp-stdio-fake-server.ts';

/** Tests the fixture's fault controls, not the future production tool dispatcher. */
async function withFake(options: FakeMcpServerOptions, run: (client: McpClient, root: string) => Promise<void>) {
  const box = createTempSandbox('shiploop-mcp-fake-');
  const command = createFakeMcpServerCommand(box.path, options);
  const transport = new StdioTransport({ command: command.executable, args: command.argv, cwd: box.path,
    env: {}, inheritEnv: false, closeTimeoutMs: 100, maxMessageBytes: 3_000_000 });
  const client = new McpClient({ name: 'fixture-test', version: '1', requestTimeoutMs: 500 });
  let pid: number | undefined;
  try {
    await client.connect(transport);
    pid = transport.pid;
    await waitForFakeMcpFile(join(box.path, 'ready'));
    await run(client, box.path);
  } finally {
    await client.close();
    await until(async () => !(await processRows()).some(row => row.processGroupId === pid), 'Fake server group absent');
    box.cleanup();
  }
}

describe('P06-4 F-002 controlled Fake MCP server', () => {
  it('[case:fake-ready-call-exit-barriers] exposes ready, call identity and exit barriers with a controlled child', async () => {
    await withFake({ spawnChild: true }, async (client, root) => {
      const child = Number(readFileSync(join(root, 'child.pid'), 'utf8'));
      const parent = Number(readFileSync(join(root, 'server.pid'), 'utf8'));
      const rows = await processRows();
      expect(rows.find(row => row.pid === child)?.processGroupId).toBe(parent);
      expect((await client.listTools()).map(t => t.name)).toEqual(['echo']);
      expect(await client.callTool('echo', { sample: 'payload' })).toMatchObject({ content: [{ text: 'fake result' }] });
      const entered = JSON.parse(readFileSync(join(root, 'call.entered'), 'utf8'));
      expect(entered).toMatchObject({ pid: parent, count: 1, params: { name: 'echo', arguments: { sample: 'payload' } } });
      await client.close();
      await waitForFakeMcpFile(join(root, 'exit.json'));
      expect(JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8'))).toEqual({ pid: parent, code: 0 });
    });
  });

  it.each(['error', 'hang', 'exit'] as const)('[case:fake-call-%s] supports a deterministic fault after the call barrier', async callMode => {
    await withFake({ callMode }, async (client, root) => {
      const pending = client.callTool('echo', {}, { timeoutMs: 250 });
      const observed = expect(pending).rejects.toThrow();
      await waitForFakeMcpFile(join(root, 'call.entered'));
      await observed;
      expect(JSON.parse(readFileSync(join(root, 'call.entered'), 'utf8')).count).toBe(1);
    });
  });

  it.each(['is_error', 'large_output'] as const)('[case:fake-result-%s] provides a controlled result without credentials or a model', async callMode => {
    await withFake({ callMode }, async client => {
      const result = await client.callTool('echo');
      if (callMode === 'is_error') expect(result.isError).toBe(true);
      else expect(JSON.stringify(result).length).toBeGreaterThan(2_000_000);
    });
  });
});
