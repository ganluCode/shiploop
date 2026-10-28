import { describe, expect, it } from 'vitest';
import { parseAppCliArgs } from '../../../packages/cli/src/app/args.ts';
import {
  buildBaselineOperationResult,
  formatBaselineComparison,
  formatBaselineOperationResult,
  formatBaselinePreview,
  type BaselineAuthorizationView,
  type BaselineOperationView,
  type BaselinePreviewResultView,
} from '../../../packages/cli/src/app/baseline.ts';

const id = '11111111-1111-4111-8111-111111111111';
const id2 = '22222222-2222-4222-8222-222222222222';
const bindingId = '33333333-3333-4333-8333-333333333333';
const identity = {
  headCommit: 'a'.repeat(40),
  workingTreeDigest: 'b'.repeat(64),
  hasUncommittedChanges: true,
};
const dirtyScope = { status: 'tracked' as const, explanation: 'tracked files changed' };
const environmentIdentity = {
  schemaVersion: 1 as const,
  environmentRef: 'approved-ci',
  definitionRevision: 'env-v4',
  toolchain: { node: '22.19.0' },
  platform: { os: 'darwin', arch: 'arm64' },
  allowedVariables: ['CI'],
  coverage: ['node', 'npm'],
  unknownFields: [],
};

function authorization(): BaselineAuthorizationView {
  return {
    projectId: 'project-1',
    repositoryBindingId: bindingId,
    repositoryBindingRevision: 7,
    codeIdentity: identity,
    dirtyScope,
    environmentIdentity,
    missingFields: [],
    policyRevision: 'c'.repeat(64),
    planDigest: 'd'.repeat(64),
    plan: {
      checks: [{
        checkKey: 'lint', kind: 'command', argv: ['npm', 'run', 'lint'], cwdRef: null,
        environmentRef: 'approved-ci', timeoutMs: 1000, required: true,
      }],
    },
  };
}

function operation(): BaselineOperationView {
  return {
    operationId: id, kind: 'baseline', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z', endedAt: '2026-01-01T00:00:02.000Z',
    summary: { total: 1, passed: 0, failed: 1, error: 0, inconclusive: 0, notRun: 0 },
  };
}

describe('P06-5 F-012 CLI baseline identity and comparison', () => {
  it('[case:compare-args] exposes an explicit read-only comparison command for two selected operations', () => {
    expect(parseAppCliArgs(['baseline', 'compare', id, id2])).toMatchObject({
      commandId: 'baseline.compare', previousOperationId: id, currentOperationId: id2,
    });
  });

  it('[case:preview-identity] keeps binding, dirty scope, approved environment and command identity in preview text', () => {
    const preview: BaselinePreviewResultView = {
      projectId: 'project-1', previewDigest: 'e'.repeat(64), policyRevision: 'f'.repeat(64),
      repositoryBindingId: bindingId, repositoryBindingRevision: 7, bindingRecordRevision: 8,
      codeIdentity: identity, dirtyScope, environmentIdentity,
      workspace: { excludedDirNames: ['node_modules'], fileCount: 3 },
      checks: [{ checkKey: 'lint', kind: 'command', argv: ['npm', 'run', 'lint'], cwdRef: null,
        cwd: '/repo', environmentRef: 'approved-ci', allowedVariables: ['CI'], timeoutMs: 1000, required: true }],
      warnings: [],
    };
    const text = formatBaselinePreview(preview);
    expect(text).toContain(`repositoryBindingId=${bindingId}`);
    expect(text).toContain('repositoryBindingRevision=7');
    expect(text).toContain('dirtyScope=tracked');
    expect(text).toContain('environmentRef=approved-ci');
    expect(text).toContain('coverage=["node","npm"]');
    expect(text).toContain('argv=["npm","run","lint"]');
  });

  it('[case:detail-status] keeps per-check command and historical identity gaps without turning a failed check into success', () => {
    const result = buildBaselineOperationResult(operation(), [{
      checkKey: 'lint', argv: ['npm', 'run', 'lint'], cwdRef: null, environmentRef: 'approved-ci',
      timeoutMs: 1000, required: true, status: 'failed', reasonCode: 'spawn_failed', timedOut: false,
      exitCode: 127, signal: null, durationMs: 3, output: { artifactId: 'artifact-1', byteSize: 4, truncated: false },
    }], identity, authorization());
    const text = formatBaselineOperationResult(result);
    expect(text).toContain(`repositoryBindingId=${bindingId}`);
    expect(text).toContain('dirtyScope=tracked');
    expect(text).toContain('environmentRef=approved-ci');
    expect(text).toContain('argv=["npm","run","lint"]');
    expect(text).toContain('spawn_failed');
    expect(result.state).toBe('failed');
  });

  it('[case:comparison-diagnostics] shows fixed, new and unconfirmable failures with source identities and gaps', () => {
    const text = formatBaselineComparison({
      schemaVersion: 1, projectId: 'project-1', comparable: false,
      previous: { operationId: id, projectId: 'project-1', operationStatus: 'completed', codeIdentity: identity,
        repositoryBindingId: bindingId, repositoryBindingRevision: 7, dirtyScope, environmentIdentity,
        evidence: [], gaps: [] },
      current: { operationId: id2, projectId: 'project-1', operationStatus: 'completed', codeIdentity: identity,
        repositoryBindingId: bindingId, repositoryBindingRevision: 7, dirtyScope, environmentIdentity,
        evidence: [], gaps: ['environment_identity_missing'] },
      codeDiff: { headCommitChanged: false, workingTreeDigestChanged: false, uncommittedChangesChanged: false, anyChanged: false },
      identityDiff: { repositoryBindingChanged: false, dirtyScopeChanged: false, environmentChanged: true },
      checks: [
        { checkKey: 'a', classification: 'fixed', definitionChanged: false, previous: null, current: null, evidence: { previous: null, current: null } },
        { checkKey: 'b', classification: 'new_failure', definitionChanged: false, previous: null, current: null, evidence: { previous: null, current: null } },
        { checkKey: 'c', classification: 'incomparable', reason: 'failure_identity_missing', definitionChanged: false, previous: null, current: null, evidence: { previous: null, current: null } },
      ],
      gaps: ['environment_identity_missing', 'failure_identity_missing'],
    });
    expect(text).toContain('comparable=false');
    expect(text).toContain('fixed');
    expect(text).toContain('new_failure');
    expect(text).toContain('failure_identity_missing');
    expect(text).toContain('environment_identity_missing');
    expect(text).toContain(bindingId);
  });
});
