import { isDeepStrictEqual } from 'node:util';
import { StorageError } from '../ports/errors.js';
import { normalizeFeatureResourceSet, validateFeatureResourceLeaseRecord } from '../ports/feature-resources.js';
import type { FeatureResourceLeaseRecord, FeatureResourceSet } from '../ports/feature-resources.js';

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
