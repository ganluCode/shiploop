import { describe, expect, it } from 'vitest';
import {
  createExecutionStopDiagnosticLedger,
  isExecutionStopDiagnostic,
  recordExecutionStopDiagnostic,
  validateExecutionStopDiagnostic,
} from 'shiploop-core';

const observed = '2026-10-20T12:01:22.000Z';
const gapless = { state: 'confirmed' as const, checkedAtUtc: observed, detail: null, gaps: [] as string[] };

function diagnostic() {
  return {
    schemaVersion: 1,
    kind: 'execution-stop-diagnostic',
    identity: {
      projectId: 'project-1', runId: 'run-1', batchId: 'batch-1', attemptId: 'attempt-1',
      sessionId: 'session-1', toolCallId: 'tool-1', checkKey: 'check-1', commandId: 'command-1',
      owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 2,
      processIdentity: { launchId: 'launch-1', pid: 42, processGroupId: 42, startTime: '12:01:22' },
    },
    operation: { operationId: 'operation-1', requestedAtUtc: observed, observedAtUtc: observed, observedOnHostInstanceId: 'host-1' },
    source: 'timeout', reason: 'crash',
    status: 'unconfirmed',
    budget: { layer: 'session', limitMs: 1_000, elapsedMs: 1_001, deadlineUtc: observed },
    timing: { lastActivityAtUtc: observed, lastActivityKind: 'tool_finished', gracefulRequestedAtUtc: observed, forcedAtUtc: null },
    escalation: { graceful: 'confirmed', forced: 'not_started' },
    exit: { exitCode: null, signal: 'SIGTERM', reason: 'supervisor_lost', forced: null },
    observations: {
      process: { ...gapless, tree: 'confirmed' as const, group: 'confirmed' as const,
        processIdentity: { launchId: 'launch-1', pid: 42, processGroupId: 42, startTime: '12:01:22' } },
      sdkRuntime: { ...gapless, result: 'unconfirmed' as const, stop: 'unknown' as const, gaps: ['runtime_result_unobserved'] },
      verifier: { ...gapless },
      recording: { ...gapless, eventFlush: 'confirmed' as const, manifestRef: 'manifest-1', finalSequence: 8 },
      workResource: { ...gapless },
      lease: { state: 'quarantined' as const, checkedAtUtc: observed, detail: 'stop not confirmed', gaps: ['stop_not_confirmed'] },
    },
    followUp: { allowed: ['read_diagnostic', 'retry_stop_with_same_identity'], blocked: ['release_work_resource', 'release_lease', 'start_attempt', 'switch_fallback'] },
    gaps: ['runtime_result_unobserved'],
  };
}

describe('P04-7 / F-001 stop diagnostic contract', () => {
  it('[case:diagnostic-captures-independent-facts] distinguishes request source from actual reason and keeps all observation domains', () => {
    const value = validateExecutionStopDiagnostic(diagnostic());
    expect(value.source).toBe('timeout');
    expect(value.reason).toBe('crash');
    expect(value.budget.layer).toBe('session');
    expect(value.observations.sdkRuntime.stop).toBe('unknown');
    expect(value.observations.lease.state).toBe('quarantined');
    expect(value.followUp.blocked).toEqual(expect.arrayContaining(['release_lease', 'start_attempt', 'switch_fallback']));
    expect(isExecutionStopDiagnostic(value)).toBe(true);
  });

  it('[case:unknown-observation-requires-gap] rejects an unknown observation without a traceable gap', () => {
    const value = diagnostic();
    value.observations.verifier = { state: 'unknown', checkedAtUtc: null, detail: null, gaps: [] };
    expect(() => validateExecutionStopDiagnostic(value)).toThrow();
  });

  it('[case:diagnostic-ledger-first-fact] keeps the first fact for duplicate, late, and cross-host replay', () => {
    const first = diagnostic();
    const late = diagnostic();
    late.operation = { ...late.operation, observedAtUtc: '2026-10-20T12:02:22.000Z', observedOnHostInstanceId: 'host-2' };
    late.reason = 'completed';
    const ledger = createExecutionStopDiagnosticLedger();
    expect(ledger.record(first).disposition).toBe('accepted');
    expect(ledger.record(late).disposition).toBe('ignored_late');
    expect(ledger.read('operation-1')!.diagnostic.reason).toBe('crash');
    expect(Object.isFrozen(ledger.read('operation-1'))).toBe(true);
    const replay = recordExecutionStopDiagnostic(ledger.read('operation-1'), late);
    expect(replay.disposition).toBe('ignored_late');
    expect(replay.entry.diagnostic.reason).toBe('crash');
  });
});
