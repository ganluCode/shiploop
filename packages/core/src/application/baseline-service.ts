/**
 * F-008（P02-3）BaselineService（application 层）：Core 基线预览与明确授权
 * 用例（docs/p02-3-onboarding-contract.md §5.3/§5.5/§6/§8.3/§9.2）。
 *
 * 不变量：
 * - 只依赖 ports 窄接口（RepositoryInspector / BaselineWorkspaceReader /
 *   BaselineEnvironmentDirectory / StateStore 只读子集 / CommandTransaction
 *   事务原语）；不接触适配器、驱动、HTTP 或 Pi SDK；Core 不直接 spawn 进程
 *   （执行域属 F-009/F-012 的 Host 侧装配）；
 * - 授权在 Core 应用层执行：baseline.run 能力 + 目标项目可见先于任何 Git/文件
 *   I/O（§4.3 不变量 1）；payload 深校验先于 I/O 与事务（非法输入零副作用）；
 * - 预览只读：不写任何行、不发事件、不执行脚本/安装、不改写 argv（未知脚本
 *   /缺命令按明确契约警示）；工作区摘要覆盖 tracked+untracked 受管内容并记录
 *   冻结排除表，不假装只检查 commit；
 * - 核验三件套：绑定身份（repoIdentity 与持久绑定一致，防同路径换仓）、cwd
 *   realpath 范围（逃逸/缺失拒绝）、环境引用（只解析获准引用，仅变量名，
 *   永不接触环境值/凭据；最小默认环境 = PATH）；
 * - 授权绑定完整输入摘要：previewDigest = sha256({plan, codeIdentity})，计划
 *   （argv/cwd 引用/环境引用/timeout/required）或代码身份任一实质变化都使旧
 *   授权失效（preview_stale）；用户决定只有 authorize/decline 二值，不存在
 *   客户端自声明 approved 字段；
 * - baseline.run 提交（F-007 单 BEGIN IMMEDIATE）：authorize = 授权行（不可变）
 *   + accepted 操作行 + 获准输入种子 + 全局占用 + baseline.authorized 事件 +
 *   accepted 回执（同一事务原子生效；启动次数为零——执行域尚未接线）；
 *   decline = not_run 操作行 + authorization_rejected + completed 回执（零种子
 *   /零占用/零事件）；stale = 持久 rejected 回执（零业务行）；另一在途操作 →
 *   resource_busy baseline_in_progress（零持久副作用）；
 * - 时间为注入时钟；principal 由可信装配显式传入，绝不由请求数据构造。
 */
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import {
  assertTrustedPrincipal,
  authorizeBaselineCommand,
  mapProjectLookupError,
} from '../ports/authorization.js';
import type { TrustedPrincipal } from '../ports/authorization.js';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import {
  PublicError,
  createAcceptedReceipt,
  createCompletedReceipt,
  createRejectedReceipt,
  mapToPublicError,
  RECEIPT_RESULT_MAX_BYTES,
} from '../ports/commands.js';
import type { CommandReceipt, CommandScope } from '../ports/commands.js';
import { createResultRef, stableCanonicalJson } from '../ports/command-receipts.js';
import { isStorageError } from '../ports/errors.js';
import { BASELINE_AUTHORIZED_EVENT_TYPE } from '../ports/events.js';
import {
  computeBaselinePlanDigest,
  computeBaselinePreviewDigest,
  normalizeBaselineAllowedVariables,
  validateBaselinePreviewPayload,
  validateBaselineRunPayload,
  type BaselineCheckPlan,
  type BaselineCodeIdentity,
  type BaselineDirtyScope,
  type BaselineEnvironmentDirectory,
  type BaselineEnvironmentIdentity,
  type BaselinePreviewCheckView,
  type BaselinePreviewResult,
  type BaselinePreviewWarning,
  type BaselineWorkspaceReader,
  type BaselineWorkspaceSummary,
} from '../ports/baseline.js';
import type { RepositoryInspector } from '../ports/repository-inspector.js';
import type { RepositoryInspection } from '../ports/repository-inspector.js';
import type { StateStore } from '../ports/state-store.js';
import { validateStableId } from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';

const PREVIEW_OPERATION = 'baseline.preview';
const RUN_OPERATION = 'baseline.run';
const SHELL_METACHARACTER_PATTERN = /(?:&&|\|\||;|>>|<|\|)/;
const RELATIVE_SCRIPT_PATTERN = /^\.\//;

