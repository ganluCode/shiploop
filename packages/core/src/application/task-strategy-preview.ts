import { createHash } from 'node:crypto';
import { stableStringify } from '../ports/feature-plan.js';
import { StorageError } from '../ports/errors.js';
import {
  validateRuntimeStrategyCapabilities,
  type RuntimeCapabilityCatalog,
} from '../ports/runtime-capabilities.js';
import {
  requirePlainObject,
  rejectUnknownKeys,
  validateStableId,
  validationError,
} from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';
import type {
  TaskStrategyReapplicationReadStore,
  TaskStrategyReapplicationReadView,
  TaskStrategyReapplicationTaskFact,
} from '../ports/task-strategy-preview.js';
import { mergeEffectiveSettings } from './effective-settings.js';
import {
  selectTaskStrategy,
  validateTaskExecutionConfig,
  type TaskExecutionConfigV1,
  type TaskStrategySelection,
} from './task-strategy-selection.js';

export const TASK_STRATEGY_REAPPLICATION_PREVIEW_OPERATION =
  'task.strategy.reapply.preview' as const;
export const TASK_STRATEGY_REAPPLICATION_PREVIEW_SCHEMA_VERSION = 1 as const;

import { TASK_STRATEGY_REAPPLICATION_BLOCK_REASONS } from '../ports/task-strategy-reapplication-wire.js';
export { TASK_STRATEGY_REAPPLICATION_BLOCK_REASONS } from '../ports/task-strategy-reapplication-wire.js';
export type TaskStrategyReapplicationBlockReason =
  (typeof TASK_STRATEGY_REAPPLICATION_BLOCK_REASONS)[number];

export interface TaskStrategyReapplicationPreviewInput {
  readonly projectId: string;
  readonly taskIds: readonly string[];
}

export interface TaskStrategyReapplicationPreviewCandidate {
  readonly executionConfig: TaskExecutionConfigV1;
  readonly configSource: TaskStrategySelection['configSource'];
  readonly configSourceKey: string;
  readonly digest: string;
}

export interface TaskStrategyReapplicationPreviewDiff {
  readonly changed: boolean;
  readonly fields: readonly string[];
  readonly beforeDigest: string;
  readonly afterDigest: string;
}

export interface TaskStrategyReapplicationPreviewItem {
  readonly taskId: string;
  readonly featureId: string | null;
  readonly taskRevision: number | null;
  readonly complexity: string | null;
  readonly current: {
    readonly configSource: string | null;
    readonly configSourceKey: string | null;
    readonly digest: string | null;
  };
  readonly candidate: TaskStrategyReapplicationPreviewCandidate | null;
  readonly diff: TaskStrategyReapplicationPreviewDiff | null;
  readonly eligible: boolean;
  readonly reasons: readonly TaskStrategyReapplicationBlockReason[];
}

export interface TaskStrategyReapplicationPreviewIdentity {
  readonly projectId: string;
  readonly globalSettingsRevision: number | null;
  readonly projectSettingsRevision: number | null;
  readonly selectedTaskIds: readonly string[];
  readonly taskRevisions: readonly { readonly taskId: string; readonly revision: number | null }[];
  readonly candidateDigest: string;
}

export interface TaskStrategyReapplicationPreview {
  readonly schemaVersion: typeof TASK_STRATEGY_REAPPLICATION_PREVIEW_SCHEMA_VERSION;
  readonly scope: 'task-strategy-reapplication-preview';
  readonly status: 'ready' | 'blocked';
  readonly identity: TaskStrategyReapplicationPreviewIdentity;
  readonly items: readonly TaskStrategyReapplicationPreviewItem[];
  readonly blockedReasons: readonly TaskStrategyReapplicationBlockReason[];
}

export interface TaskStrategyReapplicationPreviewDependencies {
  readonly reads: TaskStrategyReapplicationReadStore;
  readonly capabilityCatalog?: RuntimeCapabilityCatalog;
}

