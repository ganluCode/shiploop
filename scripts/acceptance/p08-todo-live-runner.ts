/** F-004 live child: the only process in the Todo demo allowed to call Pi SDK. */
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

interface TodoPiRunnerInput {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly attemptId: string;
  readonly repository: string;
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  readonly reportFile: string;
  readonly timeoutMs: number;
  readonly maxRequests: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly expiresAt: number;
  readonly allowedFile: string;
  readonly customModel: { readonly api: string; readonly baseUrl: string };
}

function valid(input: unknown): input is TodoPiRunnerInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Partial<TodoPiRunnerInput>;
  return value.schemaVersion === 1 && typeof value.taskId === 'string' && typeof value.attemptId === 'string'
    && typeof value.repository === 'string' && typeof value.provider === 'string' && typeof value.model === 'string'
    && typeof value.prompt === 'string' && typeof value.reportFile === 'string'
    && typeof value.timeoutMs === 'number' && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0
    && typeof value.maxRequests === 'number' && Number.isSafeInteger(value.maxRequests) && value.maxRequests > 0
    && value.maxRequests <= 8 && Number.isSafeInteger(value.maxInputTokens) && value.maxInputTokens! > 0
    && Number.isSafeInteger(value.maxOutputTokens) && value.maxOutputTokens! > 0
    && value.maxRequests * (value.maxInputTokens! + value.maxOutputTokens!) <= 200_000
    && typeof value.expiresAt === 'number' && value.expiresAt > Date.now()
    && typeof value.allowedFile === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.allowedFile)
    && value.allowedFile !== '.' && value.allowedFile !== '..'
    && value.provider === 'ark-agentplan' && value.model === 'ark-code-latest'
    && value.customModel?.api === 'openai-responses'
    && value.customModel?.baseUrl === 'https://ark.cn-beijing.volces.com/api/plan/v3';
}

function save(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w', mode: 0o600 });
}

export function liveTerminalFailure(stopReason: string | null | undefined, wroteFile: boolean): string | null {
  if (stopReason === 'error') return 'assistant_error';
  if (stopReason === 'aborted') return 'assistant_aborted';
  if (stopReason === 'length') return 'assistant_output_truncated';
  if (!wroteFile) return 'approved_file_not_written';
  return null;
}

