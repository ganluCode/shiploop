/** MCP audit is a producer for the existing Runtime/Work Recorder, never a separate journal.
 * The trusted Runner supplies the shared event sequencer and a stop request. Publishing
 * means admission only; durable coverage/watermark belong exclusively to the Recorder.
 */
import { createHash } from 'node:crypto';
import { redactOutputText, stableStringify } from 'shiploop-core';
import type { RuntimeEventPayload } from 'shiploop-core';
import type { McpStartupPlan } from './mcp-startup-plan.js';
import type { McpStdioCloseResult } from './mcp-stdio.js';
import { piEventToken } from './pi-event-identity.js';

export const MCP_AUDIT_BODY_BYTES = 4096;
const MAX_CALLS = 2048;
export class McpAuditError extends Error {
  constructor(readonly reason: 'audit_unavailable' | 'audit_identity_conflict' | 'audit_identity_missing' | 'audit_limit_exceeded') {
    super(`MCP audit ${reason}`);
    this.name = 'McpAuditError';
  }
}

/** Use the same literal/header policy as Work Recorder, before SDK/native persistence.
 * Keys are untrusted content too. Never attach third-party exceptions to public errors.
 */
export function redactMcpValue<T>(value: T, secrets: readonly string[]): T {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 16_384 || depth > 32) throw new McpAuditError('audit_limit_exceeded');
    if (typeof item === 'string') {
      if (Buffer.byteLength(item) > 1_048_576) throw new McpAuditError('audit_limit_exceeded');
      return redactOutputText(item, secrets);
    }
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .map(([key, child]) => [redactOutputText(key, secrets), visit(child, depth + 1)]));
    return item;
  };
  return visit(value, 0) as T;
}
export function mcpPlanSecrets(plan: McpStartupPlan): readonly string[] {
  return [...new Set(plan.servers.flatMap(server => Object.values(server.environment)).filter(value => value.length > 0))];
}
export interface McpStderrAudit {
  readonly text: string;
  readonly observedBytes: number;
  readonly retainedBytes: number;
  readonly truncated: boolean;
  readonly redacted: boolean;
}
export interface McpRuntimeAudit {
  readonly failed: boolean;
  assertPlan(plan: McpStartupPlan): void;
  observeCall(serverId: string, toolName: string, toolCallId: string, params: unknown,
    execute: () => Promise<unknown>, reasonOf: (error: unknown) => string): Promise<unknown>;
  lifecycle(serverId: string, phase: 'starting' | 'ready' | 'failed' | 'cleanup', reason: string | null,
    evidence?: McpStdioCloseResult, stderr?: McpStderrAudit): void;
}

