import { describe, expect, it } from 'vitest';
import {
  computePlanningMigrationPreviewDigest,
  validatePlanningMigrationConfirmPayload,
  validatePlanningMigrationPreview,
} from '../../../packages/core/src/ports/planning-migration.ts';

const previewBase = {
  schemaVersion: 1 as const,
  projectId: 'project-1',
  featureId: 'feature-1',
  featureRevision: 3,
  context: { contextId: 'context-1', candidateId: 'candidate-1', runId: 'run-1', status: 'open' },
  workspace: { workspaceId: 'workspace-1', path: '/tmp/workspace', branch: 'feature/example', baseCommit: 'a'.repeat(40), headCommit: 'a'.repeat(40), revision: 2, status: 'ready' },
  facts: { dirty: false, unfinishedOperations: [], leases: [], processStopProof: { present: true, source: 'session' } },
  blockers: [], observedAtUtcMs: 100,
};

function preview() {
  return { ...previewBase, previewDigest: computePlanningMigrationPreviewDigest(previewBase) };
}

describe('planning migration port', () => {
  it('binds a preview digest to identities and safety facts', () => {
    const value = preview();
    expect(validatePlanningMigrationPreview(value)).toEqual(value);
    expect(() => validatePlanningMigrationPreview({ ...value, workspace: { ...value.workspace, branch: 'feature/changed' } })).toThrow();
  });

  it('accepts only planning or coding as the target role', () => {
    expect(validatePlanningMigrationConfirmPayload({ featureId: 'feature-1', contextId: 'context-1', candidateId: 'candidate-1', runId: 'run-1',
      targetRole: 'coding', workspaceId: 'workspace-1', workspaceRevision: 2, headCommit: 'a'.repeat(40), previewDigest: 'b'.repeat(64) }).targetRole).toBe('coding');
    expect(() => validatePlanningMigrationConfirmPayload({ featureId: 'feature-1', contextId: 'context-1', candidateId: 'candidate-1', runId: 'run-1',
      targetRole: 'model', workspaceId: 'workspace-1', workspaceRevision: 2, headCommit: 'a'.repeat(40), previewDigest: 'b'.repeat(64) })).toThrow();
  });
});
