import { describe, expect, it } from 'vitest';
import {
  FEATURE_RESOURCE_KINDS,
  assertFeatureResourceLeaseOwner,
  assertFeatureResourceLeaseTransition,
  normalizeFeatureResourceSet,
  validateFeatureResourceDeclaration,
  validateFeatureResourceLeaseRecord,
} from '../../../packages/core/src/ports/feature-resources.ts';
import type {
  FeatureResourceLeaseRecord,
} from '../../../packages/core/src/ports/feature-resources.ts';

const NOW = 1_900_000_300_000;

function lease(overrides: Record<string, unknown> = {}): FeatureResourceLeaseRecord {
  return validateFeatureResourceLeaseRecord({
    id: 'lease-1',
    projectId: 'project-1',
    resource: { kind: 'worktree_write_exclusive', key: 'project:project-1:worktree:feature-1' },
    ownerId: 'owner-1',
    ownerVersion: 1,
    revision: 1,
    acquiredAtUtcMs: NOW,
    leaseUntilUtcMs: NOW + 60_000,
    state: 'held',
    waitingReason: null,
    releasedAtUtcMs: null,
    ...overrides,
  });
}

describe('P05-5 F-001 feature resource contract', () => {
  it('[case:resource-declaration-validation] 只接受项目范围内的有界资源键并拒绝未知字段', () => {
    const declaration = validateFeatureResourceDeclaration({
      projectId: 'project-1',
      kind: 'migration',
      key: 'project:project-1:migration:core-schema',
    });
    expect(declaration).toMatchObject({
      projectId: 'project-1',
      kind: 'migration',
      key: 'project:project-1:migration:core-schema',
      accessMode: 'exclusive',
      leaseMode: 'lease',
    });

    expect(() => validateFeatureResourceDeclaration({
      projectId: 'project-1',
      kind: 'migration',
      key: '',
    })).toThrow(/不允许为空|空/);
    expect(() => validateFeatureResourceDeclaration({
      projectId: 'project-1',
      kind: 'unknown',
      key: 'project:project-1:unknown:item',
    })).toThrow(/kind|类别|之一/);
    expect(() => validateFeatureResourceDeclaration({
      projectId: 'project-1',
      kind: 'contract',
      key: 'project:project-2:contract:api',
    })).toThrow(/项目|projectId/);
    expect(() => validateFeatureResourceDeclaration({
      projectId: 'project-1',
      kind: 'contract',
      key: 'project:project-1:contract:api',
      extra: true,
    })).toThrow(/未知字段/);
    expect(() => validateFeatureResourceDeclaration({
      projectId: 'project-1',
      kind: 'contract',
      key: 'global:execution',
    })).toThrow(/资源|project/);
  });

  it('[case:resource-order-deterministic] 资源集合去重并按全局锁顺序稳定排序', () => {
    const input = {
      projectId: 'project-1',
      resources: [
        { kind: 'git_public_metadata_short', key: 'project:project-1:git-public-metadata' },
        { kind: 'worktree_write_exclusive', key: 'project:project-1:worktree:feature-2' },
        { kind: 'feature_code_shared', key: 'project:project-1:feature-code' },
        { kind: 'worktree_write_exclusive', key: 'project:project-1:worktree:feature-2' },
        { kind: 'planning_exclusive', key: 'project:project-1:planning' },
        { kind: 'contract', key: 'project:project-1:contract:public-api' },
      ],
    } as const;
    const reversed = { ...input, resources: [...input.resources].reverse() };
    const first = normalizeFeatureResourceSet(input);
    const second = normalizeFeatureResourceSet(reversed);
    expect(first).toEqual(second);
    expect(first.resources.map(resource => resource.kind)).toEqual([
      'planning_exclusive',
      'feature_code_shared',
      'contract',
      'worktree_write_exclusive',
      'git_public_metadata_short',
    ]);
    expect(first.resources).toHaveLength(5);
  });

  it('[case:resource-occupancy-semantics] 四类运行资源具有独立占用语义且不冒充槽位或 Attempt 租约', () => {
    expect(FEATURE_RESOURCE_KINDS).toEqual([
      'planning_exclusive',
      'feature_code_shared',
      'worktree_write_exclusive',
      'git_public_metadata_short',
      'migration',
      'contract',
    ]);
    expect(validateFeatureResourceDeclaration({
      projectId: 'project-1', kind: 'planning_exclusive', key: 'project:project-1:planning',
    })).toMatchObject({ accessMode: 'exclusive', leaseMode: 'lease' });
    expect(validateFeatureResourceDeclaration({
      projectId: 'project-1', kind: 'feature_code_shared', key: 'project:project-1:feature-code',
    })).toMatchObject({ accessMode: 'shared', leaseMode: 'lease' });
    expect(validateFeatureResourceDeclaration({
      projectId: 'project-1', kind: 'worktree_write_exclusive', key: 'project:project-1:worktree:feature-1',
    })).toMatchObject({ accessMode: 'exclusive', leaseMode: 'lease' });
    expect(validateFeatureResourceDeclaration({
      projectId: 'project-1', kind: 'git_public_metadata_short', key: 'project:project-1:git-public-metadata',
    })).toMatchObject({ accessMode: 'exclusive', leaseMode: 'short' });
  });

  it('[case:resource-lease-fencing] 租约保留 owner/version/revision fencing，旧 owner 不能修改新 owner', () => {
    const current = lease();
    expect(() => assertFeatureResourceLeaseOwner(current, { ownerId: 'owner-1', ownerVersion: 1 })).not.toThrow();
    expect(() => assertFeatureResourceLeaseOwner(current, { ownerId: 'old-owner', ownerVersion: 1 })).toThrow(/owner|归属/);
    expect(() => assertFeatureResourceLeaseOwner(current, { ownerId: 'owner-1', ownerVersion: 2 })).toThrow(/version|代次/);

    const renewed = lease({ revision: 2, leaseUntilUtcMs: NOW + 120_000 });
    expect(() => assertFeatureResourceLeaseTransition(current, renewed)).not.toThrow();
    expect(() => assertFeatureResourceLeaseTransition(current, lease({ revision: 2, ownerId: 'owner-2' }))).toThrow(/owner|归属|不可变/);
    expect(() => assertFeatureResourceLeaseTransition(current, lease({ revision: 3 }))).toThrow(/revision|连续/);
  });

  it('[case:resource-wait-reason-shape] 等待原因是有界结构化事实并且随租约校验', () => {
    const blocked = lease({
      state: 'quarantined',
      waitingReason: {
        code: 'lease_expired_unverified',
        resourceKey: 'project:project-1:worktree:feature-1',
        blockingOwnerId: 'owner-1',
        blockingOwnerVersion: 1,
      },
      releasedAtUtcMs: null,
    });
    expect(blocked.waitingReason).toEqual({
      code: 'lease_expired_unverified',
      resourceKey: 'project:project-1:worktree:feature-1',
      blockingOwnerId: 'owner-1',
      blockingOwnerVersion: 1,
    });
    expect(() => lease({
      state: 'held',
      waitingReason: { code: 'unknown', resourceKey: 'project:project-1:worktree:feature-1' },
    })).toThrow(/waitingReason|原因/);
  });
});
