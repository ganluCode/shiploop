/**
 * F-007 幂等同步命令服务；F-008 起接入 project.register 纵向切片；
 * F-009 起接入 settings.global/project create/update 配置命令纵向切片。
 * 可信 principal 只由装配传入；结构/授权/时效拒绝不持久化。
 * 业务拒绝在任何写入之前作决定，写后异常只能回滚，不能吞成 rejected。
 *
 * F-009 配置命令复用 P01 全部既有规则（insert-only 首建、expectedRevision CAS、
 * consistency.globalRevision 一致性前置条件、能力目录复检）：能力复检与
 * 一致性视图（全局当前配置快照）在写事务之外完成（仅新命令），推导出的
 * globalRevision 随写入在同一事务内核对（stale_dependency 固化 rejected）；
 * 创建成功同事务写 settings.*_created 创建事件（仅命令路径，契约 §15.3），
 * 更新复用 P01 既有 *_updated 写入，不重复。
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
import {
  toPublicProjectRecord,
  toPublicRepositoryBindingRecord,
  toPublicSettingsState,
} from '../ports/queries.js';
import type { RepositoryInspector } from '../ports/repository-inspector.js';
import { validateStrategyCapabilities } from '../ports/runtime-capabilities.js';
import type { RuntimeCapabilityCatalog } from '../ports/runtime-capabilities.js';
import { GLOBAL_SETTINGS_ID } from '../ports/state-store.js';
import type {
  GlobalSettingsRecord,
  ProjectSettingsRecord,
  SettingsWriteConsistency,
} from '../ports/state-store.js';
import { validateMergedProjectSettingsWrite } from './configuration-service.js';

export interface CommandService {
  submit(principal: unknown, envelope: unknown): Promise<CommandReceipt>;
}
export interface CommandServiceOptions {
  readonly atomicStore: AtomicCommandStore;
  /** F-008：project.register 的只读仓库检查（写事务之外调用；不传则注册命令 unsupported）。 */
  readonly repositoryInspector?: RepositoryInspector;
  /** F-009：配置命令的能力目录复检（可信装配注入；不传则配置命令 unsupported）。 */
  readonly capabilityCatalog?: RuntimeCapabilityCatalog;
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

/** F-009：配置命令在写事务之外准备的写入计划（一致性前置条件由事务内重核）。 */
interface SettingsWritePlan {
  readonly consistency?: SettingsWriteConsistency;
}

type SettingsCommandEnvelope = Extract<ValidatedCommandEnvelope, { operation: `settings.${string}` }>;

function isSettingsEnvelope(envelope: ValidatedCommandEnvelope): envelope is SettingsCommandEnvelope {
  return envelope.operation.startsWith('settings.');
}

// 公开记录形状（ISO UTC 时间）：与 F-010 查询响应共用 ports/queries.ts 的同一组
// 转换函数，不另立第二套序列化规则。

