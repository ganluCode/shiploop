import { expect, it, vi } from 'vitest';
import { freezeRunWorkspaceAuthorization } from '../../../../packages/core/src/application/execution-workspace-authorization.ts';

it('[case:pending-coding-baseline-is-not-head] freezes visible pending authorization without creating a coding baseline or resolving HEAD', () => {
  const resolve = vi.fn(() => 'f'.repeat(40));
  const prepared = { scopeFeatureIds: ['a', 'b'], authorization: { deferredFeatureIds: ['b'], dagDigest: 'c'.repeat(64),
    dependencies: [{ featureId: 'b', dependsOnId: 'a', revision: 1 }] },
    baselines: [{ featureId: 'b', baseCommit: 'a'.repeat(40), treeSha: null, integrationId: null, inputDigest: null, planRevision: null, source: 'authorization_pending' }] };
  const snapshot = freezeRunWorkspaceAuthorization(prepared, 'b', { id: 'binding', bindingRevision: 1, repoIdentity: 'repo' }, resolve);
  expect(snapshot.workspaceBaseline).toBeUndefined();
  expect(snapshot.integrationAuthorization).toMatchObject({ targetBaseline: 'a'.repeat(40), dependencies: prepared.authorization.dependencies,
    scopeFeatureIds: ['a', 'b'], authorizationDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(resolve).not.toHaveBeenCalled();
});

it('[case:ready-baseline-snapshot-compatibility] keeps the immutable legacy snapshot for an immediately dispatchable member', () => {
  const result = freezeRunWorkspaceAuthorization({ scopeFeatureIds: ['a'], baselines: [] }, 'a',
    { id: 'binding', bindingRevision: 2, repoIdentity: 'repo' }, () => 'd'.repeat(40));
  expect(result).toEqual({ workspaceBaseline: { repositoryBindingId: 'binding', repositoryBindingRevision: 2, baseCommit: 'd'.repeat(40) } });
});
