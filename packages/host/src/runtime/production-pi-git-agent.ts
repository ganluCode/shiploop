/** Authorized GitAgent bridge onto the existing production Pi process/SDK stack. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createRuntimeExecutionService, createStaticRuntimeRegistry, RuntimeError,
  validateGitAgentRuntimeRequest, validateGitAgentRuntimeResult } from 'shiploop-core';
import type { CommandProcessIdentity, GitAgentRuntimeRequest, GitAgentRuntimeResult, GitAgentRuntimeStop,
  RuntimeCapabilityCatalog, RuntimeExecutionRequest, RuntimeStrategyV1, RuntimeUsageReport, WorkflowLocale } from 'shiploop-core';
import type { WorkRuntimeFactory } from 'shiploop-core/assembly';
import type { PiGitAgentRuntimeDriver } from './pi-git-agent-adapter.js';
import { createPiGitAgentRuntimeAdapter } from './pi-git-agent-adapter.js';
import { getRuntimePromptTemplates } from './prompt-templates.js';
import { productionPiOptions } from './production-pi.js';

export interface ProductionGitAgentBinding {
  /** The trusted resolver must bind policy/workspace/context to this exact authorization. */
  readonly requestDigest: string;
  readonly strategy: RuntimeStrategyV1;
  readonly cwd: RuntimeExecutionRequest['cwd'];
  readonly workspaceRoots: Readonly<Record<string, string>>;
  readonly locale: WorkflowLocale;
  readonly intent: string;
  readonly evidence: string;
  readonly maxRequests: number;
}
export interface ProductionGitAgentRecord {
  readonly requestDigest: string;
  readonly execution: GitAgentRuntimeRequest['execution'];
  readonly result: GitAgentRuntimeResult;
  /** Payloads and model text are deliberately excluded from logs/notification inputs. */
  readonly events: readonly { readonly sequence: number; readonly kind: string }[];
  readonly hold: 'stop_unconfirmed' | null;
  readonly reportedUsage: RuntimeUsageReport | null;
  readonly reportedDurationMs: number | null;
}
export interface ProductionGitAgentAuthority {
  resolve(request: GitAgentRuntimeRequest): Promise<ProductionGitAgentBinding>;
  assertCurrent(request: GitAgentRuntimeRequest): Promise<void>;
  /** Persist the launch identity under the repair owner/version fence before child execution. */
  confirmProcess(identity: CommandProcessIdentity, request: GitAgentRuntimeRequest): Promise<{ launchId: string }>;
  /** Trusted Git/workspace inspection after confirmed stop; never model-reported paths. */
  inspectCandidate(request: GitAgentRuntimeRequest): Promise<readonly string[]>;
  record(record: ProductionGitAgentRecord): Promise<void>;
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function within<T>(promise: Promise<T>, ms = 200): Promise<T | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), ms);
    void promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(undefined); });
  });
}

