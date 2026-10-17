/**
 * P03-2 / F-006 执行输入准备编排（application 层）：
 * 一致状态视图捕获 → 事务外采集/组装/发布 → 最终写事务内身份重核与原子提交。
 *
 * 设计依据：core-design/06（Attempt 固定输入引用和摘要；snapshot/manifest/
 * prompt 是可验证的不可变制品组）、core-design/13 §2（InputManifest 记录选取
 * 与读取证据）、core-design/03 §4（发布 staging→校验→ready；文件 I/O 不在
 * 数据库事务内）。实施契约：docs/p03-2-execution-input-prepare-contract.md。
 *
 * 不变量：
 * - 三阶段结构（与基线命令同一纪律）：
 *   1) 捕获：单一 DEFERRED 一致读视图内取得 Feature/Task/依赖/决策/配置，
 *      在视图内 fail-fast 核验有效批准（F-003 纯规则；未批准/拒绝/过期即
 *      拒绝，不做文件 I/O）；
 *   2) 组装与发布（事务外 I/O）：复用 F-004 ExecutionInputService 采集必需
 *      输入（文件来源捕获实际字节并发布为不可变制品；制品来源核验归属与
 *      ready）、F-005 ContextBuilder 纯组装 snapshot/manifest/prompt、
 *      ArtifactPublisher 发布三正文；发布后逐正文校验读取（readVerifiedContent
 *      字节级复验）——不宣称文件系统与 SQLite 存在跨介质原子事务；
 *   3) 最终重核（调用方同一 BEGIN IMMEDIATE 写事务内，无任何事务外 I/O）：
 *      当前 planDigest、有效批准复合身份、Task 策略副本内容身份、权限面
 *      内容身份与全部制品索引（ready + hash/size/locator 一致）重核通过才
 *      写脱敏事件与 completed 回执（事件/回执/最终状态原子一致）；任一
 *      身份漂移固化 rejected 回执（零事件、零可绑定结果）；
 * - 身份重核按**内容身份**而非裸 revision：纯标签编辑（Phase/Feature/Task
 *   labels CAS）只递增 revision 不改变 planDigest/策略副本内容，不误报业务
 *   失效；默认 modelMap 变化不进入任何捕获身份（策略按副本使用，不重读
 *   路由），天然不触发；
 * - 失败证据保留：任一必需制品缺失、篡改、超预算或发布失败都不留下可绑定
 *   的半完整制品组——已发布制品保持不可变（本身是可核对证据），索引沿用
 *   既有 pending/failed 与残留核对行为，不覆盖、不自动删除任何已有正式输入；
 * - 幂等：重复 commandId 由既有命令回执机制重放原回执（不重复发布）；
 *   历史回执重放不代表该输入仍满足当前执行前置条件（绑定前必须重核，
 *   P03-3/4 职责）；
 * - 不创建 Batch/Run/Attempt、不调用 Runtime/Git/检查进程、不声称已启动执行；
 *   凭据始终只有引用（快照/prompt/回执不携带正文或凭据）；
 * - 秘密纪律：错误 details 只含身份键、摘要、字节数、限制值与脱敏原因，
 *   不含绝对路径或正文内容。
 *
 * 本模块不实现：Host/CLI 接线（F-007/F-008）、Run/Attempt 绑定与 start
 * （P03-3/4）、通用知识检索、强 OS 沙箱。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import { mapProjectLookupError } from '../ports/authorization.js';
import {
  PublicError,
  createCompletedReceipt,
  createRejectedReceipt,
  mapStorageError,
} from '../ports/commands.js';
import type { CommandReceipt, ValidatedExecutionInputPreparePayload } from '../ports/commands.js';
import type { TrustedExecutionInputPreparePayload } from '../ports/execution-input-prepare.js';
import { createResultRef } from '../ports/command-receipts.js';
import { isStorageError, StorageError } from '../ports/errors.js';
import {
  EXECUTION_INPUT_PREPARED_EVENT_TYPE,
} from '../ports/plan-store.js';
import {
  EXECUTION_GROUP_JSON_MEDIA_TYPE,
  EXECUTION_GROUP_PROMPT_MEDIA_TYPE,
  EXECUTION_INPUT_GROUP_LOCATOR_PREFIX,
  EXECUTION_MANIFEST_ARTIFACT_KIND,
  EXECUTION_PROMPT_ARTIFACT_KIND,
  EXECUTION_SNAPSHOT_ARTIFACT_KIND,
  computeExecutionPermissionsDigest,
  computeExecutionStrategyCopyDigest,
} from '../ports/execution-input-prepare.js';
import type {
  ExecutionInputGroupBodyRef,
  ExecutionPermissionsFace,
  ExecutionPermissionsReader,
  ExecutionInputPreparationViewStore,
  PreparedExecutionInputGroup,
} from '../ports/execution-input-prepare.js';
import { stableStringify } from '../ports/feature-plan.js';
import { computeDeliveryPolicyDigest } from '../ports/delivery-policy.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validatePositiveInteger,
  validationError,
} from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';
import { isExecutionInputError } from './execution-input.js';
import type { ExecutionInputService } from './execution-input.js';
import { isContextBuildError, validateContextReworkInput } from '../ports/context-build.js';
import type { ContextBuilder } from './context-build.js';
import {
  resolveCurrentCheckPolicyDigest,
  verifyFeaturePlanApprovalInTransaction,
} from './plan-approval-verification.js';
import { evaluatePlanApprovalValidity } from '../ports/plan-approval-verification.js';
import { mergeEffectiveSettings } from './effective-settings.js';
import { isArtifactPublishError } from './artifact-publish.js';
import type { ArtifactPublisher } from './artifact-publish.js';
import { isArtifactVerifyError } from './artifact-verify.js';
import type { ArtifactVerifier } from './artifact-verify.js';

/** 执行输入准备命令操作名（与 COMMAND_OPERATIONS 白名单同一冻结名）。 */
export const EXECUTION_INPUT_PREPARE_OPERATION = 'execution.input.prepare' as const;

