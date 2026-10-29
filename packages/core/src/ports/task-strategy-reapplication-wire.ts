/** P06-6 默认策略重应用的纯公开协议。Host 和客户端共用；不包含策略正文。 */
import { StorageError } from './errors.js';

export const TASK_STRATEGY_REAPPLICATION_BLOCK_REASONS = [
  'project_not_found', 'task_not_found', 'cross_project', 'task_started',
  'execution_history', 'active_execution_inputs', 'authorized_batch_scope',
  'configuration_missing', 'configuration_invalid', 'unknown_runtime',
  'incompatible_provider', 'unsupported_model', 'capability_catalog_unavailable',
] as const;

interface StrategySourceSummary {
  readonly configSource: string | null;
  readonly configSourceKey: string | null;
  readonly digest: string | null;
}

export interface TaskStrategyReapplicationPreviewWire {
  readonly schemaVersion: 1;
  readonly scope: 'task-strategy-reapplication-preview';
  readonly status: 'ready' | 'blocked';
  readonly identity: {
    readonly projectId: string;
    readonly globalSettingsRevision: number | null;
    readonly projectSettingsRevision: number | null;
    readonly selectedTaskIds: readonly string[];
    readonly taskRevisions: readonly { readonly taskId: string; readonly revision: number | null }[];
    readonly candidateDigest: string;
  };
  readonly items: readonly {
    readonly taskId: string;
    readonly featureId: string | null;
    readonly taskRevision: number | null;
    readonly complexity: string | null;
    readonly current: StrategySourceSummary;
    readonly candidate: { readonly configSource: string; readonly configSourceKey: string; readonly digest: string } | null;
    readonly diff: {
      readonly changed: boolean;
      readonly fields: readonly string[];
      readonly beforeDigest: string;
      readonly afterDigest: string;
    } | null;
    readonly eligible: boolean;
    readonly reasons: readonly string[];
  }[];
  readonly changedCount: number;
  readonly blockedReasons: readonly string[];
}

export interface TaskStrategyReapplicationResult {
  readonly updatedTaskIds: readonly string[];
  readonly taskRevisions: readonly { readonly taskId: string; readonly revision: number }[];
  readonly updatedCount: number;
}

function invalid(): never {
  throw new StorageError('validation', 'task.strategy.reapply.wire', 'Invalid strategy reapplication response');
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) invalid();
  return record;
}

function id(value: unknown): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) invalid();
}

function hash(value: unknown): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid();
}

function revision(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) invalid();
  value.forEach(id);
  return value;
}

function reasons(value: unknown): string[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length
    || value.some(reason => !(TASK_STRATEGY_REAPPLICATION_BLOCK_REASONS as readonly unknown[]).includes(reason))) invalid();
  return value;
}

function source(value: unknown, nullable: boolean): void {
  const summary = object(value, ['configSource', 'configSourceKey', 'digest']);
  if (!(nullable && summary.configSource === null)
    && !['project_default', 'global_default', 'user_override', 'task_edit'].includes(summary.configSource as string)) invalid();
  if (!(nullable && summary.configSourceKey === null)
    && (typeof summary.configSourceKey !== 'string'
      || !/^(defaultStrategy|modelMap\.(low|medium|high)|purposeStrategies\.planner|userOverride|executionConfig)$/.test(summary.configSourceKey))) invalid();
  if (!(nullable && summary.digest === null)) hash(summary.digest);
}

