/**
 * P03-9 / F-002：Run/Batch 取消意图命令用例。
 *
 * 不变量：
 * - 无 Runtime/Git/文件 I/O；项目可见性、目标归属、revision CAS、取消意图、
 *   状态、持久停止 operation 与事件全部在同一短写事务内完成；
 * - 活动执行/占用存在时只进入 cancelling 并返回已关联停止 operation；无活动且
 *   占用确认安全时才完成 cancelled；accepted/Runtime result/父进程退出都不是停止证据；
 * - interrupted 不被当作无活动而释放占用，返回 stop_uncertain；
 * - 终态只返回 already_terminal，绝不倒写；不修改预算、deadline、累计计数、
 *   历史 Attempt 或代码；重复 commandId 由通用回执事务返回原回执且不新建 operation。
 */
import { randomBytes } from 'node:crypto';
import { mapProjectLookupError } from '../ports/authorization.js';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import {
  createCompletedReceipt,
  createRejectedReceipt,
  PublicError,
} from '../ports/commands.js';
import type { CommandReceipt, ValidatedCommandEnvelope } from '../ports/commands.js';
import { createResultRef } from '../ports/command-receipts.js';

type CancelEnvelope = Extract<ValidatedCommandEnvelope, { operation: 'execution.cancel' }>;

export interface CancelCommandIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly operation: CancelEnvelope['operation'];
  readonly scope: CancelEnvelope['scope'];
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}

/**
 * 取消事务用例：revision 失配在任何业务写入前固化为稳定 rejected；终态返回
 * completed + already_terminal（状态/事件/停止 operation 零写入）。同事务保存回执。
 */
export function submitExecutionCancel(
  identity: CancelCommandIdentity,
  envelope: CancelEnvelope,
  transaction: CommandTransaction,
): CommandReceipt {
  const operation = envelope.operation;
  try {
    transaction.getProject(envelope.scope.projectId);
  } catch (error) {
    mapProjectLookupError(error, operation);
  }
  const targetKind = typeof envelope.payload.featureId === 'string'
    ? 'feature'
    : envelope.payload.runId !== null ? 'run' : 'batch';
  const targetId = envelope.payload.featureId ?? envelope.payload.runId ?? envelope.payload.batchId!;
  const current = targetKind === 'feature'
    ? transaction.getFeaturePlan(envelope.scope.projectId, targetId).feature
    : targetKind === 'run'
      ? transaction.getExecutionRun(envelope.scope.projectId, targetId)
      : transaction.getExecutionBatch(envelope.scope.projectId, targetId);
  if (current.revision !== envelope.expectedRevision) {
    const receipt = createRejectedReceipt({
      ...identity,
      error: new PublicError('conflict', operation, undefined, {
        details: {
          reason: 'stale_revision',
          entityType: targetKind === 'run' ? 'run' : targetKind === 'batch' ? 'execution_batch' : 'feature',
          expectedRevision: envelope.expectedRevision,
          actualRevision: current.revision,
        },
      }),
    });
    transaction.saveReceipt(receipt);
    return receipt;
  }
  const result = transaction.requestExecutionCancel({
    projectId: envelope.scope.projectId,
    targetKind,
    targetId,
    expectedRevision: envelope.expectedRevision,
    commandId: envelope.commandId,
  });
  const receipt = createCompletedReceipt({
    ...identity,
    resultRef: createResultRef(randomBytes(32)),
    result: {
      outcome: result.outcome,
      targetKind: result.targetKind,
      targetId: result.targetId,
      status: result.status,
      revision: result.revision,
      changed: result.changed,
      stopOperationId: result.stopOperationId,
      stopStatus: result.stopStatus,
      // 终态只读应答；不伪造停止完成。
      ...(result.outcome === 'already_terminal' ? { alreadyTerminal: true } : {}),
    },
  });
  transaction.saveReceipt(receipt);
  return receipt;
}
