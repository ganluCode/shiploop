/** Fixed supervised entry. No imports from a project, global Pi discovery or secret-bearing argv. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { RuntimeExecutionRequest } from 'shiploop-core';
import { createPiRuntimeAdapter } from './pi-adapter.js';
import type { PiSubmissionToolDefinition } from './pi-adapter.js';
import { runPiWorkRunner } from './pi-runner.js';
import { parseProductionPiConfig, productionPiModel } from './production-pi-config.js';
import { createProductionCredentialStore } from './production-pi-auth.js';
import type { ProductionPiBootstrap } from './production-pi.js';
import { createProductionFileTools, createProductionGitAgentTools, loadProductionInstructions } from './production-pi-tools.js';
import { createProductionCommandTools } from './production-command-tools.js';
import { createPlanningCandidateSubmitTool } from './work-submission-tools.js';
import { createWorkToolClient } from '../client/work-tool-client.js';
import { getRuntimePromptTemplates } from './prompt-templates.js';
import { productionGitAgentRequest } from './pi-git-agent-adapter.js';
import { createProjectDocumentTool, parseProjectDocumentSnapshot } from './production-project-documents.js';

export { productionFilePath } from './production-pi-tools.js';

async function readBootstrap(path: string): Promise<ProductionPiBootstrap> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8_388_608 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error('bootstrap_invalid');
    }
    const value = JSON.parse(await file.readFile('utf8')) as ProductionPiBootstrap;
    parseProductionPiConfig(value.config);
    if (!isAbsolute(value.dataRoot) || !isAbsolute(value.cwd) || !Array.isArray(value.bodies)
      || value.bodies.length !== (value.projectDocuments ? 3 : 2) || typeof value.invocationId !== 'string') throw new Error('bootstrap_invalid');
    return value;
  } finally { await file.close(); }
}

export async function runProductionPiRunner(path: string): Promise<void> {
  const bootstrap = await readBootstrap(path);
  if (!Number.isSafeInteger(bootstrap.supervisorGroupId) || bootstrap.supervisorGroupId! <= 1
    || bootstrap.supervisorGroupId !== process.ppid) throw new Error('supervised_runner_required');
  const runnerStartedAt = Date.now();
  const secrets: string[] = [];
  if (bootstrap.planningBridge) secrets.push(bootstrap.planningBridge.token);
  let customPricing = false;
  const inputReader = { async read(ref: RuntimeExecutionRequest['prompt']) {
    const bound = bootstrap.bodies.find(body => isDeepStrictEqual(body.ref, ref));
    if (!bound) throw new Error('input_not_bound');
    const bytes = Buffer.from(bound.base64, 'base64');
    if (bytes.length !== ref.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== ref.contentHash) {
      throw new Error('input_digest_mismatch');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } };
  await runPiWorkRunner({ input: process.stdin,
    write: bytes => new Promise<void>((resolve, reject) => {
      const redact = (value: unknown): unknown => {
        if (typeof value === 'string') {
          for (const secret of secrets) value = (value as string).split(secret).join('[REDACTED]');
          return value;
        }
        if (Array.isArray(value)) return value.map(redact);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
        return value;
      };
      const frame = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (frame.kind === 'event') frame.body.payload = redact(frame.body.payload);
      if (customPricing && frame.kind === 'event' && frame.body.kind === 'usage') frame.body.payload.costUsdMicros = null;
      if (customPricing && frame.kind === 'result' && frame.body.usage) frame.body.usage.costUsdMicros = null;
      process.stdout.write(JSON.stringify(frame) + '\n', error => error ? reject(new Error('protocol_write_failed')) : resolve());
    }),
    adapter: { async start(request, signal) {
      if (request.invocationId !== bootstrap.invocationId || request.permissions.isolation !== 'trusted_project'
        || request.strategy.credentialRef !== `credential://pi/${request.strategy.provider}`) throw new Error('invocation_rejected');
      const provider = bootstrap.config.providers.find(p => p.id === request.strategy.provider);
      if (!provider || !provider.models.includes(request.strategy.model)) throw new Error('model_not_allowed');
      if (request.strategy.endpointRef !== undefined && (!provider.custom
        || request.strategy.endpointRef !== `endpoint://pi/${provider.id}`)) throw new Error('endpoint_not_allowed');
      customPricing = provider.custom !== undefined;
      const credentials = createProductionCredentialStore(bootstrap.dataRoot, credential => {
        for (const secret of credential.type === 'oauth' ? [credential.access, credential.refresh] : [credential.key]) {
          if (secret && !secrets.includes(secret)) secrets.push(secret);
        }
      });
      if (!await credentials.read(provider.id, { signal })) throw new Error('production_pi_auth_missing');
      if (provider.id === 'openai-codex') customPricing = true;
      const sdk = await import('@earendil-works/pi-coding-agent');
      const manifest = JSON.parse(await inputReader.read(request.inputManifest));
      const documentContext = bootstrap.projectDocuments ? JSON.parse(await inputReader.read(bootstrap.projectDocuments)) : undefined;
      if (documentContext && (documentContext.schemaVersion !== 1 || documentContext.projectId !== request.projectId
        || documentContext.featureId !== request.featureId || documentContext.invocationId !== request.invocationId
        || !isDeepStrictEqual(documentContext.identity, request.identity))) throw new Error('production_document_context_unbound');
      const documents = documentContext ? parseProjectDocumentSnapshot(JSON.stringify(documentContext.documents), request.featureId) : undefined;
      const gitAgent = productionGitAgentRequest(manifest, request);
      const codemode = !gitAgent && bootstrap.config.execution?.codemode !== false;
      const locale = manifest.locale ?? manifest.promptTemplates?.locale ?? 'zh-CN';
      const repairLimits = request.prompt.kind === 'feature-repair-prompt' || gitAgent
        ? manifest.productionLimits as { maxRequests: number; tokenLimit: number }
        : undefined;
      if (repairLimits && (!Number.isSafeInteger(repairLimits.maxRequests) || repairLimits.maxRequests < 1
        || !Number.isSafeInteger(repairLimits.tokenLimit) || repairLimits.tokenLimit < 1)) throw new Error('production_repair_budget_invalid');
      const { InMemoryModelsStore, clampThinkingLevel } = await import('@earendil-works/pi-ai');
      const modelRuntime = await sdk.ModelRuntime.create({ credentials,
        modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
      if (provider.custom) {
        const c = provider.custom;
        modelRuntime.registerProvider(provider.id, { api: c.api, baseUrl: c.baseUrl,
          models: provider.models.map(id => productionPiModel(provider, id)) });
      }
      const model = modelRuntime.getModel(provider.id, request.strategy.model);
      if (!model || !['openai-completions', 'openai-responses', 'anthropic-messages', 'openai-codex-responses'].includes(model.api)
        || (model.api === 'openai-codex-responses' && provider.id !== 'openai-codex')) {
        throw new Error('model_api_not_supported');
      }
      const getAuth = modelRuntime.getAuth.bind(modelRuntime);
      modelRuntime.getAuth = async (selection, overrides) => {
        const id = typeof selection === 'string' ? selection : selection.provider;
        if (id !== provider.id || !await credentials.read(id, { signal: overrides?.signal })) throw new Error('production_pi_auth_missing');
        return getAuth(selection as never, { ...overrides, apiKey: undefined, env: undefined });
      };
      let requests = 0;
      let chargedTokens = 0;
      const deadline = Math.min(Date.now() + request.limits.timeoutMs, gitAgent
        ? runnerStartedAt + gitAgent.authorization.budget.deadlineUtcMs - (bootstrap.hostTimeUtcMs ?? runnerStartedAt)
        : Infinity);
      if (deadline <= Date.now()) throw new Error('production_repair_budget_invalid');
      const budgetFailure = (reason: string, facts: Record<string, number>): never => {
        process.stderr.write(`shiploop: ${JSON.stringify({ kind: 'production_budget', reason, ...facts })}\n`);
        throw new Error(reason);
      };
      const stream = modelRuntime.streamSimple.bind(modelRuntime);
      modelRuntime.streamSimple = (actual, messages, options) => {
        if (actual.provider !== provider.id || actual.id !== request.strategy.model) throw new Error('production_model_changed');
        if (signal?.aborted || Date.now() >= deadline) throw new Error('production_request_cancelled');
        const requestLimit = Math.min(bootstrap.config.execution?.maxRequests ?? 256, repairLimits?.maxRequests ?? 10000);
        if (++requests > requestLimit) budgetFailure('production_request_budget', { requests, limit: requestLimit });
        const inputBytes = Buffer.byteLength(JSON.stringify(messages));
        const estimatedTokens = messages.messages.reduce((total, message) => total + sdk.estimateTokens(message), 0)
          + Math.ceil(Buffer.byteLength(JSON.stringify(messages.tools ?? [])) / 3)
          + Math.ceil(Buffer.byteLength(messages.systemPrompt ?? '') / 3);
        const maxTokens = Math.min(model.maxTokens, bootstrap.config.execution?.maxOutputTokens ?? 16384,
          Math.max(0, model.contextWindow - estimatedTokens),
          repairLimits ? Math.max(0, repairLimits.tokenLimit - chargedTokens - inputBytes) : model.maxTokens);
        if (inputBytes > (bootstrap.config.execution?.maxInputBytes ?? 512000)) {
          budgetFailure('production_input_budget', { inputBytes, limit: bootstrap.config.execution?.maxInputBytes ?? 512000 });
        }
        if (maxTokens < 1) budgetFailure(repairLimits ? 'production_repair_token_budget' : 'production_context_token_budget', {
          inputBytes, estimatedTokens, contextWindow: model.contextWindow, chargedTokens, tokenLimit: repairLimits?.tokenLimit ?? 0,
        });
        const response = stream(actual, messages, { ...options, maxTokens, maxRetries: 0, apiKey: undefined,
          ...(provider.id === 'openai-codex' ? { transport: 'sse' as const } : {}),
          fetch: async (url, init) => {
            if (signal?.aborted || Date.now() >= deadline) throw new Error('production_request_cancelled');
            if (provider.custom) {
              const target = new URL(url instanceof Request ? url.url : String(url));
              const approved = new URL(provider.custom.baseUrl);
              if (target.origin !== approved.origin || target.username || target.password
                || !(target.pathname === approved.pathname || target.pathname.startsWith(approved.pathname.replace(/\/$/, '') + '/'))) {
                throw new Error('production_endpoint_rejected');
              }
            }
            return fetch(url, { ...init, redirect: 'error' });
          } });
        if (repairLimits) void response.result().then(message => {
          chargedTokens += message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
        }).catch(() => undefined);
        return response;
      };
      const cwd = await realpath(bootstrap.cwd);
      const agentDir = join(bootstrap.dataRoot, 'pi/sessions', createHash('sha256').update(request.invocationId).digest('hex'));
      await mkdir(agentDir, { recursive: true, mode: 0o700 });
      const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off',
        retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } });
      const instructions = gitAgent ? [] : await loadProductionInstructions(cwd);
      const templates = getRuntimePromptTemplates(locale);
      const systemModules = ['runtime/system.md', 'runtime/reply-language.md', ...(codemode ? ['runtime/codemode.md'] : [])];
      const projectContext = [templates.render('runtime/project-context.md', {
        instructions: instructions.map(item => templates.render('runtime/project-instruction.md', { ...item })).join('\n'),
        skills: (bootstrap.projectSkills?.skills ?? []).map(skill => templates.render('runtime/project-skill.md', { name: skill.name, digest: skill.digest, content: skill.content })).join('\n'),
        manifest: JSON.stringify({ selectionDigest: bootstrap.projectSkills?.selection.digest ?? null,
          instructions: instructions.map(({ path, sha256 }) => ({ path, sha256 })),
          skills: bootstrap.projectSkills?.skills.map(({ id, name, digest }) => ({ id, name, digest })) ?? [],
          omitted: bootstrap.projectSkills?.omitted ?? [], allowGlobalScan: false,
          ...(bootstrap.projectDocuments ? { projectDocuments: bootstrap.projectDocuments } : {}),
          promptTemplates: templates.provenance([...systemModules, 'runtime/project-context.md',
            ...(instructions.length ? ['runtime/project-instruction.md'] : []),
            ...(bootstrap.projectSkills?.skills.length ? ['runtime/project-skill.md'] : []),
            ...(documents ? ['runtime/project-documents.md', 'runtime/tools/read_project_document.md'] : [])]) }),
        execution: JSON.stringify({ ...bootstrap.config.execution,
          requestedThinkingLevel: bootstrap.config.execution?.thinkingLevel ?? 'off',
          resolvedThinkingLevel: clampThinkingLevel(model, bootstrap.config.execution?.thinkingLevel ?? 'off') }),
      })];
      if (documents) projectContext.push(templates.render('runtime/project-documents.md', {
        index: JSON.stringify({ featureId: request.featureId, featureMapped: documents.featureMapped,
          source: documents.source ?? 'repository-compatibility',
          repositoryHead: documents.repositoryHead,
          mapping: documents.mapping && { path: documents.mapping.path, sha256: documents.mapping.sha256 },
          documents: documents.documents.map(({ content: _content, ...entry }) => entry),
          missing: documents.missing, omissions: documents.omissions }),
        evidence: JSON.stringify({ artifact: bootstrap.projectDocuments, capturedAtUtcMs: documentContext.capturedAtUtcMs,
          captureStage: documentContext.sourceArtifact ? 'frozen-planning-input' : 'invocation-start',
          ...(documentContext.sourceArtifact ? { sourceArtifact: documentContext.sourceArtifact } : {}),
          taskInputManifest: request.inputManifest.artifactId }),
      }));
      const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: codemode ? [sdk.createCodemodeExtension({ models: false })] : [],
        systemPrompt: systemModules.map(id => templates.render(id)).join('\n\n'),
        appendSystemPrompt: projectContext });
      await resourceLoader.reload();
      const customTools: PiSubmissionToolDefinition[] = [
        ...(documents ? [createProjectDocumentTool(documents, templates)] : []),
        ...(gitAgent ? createProductionGitAgentTools({ cwd, deadline, signal, promptTemplates: templates, writablePaths: gitAgent.authorization.writablePaths })
          : createProductionFileTools({ cwd, deadline, signal, promptTemplates: templates })),
        ...(gitAgent ? [] : createProductionCommandTools({ cwd, deadline, signal, promptTemplates: templates, rgPath: bootstrap.rgPath,
          commandTimeoutMs: Math.min(bootstrap.config.execution?.commandTimeoutMs ?? 600000, request.limits.toolTimeoutMs ?? 600000),
          terminateInvocation(reason) {
            process.stderr.write(`shiploop: ${reason}\n`);
            // The trusted supervisor is this Runner's parent and owns its process group.
            process.kill(-bootstrap.supervisorGroupId!, 'SIGTERM');
          } })),
      ];
      if (request.prompt.kind === 'planning-prompt') {
        if (!bootstrap.planningBridge || request.identity.purpose !== 'work') throw new Error('production_planning_bridge_not_assembled');
        const client = createWorkToolClient(bootstrap.planningBridge);
        customTools.splice(0, customTools.length, ...customTools.filter(tool =>
          ['read_file', 'list_files', 'search_files', 'search_content', 'read_project_instructions', 'read_project_document'].includes(tool.name)),
        createPlanningCandidateSubmitTool({ invoke: client.invoke, identity: request.identity, promptTemplates: templates,
          projectId: request.projectId, invocationId: request.invocationId, executionVersion: request.executionVersion,
          nowIso: () => new Date((bootstrap.hostTimeUtcMs ?? runnerStartedAt) + Date.now() - runnerStartedAt).toISOString() }));
      }
      const pi = createPiRuntimeAdapter({ providers: bootstrap.config.providers.map(p => ({ providerId: p.id, models: p.models })),
        permissionGrants: [], isolationModes: ['trusted_project'],
        requestRetryPolicy: { maxRetries: gitAgent ? 0 : bootstrap.config.pi_agent?.transient_retry_attempts ?? 10,
          maxTotalRetries: gitAgent ? 0 : bootstrap.config.pi_agent?.transient_retry_attempts ?? 10,
          baseBackoffMs: (bootstrap.config.pi_agent?.transient_retry_backoff_base_seconds ?? 1) * 1000,
          maxBackoffMs: 60000, budgetScope: 'consecutive', backoffMode: 'linear' },
        assembly: { agentDir, resolveWorkingDirectory: () => cwd, inputReader,
          extensionTools: codemode ? ['codemode'] : [],
          credentialRef: { kind: 'trusted-resolution', id: `pi:${provider.id}` }, resourceLoader,
          settingsManager, modelRuntime, resolveModel: () => model,
          resolveThinkingLevel: () => clampThinkingLevel(model, bootstrap.config.execution?.thinkingLevel ?? 'off'), resolveSubmissionTools: () => customTools } });
      return pi.adapter.start(request, signal);
    } },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.env.SHIPLOOP_PI_BOOTSTRAP;
  delete process.env.SHIPLOOP_PI_BOOTSTRAP;
  try {
    if (!path || !isAbsolute(path)) throw new Error('bootstrap_required');
    await runProductionPiRunner(path);
  } catch {
    process.stderr.write('shiploop: production_pi_runner_failed\n');
    process.exitCode = 1;
  }
}
