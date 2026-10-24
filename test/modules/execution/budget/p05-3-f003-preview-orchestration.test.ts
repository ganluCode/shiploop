import { describe, expect, it } from 'vitest';
import { createExecutionPreviewService } from '../../../../packages/core/src/application/execution-preview.ts';
import { computeFeatureCheckPolicyDigest } from '../../../../packages/core/src/ports/plan-approval-verification.ts';
import type { ExecutionPreviewScopeView } from '../../../../packages/core/src/ports/execution-preview.ts';

const NOW = 1_900_000_000_000;
const HASH = 'a'.repeat(64);
const BUDGET = {
  batch: { maxRuns: 2, maxTotalAttempts: 4, maxRuntimeStarts: 4, maxNoProgressRuns: 1, deadlineUtcMs: NOW + 60_000 },
  run: { maxAttemptsPerRun: 2, runTimeLimitMs: 30_000 },
};

function member(featureId: string, approved = true, revision = 1): any {
  const planDigest = `${featureId.slice(0, 1)}${HASH.slice(1)}`;
  return {
    feature: {
      id: featureId, projectId: 'project-1', phaseId: 'phase-1', revision,
      planDigest, planStatus: approved ? 'approved' : 'draft', status: 'ready',
      title: featureId, labels: [], sourceRefs: [], deliveryStatus: 'not_requested',
    },
    tasks: [{
      id: `${featureId}-task`, projectId: 'project-1', featureId, revision: 1,
      status: 'pending', kind: 'coding', title: 'task', labels: [], requirementsRefs: [],
      executionConfig: {}, configSource: 'default', configSourceKey: null,
    }],
    dependencies: [],
    approvals: approved ? [{
      id: `${featureId}-approval`, projectId: 'project-1', subjectType: 'feature_plan', subjectId: featureId,
      subjectDigest: planDigest, checkPolicyDigest: computeFeatureCheckPolicyDigest(undefined), status: 'approved',
      decisionActor: 'owner', reason: null, decidedAtUtcMs: NOW, revision: 1,
      createdAtUtcMs: NOW, updatedAtUtcMs: NOW,
    }] : [],
    resolvedInputs: [],
    activeRuns: [],
    entity: { revision, planDigest },
    readiness: {
      featureId, dependencyCompleted: true, dependencyCompletion: 'complete',
      integrationReady: true, dependencyIntegrationReady: true, ready: true, reason: 'ready',
    },
  };
}

function scopeView(members: readonly any[]): ExecutionPreviewScopeView {
  return {
    project: { id: 'project-1', status: 'active' },
    binding: { canonicalPath: '/private/repo', repoIdentity: 'repo-1' },
    phase: { id: 'phase-1', projectId: 'project-1', revision: 1, title: 'phase', description: null, labels: [], status: 'open', createdAtUtcMs: NOW, updatedAtUtcMs: NOW },
    selection: {
      phaseId: 'phase-1',
      requestedFeatureIds: members.map((item) => item.feature.id),
      memberFeatureIds: members.map((item) => item.feature.id),
    },
    members,
    featureDependencies: [],
    settings: { global: null, project: null },
    activePhaseBatches: [],
    baselineOccupancy: { holderOperationId: null },
  };
}

function previewWith(view: ExecutionPreviewScopeView, calls: { inspect: number }): ReturnType<typeof createExecutionPreviewService> {
  return createExecutionPreviewService({
    views: { readExecutionPreviewScopeView: () => view, readExecutionPreviewView: undefined },
    inspector: {
      inspect: async () => {
        calls.inspect += 1;
        return { canonicalPath: '/private/repo', repoIdentity: 'repo-1', gitCommonDir: '/private/repo/.git', headCommit: 'b'.repeat(40), hasInitialCommit: true, hasUncommittedChanges: false };
      },
    },
    workspace: { readWorkspaceSummary: async () => ({ digest: HASH, fileCount: 0, excludedDirNames: [] }) } as any,
    permissions: () => ({ grants: [] }),
    nowMs: () => NOW,
  });
}

describe('P05-3 F-003 multi-member execution preview', () => {
  it('[case:multi-member-ready-scope-and-digest] returns the requested and frozen closure identities', async () => {
    const calls = { inspect: 0 };
    const first = member('feature-a');
    const second = member('feature-b');
    const service = previewWith(scopeView([first, second]), calls);
    const result = await service.previewExecution('project-1', { phaseId: 'phase-1', featureIds: [], budget: BUDGET });

    expect(result.status).toBe('ready');
    expect(result.scope).toMatchObject({
      phaseId: 'phase-1',
      requestedFeatureIds: ['feature-a', 'feature-b'],
      memberFeatureIds: ['feature-a', 'feature-b'],
    });
    expect(result.summary?.members.map((item) => item.featureId)).toEqual(['feature-a', 'feature-b']);
    expect(result.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.inspect).toBe(1);
  });

  it('[case:member-blocker-no-repository-io] returns a member-associated blocker before repository inspection', async () => {
    const calls = { inspect: 0 };
    const blocked = member('feature-b', false);
    const service = previewWith(scopeView([member('feature-a'), blocked]), calls);
    const result = await service.previewExecution('project-1', {
      featureIds: ['feature-a', 'feature-b'], phaseId: null, budget: BUDGET,
    });

    expect(result.status).toBe('blocked');
    expect(result.blocked).toContainEqual({ kind: 'plan_approval', reason: 'not_approved', featureId: 'feature-b' });
    expect(result.previewDigest).toBeNull();
    expect(calls.inspect).toBe(0);
  });
});
