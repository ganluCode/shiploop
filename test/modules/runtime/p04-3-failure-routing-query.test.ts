import { describe, expect, it } from 'vitest';
import { toPublicWorkSessionResultEvidence, validatePublicWorkSessionResultEvidence, validateWorkSessionResultEvidence }
  from '../../../packages/core/src/ports/work-session-query.ts';

const legacy = () => ({ schemaVersion: 1, kind: 'runtime-settlement', identity: {},
  execution: { result: null, failure: { kind: 'process', reason: 'unknown_failure' } },
  recording: { complete: false, manifestRef: null, failure: null, gaps: [], watermark: null },
  stop: { evidence: null, failure: null } });
const routing = () => ({ category: 'unknown', previousFailures: [{ category: 'transient_server', reason: 'temporary_server_failure' }],
  selected: { runtime: 'pi', provider: 'anthropic', model: 'backup-model', source: 'task.backup' } });

describe('F-007 bounded public routing diagnostics', () => {
  it('[case:query-legacy] preserves old settlement and Host wire compatibility when no routing evidence exists', () => {
    const publicEvidence = toPublicWorkSessionResultEvidence(validateWorkSessionResultEvidence(legacy()));
    expect(publicEvidence).not.toHaveProperty('routing');
    expect(validatePublicWorkSessionResultEvidence(publicEvidence)).toEqual(publicEvidence);
  });

  it('[case:query-history] preserves unknown classification, prior failures and selection through the public wire', () => {
    const evidence = toPublicWorkSessionResultEvidence(validateWorkSessionResultEvidence({ ...legacy(), routing: routing() }));
    expect(evidence.routing).toEqual(routing());
    expect(validatePublicWorkSessionResultEvidence(evidence)).toEqual(evidence);
  });

  it.each([
    { id: 'oversized', value: { ...routing(), previousFailures: Array(33).fill({ category: 'unknown', reason: 'unknown_failure' }) } },
    { id: 'bad-category', value: { ...routing(), category: 'success_despite_error' } },
    { id: 'credential', value: { ...routing(), selected: { ...routing().selected, credentialRef: 'never-public' } } },
    { id: 'raw-text', value: { ...routing(), previousFailures: [{ category: 'unknown', reason: 'https://private/?api_key=secret' }] } },
  ])('[case:query-reject-$id] rejects invalid or unbounded routing data at both evidence boundaries', ({ value }) => {
    expect(() => validateWorkSessionResultEvidence({ ...legacy(), routing: value })).toThrow();
    const publicEvidence = toPublicWorkSessionResultEvidence(validateWorkSessionResultEvidence(legacy()));
    expect(() => validatePublicWorkSessionResultEvidence({ ...publicEvidence, routing: value })).toThrow();
  });
});