export function createCommandService(options: CommandServiceOptions): CommandService {
  const store = options.atomicStore;
  const repositoryInspector = options.repositoryInspector;
  const capabilityCatalog = options.capabilityCatalog;
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
      result: { project: toPublicProjectRecord(updated) },
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
        project: toPublicProjectRecord(outcome.project),
        binding: toPublicRepositoryBindingRecord(outcome.binding),
      },
    });
    transaction.saveReceipt(receipt);
    return receipt;
  }

  /**
   * F-009：配置命令的事务外写入计划——能力兼容复检与一致性视图（全局当前配置
   * 快照）都在写事务之外完成（仅新命令；重放已在权威事务内返回原回执）。
   * 全局有效配置即全局 payload 自身，直接复检；项目覆盖以「全局快照 + 新
   * payload」合并有效配置后按当前目录复检（继承条目随当前目录复检，P01
   * ConfigurationService 同一纯函数），快照 revision 作为 consistency
   * 前置条件随写入，由同一写事务内核对（stale_dependency 固化 rejected）。
   */
  function prepareSettingsWrite(envelope: SettingsCommandEnvelope): SettingsWritePlan {
    const catalog = capabilityCatalog;
    if (catalog === undefined) throw new TypeError('配置命令缺少可信能力目录装配');
    if (envelope.scope.kind === 'global') {
      validateStrategyCapabilities(envelope.payload, catalog, {
        operation: envelope.operation,
        entity: { type: 'global_settings', id: GLOBAL_SETTINGS_ID },
      });
      return {};
    }
    const snapshot = store.getGlobalSettingsOrNull();
    validateMergedProjectSettingsWrite(
      envelope.operation,
      envelope.scope.projectId,
      envelope.payload,
      envelope.expectedRevision === null ? 1 : envelope.expectedRevision + 1,
      snapshot === null ? null : { revision: snapshot.revision, payload: snapshot.payload },
      catalog,
    );
    return { consistency: { globalRevision: snapshot === null ? null : snapshot.revision } };
  }

  /**
   * F-009：配置写入 + settings.*_created（仅命令路径首建）/ 既有 *_updated 事件 +
   * 回执同一事务。already_exists/CAS 不匹配/stale_dependency 在任何业务写入之前
   * 固化稳定 rejected；更新目标缺失按 not_found 抛出（不积回执，与 F-007 项目
   * 缺失同一边界）；项目存在性缺失折算为与不可见相同的 forbidden，不泄漏存在性。
   */
  function submitSettingsCommand(
    principal: TrustedPrincipal,
    envelope: SettingsCommandEnvelope,
    digest: string,
    plan: SettingsWritePlan,
    transaction: CommandTransaction,
    now: number,
  ): CommandReceipt {
    const identity: ReceiptIdentity = {
      principalId: principal.principalId,
      commandId: envelope.commandId,
      operation: envelope.operation,
      scope: envelope.scope,
      requestDigest: digest,
      issuedAt: envelope.issuedAt,
      completedAt: new Date(now).toISOString(),
    };
    const entityType = envelope.scope.kind === 'global' ? 'global_settings' : 'project_settings';
    const rejected = (error: PublicError): CommandReceipt => {
      const receipt = createRejectedReceipt({ ...identity, error });
      transaction.saveReceipt(receipt);
      return receipt;
    };
    const conflict = (details: Record<string, unknown>): CommandReceipt =>
      rejected(new PublicError('conflict', envelope.operation, undefined, { details }));
    const completed = (record: GlobalSettingsRecord | ProjectSettingsRecord): CommandReceipt => {
      const receipt = createCompletedReceipt({
        ...identity,
        resultRef: createResultRef(randomBytes(32)),
        // 结果只携带提交时固化的当前值事实；不声称 Task 重放/策略可执行/模型已登录。
        result: toPublicSettingsState(envelope.scope, record),
      });
      transaction.saveReceipt(receipt);
      return receipt;
    };
    /** 项目配置写入的目标项目把关：缺失/不可见统一 forbidden（不泄漏存在性）。 */
    const requireVisibleProject = (projectId: string): void => {
      try {
        transaction.getProject(projectId);
      } catch (error) {
        mapProjectLookupError(error, envelope.operation);
      }
    };
    /** 一致性前置条件在同一事务内重核；不一致固化 rejected，不提交基于旧全局值的配置。 */
    const staleDependency = (): CommandReceipt | undefined => {
      const actual = transaction.getGlobalSettingsOrNull()?.revision ?? null;
      if (actual === plan.consistency?.globalRevision) return undefined;
      return conflict({ reason: 'stale_dependency', entityType });
    };

    switch (envelope.operation) {
      case 'settings.global.create': {
        if (transaction.getGlobalSettingsOrNull() !== null) {
          return conflict({ reason: 'already_exists', entityType });
        }
        return completed(transaction.createGlobalSettings({ payload: envelope.payload }));
      }
      case 'settings.global.update': {
        const current = transaction.getGlobalSettingsOrNull();
        if (current === null) {
          throw new PublicError('not_found', envelope.operation, undefined, {
            details: { entityType },
          });
        }
        if (current.revision !== envelope.expectedRevision) {
          return conflict({
            expectedRevision: envelope.expectedRevision,
            actualRevision: current.revision,
            entityType,
          });
        }
        return completed(
          transaction.updateGlobalSettings({
            expectedRevision: envelope.expectedRevision,
            payload: envelope.payload,
          }),
        );
      }
      case 'settings.project.create': {
        requireVisibleProject(envelope.scope.projectId);
        if (transaction.getProjectSettingsOrNull(envelope.scope.projectId) !== null) {
          return conflict({ reason: 'already_exists', entityType });
        }
        const stale = staleDependency();
        if (stale !== undefined) return stale;
        return completed(
          transaction.createProjectSettings(envelope.scope.projectId, {
            payload: envelope.payload,
            consistency: plan.consistency,
          }),
        );
      }
      case 'settings.project.update': {
        requireVisibleProject(envelope.scope.projectId);
        const current = transaction.getProjectSettingsOrNull(envelope.scope.projectId);
        if (current === null) {
          throw new PublicError('not_found', envelope.operation, undefined, {
            details: { entityType },
          });
        }
        if (current.revision !== envelope.expectedRevision) {
          return conflict({
            expectedRevision: envelope.expectedRevision,
            actualRevision: current.revision,
            entityType,
          });
        }
        const stale = staleDependency();
        if (stale !== undefined) return stale;
        return completed(
          transaction.updateProjectSettings(envelope.scope.projectId, {
            expectedRevision: envelope.expectedRevision,
            payload: envelope.payload,
            consistency: plan.consistency,
          }),
        );
      }
    }
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
        if (isSettingsEnvelope(envelope) && capabilityCatalog === undefined) {
          throw new PublicError('unsupported', operation);
        }
        if (
          envelope.operation !== 'project.metadata.update' &&
          envelope.operation !== 'project.register' &&
          !isSettingsEnvelope(envelope)
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

        // F-009：配置命令的能力兼容复检与一致性视图（全局快照）在写事务之外、
        // 仅对新命令执行；推导出的 consistency.globalRevision 随写入在同一事务内核对。
        let settingsPlan: SettingsWritePlan | undefined;
        if (isSettingsEnvelope(envelope) && existing === undefined) {
          settingsPlan = prepareSettingsWrite(envelope);
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
          if (isSettingsEnvelope(envelope)) {
            // 新配置命令必定已在事务外完成能力复检与一致性视图（重放已在上面返回）。
            if (settingsPlan === undefined) throw new TypeError('配置命令缺少事务外写入计划');
            return submitSettingsCommand(principal, envelope, digest, settingsPlan, transaction, now);
          }
          return submitMetadataUpdate(principal, envelope, digest, transaction, now);
        });
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },
  };
}