const TASK_STRATEGY_REAPPLICATION_INPUT_KEYS = ['projectId', 'taskIds'] as const;
const CONFIG_FIELDS = [
  'schemaVersion',
  'runtime',
  'provider',
  'model',
  'credentialRef',
  'endpointRef',
  'maxCodeAttempts',
  'workTimeoutMs',
  'toolTimeoutMs',
] as const;
const DIGEST_DOMAIN = 'shiploop/task-strategy-reapplication-preview/v1';

function digest(value: unknown): string {
  return createHash('sha256')
    .update(`${DIGEST_DOMAIN}\n${stableStringify(value)}`, 'utf8')
    .digest('hex');
}

function validationContext(): ValidationContext {
  return { operation: TASK_STRATEGY_REAPPLICATION_PREVIEW_OPERATION };
}

function validateInput(value: unknown): TaskStrategyReapplicationPreviewInput {
  const context = validationContext();
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, TASK_STRATEGY_REAPPLICATION_INPUT_KEYS, context, 'input');
  const projectId = validateStableId(object.projectId, context, 'input.projectId');
  if (!Array.isArray(object.taskIds) || object.taskIds.length === 0) {
    throw validationError(context, 'input.taskIds', '必须是非空稳定 Task ID 数组', object.taskIds);
  }
  const taskIds = object.taskIds.map((taskId, index) =>
    validateStableId(taskId, context, `input.taskIds[${index}]`),
  );
  if (new Set(taskIds).size !== taskIds.length) {
    throw validationError(context, 'input.taskIds', 'Task ID 不得重复', undefined);
  }
  return { projectId, taskIds: [...taskIds].sort() };
}

function reasonFromCapabilityError(error: unknown): TaskStrategyReapplicationBlockReason {
  if (error instanceof StorageError) {
    const reason = error.details?.reason;
    if (
      reason === 'unknown_runtime' ||
      reason === 'incompatible_provider' ||
      reason === 'unsupported_model'
    ) {
      return reason;
    }
  }
  return 'configuration_invalid';
}

function safeTaskConfigDigest(config: unknown): string | null {
  try {
    return digest(validateTaskExecutionConfig(config, TASK_STRATEGY_REAPPLICATION_PREVIEW_OPERATION));
  } catch {
    return null;
  }
}

function diffConfigs(
  before: TaskExecutionConfigV1,
  after: TaskExecutionConfigV1,
): TaskStrategyReapplicationPreviewDiff {
  const fields = CONFIG_FIELDS.filter((field) =>
    stableStringify(before[field]) !== stableStringify(after[field]),
  );
  return {
    changed: fields.length > 0,
    fields,
    beforeDigest: digest(before),
    afterDigest: digest(after),
  };
}

function baseReasons(
  fact: TaskStrategyReapplicationTaskFact,
): TaskStrategyReapplicationBlockReason[] {
  const reasons: TaskStrategyReapplicationBlockReason[] = [];
  if (fact.ownership === 'missing') reasons.push('task_not_found');
  if (fact.ownership === 'other_project') reasons.push('cross_project');
  if (fact.task !== null && fact.task.status !== 'pending') reasons.push('task_started');
  if (fact.execution.hasExecutionHistory) reasons.push('execution_history');
  if (fact.execution.hasActiveExecutionInputs) reasons.push('active_execution_inputs');
  if (fact.execution.hasAuthorizedBatchScope) reasons.push('authorized_batch_scope');
  return reasons;
}

function settingsInputs(view: TaskStrategyReapplicationReadView): {
  readonly global?: { readonly scopeRevision: number; readonly payload: unknown };
  readonly project?: { readonly scopeRevision: number; readonly payload: unknown };
} {
  return {
    ...(view.globalSettings === null
      ? {}
      : { global: { scopeRevision: view.globalSettings.revision, payload: view.globalSettings.payload } }),
    ...(view.projectSettings === null
      ? {}
      : { project: { scopeRevision: view.projectSettings.revision, payload: view.projectSettings.payload } }),
  };
}