/**
 * F-006（P03-2）纯规则（可核对冻结面）：执行输入准备的影响面。发布同项目
 * 不可变三正文制品组并最终重核批准与 Task 输入身份；不修改任何计划实体
 * （planDigest/planStatus/revision/策略副本/标签全部不变）、不创建执行实体、
 * 不启动 Runtime/Git/检查进程；旧制品永不改写（新准备生成新制品，历史正文
 * 逐字节不变）；事件与回执在最终短写事务内原子提交。
 */
export const EXECUTION_INPUT_PREPARE_IMPACT = Object.freeze({
  publishesImmutableGroupArtifacts: true,
  capturesFromConsistentReadView: true,
  assemblesOutsideTransactions: true,
  finalRecheckInsideWriteTransaction: true,
  changesPlanEntities: false,
  changesTaskStrategyCopies: false,
  createsExecutionEntities: false,
  startsRuntimeGitOrChecks: false,
  rewritesHistoricalArtifacts: false,
  credentialsRemainReferencesOnly: true,
});

/** 准备预算：显式有限（必需输入采集条数；字节/时间预算由采集与发布器承担）。 */
export interface ExecutionInputPrepareLimits {
  /** 单次准备的最大必需输入条数（≥1；0 条输入合法）。 */
  readonly maxRequiredItems: number;
}

/** 生产/测试共用缺省预算（有界；与 F-004 采集服务限制共同生效）。 */
export const DEFAULT_EXECUTION_INPUT_PREPARE_LIMITS: Readonly<ExecutionInputPrepareLimits> =
  Object.freeze({ maxRequiredItems: 16 });

/**
 * 生产组装的 ContextBuilder 冻结缺省预算（F-006 定案；预算全部显式有限，
 * 必需内容超限整体结构化失败，绝不截断验收条目换取成功）。变更本预算即变更
 * 组装行为，须同步契约文档与回归。
 */
export const DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET: Readonly<import('./context-build.js').ContextBudget> =
  Object.freeze({
    maxPromptBytes: 400_000,
    maxRequiredSnapshotBytes: 300_000,
    maxRequiredInputRefs: 64,
    maxHistoryEntries: 50,
    maxHistoryEntryChars: 400,
    bytesPerTokenEstimate: 4,
  });

/** 准备服务装配依赖（全部窄端口/用例；不接触具体适配器）。 */
export interface ExecutionInputPrepareServiceDeps {
  readonly views: ExecutionInputPreparationViewStore;
  readonly inputs: ExecutionInputService;
  readonly builder: ContextBuilder;
  readonly publisher: ArtifactPublisher;
  readonly verifier: ArtifactVerifier;
  readonly permissions: ExecutionPermissionsReader;
  readonly limits: ExecutionInputPrepareLimits;
  /** 时间源（默认 Date.now；测试注入以获得确定性）。 */
  readonly nowMs?: () => number;
}

