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
import { createFeatureDeliveryCommandHandler, type FeatureDeliveryDependencies } from './feature-delivery-commands.js';
import {
  assertTrustedPrincipal,
  authorizeCommand,
  authorizeCommandReplay,
  mapProjectLookupError,
  requireProjectVisible,
} from '../ports/authorization.js';
import type { TrustedPrincipal } from '../ports/authorization.js';
import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
import { validateBaselineCancelPayload } from '../ports/baseline.js';
import type { BaselineOperationRecord } from '../ports/baseline-store.js';
import type { BaselineService } from './baseline-service.js';
import {
  PublicError,
  createCompletedReceipt,
  createRejectedReceipt,
  evaluateCommandTiming,
  mapStorageError,
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
import { isStorageError } from '../ports/errors.js';
import { PHASE_CREATED_EVENT_TYPE } from '../ports/plan-store.js';
import type { PhaseRecord } from '../ports/plan-store.js';
import {
  toPublicPhaseRecord,
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
import { submitExecutionPause } from './execution-pause.js';
import { submitExecutionCancel } from './execution-cancel.js';
import { submitExecutionStopManual } from './execution-stop-manual.js';
import { signalExecutionResumeAfterCommit } from './execution-resume.js';
import type { ExecutionResumePort } from '../ports/execution-resume.js';
import { FINALIZATION_RETRY_OPERATION } from '../ports/finalization-retry.js';
import type {
  FinalizationRetryExecutionPort,
  PreparedFinalizationRetry,
} from '../ports/finalization-retry.js';
import { signalFinalizationRetryAfterCommit } from './finalization-retry-execution.js';
import { submitTaskApprovalBlock, TASK_APPROVAL_BLOCK_OPERATION } from './task-approval-block.js';
import { submitTaskApprovalDecision, TASK_APPROVAL_DECISION_OPERATIONS } from './task-approval-decision.js';
import { submitTaskVerificationContinue, validateTaskVerificationContinue, TASK_VERIFICATION_CONTINUE_OPERATION, type TaskVerificationContinueDeps } from './task-verification-continue.js';
import { FEATURE_PLAN_DECIDE_OPERATION, submitFeaturePlanDecide } from './feature-plan-decide.js';
import { FEATURE_PLAN_IMPORT_OPERATION, submitFeaturePlanImport } from './feature-plan-import.js';
import {
  FEATURE_PLAN_REVISE_OPERATION,
  submitFeaturePlanRevise,
} from './feature-plan-revise.js';
import type { FeaturePlanReviseGuards } from './feature-plan-revise.js';
import { PLAN_LABELS_UPDATE_OPERATION, submitPlanLabelsUpdate } from './plan-labels-update.js';
import {
  EXECUTION_INPUT_PREPARE_OPERATION,
  submitExecutionInputPrepare,
} from './execution-input-prepare.js';
import type { ExecutionInputPreparePort } from './execution-input-prepare.js';
import type { PreparedExecutionInputGroup } from '../ports/execution-input-prepare.js';
import { EXECUTION_PREVIEW_OPERATION } from '../ports/execution-preview.js';
import type { ExecutionPreviewPort } from './execution-preview.js';
import type { ExecutionPreviewResult } from '../ports/execution-preview.js';
import { EXECUTION_START_OPERATION } from '../ports/execution-start.js';
import { PLANNING_START_OPERATION } from '../ports/planning-start.js';
import type { PlanningStartPort, PreparedPlanningStart } from '../ports/planning-start.js';
import { signalPlanningRunDispatchAfterCommit } from './planning-start.js';
import {
  computeWorkspaceDiscardRequestDigest,
  toWorkspaceDiscardStoreInput,
  validateWorkspaceDiscardConfirmInput,
  WORKSPACE_DISCARD_OPERATION,
  WORKSPACE_DISCARD_PREVIEW_OPERATION,
} from '../ports/workspace-discard.js';
import type {
  WorkspaceDiscardPreview,
} from '../ports/workspace-discard.js';
import type { WorkspaceDiscardService } from './workspace-discard.js';
import type {
  ExecutionDispatchSignalPort,
  ExecutionStartPort,
  PreparedExecutionStart,
} from '../ports/execution-start.js';
import { signalRunDispatchAfterCommit } from './execution-start.js';
import {
  EXECUTION_BUDGET_REVISE_OPERATION,
  submitExecutionBudgetRevise,
} from './execution-budget-revise.js';
import {
  TASK_STRATEGY_UPDATE_OPERATION,
  submitTaskStrategyUpdate,
} from './task-strategy-update.js';
import type { TaskStrategyEditGuards } from './task-strategy-update.js';

export interface DeliveryActivity {
  enterQuiesce(): { readonly accepted: number };
  awaitQuiesce(budgetMs: number): Promise<{ readonly confirmed: boolean; readonly pending: readonly string[] }>;
}

export interface CommandService {
  readonly deliveryActivity?: DeliveryActivity;
  submit(principal: unknown, envelope: unknown): Promise<CommandReceipt>;
}
/**
 * P02-3 / F-014：baseline.cancel 的取消执行端口（进程停止核验在事务外完成）。
 * 生产装配注入 BaselineExecutionService.cancel（组合根内晚绑定，避免与
 * CommandService 的构造环）；返回取消后的操作记录，回执在同一事务内持久化。
 */
export interface BaselineCancelPort {
  cancel(
    principal: TrustedPrincipal,
    projectId: string,
    operationId: string,
  ): Promise<BaselineOperationRecord>;
}
export interface CommandServiceOptions {
  /** Validation is synchronous in the receipt transaction; stop runs after commit. */
  readonly executionCancel?: {
    assertCancel(projectId: string, attemptId: string): import('../ports/work-resources.js').WorkResourceIdentity;
    cancel(identity: import('../ports/work-resources.js').WorkResourceIdentity): Promise<unknown>;
  };
  /**
   * P03-9 / F-003：Run/Batch 取消提交后的停止控制（事务外、best-effort）。
   * 不传时保持 F-002 的意图/持久 operation 语义，不冒充已停止。
   */
  readonly executionStopControl?: import('../ports/execution-stop.js').ExecutionStopControlPort;
  readonly atomicStore: AtomicCommandStore;
  /** F-008：project.register 的只读仓库检查（写事务之外调用；不传则注册命令 unsupported）。 */
  readonly repositoryInspector?: RepositoryInspector;
  /** F-009：配置命令的能力目录复检（可信装配注入；不传则配置命令 unsupported）。 */
  readonly capabilityCatalog?: RuntimeCapabilityCatalog;
  /** P02-3 / F-008：基线预览/授权用例（不传则基线命令 unsupported）。 */
  readonly baselineService?: BaselineService;
  /** P02-3 / F-014：baseline.cancel 的取消执行端口（不传则取消命令 unsupported）。 */
  readonly baselineCancel?: BaselineCancelPort;
  /**
   * P03-1 / F-008：实质计划修订守卫（受控测试装配注入活动执行输入探测；
   * 缺省为生产「无执行实体表」边界宣告，见 feature-plan-revise）。
   */
  readonly featurePlanReviseGuards?: FeaturePlanReviseGuards;
  /**
   * P03-2 / F-001：Task 策略编辑守卫（受控测试装配注入 Task 活动执行输入
   * 探测；缺省为生产「无执行实体表」边界宣告，见 task-strategy-update）。
   */
  readonly taskStrategyEditGuards?: TaskStrategyEditGuards;
  /**
   * P03-2 / F-006：执行输入制品组准备端口（事务外采集/组装/发布 + 同步权限
   * 读取；不传则命令 unsupported，不冒充能力）。装配者：composition 根；
   * 受控测试可直接注入窄端口实现。
   */
  readonly executionInputPrepare?: ExecutionInputPreparePort;
  /**
   * P03-3 / F-004：单 Feature 执行 prepare 预览端口（只读预览：事务外完成全部
   * I/O 与身份计算，命令短写事务内只持久化 completed 回执；不传则命令
   * unsupported，不冒充能力）。装配者：composition 根；受控测试可直接注入。
   */
  readonly executionPreview?: ExecutionPreviewPort;
  /**
   * P03-3 / F-005：显式执行启动端口（事务外有界输入核验与预览重算 + 短写事务
   * 内重核与原子提交；不传则命令 unsupported，不冒充能力）。装配者：
   * composition 根；受控测试可直接注入。
   */
  readonly executionStart?: ExecutionStartPort;
  /**
   * P05-1 / F-003：一次性规划启动端口（事务外请求/预算校验 + 短写事务内重核
   * 与原子提交 Batch/Run/planning Task/上下文/派发意图/事件/accepted v7 回执；
   * 不传则命令 unsupported，不冒充能力）。装配者：composition 根。
   */
  readonly planningStart?: PlanningStartPort;
  /**
   * P03-9 / F-008：显式工作流 resume 端口（事务外重新授权/现场核验 + 短写事务内
   * 重核解除暂停；不传则命令 unsupported，不冒充能力）。
   */
  readonly executionResume?: ExecutionResumePort;
  /**
   * P03-9 / F-010：finalization-only 重试端口（F-009 资格/范围 + 父 Batch 重开
   * 与 Run 名额扣减；事务外准备、短写事务内原子提交；不传则命令 unsupported）。
   */
  readonly finalizationRetry?: FinalizationRetryExecutionPort;
  /**
   * P03-3 / F-005：派发唤醒窄端口（仅写事务成功提交且非重放的新 Work accepted
   * 后 best-effort 调用；失败吞掉，持久 queued Run 是权威；不传则 Run 保留
   * queued + scheduler_not_assembled 可查询原因）。
   */
  readonly executionDispatchSignal?: ExecutionDispatchSignalPort;
  /**
   * P03-5 / F-011：人工丢弃预览/确认服务端口（不传则两个丢弃命令
   * unsupported，不冒充能力）。预览走通用命令事务（事务外只读检查与证据
   * 发布，事务内只持久化 completed 回执）；确认不经通用回执事务——存储在
   * begin 事务内以真实主体+commandId 持久化幂等锚点回执（请求摘要 =
   * computeWorkspaceDiscardRequestDigest），命令层重放预检同源比对。
   */
  readonly workspaceDiscard?: WorkspaceDiscardService;
  /**
   * F-012：人工批准后的授权显式验证继续依赖（同库只读 Attempt/批次访问 +
   * 生命周期内事务提交；不传则命令 unsupported，不冒充能力）。装配者：
   * composition 根；受控测试可直接注入窄端口实现。
   */
  readonly taskVerificationContinue?: TaskVerificationContinueDeps;
  readonly featureDelivery?: FeatureDeliveryDependencies;
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
  const baselineService = options.baselineService;
  const baselineCancel = options.baselineCancel;
  const featurePlanReviseGuards = options.featurePlanReviseGuards;
  const taskStrategyEditGuards = options.taskStrategyEditGuards;
  const executionInputPrepare = options.executionInputPrepare;
  const executionPreview = options.executionPreview;
  const executionStart = options.executionStart;
  const planningStart = options.planningStart;
  const executionResume = options.executionResume;
  const finalizationRetry = options.finalizationRetry;
  const executionDispatchSignal = options.executionDispatchSignal;
  const executionStopControl = options.executionStopControl;
  const workspaceDiscard = options.workspaceDiscard;
  const taskVerificationContinue = options.taskVerificationContinue;
  const nowUtcMs = options.nowUtcMs ?? Date.now;
  const delivery = options.featureDelivery === undefined ? undefined : createFeatureDeliveryCommandHandler({
    atomicStore: store, dependencies: options.featureDelivery, nowUtcMs,
  });

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
   * P03-1 / F-004：Phase 创建——父级项目把关 + open Phase + phase.created 脱敏
   * 事件 + completed 回执同一事务；重复业务 ID 在任何写入之前固化 rejected
   * （settings 首建 already_exists 同一纪律），不覆盖既有 Phase、不写事件。
   * 不执行仓库脚本、不创建执行实体；批准/执行结果不能经请求输入。
   */
  function submitPhaseCreate(
    principal: TrustedPrincipal,
    envelope: Extract<ValidatedCommandEnvelope, { operation: 'phase.create' }>,
    digest: string,
    transaction: CommandTransaction,
    now: number,
  ): CommandReceipt {
    // 父级项目把关：不存在折算为与不可见相同的 forbidden，不泄漏存在性。
    try {
      transaction.getProject(envelope.scope.projectId);
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
    let phase: PhaseRecord;
    try {
      phase = transaction.insertPhase({
        ...(envelope.payload.id !== null ? { id: envelope.payload.id } : {}),
        projectId: envelope.scope.projectId,
        title: envelope.payload.title,
        description: envelope.payload.description,
        labels: envelope.payload.labels,
      });
    } catch (error) {
      // 重复业务 ID：插入原语在任何 SQL 写入之前决定（存在性检查/唯一兜底），
      // 按既有公开错误映射固化 rejected；写后异常不属于本分支，只回滚不吞成 rejected。
      if (isStorageError(error, 'conflict')) {
        const receipt = createRejectedReceipt({
          ...identity,
          error: mapStorageError(error, { operation: envelope.operation }),
        });
        transaction.saveReceipt(receipt);
        return receipt;
      }
      throw error;
    }
    transaction.appendPlanEvent({
      projectId: envelope.scope.projectId,
      eventType: PHASE_CREATED_EVENT_TYPE,
      aggregateType: 'phase',
      aggregateId: phase.id,
      aggregateRevision: phase.revision,
      payload: { created: true },
    });
    const receipt = createCompletedReceipt({
      ...identity,
      resultRef: createResultRef(randomBytes(32)),
      // 结果只携带提交时固化的 Phase 事实；不声称批准、可执行或执行结果。
      result: { phase: toPublicPhaseRecord(phase) },
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
    deliveryActivity: delivery?.activity,
    async submit(principal: unknown, input: unknown): Promise<CommandReceipt> {
      // 非法可信装配为编程错误，不折算客户端错误。
      assertTrustedPrincipal(principal);
      let operation = 'commands.submit';
      let continuationReplay: { commandId: string; digest: string } | undefined;
      try {
        const envelope = validateCommandEnvelope(input);
        operation = envelope.operation;
        authorizeCommand(principal, envelope);
        if (envelope.operation === 'feature.verification.continue' || envelope.operation === 'git.operation.reconcile') {
          const digest = computeCommandRequestDigest(envelope);
          if (delivery === undefined) {
            const receipt = store.transact(operation, transaction =>
              replay(principal, transaction.findReceipt(principal.principalId, envelope.commandId), digest, operation));
            if (receipt) return receipt;
            checkTiming(envelope, nowUtcMs());
            throw new PublicError('unsupported', operation);
          }
          return await delivery.submit(principal, envelope, digest);
        }
        if (envelope.operation === 'project.register' && repositoryInspector === undefined) {
          throw new PublicError('unsupported', operation);
        }
        if (isSettingsEnvelope(envelope) && capabilityCatalog === undefined) {
          throw new PublicError('unsupported', operation);
        }
        // P03-2 / F-001：Task 策略编辑的能力兼容校验复用可信目录；目录未装配
        // 时命令 unsupported（与配置命令同一纪律，不冒充能力）。
        if (envelope.operation === TASK_STRATEGY_UPDATE_OPERATION && capabilityCatalog === undefined) {
          throw new PublicError('unsupported', operation);
        }
        // P02-3 / F-014：baseline.cancel 已随取消/停止核验（F-010/F-012）进入白名单；
        // 取消执行端口缺席时仍 unsupported（不冒充能力）。
        if (
          (envelope.operation === 'baseline.preview' || envelope.operation === 'baseline.run') &&
          baselineService === undefined
        ) {
          throw new PublicError('unsupported', operation);
        }
        if (envelope.operation === 'execution.attempt.cancel' && options.executionCancel === undefined) {
          throw new PublicError('unsupported', operation);
        }
        if (envelope.operation === 'baseline.cancel' && baselineCancel === undefined) {
          throw new PublicError('unsupported', operation);
        }
        // P03-2 / F-006：执行输入准备端口缺席时 unsupported（与基线命令同一纪律；
        // 不冒充准备能力）。
        if (envelope.operation === EXECUTION_INPUT_PREPARE_OPERATION && executionInputPrepare === undefined) {
          throw new PublicError('unsupported', operation);
        }
        // P03-3 / F-004：执行预览端口缺席时 unsupported（与基线/准备命令同一纪律；
        // 不冒充预览能力）。
        if (envelope.operation === EXECUTION_PREVIEW_OPERATION && executionPreview === undefined) {
          throw new PublicError('unsupported', operation);
        }
        // P03-3 / F-005：执行启动端口缺席时 unsupported（不冒充启动能力；
        // 命令面能力位与预览共享授权面，端口装配是真实支持边界）。
        if (envelope.operation === EXECUTION_START_OPERATION && executionStart === undefined) {
          throw new PublicError('unsupported', operation);
        }
        // P05-1 / F-003：规划启动端口缺席时 unsupported（同一纪律，不冒充能力）。
        if (envelope.operation === PLANNING_START_OPERATION && planningStart === undefined) {
          throw new PublicError('unsupported', operation);
        }
        if (envelope.operation === 'execution.resume' && executionResume === undefined) {
          throw new PublicError('unsupported', operation);
        }
        if (envelope.operation === FINALIZATION_RETRY_OPERATION && finalizationRetry === undefined) {
          throw new PublicError('unsupported', operation);
        }
        // P03-5 / F-011：人工丢弃预览/确认服务端口缺席时 unsupported（不冒充
        // 能力；命令面能力位与预览/确认共享授权面，端口装配是真实支持边界）。
        if (
          (envelope.operation === WORKSPACE_DISCARD_OPERATION ||
            envelope.operation === WORKSPACE_DISCARD_PREVIEW_OPERATION) &&
          workspaceDiscard === undefined
        ) {
          throw new PublicError('unsupported', operation);
        }
        // F-012：显式验证继续依赖缺席时 unsupported（不冒充继续能力）。
        if (envelope.operation === TASK_VERIFICATION_CONTINUE_OPERATION && taskVerificationContinue === undefined) {
          throw new PublicError('unsupported', operation);
        }
        if (
          envelope.operation !== 'project.metadata.update' &&
          envelope.operation !== 'project.register' &&
          envelope.operation !== 'baseline.preview' &&
          envelope.operation !== 'baseline.run' &&
          envelope.operation !== 'execution.attempt.cancel' &&
          envelope.operation !== 'execution.stop.manual' &&
          envelope.operation !== 'execution.pause' &&
          envelope.operation !== 'execution.cancel' &&
          envelope.operation !== 'execution.resume' &&
          envelope.operation !== FINALIZATION_RETRY_OPERATION &&
          envelope.operation !== 'baseline.cancel' &&
          envelope.operation !== 'phase.create' &&
          envelope.operation !== FEATURE_PLAN_IMPORT_OPERATION &&
          envelope.operation !== PLAN_LABELS_UPDATE_OPERATION &&
          envelope.operation !== FEATURE_PLAN_REVISE_OPERATION &&
          envelope.operation !== TASK_STRATEGY_UPDATE_OPERATION &&
          envelope.operation !== FEATURE_PLAN_DECIDE_OPERATION &&
          envelope.operation !== TASK_APPROVAL_BLOCK_OPERATION &&
          !TASK_APPROVAL_DECISION_OPERATIONS.includes(envelope.operation as (typeof TASK_APPROVAL_DECISION_OPERATIONS)[number]) &&
          envelope.operation !== EXECUTION_INPUT_PREPARE_OPERATION &&
          envelope.operation !== EXECUTION_PREVIEW_OPERATION &&
          envelope.operation !== EXECUTION_START_OPERATION &&
          envelope.operation !== PLANNING_START_OPERATION &&
          envelope.operation !== EXECUTION_BUDGET_REVISE_OPERATION &&
          envelope.operation !== WORKSPACE_DISCARD_OPERATION &&
          envelope.operation !== WORKSPACE_DISCARD_PREVIEW_OPERATION &&
          envelope.operation !== TASK_VERIFICATION_CONTINUE_OPERATION &&
          !isSettingsEnvelope(envelope)
        ) {
          throw new PublicError('unsupported', operation);
        }
        const digest = computeCommandRequestDigest(envelope);
        if (envelope.operation === TASK_VERIFICATION_CONTINUE_OPERATION) {
          continuationReplay = { commandId: envelope.commandId, digest };
        }
        const existing = store.findReceipt(principal.principalId, envelope.commandId);
        // 预读只决定新命令的事务外时效拒绝；重放仍必须进入权威写事务重读。
        if (existing === undefined) {
          checkTiming(envelope, nowUtcMs());
        } else if (envelope.operation !== WORKSPACE_DISCARD_OPERATION) {
          // P03-5 / F-011：丢弃确认的用户回执由 F-010 存储以丢弃请求摘要锚定，
          // 不经通用回执事务；其重放预检走专属通道（见下方 confirm 分支）。
          replay(principal, existing, digest, operation);
        }

        let continuationStopEvidence: unknown;
        if (envelope.operation === TASK_VERIFICATION_CONTINUE_OPERATION && existing === undefined) {
          if (typeof taskVerificationContinue?.verifyCurrentEvidence !== 'function') {
            throw new PublicError('unsupported', operation);
          }
          options.atomicStore.transact('task.verification.continue.preflight', tx =>
            validateTaskVerificationContinue(envelope, tx, taskVerificationContinue!));
          continuationStopEvidence = await taskVerificationContinue.verifyCurrentEvidence(envelope);
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

        // P02-3 / F-008：基线命令的只读 I/O（Git/工作区/绑定读取/stale 原料）
        // 全部在写事务之外、仅对新命令执行；事务内只做摘要核对与原子写入。
        let baselinePreview: unknown;
        let baselinePrepared: import('./baseline-service.js').BaselineRunPrepared | undefined;
        if (envelope.operation === 'baseline.preview' && existing === undefined) {
          baselinePreview = await baselineService!.previewBaseline(
            principal,
            envelope.scope.projectId,
            envelope.payload,
          );
        }
        if (envelope.operation === 'baseline.run' && existing === undefined) {
          baselinePrepared = await baselineService!.prepareBaselineRun(
            principal,
            envelope.scope.projectId,
            envelope.payload,
          );
        }

        // P02-3 / F-014：baseline.cancel 的进程停止核验在写事务之外、仅对新命令
        // 执行（等待确认停止可能耗时）；取消结果随后在同一事务内核对重放并持久化
        // completed 回执。取消执行自身的拒绝（resource_busy 等）不写回执，与
        // baseline.run 提交冲突同一纪律。
        let baselineCanceled: BaselineOperationRecord | undefined;
        if (envelope.operation === 'baseline.cancel' && existing === undefined) {
          const payload = validateBaselineCancelPayload(envelope.payload);
          baselineCanceled = await baselineCancel!.cancel(
            principal,
            envelope.scope.projectId,
            payload.operationId,
          );
        }

        // P03-2 / F-006：执行输入准备的视图捕获/采集/组装/发布/正文复验全部在
        // 写事务之外、仅对新命令执行（外部 I/O 不在写事务内等待）；最终身份
        // 重核、脱敏事件与回执在同一短写事务内原子提交。
        let executionInputPrepared: PreparedExecutionInputGroup | undefined;
        if (envelope.operation === EXECUTION_INPUT_PREPARE_OPERATION && existing === undefined) {
          executionInputPrepared = await executionInputPrepare!.prepareExecutionInput(
            envelope.scope.projectId,
            envelope.payload,
          );
        }

        // P03-3 / F-004：执行预览为只读预览（授权与纯校验先于仓库/制品 I/O；
        // 不创建执行实体、不扣预算、不写业务事件）；事务外完成全部计算，
        // 命令短写事务内只持久化 completed 回执（与 baseline.preview 同一纪律）。
        let executionPreviewResult: ExecutionPreviewResult | undefined;
        if (envelope.operation === EXECUTION_PREVIEW_OPERATION && existing === undefined) {
          executionPreviewResult = await executionPreview!.previewExecution(
            envelope.scope.projectId,
            envelope.payload,
          );
        }

        // P03-3 / F-005：显式执行启动的事务外准备（预算深校验 + 范围形态 +
        // 只读预览重算；全部仓库/制品 I/O 在写事务之外、仅对新命令执行）；
        // 短写事务内重核前置条件并原子提交 Batch/Run/事件/回执。
        let executionStartPrepared: PreparedExecutionStart | undefined;
        if (envelope.operation === EXECUTION_START_OPERATION && existing === undefined) {
          executionStartPrepared = await executionStart!.prepareExecutionStart(
            envelope.scope.projectId,
            envelope.payload,
          );
        }

        // P05-1 / F-003：一次性规划启动的事务外准备（请求/预算纯校验；无仓库/
        // 模型 I/O，仅对新命令执行）；短写事务内重核并原子提交 Batch/Run/
        // planning Task/上下文/派发意图/事件/回执。
        let planningStartPrepared: PreparedPlanningStart | undefined;
        if (envelope.operation === PLANNING_START_OPERATION && existing === undefined) {
          planningStartPrepared = await planningStart!.preparePlanningStart(
            envelope.scope.projectId,
            envelope.payload,
          );
        }

        // P03-9 / F-008：显式 resume 的事务外重新授权/现场核验（全部只读 I/O 在
        // 写事务之外），事务内只重核身份并解除暂停。
        let executionResumePrepared: import('../ports/execution-resume.js').PreparedExecutionResume | undefined;
        if (envelope.operation === 'execution.resume' && existing === undefined) {
          executionResumePrepared = await executionResume!.prepareExecutionResume(
            envelope.scope.projectId,
            envelope.payload,
          );
        }
        // P03-9 / F-010：retryFinal 先复用 F-009 只读资格/scope，再核验父 Batch
        // 可继续性与预算；全部证据判定失败都只返回 rejected，不创建 Run。
        let finalizationRetryPrepared: PreparedFinalizationRetry | undefined;
        if (envelope.operation === FINALIZATION_RETRY_OPERATION && existing === undefined) {
          finalizationRetryPrepared = await finalizationRetry!.prepareExecutionRetryFinal(
            envelope.scope.projectId,
            envelope.payload,
          );
        }

        // P03-5 / F-011：人工丢弃预览为只读检查 + 不可变证据发布（事务外、
        // 仅对新命令执行）；命令短写事务内只持久化 completed 回执（与
        // execution.preview 同一纪律）。payload 深校验（featureId）在服务内。
        let workspaceDiscardPreviewResult: WorkspaceDiscardPreview | undefined;
        if (envelope.operation === WORKSPACE_DISCARD_PREVIEW_OPERATION && existing === undefined) {
          const payloadKeys = Object.keys(envelope.payload as Record<string, unknown>);
          if (payloadKeys.some(key => key !== 'featureId')) {
            throw new PublicError('invalid_input', operation, undefined, {
              details: { field: 'payload', reason: 'unknown_keys' },
            });
          }
          workspaceDiscardPreviewResult = await workspaceDiscard!.preview({
            principal,
            projectId: envelope.scope.projectId,
            featureId: (envelope.payload as Record<string, unknown>).featureId,
          });
        }

        // P03-5 / F-011：人工丢弃确认不经通用回执事务——F-010 存储在 begin
        // 事务内以真实主体+commandId 持久化幂等锚点回执（请求摘要为丢弃输入
        // 摘要）；命令层负责重放预检（能力/归属重核 + 同源摘要比对）与时效。
        if (envelope.operation === WORKSPACE_DISCARD_OPERATION) {
          const confirmInput = validateWorkspaceDiscardConfirmInput({
            ...(envelope.payload as Record<string, unknown>),
            principal,
            commandId: envelope.commandId,
            projectId: envelope.scope.projectId,
          });
          const storeInput = toWorkspaceDiscardStoreInput(confirmInput);
          if (existing !== undefined) {
            authorizeCommandReplay(principal, existing, registrationProjectIdOf(existing, operation), operation);
            if (existing.requestDigest !== computeWorkspaceDiscardRequestDigest(storeInput)) {
              throw new PublicError('conflict', operation, undefined, {
                details: { reason: 'command_reused' },
              });
            }
            // 意图回执不代表操作终态：交回服务恢复 pending，终态由 store.begin 幂等返回。
          }
          await workspaceDiscard!.confirm(confirmInput);
          const persisted = store.findReceipt(principal.principalId, envelope.commandId);
          if (persisted === undefined) {
            throw new TypeError('丢弃确认已提交但用户回执不可读（存储装配错误）');
          }
          return existing === undefined ? persisted : { ...persisted, replayed: true };
        }

        let cancelIdentity: import('../ports/work-resources.js').WorkResourceIdentity | undefined;
        let stopRequest: import('../ports/execution-stop.js').ExecutionStopRequest | undefined;
        let manualProbeRequest: import('../ports/execution-stop.js').ExecutionStopRequest | undefined;
        const receipt = store.transact(operation, transaction => {
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
          if (envelope.operation === 'execution.attempt.cancel') {
            cancelIdentity = options.executionCancel!.assertCancel(envelope.scope.projectId, envelope.payload.attemptId);
            const receipt = createCompletedReceipt({ principalId: principal.principalId, commandId: envelope.commandId,
              operation: envelope.operation, scope: envelope.scope, requestDigest: digest, issuedAt: envelope.issuedAt,
              completedAt: new Date(now).toISOString(), resultRef: createResultRef(randomBytes(32)),
              result: { attemptId: envelope.payload.attemptId, cancellationRequested: true } });
            transaction.saveReceipt(receipt);
            return receipt;
          }
          if (envelope.operation === 'execution.pause') {
            // P03-9 / F-001：目标归属/revision CAS/暂停意图/状态/事件/回执同一短事务。
            return submitExecutionPause(
              {
                principalId: principal.principalId,
                commandId: envelope.commandId,
                operation: envelope.operation,
                scope: envelope.scope,
                requestDigest: digest,
                issuedAt: envelope.issuedAt,
                completedAt: new Date(now).toISOString(),
              },
              envelope,
              transaction,
            );
          }
          if (envelope.operation === 'execution.resume') {
            if (executionResumePrepared === undefined) throw new TypeError('resume 缺少事务外准备结果');
            return executionResume!.submitExecutionResume(
              {
                principalId: principal.principalId,
                commandId: envelope.commandId,
                scope: envelope.scope,
                requestDigest: digest,
                issuedAt: envelope.issuedAt,
              },
              envelope,
              transaction,
              executionResumePrepared,
            );
          }
          if (envelope.operation === FINALIZATION_RETRY_OPERATION) {
            if (finalizationRetryPrepared === undefined) {
              throw new TypeError('retryFinal 缺少事务外准备结果');
            }
            return finalizationRetry!.submitExecutionRetryFinal(
              {
                principalId: principal.principalId,
                commandId: envelope.commandId,
                scope: envelope.scope,
                requestDigest: digest,
                issuedAt: envelope.issuedAt,
              },
              envelope,
              transaction,
              finalizationRetryPrepared,
            );
          }
          if (envelope.operation === 'execution.stop.manual') {
            const receipt = submitExecutionStopManual(
              {
                principalId: principal.principalId,
                commandId: envelope.commandId,
                operation: envelope.operation,
                scope: envelope.scope,
                requestDigest: digest,
                issuedAt: envelope.issuedAt,
                completedAt: new Date(now).toISOString(),
              },
              envelope,
              transaction,
            );
            if (envelope.payload.action === 'retry_probe' && receipt.status === 'completed' &&
                'result' in receipt && executionStopControl !== undefined) {
              const result = receipt.result as Record<string, unknown>;
              if (typeof result.operationId === 'string') {
                manualProbeRequest = {
                  projectId: envelope.scope.projectId,
                  stopOperationId: result.operationId,
                };
              }
            }
            return receipt;
          }
          if (envelope.operation === 'execution.cancel') {
            // P03-9 / F-002：取消意图/持久停止 operation/状态/事件/回执同一短事务。
            const receipt = submitExecutionCancel(
              {
                principalId: principal.principalId,
                commandId: envelope.commandId,
                operation: envelope.operation,
                scope: envelope.scope,
                requestDigest: digest,
                issuedAt: envelope.issuedAt,
                completedAt: new Date(now).toISOString(),
              },
              envelope,
              transaction,
            );
            // P03-9 / F-003：仅新的 stopping operation 进入事务外停止控制；已终态
            // 或已 uncertain 的 operation 不重放停止/不冒充停止。
            if (receipt.status === 'completed' && 'result' in receipt && executionStopControl !== undefined) {
              const result = receipt.result as Record<string, unknown>;
              if (result.stopStatus === 'stopping' && typeof result.stopOperationId === 'string') {
                stopRequest = { projectId: envelope.scope.projectId, stopOperationId: result.stopOperationId };
              }
            }
            return receipt;
          }
          if (envelope.operation === 'baseline.preview') {
            // 只读预览：事务外已完成全部 I/O；事务内只持久化 completed 回执。
            if (baselinePreview === undefined) {
              throw new TypeError('基线预览缺少事务外准备结果');
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
              result: baselinePreview,
            });
            transaction.saveReceipt(receipt);
            return receipt;
          }
          if (envelope.operation === 'baseline.run') {
            // 授权提交：stale 核对 + 授权/操作/种子/占用/事件/回执同一事务。
            if (baselinePrepared === undefined) {
              throw new TypeError('基线运行缺少事务外准备结果');
            }
            return baselineService!.submitBaselineRun(
              transaction,
              {
                principalId: principal.principalId,
                commandId: envelope.commandId,
                scope: envelope.scope,
                requestDigest: digest,
                issuedAt: envelope.issuedAt,
              },
              baselinePrepared,
            );
          }
          if (envelope.operation === 'baseline.cancel') {
            // 取消已在新命令路径完成并确认停止；事务内只重核重放并持久化回执。
            if (baselineCanceled === undefined) {
              throw new TypeError('基线取消缺少事务外执行结果');
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
                operationId: baselineCanceled.id,
                status: baselineCanceled.status,
                ...(baselineCanceled.reasonCode !== null
                  ? { reasonCode: baselineCanceled.reasonCode }
                  : {}),
              },
            });
            transaction.saveReceipt(receipt);
            return receipt;
          }
          if (envelope.operation === 'phase.create') {
            // P03-1 / F-004：Phase 创建无事务外 I/O；项目把关/业务/事件/回执同一事务。
            return submitPhaseCreate(principal, envelope, digest, transaction, now);
          }
          if (envelope.operation === FEATURE_PLAN_IMPORT_OPERATION) {
            // P03-1 / F-005：计划导入无事务外 I/O（引用仅索引级身份重核）；
            // 归属/CAS/引用/配置重核与 Feature/Task/边/事件/回执同一事务。
            return submitFeaturePlanImport(
              {
                principalId: principal.principalId,
                commandId: envelope.commandId,
                operation: envelope.operation,
                scope: envelope.scope,
                requestDigest: digest,
                issuedAt: envelope.issuedAt,
                completedAt: new Date(now).toISOString(),
              },
              envelope,
              transaction,
            );
          }
          if (envelope.operation === PLAN_LABELS_UPDATE_OPERATION) {
            // P03-1 / F-007：纯标签 CAS 编辑无事务外 I/O；项目把关/归属/标签 CAS
            // 更新/脱敏事件/回执同一事务。
            return submitPlanLabelsUpdate(
              {
                principalId: principal.principalId,
                commandId: envelope.commandId,
                operation: envelope.operation,
                scope: envelope.scope,
                requestDigest: digest,
                issuedAt: envelope.issuedAt,
                completedAt: new Date(now).toISOString(),
              },
              envelope,
              transaction,
            );
          }
          if (envelope.operation === FEATURE_PLAN_REVISE_OPERATION) {
            // P03-1 / F-008：实质计划修订无事务外 I/O；项目把关/草稿可编辑性/
            // 活动执行输入保护/聚合 CAS/引用与策略重核/整体替换/脱敏事件/
            // 回执同一事务。
            return submitFeaturePlanRevise(
              {
                principalId: principal.principalId,
                commandId: envelope.commandId,
                operation: envelope.operation,
                scope: envelope.scope,
                requestDigest: digest,
                issuedAt: envelope.issuedAt,
                completedAt: new Date(now).toISOString(),
              },
              envelope,
              transaction,
              featurePlanReviseGuards,
            );
          }
          if (envelope.operation === TASK_STRATEGY_UPDATE_OPERATION) {
            // P03-2 / F-001：Task 策略副本 CAS 编辑无事务外 I/O；项目把关/
            // 活动执行输入保护/Task CAS/策略语义与能力兼容重核/副本替换/
            // 脱敏事件/回执同一事务。
            return submitTaskStrategyUpdate(
              {
                principalId: principal.principalId,
                commandId: envelope.commandId,
                operation: envelope.operation,
                scope: envelope.scope,
                requestDigest: digest,
                issuedAt: envelope.issuedAt,
                completedAt: new Date(now).toISOString(),
              },
              envelope,
              transaction,
              {
                capabilityCatalog: capabilityCatalog!,
                ...(taskStrategyEditGuards !== undefined ? { guards: taskStrategyEditGuards } : {}),
              },
            );
          }
          if (envelope.operation === TASK_APPROVAL_BLOCK_OPERATION) {
            return submitTaskApprovalBlock({ principalId: principal.principalId, commandId: envelope.commandId,
              operation: envelope.operation, scope: envelope.scope, requestDigest: digest, issuedAt: envelope.issuedAt,
              completedAt: new Date(now).toISOString() }, envelope, transaction);
          }
          if (envelope.operation === 'task.approval.approve' || envelope.operation === 'task.approval.reject' || envelope.operation === 'task.approval.unblock') {
            return submitTaskApprovalDecision({ principalId: principal.principalId, capabilities: principal.capabilities, commandId: envelope.commandId,
              operation: envelope.operation, scope: envelope.scope, requestDigest: digest, issuedAt: envelope.issuedAt,
              completedAt: new Date(now).toISOString() }, envelope, transaction);
          }
          if (envelope.operation === TASK_VERIFICATION_CONTINUE_OPERATION) {
            // 现场和证据 I/O 已在事务外完成；此处重核身份、批准与 CAS。
            return submitTaskVerificationContinue({ principalId: principal.principalId, capabilities: principal.capabilities,
              commandId: envelope.commandId, operation: envelope.operation, scope: envelope.scope,
              requestDigest: digest, issuedAt: envelope.issuedAt, completedAt: new Date(now).toISOString() },
              envelope, transaction, taskVerificationContinue!, continuationStopEvidence ?? undefined);
          }
          if (envelope.operation === FEATURE_PLAN_DECIDE_OPERATION) {
            // P03-2 / F-002：计划批准/拒绝决策无事务外 I/O（无 Runtime/Git/检查
            // 进程）；项目把关/摘要绑定/空任务/重复决策/聚合 CAS 重核、决策
            // 记录、plan_status 更新、脱敏事件与回执同一短写事务。
            return submitFeaturePlanDecide(
              {
                principalId: principal.principalId,
                commandId: envelope.commandId,
                operation: envelope.operation,
                scope: envelope.scope,
                requestDigest: digest,
                issuedAt: envelope.issuedAt,
                completedAt: new Date(now).toISOString(),
              },
              envelope,
              transaction,
              now,
            );
          }
          if (envelope.operation === EXECUTION_INPUT_PREPARE_OPERATION) {
            // P03-2 / F-006：执行输入准备的事务外 I/O（视图捕获/采集/组装/发布/
            // 正文复验）已在上面完成；本事务内只做身份重核、脱敏事件与回执的
            // 原子提交（外部 I/O 不在写事务内等待）。
            if (executionInputPrepared === undefined) {
              throw new TypeError('执行输入准备缺少事务外准备结果');
            }
            return submitExecutionInputPrepare(
              {
                principalId: principal.principalId,
                commandId: envelope.commandId,
                operation: envelope.operation,
                scope: envelope.scope,
                requestDigest: digest,
                issuedAt: envelope.issuedAt,
                completedAt: new Date(now).toISOString(),
              },
              envelope,
              transaction,
              executionInputPrepared,
              executionInputPrepare!,
            );
          }
          if (envelope.operation === EXECUTION_PREVIEW_OPERATION) {
            // 只读预览：事务外已完成全部 I/O 与身份计算；事务内只持久化
            // completed 回执（零执行实体、零预算变更、零业务事件）。
            if (executionPreviewResult === undefined) {
              throw new TypeError('执行预览缺少事务外准备结果');
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
              result: executionPreviewResult,
            });
            transaction.saveReceipt(receipt);
            return receipt;
          }
          if (envelope.operation === EXECUTION_START_OPERATION) {
            // P03-3 / F-005：显式执行启动——事务外准备（预览重算/仓库 I/O）已在
            // 上面完成；本事务内重核全部前置条件并原子提交 Batch/Run/初始预算
            // 修订行/脱敏事件与 Work accepted v6 回执（任一失败整组回滚）。
            if (executionStartPrepared === undefined) {
              throw new TypeError('执行启动缺少事务外准备结果');
            }
            return executionStart!.submitExecutionStart(
              {
                principalId: principal.principalId,
                commandId: envelope.commandId,
                scope: envelope.scope,
                requestDigest: digest,
                issuedAt: envelope.issuedAt,
              },
              envelope,
              transaction,
              executionStartPrepared,
              { schedulerAssembled: executionDispatchSignal !== undefined },
            );
          }
          if (envelope.operation === PLANNING_START_OPERATION) {
            // P05-1 / F-003：一次性规划启动——事务外请求/预算校验已完成；本事务
            // 内重核全部前置条件并原子提交单 Feature Batch/purpose=plan Run/
            // planning Task/上下文/初始预算行/派发意图/事件与 accepted v7 回执
            // （任一失败整组回滚）。
            if (planningStartPrepared === undefined) {
              throw new TypeError('规划启动缺少事务外准备结果');
            }
            return planningStart!.submitPlanningStart(
              {
                principalId: principal.principalId,
                commandId: envelope.commandId,
                scope: envelope.scope,
                requestDigest: digest,
                issuedAt: envelope.issuedAt,
              },
              envelope,
              transaction,
              planningStartPrepared,
              { schedulerAssembled: executionDispatchSignal !== undefined },
            );
          }
          if (envelope.operation === EXECUTION_BUDGET_REVISE_OPERATION) {
            // P03-3 / F-009：批次预算显式修订——无事务外 I/O；项目把关/预算深
            // 校验/CAS/单调判定/原子写入（当前预算+不可变修订行）/脱敏事件与
            // completed 回执同一短写事务（任一失败整组回滚；仅增额不自动
            // 启动或恢复 Run）。
            return submitExecutionBudgetRevise(
              {
                principalId: principal.principalId,
                commandId: envelope.commandId,
                operation: envelope.operation,
                scope: envelope.scope,
                requestDigest: digest,
                issuedAt: envelope.issuedAt,
                completedAt: new Date(now).toISOString(),
              },
              envelope,
              transaction,
              now,
            );
          }
          if (envelope.operation === WORKSPACE_DISCARD_PREVIEW_OPERATION) {
            // P03-5 / F-011：只读预览——事务外已完成检查与证据发布；事务内只
            // 持久化 completed 回执（零工作区变更、零事件、零预算）。
            if (workspaceDiscardPreviewResult === undefined) {
              throw new TypeError('丢弃预览缺少事务外准备结果');
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
              result: workspaceDiscardPreviewResult,
            });
            transaction.saveReceipt(receipt);
            return receipt;
          }
          if (isSettingsEnvelope(envelope)) {
            // 新配置命令必定已在事务外完成能力复检与一致性视图（重放已在上面返回）。
            if (settingsPlan === undefined) throw new TypeError('配置命令缺少事务外写入计划');
            return submitSettingsCommand(principal, envelope, digest, settingsPlan, transaction, now);
          }
          return submitMetadataUpdate(principal, envelope as Extract<ValidatedCommandEnvelope, { operation: 'project.metadata.update' }>, digest, transaction, now);
        });
        // P03-3 / F-005：提交后唤醒——仅写事务成功提交且非重放的新 Work accepted
        // 时经窄端口 best-effort 发信号（事务失败在上方抛出，不会到达这里；
        // 唤醒失败吞掉，持久 queued Run 是权威，不重复创建 Run）。
        if (envelope.operation === EXECUTION_START_OPERATION) {
          signalRunDispatchAfterCommit(
            executionDispatchSignal,
            receipt,
            envelope.payload.featureIds[0] ?? '',
          );
        }
        // P05-1 / F-003：规划启动提交后 best-effort 唤醒（仅新回执；重放不重复
        // 通知；持久 queued Run 仍是权威）。
        if (envelope.operation === PLANNING_START_OPERATION) {
          signalPlanningRunDispatchAfterCommit(
            executionDispatchSignal,
            receipt,
            envelope.payload.request.featureId,
          );
        }
        // P03-9 / F-008：显式 resume 提交后只对新回执发出调度唤醒；approval 缺失
        // 步骤不唤醒调度器，replay 也不重复唤醒。
        if (envelope.operation === 'execution.resume') {
          signalExecutionResumeAfterCommit(executionDispatchSignal, receipt);
        }
        // P03-9 / F-010：新 finalization Run 提交后 best-effort 唤醒调度；replay
        // 不重复通知，持久 queued Run 仍是权威。
        if (envelope.operation === FINALIZATION_RETRY_OPERATION) {
          signalFinalizationRetryAfterCommit(executionDispatchSignal, receipt);
        }
        // Persist the authorization/receipt before touching the Runtime. Replays never
        // resubmit cancellation, even if the HTTP response was lost.
        if (cancelIdentity) void options.executionCancel!.cancel(cancelIdentity).catch(() => undefined);
        if (manualProbeRequest) void executionStopControl!.stop(manualProbeRequest).catch(() => undefined);
        // P03-9 / F-003：停止控制在回执提交后运行；失败不回滚已持久化的取消意图。
        if (stopRequest) void executionStopControl!.stop(stopRequest).catch(() => undefined);
        return receipt;
      } catch (error) {
        // A transport retry can finish its Git preflight after the original
        // request commits. The durable receipt wins over that stale CAS error.
        if (continuationReplay !== undefined) {
          const original = replay(principal, store.findReceipt(principal.principalId, continuationReplay.commandId),
            continuationReplay.digest, operation);
          if (original !== undefined) return original;
        }
        throw mapToPublicError(error, { operation });
      }
    },
  };
}
