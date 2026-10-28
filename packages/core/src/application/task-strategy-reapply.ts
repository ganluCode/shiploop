/** P06-6 / F-002：默认策略重应用确认与原子批量写入。 */
import { randomBytes } from 'node:crypto';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import { mapProjectLookupError } from '../ports/authorization.js';
import {
  PublicError,
  createCompletedReceipt,
  createRejectedReceipt,
} from '../ports/commands.js';
import type { CommandReceipt, ValidatedCommandEnvelope } from '../ports/commands.js';
import { createResultRef } from '../ports/command-receipts.js';
import type { RuntimeCapabilityCatalog } from '../ports/runtime-capabilities.js';
import type { TaskStrategyEditGuards } from './task-strategy-update.js';
import { previewTaskStrategyReapplication } from './task-strategy-preview.js';

export const TASK_STRATEGY_REAPPLICATION_OPERATION = 'task.strategy.reapply' as const;

type ReapplicationEnvelope = Extract<
  ValidatedCommandEnvelope,
  { operation: typeof TASK_STRATEGY_REAPPLICATION_OPERATION }
>;

export interface TaskStrategyReapplicationIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly operation: typeof TASK_STRATEGY_REAPPLICATION_OPERATION;
  readonly scope: ReapplicationEnvelope['scope'];
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}

export interface TaskStrategyReapplicationDeps {
  readonly capabilityCatalog: RuntimeCapabilityCatalog;
  readonly guards?: TaskStrategyEditGuards;
}

function rejected(
  identity: TaskStrategyReapplicationIdentity,
  transaction: CommandTransaction,
  reason: string,
): CommandReceipt {
  const receipt = createRejectedReceipt({
    ...identity,
    error: new PublicError('conflict', TASK_STRATEGY_REAPPLICATION_OPERATION, undefined, {
      details: { reason },
    }),
  });
  transaction.saveReceipt(receipt);
  return receipt;
}

function sameTaskRevisions(
  expected: ReapplicationEnvelope['payload']['expectedTaskRevisions'],
  actual: ReapplicationEnvelope['payload']['expectedTaskRevisions'],
): boolean {
  return expected.length === actual.length
    && expected.every((entry, index) => entry.taskId === actual[index]?.taskId
      && entry.revision === actual[index]?.revision);
}

/**
 * 在 BEGIN IMMEDIATE 内重算预览并逐目标 CAS 更新。所有目标先完成资格、摘要、
 * 配置 revision、Task revision、活动执行与能力检查，之后才执行第一条 UPDATE，
 * 因而任一目标失败都不会留下部分批量写入。
 */
export function submitTaskStrategyReapplication(
  identity: TaskStrategyReapplicationIdentity,
  envelope: ReapplicationEnvelope,
  transaction: CommandTransaction,
  deps: TaskStrategyReapplicationDeps,
): CommandReceipt {
  const projectId = envelope.scope.projectId;
  try {
    transaction.getProject(projectId);
  } catch (error) {
    mapProjectLookupError(error, TASK_STRATEGY_REAPPLICATION_OPERATION);
  }

  const payload = envelope.payload;
  const preview = previewTaskStrategyReapplication(
    { projectId, taskIds: payload.selectedTaskIds },
    {
      reads: {
        readTaskStrategyReapplicationView: (readProjectId, taskIds) =>
          transaction.readTaskStrategyReapplicationViewInTransaction(
            String(readProjectId), taskIds.map(String)),
      },
      capabilityCatalog: deps.capabilityCatalog,
    },
  );
  const expectedRevisions = [...payload.expectedTaskRevisions].sort((a, b) => a.taskId.localeCompare(b.taskId));
  const actualRevisions = [...preview.identity.taskRevisions]
    .filter((entry): entry is { readonly taskId: string; readonly revision: number } => entry.revision !== null)
    .map((entry) => ({ taskId: entry.taskId, revision: entry.revision }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  const identityMatches = preview.identity.projectId === projectId
    && preview.identity.globalSettingsRevision === payload.globalSettingsRevision
    && preview.identity.projectSettingsRevision === payload.projectSettingsRevision
    && preview.identity.selectedTaskIds.length === payload.selectedTaskIds.length
    && preview.identity.selectedTaskIds.every((taskId, index) => taskId === payload.selectedTaskIds[index])
    && sameTaskRevisions(expectedRevisions, actualRevisions)
    && preview.identity.candidateDigest === payload.previewDigest;
  if (!identityMatches) return rejected(identity, transaction, 'preview_stale');
  if (preview.status !== 'ready') {
    return rejected(identity, transaction, preview.blockedReasons[0] ?? 'preview_stale');
  }

  const selected = new Map(preview.items.map((item) => [item.taskId, item]));
  // 受控测试装配的执行输入探测仍在同一事务内执行；生产库事实由上面的
  // attempts/runs/Batch 一致读提供，二者任一报告活动都 fail-closed。
  if (deps.guards !== undefined) {
    for (const taskId of payload.selectedTaskIds) {
      if (deps.guards.activeTaskExecutionInputs({ projectId, taskId }).active) {
        return rejected(identity, transaction, 'active_execution_inputs');
      }
    }
  }

  const updated: { readonly taskId: string; readonly revision: number }[] = [];
  for (const taskId of payload.selectedTaskIds) {
    const item = selected.get(taskId);
    if (item === undefined || !item.eligible || item.candidate === null) {
      return rejected(identity, transaction, 'preview_stale');
    }
    const expected = payload.expectedTaskRevisions.find((entry) => entry.taskId === taskId);
    if (expected === undefined || item.taskRevision !== expected.revision) {
      return rejected(identity, transaction, 'preview_stale');
    }
    const task = transaction.updateTaskStrategy({
      projectId,
      taskId,
      executionConfig: item.candidate.executionConfig,
      configSource: item.candidate.configSource,
      configSourceKey: item.candidate.configSourceKey,
      expectedRevision: expected.revision,
    });
    transaction.appendPlanEvent({
      projectId,
      eventType: 'task.strategy.updated',
      aggregateType: 'task',
      aggregateId: task.id,
      aggregateRevision: task.revision,
      payload: { strategyUpdated: true },
    });
    updated.push({ taskId: task.id, revision: task.revision });
  }

  const receipt = createCompletedReceipt({
    ...identity,
    resultRef: createResultRef(randomBytes(32)),
    result: {
      updatedTaskIds: updated.map((entry) => entry.taskId),
      taskRevisions: updated,
      updatedCount: updated.length,
    },
  });
  transaction.saveReceipt(receipt);
  return receipt;
}
