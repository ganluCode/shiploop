/**
 * P07-3 / F-015：retention.cleanup.execute 公开命令（application 层）。
 *
 * 设计依据：FR-2 / PRD §3.1 保留政策与 core-design/08 §2 命令面。
 *
 * 不变量：
 * - 政策唯一来源是全局当前配置（payload 为空对象；客户端不能自带政策或
 *   限额）；未配置保留段 → rejected（conflict / retention_policy_not_configured），
 *   不注入默认值也不伪造执行；
 * - 授权在 commandService 信封阶段完成（global scope + settings.global.write，
 *   local-owner 能力面；受限 Work 主体默认无该能力位）；
 * - 清理文件副作用发生在短写事务之外；事务内只持久化 completed/rejected
 *   回执（与 project.delete.preview 同一纪律）；同 commandId 重放返回同一
 *   回执，operationId 复用命令身份，重复执行按 F-013 存储重核候选；
 * - 回执结果是有界摘要（状态/计数/去重 reason 截断），不内联完整候选清单。
 */
import { PublicError, createCompletedReceipt, createRejectedReceipt, type CommandReceipt, type ValidatedCommandEnvelope } from '../ports/commands.js';
import { computeCommandRequestDigest, createResultRef, decideCommandReplay } from '../ports/command-receipts.js';
import { assertTrustedPrincipal, authorizeCommandReplay, type TrustedPrincipal } from '../ports/authorization.js';
import { isStorageError } from '../ports/errors.js';
import type { AtomicCommandStore } from '../ports/atomic-commands.js';
import type { RetentionCleanupService } from '../ports/evidence-retention.js';
import type { RetentionPolicyV2 } from '../ports/settings-schema.js';
import type { ConfigurationService } from './configuration-service.js';
import { randomBytes } from 'node:crypto';

/** 回执 reason 清单的有界上限（去重后截断）。 */
const RECEIPT_REASON_LIMIT = 20;

export const RETENTION_CLEANUP_COMMAND_OPERATION = 'retention.cleanup.execute' as const;

export interface RetentionCleanupCommandReceiptResult {
  readonly status: 'completed' | 'partial' | 'blocked' | 'failed' | 'unknown';
  readonly operationId: string;
  readonly itemsDeleted: number;
  readonly bytesDeleted: number;
  readonly candidateCount: number;
  readonly retainedCount: number;
  readonly skippedCount: number;
  readonly reasons: readonly string[];
}

export interface RetentionCleanupCommandHandler {
  submit(principal: TrustedPrincipal, envelope: Extract<ValidatedCommandEnvelope, { operation: typeof RETENTION_CLEANUP_COMMAND_OPERATION }>, digest: string): Promise<CommandReceipt>;
}

interface ReceiptIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly operation: typeof RETENTION_CLEANUP_COMMAND_OPERATION;
  readonly scope: { readonly kind: 'global' };
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}

export function createRetentionCleanupCommandHandler(options: {
  /** F-013 有界清理服务（引用保护 + 备份轮换 + 维护/备份互斥）。 */
  readonly cleanup: RetentionCleanupService;
  /** 全局当前配置读取（唯一政策来源）。 */
  readonly settings: Pick<ConfigurationService, 'getCurrentSettings'>;
  readonly atomicStore: AtomicCommandStore;
  readonly nowUtcMs?: () => number;
}): RetentionCleanupCommandHandler {
  const now = options.nowUtcMs ?? Date.now;

  const replay = (principal: TrustedPrincipal, existing: CommandReceipt | undefined, digest: string): CommandReceipt | undefined => {
    if (existing !== undefined) {
      authorizeCommandReplay(principal, existing, null, RETENTION_CLEANUP_COMMAND_OPERATION);
    }
    const decision = decideCommandReplay(existing, digest, RETENTION_CLEANUP_COMMAND_OPERATION);
    return decision.kind === 'replay' ? decision.receipt : undefined;
  };

  const readPolicy = async (): Promise<RetentionCleanupV2 | undefined> => {
    try {
      const record = await options.settings.getCurrentSettings({ kind: 'global' });
      const section = record.payload.policies?.retentionPolicy;
      if (section !== undefined && Object.keys(section).length > 0) return section;
      return undefined;
    } catch (error) {
      // 未配置（缺失）折算为 undefined；损坏/其他错误原样传播，不冒充未配置。
      if (isStorageError(error, 'not_found')) return undefined;
      throw error;
    }
  };

  return {
    async submit(principal, envelope, digest) {
      assertTrustedPrincipal(principal);
      const owner: TrustedPrincipal = principal;
      const existing = options.atomicStore.transact(`${RETENTION_CLEANUP_COMMAND_OPERATION}.replay`, transaction =>
        replay(owner, transaction.findReceipt(owner.principalId, envelope.commandId), digest));
      if (existing !== undefined) return existing;

      const timestamp = now();
      const identity: ReceiptIdentity = {
        principalId: owner.principalId,
        commandId: envelope.commandId,
        operation: RETENTION_CLEANUP_COMMAND_OPERATION,
        scope: { kind: 'global' },
        requestDigest: digest,
        issuedAt: envelope.issuedAt,
        completedAt: new Date(timestamp).toISOString(),
      };

      const policy = await readPolicy();
      if (policy === undefined) {
        const receipt = createRejectedReceipt({
          ...identity,
          error: new PublicError('conflict', RETENTION_CLEANUP_COMMAND_OPERATION, '未配置保留政策（settings.global policies.retentionPolicy），拒绝清理', {
            details: { reason: 'retention_policy_not_configured' },
          }),
        });
        options.atomicStore.transact(RETENTION_CLEANUP_COMMAND_OPERATION, transaction => transaction.saveReceipt(receipt));
        return receipt;
      }

      // 文件副作用在事务外；operationId 绑定命令身份（重放/续跑不换身份）。
      const run = await options.cleanup.execute({ operationId: envelope.commandId, policy, nowUtcMs: timestamp });
      const receipt = createCompletedReceipt({
        ...identity,
        resultRef: createResultRef(randomBytes(32)),
        result: {
          status: run.status,
          operationId: run.operationId,
          itemsDeleted: run.itemsDeleted,
          bytesDeleted: run.bytesDeleted,
          candidateCount: run.evaluated.candidates.length + run.evaluated.backupCandidates.length,
          retainedCount: run.retained.length,
          skippedCount: run.skipped.length,
          reasons: [...new Set(run.reasons)].slice(0, RECEIPT_REASON_LIMIT),
        } satisfies RetentionCleanupCommandReceiptResult,
      });
      options.atomicStore.transact(RETENTION_CLEANUP_COMMAND_OPERATION, transaction => transaction.saveReceipt(receipt));
      return receipt;
    },
  };
}

type RetentionCleanupV2 = RetentionPolicyV2;