export function createMcpRuntimeAudit(options: {
  readonly plan: McpStartupPlan;
  /** Synchronous bounded admission into the existing Runtime event stream. */
  readonly publish: (payload: RuntimeEventPayload) => boolean | void;
  readonly requestStop: () => void;
}): McpRuntimeAudit {
  const plan = structuredClone(options.plan);
  const secrets = mcpPlanSecrets(plan);
  const scopeDigest = createHash('sha256').update(stableStringify(plan)).digest('hex');
  let failed = false;
  let ordinal = 0;
  const calls = new Map<string, { digest: string; promise: Promise<unknown> }>();
  const lifecycleKeys = new Set<string>();
  const stop = () => {
    if (failed) return;
    failed = true;
    try { void Promise.resolve(options.requestStop()).catch(() => {}); }
    catch { /* Caller failure is never a stop confirmation. */ }
  };
  const emit = (payload: RuntimeEventPayload) => {
    try { if (options.publish(payload) === false) throw new McpAuditError('audit_unavailable'); }
    catch { stop(); throw new McpAuditError('audit_unavailable'); }
  };
  const safeReason = (reason: string | null): string | null => reason === null ? null
    : /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(reason) && !secrets.some(secret => reason.includes(secret)) ? reason : 'mcp_failure';
  const envelope = (serverId: string, phase: string, toolCallId: string | null, toolName: string | null,
    reason: string | null, content?: unknown) => {
    const identity = { schemaVersion: 1, projectId: plan.projectId, sessionId: plan.sessionId,
      attemptId: plan.attemptId, serverId, invocationId: plan.invocationId, executionVersion: plan.executionVersion,
      planDigest: plan.digest, phase, toolCallId, toolName, reason: safeReason(reason) };
    let text: string | undefined;
    let observedBytes: number | null = null;
    let gap = reason === 'limit_exceeded' || reason?.startsWith('audit_') === true;
    let retainedEvidence: unknown = null;
    try {
      const clean = content === undefined ? null : redactMcpValue(content, secrets);
      const encoded = JSON.stringify(clean);
      observedBytes = Buffer.byteLength(encoded);
      const lifecycle = phase === 'cleanup' ? clean as { evidence?: unknown; evidenceDigest?: string; stderr?: McpStderrAudit } | null : null;
      if (lifecycle?.evidence !== undefined) retainedEvidence = { evidence: lifecycle.evidence, evidenceDigest: lifecycle.evidenceDigest,
        stderr: lifecycle.stderr ? { ...lifecycle.stderr, text: '', retainedBytes: 0, truncated: true } : null };
      gap ||= lifecycle?.stderr?.truncated === true;
      const gapCode = reason === 'audit_identity_missing' ? 'mcp_call_identity_missing'
        : lifecycle?.stderr?.truncated ? 'mcp_stderr_truncated' : 'mcp_content_omitted';
      text = JSON.stringify({ ...identity, coverage: gap ? 'partial' : 'complete', gap: gap ? gapCode : null, content: clean });
      if (Buffer.byteLength(text) > MCP_AUDIT_BODY_BYTES) text = undefined;
    } catch { /* Omit unsupported content rather than persisting an exception or an unsafe tail. */ }
    if (text === undefined) {
      gap = true;
      text = JSON.stringify({ ...identity, coverage: 'partial', gap: 'mcp_content_omitted', observedBytes, content: retainedEvidence });
    }
    if (gap) {
      emit({ kind: 'diagnostic', code: 'mcp.audit_gap', message: 'MCP content could not be retained within the audit budget' });
      stop();
    }
    return text;
  };
  const token = (id: string) => secrets.some(secret => id.includes(secret))
    ? `pi-${createHash('sha256').update(id).digest('hex').slice(0, 20)}` : piEventToken(id);
  const audit: McpRuntimeAudit = {
    get failed() { return failed; },
    assertPlan(value) {
      if (createHash('sha256').update(stableStringify(value)).digest('hex') !== scopeDigest) {
        stop(); throw new McpAuditError('audit_identity_conflict');
      }
    },
    observeCall(serverId, toolName, toolCallId, params, execute, reasonOf) {
      if (failed) return Promise.reject(new McpAuditError('audit_unavailable'));
      // Missing/invalid native ids are not invented; retain a lifecycle-shaped record instead.
      const callId = typeof toolCallId === 'string' && toolCallId ? token(toolCallId) : null;
      if (callId === null) {
        try {
          const text = envelope(serverId, 'rejected', null, toolName, 'audit_identity_missing');
          emit({ kind: 'message', messageId: `mcp-audit-${++ordinal}`, role: 'system', preview: 'MCP identity missing', text });
        } catch { return Promise.reject(new McpAuditError('audit_unavailable')); }
        return Promise.reject(new McpAuditError('audit_identity_missing'));
      }
      let digest: string;
      try { digest = createHash('sha256').update(stableStringify([serverId, toolName, params])).digest('hex'); }
      catch { digest = 'unserializable'; }
      const key = callId;
      const refuse = (reason: 'audit_identity_conflict' | 'audit_limit_exceeded'): Promise<never> => {
        try {
          const text = envelope(serverId, 'rejected', callId, toolName, reason);
          emit({ kind: 'message', messageId: `mcp-audit-${++ordinal}`, role: 'system', preview: 'MCP audit rejected', text });
        } catch { /* Preserve the bounded admission error; stop remains required. */ }
        stop();
        return Promise.reject(new McpAuditError(reason));
      };
      const prior = calls.get(key);
      if (prior) {
        if (prior.digest === digest && digest !== 'unserializable') return prior.promise;
        return refuse('audit_identity_conflict');
      }
      if (calls.size >= MAX_CALLS) return refuse('audit_limit_exceeded');
      const publishPhase = (phase: 'started' | 'finished', reason: string | null, content: unknown) => {
        const text = envelope(serverId, phase, callId, toolName, reason, content);
        if (phase === 'started') emit({ kind: 'tool_started', toolCallId: callId, toolName: token(toolName), input: text });
        else emit({ kind: 'tool_finished', toolCallId: callId, exitCode: null, signal: null, reason: safeReason(reason), output: text });
      };
      let resolve!: (value: unknown) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<unknown>((accept, decline) => { resolve = accept; reject = decline; });
      // Reserve correlation before admission callbacks can re-enter. Start synchronously
      // so the existing dispatcher snapshots arguments before returning to its caller.
      calls.set(key, { digest, promise });
      void (async () => {
        publishPhase('started', null, params);
        if (failed) {
          publishPhase('finished', 'audit_unavailable', null);
          throw new McpAuditError('audit_unavailable');
        }
        let result: unknown;
        try { result = await execute(); }
        catch (error) {
          const reason = reasonOf(error);
          publishPhase('finished', reason, null);
          throw error;
        }
        const isError = result !== null && typeof result === 'object' && (result as { isError?: unknown }).isError === true;
        publishPhase('finished', isError ? 'mcp_tool_error' : null, result);
        return result;
      })().then(resolve, reject);
      // Keep rejected promises too: an uncertain side effect must never be replayed.
      return promise;
    },
    lifecycle(serverId, phase, reason, evidence, stderr) {
      const key = JSON.stringify([serverId, phase]);
      if (lifecycleKeys.has(key)) return;
      if (!plan.servers.some(server => server.resourceId === serverId) || lifecycleKeys.size >= plan.servers.length * 4) {
        stop(); throw new McpAuditError('audit_identity_conflict');
      }
      const content = evidence === undefined ? null : { evidence, stderr: stderr ?? null,
        evidenceDigest: createHash('sha256').update(stableStringify(evidence)).digest('hex') };
      const text = envelope(serverId, phase, null, null, reason, content);
      emit({ kind: 'message', messageId: `mcp-lifecycle-${++ordinal}`, role: 'system', preview: `MCP ${phase}`, text });
      lifecycleKeys.add(key);
    },
  };
  return audit;
}
