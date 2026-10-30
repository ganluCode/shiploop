import type {
  RetentionCleanupCandidate,
  RetentionCleanupEvaluation,
  RetentionCleanupRunLimits,
  RetentionCleanupRunResult,
  RetentionCleanupService,
  RetentionCleanupStore,
} from '../ports/evidence-retention.js';
import { RETENTION_CLEANUP_OPERATION, RETENTION_CLEANUP_SCHEMA_VERSION } from '../ports/evidence-retention.js';
import type { RetentionPolicyV2 } from '../ports/settings-schema.js';

const DAY_MS = 86_400_000;
const DEFAULTS = Object.freeze({ maxItems: 256, maxBytes: 64 * 1024 * 1024, maxDurationMs: 60_000, maxRetries: 2 });

function limitsOf(value: RetentionCleanupRunLimits | undefined): Required<RetentionCleanupRunLimits> {
  const limits = {
    maxItems: value?.maxItems ?? DEFAULTS.maxItems,
    maxBytes: value?.maxBytes ?? DEFAULTS.maxBytes,
    maxDurationMs: value?.maxDurationMs ?? DEFAULTS.maxDurationMs,
    maxRetries: value?.maxRetries ?? DEFAULTS.maxRetries,
  };
  if (!Object.values(limits).every(item => Number.isSafeInteger(item) && item >= 0)
    || limits.maxItems < 1 || limits.maxBytes < 1 || limits.maxDurationMs < 1 || limits.maxRetries > 5) {
    throw new TypeError('RetentionCleanup limits 非法');
  }
  return limits;
}

function candidate(object: RetentionCleanupCandidate['object'], reasons: readonly string[], revision: string): RetentionCleanupCandidate {
  return { object, reasons, expectedSnapshotRevision: revision, referenceCount: 0, status: 'candidate' };
}

export interface RetentionCleanupServiceDeps {
  readonly store: RetentionCleanupStore;
  readonly nowUtcMs?: () => number;
}

