/** Standalone newline JSON-RPC server. Files are test barriers; stdout is protocol only except injected faults. */
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const config = JSON.parse(process.argv[2] ?? '{}');
const root = config.root;
mkdirSync(root, { recursive: true });
const mark = (name, value = process.pid) => writeFileSync(join(root, name), String(value));
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const rpcError = id => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'synthetic fake error' } }) + '\n');
const children = [];
async function exitGracefully() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
  process.exit(0);
}
const hold = config.ignoreTerminate || config.mode === 'hang_initialize' || config.mode === 'hang_list';
const interval = hold ? setInterval(() => {}, 1_000) : undefined;
process.on('exit', code => mark(config.exitFile ?? 'exit.json', JSON.stringify({ pid: process.pid, code })));
process.on('SIGTERM', () => {
  mark('terminate.entered');
  if (!config.ignoreTerminate) void exitGracefully();
});
process.on('SIGINT', () => { if (!config.ignoreTerminate) process.exit(0); });
mark(config.pidFile ?? 'server.pid');
if (config.spawnChild) {
  // Same process group; parent reaps the child before exiting when termination is accepted.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: false, stdio: 'ignore', env: {} });
  children.push(child);
  mark(config.childPidFile ?? 'child.pid', child.pid);
}
mark(config.readyFile ?? 'ready');
if (config.mode === 'exit_on_start') process.exit(17);
if (config.mode === 'stdout_noise') process.stdout.write('noise-before-json\n');
if (config.mode === 'large_output') process.stdout.write('x'.repeat(2 * 1024 * 1024) + '\n');
if (config.stderrBytes) process.stderr.write('private-diagnostic-'.repeat(Math.ceil(config.stderrBytes / 19)));
const environmentEcho = config.echoEnvironmentKey ? process.env[config.echoEnvironmentKey] : undefined;
if (environmentEcho) {
  const split = Math.floor(environmentEcho.length / 2);
  process.stderr.write(environmentEcho.slice(0, split));
  process.stderr.write(environmentEcho.slice(split) + '\n');
}
let calls = 0;
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('end', () => {
  if (hold) return;
  void exitGracefully();
});
const initialize = id => {
  send(id, {
    protocolVersion: config.mode === 'invalid_protocol' ? '1900-01-01' : '2025-11-25',
    capabilities: config.mode === 'missing_tools_capability' ? {} : { tools: {} },
    serverInfo: { name: 'shiploop-local-fake', version: '1.0.0' },
    ...(config.instructions || environmentEcho ? { instructions: config.instructions ?? environmentEcho } : {}),
  });
  if (Number.isSafeInteger(config.parentExitAfterInitializeMs) && config.parentExitAfterInitializeMs >= 0) {
    setTimeout(() => process.exit(0), config.parentExitAfterInitializeMs);
  }
};
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const newline = buffer.indexOf('\n');
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      mark(config.initializeFile ?? 'initialize.entered');
      if (config.mode === 'exit_initialize') process.exit(19);
      if (config.mode === 'hang_initialize') continue;
      if (config.holdInitialize) {
        const watcher = watch(root, () => {
          if (existsSync(join(root, 'initialize.release'))) { watcher.close(); initialize(message.id); }
        });
        if (existsSync(join(root, 'initialize.release'))) { watcher.close(); initialize(message.id); }
      } else initialize(message.id);
    } else if (message.method === 'notifications/initialized') {
      mark('initialized');
    } else if (message.method === 'tools/list') {
      mark(config.toolsListFile ?? 'tools.list');
      if (config.mode === 'hang_list') continue;
      if (config.mode === 'list_error') { rpcError(message.id); continue; }
      const tools = config.discoveryFile ? JSON.parse(readFileSync(join(root, config.discoveryFile), 'utf8'))
        : [{ name: config.toolName ?? 'echo', description: 'local fake', inputSchema: { type: 'object', properties: {} } }];
      const pages = config.pagesFile ? JSON.parse(readFileSync(join(root, config.pagesFile), 'utf8')) : undefined;
      send(message.id, pages ? pages[message.params?.cursor ?? 'first'] : { tools });
    } else if (message.method === 'tools/call') {
      mark('call.entered', JSON.stringify({ pid: process.pid, count: ++calls, id: message.id, params: message.params }));
      if (config.callMode === 'hang') continue;
      if (config.callMode === 'exit') process.exit(23);
      if (config.callMode === 'error') { rpcError(message.id); continue; }
      send(message.id, { content: [{ type: 'text', text: config.callMode === 'large_output' ? 'x'.repeat(2 * 1024 * 1024) : environmentEcho ?? 'fake result' }],
        ...(config.callMode === 'is_error' ? { isError: true } : {}) });
    }
  }
});
void interval;