/** 命令服务传入的回执身份（§5.3 公共字段；信封/摘要/时效已核验）。 */
export interface BaselineCommandIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly scope: CommandScope;
  readonly requestDigest: string;
  readonly issuedAt: string;
}

/** baseline.run 事务外准备结果（I/O 已完成；提交时在同一事务内核对摘要）。 */
export interface BaselineRunPrepared {
  readonly projectId: string;
  readonly decision: 'authorize' | 'decline';
  readonly plan: BaselineCheckPlan;
  readonly planDigest: string;
  readonly claimedPreviewDigest: string;
  readonly codeIdentity: BaselineCodeIdentity;
  readonly repositoryBindingId: string;
  readonly bindingRevision: number;
  readonly bindingRecordRevision: number;
  readonly dirtyScope: BaselineDirtyScope;
  readonly environmentIdentity: BaselineEnvironmentIdentity;
}

export interface BaselineService {
  /** baseline.preview：只读预览（§6；结构化拒绝抛 PublicError，零副作用）。 */
  previewBaseline(
    principal: unknown,
    projectId: unknown,
    payload: unknown,
  ): Promise<BaselinePreviewResult>;
  /** baseline.run 事务外准备：校验 + 核验 + 当前代码身份（I/O 在写事务外）。 */
  prepareBaselineRun(
    principal: unknown,
    projectId: unknown,
    payload: unknown,
  ): Promise<BaselineRunPrepared>;
  /** baseline.run 事务内提交：stale 核对 + 授权/操作/种子/占用/事件/回执。 */
  submitBaselineRun(
    transaction: CommandTransaction,
    identity: BaselineCommandIdentity,
    prepared: BaselineRunPrepared,
  ): CommandReceipt;
}

export interface BaselineServiceOptions {
  readonly repositoryInspector: RepositoryInspector;
  readonly workspaceReader: BaselineWorkspaceReader;
  readonly environmentDirectory: BaselineEnvironmentDirectory;
  readonly stateStore: Pick<StateStore, 'getProject' | 'getRepositoryBinding'>;
  readonly nowUtcMs?: () => number;
}

function requirePort(value: unknown, field: string, method: string): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as Record<string, unknown>)[method] !== 'function'
  ) {
    throw new TypeError(`createBaselineService: ${field} 必须提供 ${method} 方法（可信装配编程错误）`);
  }
}

function invalidCheckPlan(operation: string, field: string, reason = 'invalid_check_plan'): never {
  throw new PublicError('invalid_input', operation, undefined, {
    details: { field, reason },
  });
}

