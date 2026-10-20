import { describe, expect, it } from 'vitest';
import {
  RUNTIME_FAILURE_MAX_DIAGNOSTICS,
  classifyRuntimeFailure,
  classifyRuntimeExecutionResult,
  toRuntimeSettlementFailure,
} from '../../../packages/core/src/ports/runtime-failure.ts';

const usage = { basis: 'reported' as const, inputTokens: 17, outputTokens: null, costUsdMicros: null };

function category(input: Parameters<typeof classifyRuntimeFailure>[0]) {
  return classifyRuntimeFailure(input);
}

describe('P04-3 Runtime failure classification', () => {
  it('[case:f001-ten-categories] classifies deterministic SDK, transport, HTTP, tool, timeout, cancel and unknown facts', () => {
    expect(category({ errorChain: [{ code: 'invalid_api_key', message: 'bad credential' }] }).category).toBe('authentication');
    expect(category({ errorChain: [{ code: 'model_not_found', message: 'unsupported model' }] }).category).toBe('configuration');
    expect(category({ http: { status: 402, body: 'insufficient_quota' } }).category).toBe('quota_blocked');
    expect(category({ http: { status: 429 } }).category).toBe('quota_blocked');
    expect(category({ errorChain: [{ code: 'ECONNRESET', message: 'socket reset' }] }).category).toBe('transient_connection');
    expect(category({ http: { status: 503, body: 'overloaded' } }).category).toBe('transient_server');
    expect(category({ protocolIssue: 'invalid_json' }).category).toBe('protocol');
    expect(category({ lastStage: 'tool:read', exitCode: 2 }).category).toBe('tool_failure');
    expect(category({ timeoutObserved: true }).category).toBe('timeout');
    expect(category({ cancelRequested: true }).category).toBe('cancelled');
    expect(category({ errorChain: [{ message: 'failure with no trustworthy source' }] }).category).toBe('unknown');
  });

  it('[case:f001-http-200-stream-break] does not treat an interrupted HTTP 200 stream as success', () => {
    const result = category({ http: { status: 200 }, stream: 'interrupted', terminalObserved: false, usage, durationMs: 321 });
    expect(result.outcome).toBe('failure');
    expect(result.category).toBe('transient_connection');
    expect(result.evidence.usage).toEqual(usage);
    expect(result.evidence.durationMs).toBe(321);
  });

  it('[case:f001-terminal-unknown] preserves missing and unknown terminal semantics', () => {
    expect(category({ stream: 'closed', terminalObserved: false }).category).toBe('unknown');
    expect(category({ sdkTerminal: 'paused_by_vendor' }).category).toBe('unknown');
    expect(category({ sdkTerminal: 'paused_by_vendor' }).settlementKind).toBeNull();
    expect(category({ terminal: 'completed', stream: 'interrupted' }).outcome).toBe('failure');
  });

  it('[case:f001-partial-evidence] keeps partial result, usage, duration, stage and null unknowns', () => {
    const result = category({
      errorChain: [{ source: 'transport', code: 'ECONNRESET', message: 'Bearer top-secret https://private.example/x', reference: 'err-1' }],
      lastStage: 'assistant_turn', stream: 'interrupted', terminalObserved: false,
      partialResult: { text: 'partial answer', turns: 2, lastEventSequence: 9, usage, durationMs: 44 },
      durationMs: 44, secrets: ['top-secret'],
    });
    expect(result.evidence).toMatchObject({ rawErrorRef: 'err-1', source: 'transport', sourceConfidence: 'medium', lastStage: 'assistant_turn', usage, durationMs: 44 });
    expect(result.evidence.partialResult).toEqual({ text: 'partial answer', turns: 2, lastEventSequence: 9, usage, durationMs: 44 });
    expect(result.evidence.exitCode).toBeNull();
    expect(result.evidence.diagnostics[0]?.message).toContain('[REDACTED]');
    expect(result.evidence.diagnostics[0]?.message).not.toContain('top-secret');
  });

  it('[case:f001-diagnostics-bounded] redacts sensitive diagnostics and bounds retained error chain', () => {
    const result = category({
      errorChain: Array.from({ length: 20 }, (_, index) => ({ source: 'sdk', code: `E${index}`, message: `Authorization: secret-${index}\nhttps://secret.example/${index}` })),
      secrets: ['secret-0'],
    });
    expect(result.evidence.diagnostics).toHaveLength(RUNTIME_FAILURE_MAX_DIAGNOSTICS);
    expect(JSON.stringify(result.evidence)).not.toContain('https://secret.example');
    expect(JSON.stringify(result.evidence)).not.toContain('secret-0');
  });

  it('[case:f001-settlement-compatibility] maps only known controlled categories and leaves cancellation/unknown explicit', () => {
    expect(toRuntimeSettlementFailure(category({ http: { status: 401 } }))).toEqual({ kind: 'authentication', reason: 'authentication_failed' });
    expect(toRuntimeSettlementFailure(category({ http: { status: 429, body: 'quota_exceeded' } }))).toEqual({ kind: 'rate_limited', reason: 'quota_blocked' });
    expect(toRuntimeSettlementFailure(category({ cancelRequested: true }))).toBeNull();
    expect(toRuntimeSettlementFailure(category({}))).toBeNull();
  });

  it('[case:f001-existing-runtime-error] preserves legacy controlled kinds while retaining unknown permission semantics', () => {
    const permission = category({ existingRuntimeError: { kind: 'permission', reason: 'required_permission_not_granted' } });
    expect(permission.category).toBe('unknown');
    expect(permission.settlementKind).toBe('permission');
    const provider = category({ existingRuntimeError: { kind: 'provider', reason: 'provider_error' } });
    expect(provider.category).toBe('unknown');
    expect(provider.settlementKind).toBe('provider');
  });

  it('[case:f001-existing-result] classifies existing result facts without resetting known usage', () => {
    const result = classifyRuntimeExecutionResult({
      schemaVersion: 1, terminal: 'timed_out', reason: 'timed_out', exitCode: null, signal: null,
      durationMs: 1000, usage, lastEventSequence: 4,
    });
    expect(result).toMatchObject({ category: 'timeout', evidence: { usage, durationMs: 1000, exitCode: null, signal: null } });
  });
});