/** Trusted dependency injection is for contract tests; production uses productionPiGitAgentRuntime below. */
export function createProductionPiGitAgentDriver(options: {
  readonly runtimeFactory?: WorkRuntimeFactory;
  readonly capabilityCatalog: RuntimeCapabilityCatalog;
  readonly authority: ProductionGitAgentAuthority;
  readonly nowUtcMs?: () => number;
}): PiGitAgentRuntimeDriver {
  if (options === null || typeof options !== 'object' || typeof options.capabilityCatalog?.resolve !== 'function'
    || options.authority === null || typeof options.authority !== 'object'
    || ['resolve', 'assertCurrent', 'confirmProcess', 'inspectCandidate', 'record']
      .some(key => typeof options.authority[key as keyof ProductionGitAgentAuthority] !== 'function')) {
    throw new RuntimeError('configuration', 'git_agent_authority_invalid');
  }
  if (options.runtimeFactory === undefined) throw new RuntimeError('missing_runtime', 'git_agent_driver_unavailable');
  if (typeof options.runtimeFactory !== 'function') throw new RuntimeError('configuration', 'git_agent_driver_invalid');
  const now = options.nowUtcMs ?? Date.now;
  // Retain admission even for failures. A new authorized attempt must use a new invocation.
  const admitted = new Map<string, { digest: string; handle: ReturnType<PiGitAgentRuntimeDriver['start']> }>();
  return { async start(raw) {
    const request = validateGitAgentRuntimeRequest(raw);
    const previous = admitted.get(request.execution.invocationId);
    if (previous) {
      if (previous.digest !== request.requestDigest) throw new RuntimeError('protocol', 'git_agent_invocation_conflict');
      return previous.handle;
    }
    if (admitted.size >= 1024) throw new RuntimeError('process', 'git_agent_invocation_capacity');
    const handle = Promise.resolve().then(() => start(request));
    admitted.set(request.execution.invocationId, { digest: request.requestDigest, handle });
    return handle;
  } };

  async function start(request: GitAgentRuntimeRequest) {
    if (!options.runtimeFactory) throw new RuntimeError('missing_runtime', 'git_agent_driver_unavailable');
    await options.authority.assertCurrent(request);
    // Snapshot the trusted lookup so subsequent policy mutation cannot change the launch.
    const binding: ProductionGitAgentBinding = structuredClone(await options.authority.resolve(request));
    if (binding.requestDigest !== request.requestDigest) throw new RuntimeError('permission', 'git_agent_binding_mismatch');
    if (binding.strategy.runtime !== 'pi' || binding.strategy.credentialRef !== `credential://pi/${binding.strategy.provider}`) {
      throw new RuntimeError('configuration', 'production_pi_credential_reference_required');
    }
    if (hash(binding.intent) !== request.authorization.intent.digest
      || hash(binding.evidence) !== request.authorization.source.evidenceDigest) throw new RuntimeError('configuration', 'git_agent_context_mismatch');
    if (!Number.isSafeInteger(binding.maxRequests) || binding.maxRequests < 1 || binding.maxRequests > 10000) {
      throw new RuntimeError('configuration', 'git_agent_request_budget_invalid');
    }
    const budget = request.authorization.budget;
    const timeoutMs = Math.min(budget.remainingRuntimeMs, budget.deadlineUtcMs - now(), 86400000);
    // Existing Work protocol has a 1s minimum. Never round up an exhausted/sub-second budget.
    if (timeoutMs < 1000) throw new RuntimeError('timeout', 'budget_exhausted');
    const launchDeadline = now() + timeoutMs;
    const templates = getRuntimePromptTemplates(binding.locale);
    const bodies = new Map<string, { content: Uint8Array; ref: RuntimeExecutionRequest['prompt'] }>();
    const input = (purpose: string, kind: string, text: string) => {
      const content = Buffer.from(text);
      if (content.length > 262144) throw new RuntimeError('configuration', 'git_agent_context_limit');
      const locator = `git-agent/${request.execution.invocationId}/${purpose}.json`;
      const ref: RuntimeExecutionRequest['prompt'] = { projectId: request.authorization.projectId,
        artifactId: `git-agent-${purpose}-${hash(text).slice(0, 24)}`, version: 1, kind, purpose,
        contentHash: hash(text), sizeBytes: content.length, locator, mediaType: purpose === 'prompt' ? 'text/plain' : 'application/json',
        origin: { kind: 'file', root: 'managed-work', relativePath: locator } };
      bodies.set(purpose, { content, ref });
      return ref;
    };
    const prompt = input('prompt', 'git-agent-repair-prompt', templates.render('repair/git-agent.md', {
      authorization: JSON.stringify(request), intent: binding.intent, evidence: binding.evidence,
    }));
    const manifest = input('manifest', 'git-agent-repair-manifest', JSON.stringify({ schemaVersion: 1,
      locale: templates.locale, gitAgent: request, productionLimits: { maxRequests: binding.maxRequests, tokenLimit: budget.remainingTokens },
      promptTemplates: templates.provenance(['repair/git-agent.md', 'runtime/reply-language.md']) }));
    let actual: RuntimeExecutionRequest = {
      schemaVersion: 1, projectId: request.authorization.projectId, featureId: request.authorization.featureId,
      sessionId: `git-agent-${request.execution.attemptId}`, executionVersion: request.execution.executionVersion,
      identity: { purpose: 'work', runId: request.authorization.runId, taskId: request.authorization.repairId, attemptId: request.execution.attemptId },
      invocationId: request.execution.invocationId, owner: { principalId: request.execution.ownerId, hostInstanceId: request.execution.hostInstanceId },
      strategy: binding.strategy, prompt, inputManifest: manifest, cwd: binding.cwd,
      permissions: { grants: [], isolation: 'trusted_project' }, recovery: { mode: 'new' },
      limits: { timeoutMs, toolTimeoutMs: Math.min(timeoutMs, 600000), maxEvents: 10000, maxOutputBytes: 8388608 },
    };
    const runtime = options.runtimeFactory({ capabilityCatalog: options.capabilityCatalog, workspaceRoots: binding.workspaceRoots,
      nowUtcMs: now, reader: candidate => isDeepStrictEqual(candidate, actual) ? {
        list: () => [...bodies.values()].map(body => body.ref),
        async read(purpose) {
          if (typeof purpose !== 'string') throw new RuntimeError('configuration', 'git_agent_input_unbound');
          const body = bodies.get(purpose);
          if (!body) throw new RuntimeError('configuration', 'git_agent_input_unbound');
          return { purpose, artifactId: body.ref.artifactId, contentHash: body.ref.contentHash, sizeBytes: body.ref.sizeBytes, content: body.content };
        },
      } : undefined,
      async commitCommandIdentity(identity, candidate) {
        if (!isDeepStrictEqual(candidate, actual)) throw new RuntimeError('permission', 'git_agent_execution_identity_mismatch');
        await options.authority.assertCurrent(request);
        return options.authority.confirmProcess(identity, request);
      },
    });
    const service = createRuntimeExecutionService({ configuration: options.capabilityCatalog,
      registry: createStaticRuntimeRegistry(runtime.entries, options.capabilityCatalog) });
    await options.authority.assertCurrent(request);
    const remainingMs = Math.min(launchDeadline, budget.deadlineUtcMs) - now();
    if (remainingMs < 1000) throw new RuntimeError('timeout', 'budget_exhausted');
    actual = { ...actual, limits: { ...actual.limits, timeoutMs: remainingMs, toolTimeoutMs: Math.min(remainingMs, 600000) } };
    service.prepare(actual);
    const session = await service.start(actual);
    let cancelled = false;
    const cancel = () => { cancelled = true; return session.cancel(); };
    const stopped = session.stopped.then(stop => ({ confirmed: stop.confirmed, detail: stop.confirmed ? null : 'stop_unconfirmed' }),
      (): GitAgentRuntimeStop => ({ confirmed: false, detail: 'stop_unconfirmed' }));
    const events: { sequence: number; kind: string }[] = [];
    const drain = (async () => {
      for await (const event of session.events) {
        if (!event.eventId.startsWith(runtime.eventIdentityPrefix(actual))) throw new RuntimeError('protocol', 'git_agent_event_identity_mismatch');
        events.push({ sequence: event.sequence, kind: event.kind });
      }
      return true;
    })();
    void drain.catch(() => { void cancel().catch(() => undefined); });
    const result = (async (): Promise<GitAgentRuntimeResult> => {
      let terminal: GitAgentRuntimeResult['terminal'] = 'failed';
      let usage = { consumedTokens: 0, runtimeMs: 0 };
      let code: string | null = null;
      let changedPaths: readonly string[] = [];
      let reportedUsage: RuntimeUsageReport | null = null, reportedDurationMs: number | null = null;
      try {
        const output = await session.result;
        terminal = output.terminal;
        if (terminal !== 'completed') code = terminal === 'failed' ? 'git_agent_runtime_failed' : terminal;
        if (['runner_crashed', 'runner_disconnected', 'runner_process_lost'].includes(output.reason ?? '')) {
          terminal = 'process_exited'; code = 'git_agent_process_exited';
        }
        const u = output.usage;
        reportedUsage = u; reportedDurationMs = output.durationMs;
        if (!u || u.inputTokens === null || u.outputTokens === null || output.durationMs === null
          || typeof u.cacheReadIncludedInInput !== 'boolean' || typeof u.cacheWriteIncludedInInput !== 'boolean'
          || (u.cacheReadIncludedInInput === false && u.cacheReadTokens == null)
          || (u.cacheWriteIncludedInInput === false && u.cacheWriteTokens == null)) {
          code = 'git_agent_usage_unknown';
        } else {
          usage = { consumedTokens: u.inputTokens + u.outputTokens
            + (u.cacheReadIncludedInInput ? 0 : u.cacheReadTokens!) + (u.cacheWriteIncludedInInput ? 0 : u.cacheWriteTokens!), runtimeMs: output.durationMs };
          if (usage.consumedTokens > budget.remainingTokens || usage.runtimeMs > timeoutMs) code = 'budget_exhausted';
        }
        if (await within(drain) !== true) code = 'git_agent_events_unconfirmed';
        else if (output.lastEventSequence !== (events.at(-1)?.sequence ?? null)) code = 'git_agent_event_watermark_mismatch';
        const stop = await within(stopped);
        if (!stop?.confirmed) code = 'stop_unconfirmed';
        if (!code && terminal === 'completed' && !cancelled) {
          await options.authority.assertCurrent(request);
          changedPaths = await options.authority.inspectCandidate(request);
        }
      } catch {
        code = 'git_agent_runtime_failed';
        void cancel().catch(() => undefined);
      }
      const stop = await within(stopped) ?? { confirmed: false, detail: 'stop_unconfirmed' };
      if (cancelled && terminal === 'completed') terminal = 'cancelled';
      if (code && (terminal === 'completed' || code === 'budget_exhausted')) terminal = 'failed';
      const output: GitAgentRuntimeResult = { schemaVersion: 1, repairId: request.authorization.repairId,
        execution: request.execution, terminal, changedPaths,
        verification: { strategyId: request.authorization.verification.strategyId, strategyDigest: request.authorization.verification.digest,
          outputDigest: null, exitCode: null }, usage, stop,
        failure: code ? { classification: terminal === 'process_exited' ? 'process_exited' : 'runtime', code } : null };
      const checked = validateGitAgentRuntimeResult(output, request);
      await options.authority.record({ requestDigest: request.requestDigest, execution: request.execution, result: checked,
        events, hold: stop.confirmed ? null : 'stop_unconfirmed', reportedUsage, reportedDurationMs });
      return checked;
    })();
    void result.catch(() => undefined);
    return { result, stopped, cancel };
  }
}

/** Real assembly: same private config, credential resolver, SDK runner and OS supervision as Work. */
export async function productionPiGitAgentRuntime(dataRoot: string, authority: ProductionGitAgentAuthority) {
  const options = await productionPiOptions(dataRoot);
  return createPiGitAgentRuntimeAdapter({ driver: createProductionPiGitAgentDriver({
    runtimeFactory: options.workRuntimeFactory, capabilityCatalog: options.capabilityCatalog!, authority,
  }) });
}
