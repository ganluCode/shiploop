import { isDeepStrictEqual } from 'node:util';
import { StorageError } from './errors.js';
import type { GitOperationIntent } from './git-operations.js';
import type { IntegrationExecutionObservation } from './git-integration-journal.js';

/** Validate private observed facts against the immutable operation, including parent order. */
export function validateIntegrationObservation(raw: unknown, intent: GitOperationIntent): IntegrationExecutionObservation {
  const fail = (): never => { throw new StorageError('validation', 'IntegrationObservation', 'Integration facts do not match the frozen operation'); };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail();
  const value = raw as IntegrationExecutionObservation;
  const plan = intent.integrationPlan;
  const oid = (s: unknown) => typeof s === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s);
  if (plan == null) return fail();
  if (Object.keys(value).some(key => !['outcome', 'reason', 'workspace', 'steps'].includes(key))
    || !['merging', 'pending_verification', 'blocked', 'unknown'].includes(value.outcome)
    || !(value.reason === null || typeof value.reason === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value.reason))
    || !Array.isArray(value.steps) || value.steps.length > plan.mergeOrder.length) fail();
  let head = plan.target.baseCommit;
  for (let index = 0; index < value.steps.length; index++) {
    const step = value.steps[index]!;
    const featureId = plan.mergeOrder[index];
    const source = plan.predecessors.find(item => item.featureId === featureId)?.delivery?.commitSha;
    if (!step || Object.keys(step).some(key => !['ordinal', 'featureId', 'inputSha', 'parentBefore', 'parents', 'commitSha', 'treeSha', 'status'].includes(key))
      || step.ordinal !== index + 1 || step.featureId !== featureId || step.inputSha !== source
      || step.parentBefore !== head || !oid(step.commitSha) || !oid(step.treeSha) || step.status !== 'succeeded'
      || !Array.isArray(step.parents) || step.parents.length !== 2 || step.parents[0] !== head || step.parents[1] !== source) fail();
    head = step.commitSha;
  }
  if (value.workspace !== null) {
    const w = value.workspace;
    if (!w || Object.keys(w).some(key => !['workspaceId', 'ownerId', 'ownerVersion', 'path', 'gitCommonDir', 'repoIdentity', 'targetBase', 'plan', 'gitIdentity', 'status', 'currentHead', 'steps', 'facts'].includes(key))
      || !['ready', 'succeeded', 'blocked', 'unknown'].includes(w.status)
      || w.path !== intent.worktreePath || w.ownerId !== intent.ownerId
      || w.ownerVersion !== intent.budgetSnapshot?.ownerVersion || w.repoIdentity !== intent.repoIdentity
      || w.gitCommonDir !== plan.target.gitCommonDir || w.targetBase !== intent.expectedHead
      || !isDeepStrictEqual(w.plan, plan) || !isDeepStrictEqual(w.gitIdentity, intent.gitIdentity)
      || typeof w.workspaceId !== 'string' || w.workspaceId.length === 0
      || !w.facts || Object.keys(w.facts).some(key => !['head', 'tree', 'parents', 'statusPorcelain', 'unresolvedPaths'].includes(key))
      || !oid(w.currentHead) || !oid(w.facts.head) || !oid(w.facts.tree) || w.currentHead !== w.facts.head
      || !Array.isArray(w.facts.parents) || w.facts.parents.some(parent => !oid(parent))
      || typeof w.facts.statusPorcelain !== 'string' || !Array.isArray(w.facts.unresolvedPaths)
      || w.facts.unresolvedPaths.some(path => typeof path !== 'string')
      || !isDeepStrictEqual(w.steps, value.steps)) fail();
    if (value.outcome === 'pending_verification' || value.outcome === 'merging') {
      if (w.currentHead !== head || w.facts.head !== head || w.facts.statusPorcelain !== '' || w.facts.unresolvedPaths.length !== 0) fail();
      const last = value.steps.at(-1);
      if (last && (w.facts.tree !== last.treeSha || !isDeepStrictEqual(w.facts.parents, last.parents))) fail();
    }
  }
  if (value.outcome === 'pending_verification'
    && (value.workspace === null || value.steps.length !== plan.mergeOrder.length || value.reason !== null)) fail();
  if (Buffer.byteLength(JSON.stringify(value)) > 2_097_152) fail();
  return structuredClone(value);
}
