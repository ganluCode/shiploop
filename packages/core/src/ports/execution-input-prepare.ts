/**
 * P03-2 / F-006 执行输入准备窄契约（ports 契约层：类型、常量、纯摘要函数与
 * 一致读视图/权限读取端口形态，无任何 I/O）。
 *
 * 设计依据：core-design/06 §“Attempt 输入固定”（Attempt 固定输入引用和摘要；
 * snapshot/manifest/prompt 是可验证的不可变制品组）、core-design/13 §2
 * （InputManifest 记录选取与读取证据）与 core-design/03 §4（发布 staging→
 * 校验→ready；文件 I/O 不在数据库事务内）。
 *
 * 契约要点：
 * - 制品组三正文（snapshot/manifest/prompt）经既有 ArtifactPublisher 发布为
 *   同项目不可变受管 Artifact（kind/locator/mediaType 受控词汇）；本契约只
 *   固定身份形态（artifactId/version/contentHash/sizeBytes/locator/
 *   mediaType），正文永不内联；
 * - 一致状态视图（ExecutionInputPreparationView）：Feature + 全部 Task +
 *   依赖边 + 全部决策记录 + 全局/项目当前配置必须在同一读事务内取得
 * （并发修订/决策/配置变化只能观察到完整前后状态）；实现者：
 *   adapters/sqlite/plan-store（单一 BEGIN DEFERRED 读事务）；
 * - Task 策略副本身份 = computeExecutionStrategyCopyDigest（executionConfig +
 *   configSource + configSourceKey 的规范化内容摘要；与 F-005 manifest 的
 *   task-strategy 来源摘要同一公式）。最终重核按**内容身份**比较，不按裸
 *   revision：纯标签编辑递增 Task revision 但不改变策略副本身份，不误报
 *   业务失效（planDigest 同理不含策略副本，modelMap 默认变化天然不触发）；
 * - 权限面（ExecutionPermissionsFace）由可信装配注入的同步读取器提供
 * （不是请求字段，不能被 payload 伪造）：捕获阶段与最终写事务内各读一次，
 *   内容摘要不一致即权限变更拒绝；生产缺省 TRUSTED_PROJECT_PERMISSIONS_READER
 *   是 P03-2「无运行时授权面」的显式空集边界宣告，不是查询失败兜底；
 * - PreparedExecutionInputGroup 是可绑定输入的完整身份：同项目制品组引用、
 *   schemaVersion、各正文摘要（制品 contentHash + F-005 域摘要）、批准复合
 *   身份与策略/权限身份，供 P03-3/4 绑定到新 Run/Attempt；本契约不创建
 *   任何执行实体；
 * - 秘密纪律：请求与结果不携带正文/凭据字段（凭据只以引用表达）；错误
 *   details 只含身份键、摘要、字节数、限制值与脱敏原因，不含绝对路径或
 *   正文内容；
 * - 本契约不宣称文件系统与 SQLite 存在跨介质原子事务：制品索引经发布器
 *   各自短事务提交，事件/回执在最终写事务内原子提交（见
 *   application/execution-input-prepare.ts）。
 *
 * 实现者：application/execution-input-prepare.ts（准备编排与最终重核提交）；
 * 本层不实现任何存储、文件系统或组装行为。Host/CLI 接线属 F-007/F-008。
 */
import { createHash } from 'node:crypto';
import type { ContextReworkInput, ContextTokenEstimate } from './context-build.js';
import { CONTEXT_SNAPSHOT_DIGEST_DOMAIN } from './context-build.js';
import type { ExecutionInputRef } from './execution-input.js';
import type { PlanApprovalRecord, TaskDependencyRecord, TaskRecord } from './plan-store.js';
import type { FeatureRecord } from './plan-store.js';
import type { SettingsPayload } from './settings-schema.js';
import { stableStringify } from './feature-plan.js';

/* ------------------------------------------------------------------ *
 * 受控制品词汇（三正文各一条不可变受管 Artifact）
 * ------------------------------------------------------------------ */