export function validateTaskStrategyReapplicationPreview(value: unknown): TaskStrategyReapplicationPreviewWire {
  const preview = object(value, ['schemaVersion', 'scope', 'status', 'identity', 'items', 'changedCount', 'blockedReasons']);
  if (preview.schemaVersion !== 1 || preview.scope !== 'task-strategy-reapplication-preview'
    || !['ready', 'blocked'].includes(preview.status as string)) invalid();
  const identity = object(preview.identity, ['projectId', 'globalSettingsRevision', 'projectSettingsRevision', 'selectedTaskIds', 'taskRevisions', 'candidateDigest']);
  id(identity.projectId);
  for (const key of ['globalSettingsRevision', 'projectSettingsRevision']) {
    if (identity[key] !== null) revision(identity[key]);
  }
  hash(identity.candidateDigest);
  const selected = ids(identity.selectedTaskIds);
  if (selected.some((taskId, index) => index > 0 && selected[index - 1]! >= taskId)) invalid();
  if (!Array.isArray(identity.taskRevisions) || identity.taskRevisions.length !== selected.length
    || !Array.isArray(preview.items) || preview.items.length !== selected.length) invalid();
  const blocked = reasons(preview.blockedReasons);
  let changedCount = 0;
  const allReasons = new Set<string>();
  preview.items.forEach((raw, index) => {
    const item = object(raw, ['taskId', 'featureId', 'taskRevision', 'complexity', 'current', 'candidate', 'diff', 'eligible', 'reasons']);
    if (item.taskId !== selected[index]) invalid();
    if (item.featureId !== null) id(item.featureId);
    if (item.taskRevision !== null) revision(item.taskRevision);
    if (item.complexity !== null && !['low', 'medium', 'high'].includes(item.complexity as string)) invalid();
    const expected = object((identity.taskRevisions as unknown[])[index], ['taskId', 'revision']);
    if (expected.taskId !== item.taskId || expected.revision !== item.taskRevision) invalid();
    source(item.current, true);
    if (item.candidate !== null) source(item.candidate, false);
    const itemReasons = reasons(item.reasons);
    itemReasons.forEach(reason => allReasons.add(reason));
    if (typeof item.eligible !== 'boolean' || item.eligible !== (itemReasons.length === 0)) invalid();
    if (item.eligible && (item.candidate === null || item.diff === null || item.taskRevision === null || item.featureId === null)) invalid();
    if (!item.eligible && (item.candidate !== null || item.diff !== null)) invalid();
    if (item.diff !== null) {
      const diff = object(item.diff, ['changed', 'fields', 'beforeDigest', 'afterDigest']);
      if (typeof diff.changed !== 'boolean' || !Array.isArray(diff.fields)
        || new Set(diff.fields).size !== diff.fields.length
        || diff.fields.some(field => !['schemaVersion', 'runtime', 'provider', 'model', 'credentialRef', 'endpointRef', 'maxCodeAttempts', 'workTimeoutMs', 'toolTimeoutMs'].includes(field))) invalid();
      hash(diff.beforeDigest);
      hash(diff.afterDigest);
      if (diff.changed !== (diff.fields.length > 0)
        || diff.beforeDigest !== (item.current as StrategySourceSummary).digest
        || diff.afterDigest !== (item.candidate as StrategySourceSummary).digest) invalid();
      if (diff.changed) changedCount += 1;
    }
    if (itemReasons.includes('cross_project') || itemReasons.includes('task_not_found')) {
      const current = item.current as StrategySourceSummary;
      if (item.featureId !== null || item.taskRevision !== null || item.complexity !== null
        || Object.values(current).some(entry => entry !== null)) invalid();
    }
  });
  if (preview.changedCount !== changedCount || preview.status !== (blocked.length === 0 ? 'ready' : 'blocked')
    || allReasons.size !== blocked.length || blocked.some(reason => !allReasons.has(reason))) invalid();
  return value as TaskStrategyReapplicationPreviewWire;
}

/** 仅投影公开来源和摘要；先剥离完整候选策略，再以同一 schema 验证输出。 */
export function toPublicTaskStrategyReapplicationPreview(
  preview: Omit<TaskStrategyReapplicationPreviewWire, 'changedCount'>,
): TaskStrategyReapplicationPreviewWire {
  return validateTaskStrategyReapplicationPreview({
    ...preview,
    items: preview.items.map(item => ({
      ...item,
      candidate: item.candidate === null ? null : {
        configSource: item.candidate.configSource,
        configSourceKey: item.candidate.configSourceKey,
        digest: item.candidate.digest,
      },
    })),
    changedCount: preview.items.filter(item => item.diff?.changed === true).length,
  });
}

export function validateTaskStrategyReapplicationResult(value: unknown): TaskStrategyReapplicationResult {
  const result = object(value, ['updatedTaskIds', 'taskRevisions', 'updatedCount']);
  const updated = ids(result.updatedTaskIds);
  if (result.updatedCount !== updated.length || !Array.isArray(result.taskRevisions)
    || result.taskRevisions.length !== updated.length) invalid();
  result.taskRevisions.forEach((raw, index) => {
    const entry = object(raw, ['taskId', 'revision']);
    if (entry.taskId !== updated[index]) invalid();
    revision(entry.revision);
  });
  return value as TaskStrategyReapplicationResult;
}
