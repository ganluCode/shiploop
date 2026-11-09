import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { beforeAll, expect, it } from 'vitest';
import type { RuntimeExecutionRequest, RuntimeHandle } from '../../../packages/core/src/ports/runtime-execution.ts';
import { validateRuntimeExecutionResult } from '../../../packages/core/src/ports/runtime-execution.ts';
import { productionFilePath } from '../../../packages/host/src/runtime/production-pi-runner.ts';

beforeAll(() => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-b', 'packages/core/tsconfig.json', 'packages/host/tsconfig.json'],
    { cwd: root, timeout: 60000 });
}, 65000);

it('文件工具拒绝路径穿越、Git 元数据和符号链接', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-path-')));
  try {
    symlinkSync('/private/tmp', join(root, 'outside'));
    for (const path of ['../outside', '/private/tmp/file', '.git/config', 'outside/file']) {
      await expect(productionFilePath(root, path, true)).rejects.toThrow('file_path_rejected');
    }
    expect(await productionFilePath(root, 'src/file.ts', true)).toBe(join(root, 'src/file.ts'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(['codemode', 'command_timeout', 'legacy_zh', 'documents'] as const)('生产工厂真实 SDK 和本机假 HTTP：%s及停止证明（无外网模型）', async mode => {
  const built = await import(new URL('../../../packages/host/dist/runtime/production-pi.js', import.meta.url).href);
  const productionPiOptions = built.productionPiOptions as typeof import('../../../packages/host/src/runtime/production-pi.js').productionPiOptions;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-production-')));
  let requests = 0;
  const documentArtifacts: { ref: RuntimeExecutionRequest['inputManifest']; content: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; messages?: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
      expect(req.headers.authorization).toBe('Bearer offline-key');
      expect(body.model).toBe('test-model');
      const system = JSON.stringify(body.messages?.filter(message => message.role === 'system'));
      expect(system).toContain('Core owns official Git commit/push');
      expect(system).toContain('When codemode is available');
      expect(system).toContain('promptTemplates');
      expect(system).toContain('docs/README.md');
      expect(system).toContain('read_project_document');
      expect(system).toContain('project-document-context');
      expect(system).not.toContain('PRIVATE_DOCUMENT_BODY');
      expect(system).toContain(mode === 'legacy_zh' ? '使用中文报告进展' : 'Use English for progress');
      expect(body.tools?.map(tool => tool.function.name)).toEqual(expect.arrayContaining(['codemode', 'execute_command', 'edit_file', 'search_content']));
      requests++;
      if (mode === 'documents' && requests === 2) {
        const outputs = JSON.stringify(body.messages?.filter(message => message.role === 'tool'));
        expect(outputs).toContain('PRIVATE_DOCUMENT_BODY');
        expect(outputs).not.toContain('CHANGED_DOCUMENT_BODY');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finish_reason: string | null, usage?: unknown) => {
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1,
          model: 'test-model', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
      };
      if (mode === 'documents' && requests === 1) {
        writeFileSync(join(root, 'work/docs/README.md'), 'CHANGED_DOCUMENT_BODY');
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-document', type: 'function',
          function: { name: 'read_project_document', arguments: JSON.stringify({ path: 'docs/README.md' }) } }] }, null);
        chunk({}, 'tool_calls', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
      } else if (requests === (mode === 'documents' ? 2 : 1)) {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-write', type: 'function',
          function: mode !== 'command_timeout'
            ? { name: 'codemode', arguments: JSON.stringify({ code: 'text(await tools.write_file({path:"probe.txt",content:"offline passed\\n"}));' }) }
            : { name: 'execute_command', arguments: JSON.stringify({ command: 'sleep 60 & echo $! > child.pid; wait' }) } }] }, null);
        chunk({}, 'tool_calls', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
      } else {
        chunk({ role: 'assistant', content: '已写入文件。offline-key' }, null);
        chunk({}, 'stop', { prompt_tokens: 150, completion_tokens: 10, total_tokens: 160 });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  let handle: RuntimeHandle | undefined;
  let drain: Promise<void> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    mkdirSync(join(root, 'pi'), { mode: 0o700 });
    mkdirSync(join(root, 'work'));
    mkdirSync(join(root, 'work/docs'));
    writeFileSync(join(root, 'work/docs/README.md'), 'PRIVATE_DOCUMENT_BODY');
    writeFileSync(join(root, 'pi/runtime.json'), JSON.stringify({ schemaVersion: 1, execution: { commandTimeoutMs: 1000 }, providers: [{ id: 'offline', models: ['test-model'],
      custom: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 128000, maxTokens: 16384, reasoning: false,
        compat: { supportsDeveloperRole: false }, modelOverrides: { 'test-model': { name: 'Offline', contextWindow: 32000,
          maxTokens: 4096, reasoning: true, input: ['text'], thinkingLevelMap: { off: null } } } } }] }), { mode: 0o600 });
    writeFileSync(join(root, 'pi/auth.json'), JSON.stringify({ offline: { type: 'api_key', key: 'offline-key' } }), { mode: 0o600 });
    const bytes = Buffer.from('Write probe.txt using write_file, then finish.');
    const content = (purpose: string) => purpose === 'manifest' ? Buffer.from(JSON.stringify(mode === 'legacy_zh' ? {} : { locale: 'en-US' })) : bytes;
    const ref = (purpose: string): RuntimeExecutionRequest['prompt'] => ({ projectId: 'project-1', artifactId: `artifact-${purpose}`,
      kind: 'execution-input', purpose, version: 1, contentHash: createHash('sha256').update(content(purpose)).digest('hex'), sizeBytes: content(purpose).length,
      locator: `inputs/${purpose}`, mediaType: 'text/plain', origin: { kind: 'file', root: 'managed-work', relativePath: `${purpose}.md` } });
    const request: RuntimeExecutionRequest = { schemaVersion: 1, projectId: 'project-1', featureId: 'feature-1', sessionId: 'session-1', executionVersion: 1,
      owner: { principalId: 'owner-1', hostInstanceId: 'host-1' }, identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
      invocationId: 'invocation-1', strategy: { runtime: 'pi', provider: 'offline', model: 'test-model', credentialRef: 'credential://pi/offline' },
      prompt: ref('prompt'), inputManifest: ref('manifest'), cwd: { root: 'managed-work', relativePath: 'work' },
      permissions: { grants: [], isolation: 'trusted_project' }, limits: { timeoutMs: 30000, maxEvents: 200, maxOutputBytes: 1_000_000 }, recovery: { mode: 'new' } };
    const options = await productionPiOptions(root);
    const runtime = options.workRuntimeFactory!({ capabilityCatalog: options.capabilityCatalog, workspaceRoots: { 'managed-work': root },
      async publishDocumentContext(actual, content) {
        const text = Buffer.from(content).toString('utf8');
        const ref: RuntimeExecutionRequest['inputManifest'] = { projectId: actual.projectId, artifactId: 'artifact-documents',
          purpose: 'project-documents', kind: 'project-document-context', version: 1, origin: { kind: 'artifact' },
          contentHash: createHash('sha256').update(content).digest('hex'), sizeBytes: content.byteLength,
          mediaType: 'application/json', locator: 'runtime-context/documents.json' };
        documentArtifacts.push({ ref, content: text });
        return ref;
      },
      reader: () => ({ list: () => [request.prompt, request.inputManifest], read: async purpose => ({ purpose: String(purpose), artifactId: `artifact-${purpose}`,
        contentHash: ref(String(purpose)).contentHash, sizeBytes: content(String(purpose)).length, content: content(String(purpose)) }) }),
      commitCommandIdentity: async identity => ({ launchId: identity.launchId }) });
    handle = await runtime.entries[0].adapter.start(request);
    expect(documentArtifacts).toHaveLength(1);
    expect(JSON.parse(documentArtifacts[0].content)).toMatchObject({ projectId: request.projectId, featureId: request.featureId,
      invocationId: request.invocationId, documents: { documents: [{ path: 'docs/README.md', content: 'PRIVATE_DOCUMENT_BODY', required: true }] } });
    const events: unknown[] = [];
    drain = (async () => { for await (const event of handle!.events) events.push(event); })();
    const result = validateRuntimeExecutionResult(await handle.result);
    await drain;
    expect(await handle.stopped).toMatchObject({ confirmed: true });
    if (mode === 'command_timeout') {
      expect(result.terminal).not.toBe('completed');
      expect(requests).toBe(1);
      const childPid = Number(readFileSync(join(root, 'work/child.pid'), 'utf8').trim());
      expect(childPid).toBeGreaterThan(1);
      expect(() => process.kill(childPid, 0)).toThrow();
      return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ terminal: 'completed' });
    expect(result.usage?.costUsdMicros).toBeNull();
    expect(requests).toBe(mode === 'documents' ? 3 : 2);
    expect(JSON.stringify(events)).not.toContain('offline-key');
    expect(readFileSync(join(root, 'work/probe.txt'), 'utf8')).toBe('offline passed\n');
    expect(await runtime.entries[0].adapter.start(request)).toBe(handle);
    expect(requests).toBe(mode === 'documents' ? 3 : 2);
    await expect(runtime.entries[0].adapter.start({ ...request, invocationId: 'invocation-2',
      strategy: { ...request.strategy, credentialRef: 'credential://wrong' } })).rejects.toThrow();
    await expect(runtime.entries[0].adapter.start({ ...request, invocationId: 'invocation-3',
      strategy: { ...request.strategy, endpointRef: 'endpoint://unknown' } })).rejects.toThrow();
    expect(requests).toBe(mode === 'documents' ? 3 : 2);
  } finally {
    if (handle) { await handle.cancel(); await handle.stopped; }
    await drain;
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