async function run(input: TodoPiRunnerInput): Promise<void> {
  const secret = process.env.SHIPLOOP_P08_LIVE_KEY ?? '';
  delete process.env.SHIPLOOP_P08_LIVE_KEY;
  let realCalls = 0;
  let terminal: 'completed' | 'failed' | 'cancelled' = 'failed';
  let stopped = false;
  let wroteFile = false;
  let reason: string | null = null;
  let reservedTokens = 0;
  const httpStatuses: number[] = [];
  const assistantMessages: { stopReason: string | null; toolNames: string[]; textCharacters: number; errorPresent: boolean }[] = [];
  const deadline = Math.min(input.expiresAt, Date.now() + input.timeoutMs);
  let session: { prompt(value: string): Promise<void>; waitForIdle?(): Promise<void>; abort(): Promise<void>; dispose(): void } | undefined;
  try {
    if (secret.length === 0 || secret.length > 16_384) throw new Error('authorization_missing');
    const repository = realpathSync(input.repository);
    if (!repository.startsWith(realpathSync(tmpdir()) + sep)) throw new Error('temporary_repository_required');
    const target = join(repository, input.allowedFile);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('approved_file_symlink');
    const sdk: any = await import('@earendil-works/pi-coding-agent');
    const piAi: any = await import('@earendil-works/pi-ai');
    if (sdk.VERSION !== '1.0.4') throw new Error('sdk_version_mismatch');
    const agentDir = join(dirname(input.reportFile), `agent-${input.taskId}`);
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } });
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: input.repository, agentDir, settingsManager, noSkills: true, noExtensions: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: 'Work only in the approved Todo repository. Use the approved tools and implement the assigned task. Do not read credentials, change Git history, or access paths outside the repository.',
      appendSystemPrompt: [],
    });
    await resourceLoader.reload();
    const modelRuntime = await sdk.ModelRuntime.create({
      credentials: new piAi.InMemoryCredentialStore(), modelsStore: new piAi.InMemoryModelsStore(),
      modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
    });
    await modelRuntime.setRuntimeApiKey(input.provider, secret);
    modelRuntime.registerProvider(input.provider, { api: input.customModel.api, baseUrl: input.customModel.baseUrl,
      models: [{ id: input.model, name: input.model, input: ['text'], reasoning: false,
        contextWindow: 256000, maxTokens: input.maxOutputTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    const model = modelRuntime.getModel(input.provider, input.model);
    if (!model) throw new Error('approved_model_unavailable');
    const originalStream = modelRuntime.streamSimple.bind(modelRuntime);
    modelRuntime.streamSimple = (actual: any, context: any, options: any) => {
      if (actual.provider !== input.provider || actual.id !== input.model || Date.now() >= deadline
          || reservedTokens / (input.maxInputTokens + input.maxOutputTokens) >= input.maxRequests
          || Buffer.byteLength(JSON.stringify(context)) + 4096 > input.maxInputTokens) throw new Error('live_route_or_budget_rejected');
      reservedTokens += input.maxInputTokens + input.maxOutputTokens;
      return originalStream(actual, context, { ...options, maxRetries: 0, maxTokens: input.maxOutputTokens, apiKey: secret,
        fetch: async (url: any, init: any) => {
          const endpoint = new URL(url instanceof Request ? url.url : String(url));
          if (Date.now() >= deadline || realCalls >= input.maxRequests
              || endpoint.origin !== 'https://ark.cn-beijing.volces.com'
              || !endpoint.pathname.startsWith('/api/plan/v3/')) throw new Error('live_transport_rejected');
          realCalls++;
          const response = await fetch(url, { ...init, redirect: 'error' });
          httpStatuses.push(response.status);
          return response;
        } });
    };
    const result = await sdk.createAgentSession({
      cwd: input.repository, agentDir, model, modelRuntime,
      resourceLoader, sessionManager: sdk.SessionManager.inMemory(input.repository),
      settingsManager, thinkingLevel: 'off', tools: ['write_approved_file'],
      customTools: [{ name: 'write_approved_file', label: 'Write approved file',
        description: `Write UTF-8 content to ${input.allowedFile}. This is the only permitted file.`,
        parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false },
        async execute(_id: string, params: { content: string }, signal: AbortSignal) {
          if (signal?.aborted || Date.now() >= deadline || typeof params.content !== 'string'
              || Buffer.byteLength(params.content) > 32768 || (existsSync(target) && lstatSync(target).isSymbolicLink())) throw new Error('approved_write_rejected');
          writeFileSync(target, params.content, { encoding: 'utf8', mode: 0o600 });
          wroteFile = true;
          return { content: [{ type: 'text', text: 'Approved file written.' }], details: {} };
        } }],
    });
    session = result.session;
    if (session === undefined || result.session.model?.provider !== input.provider || result.session.model?.id !== input.model) {
      throw new Error('actual_model_configuration_mismatch');
    }
    result.session.subscribe((event: any) => {
      if (event.type !== 'message_end' || event.message?.role !== 'assistant') return;
      const message = event.message;
      assistantMessages.push({
        stopReason: typeof message.stopReason === 'string' ? message.stopReason : null,
        toolNames: (message.content ?? []).filter((part: any) => part.type === 'toolCall')
          .map((part: any) => part.name === 'write_approved_file' ? part.name : 'unexpected_tool'),
        textCharacters: (message.content ?? []).filter((part: any) => part.type === 'text')
          .reduce((sum: number, part: any) => sum + String(part.text ?? '').length, 0),
        errorPresent: typeof message.errorMessage === 'string' && message.errorMessage.length > 0,
      });
    });
    await session.prompt(input.prompt);
    await session.waitForIdle?.();
    const failure = liveTerminalFailure(assistantMessages.at(-1)?.stopReason, wroteFile);
    if (failure) throw new Error(failure);
    terminal = 'completed';
    session.dispose();
    session = undefined;
    stopped = true;
  } catch (error) {
    reason = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'live_runner_failed';
    terminal = 'failed';
    if (session) {
      try { await session.abort(); await session.waitForIdle?.(); stopped = true; } catch { stopped = false; }
    } else stopped = true;
  } finally {
    session?.dispose();
    save(input.reportFile, {
      schemaVersion: 1, executionMode: 'live', taskId: input.taskId, attemptId: input.attemptId,
      provider: input.provider, model: input.model, realCalls, terminal, stopped, reservedTokens, reason, assistantMessages, httpStatuses,
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const inputPath = process.argv[2];
 if (!inputPath) process.exitCode = 2;
 else {
  try {
    const value: unknown = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
    if (!valid(value)) throw new Error('runner_input_invalid');
    await run(value);
  } catch {
    process.exitCode = 1;
  }
 }
}

export {};
