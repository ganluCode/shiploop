import { describe, expect, it } from 'vitest';
import { aggregateMachineVerification } from '../../../packages/core/src/application/verification-aggregate.js';
import type { MachineVerificationInput } from '../../../packages/core/src/ports/verification-aggregate.js';

const runtime = (overrides: Partial<MachineVerificationInput['runtime']> = {}): MachineVerificationInput['runtime'] => ({
  result: { schemaVersion: 1, terminal: 'completed', reason: null, exitCode: 0, signal: null,
    durationMs: 10, usage: null, lastEventSequence: 1 },
  failure: null,
  stopped: { schemaVersion: 1, confirmed: true, checkedAtUtc: '2026-01-01T00:00:00.000Z', detail: null },
  ...overrides,
});
const identity = (overrides: Record<string, string> = {}) => ({
  headCommit: 'a'.repeat(40), codeDigest: 'b'.repeat(64), trackedPathsDigest: 'c', untrackedPathsDigest: 'd',
  executionDigest: 'e', environmentDigest: 'f', ...overrides,
});
const check = (checkKey: string, required = true, status: string = 'passed') => ({
  checkKey, required, status, outputArtifactId: 'artifact-1',
});
const base = (overrides: Partial<MachineVerificationInput> = {}): MachineVerificationInput => ({
  runtime: runtime(), workspaceHeld: true, beforeIdentity: identity(), afterIdentity: identity(),
  plan: { status: 'ready', selectedChecks: [{ checkKey: 'unit', required: true }] },
  results: [check('unit') as never], evidence: { unit: { status: 'complete', reference: 'evidence-1' } },
  testCounts: { unit: 2 }, ...overrides,
});

describe('P03-7 F-006 machine verification aggregation', () => {
  it('passes only with a complete required check, evidence, and nonzero tests', () => {
    expect(aggregateMachineVerification(base())).toMatchObject({ status: 'passed', machinePassed: true, category: 'passed' });
    expect(aggregateMachineVerification(base({ testCounts: { unit: 0 } }))).toMatchObject({
      status: 'inconclusive', category: 'zero_tests', machinePassed: false,
    });
    expect(aggregateMachineVerification(base({ evidence: {} }))).toMatchObject({
      status: 'inconclusive', category: 'evidence_incomplete', machinePassed: false,
    });
  });

  it.each([
    ['empty_check_set', { plan: { status: 'ready' as const, selectedChecks: [] }, results: [], evidence: {} }],
    ['missing_required_check', { results: [], evidence: {} }],
    ['not_run', { results: [check('unit', true, 'not_run') as never], evidence: {} }],
    ['error', { results: [check('unit', true, 'error') as never] }],
    ['inconclusive', { results: [check('unit', true, 'inconclusive') as never] }],
  ] as const)('rejects %s as machine success', (_name, overrides) => {
    const result = aggregateMachineVerification(base(overrides));
    expect(result.machinePassed).toBe(false);
    expect(result.status).not.toBe('passed');
  });

  it('does not let optional checks hide required failure or baseline failure', () => {
    const requiredFailure = aggregateMachineVerification(base({
      plan: { status: 'ready', selectedChecks: [{ checkKey: 'unit', required: true }, { checkKey: 'lint', required: false }] },
      results: [check('unit', true, 'failed') as never, check('lint', false) as never],
      evidence: { lint: { status: 'complete' } },
    }));
    expect(requiredFailure).toMatchObject({ machinePassed: false, status: 'failed' });
    expect(aggregateMachineVerification(base({ baseline: { status: 'failed' } }))).toMatchObject({
      machinePassed: false, category: 'baseline_failed',
    });
  });

  it('invalidates old evidence when source or execution identity changes', () => {
    expect(aggregateMachineVerification(base({ afterIdentity: identity({ codeDigest: 'changed' }) }))).toMatchObject({
      machinePassed: false, category: 'source_changed',
    });
    expect(aggregateMachineVerification(base({ afterIdentity: identity({ environmentDigest: 'changed' }) }))).toMatchObject({
      machinePassed: false, category: 'execution_identity_changed',
    });
  });

  it('keeps Runtime errors authoritative and only permits diagnosis after confirmed stop', () => {
    const runtimeError = runtime({
      result: { schemaVersion: 1, terminal: 'failed', reason: 'provider_down', exitCode: null, signal: null,
        durationMs: 10, usage: null, lastEventSequence: 1 },
      failure: { kind: 'provider', reason: 'provider_down' },
    });
    expect(aggregateMachineVerification(base({ runtime: runtimeError, diagnostic: true }))).toMatchObject({
      status: 'error', category: 'runtime_error', machinePassed: false,
    });
    expect(aggregateMachineVerification(base({ runtime: { ...runtimeError, stopped: { ...runtimeError.stopped!, confirmed: false } } }))).toMatchObject({
      category: 'runtime_not_stopped', machinePassed: false,
    });
  });

  it('preserves human review independently from the machine decision', () => {
    expect(aggregateMachineVerification(base({ humanReview: { status: 'pending', reviewer: 'human-1' } }))).toMatchObject({
      status: 'passed', humanReview: { status: 'pending', reviewer: 'human-1' },
    });
  });
});
