import { isDeepStrictEqual } from 'node:util';
import { StorageError } from '../ports/errors.js';
import { normalizeFeatureResourceSet, validateFeatureResourceLeaseRecord } from '../ports/feature-resources.js';
import type { FeatureResourceLeaseRecord, FeatureResourceSet } from '../ports/feature-resources.js';
import type { GitCommitRequest, IntegrationCommitResourceFence, IntegrationCommitResourceSnapshot } from '../ports/controlled-git-commit.js';
import type { WorkResourceIdentity } from '../ports/work-resources.js';

/** Shared by first commit and read-only lost-receipt reconciliation. */
export function readIntegrationCommitResources(fence: IntegrationCommitResourceFence | undefined, request: GitCommitRequest,
  identity: WorkResourceIdentity, sourceOperationId: string, nowUtcMs: number): IntegrationCommitResourceSnapshot {
  const fail = (reason: string): never => {throw new StorageError('conflict','IntegrationCommitResources',reason,{details:{reason}});};
  if (!fence) fail('integration_resource_fence_required');
  const snapshot = fence!.read(request,identity);
  if (!isDeepStrictEqual(snapshot.identity,identity) || snapshot.integrationId !== sourceOperationId
    || !Number.isSafeInteger(snapshot.ownerVersion) || snapshot.ownerVersion < 1) fail('workspace_not_held');
  assertIntegrationResourceFence({projectId:identity.projectId,integrationId:snapshot.integrationId,ownerId:identity.owner,
    ownerVersion:snapshot.ownerVersion,resourceSet:snapshot.resourceSet,leases:snapshot.leases},nowUtcMs);
  return snapshot;
}

/** Long-lived integration ownership. The common-dir short lock is acquired later,
 * only around Git metadata writes, and must never be part of this lease group. */
export function assertIntegrationResourceFence(input: {
  readonly projectId: string;
  readonly integrationId: string;
  readonly ownerId: string;
  readonly ownerVersion: number;
  readonly resourceSet: FeatureResourceSet;
  readonly leases: readonly FeatureResourceLeaseRecord[];
}, nowUtcMs: number): void {
  const fail = (): never => { throw new StorageError('conflict', 'IntegrationResourceFence', 'workspace_not_held', {
    details: { reason: 'workspace_not_held' },
  }); };
  const resources = normalizeFeatureResourceSet(input.resourceSet);
  const leases = input.leases.map(validateFeatureResourceLeaseRecord);
  if (resources.projectId !== input.projectId
    || resources.resources.some(resource => resource.leaseMode === 'short')
    || !resources.resources.some(resource => resource.kind === 'feature_code_shared'
      && resource.key === `project:${input.projectId}:feature-code`)
    || !resources.resources.some(resource => resource.kind === 'worktree_write_exclusive'
      && resource.key === `project:${input.projectId}:worktree:${input.integrationId}`)) fail();
  for (const resource of resources.resources) {
    const matching = leases.filter(lease => lease.resource.key === resource.key && lease.state !== 'released');
    if (resource.accessMode === 'exclusive' && matching.some(lease => lease.ownerId !== input.ownerId
      || lease.ownerVersion !== input.ownerVersion || lease.state !== 'held')) fail();
    if (!matching.some(lease => isDeepStrictEqual(lease.resource, resource) && lease.projectId === input.projectId
      && lease.ownerId === input.ownerId && lease.ownerVersion === input.ownerVersion
      && lease.state === 'held' && lease.leaseUntilUtcMs > nowUtcMs)) fail();
  }
}