/** 输入快照正文的制品 kind。 */
export const EXECUTION_SNAPSHOT_ARTIFACT_KIND = 'execution-snapshot';

/** 输入 manifest 正文的制品 kind。 */
export const EXECUTION_MANIFEST_ARTIFACT_KIND = 'execution-manifest';

/** prompt 正文的制品 kind。 */
export const EXECUTION_PROMPT_ARTIFACT_KIND = 'execution-prompt';

/** 制品组 locator 前缀（POSIX 相对；实际 locator = <前缀>/<taskId>/<part>）。 */
export const EXECUTION_INPUT_GROUP_LOCATOR_PREFIX = 'execution-input-groups';

/** snapshot 正文用途（进入 ExecutionInputRef.purpose 的受控词汇）。 */
export const EXECUTION_GROUP_SNAPSHOT_PURPOSE = 'snapshot';

/** manifest 正文用途。 */
export const EXECUTION_GROUP_MANIFEST_PURPOSE = 'manifest';

/** prompt 正文用途。 */
export const EXECUTION_GROUP_PROMPT_PURPOSE = 'prompt';

/** snapshot/manifest 正文的媒体类型（受控 JSON）。 */
export const EXECUTION_GROUP_JSON_MEDIA_TYPE = 'application/json';

/** prompt 正文的媒体类型。 */
export const EXECUTION_GROUP_PROMPT_MEDIA_TYPE = 'text/plain';

/* ------------------------------------------------------------------ *
 * 纯身份摘要（最终重核的比较基线；与 F-005 摘要域同一规范化规则）
 * ------------------------------------------------------------------ */

function domainDigest(domain: string, canonical: string): string {
  return createHash('sha256').update(`${domain}\n${canonical}`, 'utf8').digest('hex');
}

/**
 * Task 策略副本内容身份：executionConfig + configSource + configSourceKey 的
 * 规范化摘要（与 F-005 manifest task-strategy 来源摘要同一公式，二者按设计
 * 相等）。按内容比较使纯标签编辑（只递增 revision）不误报策略变更。
 */
export function computeExecutionStrategyCopyDigest(input: {
  readonly executionConfig: Readonly<Record<string, unknown>>;
  readonly configSource: string;
  readonly configSourceKey: string | null;
}): string {
  return domainDigest(
    CONTEXT_SNAPSHOT_DIGEST_DOMAIN,
    stableStringify({
      executionConfig: input.executionConfig,
      configSource: input.configSource,
      configSourceKey: input.configSourceKey,
    }),
  );
}

/** 权限面内容身份：grants 清单的规范化摘要（捕获与最终重核的比较基线）。 */
export function computeExecutionPermissionsDigest(grants: readonly string[]): string {
  return domainDigest(CONTEXT_SNAPSHOT_DIGEST_DOMAIN, stableStringify({ grants: [...grants] }));
}

/* ------------------------------------------------------------------ *
 * 权限面读取端口（可信装配注入；同步、无 I/O）
 * ------------------------------------------------------------------ */

/** 权限面：有界授予清单（数据，不是提权指令；进入 F-005 permissions 输入）。 */
export interface ExecutionPermissionsFace {
  readonly grants: readonly string[];
}

/**
 * 执行权限读取器：同一装配在捕获阶段与最终写事务内各调用一次，内容摘要
 * 不一致即权限变更拒绝。必须同步返回（最终重核在写事务内调用，不允许
 * 事务内等待外部 I/O）。
 */
export type ExecutionPermissionsReader = (input: {
  readonly projectId: string;
  readonly featureId: string;
  readonly taskId: string;
}) => ExecutionPermissionsFace;

/**
 * 生产缺省权限读取器：P03-2 存储没有运行时授权面（无 Run/Attempt/权限表），
 * 恒返回空授予清单。这是显式的能力边界宣告（空集亦是证据，与 F-005
 * permissions 契约一致），不是「读取失败当作空集」的兜底；运行时授权面
 * 随后续阶段引入时必须替换为真实权威读取并保持同一重核契约。
 */
