import { createHash } from 'node:crypto';
import { stableStringify } from '../ports/feature-plan.js';
import type { PreparedExecutionStartFresh } from '../ports/execution-start.js';
import type { RepositoryBindingRecord } from '../ports/state-store.js';

/** Distinguishes a fixed authorization target from a coding baseline. Never fill a pending SHA from HEAD. */
export function freezeRunWorkspaceAuthorization(prepared: Pick<PreparedExecutionStartFresh,
  'authorization' | 'baselines' | 'scopeFeatureIds'>, featureId: string,
  binding: Pick<RepositoryBindingRecord, 'id' | 'bindingRevision' | 'repoIdentity'>,
  resolveReadyBaseline: () => string): Readonly<Record<string, unknown>> {
  const pending = prepared.baselines.find(baseline => baseline.featureId === featureId && baseline.source === 'authorization_pending');
  const identity = { repositoryBindingId: binding.id, repositoryBindingRevision: binding.bindingRevision };
  if (!pending) return { workspaceBaseline: { ...identity, baseCommit: resolveReadyBaseline() } };
  const authorization = prepared.authorization;
  if (!authorization || !authorization.deferredFeatureIds.includes(featureId)) throw new TypeError('Pending baseline requires frozen scope authorization');
  const material = { schemaVersion: 1, ...identity, repoIdentity: binding.repoIdentity,
    targetBaseline: pending.baseCommit, dagDigest: authorization.dagDigest, scopeFeatureIds: prepared.scopeFeatureIds,
    dependencies: authorization.dependencies.filter(edge => edge.featureId === featureId) };
  return { integrationAuthorization: { ...material,
    authorizationDigest: createHash('sha256').update(stableStringify(material)).digest('hex') } };
}
