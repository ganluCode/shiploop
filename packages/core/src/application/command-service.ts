/**
 * F-007 幂等同步命令服务；F-008 起接入 project.register 纵向切片
 * （配置命令 F-009 接入，此时明确 unsupported）。
 * 可信 principal 只由装配传入；结构/授权/时效拒绝不持久化。
 * 业务拒绝在任何写入之前作决定，写后异常只能回滚，不能吞成 rejected。
 */
import { randomBytes } from 'node:crypto';
import {
  assertTrustedPrincipal,
  authorizeCommand,
  authorizeCommandReplay,
  mapProjectLookupError,
  requireProjectVisible,
} from '../ports/authorization.js';
import type { TrustedPrincipal } from '../ports/authorization.js';
import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
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
import type { RepositoryInspector } from '../ports/repository-inspector.js';
import type {
  ProjectRecord,
  RepositoryBindingRecord,
} from '../ports/state-store.js';

export interface CommandService {
  submit(principal: unknown, envelope: unknown): Promise<CommandReceipt>;
}
export interface CommandServiceOptions {
  readonly atomicStore: AtomicCommandStore;
  /** F-008：project.register 的只读仓库检查（写事务之外调用；不传则注册命令 unsupported）。 */
  readonly repositoryInspector?: RepositoryInspector;
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

interface ReceiptIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly operation: ValidatedCommandEnvelope['operation'];
  readonly scope: ValidatedCommandEnvelope['scope'];
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}

/** 公开记录形状：UtcMs → ISO UTC；字段集与 P01 端口记录一一对应。 */
function publicProjectRecord(project: ProjectRecord) {
  const { createdAtUtcMs, updatedAtUtcMs, ...fields } = project;
  return {
    ...fields,
    createdAt: new Date(createdAtUtcMs).toISOString(),
    updatedAt: new Date(updatedAtUtcMs).toISOString(),
  };
}

function publicBindingRecord(binding: RepositoryBindingRecord) {
  const { createdAtUtcMs, updatedAtUtcMs, ...fields } = binding;
  return {
    ...fields,
    createdAt: new Date(createdAtUtcMs).toISOString(),
    updatedAt: new Date(updatedAtUtcMs).toISOString(),
  };
}

export function createCommandService(options: CommandServiceOptions): CommandService {
  const store = options.atomicStore;
  const repositoryInspector = options.repositoryInspector;
  const nowUtcMs = options.nowUtcMs ?? Date.now;

  /** 既有项目元数据 CAS：业务 + metadata_updated 事件 + 回执同一事务（F-007）。 */
  function submitMetadataUpdate(
    principal: TrustedPrincipal,
    envelope: Extract<ValidatedCommandEnvelope, { operation: 'project.metadata.update' }>,
    digest: string,
    transaction: CommandTransaction,
    now: number,
  ): CommandReceipt {
    let project;
    try {
      project = transaction.getProject(envelope.scope.projectId);
    } catch (error) {
      mapProjectLookupError(error, envelope.operation);
    }
    const identity: ReceiptIdentity = {
      principalId: principal.principalId,
      commandId: envelope.commandId,
      operation: envelope.operation,
      scope: envelope.scope,
      requestDigest: digest,
      issuedAt: envelope.issuedAt,
      completedAt: new Date(now).toISOString(),
    };
    if (project.revision !== envelope.expectedRevision) {
      // CAS 失败在任何业务写入之前固化稳定 rejected。
      const receipt = createRejectedReceipt({
        ...identity,
        error: new PublicError('conflict', envelope.operation, undefined, {
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
    const receipt = createCompletedReceipt({
      ...identity,
      resultRef: createResultRef(randomBytes(32)),
      result: { project: publicProjectRecord(updated) },
    });
    transaction.saveReceipt(receipt);
    return receipt;
  }

  /** 注册：项目 + 绑定 + project.registered 创建事件 + 回执同一事务（F-008）。 */
  function submitRegister(
    principal: TrustedPrincipal,
    envelope: Extract<ValidatedCommandEnvelope, { operation: 'project.register' }>,
    digest: string,
    binding: { canonicalPath: string; gitCommonDir: string | null; repoIdentity: string },
    transaction: CommandTransaction,
    now: number,
  ): CommandReceipt {
    const outcome = transaction.registerProject(
      {
        displayName: envelope.payload.displayName,
        description: envelope.payload.description,
        labels: envelope.payload.labels,
      },
      binding,
    );
    if (outcome.status === 'already_exists') {
      // canonicalPath 命中不可见项目：授权失败不积回执，整组回滚、不泄漏存在性。
      requireProjectVisible(principal, outcome.project.id, envelope.operation);
    }
    const receipt = createCompletedReceipt({
      principalId: principal.principalId,
      commandId: envelope.commandId,
      operation: envelope.operation,
      scope: envelope.scope,
      requestDigest: digest,
      issuedAt: envelope.issuedAt,
      completedAt: new Date(now).toISOString(),
      resultRef: createResultRef(randomBytes(32)),
      result: {
        status: outcome.status,
        project: publicProjectRecord(outcome.project),
        binding: publicBindingRecord(outcome.binding),
      },
    });
    transaction.saveReceipt(receipt);
    return receipt;
  }

  return {
    async submit(principal: unknown, input: unknown): Promise<CommandReceipt> {
      // 非法可信装配为编程错误，不折算客户端错误。
      assertTrustedPrincipal(principal);
      let operation = 'commands.submit';
      try {
        const envelope = validateCommandEnvelope(input);
        operation = envelope.operation;
        authorizeCommand(principal, envelope);
        if (envelope.operation === 'project.register' && repositoryInspector === undefined) {
          throw new PublicError('unsupported', operation);
        }
        if (
          envelope.operation !== 'project.metadata.update' &&
          envelope.operation !== 'project.register'
        ) {
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

        // F-008：只读仓库检查（Git/文件系统）在写事务之外，仅对新命令执行；
        // 检查错误经 mapToPublicError 折算为受控公开错误，零业务副作用。
        let binding:
          | { canonicalPath: string; gitCommonDir: string | null; repoIdentity: string }
          | undefined;
        if (envelope.operation === 'project.register' && existing === undefined) {
          const inspection = await repositoryInspector!.inspect(envelope.payload.repositoryPath);
          binding = {
            canonicalPath: inspection.canonicalPath,
            gitCommonDir: inspection.gitCommonDir,
            repoIdentity: inspection.repoIdentity,
          };
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
          if (envelope.operation === 'project.register') {
            // 新注册命令必定已在事务外完成仓库检查（重放已在上面返回）。
            if (binding === undefined) throw new TypeError('注册命令缺少事务外仓库检查结果');
            return submitRegister(principal, envelope, digest, binding, transaction, now);
          }
          return submitMetadataUpdate(principal, envelope, digest, transaction, now);
        });
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },
  };
}