export const TRUSTED_PROJECT_PERMISSIONS_READER: ExecutionPermissionsReader = () => ({
  grants: [],
});

/* ------------------------------------------------------------------ *
 * 一致状态视图（单一读事务内取得；实现者为 SQLite 适配器）
 * ------------------------------------------------------------------ */

/** 视图内配置 scope 快照（scopeRevision + 已校验 payload；缺失为 null）。 */
export interface PreparationSettingsScopeSnapshot {
  readonly scopeRevision: number;
  readonly payload: SettingsPayload;
}

/**
 * 执行输入准备一致读视图：Feature + 全部 Task + 全部依赖边 + 全部决策记录 +
 * 全局/项目当前配置。全部成分必须来自同一读事务（并发修订/决策/配置变化
 * 只能观察到完整前后状态，不存在新 Task 配旧边/旧摘要的混合状态）。
 */
export interface ExecutionInputPreparationView {
  readonly feature: FeatureRecord;
  readonly tasks: readonly TaskRecord[];
  readonly dependencies: readonly TaskDependencyRecord[];
  readonly approvals: readonly PlanApprovalRecord[];
  readonly settings: {
    readonly global: PreparationSettingsScopeSnapshot | null;
    readonly project: PreparationSettingsScopeSnapshot | null;
  };
}

/**
 * 执行输入准备视图读取端口：同一读事务内返回完整视图；目标 Feature 缺失
 * 返回 undefined（应用层折叠 not_found，与查询读取端口同一约定），跨项目抛
 * StorageError(ownership)。嵌套于写事务内调用是编程错误（实现者以
 * TypeError fail-closed）。
 */
export interface ExecutionInputPreparationViewStore {
  readExecutionInputPreparationView(
    projectId: string,
    featureId: string,
  ): ExecutionInputPreparationView | undefined;
}

/* ------------------------------------------------------------------ *
 * 制品组身份（结果形态；正文永不内联）
 * ------------------------------------------------------------------ */

/** 制品组单正文引用：身份级摘要（不是正文本身；核验以权威索引为准）。 */
export interface ExecutionInputGroupBodyRef {
  readonly artifactId: string;
  readonly version: number;
  /** 正文 SHA-256（制品索引 ready 后权威值；= 发布正文的字节摘要）。 */
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly locator: string;
  readonly mediaType: string;
}

/** 域摘要组（F-005 确定性摘要 + 策略/权限内容身份；labels 不参与）。 */
export interface ExecutionInputGroupDigests {
  /** snapshot 业务投影域摘要（CONTEXT_SNAPSHOT_DIGEST_DOMAIN）。 */
  readonly snapshotDigest: string;
  readonly manifestDigest: string;
  readonly promptDigest: string;
  /** Task 策略副本内容身份（最终重核基线）。 */
  readonly strategyCopyDigest: string;
  /** 权限面内容身份（最终重核基线）。 */
  readonly permissionsDigest: string;
}

/** 捕获视图内的批准复合身份（最终重核重算比较）。 */
export interface ExecutionInputApprovalIdentity {
  /** 捕获时 Feature 当前计划业务摘要。 */
  readonly planDigest: string;
  /** 捕获时适用检查政策内容摘要（F-003 复合身份成分）。 */
  readonly checkPolicyDigest: string;
  /** 绑定当前身份的决策记录 ID（证据引用；无则 null）。 */
  readonly decisionId: string | null;
  /** 捕获时 Feature 聚合 revision（记录用途，不是重核基线）。 */
  readonly featureRevision: number;
}

/**
 * F-012：受信返工准备 payload（仅由受信 Runner 路径构造；命令信封校验不接受
 * rework 键，用户命令不能伪造返工身份）。rework 形态复用 ContextBuild 契约，
 * 在应用层再校验一次（fail-closed）。
 */
