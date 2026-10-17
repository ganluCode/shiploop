import { fileURLToPath } from 'node:url';
import { createIsolatedHostEnvironment } from './helpers/host/index.ts';
import { runBarrierChildren } from './helpers/p02-2/index.ts';
import { describe, expect, it } from 'vitest';
import { classifyCodeAttempt, settleCodeAttemptInTransaction, settleStoredCodeAttemptInTransaction } from '../packages/core/src/application/code-attempt-budget.ts';
import { openClaimFixture } from './helpers/p03-4/task-claim-fixture.ts';
import { createSqliteVerificationStore } from '../packages/core/src/adapters/sqlite/verification-store.ts';
import type { MachineVerificationInput } from '../packages/core/src/ports/verification-aggregate.ts';
import { openBudgetFixture, BUDGET, NOW } from './helpers/p03-3/budget-fixture.ts';

function observation(overrides: Partial<MachineVerificationInput> = {}): MachineVerificationInput {
  const identity = { headCommit: 'a'.repeat(40), codeDigest: 'b'.repeat(64) };
  return {
    runtime: { result: { schemaVersion: 1, terminal: 'completed', reason: null, exitCode: 0, signal: null,
      durationMs: 1, usage: null, lastEventSequence: 1 }, failure: null,
      stopped: { schemaVersion: 1, confirmed: true, checkedAtUtc: '2026-01-01T00:00:00.000Z', detail: null } },
    workspaceHeld: true, beforeIdentity: identity, afterIdentity: identity,
    plan: { status: 'ready', selectedChecks: [{ checkKey: 'unit', required: true }] },
    results: [{ id: 'result-1', createdAtUtcMs: NOW, updatedAtUtcMs: NOW, revision: 1,
      projectId: 'project-1', batchId: 'verification-1', checkKey: 'unit', argv: ['node', 'test.js'],
      cwdRef: null, environmentRef: null, timeoutMs: 1000, status: 'failed', required: true, exitCode: 1, signal: null,
      timedOut: false, outputArtifactId: 'output', outputDigest: 'c'.repeat(64), outputTail: 'failed assertion',
      startedAtUtcMs: NOW, endedAtUtcMs: NOW }],
    evidence: { unit: { status: 'complete', reference: 'output' } }, testCounts: { unit: 1 }, ...overrides,
  };
}
const code = { unit: 'code' as const };

describe('F-009 trusted code attempt classification', () => {
  it('requires complete deterministic code failure, not just a nonzero exit', () => {
    expect(classifyCodeAttempt(observation(), code).outcome).toBe('code_failure');
    expect(classifyCodeAttempt(observation(), {}).outcome).toBe('non_code_failure');
    for (const kind of ['authentication', 'configuration', 'protocol', 'timeout', 'environment', 'recording', 'unknown'] as const) {
      expect(classifyCodeAttempt(observation(), { unit: kind }).outcome).toBe('non_code_failure');
    }
  });
  it('rejects zero tests, incomplete evidence, changing source, and failed Runtime', () => {
    const changes: Partial<MachineVerificationInput>[] = [
      { testCounts: { unit: 0 } }, { testCounts: {} }, { evidence: {} },
      { evidence: { unit: { status: 'incomplete' as const } } },
      { afterIdentity: { headCommit: 'changed', codeDigest: 'b'.repeat(64) } },
      { runtime: { ...observation().runtime, failure: { kind: 'authentication', reason: 'denied' } } },
    ];
    for (const change of changes) expect(classifyCodeAttempt(observation(change), code).outcome).toBe('non_code_failure');
  });
  it('examines all checks before counting, regardless of failure order', () => {
    const first = observation();
    const input = observation({ plan: { status: 'ready', selectedChecks: [
      { checkKey: 'unit', required: true }, { checkKey: 'integration', required: true }] },
      results: [...first.results, { ...first.results[0], id: 'result-2', checkKey: 'integration', timedOut: true }],
      evidence: { ...first.evidence, integration: { status: 'complete' } }, testCounts: { unit: 1, integration: 1 } });
    expect(classifyCodeAttempt(input, { unit: 'code', integration: 'code' }).outcome).toBe('non_code_failure');
    expect(classifyCodeAttempt({ ...input, results: [...input.results].reverse() }, { unit: 'code', integration: 'code' }).outcome).toBe('non_code_failure');
    expect(classifyCodeAttempt({ ...input, results: input.results.map(check => ({ ...check, timedOut: false })) },
      { unit: 'code', integration: 'code' })).toMatchObject({ outcome: 'code_failure', failedCheckKeys: ['integration', 'unit'] });
  });
});

const generous = { batch: { ...BUDGET.batch, maxTotalAttempts: 8, maxRuntimeStarts: 8 },
  run: { ...BUDGET.run, maxAttemptsPerRun: 8 } };

