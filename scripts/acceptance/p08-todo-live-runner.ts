/** F-004 live child: the only process in the Todo demo allowed to call Pi SDK. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
}

function valid(input: unknown): input is TodoPiRunnerInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Partial<TodoPiRunnerInput>;
  return value.schemaVersion === 1 && typeof value.taskId === 'string' && typeof value.attemptId === 'string'
    && typeof value.repository === 'string' && typeof value.provider === 'string' && typeof value.model === 'string'
    && typeof value.prompt === 'string' && typeof value.reportFile === 'string'
    && typeof value.timeoutMs === 'number' && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0
    && typeof value.maxRequests === 'number' && Number.isSafeInteger(value.maxRequests) && value.maxRequests > 0;
}

function save(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w', mode: 0o600 });
}

async function run(input: TodoPiRunnerInput): Promise<void> {
  const secret = process.env.SHIPLOOP_P08_LIVE_KEY ?? '';
  delete process.env.SHIPLOOP_P08_LIVE_KEY;
  let realCalls = 0;
  let terminal: 'completed' | 'failed' | 'cancelled' = 'failed';
  let stopped = false;
  let session: { prompt(value: string): Promise<void>; waitForIdle?(): Promise<void>; abort(): Promise<void>; dispose(): void } | undefined;
  try {
    if (secret.length === 0 || secret.length > 16_384) throw new Error('authorization_missing');
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
    const model = modelRuntime.getModel(input.provider, input.model);
    if (!model) throw new Error('approved_model_unavailable');
    const originalStream = modelRuntime.streamSimple.bind(modelRuntime);
    modelRuntime.streamSimple = (actual: any, context: any, options: any) => {
      if (actual.provider !== input.provider || actual.id !== input.model || realCalls >= input.maxRequests) throw new Error('live_route_or_budget_rejected');
      realCalls++;
      return originalStream(actual, context, { ...options, maxRetries: 0, apiKey: secret });
    };
    const result = await sdk.createAgentSession({
      cwd: input.repository, agentDir, model, modelRuntime,
      resourceLoader, sessionManager: sdk.SessionManager.inMemory(input.repository),
      settingsManager, thinkingLevel: 'off', tools: ['read', 'write', 'edit', 'bash'],
    });
    session = result.session;
    if (session === undefined || result.session.model?.provider !== input.provider || result.session.model?.id !== input.model) {
      throw new Error('actual_model_configuration_mismatch');
    }
    await session.prompt(input.prompt);
    await session.waitForIdle?.();
    terminal = 'completed';
    session.dispose();
    session = undefined;
    stopped = true;
  } catch {
    terminal = 'failed';
    if (session) {
      try { await session.abort(); await session.waitForIdle?.(); stopped = true; } catch { stopped = false; }
    } else stopped = true;
  } finally {
    session?.dispose();
    save(input.reportFile, {
      schemaVersion: 1, executionMode: 'live', taskId: input.taskId, attemptId: input.attemptId,
      provider: input.provider, model: input.model, realCalls, terminal, stopped,
    });
  }
}

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

export {};