export interface TrustedExecutionInputPreparePayload {
  readonly featureId: string;
  readonly taskId: string;
  /** 必需输入采集清单（可为空数组；逐项深校验在应用层）。 */
  readonly items: readonly Record<string, unknown>[];
  /** 可选同 Task 返工输入（F-011 契约；存在即生成返工快照）。 */
  readonly rework?: ContextReworkInput | null;
  /** P03-9 / F-007：可选同 Task 续接决策与来源快照。 */
  readonly recovery?: import('../ports/work-recovery-continuation.js').WorkRecoveryContinuationRecord | null;
}

/**
 * 已准备执行输入制品组（可绑定输入的完整身份）：同项目三正文引用、必需
 * 输入引用、schemaVersion、各正文摘要、批准/策略/权限身份。供 P03-3/4 绑定
 * 到新 Run/Attempt；不创建任何执行实体，也不声称已启动执行。
 * F-012：可选 rework 携带同 Task 返工身份（仅 schemaVersion 2 且返工构建存在；
 * 普通首次构建不携带该键，与 ContextBuilder 条件展开一致）。
 */
export interface PreparedExecutionInputGroup {
  readonly projectId: string;
  readonly featureId: string;
  readonly taskId: string;
  /** = ContextBuilder schemaVersion（制品组随 ContextBuilder 契约升版）。 */
  readonly schemaVersion: number;
  readonly group: {
    readonly snapshot: ExecutionInputGroupBodyRef;
    readonly manifest: ExecutionInputGroupBodyRef;
    readonly prompt: ExecutionInputGroupBodyRef;
  };
  readonly requiredInputs: readonly ExecutionInputRef[];
  readonly digests: ExecutionInputGroupDigests;
  readonly approval: ExecutionInputApprovalIdentity;
  /** 捕获时 Task revision（记录用途；重核按策略副本内容身份，不按裸 revision）。 */
  readonly taskRevision: number;
  readonly promptBytes: number;
  readonly tokenEstimate: ContextTokenEstimate;
  readonly preparedAtUtcMs: number;
  /** F-012：同 Task 返工身份（仅返工构建携带；普通首次构建不包含该键）。 */
  readonly rework?: ContextReworkInput;
  /** P03-9 / F-007：同 Task 续接记录（仅续接构建携带）。 */
  readonly recovery?: import('../ports/work-recovery-continuation.js').WorkRecoveryContinuationRecord;
}

/* ------------------------------------------------------------------ *
 * 失败类别（命令面公开错误映射表；细节见 application 层）
 * ------------------------------------------------------------------ */

/**
 * 准备失败原因词汇（进入 PublicError.details.reason 的受控子集）：
 * - 视图/目标：feature_not_found / task_not_in_plan / ownership_denied；
 * - 批准（捕获阶段 fail-fast，F-003 评估原因原样透传）：no_plan / no_tasks /
 *   not_approved / rejected / plan_changed / check_policy_changed /
 *   approval_state_inconsistent；
 * - 预算/正文：limit_exceeded / context_build_failed / source_unavailable /
 *   published_body_mismatch；
 * - 基础设施：publish_failed / timeout / file_io；
 * - 形态：validation（invalid_input 定位字段）。
 * 最终写事务内的身份漂移（plan/批准/策略/权限/制品）以 rejected 回执
 * reason 表达（同一词汇 + artifact 相关子集），不以异常抛出。
 */
export const EXECUTION_INPUT_PREPARE_FAILURE_REASONS = [
  'validation',
  'feature_not_found',
  'task_not_in_plan',
  'ownership_denied',
  'no_plan',
  'no_tasks',
  'not_approved',
  'rejected',
  'plan_changed',
  'check_policy_changed',
  'approval_state_inconsistent',
  'limit_exceeded',
  'context_build_failed',
  'source_unavailable',
  'published_body_mismatch',
  'publish_failed',
  'timeout',
  'file_io',
] as const;
export type ExecutionInputPrepareFailureReason =
  (typeof EXECUTION_INPUT_PREPARE_FAILURE_REASONS)[number];
