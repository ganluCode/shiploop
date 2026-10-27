import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAcceptedReceipt, validateCommandEnvelope } from '../../../packages/core/src/ports/commands.ts';
import { validateCommandReceiptWire, validateExecutionPreviewResultWire } from '../../../packages/host/src/client/app-wire.ts';

const digest = 'a'.repeat(64);
const budget = { batch: { maxRuns: 2, maxTotalAttempts: 4, maxRuntimeStarts: 4, maxNoProgressRuns: 2, deadlineUtcMs: 1_900_000_000_000 }, run: { maxAttemptsPerRun: 2, runTimeLimitMs: 60_000 } };
function preview() {
  const members = ['feature-a', 'feature-b'].map(featureId => ({ featureId, revision: 1, planDigest: digest }));
  return {
    schemaVersion: 1, projectId: randomUUID(), scope: { phaseId: 'phase-1', phaseRevision: 1, featureIds: members.map(m => m.featureId),
      requestedFeatureIds: ['feature-b'], memberFeatureIds: members.map(m => m.featureId), members },
    status: 'ready', noWorkReason: null, blocked: [] as unknown[], previewDigest: digest, runtimeExecution: false, generatedAtUtcMs: 1_800_000_000_000,
    summary: {
      members: members.map(member => ({ ...member, planStatus: 'approved', status: 'ready', taskCount: 1, pendingTaskIds: ['task-1'], codeBaselineRefs: ['baseline-1'],
        readiness: { featureId: member.featureId, dependencyCompleted: true, dependencyCompletion: 'complete', integrationReady: false, dependencyIntegrationReady: true, ready: true, reason: 'ready' } })),
      approval: { planDigest: digest, checkPolicyDigest: digest, decisionId: null }, plan: { planDigest: digest, taskCount: 2, pendingTaskIds: ['task-1', 'task-1'] },
      code: { headCommit: 'a'.repeat(40), workingTreeDigest: digest, hasUncommittedChanges: false }, checkPolicyDigest: digest,
      tasks: members.map(m => ({ featureId: m.featureId, taskId: 'task-1', status: 'pending', strategyCopyDigest: digest, strategyConfigSource: 'project' })),
      permissions: { tasks: members.map(m => ({ featureId: m.featureId, taskId: 'task-1', digest })) }, inputs: { refs: [] }, budget,
      concurrency: { maxConcurrentWorks: 1, source: 'project' },
    },
  };
}

