/**
 * F-007 幂等同步命令服务；目前只交付既有项目 metadata CAS 纵向切片。
 * 注册/配置将在 F-008/F-009 接入，此时明确 unsupported。
 * 可信 principal 只由装配传入；结构/授权/时效拒绝不持久化。
 * 业务拒绝在任何写入之前作决定，写后异常只能回滚，不能吞成 rejected。
 */
import { randomBytes } from 'node:crypto';
import {
  assertTrustedPrincipal,
  authorizeCommand,
  authorizeCommandReplay,
  mapProjectLookupError,
} from '../ports/authorization.js';
import type { TrustedPrincipal } from '../ports/authorization.js';
import type { AtomicCommandStore } from '../ports/atomic-commands.js';
import {
  PublicError,
  createCompletedReceipt,
  createRejectedReceipt,
  evaluateCommandTiming,
  mapToPublicError,
  validateCommandEnvelope,
} from '../ports/commands.js';
import type { CommandReceipt, ValidatedCommandEnvelope } from '../ports/commands.js';
import {
  computeCommandRequestDigest,
  createResultRef,
  decideCommandReplay,
  registrationProjectIdOf,
} from '../ports/command-receipts.js';

export interface CommandService {
  submit(principal: unknown, envelope: unknown): Promise<CommandReceipt>;
}
export interface CommandServiceOptions {
  readonly atomicStore: AtomicCommandStore;
  readonly nowUtcMs?: () => number;
}

function checkTiming(envelope: ValidatedCommandEnvelope, now: number): void {
  const verdict = evaluateCommandTiming(envelope, now);
  if (verdict.kind === 'expired') {
    throw new PublicError('command_expired', envelope.operation, undefined, {
      details: { reason: 'command_expired' },
    });
  }
  if (verdict.kind === 'clock_skew') {
    throw new PublicError('invalid_input', envelope.operation, undefined, {
      details: { field: 'issuedAt', reason: 'clock_skew' },
    });
  }
}

function replay(
  principal: TrustedPrincipal,
  existing: CommandReceipt | undefined,
  digest: string,
  operation: string,
): CommandReceipt | undefined {
  if (existing !== undefined) {
    // 原回执操作的能力/归属重核先于摘要比较；不泄漏旧命令信息。
    authorizeCommandReplay(principal, existing, registrationProjectIdOf(existing, operation), operation);
  }
  const decision = decideCommandReplay(existing, digest, operation);
  return decision.kind === 'replay' ? decision.receipt : undefined;
}

export function createCommandService(options: CommandServiceOptions): CommandService {
  const store = options.atomicStore;
  const nowUtcMs = options.nowUtcMs ?? Date.now;
  return {
    async submit(principal: unknown, input: unknown): Promise<CommandReceipt> {
      // 非法可信装配为编程错误，不折算客户端错误。
      assertTrustedPrincipal(principal);
      let operation = 'commands.submit';
      try {
        const envelope = validateCommandEnvelope(input);
        operation = envelope.operation;
        authorizeCommand(principal, envelope);
        if (envelope.operation !== 'project.metadata.update') {
          throw new PublicError('unsupported', operation);
        }
        const digest = computeCommandRequestDigest(envelope);
        const existing = store.findReceipt(principal.principalId, envelope.commandId);
        // 预读只决定新命令的事务外时效拒绝；重放仍必须进入权威写事务重读。
        if (existing === undefined) {
          checkTiming(envelope, nowUtcMs());
        } else {
          replay(principal, existing, digest, operation);
        }

        return store.transact(operation, transaction => {
          authorizeCommand(principal, envelope);
          const original = replay(
            principal,
            transaction.findReceipt(principal.principalId, envelope.commandId),
            digest,
            operation,
          );
          if (original !== undefined) return original;
          const now = nowUtcMs();
          checkTiming(envelope, now);
          let project;
          try {
            project = transaction.getProject(envelope.scope.projectId);
          } catch (error) {
            mapProjectLookupError(error, operation);
          }
          const identity = {
            principalId: principal.principalId,
            commandId: envelope.commandId,
            operation: envelope.operation,
            scope: envelope.scope,
            requestDigest: digest,
            issuedAt: envelope.issuedAt,
            completedAt: new Date(now).toISOString(),
          };
          if (project.revision !== envelope.expectedRevision) {
            const receipt = createRejectedReceipt({
              ...identity,
              error: new PublicError('conflict', operation, undefined, {
                details: {
                  expectedRevision: envelope.expectedRevision,
                  actualRevision: project.revision,
                  entityType: 'project',
                },
              }),
            });
            transaction.saveReceipt(receipt);
            return receipt;
          }
          const updated = transaction.updateProjectMetadata(envelope.scope.projectId, {
            ...envelope.payload,
            expectedRevision: envelope.expectedRevision,
          });
          const { createdAtUtcMs, updatedAtUtcMs, ...fields } = updated;
          const receipt = createCompletedReceipt({
            ...identity,
            resultRef: createResultRef(randomBytes(32)),
            result: {
              project: {
                ...fields,
                createdAt: new Date(createdAtUtcMs).toISOString(),
                updatedAt: new Date(updatedAtUtcMs).toISOString(),
              },
            },
          });
          transaction.saveReceipt(receipt);
          return receipt;
        });
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },
  };
}
