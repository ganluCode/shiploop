import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeRecoveryKind, RuntimeRecoveryReference, RuntimeRecoveryRequest } from '../packages/core/src/index.ts';
import { withTempSandbox } from './helpers/temp-sandbox.ts';
import { SyntheticRecoveryDriver, syntheticCapabilities } from './helpers/runtime-recovery/driver.ts';
import { SyntheticEventRecorder, SyntheticUsageLedger } from './helpers/runtime-recovery/recording.ts';

function request(invocationId = 'invoke-1', source?: RuntimeRecoveryReference): RuntimeRecoveryRequest {
  return {
    schemaVersion: 1, projectId: 'project-1', sessionId: `session-${invocationId}`, executionVersion: source ? 2 : 1,
    invocationId, identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: `attempt-${invocationId}` },
    strategy: { runtime: 'synthetic', provider: 'offline', model: 'scripted' },
    recovery: source ? { mode: 'required', kind: source.kind, source } : { mode: 'new' },
  };
}
const tool = { requestId: 'request-1', toolCallId: 'tool-1', text: 'file-effect', identifiable: true };

describe('F-003 synthetic recovery with real file effects (not SDK evidence)', () => {
  it('keeps invocation/request/tool identities stable across retries and reopen', () => withTempSandbox(root => {
    const first = new SyntheticRecoveryDriver(root);
    const input = request();
    try {
      first.begin(input);
      const result = first.execute(tool);
      expect(result.status).toBe('completed');
      expect(first.begin(input)).toEqual({ mode: 'new', reasons: ['explicit_new'] });
      expect(first.execute(tool)).toEqual(result);
      expect(first.effects()).toHaveLength(1);
      expect(() => first.execute({ ...tool, text: 'conflicting-payload' })).toThrow('request_identity_conflict');
      expect(() => first.begin({ ...input, executionVersion: 2 })).toThrow('invocation_identity_conflict');
    } finally { first.close(); }
    const reopened = new SyntheticRecoveryDriver(root);
    try {
      reopened.begin(input);
      expect(reopened.execute(tool)).toMatchObject({ status: 'completed', requestId: tool.requestId, toolCallId: tool.toolCallId });
      expect(reopened.effects()).toHaveLength(1);
      expect(readFileSync(join(root, 'effects.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    } finally { reopened.close(); }
  }));

  it.each(['before-tool', 'after-tool', 'stream'] as const)('recovers %s interruption without repeating an identifiable effect', point => withTempSandbox(root => {
    const first = new SyntheticRecoveryDriver(root);
    let source: RuntimeRecoveryReference;
    try {
      first.begin(request());
      expect(first.execute(tool, point)).toMatchObject({ status: 'interrupted', stopped: false });
      expect(first.effects()).toHaveLength(point === 'before-tool' ? 0 : 1);
      source = first.archive('checkpoint');
    } finally { first.close(); }
    const sourcePath = join(root, 'artifacts', `${source.nativeArchiveRef}.json`);
    const original = readFileSync(sourcePath);
    const recovered = new SyntheticRecoveryDriver(root);
    try {
      expect(recovered.begin(request('invoke-2', source), 'confirmed')).toMatchObject({ mode: 'resume', kind: 'checkpoint' });
      expect(recovered.execute(tool)).toMatchObject({ status: 'completed', requestId: 'request-1', toolCallId: 'tool-1' });
      expect(recovered.effects()).toHaveLength(1);
      expect(readFileSync(sourcePath)).toEqual(original);
      expect(recovered.resultEnvelope().invocationId).toBe('invoke-2');
    } finally { recovered.close(); }
  }));

  it('quarantines an unidentifiable effect after tool execution but before acknowledgement', () => withTempSandbox(root => {
    const first = new SyntheticRecoveryDriver(root);
    let source: RuntimeRecoveryReference;
    try {
      first.begin(request());
      first.execute({ ...tool, identifiable: false }, 'after-tool');
      source = first.archive('checkpoint');
    } finally { first.close(); }
    const recovered = new SyntheticRecoveryDriver(root);
    try {
      recovered.begin(request('invoke-2', source), 'confirmed');
      const bytes = readFileSync(join(root, 'effects.jsonl'));
      expect(recovered.execute({ ...tool, identifiable: false })).toMatchObject({ status: 'needs_reconciliation', quarantined: true, stopped: false });
      expect(readFileSync(join(root, 'effects.jsonl'))).toEqual(bytes);
      expect(recovered.acceptResult(recovered.resultEnvelope())).toBe('diagnostic_only');
    } finally { recovered.close(); }
  }));

  it('rejects two native writers, retains occupancy on cancel, and rejects stale results', () => withTempSandbox(root => {
    const first = new SyntheticRecoveryDriver(root);
    const second = new SyntheticRecoveryDriver(root);
    try {
      first.begin(request());
      expect(() => second.begin(request())).toThrow('native_writer_busy');
      expect(first.cancel()).toEqual({ accepted: true, stopped: false, quarantined: true });
      expect(() => second.begin(request())).toThrow('native_writer_busy');
      const late = first.resultEnvelope();
      expect(first.acceptResult(late)).toBe('diagnostic_only');
      const source = first.archive('conversation');
      expect(() => second.begin(request('invoke-2', source), 'unknown')).toThrow('stop_unconfirmed');
      expect(() => second.begin(request('invoke-2', source), 'confirmed')).toThrow('native_writer_busy');
      first.close();
      second.begin(request('invoke-2', source), 'confirmed');
      const third = new SyntheticRecoveryDriver(root);
      try {
        expect(() => third.begin(request('invoke-3', source), 'confirmed')).toThrow('native_writer_busy');
      } finally { third.close(); }
      expect(second.acceptResult(late)).toBe('diagnostic_only');
      expect(second.acceptResult({ ...second.resultEnvelope(), executionVersion: 1 })).toBe('diagnostic_only');
      expect(second.acceptResult(second.resultEnvelope())).toBe('diagnostic_only');
      second.execute(tool);
      expect(second.acceptResult(second.resultEnvelope())).toBe('accepted_runtime_result');
    } finally { first.close(); second.close(); }
  }));

  it('does not reopen a cancelled invocation or replay a missing confirmed file effect', () => withTempSandbox(root => {
    const first = new SyntheticRecoveryDriver(root);
    let source: RuntimeRecoveryReference;
    try {
      first.begin(request());
      first.execute(tool);
      first.cancel();
      source = first.archive('checkpoint');
    } finally { first.close(); }
    const reopened = new SyntheticRecoveryDriver(root);
    try {
      reopened.begin(request());
      expect(reopened.execute(tool)).toMatchObject({ status: 'needs_reconciliation', quarantined: true });
    } finally { reopened.close(); }
    rmSync(join(root, 'effects.jsonl'));
    const recovered = new SyntheticRecoveryDriver(root);
    try {
      recovered.begin(request('invoke-2', source), 'confirmed');
      expect(recovered.execute(tool)).toMatchObject({ status: 'needs_reconciliation', quarantined: true });
      expect(recovered.effects()).toHaveLength(0);
    } finally { recovered.close(); }
  }));

  it('equal file payloads with distinct native tool identities are not guessed duplicates', () => withTempSandbox(root => {
    const driver = new SyntheticRecoveryDriver(root);
    try {
      driver.begin(request());
      driver.execute(tool);
      driver.execute({ ...tool, requestId: 'request-2' });
      expect(driver.effects()).toHaveLength(2);
    } finally { driver.close(); }
  }));

  it.each(['conversation', 'checkpoint'] as const)('reads history and safely forks %s without counting historical completion as a new reply', kind => withTempSandbox(root => {
    const first = new SyntheticRecoveryDriver(root);
    let source: RuntimeRecoveryReference;
    try {
      first.begin(request());
      first.execute(tool);
      source = first.archive(kind);
    } finally { first.close(); }
    const second = new SyntheticRecoveryDriver(root);
    try {
      second.begin(request('invoke-2', source), 'confirmed');
      expect(second.history(source)).toHaveLength(1);
      expect(second.newReplies).toBe(0);
      second.execute(tool);
      expect(second.effects()).toHaveLength(1);
      expect(second.newReplies).toBe(1);
      expect(readdirSync(join(root, 'native')).filter(name => name.endsWith('.json'))).toHaveLength(2);
    } finally { second.close(); }
  }));

  it('rejects a real second process opening the same native archive', () => withTempSandbox(root => {
    const first = new SyntheticRecoveryDriver(root);
    try {
      first.begin(request());
      const child = spawnSync(process.execPath, [
        '--import', new URL('./helpers/node-ts-loader/register.mjs', import.meta.url).pathname,
        new URL('./helpers/runtime-recovery/writer-child.ts', import.meta.url).pathname,
        root, JSON.stringify(request()),
      ], { encoding: 'utf8', timeout: 10_000, env: {} });
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status).toBe(1);
      expect(child.stderr).toContain('native_writer_busy');
      expect(child.stdout).not.toContain('writer_acquired');
      expect(first.execute(tool).status).toBe('completed');
    } finally { first.close(); }
  }));

  it('replays an interrupted event stream and separates inherited usage from the new reply', () => withTempSandbox(root => {
    const first = new SyntheticRecoveryDriver(root);
    let source: RuntimeRecoveryReference;
    const recorder = new SyntheticEventRecorder(root);
    try {
      first.begin(request());
      first.execute(tool, 'stream');
      const nativeEvents = first.events();
      recorder.append(nativeEvents[0]);
      expect(recorder.coverage(nativeEvents.length)).toBe('partial');
      expect(first.acceptResult(first.resultEnvelope())).toBe('diagnostic_only');
      source = first.archive('checkpoint');
    } finally { first.close(); }
    const recovered = new SyntheticRecoveryDriver(root);
    try {
      recovered.begin(request('invoke-2', source), 'confirmed');
      recovered.execute(tool);
      const replay = new SyntheticEventRecorder(root);
      const events = recovered.events();
      events.forEach(event => replay.append(event));
      events.forEach(event => replay.append(event));
      expect(events).toHaveLength(4);
      expect(replay.coverage(events.length)).toBe('complete');
      expect(replay.watermark).toBe(4);
      const ledger = new SyntheticUsageLedger();
      recovered.usage().forEach(row => { ledger.add(row); ledger.add(row); });
      expect(ledger.summary()).toEqual({ tokens: 7, coverage: 'complete', reasons: [] });
      expect(recovered.effects()).toHaveLength(1);
      expect(recovered.acceptResult(recovered.resultEnvelope())).toBe('accepted_runtime_result');
      expect(recovered.acceptResult(recovered.resultEnvelope())).toBe('diagnostic_only');
    } finally { recovered.close(); }
  }));

  it.each(['missing', 'corrupt', 'checkpoint-missing'] as const)('rejects %s immutable source before creating a writer even for auto', failure => withTempSandbox(root => {
    const first = new SyntheticRecoveryDriver(root);
    let source: RuntimeRecoveryReference;
    try { first.begin(request()); source = first.archive('checkpoint'); } finally { first.close(); }
    const path = join(root, 'artifacts', `${failure === 'checkpoint-missing' && source.kind === 'checkpoint' ? source.checkpointRef : source.nativeArchiveRef}.json`);
    if (failure === 'corrupt') writeFileSync(path, '{}'); else rmSync(path);
    const recovered = new SyntheticRecoveryDriver(root);
    try {
      const originalRequest = request('invoke-2', source);
      const input = { ...originalRequest, recovery: { mode: 'auto' as const, kind: source.kind, source } };
      expect(() => recovered.begin(input, 'confirmed')).toThrow();
      expect(existsSync(join(root, 'native', 'invoke-2.json'))).toBe(false);
    } finally { recovered.close(); }
  }));

  it.each(['conversation', 'checkpoint'] as RuntimeRecoveryKind[])('history-only capability does not satisfy required %s', kind => withTempSandbox(root => {
    const first = new SyntheticRecoveryDriver(root);
    let source: RuntimeRecoveryReference;
    try { first.begin(request()); first.execute(tool); source = first.archive(kind); } finally { first.close(); }
    const supported = syntheticCapabilities();
    const capabilities = { ...supported, capabilities: { ...supported.capabilities,
      conversationResume: { status: 'unsupported' as const, limits: [] },
      executionRecovery: { status: 'unsupported' as const, limits: [] } } };
    const second = new SyntheticRecoveryDriver(root, capabilities);
    try {
      expect(second.history(source)).toHaveLength(1);
      expect(second.begin(request('invoke-2', source), 'confirmed').mode).toBe('rejected');
      expect(existsSync(join(root, 'native', 'invoke-2.json'))).toBe(false);
      const input = { ...request('invoke-2', source), recovery: { mode: 'auto' as const, kind, source } };
      expect(second.begin(input, 'confirmed').mode).toBe('new');
      expect(second.newReplies).toBe(0);
    } finally { second.close(); }
  }));
});