/**
 * 命令服务消费的执行输入准备端口：事务外准备（阶段 1+2）+ 同步权限读取
 * （最终写事务内重核用）。实现者：createExecutionInputPrepareService。
 */
export interface ExecutionInputPreparePort {
  /** 事务外准备（视图捕获 + 采集 + 组装 + 发布 + 正文复验）；失败抛 PublicError。 */
  prepareExecutionInput(
    projectId: string,
    payload: ValidatedExecutionInputPreparePayload | TrustedExecutionInputPreparePayload,
  ): Promise<PreparedExecutionInputGroup>;
  /** 同步权限面读取（同一装配在捕获与最终重核各调用一次）。 */
  readExecutionPermissions(input: {
    readonly projectId: string;
    readonly featureId: string;
    readonly taskId: string;
  }): ExecutionPermissionsFace;
}

export type ExecutionInputPrepareEnvelope = Extract<
  import('../ports/commands.js').ValidatedCommandEnvelope,
  { operation: typeof EXECUTION_INPUT_PREPARE_OPERATION }
>;

/** 准备提交身份（回执公共字段；由命令服务从信封与服务端时钟组装）。 */
export interface ExecutionInputPrepareIdentity {
  readonly principalId: string;
  readonly commandId: string;
  readonly operation: typeof EXECUTION_INPUT_PREPARE_OPERATION;
  readonly scope: ExecutionInputPrepareEnvelope['scope'];
  readonly requestDigest: string;
  readonly issuedAt: string;
  readonly completedAt: string;
}

/* ------------------------------------------------------------------ *
 * 内部工具（脱敏错误构造与正文字节化）
 * ------------------------------------------------------------------ */

const OPERATION = EXECUTION_INPUT_PREPARE_OPERATION;