export function createRetentionCleanupService(deps: RetentionCleanupServiceDeps): RetentionCleanupService {
  if (deps === null || typeof deps !== 'object' || typeof deps.store?.readSnapshot !== 'function') {
    throw new TypeError('RetentionCleanup.create: 必须提供清理存储端口');
  }
  const now = deps.nowUtcMs ?? Date.now;

  async function evaluate(input: { readonly policy: RetentionPolicyV2; readonly nowUtcMs?: number }): Promise<RetentionCleanupEvaluation> {
    const evaluatedAtUtcMs = input.nowUtcMs ?? now();
    const snapshot = await deps.store.readSnapshot(input.policy, evaluatedAtUtcMs);
    const refs = new Map<string, string[]>();
    for (const reference of snapshot.references) {
      const key = `${reference.objectKind}:${reference.objectId}`;
      const list = refs.get(key) ?? [];
      list.push(reference.reason);
      refs.set(key, list);
    }
    const unknown = snapshot.unknownReasons.length > 0;
    const cutoff = input.policy.evidenceRetentionDays === undefined
      ? undefined : evaluatedAtUtcMs - input.policy.evidenceRetentionDays * DAY_MS;
    const retained: RetentionCleanupCandidate[] = [];
    const candidates: RetentionCleanupCandidate[] = [];
    for (const object of snapshot.objects) {
      const key = `${object.kind}:${object.id}`;
      const reasons = [...new Set(refs.get(key) ?? [])];
      if (unknown) reasons.push(...snapshot.unknownReasons.map(reason => `unknown:${reason}`));
      if (object.metadata?.status !== undefined && object.metadata.status !== 'ready') reasons.push('artifact_not_ready');
      if (object.kind === 'artifact' && object.metadata?.fileIdentityRequired === true && object.fileIdentity === undefined) reasons.push('file_identity_unknown');
      if (cutoff === undefined) reasons.push('policy_not_configured');
      else if (object.updatedAtUtcMs > cutoff) reasons.push('within_retention_window');
      const item = candidate(object, [...new Set(reasons)], snapshot.revision);
      const protectedItem = item.reasons.length > 0;
      if (protectedItem) retained.push({ ...item, status: 'retained', referenceCount: refs.get(key)?.length ?? 0 });
      else candidates.push(item);
    }

    const backups = [...snapshot.backups].sort((a, b) =>
      b.createdAtUtcMs - a.createdAtUtcMs || (a.id < b.id ? 1 : -1));
    const backupCandidates: RetentionCleanupCandidate[] = [];
    const backupLimit = input.policy.maxBackupCount;
    const backupCutoff = input.policy.backupRetentionDays === undefined
      ? undefined : evaluatedAtUtcMs - input.policy.backupRetentionDays * DAY_MS;
    for (const [rank, backup] of backups.entries()) {
      const reasons: string[] = [];
      if (rank === 0) reasons.push('latest_backup_required');
      if (backupLimit !== undefined && rank >= backupLimit) reasons.push('backup_count_exceeded');
      if (backupCutoff !== undefined && backup.createdAtUtcMs <= backupCutoff) reasons.push('backup_retention_expired');
      const item = candidate(backup, [...new Set(reasons)], snapshot.revision);
      if (item.reasons.length > 0 && rank > 0 && !unknown) backupCandidates.push(item);
      else if (item.reasons.length > 0) retained.push({ ...item, status: 'retained' });
    }
    return {
      schemaVersion: RETENTION_CLEANUP_SCHEMA_VERSION,
      operation: RETENTION_CLEANUP_OPERATION,
      evaluatedAtUtcMs,
      snapshotRevision: snapshot.revision,
      candidates,
      retained,
      unknownReasons: snapshot.unknownReasons,
      backupCandidates,
    };
  }

  async function execute(input: { readonly operationId: string; readonly policy: RetentionPolicyV2; readonly nowUtcMs?: number; readonly limits?: RetentionCleanupRunLimits }): Promise<RetentionCleanupRunResult> {
    const started = input.nowUtcMs ?? now();
    const limits = limitsOf(input.limits);
    const evaluated = await evaluate({ policy: input.policy, nowUtcMs: started });
    const work = [...evaluated.candidates, ...evaluated.backupCandidates];
    const retained = [...evaluated.retained];
    const deleted: RetentionCleanupCandidate[] = [];
    const skipped: Array<{ readonly candidate: RetentionCleanupCandidate; readonly reason: string }> = [];
    const reasons: string[] = [...evaluated.unknownReasons];
    await deps.store.beginOperation({ operationId: input.operationId, policy: input.policy, snapshot: await deps.store.readSnapshot(input.policy, started), nowUtcMs: started });
    let bytes = 0;
    let retries = 0;
    let index = 0;
    let status: RetentionCleanupRunResult['status'] = 'completed';
    try {
      for (; index < work.length; index += 1) {
        const item = work[index]!;
        if (deleted.length >= limits.maxItems || bytes + item.object.bytes > limits.maxBytes || now() - started >= limits.maxDurationMs) {
          status = 'partial'; reasons.push('cleanup_budget_exhausted'); break;
        }
        const checked = await deps.store.recheckCandidate(item, now());
        if (!checked.allowed) {
          retained.push({ ...checked.candidate, status: 'retained', reasons: [...checked.candidate.reasons, checked.reason ?? 'candidate_changed'] });
          skipped.push({ candidate: checked.candidate, reason: checked.reason ?? 'candidate_changed' });
          continue;
        }
        let removed = false;
        for (let attempt = 0; attempt <= limits.maxRetries; attempt += 1) {
          try {
            const result = await deps.store.deleteCandidate(checked.candidate);
            if (result.deleted) {
              deleted.push(checked.candidate);
              bytes += result.bytesDeleted;
            } else skipped.push({ candidate: checked.candidate, reason: result.reason ?? 'delete_skipped' });
            removed = true;
            break;
          } catch (error) {
            retries += 1;
            if (attempt >= limits.maxRetries) {
              skipped.push({ candidate: checked.candidate, reason: 'delete_failed' });
              reasons.push(error instanceof Error ? error.message : 'delete_failed');
              status = 'failed';
            }
          }
        }
        if (!removed && status === 'failed') break;
      }
    } catch (error) {
      status = 'unknown';
      reasons.push(error instanceof Error ? error.message : 'cleanup_stopped_unknown');
    }
    if (index < work.length && status === 'completed') status = 'partial';
    if (retries > 0) reasons.push(`retries:${retries}`);
    await deps.store.finishOperation({ operationId: input.operationId, status, nextIndex: index, itemsDeleted: deleted.length, bytesDeleted: bytes, reason: reasons.at(-1), nowUtcMs: now() });
    return { operationId: input.operationId, status, evaluated, deleted, retained, skipped, itemsDeleted: deleted.length, bytesDeleted: bytes, reasons: [...new Set(reasons)] };
  }

  return Object.freeze({ evaluate, execute });
}

export type { RetentionCleanupService };