function makeIdentity(
  input: TaskStrategyReapplicationPreviewInput,
  view: TaskStrategyReapplicationReadView,
  items: readonly TaskStrategyReapplicationPreviewItem[],
): TaskStrategyReapplicationPreviewIdentity {
  const taskRevisions = items.map((item) => ({ taskId: item.taskId, revision: item.taskRevision }));
  const candidateSummary = items.map((item) => ({
    taskId: item.taskId,
    taskRevision: item.taskRevision,
    eligible: item.eligible,
    reasons: item.reasons,
    candidate: item.candidate === null
      ? null
      : {
          digest: item.candidate.digest,
          configSource: item.candidate.configSource,
          configSourceKey: item.candidate.configSourceKey,
        },
    diff: item.diff,
  }));
  const candidateDigest = digest({
    projectId: input.projectId,
    globalSettingsRevision: view.globalSettings?.revision ?? null,
    projectSettingsRevision: view.projectSettings?.revision ?? null,
    selectedTaskIds: input.taskIds,
    taskRevisions,
    candidateSummary,
  });
  return {
    projectId: input.projectId,
    globalSettingsRevision: view.globalSettings?.revision ?? null,
    projectSettingsRevision: view.projectSettings?.revision ?? null,
    selectedTaskIds: [...input.taskIds],
    taskRevisions,
    candidateDigest,
  };
}

function blockedItem(
  fact: TaskStrategyReapplicationTaskFact,
  reasons: readonly TaskStrategyReapplicationBlockReason[],
): TaskStrategyReapplicationPreviewItem {
  return {
    taskId: fact.task?.id ?? '',
    featureId: fact.task?.featureId ?? null,
    taskRevision: fact.task?.revision ?? null,
    complexity: fact.task?.complexity ?? null,
    current: {
      configSource: fact.task?.configSource ?? null,
      configSourceKey: fact.task?.configSourceKey ?? null,
      digest: fact.task === null ? null : safeTaskConfigDigest(fact.task.executionConfig),
    },
    candidate: null,
    diff: null,
    eligible: false,
    reasons,
  };
}

