/** Isolated live SDK process. Only this file imports the SDK, after explicit parent admission. */
import { appendFileSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createP04LiveBudget, redactP04Live, validateP04LiveApproval } from './p04-live.ts';
import type { P04LiveApproval } from './p04-live.ts';

export async function runP04LiveRunner(input: { approval: P04LiveApproval; identity: { runId: string; taskId: string; attemptId: string }; prompt: string }) {
  const { identity } = input;
  const a = validateP04LiveApproval(input.approval, true);
  const secret = process.env.SHIPLOOP_P04_LIVE_KEY ?? '';
  // Remove the bootstrap environment secret before constructing any SDK resources.
  delete process.env.SHIPLOOP_P04_LIVE_KEY;
  const budget = createP04LiveBudget(a);
  const secrets = [secret, a.repository];
  const save = (name: string, value: unknown) => writeFileSync(join(a.reportDir, name), redactP04Live(value, secrets), { mode: 0o600, flag: 'wx' });
  let bytes = 0, sequence = 0, realCalls = 0, terminal = 'failed', cancelled = false, stopped = false;
  let session: import('@earendil-works/pi-coding-agent').AgentSession | undefined;
  let timer: NodeJS.Timeout | undefined;
  const usage = new Map<number, unknown>();
  const observe = (value: unknown) => {
    const text = redactP04Live({ sequence: ++sequence, attemptId: identity.attemptId, value }, secrets);
    bytes += Buffer.byteLength(text);
    if (bytes > 750_000) throw new Error('live_recording_limit');
    // A complete line is the durable prefix; crashes never become complete evidence.
    appendFileSync(join(a.reportDir, 'events.jsonl'), JSON.stringify(JSON.parse(text)) + '\n', { mode: 0o600 });
  };
  const cancel = () => {
    cancelled = true;
    observe({ type: 'cancel_requested', at: new Date().toISOString() });
    void session?.abort().catch(() => {});
  };
  process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
  try {
    if (!secret || a.authorization.expiresAt <= Date.now()) throw new Error('authentication_or_authorization_missing');
    if (a.scenario === 'resume-required') {
      // Current production capabilities explicitly do not authorize continuation.
      terminal = 'unsupported'; stopped = true;
      observe({ type: 'recovery_refused', taskId: identity.taskId, mode: 'required', kind: 'conversation',
        reason: 'production_conversation_resume_unsupported', capabilityEvidence: 'p04-4-pi-recovery-boundary' });
    } else {
      const sdk = await import('@earendil-works/pi-coding-agent');
      const { InMemoryCredentialStore, InMemoryModelsStore } = await import('@earendil-works/pi-ai');
      if (sdk.VERSION !== '1.0.4') throw new Error('sdk_version_mismatch');
      const agentDir = join(a.reportDir, 'agent');
      const modelRuntime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
      if (a.customModel) {
        const c = a.customModel;
        modelRuntime.registerProvider(a.provider, { api: c.api, baseUrl: c.baseUrl,
          models: [{ id: a.model, name: a.model, input: ['text'], reasoning: c.reasoning,
            contextWindow: c.contextWindow, maxTokens: c.maxTokens,
            compat: { supportsDeveloperRole: c.supportsDeveloperRole },
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
        observe({ type: 'custom_model_registered', provider: a.provider, model: a.model, configuration: c,
          pricing: 'unknown_not_a_cost_estimate' });
      }
      await modelRuntime.setRuntimeApiKey(a.provider, secret);
      const model = modelRuntime.getModel(a.provider, a.model);
      if (!model || !['anthropic-messages', 'openai-completions', 'openai-responses'].includes(model.api)) throw new Error('approved_model_or_bounded_api_unavailable');
      const original = modelRuntime.streamSimple.bind(modelRuntime);
      modelRuntime.streamSimple = (actual, context, options) => {
        if (cancelled) throw new Error('live_cancelled');
        const maxTokens = budget.admit(actual.provider, actual.id, context);
        observe({ type: 'model_request_admitted', request: budget.snapshot().requests, provider: actual.provider,
          model: actual.id, maxOutputTokens: maxTokens, reservedTokens: budget.snapshot().reservedTokens });
        return original(actual, context, { ...options, maxTokens, maxRetries: 0, apiKey: secret,
          fetch: async (url, init) => {
            if (a.customModel) {
              const endpoint = new URL(a.customModel.baseUrl);
              const target = new URL(url instanceof Request ? url.url : String(url));
              if (target.origin !== endpoint.origin || !target.pathname.startsWith(endpoint.pathname + '/')
                  || target.username || target.password) throw new Error('live_endpoint_rejected');
            }
            if (cancelled || Date.now() >= budget.snapshot().deadline || Date.now() >= a.authorization.expiresAt
                || realCalls >= budget.snapshot().requests) throw new Error('live_transport_budget_rejected');
            realCalls++;
            observe({ type: 'provider_request_started', request: realCalls, provider: actual.provider, model: actual.id });
            return fetch(url, { ...init, redirect: 'error' });
          } });
      };
      const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off',
        retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } });
      const resourceLoader = new sdk.DefaultResourceLoader({ cwd: a.repository, agentDir, settingsManager,
        noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPrompt: 'Perform only the approved greeting file change with the two provided tools. Never read credentials or manage Git.', appendSystemPrompt: [] });
      await resourceLoader.reload();
      const target = join(a.repository, 'greeting.txt');
      const tool = (name: string): import('@earendil-works/pi-coding-agent').ToolDefinition => ({
        name, label: name, description: name === 'read_greeting' ? 'Read greeting.txt.' : 'Change greeting.txt from hello to hello pi with a trailing newline.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute(id, _params, signal) {
          if (cancelled || signal?.aborted || Date.now() >= budget.snapshot().deadline || a.authorization.expiresAt <= Date.now()) throw new Error('tool_cancelled_or_expired');
          if (lstatSync(target).isSymbolicLink()) throw new Error('tool_target_denied');
          observe({ type: 'tool_started', toolCallId: id, name });
          const before = readFileSync(target, 'utf8');
          if (name === 'write_greeting') {
            if (before !== 'hello\n' && before !== 'hello pi\n') throw new Error('tool_precondition_failed');
            writeFileSync(target, 'hello pi\n');
          }
          const text = readFileSync(target, 'utf8');
          observe({ type: 'tool_completed', toolCallId: id, name, text, externalProcesses: 0 });
          return { content: [{ type: 'text', text }], details: {} };
        },
      });
      ({ session } = await sdk.createAgentSession({ cwd: a.repository, agentDir, model, modelRuntime, resourceLoader,
        thinkingLevel: 'off', sessionManager: sdk.SessionManager.inMemory(a.repository), settingsManager,
        tools: [...a.resources], customTools: a.resources.map(tool) }));
      if (session.model?.provider !== a.provider || session.model.id !== a.model
          || JSON.stringify(session.getActiveToolNames().sort()) !== JSON.stringify([...a.resources].sort())) throw new Error('actual_configuration_mismatch');
      session.setAutoRetryEnabled(false);
      session.subscribe(event => {
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const m = event.message;
          const record = { request: budget.snapshot().requests, provider: m.provider, model: m.model,
            usage: ['error', 'aborted'].includes(m.stopReason) || !m.usage || m.usage.totalTokens <= 0 ? null : m.usage };
          if (m.provider !== a.provider || m.model !== a.model) { cancelled = true; void session?.abort().catch(() => {}); }
          usage.set(record.request, record);
          observe({ type: 'assistant_completed', ...record, content: m.content, stopReason: m.stopReason });
        }
      });
      timer = setTimeout(cancel, a.scenario === 'cancel' ? a.cancelAfterMs! : Math.max(1, budget.snapshot().deadline - Date.now() - 1000));
      if (cancelled) throw new Error('live_cancelled_during_setup');
      await session.prompt(input.prompt);
      await session.waitForIdle();
      const last = session.messages.filter(m => m.role === 'assistant').at(-1);
      terminal = cancelled ? 'cancelled' : last?.role === 'assistant' && ['stop', 'toolUse'].includes(last.stopReason) ? 'completed' : 'failed';
      session.dispose();
      stopped = true;
      session = undefined;
      observe({ type: 'tools_stopped', confirmed: true, scope: 'synchronous_greeting_tools', externalToolProcesses: 'not_run' });
    }
  } catch {
    // Do not serialize arbitrary SDK errors; they can contain headers, keys, or provider response bodies.
    terminal = cancelled ? 'cancelled' : 'failed';
    observe({ type: 'execution_failed', reason: 'sdk_authentication_provider_or_budget_failure', usage: 'unknown' });
    if (session) {
      try { await session.abort(); await session.waitForIdle(); stopped = true; } catch { stopped = false; }
    } else stopped = true;
  } finally {
    if (timer) clearTimeout(timer);
    session?.dispose();
    process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
    save('runner-result.json', { schemaVersion: 1, identity, provider: a.provider, model: a.model, sdkVersion: '1.0.4',
      realCalls, admittedRequests: budget.snapshot().requests, reservedTokens: budget.snapshot().reservedTokens, terminal, stopped, usage: [...usage.values()],
      usageCoverage: [...usage.values()].some(value => (value as { usage: unknown }).usage !== null) ? 'partial' : 'unknown', recording: terminal === 'completed' ? 'complete' : 'partial',
      finalSequence: sequence, externalToolProcesses: 'not_run', nativeArchive: 'not_retained', executionMode: 'live' });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runP04LiveRunner(JSON.parse(readFileSync(process.argv[2]!, 'utf8'))); }
  catch { process.exitCode = 1; }
}
