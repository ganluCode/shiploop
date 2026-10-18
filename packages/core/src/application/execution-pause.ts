/**
 * P03-9 / F-001：Run/Batch 的 Task 边界暂停命令用例。
 *
 * 不变量：
 * - 无 Runtime/Git/文件 I/O；项目可见性、目标归属、revision CAS、暂停意图、
 *   状态与事件全部在同一短写事务内完成；
 * - 暂停只停止新认领：目标无活动 Attempt 直接 paused，有活动 Attempt 进入
 *   pausing；当前 Attempt 仍可完成验证/必要收尾，之后由生命周期收口为 paused；
 * - 终态目标只返回 already_terminal，绝不倒写；不修改预算、deadline、累计计数
 *   或代码；重复 commandId 由通用回执事务返回原回执；
 * - 目标 ID 只能是同项目 Run 或 Batch，跨项目/缺失目标结构化拒绝。
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

type PauseEnvelope = Extract<ValidatedCommandEnvelope, { operation: 'execution.pause' }>;

export interface PauseCommandIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly operation: PauseEnvelope['operation'];
  readonly scope: PauseEnvelope['scope'];
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}

/**
 * 暂停事务用例：revision 失配在任何业务写入前固化为稳定 rejected；目标终态
 * 返回 completed + already_terminal（状态/事件零写入）。同事务保存回执。
 */
export function submitExecutionPause(
  identity: PauseCommandIdentity,
  envelope: PauseEnvelope,
  transaction: CommandTransaction,
): CommandReceipt {
  const operation = envelope.operation;
  try {
    transaction.getProject(envelope.scope.projectId);
  } catch (error) {
    mapProjectLookupError(error, operation);
  }
  const targetKind = envelope.payload.runId !== null ? 'run' : 'batch';
  const targetId = envelope.payload.runId ?? envelope.payload.batchId!;
  const current = targetKind === 'run'
    ? transaction.getExecutionRun(envelope.scope.projectId, targetId)
    : transaction.getExecutionBatch(envelope.scope.projectId, targetId);
  if (current.revision !== envelope.expectedRevision) {
    const receipt = createRejectedReceipt({
      ...identity,
      error: new PublicError('conflict', operation, undefined, {
        details: {
          reason: 'stale_revision',
          entityType: targetKind === 'run' ? 'run' : 'execution_batch',
          expectedRevision: envelope.expectedRevision,
          actualRevision: current.revision,
        },
      }),
    });
    transaction.saveReceipt(receipt);
    return receipt;
  }
  const result = transaction.requestExecutionPause({
    projectId: envelope.scope.projectId,
    targetKind,
    targetId,
    expectedRevision: envelope.expectedRevision,
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
      // 终态只读应答；不带任何伪造的停止/暂停完成声明。
      ...(result.outcome === 'already_terminal' ? { alreadyTerminal: true } : {}),
    },
  });
  transaction.saveReceipt(receipt);
  return receipt;
}