function previewValidated(
  input: TaskStrategyReapplicationPreviewInput,
  view: TaskStrategyReapplicationReadView,
  dependencies: TaskStrategyReapplicationPreviewDependencies,
): TaskStrategyReapplicationPreview {
  const globalReasons: TaskStrategyReapplicationBlockReason[] = [];
  if (!view.projectExists) globalReasons.push('project_not_found');
  if (view.globalSettings === null && view.projectSettings === null) {
    globalReasons.push('configuration_missing');
  }

  let settings: ReturnType<typeof mergeEffectiveSettings> | null = null;
  if (globalReasons.length === 0) {
    try {
      settings = mergeEffectiveSettings(settingsInputs(view));
      if (!settings.configured) globalReasons.push('configuration_missing');
    } catch {
      globalReasons.push('configuration_invalid');
    }
  }

  const factsById = new Map(view.tasks.map((fact) => [fact.task?.id ?? '', fact]));
  const items = input.taskIds.map((taskId): TaskStrategyReapplicationPreviewItem => {
    const fact = factsById.get(taskId);
    if (fact === undefined) {
      return {
        taskId,
        featureId: null,
        taskRevision: null,
        complexity: null,
        current: { configSource: null, configSourceKey: null, digest: null },
        candidate: null,
        diff: null,
        eligible: false,
        reasons: ['task_not_found'],
      };
    }
    const reasons = baseReasons(fact);
    if (fact.ownership !== 'same_project') {
      return {
        taskId,
        featureId: null,
        taskRevision: null,
        complexity: null,
        current: { configSource: null, configSourceKey: null, digest: null },
        candidate: null,
        diff: null,
        eligible: false,
        reasons: [fact.ownership === 'other_project' ? 'cross_project' : 'task_not_found'],
      };
    }
    if (globalReasons.length > 0 || fact.task === null) {
      return {
        ...blockedItem(fact, [...new Set([...globalReasons, ...reasons])]),
        taskId,
      };
    }
    if (reasons.length > 0) return blockedItem(fact, reasons);
    if (dependencies.capabilityCatalog === undefined) {
      return blockedItem(fact, ['capability_catalog_unavailable']);
    }
    try {
      const selection = selectTaskStrategy({
        ...settingsInputs(view),
        ...(fact.task.complexity === null ? {} : { complexity: fact.task.complexity }),
      });
      const candidate = validateTaskExecutionConfig(
        selection.executionConfig,
        TASK_STRATEGY_REAPPLICATION_PREVIEW_OPERATION,
      );
      validateRuntimeStrategyCapabilities(
        candidate,
        dependencies.capabilityCatalog,
        { operation: TASK_STRATEGY_REAPPLICATION_PREVIEW_OPERATION, entity: { type: 'task', projectId: input.projectId, id: taskId } },
        'candidate.executionConfig',
      );
      const current = validateTaskExecutionConfig(
        fact.task.executionConfig,
        TASK_STRATEGY_REAPPLICATION_PREVIEW_OPERATION,
      );
      const candidateView: TaskStrategyReapplicationPreviewCandidate = {
        executionConfig: candidate,
        configSource: selection.configSource,
        configSourceKey: selection.configSourceKey,
        digest: digest(candidate),
      };
      return {
        taskId,
        featureId: fact.task.featureId,
        taskRevision: fact.task.revision,
        complexity: fact.task.complexity,
        current: {
          configSource: fact.task.configSource,
          configSourceKey: fact.task.configSourceKey,
          digest: digest(current),
        },
        candidate: candidateView,
        diff: diffConfigs(current, candidate),
        eligible: true,
        reasons: [],
      };
    } catch (error) {
      const reason = reasonFromCapabilityError(error);
      return blockedItem(fact, [reason]);
    }
  });

  const blockedReasons = [...new Set([
    ...globalReasons,
    ...items.flatMap((item) => item.reasons),
  ])];
  return {
    schemaVersion: TASK_STRATEGY_REAPPLICATION_PREVIEW_SCHEMA_VERSION,
    scope: 'task-strategy-reapplication-preview',
    status: blockedReasons.length === 0 ? 'ready' : 'blocked',
    identity: makeIdentity(input, view, items),
    items,
    blockedReasons,
  };
}

/** 计算默认策略重新应用预览；整个函数只调用只读端口。 */
export function previewTaskStrategyReapplication(
  input: unknown,
  dependencies: TaskStrategyReapplicationPreviewDependencies,
): TaskStrategyReapplicationPreview {
  const validated = validateInput(input);
  if (dependencies === null || typeof dependencies !== 'object' || dependencies.reads === undefined) {
    throw new TypeError(`${TASK_STRATEGY_REAPPLICATION_PREVIEW_OPERATION}: reads 依赖缺失`);
  }
  const view = dependencies.reads.readTaskStrategyReapplicationView(
    validated.projectId,
    validated.taskIds,
  );
  return previewValidated(validated, view, dependencies);
}

export interface TaskStrategyReapplicationPreviewService {
  preview(input: unknown): TaskStrategyReapplicationPreview;
}

export function createTaskStrategyReapplicationPreviewService(
  dependencies: TaskStrategyReapplicationPreviewDependencies,
): TaskStrategyReapplicationPreviewService {
  return { preview: (input) => previewTaskStrategyReapplication(input, dependencies) };
}

/** 兼容调用方自然命名的别名；均指向同一只读实现。 */
export const previewDefaultTaskStrategyReapplication = previewTaskStrategyReapplication;
export const createDefaultTaskStrategyReapplicationPreview = createTaskStrategyReapplicationPreviewService;
