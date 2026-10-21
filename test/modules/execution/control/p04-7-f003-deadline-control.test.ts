import { describe, expect, it, vi } from 'vitest';
import { superviseExecution } from '../../../../packages/core/src/application/execution-supervision.ts';
import type { RuntimeSession } from '../../../../packages/core/src/application/runtime-execution.ts';
import type { RuntimeExecutionRequest } from '../../../../packages/core/src/ports/runtime-execution.ts';
import type { WorkEvidenceRecordingOutcome } from '../../../../packages/core/src/application/work-evidence-recorder.ts';
import { fixture } from '../../../helpers/p03-6/stopping-fixture.ts';
import { BINDING_NOW } from '../../../helpers/p03-6/input-binding-fixture.ts';

const request = {
  projectId: 'project-1',
  featureId: 'feature-1',
  sessionId: 'session-1',
  owner: { principalId: 'owner-1', hostInstanceId: 'host-1' },
  executionVersion: 1,
  identity: { purpose: 'work', taskId: 'task-1', runId: 'run-1', attemptId: 'attempt-1' },
  limits: { timeoutMs: 100, toolTimeoutMs: null, maxEvents: 10, maxOutputBytes: 1024 },
} as unknown as RuntimeExecutionRequest;

const recording: WorkEvidenceRecordingOutcome = {
  status: 'complete', manifestArtifactId: 'manifest-1', watermark: 0, gaps: [],
  stats: {} as WorkEvidenceRecordingOutcome['stats'],
  result: null, resultStatus: 'settled', sequenceReconciliation: 'match',
};

describe('P04-7 / F-003 deadline supervision', () => {
  it('[case:late-completed-result-is-timeout] preserves timeout when a completed result is observed after its absolute deadline', async () => {
    const cancel = vi.fn(async () => ({ schemaVersion: 1 as const, accepted: true, reason: null }));
    const runtime = { cancel } as unknown as RuntimeSession;
    const result = Promise.resolve({ status: 'fulfilled' as const, value: {
      schemaVersion: 1 as const, terminal: 'completed' as const, reason: null,
      exitCode: 0, signal: null, durationMs: 101, usage: null, lastEventSequence: 0,
    } });
    const stopped = Promise.resolve({ status: 'fulfilled' as const, value: {
      schemaVersion: 1 as const, confirmed: true, checkedAtUtc: new Date(101).toISOString(), detail: null,
    } });
    let control: any;
    const settlement = { async settle(input: any) {
      control = input.control;
      return { disposition: 'applied' as const, resultSaved: true, status: 'failed' as const } as any;
    } };
    const supervision = superviseExecution({
      request, runtime, controller: new AbortController(), result, stopped,
      recording: Promise.resolve({ status: 'fulfilled' as const, value: recording }),
      options: { stopWaitMs: 20, drainWaitMs: 20, closeWaitMs: 20, async retain() {} },
      settlement, quarantine() {}, evidenceRef: () => 'evidence-1',
      timeoutMs: 1_000, timeoutReason: 'runtime_timeout', timeoutLayer: 'session', timeoutLimitMs: 100,
      deadlineUtcMs: 100, nowUtcMs: () => 101,
    });

    await expect(supervision.completion).resolves.toMatchObject({ persisted: true, retained: true });
    expect(control).toMatchObject({ reason: 'runtime_timeout', timeout: {
      layer: 'session', limitMs: 100, deadlineUtcMs: 100,
    } });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('[case:expired-before-adapter-start] blocks a newly expired deadline before invoking the Runtime adapter', async () => {
    let nowCalls = 0;
    const f = await fixture({}, { nowUtcMs: () => nowCalls++ < 2 ? BINDING_NOW : BINDING_NOW + 2_000 });
    try {
      await expect(f.start({ limits: { timeoutMs: 1_000, maxEvents: 1_000, maxOutputBytes: 1_048_576 } }))
        .rejects.toMatchObject({ kind: 'timeout', reason: 'deadline_exhausted' });
      expect(f.rawHandles).toHaveLength(0);
    } finally {
      await f.dispose();
    }
  });
});