export function createBaselineService(options: BaselineServiceOptions): BaselineService {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createBaselineService: options 必须是对象');
  }
  requirePort(options.repositoryInspector, 'repositoryInspector', 'inspect');
  requirePort(options.workspaceReader, 'workspaceReader', 'readWorkspaceSummary');
  requirePort(options.workspaceReader, 'workspaceReader', 'resolveContainedCwd');
  requirePort(options.workspaceReader, 'workspaceReader', 'probeRelativeTarget');
  if (
    options.environmentDirectory === null ||
    typeof options.environmentDirectory !== 'object' ||
    typeof options.environmentDirectory.resolveEnvironmentRef !== 'function'
  ) {
    throw new TypeError(
      'createBaselineService: environmentDirectory 必须提供 resolveEnvironmentRef 方法',
    );
  }
  requirePort(options.stateStore, 'stateStore', 'getProject');
  requirePort(options.stateStore, 'stateStore', 'getRepositoryBinding');
  const { repositoryInspector, workspaceReader, environmentDirectory, stateStore } = options;
  const nowUtcMs = options.nowUtcMs ?? Date.now;

  function dirtyScopeFor(codeIdentity: BaselineCodeIdentity): BaselineDirtyScope {
    return {
      status: codeIdentity.hasUncommittedChanges ? 'unknown' : 'clean',
      explanation: codeIdentity.hasUncommittedChanges
        ? '工作区摘要确认存在未提交变化；逐路径范围由受管摘要保留，当前接口未暴露原始路径。'
        : '工作区摘要确认没有未提交变化。',
    };
  }

  function previewContext(
    repositoryBindingId: string,
    bindingRevision: number,
    bindingRecordRevision: number,
    codeIdentity: BaselineCodeIdentity,
    environmentIdentity: BaselineEnvironmentIdentity,
  ): import('../ports/baseline.js').BaselinePreviewContext {
    return {
      repositoryBindingId,
      repositoryBindingRevision: bindingRevision,
      bindingRecordRevision,
      dirtyScope: dirtyScopeFor(codeIdentity),
      environmentIdentity,
    };
  }

  function requireProjectId(projectId: unknown, operation: string): string {
    const context: ValidationContext = { operation, entity: { type: 'project' } };
    return validateStableId(projectId, context, 'projectId');
  }

  /** 载入目标项目与绑定；绑定身份（repoIdentity）与仓库现状核对。 */
  async function loadBindingContext(
    principal: TrustedPrincipal,
    projectId: string,
    operation: string,
  ): Promise<{ inspection: RepositoryInspection; repositoryBindingId: string; bindingRevision: number; bindingRecordRevision: number }> {
    authorizeBaselineCommand(principal, projectId, operation);
    let project;
    try {
      project = await stateStore.getProject(projectId);
    } catch (error) {
      // 未知/不可见统一 forbidden（不泄漏存在性）。
      mapProjectLookupError(error, operation);
    }
    let binding;
    try {
      binding = await stateStore.getRepositoryBinding(projectId);
    } catch (error) {
      if (isStorageError(error, 'not_found') && error.entity?.type === 'repository_binding') {
        // 已注册项目无仓库绑定：业务前置条件缺失（结构化拒绝，零副作用）。
        throw new PublicError('conflict', operation, undefined, {
          details: { reason: 'binding_missing', entityType: 'repository_binding' },
        });
      }
      mapProjectLookupError(error, operation);
    }
    // 只读仓库检查（Git 在写事务外）；检查失败由调用方映射为受控公开错误。
    const inspection = await repositoryInspector.inspect(binding.canonicalPath);
    if (inspection.repoIdentity !== binding.repoIdentity) {
      // 同规范路径下的仓库已被替换（repoIdentity 漂移）：拒绝以新仓库内容
      // 冒充既有绑定（防伪项目/换仓授权）。
      throw new PublicError('conflict', operation, undefined, {
        details: { reason: 'binding_identity_mismatch', entityType: 'repository_binding' },
      });
    }
    return { inspection, repositoryBindingId: binding.id, bindingRevision: binding.bindingRevision, bindingRecordRevision: binding.revision };
  }

  /** 环境引用核验：伪引用拒绝；只返回变量名（PATH + 获准允许列表）。 */
  function resolveAllowedVariables(
    operation: string,
    checkKey: string,
    environmentRef: string | undefined,
  ): readonly string[] {
    if (environmentRef === undefined) {
      return ['PATH'];
    }
    const allowlist = environmentDirectory.resolveEnvironmentRef(environmentRef);
    if (allowlist === null || allowlist === undefined) {
      invalidCheckPlan(operation, `plan.checks.${checkKey}.environmentRef`);
    }
    let extra: readonly string[];
    try {
      extra = normalizeBaselineAllowedVariables(allowlist);
    } catch (error) {
      throw new TypeError(
        `createBaselineService: 环境目录解析结果非法（可信装配编程错误）：${String(error)}`,
      );
    }
    return ['PATH', ...extra];
  }

  /** 环境目录只提供获准定义摘要；不读取 Host 环境值或运行项目脚本。 */
  function snapshotEnvironmentIdentity(plan: BaselineCheckPlan): BaselineEnvironmentIdentity {
    const refs = [...new Set(plan.checks.map((check) => check.environmentRef).filter((ref): ref is string => ref !== undefined))];
    const definitions = refs.map((environmentRef) => ({ environmentRef, definition: environmentDirectory.resolveEnvironmentRef(environmentRef) }));
    const allowedVariables = new Set<string>(['PATH']);
    const toolchain: Record<string, string | null> = {};
    const unknownFields: string[] = [];
    const coverage: string[] = ['PATH'];
    for (const { environmentRef, definition } of definitions) {
      if (definition === null || definition === undefined) {
        unknownFields.push(`environment:${environmentRef}`);
        continue;
      }
      for (const variable of normalizeBaselineAllowedVariables(definition)) allowedVariables.add(variable);
      coverage.push(`environmentRef:${environmentRef}`);
      for (const [name, version] of Object.entries(definition.toolchain ?? {})) {
        if (toolchain[name] !== undefined && toolchain[name] !== version) toolchain[name] = null;
        else toolchain[name] = version;
      }
      if (definition.definitionRevision === undefined) unknownFields.push(`environmentRevision:${environmentRef}`);
      for (const field of definition.unknownFields ?? []) unknownFields.push(field);
    }
    const revisions = definitions.map(({ definition }) => definition?.definitionRevision).filter((value): value is string => value !== undefined);
    const definitionRevision = refs.length === 1 ? (revisions[0] ?? null) : null;
    if (refs.length > 1 && new Set(revisions).size > 1) unknownFields.push('environmentRevision:multiple');
    return {
      schemaVersion: 1,
      environmentRef: refs.length === 1 ? refs[0]! : null,
      definitionRevision,
      toolchain,
      platform: { os: process.platform, arch: process.arch },
      allowedVariables: [...allowedVariables].sort(),
      coverage: [...new Set(coverage)].sort(),
      unknownFields: [...new Set(unknownFields)].sort(),
    };
  }

  /** 逐项核验：cwd realpath 范围 + 环境引用（预览视图与授权共用同一核验）。 */
  async function resolveChecks(
    operation: string,
    plan: BaselineCheckPlan,
    canonicalRoot: string,
  ): Promise<readonly BaselinePreviewCheckView[]> {
    const views: BaselinePreviewCheckView[] = [];
    for (const check of plan.checks) {
      const field = `plan.checks.${check.checkKey}`;
      const cwdResolution = await workspaceReader.resolveContainedCwd(
        canonicalRoot,
        check.cwdRef ?? null,
      );
      if (cwdResolution.status === 'outside') {
        throw new PublicError('invalid_input', operation, undefined, {
          details: { field: `${field}.cwdRef`, reason: 'path_outside_repository' },
        });
      }
      if (cwdResolution.status === 'missing') {
        invalidCheckPlan(operation, `${field}.cwdRef`);
      }
      views.push({
        checkKey: check.checkKey,
        kind: 'command',
        argv: [...check.argv],
        cwdRef: check.cwdRef ?? null,
        cwd: cwdResolution.canonicalPath,
        environmentRef: check.environmentRef ?? null,
        allowedVariables: resolveAllowedVariables(operation, check.checkKey, check.environmentRef),
        timeoutMs: check.timeoutMs,
        required: check.required,
      });
    }
    return views;
  }

  /**
   * 预览警示（§6.1 明确契约：不解释 shell 元字符、不改写 argv、不自动执行）：
   * - shell_metacharacters_in_argument：单参数含 shell 控制符形态（字面传递）；
   * - argv0_relative_script_missing：相对脚本在仓库内不存在（unknown_script
   *   风险的预览态提示；执行期由 F-012 记独立可查询 reason）；
   * - working_tree_dirty / no_initial_commit：当前工作区基线的明确确认事实
   *   （§15.3：脏工作区/无 HEAD 仍可运行，但必须明示）。
   */
  async function collectWarnings(
    operation: string,
    plan: BaselineCheckPlan,
    views: readonly BaselinePreviewCheckView[],
    canonicalRoot: string,
    codeIdentity: BaselineCodeIdentity,
  ): Promise<readonly BaselinePreviewWarning[]> {
    const warnings: BaselinePreviewWarning[] = [];
    for (const check of plan.checks) {
      for (const argument of check.argv) {
        if (SHELL_METACHARACTER_PATTERN.test(argument)) {
          warnings.push({ code: 'shell_metacharacters_in_argument', checkKey: check.checkKey });
          break;
        }
      }
      const argv0 = check.argv[0];
      if (RELATIVE_SCRIPT_PATTERN.test(argv0)) {
        const probe = await workspaceReader.probeRelativeTarget(
          canonicalRoot,
          check.cwdRef ?? null,
          argv0,
        );
        if (probe !== 'exists') {
          warnings.push({ code: 'argv0_relative_script_missing', checkKey: check.checkKey });
        }
      }
    }
    if (codeIdentity.hasUncommittedChanges) {
      warnings.push({ code: 'working_tree_dirty' });
    }
    if (codeIdentity.headCommit === null) {
      warnings.push({ code: 'no_initial_commit' });
    }
    return warnings;
  }

  /** 代码身份 + 工作区摘要（单次读取；§6.3：授权前重新核验当前事实）。 */
  async function computeCodeIdentity(
    inspection: RepositoryInspection,
  ): Promise<{ codeIdentity: BaselineCodeIdentity; workspace: BaselineWorkspaceSummary }> {
    const workspace = await workspaceReader.readWorkspaceSummary(inspection.canonicalPath);
    return {
      codeIdentity: {
        headCommit: inspection.headCommit,
        workingTreeDigest: workspace.digest,
        hasUncommittedChanges: inspection.hasUncommittedChanges,
      },
      workspace,
    };
  }

  function assertBoundedPreviewResult(result: BaselinePreviewResult, operation: string): void {
    let text: string;
    try {
      text = JSON.stringify(result);
    } catch {
      throw new PublicError('internal', operation);
    }
    if (Buffer.byteLength(text, 'utf8') > RECEIPT_RESULT_MAX_BYTES) {
      // 回执内嵌 result 有界（§13）；超限计划在预览即拒绝，不截断冒充。
      invalidCheckPlan(operation, 'plan');
    }
  }

  return {
    async previewBaseline(
      principal: unknown,
      projectId: unknown,
      payload: unknown,
    ): Promise<BaselinePreviewResult> {
      assertTrustedPrincipal(principal);
      const operation = PREVIEW_OPERATION;
      try {
        const plan = validateBaselinePreviewPayload(payload).plan;
        const id = requireProjectId(projectId, operation);
        const { inspection, repositoryBindingId, bindingRevision, bindingRecordRevision } = await loadBindingContext(principal, id, operation);
        const views = await resolveChecks(operation, plan, inspection.canonicalPath);
        const { codeIdentity, workspace } = await computeCodeIdentity(inspection);
        const environmentIdentity = snapshotEnvironmentIdentity(plan);
        const dirtyScope = dirtyScopeFor(codeIdentity);
        const result: BaselinePreviewResult = {
          previewDigest: computeBaselinePreviewDigest(
            plan,
            codeIdentity,
            previewContext(repositoryBindingId, bindingRevision, bindingRecordRevision, codeIdentity, environmentIdentity),
          ),
          policyRevision: computeBaselinePlanDigest(plan),
          repositoryBindingId,
          repositoryBindingRevision: bindingRevision,
          bindingRecordRevision,
          codeIdentity,
          dirtyScope,
          environmentIdentity,
          workspace: {
            excludedDirNames: [...workspace.excludedDirNames],
            fileCount: workspace.fileCount,
          },
          checks: views,
          warnings: await collectWarnings(operation, plan, views, inspection.canonicalPath, codeIdentity),
        };
        assertBoundedPreviewResult(result, operation);
        return result;
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    async prepareBaselineRun(
      principal: unknown,
      projectId: unknown,
      payload: unknown,
    ): Promise<BaselineRunPrepared> {
      assertTrustedPrincipal(principal);
      const operation = RUN_OPERATION;
      try {
        const { decision, plan, previewDigest } = validateBaselineRunPayload(payload);
        const id = requireProjectId(projectId, operation);
        const { inspection, repositoryBindingId, bindingRevision, bindingRecordRevision } = await loadBindingContext(principal, id, operation);
        // 与预览完全相同的核验（cwd realpath 范围 + 环境引用）；失败零副作用。
        await resolveChecks(operation, plan, inspection.canonicalPath);
        const { codeIdentity } = await computeCodeIdentity(inspection);
        const environmentIdentity = snapshotEnvironmentIdentity(plan);
        return {
          projectId: id,
          decision,
          plan,
          planDigest: computeBaselinePlanDigest(plan),
          claimedPreviewDigest: previewDigest,
          codeIdentity,
          repositoryBindingId,
          bindingRevision,
          bindingRecordRevision,
          dirtyScope: dirtyScopeFor(codeIdentity),
          environmentIdentity,
        };
      } catch (error) {
        throw mapToPublicError(error, { operation });
      }
    },

    submitBaselineRun(
      transaction: CommandTransaction,
      identity: BaselineCommandIdentity,
      prepared: BaselineRunPrepared,
    ): CommandReceipt {
      const operation: 'baseline.run' = RUN_OPERATION;
      const now = nowUtcMs();
      const receiptIdentity = {
        principalId: identity.principalId,
        commandId: identity.commandId,
        operation,
        scope: identity.scope,
        requestDigest: identity.requestDigest,
        issuedAt: identity.issuedAt,
        completedAt: new Date(now).toISOString(),
      };

      // 执行前必须重新核验：提交计划与当前代码身份的摘要必须与用户确认的
      // previewDigest 一致（argv/cwd/环境/政策/代码身份任一实质变化 → 失效）。
      const expectedPreviewDigest = computeBaselinePreviewDigest(
        prepared.plan,
        prepared.codeIdentity,
        previewContext(
          prepared.repositoryBindingId,
          prepared.bindingRevision,
          prepared.bindingRecordRevision,
          prepared.codeIdentity,
          prepared.environmentIdentity,
        ),
      );
      const currentEnvironmentIdentity = snapshotEnvironmentIdentity(prepared.plan);
      const environmentChanged = stableCanonicalJson(currentEnvironmentIdentity) !== stableCanonicalJson(prepared.environmentIdentity);
      const binding = transaction.getRepositoryBinding(prepared.projectId);
      if (prepared.claimedPreviewDigest !== expectedPreviewDigest ||
          environmentChanged ||
          computeBaselinePlanDigest(prepared.plan) !== prepared.planDigest ||
          binding.id !== prepared.repositoryBindingId || binding.bindingRevision !== prepared.bindingRevision ||
          binding.revision !== prepared.bindingRecordRevision) {
        const receipt = createRejectedReceipt({
          ...receiptIdentity,
          error: new PublicError('conflict', operation, undefined, {
            details: { reason: 'preview_stale' },
          }),
        });
        transaction.saveReceipt(receipt);
        return receipt;
      }

      if (prepared.decision === 'decline') {
        // 明确拒绝：持久 not_run + 独立原因；零种子/零占用/零事件/零启动。
        const declined = transaction.insertBaselineOperation({
          projectId: prepared.projectId,
          kind: 'baseline',
          authorizationId: null,
          status: 'not_run',
          reasonCode: 'authorization_rejected',
          startedAtUtcMs: null,
          endedAtUtcMs: now,
        });
        const receipt = createCompletedReceipt({
          ...receiptIdentity,
          resultRef: createResultRef(randomBytes(32)),
          result: {
            operationId: declined.id,
            status: 'not_run',
            reasonCode: 'authorization_rejected',
          },
        });
        transaction.saveReceipt(receipt);
        return receipt;
      }

      // authorize：授权行（不可变）+ accepted 操作 + 获准输入种子 + 全局占用 +
      // baseline.authorized 事件 + accepted 回执 —— 同一事务原子生效。
      const authorization = transaction.insertBaselineAuthorization({
        projectId: prepared.projectId,
        repositoryBindingId: prepared.repositoryBindingId,
        repositoryBindingRevision: prepared.bindingRevision,
        codeIdentity: {
          headCommit: prepared.codeIdentity.headCommit,
          workingTreeDigest: prepared.codeIdentity.workingTreeDigest,
          hasUncommittedChanges: prepared.codeIdentity.hasUncommittedChanges,
        },
        dirtyScope: prepared.dirtyScope,
        environmentIdentity: prepared.environmentIdentity,
        policyRevision: prepared.planDigest,
        planDigest: prepared.planDigest,
        plan: prepared.plan,
        authorizedBy: identity.principalId,
        authorizedAtUtcMs: now,
      });
      const operationRow = transaction.insertBaselineOperation({
        projectId: prepared.projectId,
        kind: 'baseline',
        authorizationId: authorization.id,
        status: 'accepted',
        reasonCode: null,
        startedAtUtcMs: null,
        endedAtUtcMs: null,
      });
      // 获准输入快照（全部检查共用同一授权 → 单一代码身份，不混用）。
      transaction.insertBaselineCheckResults(operationRow.id, prepared.plan);
      try {
        transaction.acquireBaselineOccupancy({ operationId: operationRow.id, processIdentity: {
          bindingRevision: prepared.bindingRevision,
          bindingRecordRevision: prepared.bindingRecordRevision,
          deadlineUtcMs: now + prepared.plan.checks.reduce((sum, check) => sum + check.timeoutMs, 0) + 30_000,
        } });
      } catch (error) {
        // §8.3：另一在途操作 → resource_busy baseline_in_progress（整组回滚，
        // 零持久副作用；不落 rejected 回执——客户端可换 commandId 重试）。
        if (isStorageError(error, 'conflict') && error.details?.reason === 'baseline_in_progress') {
          throw new PublicError('resource_busy', operation, undefined, {
            details: { reason: 'baseline_in_progress' },
          });
        }
        throw error;
      }
      transaction.appendBaselineEvent({
        projectId: prepared.projectId,
        type: BASELINE_AUTHORIZED_EVENT_TYPE,
        operationId: operationRow.id,
        aggregateRevision: operationRow.revision,
        planDigest: prepared.planDigest,
        checkCount: prepared.plan.checks.length,
      });
      const receipt = createAcceptedReceipt({
        ...receiptIdentity,
        operationId: operationRow.id,
      });
      transaction.saveReceipt(receipt);
      return receipt;
    },
  };
}
