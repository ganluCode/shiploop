import { describe, expect, it, vi } from 'vitest';
import {
  decideRuntimeRecovery,
  validateRuntimeRecoveryRequest,
  validateRuntimeRecoveryCapabilities,
} from '../../../../packages/core/src/index.ts';
import type { RuntimeRecoveryCapabilityName } from '../../../../packages/core/src/index.ts';

const digest = 'a'.repeat(64);
function source(kind = 'conversation', purpose = 'work') {
  return {
    schemaVersion: 1, purpose, kind, sourceProjectId: 'project-1',
    sourceSessionId: purpose === 'chat' ? 'session-new' : 'session-old', runtime: 'fake', provider: 'provider', model: 'model',
    providerSessionId: 'native:session/1', nativeArchiveRef: 'artifact-native',
    nativeFormat: 'synthetic-json', nativeFormatVersion: '1.0', sourceDigest: digest,
    ...(purpose === 'work'
      ? { sourceTaskId: 'task-1', sourceAttemptId: 'attempt-old' }
      : { sourceTurnId: 'turn-old' }),
    ...(kind === 'checkpoint' ? { checkpointRef: 'artifact-checkpoint' } : {}),
  };
}
function request(kind = 'conversation', purpose = 'work') {
  return {
    schemaVersion: 1, projectId: 'project-1', sessionId: 'session-new', executionVersion: 2,
    invocationId: 'invocation-1',
    identity: purpose === 'work'
      ? { purpose, runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-new' }
      : { purpose, sessionId: 'session-new', turnId: 'turn-new' },
    strategy: { runtime: 'fake', provider: 'provider', model: 'model' },
    recovery: { mode: 'required', kind, source: source(kind, purpose) },
  };
}
const names: RuntimeRecoveryCapabilityName[] = [
  'nativeHistory', 'conversationResume', 'executionRecovery', 'modelSwitchOnResume', 'nativeFork',
];
function capabilities() {
  return {
    schemaVersion: 1, runtimeId: 'fake', adapterVersion: '1.0.0', sdkVersion: null,
    nativeFormats: [{ format: 'synthetic-json', versions: ['1.0'] }], limits: [],
    capabilities: Object.fromEntries(names.map((name) => [name, {
      status: 'verified', limits: [], evidenceRef: 'artifact-evidence',
    }])),
  };
}
function invalid(fn: () => unknown) {
  expect(fn).toThrowError(expect.objectContaining({ kind: 'validation' }));
}

describe('F-001 runtime recovery request boundary', () => {
  it.each(['work', 'chat'])('accepts %s conversation and checkpoint sources', (purpose) => {
    for (const kind of ['conversation', 'checkpoint']) {
      const input = request(kind, purpose);
      expect(validateRuntimeRecoveryRequest(input)).toEqual(input);
    }
  });
  it('accepts explicit new without a source and auto without a source', () => {
    const input = request();
    expect(validateRuntimeRecoveryRequest({ ...input, recovery: { mode: 'new' } }).recovery)
      .toEqual({ mode: 'new' });
    expect(validateRuntimeRecoveryRequest({ ...input, recovery: { mode: 'auto', kind: 'conversation' } }).recovery)
      .toEqual({ mode: 'auto', kind: 'conversation' });
  });
  it.each([
    ['unknown root', (r: any) => { r.extra = true; }],
    ['unknown identity', (r: any) => { r.identity.requestId = 'sdk-id'; }],
    ['unknown strategy', (r: any) => { r.strategy.sdkOptions = {}; }],
    ['unknown recovery', (r: any) => { r.recovery.fallback = true; }],
    ['unknown source', (r: any) => { r.recovery.source.path = '/tmp/native.db'; }],
    ['missing invocation', (r: any) => { delete r.invocationId; }],
    ['unsafe invocation', (r: any) => { r.invocationId = '../id'; }],
    ['missing identity', (r: any) => { delete r.identity; }],
    ['illegal purpose', (r: any) => { r.identity.purpose = 'tool'; }],
    ['illegal schema', (r: any) => { r.schemaVersion = 2; }],
    ['illegal source schema', (r: any) => { r.recovery.source.schemaVersion = '1'; }],
    ['illegal execution version', (r: any) => { r.executionVersion = Number.MAX_SAFE_INTEGER + 1; }],
    ['illegal mode', (r: any) => { r.recovery.mode = 'resume'; }],
    ['illegal kind', (r: any) => { r.recovery.kind = 'history'; }],
    ['missing required source', (r: any) => { delete r.recovery.source; }],
    ['new with source', (r: any) => { r.recovery.mode = 'new'; }],
    ['cross purpose', (r: any) => { r.recovery.source = source('conversation', 'chat'); }],
    ['cross project', (r: any) => { r.recovery.source.sourceProjectId = 'another'; }],
    ['cross task', (r: any) => { r.recovery.source.sourceTaskId = 'another'; }],
    ['same attempt', (r: any) => { r.recovery.source.sourceAttemptId = r.identity.attemptId; }],
    ['cross runtime', (r: any) => { r.recovery.source.runtime = 'other'; }],
    ['kind contradiction', (r: any) => { r.recovery.source.kind = 'checkpoint'; }],
    ['missing source session', (r: any) => { delete r.recovery.source.sourceSessionId; }],
    ['missing native identity', (r: any) => { delete r.recovery.source.providerSessionId; }],
    ['missing source attempt', (r: any) => { delete r.recovery.source.sourceAttemptId; }],
    ['missing archive', (r: any) => { delete r.recovery.source.nativeArchiveRef; }],
    ['absolute archive path', (r: any) => { r.recovery.source.nativeArchiveRef = '/tmp/native'; }],
    ['missing format', (r: any) => { delete r.recovery.source.nativeFormat; }],
    ['missing native version', (r: any) => { delete r.recovery.source.nativeFormatVersion; }],
    ['illegal native version', (r: any) => { r.recovery.source.nativeFormatVersion = '1 2'; }],
    ['illegal digest', (r: any) => { r.recovery.source.sourceDigest = 'A'.repeat(64); }],
    ['conversation checkpoint', (r: any) => { r.recovery.source.checkpointRef = 'checkpoint'; }],
  ])('rejects %s before dispatch (zero I/O)', (_name, mutate) => {
    const input = request();
    mutate(input);
    const dispatch = vi.fn();
    invalid(() => dispatch(validateRuntimeRecoveryRequest(input)));
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('requires every execution and native-source identity field', () => {
    for (const field of ['schemaVersion', 'projectId', 'sessionId', 'executionVersion', 'strategy', 'recovery']) {
      const input = request();
      delete (input as any)[field];
      invalid(() => validateRuntimeRecoveryRequest(input));
    }
    for (const purpose of ['work', 'chat']) {
      for (const field of purpose === 'work' ? ['runId', 'taskId', 'attemptId'] : ['sessionId', 'turnId']) {
        const input = request('conversation', purpose);
        delete (input.identity as any)[field];
        invalid(() => validateRuntimeRecoveryRequest(input));
      }
      for (const field of ['schemaVersion', 'purpose', 'kind', 'sourceProjectId', 'sourceDigest', 'runtime', 'provider', 'model',
        ...(purpose === 'chat' ? ['sourceTurnId'] : [])]) {
        const input = request('conversation', purpose);
        delete (input.recovery.source as any)[field];
        invalid(() => validateRuntimeRecoveryRequest(input));
      }
    }
  });
  it('does not alias mutable request input', () => {
    const input = request();
    const validated = validateRuntimeRecoveryRequest(input);
    input.invocationId = 'different';
    input.recovery.source.sourceDigest = 'b'.repeat(64);
    expect(validated.invocationId).toBe('invocation-1');
    expect(validated.recovery.mode !== 'new' && validated.recovery.source?.sourceDigest).toBe(digest);
  });
  it('requires a checkpoint Artifact reference, not a path', () => {
    const input = request('checkpoint');
    delete (input.recovery.source as any).checkpointRef;
    invalid(() => validateRuntimeRecoveryRequest(input));
    (input.recovery.source as any).checkpointRef = '../checkpoint';
    invalid(() => validateRuntimeRecoveryRequest(input));
  });
  it('checks Chat session and Turn identity without inventing an Attempt', () => {
    const input = request('conversation', 'chat');
    input.identity.sessionId = 'different';
    invalid(() => validateRuntimeRecoveryRequest(input));
    input.identity.sessionId = input.sessionId;
    input.recovery.source.sourceSessionId = 'different';
    invalid(() => validateRuntimeRecoveryRequest(input));
    input.recovery.source.sourceSessionId = input.sessionId;
    (input.recovery.source as any).sourceTurnId = input.identity.turnId;
    invalid(() => validateRuntimeRecoveryRequest(input));
  });
});

describe('F-001 independently verified recovery capabilities', () => {
  it('validates versions, explicit limits and evidence for every capability', () => {
    expect(validateRuntimeRecoveryCapabilities(capabilities())).toEqual(capabilities());
  });
  it.each([
    ['missing capability', (c: any) => { delete c.capabilities.nativeFork; }],
    ['unknown capability', (c: any) => { c.capabilities.resume = c.capabilities.nativeHistory; }],
    ['unknown root', (c: any) => { c.executable = true; }],
    ['unknown format', (c: any) => { c.nativeFormats[0].path = '/tmp/db'; }],
    ['unknown evidence field', (c: any) => { c.capabilities.nativeFork.enabled = true; }],
    ['missing evidence', (c: any) => { delete c.capabilities.nativeFork.evidenceRef; }],
    ['illegal status', (c: any) => { c.capabilities.nativeFork.status = true; }],
    ['missing limits', (c: any) => { delete c.capabilities.executionRecovery.limits; }],
    ['illegal limits', (c: any) => { c.limits = ['']; }],
    ['illegal version', (c: any) => { c.adapterVersion = ' '; }],
    ['illegal sdk version', (c: any) => { c.sdkVersion = 42; }],
    ['illegal schema', (c: any) => { c.schemaVersion = 0; }],
    ['duplicate format', (c: any) => { c.nativeFormats.push(c.nativeFormats[0]); }],
    ['empty versions', (c: any) => { c.nativeFormats[0].versions = []; }],
    ['duplicate version', (c: any) => { c.nativeFormats[0].versions.push('1.0'); }],
  ])('rejects %s', (_label, mutate) => {
    const input = capabilities();
    mutate(input);
    invalid(() => validateRuntimeRecoveryCapabilities(input));
  });
  it('does not alias capability evidence or version lists', () => {
    const input = capabilities();
    const validated = validateRuntimeRecoveryCapabilities(input);
    input.nativeFormats[0].versions.push('99');
    input.capabilities.nativeFork.status = 'unsupported';
    expect(validated.nativeFormats[0].versions).toEqual(['1.0']);
    expect(validated.capabilities.nativeFork.status).toBe('verified');
  });
  it('rejects malformed requests and descriptors before computing a decision', () => {
    invalid(() => decideRuntimeRecovery({ ...request(), invocationId: null }, capabilities()));
    invalid(() => decideRuntimeRecovery(request(), { ...capabilities(), schemaVersion: 2 }));
    invalid(() => decideRuntimeRecovery(request(), null));
  });
  it.each(['conversation', 'checkpoint'])('selects verified %s without requiring history read', (kind) => {
    const caps = capabilities();
    caps.capabilities.nativeHistory.status = 'unsupported';
    expect(decideRuntimeRecovery(request(kind), caps)).toEqual({ mode: 'resume', kind, reasons: [] });
  });
  it.each(['unsupported', 'unverified'])('required rejects and auto explains %s capabilities', (status) => {
    for (const kind of ['conversation', 'checkpoint']) {
      const caps = capabilities();
      const name = kind === 'checkpoint' ? 'executionRecovery' : 'conversationResume';
      caps.capabilities[name].status = status;
      expect(decideRuntimeRecovery(request(kind), caps)).toEqual({
        mode: 'rejected', reasons: [`${name}:${status}`],
      });
      const input = request(kind);
      input.recovery.mode = 'auto';
      expect(decideRuntimeRecovery(input, caps)).toEqual({ mode: 'new', reasons: [`${name}:${status}`] });
    }
  });
  it('does not substitute conversation resume for checkpoint recovery', () => {
    const caps = capabilities();
    caps.capabilities.executionRecovery.status = 'unsupported';
    expect(decideRuntimeRecovery(request('checkpoint'), caps).mode).toBe('rejected');
  });
  it('requires nativeFork to preserve immutable sources', () => {
    const caps = capabilities();
    caps.capabilities.nativeFork.status = 'unverified';
    expect(decideRuntimeRecovery(request(), caps)).toEqual({ mode: 'rejected', reasons: ['nativeFork:unverified'] });
  });
  it.each(['provider', 'model'])('checks %s switch separately', (field) => {
    const caps = capabilities();
    caps.capabilities.modelSwitchOnResume.status = 'unsupported';
    const input = request();
    (input.strategy as any)[field] = 'changed';
    expect(decideRuntimeRecovery(input, caps)).toEqual({ mode: 'rejected', reasons: ['modelSwitchOnResume:unsupported'] });
    caps.capabilities.modelSwitchOnResume.status = 'verified';
    expect(decideRuntimeRecovery(input, caps).mode).toBe('resume');
  });
  it('fails closed on missing descriptors, wrong runtime and incompatible format versions', () => {
    expect(decideRuntimeRecovery(request(), undefined)).toEqual({ mode: 'rejected', reasons: ['capabilities:unverified'] });
    const caps = capabilities();
    caps.runtimeId = 'other';
    expect(decideRuntimeRecovery(request(), caps)).toEqual({ mode: 'rejected', reasons: ['runtime:mismatch'] });
    caps.runtimeId = 'fake';
    caps.nativeFormats[0].versions = ['2.0'];
    expect(decideRuntimeRecovery(request(), caps)).toEqual({ mode: 'rejected', reasons: ['nativeFormat:unsupported'] });
  });
  it('records explicit new and missing-source auto decisions', () => {
    const input = request();
    expect(decideRuntimeRecovery({ ...input, recovery: { mode: 'new' } }, undefined))
      .toEqual({ mode: 'new', reasons: ['explicit_new'] });
    expect(decideRuntimeRecovery({ ...input, recovery: { mode: 'auto', kind: 'checkpoint' } }, undefined))
      .toEqual({ mode: 'new', reasons: ['source:missing'] });
  });
});