describe('F-009 persistent attempt settlement', () => {
  it('binds finalized F-002 evidence to the reserved Attempt and preserves its input snapshot', async () => {
    const f = await openClaimFixture();
    try {
      const attempt = f.store().claimTask(f.input()).receipt.attempt;
      const before = JSON.stringify(attempt.inputSnapshot);
      const h = f.box;
      const store = createSqliteVerificationStore(h.session, { nowUtcMs: () => NOW });
      const identity = { ...f.ids, attemptKey: attempt.id };
      const unit = observation();
      const checkIdentity = { ...unit.beforeIdentity, executionDigest: 'e'.repeat(64) };
      const input = { projectId: h.projectId, batchId: 'verified-failure', runtime: unit.runtime,
        workspaceHeld: true, beforeIdentity: checkIdentity, afterIdentity: checkIdentity, testCounts: { unit: 1 } };
      h.session.database.prepare(`INSERT INTO artifacts (id, created_at, updated_at, project_id, kind, status,
        media_type, expected_hash, content_hash, size_bytes, storage_locator)
        VALUES ('output', ?, ?, ?, 'verification-output', 'ready', 'text/plain', ?, ?, 10, 'outputs/failure')`)
        .run(NOW, NOW, h.projectId, 'c'.repeat(64), 'c'.repeat(64));
      h.services.atomic.transact('checks', tx => {
        store.createVerificationBatchInTransaction(tx, {
          batchId: input.batchId, projectId: h.projectId, featureId: h.featureId, runId: f.ids.runId, taskId: f.ids.taskId,
          attemptId: attempt.id, executionVersion: attempt.executionVersion, operation: 'task.verify.checks',
          codeDigest: checkIdentity.codeDigest, policyDigest: checkIdentity.executionDigest,
          environmentSummary: {}, checkSnapshot: [{ checkKey: 'unit', scope: 'task', kind: 'command',
            argv: ['node', 'test.js'], cwdRef: null, environmentRef: null, timeout: 1000, required: true, requirementRefs: [] }],
          selection: { schemaVersion: 1, mode: 'full_fallback', reason: 'full checks', selectedCheckKeys: ['unit'] }, startedAtUtcMs: NOW,
        });
        store.saveCheckResultInTransaction(tx, { resultId: 'check-1', projectId: h.projectId, batchId: input.batchId,
          checkKey: 'unit', status: 'failed', exitCode: 1, signal: null, timedOut: false, outputArtifactId: 'output',
          outputTail: 'failed assertion', startedAtUtcMs: NOW, endedAtUtcMs: NOW });
      });
      const settle = () => h.services.atomic.transact('settle', tx => settleStoredCodeAttemptInTransaction(tx, store, identity, input, code));
      expect(settle).toThrow(); // an in-flight batch cannot settle quota
      h.services.atomic.transact('finalize', tx => store.finalizeVerificationBatchInTransaction(tx,
        { projectId: h.projectId, batchId: input.batchId, expectedRevision: 1, status: 'failed', endedAtUtcMs: NOW }));
      expect(settle()).toMatchObject({ outcome: 'code_failure', codeRetryEligible: true });
      expect(settle().counters).toMatchObject({ attemptCounter: 1, codeAttemptsUsed: 1 });
      expect(() => h.services.atomic.transact('wrong-attempt', tx => settleStoredCodeAttemptInTransaction(tx, store,
        { ...identity, attemptKey: 'other' }, input, code))).toThrow();
      expect(h.session.database.prepare('SELECT input_snapshot FROM attempts WHERE id = ?').get(attempt.id))
        .toEqual({ input_snapshot: before });
    } finally { f.box.close(); }
  });
  it('permits at most two repairs; repeated or multiple failures never double charge', async () => {
    const h = await openBudgetFixture(generous);
    try {
      const seed = await h.start();
      for (let n = 1; n <= 3; n++) {
        const identity = { ...seed, attemptKey: `a${n}` };
        h.services.atomic.transact('reserve', tx => tx.reserveTaskAttempt(identity));
        const first = observation();
        const input = n === 2 ? observation({
          plan: { status: 'ready', selectedChecks: [{ checkKey: 'unit', required: true }, { checkKey: 'integration', required: true }] },
          results: [...first.results, { ...first.results[0]!, id: 'result-2', checkKey: 'integration' }],
          evidence: { ...first.evidence, integration: { status: 'complete' } }, testCounts: { unit: 1, integration: 1 },
        }) : first;
        const settle = () => h.services.atomic.transact('settle', tx => settleCodeAttemptInTransaction(tx, identity, input,
          { ...code, integration: 'code' }));
        expect(settle()).toMatchObject({ outcome: 'code_failure', codeRetryEligible: n < 3 });
        expect(settle()).toMatchObject({ counters: { attemptCounter: n, codeAttemptsUsed: n } });
      }
      expect(() => h.services.atomic.transact('reserve', tx => tx.reserveTaskAttempt({ ...seed, attemptKey: 'a4' })))
        .toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'budget_exhausted' }) }));
      h.reopen();
      expect(h.services.atomic.transact('read', tx => tx.getTaskExecutionCounters(seed.projectId, seed.taskId)))
        .toMatchObject({ attemptCounter: 3, codeAttemptsUsed: 3 });
    } finally { h.close(); }
  });
  it('refunds only code quota, survives reopen, and still exhausts parent total attempts', async () => {
    const h = await openBudgetFixture();
    try {
      const seed = await h.start();
      for (let n = 1; n <= 2; n++) {
        const identity = { ...seed, attemptKey: `infra-${n}` };
        h.services.atomic.transact('reserve', tx => {
          tx.reserveTaskAttempt(identity);
          tx.reserveRuntimeStart({ projectId: seed.projectId, batchId: seed.batchId, runId: seed.runId, startKey: `start-${n}` });
        });
        const settle = () => h.services.atomic.transact('settle', tx => settleCodeAttemptInTransaction(tx, identity, observation(), { unit: 'environment' }));
        expect(settle()).toMatchObject({ outcome: 'non_code_failure', codeRetryEligible: false,
          counters: { attemptCounter: n, codeAttemptsUsed: 0 } });
        h.reopen();
        expect(settle().counters.codeAttemptsUsed).toBe(0);
      }
      expect(() => h.services.atomic.transact('reserve', tx => tx.reserveTaskAttempt({ ...seed, attemptKey: 'third' })))
        .toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'budget_exhausted' }) }));
      const parent = h.session.database.prepare('SELECT attempts_created, runtime_starts, deadline_at FROM execution_batches WHERE id = ?').get(seed.batchId);
      expect(parent).toEqual({ attempts_created: 2, runtime_starts: 2, deadline_at: BUDGET.batch.deadlineUtcMs });
    } finally { h.close(); }
  });
  it.each(['duplicate', 'conflicting'] as const)('serializes %s settlements from two real processes', async mode => {
    const h = await openBudgetFixture();
    const environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f009-race-' });
    try {
      const identity = { ...await h.start(), attemptKey: 'raced' };
      h.services.atomic.transact('reserve', tx => tx.reserveTaskAttempt(identity));
      const input = { ...identity, outcome: 'non_code_failure', observationDigest: 'd'.repeat(64) };
      const outcomes = await runBarrierChildren(environment, {
        scriptPath: fileURLToPath(new URL('./helpers/p03-3/budget-race-child.ts', import.meta.url)),
        configs: [input, mode === 'duplicate' ? input : { ...input, outcome: 'code_failure' }]
          .map(input => ({ dbPath: h.box.dbPath, mode: 'attempt-budget-settlement', input })),
        readyTimeoutMs: 10_000, resultTimeoutMs: 10_000,
      });
      for (const child of outcomes) {
        expect(child.exit.code).toBe(0);
        expect(() => process.kill(child.pid, 0)).toThrow();
      }
      const results = outcomes.map(child => child.result as { record?: { classification: string }; error?: { code: string } });
      expect(results.filter(result => result.record)).toHaveLength(mode === 'duplicate' ? 2 : 1);
      if (mode === 'conflicting') expect(results.find(result => result.error)?.error?.code).toBe('conflict');
      const used = results.find(result => result.record)!.record!.classification === 'code' ? 1 : 0;
      h.reopen();
      expect(h.services.atomic.transact('read', tx => tx.getTaskExecutionCounters(identity.projectId, identity.taskId)))
        .toMatchObject({ attemptCounter: 1, codeAttemptsUsed: used });
      expect(h.session.database.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally { await environment.dispose(); h.close(); }
  }, 30_000);

  it('rolls back refund and settlement together and rejects contradictory replay', async () => {
    const h = await openBudgetFixture();
    try {
      const identity = { ...await h.start(), attemptKey: 'atomic' };
      h.services.atomic.transact('reserve', tx => tx.reserveTaskAttempt(identity));
      expect(() => h.services.atomic.transact('fault', tx => {
        settleCodeAttemptInTransaction(tx, identity, observation(), { unit: 'protocol' });
        throw new Error('rollback');
      })).toThrow('rollback');
      expect(h.services.atomic.transact('read', tx => tx.getTaskExecutionCounters(identity.projectId, identity.taskId)).codeAttemptsUsed).toBe(1);
      h.services.atomic.transact('settle', tx => settleCodeAttemptInTransaction(tx, identity, observation(), code));
      expect(() => h.services.atomic.transact('conflict', tx => settleCodeAttemptInTransaction(tx, identity, observation(), { unit: 'protocol' })))
        .toThrowError(expect.objectContaining({ kind: 'conflict' }));
      expect(() => h.services.atomic.transact('refund-final', tx => tx.reclassifyTaskAttemptAsInfrastructure({
        projectId: identity.projectId, taskId: identity.taskId, attemptKey: identity.attemptKey, reason: 'late error' })))
        .toThrowError(expect.objectContaining({ kind: 'conflict' }));
    } finally { h.close(); }
  });
});