function publicError(
  code: 'invalid_input' | 'not_found' | 'forbidden' | 'conflict' | 'corrupt_state' | 'internal',
  reason: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): PublicError {
  return new PublicError(code, OPERATION, undefined, {
    details: { reason, ...(details ?? {}) },
    ...(cause !== undefined ? { cause } : {}),
  });
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 权限面形态核验（fail-closed：装配契约被违反即 corrupt_state，不静默兜底）。 */
function readPermissionsFace(
  reader: ExecutionPermissionsReader,
  input: { projectId: string; featureId: string; taskId: string },
): ExecutionPermissionsFace {
  let face: unknown;
  try {
    face = reader(input);
  } catch (cause) {
    throw new StorageError('corrupt', OPERATION, '权限读取器抛出异常（fail-closed，不默认为空集）', {
      cause,
    });
  }
  if (
    face === null ||
    typeof face !== 'object' ||
    !Array.isArray((face as { grants?: unknown }).grants) ||
    (face as { grants: unknown[] }).grants.some((grant) => typeof grant !== 'string')
  ) {
    throw new StorageError('corrupt', OPERATION, '权限读取器返回非法形态（期望 { grants: string[] }）');
  }
  return face as ExecutionPermissionsFace;
}

/* ------------------------------------------------------------------ *
 * 事务外准备（阶段 1+2）
 * ------------------------------------------------------------------ */

/**
 * 装配执行输入准备服务。只校验依赖形态与预算（fail-closed），不执行任何
 * I/O；import 本模块无副作用。返回命令服务消费端口（准备 + 同步权限读取）。
 */
export function createExecutionInputPrepareService(
  deps: ExecutionInputPrepareServiceDeps,
): ExecutionInputPreparePort {
  const context: ValidationContext = { operation: `${OPERATION}.create` };
  if (deps === null || typeof deps !== 'object') {
    throw validationError(context, 'deps', '必须提供 views/inputs/builder/publisher/verifier/permissions/limits 装配依赖');
  }
  for (const [field, value] of [
    ['views', deps.views],
    ['inputs', deps.inputs],
    ['builder', deps.builder],
    ['publisher', deps.publisher],
    ['verifier', deps.verifier],
    ['permissions', deps.permissions],
  ] as const) {
    if (value === null || typeof value !== 'object' && typeof value !== 'function') {
      throw validationError(context, `deps.${field}`, `必须提供 ${field} 端口/用例实现`);
    }
  }
  const limitsObject = requirePlainObject(deps.limits, context, 'limits');
  rejectUnknownKeys(limitsObject, ['maxRequiredItems'], context, 'limits');
  const limits: ExecutionInputPrepareLimits = {
    maxRequiredItems: validatePositiveInteger(
      limitsObject.maxRequiredItems,
      context,
      'limits.maxRequiredItems',
    ),
  };
  const nowMs = deps.nowMs ?? Date.now;
  const { views, inputs, builder, publisher, verifier, permissions } = deps;

  /** 发布单个组正文并返回身份引用（expectedHash = 正文字节摘要）。 */
  async function publishGroupBody(
    projectId: string,
    taskId: string,
    part: 'snapshot' | 'manifest' | 'prompt',
    body: string,
  ): Promise<ExecutionInputGroupBodyRef> {
    const bodyBuffer = Buffer.from(body, 'utf8');
    const expectedHash = sha256Hex(bodyBuffer);
    const spec = {
      snapshot: { kind: EXECUTION_SNAPSHOT_ARTIFACT_KIND, mediaType: EXECUTION_GROUP_JSON_MEDIA_TYPE },
      manifest: { kind: EXECUTION_MANIFEST_ARTIFACT_KIND, mediaType: EXECUTION_GROUP_JSON_MEDIA_TYPE },
      prompt: { kind: EXECUTION_PROMPT_ARTIFACT_KIND, mediaType: EXECUTION_GROUP_PROMPT_MEDIA_TYPE },
    }[part];
    let published;
    try {
      published = await publisher.publishArtifact({
        projectId,
        kind: spec.kind,
        mediaType: spec.mediaType,
        expectedHash,
        locator: `${EXECUTION_INPUT_GROUP_LOCATOR_PREFIX}/${taskId}/${part}`,
        content: [bodyBuffer],
      });
    } catch (cause) {
      if (isArtifactPublishError(cause)) {
        // 索引保留 failed/pending 证据与 staging 残留（发布器行为），不回滚、
        // 不删除；本组不产生任何可绑定结果。
        throw publicError(
          'internal',
          'publish_failed',
          { stage: cause.stage, publishCode: cause.code, artifactId: cause.artifactId },
          cause,
        );
      }
      throw publicError('internal', 'publish_failed', undefined, cause);
    }
    const record = published.artifact;
    return {
      artifactId: record.id,
      version: record.version,
      contentHash: record.contentHash ?? expectedHash,
      sizeBytes: record.sizeBytes ?? bodyBuffer.byteLength,
      locator: record.locator,
      mediaType: record.mediaType,
    };
  }

  /** 发布后正文复验：readVerifiedContent 字节级一致（ready + 索引一致 + 正文未篡改）。 */
  async function verifyGroupBody(
    projectId: string,
    part: 'snapshot' | 'manifest' | 'prompt',
    ref: ExecutionInputGroupBodyRef,
    body: string,
  ): Promise<void> {
    let verified;
    try {
      verified = await verifier.readVerifiedContent(projectId, ref.artifactId);
    } catch (cause) {
      if (isArtifactVerifyError(cause)) {
        throw publicError(
          cause.code === 'conflict' ? 'conflict' : 'corrupt_state',
          'published_body_mismatch',
          { part, artifactId: ref.artifactId, verifyCode: cause.code },
          cause,
        );
      }
      throw publicError('corrupt_state', 'published_body_mismatch', { part, artifactId: ref.artifactId }, cause);
    }
    if (
      verified.contentHash !== ref.contentHash ||
      verified.sizeBytes !== ref.sizeBytes ||
      verified.locator !== ref.locator ||
      Buffer.compare(Buffer.from(verified.content), Buffer.from(body, 'utf8')) !== 0
    ) {
      throw publicError('corrupt_state', 'published_body_mismatch', { part, artifactId: ref.artifactId });
    }
  }

  return {
    readExecutionPermissions(input) {
      return readPermissionsFace(permissions, input);
    },

    async prepareExecutionInput(projectId, payload) {
      /* F-012：受信返工输入先行 fail-closed 校验（命令信封不接受 rework 键；
       * 只有受信 Runner 能构造，但仍在入口重验，不信任调用方形态）。 */
      let reworkInput: import('../ports/context-build.js').ContextReworkInput | undefined;
      const rawRework = (payload as TrustedExecutionInputPreparePayload).rework;
      if (rawRework !== undefined && rawRework !== null) {
        try {
          reworkInput = validateContextReworkInput(rawRework, { projectId, taskId: payload.taskId });
        } catch (cause) {
          if (isContextBuildError(cause)) {
            throw publicError('invalid_input', 'rework_validation', {
              field: cause.field,
              reason: cause.code,
            }, cause);
          }
          throw cause;
        }
      }

      /* 阶段 1：一致读视图捕获（单一 DEFERRED 读事务）。 */
      let view;
      try {
        view = views.readExecutionInputPreparationView(projectId, payload.featureId);
      } catch (cause) {
        if (isStorageError(cause, 'ownership')) {
          throw publicError('forbidden', 'ownership_denied', { entityType: 'feature' }, cause);
        }
        if (isStorageError(cause)) {
          throw mapStorageError(cause, { operation: OPERATION });
        }
        throw cause;
      }
      if (view === undefined) {
        throw publicError('not_found', 'feature_not_found', { entityType: 'feature' });
      }

      /* 阶段 1a：视图内 fail-fast 有效批准核验（F-003 纯规则；先于任何文件 I/O）。 */
      const checkPolicyDigest = resolveCurrentCheckPolicyDigest(
        view.settings.global === null
          ? null
          : { scopeRevision: view.settings.global.scopeRevision, payload: view.settings.global.payload },
        view.settings.project === null
          ? null
          : { scopeRevision: view.settings.project.scopeRevision, payload: view.settings.project.payload },
      );
      const validity = evaluatePlanApprovalValidity({
        planDigest: view.feature.planDigest,
        planStatus: view.feature.planStatus,
        taskCount: view.tasks.length,
        decisions: view.approvals,
        currentCheckPolicyDigest: checkPolicyDigest,
      });
      if (!validity.valid) {
        throw publicError('conflict', validity.reason, { entityType: 'feature' });
      }

      /* 阶段 1b：目标 Task 固定输入捕获（来自同一视图）。 */
      const task = view.tasks.find((candidate) => candidate.id === payload.taskId);
      if (task === undefined || task.featureId !== view.feature.id) {
        throw publicError('not_found', 'task_not_in_plan', { entityType: 'task' });
      }
      const dependencyEvidence = view.dependencies
        .filter((edge) => edge.taskId === task.id)
        .map((edge) => ({ taskId: edge.taskId, dependsOnId: edge.dependsOnId }));
      const upstreamIds = new Set(dependencyEvidence.map((edge) => edge.dependsOnId));
      const dependencies = view.tasks
        .filter((candidate) => upstreamIds.has(candidate.id))
        .map((candidate) => ({
          taskId: candidate.id,
          evidenceRefs: candidate.requirementsRefs.map((ref) =>
            ref.contentHash === undefined ? { artifactId: ref.artifactId } : { ...ref },
          ),
        }));

      /* 阶段 1c：权限面捕获（可信装配读取器；请求不能伪造）。 */
      const permissionsFace = readPermissionsFace(permissions, {
        projectId,
        featureId: view.feature.id,
        taskId: task.id,
      });

      /* 阶段 2a：必需输入采集（事务外文件/索引 I/O 由 F-004 用例承担）。 */
      if (payload.items.length > limits.maxRequiredItems) {
        throw publicError('invalid_input', 'limit_exceeded', {
          limit: 'maxRequiredItems',
          maxRequiredItems: limits.maxRequiredItems,
          actualItems: payload.items.length,
        });
      }
      let captured;
      try {
        captured = await inputs.captureRequiredInputs({
          projectId,
          taskId: task.id,
          items: payload.items,
        });
      } catch (cause) {
        if (isExecutionInputError(cause)) {
          throw mapCaptureError(cause);
        }
        if (isStorageError(cause)) {
          throw mapStorageError(cause, { operation: OPERATION });
        }
        throw cause;
      }

      /* 阶段 2b：ContextBuilder 纯组装（无 I/O；超预算整体结构化失败）。 */
      const effective = mergeEffectiveSettings({
        global:
          view.settings.global === null
            ? null
            : { scopeRevision: view.settings.global.scopeRevision, payload: view.settings.global.payload },
        project:
          view.settings.project === null
            ? null
            : { scopeRevision: view.settings.project.scopeRevision, payload: view.settings.project.payload },
      });
      let built;
      try {
        built = builder.build({
          projectId,
          featureId: view.feature.id,
          taskId: task.id,
          task: {
            title: task.title,
            description: task.description,
            acceptance: task.acceptance,
            requirementsRefs: task.requirementsRefs,
            dependencies,
            executionConfig: task.executionConfig,
            configSource: task.configSource,
            configSourceKey: task.configSourceKey,
            labels: task.labels,
          },
          checkPolicy: {
            digest: checkPolicyDigest,
            ...(effective.policies.verification === undefined
              ? {}
              : { copy: effective.policies.verification.value as Record<string, unknown> }),
          },
          /* P03-8 / F-001：交付政策固定进执行依据——当前有效 deliveryPolicy 段
             （或未配置时的 null 形态摘要）随快照发布；后续配置漂移不改变
             已发布快照字节。Task 执行不要求交付政策已配置（Task 不自行提交）。 */
          deliveryPolicy: {
            digest: computeDeliveryPolicyDigest(effective.policies.deliveryPolicy?.value),
            ...(effective.policies.deliveryPolicy === undefined
              ? {}
              : { copy: effective.policies.deliveryPolicy.value as Record<string, unknown> }),
          },
          permissions: { grants: [...permissionsFace.grants] },
          requiredInputs: captured.refs,
          ...(reworkInput !== undefined ? { rework: reworkInput } : {}),
        });
      } catch (cause) {
        throw mapContextBuildFailure(cause);
      }

      /* 阶段 2c：三正文序列化（稳定规范化；相同输入逐字节可复现）。 */
      const snapshotBody = stableStringify(built.inputSnapshot);
      const manifestBody = stableStringify(built.inputManifest);
      const promptBody = built.prompt;

      /* 阶段 2d：发布 + 正文复验（事务外文件 I/O；失败保留证据不产生可绑定结果）。 */
      const snapshotRef = await publishGroupBody(projectId, task.id, 'snapshot', snapshotBody);
      const manifestRef = await publishGroupBody(projectId, task.id, 'manifest', manifestBody);
      const promptRef = await publishGroupBody(projectId, task.id, 'prompt', promptBody);
      await verifyGroupBody(projectId, 'snapshot', snapshotRef, snapshotBody);
      await verifyGroupBody(projectId, 'manifest', manifestRef, manifestBody);
      await verifyGroupBody(projectId, 'prompt', promptRef, promptBody);

      return {
        projectId,
        featureId: view.feature.id,
        taskId: task.id,
        schemaVersion: built.schemaVersion,
        group: { snapshot: snapshotRef, manifest: manifestRef, prompt: promptRef },
        requiredInputs: captured.refs,
        digests: {
          snapshotDigest: built.digests.snapshotDigest,
          manifestDigest: built.digests.manifestDigest,
          promptDigest: built.digests.promptDigest,
          strategyCopyDigest: computeExecutionStrategyCopyDigest({
            executionConfig: task.executionConfig,
            configSource: task.configSource,
            configSourceKey: task.configSourceKey,
          }),
          permissionsDigest: computeExecutionPermissionsDigest(permissionsFace.grants),
        },
        approval: {
          planDigest: view.feature.planDigest as string,
          checkPolicyDigest,
          decisionId: validity.currentDecisionId,
          featureRevision: view.feature.revision,
        },
        taskRevision: task.revision,
        promptBytes: built.promptBytes,
        tokenEstimate: built.tokenEstimate,
        preparedAtUtcMs: nowMs(),
        ...(built.inputSnapshot.rework !== null && built.inputSnapshot.rework !== undefined
          ? { rework: built.inputSnapshot.rework }
          : {}),
      };
    },
  };
}

/** F-004 采集错误 → 命令面公开错误（details 携带脱敏原因/限制；不含正文与绝对路径）。 */
function mapCaptureError(cause: import('./execution-input.js').ExecutionInputError): PublicError {
  switch (cause.code) {
    case 'validation':
      return publicError('invalid_input', 'validation', { purpose: cause.purpose ?? undefined }, cause);
    case 'not_found':
      return publicError('not_found', 'required_input_not_found', {
        purpose: cause.purpose ?? undefined,
        artifactId: cause.artifactId ?? undefined,
      }, cause);
    case 'ownership':
      return publicError('forbidden', 'ownership_denied', {
        purpose: cause.purpose ?? undefined,
        artifactId: cause.artifactId ?? undefined,
      }, cause);
    case 'not_ready':
      return publicError('conflict', 'not_ready', {
        purpose: cause.purpose ?? undefined,
        artifactId: cause.artifactId ?? undefined,
      }, cause);
    case 'source_unavailable':
      return publicError('invalid_input', 'source_unavailable', { ...(cause.details ?? {}) }, cause);
    case 'limit_exceeded':
      return publicError('invalid_input', 'limit_exceeded', { ...(cause.details ?? {}) }, cause);
    case 'timeout':
      return publicError('internal', 'timeout', { ...(cause.details ?? {}) }, cause);
    case 'corrupt':
    case 'mismatch':
      return publicError('corrupt_state', cause.code === 'corrupt' ? 'corrupt' : 'reference_mismatch', {
        purpose: cause.purpose ?? undefined,
        artifactId: cause.artifactId ?? undefined,
      }, cause);
    case 'publish':
      return publicError('internal', 'publish_failed', { ...(cause.details ?? {}) }, cause);
    case 'file':
      return publicError('internal', 'file_io', { ...(cause.details ?? {}) }, cause);
    default:
      return publicError('internal', 'storage', undefined, cause);
  }
}

/** ContextBuilder 失败 → 命令面公开错误（必需内容超预算等结构化失败）。 */
export function mapContextBuildFailure(cause: unknown): PublicError {
  if (isContextBuildError(cause)) {
    return publicError(
      'invalid_input',
      cause.code === 'limit_exceeded' ? 'limit_exceeded' : 'context_build_failed',
      { field: cause.field ?? undefined, ...(cause.details ?? {}) },
      cause,
    );
  }
  if (isStorageError(cause)) {
    return mapStorageError(cause, { operation: OPERATION });
  }
  throw cause;
}

/* ------------------------------------------------------------------ *
 * 最终重核与原子提交（阶段 3：调用方同一写事务内）
 * ------------------------------------------------------------------ */

/** 制品索引重核：ready + hash/size/locator 与准备结果一致（不一致即漂移/篡改）。 */
function recheckArtifactRef(
  ref: { readonly artifactId: string; readonly contentHash: string; readonly sizeBytes: number; readonly locator: string },
  expected: { readonly contentHash: string; readonly sizeBytes: number; readonly locator: string },
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (ref.contentHash !== expected.contentHash || ref.sizeBytes !== expected.sizeBytes || ref.locator !== expected.locator) {
    return { ok: false, reason: 'artifact_changed' };
  }
  return { ok: true };
}

/**
 * 提交执行输入准备最终重核结果：在调用方的同一写事务内重核当前批准、计划
 * 摘要、Task 策略副本内容身份、权限面内容身份与全部制品索引；全部通过才
 * 写脱敏事件与 completed 回执（原子一致）。任一身份漂移在任何写入之前固化
 * rejected（零事件）；除 saveReceipt 外的失败以异常抛出（整组回滚，零回执）。
 */
export function submitExecutionInputPrepare(
  identity: ExecutionInputPrepareIdentity,
  envelope: ExecutionInputPrepareEnvelope,
  transaction: CommandTransaction,
  prepared: PreparedExecutionInputGroup,
  preparePort: ExecutionInputPreparePort,
): CommandReceipt {
  const projectId = envelope.scope.projectId;

  // 防御：准备结果必须与命令目标一致（同一项目/Feature/Task）。
  if (
    prepared.projectId !== projectId ||
    prepared.featureId !== envelope.payload.featureId ||
    prepared.taskId !== envelope.payload.taskId
  ) {
    throw new StorageError('corrupt', OPERATION, '准备结果与命令目标不一致（防御拒绝，零写入）');
  }

  // 1) 父级项目把关：缺失/不可见统一 forbidden（不泄漏存在性；抛出）。
  try {
    transaction.getProject(projectId);
  } catch (error) {
    mapProjectLookupError(error, OPERATION);
  }

  const rejected = (details: Record<string, unknown>): CommandReceipt => {
    const receipt = createRejectedReceipt({
      ...identity,
      error: new PublicError('conflict', OPERATION, undefined, { details }),
    });
    transaction.saveReceipt(receipt);
    return receipt;
  };

  // 2) 当前计划快照（同一写事务权威读）：缺失 not_found、跨项目 ownership 抛出。
  const snapshot = transaction.getFeaturePlan(projectId, envelope.payload.featureId);
  const feature = snapshot.feature;

  // 3) 计划业务摘要重核：捕获视图之后发生实质修订（要求/验收/依赖变化）即
  //    过期——旧视图不得作为当前有效输入返回（即使新计划已被重新批准）。
  if (feature.planDigest !== prepared.approval.planDigest) {
    return rejected({ reason: 'plan_changed', entityType: 'feature' });
  }

  // 4) 有效批准重核（F-003 同一写事务复用入口；复合身份 = planDigest + 当前
  //    检查政策摘要）：未批准/拒绝/检查政策变化/状态不一致均 fail-closed。
  const approval = verifyFeaturePlanApprovalInTransaction(transaction, projectId, feature.id);
  if (!approval.validity.valid) {
    return rejected({ reason: approval.validity.reason, entityType: 'feature' });
  }

  // 5) 目标 Task 重核：成员资格 + 策略副本**内容身份**（纯标签编辑只递增
  //    revision 不改变内容身份，不误报业务失效）。
  const task = snapshot.tasks.find((candidate) => candidate.id === prepared.taskId);
  if (task === undefined || task.featureId !== feature.id) {
    return rejected({ reason: 'task_not_in_plan', entityType: 'task' });
  }
  if (
    computeExecutionStrategyCopyDigest({
      executionConfig: task.executionConfig,
      configSource: task.configSource,
      configSourceKey: task.configSourceKey,
    }) !== prepared.digests.strategyCopyDigest
  ) {
    return rejected({ reason: 'task_strategy_changed', entityType: 'task' });
  }

  // 6) 权限面内容身份重核（同一装配同步读取；漂移即拒绝）。
  const permissionsFace = readPermissionsFace(
    (input) => preparePort.readExecutionPermissions(input),
    {
      projectId,
      featureId: feature.id,
      taskId: task.id,
    },
  );
  if (computeExecutionPermissionsDigest(permissionsFace.grants) !== prepared.digests.permissionsDigest) {
    return rejected({ reason: 'permissions_changed', entityType: 'task' });
  }

  // 7) 全部制品索引重核：三正文 + 每条必需输入必须 ready 且 hash/size/locator
  //    与准备结果一致（缺失/未 ready/被篡改都不产生可绑定结果）。
  const artifactChecks: readonly { label: string; ref: { artifactId: string; contentHash: string; sizeBytes: number; locator: string } }[] = [
    { label: 'snapshot', ref: prepared.group.snapshot },
    { label: 'manifest', ref: prepared.group.manifest },
    { label: 'prompt', ref: prepared.group.prompt },
    ...prepared.requiredInputs.map((ref, index) => ({
      label: `required-input[${index}]`,
      ref,
    })),
  ];
  for (const check of artifactChecks) {
    let indexRef;
    try {
      indexRef = transaction.getArtifactInputRef(projectId, check.ref.artifactId);
    } catch (error) {
      if (isStorageError(error, 'conflict')) {
        return rejected({ reason: 'artifact_not_ready', artifactId: check.ref.artifactId, part: check.label });
      }
      if (isStorageError(error, 'not_found')) {
        return rejected({ reason: 'artifact_missing', artifactId: check.ref.artifactId, part: check.label });
      }
      if (isStorageError(error)) {
        throw mapStorageError(error, { operation: OPERATION });
      }
      throw error;
    }
    const outcome = recheckArtifactRef(indexRef, check.ref);
    if (!outcome.ok) {
      return rejected({ reason: outcome.reason, artifactId: check.ref.artifactId, part: check.label });
    }
  }

  // 8) 同事务脱敏事件（恒定 payload；不携带制品正文/摘要/策略副本/执行语义）。
  transaction.appendPlanEvent({
    projectId,
    eventType: EXECUTION_INPUT_PREPARED_EVENT_TYPE,
    aggregateType: 'task',
    aggregateId: task.id,
    aggregateRevision: task.revision,
    payload: { prepared: true },
  });

  // 9) completed 回执：有界结果只携带制品组身份（引用 + 摘要 + 复合身份），
  //    供 P03-3/4 绑定到新 Run/Attempt；不携带正文、不声称已启动执行。
  const receipt = createCompletedReceipt({
    ...identity,
    resultRef: createResultRef(randomBytes(32)),
    result: {
      schemaVersion: prepared.schemaVersion,
      bindable: true,
      preparedAt: new Date(prepared.preparedAtUtcMs).toISOString(),
      group: {
        snapshot: { ...prepared.group.snapshot },
        manifest: { ...prepared.group.manifest },
        prompt: { ...prepared.group.prompt },
      },
      requiredInputs: prepared.requiredInputs.map((ref) => ({
        purpose: ref.purpose,
        artifactId: ref.artifactId,
        version: ref.version,
        contentHash: ref.contentHash,
        sizeBytes: ref.sizeBytes,
        locator: ref.locator,
        mediaType: ref.mediaType,
        origin: ref.origin,
      })),
      digests: { ...prepared.digests },
      approval: {
        planDigest: prepared.approval.planDigest,
        checkPolicyDigest: prepared.approval.checkPolicyDigest,
        decisionId: prepared.approval.decisionId,
        featureRevision: prepared.approval.featureRevision,
      },
      taskRevision: prepared.taskRevision,
      promptBytes: prepared.promptBytes,
      tokenEstimate: prepared.tokenEstimate,
    },
  });
  transaction.saveReceipt(receipt);
  return receipt;
}