describe('P05-3 F-006 fail-closed multi-member wire', () => {
  it('[case:complete-multi-preview] accepts complete member identities, repeated Task IDs in different Features and closure', () => {
    const value = preview();
    expect(validateExecutionPreviewResultWire(value)).toEqual(value);
  });
  it.each<[string, (value: any) => void]>([
    ['alias mismatch', value => { value.scope.memberFeatureIds[0] = 'other'; }],
    ['duplicate scope', value => { value.scope.featureIds[1] = value.scope.featureIds[0]; }],
    ['requested outside closure', value => { value.scope.requestedFeatureIds = ['other']; }],
    ['missing member identity', value => { value.scope.members.pop(); }],
    ['duplicate member identity', value => { value.scope.members[1] = value.scope.members[0]; }],
    ['summary outside closure', value => { value.summary.members[0].featureId = 'other'; }],
    ['missing member summary', value => { delete value.summary.members; }],
    ['stale member revision', value => { value.summary.members[0].revision++; }],
    ['stale member digest', value => { value.summary.members[0].planDigest = 'b'.repeat(64); }],
    ['wrong readiness owner', value => { value.summary.members[0].readiness.featureId = 'other'; }],
    ['invalid readiness reason', value => { value.summary.members[0].readiness.reason = 'invented'; }],
    ['inconsistent readiness', value => { value.summary.members[0].readiness.dependencyCompletion = 'failed'; }],
    ['wrong Task owner', value => { value.summary.tasks[0].featureId = 'other'; }],
    ['missing Task owner', value => { delete value.summary.tasks[0].featureId; }],
    ['duplicate Task identity', value => { value.summary.tasks[1] = value.summary.tasks[0]; }],
    ['missing permissions', value => { value.summary.permissions.tasks.pop(); }],
    ['duplicate permissions', value => { value.summary.permissions.tasks[1] = value.summary.permissions.tasks[0]; }],
    ['wrong aggregate digest', value => { value.summary.plan.planDigest = 'b'.repeat(64); }],
    ['wrong policy digest', value => { value.summary.checkPolicyDigest = 'b'.repeat(64); }],
    ['wrong aggregate count', value => { value.summary.plan.taskCount++; }],
    ['wrong member count', value => { value.summary.members[0].taskCount++; }],
    ['wrong pending Tasks', value => { value.summary.plan.pendingTaskIds.pop(); }],
    ['wrong member pending Tasks', value => { value.summary.members[0].pendingTaskIds = []; }],
    ['unknown field', value => { value.scope.authorization = true; }],
    ['bad phase revision', value => { value.scope.phaseRevision = -1; }],
    ['ready with blockers', value => { value.blocked = [{ kind: 'feature_dependency', featureId: 'feature-a', reason: 'dependency_pending' }]; }],
    ['blocked without blockers', value => { value.status = 'blocked'; value.summary = null; value.previewDigest = null; }],
    ['no_work with digest', value => { value.status = 'no_work'; value.noWorkReason = 'no_pending_tasks'; }],
    ['no_work empty_scope with members', value => { value.status = 'no_work'; value.noWorkReason = 'empty_scope'; value.summary = null; value.previewDigest = null; }],
  ])('[case:malformed-preview-%s] rejects inconsistent preview', (name, mutate) => {
    const value = preview(); mutate(value);
    expect(() => validateExecutionPreviewResultWire(value), name).toThrow();
  });
  it('[case:blocked-no-work] accepts complete blocked and no_work scopes and rejects foreign blocker attribution', () => {
    const ready = preview();
    const blocked = { ...ready, status: 'blocked', summary: null, previewDigest: null, blocked: [{ kind: 'feature_dependency', featureId: 'feature-a', reason: 'dependency_pending' }] };
    expect(validateExecutionPreviewResultWire(blocked)).toEqual(blocked);
    expect(() => validateExecutionPreviewResultWire({ ...blocked, blocked: [{ ...blocked.blocked[0], featureId: 'other' }] })).toThrow();
    const noWork = { ...ready, status: 'no_work', summary: null, previewDigest: null, noWorkReason: 'no_pending_tasks' };
    expect(validateExecutionPreviewResultWire(noWork)).toEqual(noWork);
    const empty = { ...noWork, noWorkReason: 'empty_scope', scope: { ...ready.scope, featureIds: [], requestedFeatureIds: [], memberFeatureIds: [], members: [] } };
    expect(validateExecutionPreviewResultWire(empty)).toEqual(empty);
  });

  it('[case:run-receipt-wire] validates all initial Run IDs and keeps legacy single-member decoding', () => {
    const batchId = randomUUID(); const runId = randomUUID();
    const legacy = createAcceptedReceipt({ commandId: randomUUID(), principalId: 'local-owner', operation: 'execution.start', scope: { kind: 'project', projectId: randomUUID() },
      requestDigest: digest, issuedAt: new Date().toISOString(), completedAt: new Date().toISOString(), operationId: batchId, batchId, runId });
    expect(validateCommandReceiptWire(legacy)).toEqual(legacy);
    const expanded = { ...legacy, runIds: [runId, randomUUID()] };
    expect(validateCommandReceiptWire(expanded)).toEqual(expanded);
    for (const runIds of [[], [runId], [runId, runId], [randomUUID(), runId], [runId, 'bad'], Array.from({ length: 17 }, () => randomUUID())]) {
      expect(() => validateCommandReceiptWire({ ...expanded, runIds })).toThrow();
    }
    expect(() => validateCommandReceiptWire({ ...expanded, schemaVersion: 999 })).toThrow();
    expect(() => validateCommandReceiptWire({ ...expanded, unknown: true })).toThrow();
  });

  it('[case:core-command-boundary] preserves selector, identity and revision validation in the Core envelope', () => {
    const base = { schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date().toISOString(), operation: 'execution.preview', scope: { kind: 'project', projectId: randomUUID() }, payload: { phaseId: 'phase-1', budget } };
    expect(validateCommandEnvelope(base)).toMatchObject({ expectedRevision: null, payload: { phaseId: 'phase-1' } });
    for (const bad of [
      { ...base, payload: { ...base.payload, featureIds: ['feature-a'] } },
      { ...base, payload: { ...base.payload, actorId: 'owner' } },
      { ...base, principalId: 'owner' }, { ...base, expectedRevision: 1 },
      { ...base, payload: { featureIds: ['feature-a', 'feature-a'], budget } },
      { ...base, payload: { featureIds: Array.from({ length: 17 }, (_, i) => `feature-${i}`), budget } },
    ]) expect(() => validateCommandEnvelope(bad)).toThrow();
  });
});
