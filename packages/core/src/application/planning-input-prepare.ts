/**
 * P05-1 / F-004 规划输入准备编排（application 层）：
 * 一致视图捕获 → 事务外采集/组装/发布/正文复验 → 启动前事务外重核。
 *
 * 设计依据：ports/planning-input-prepare.ts（契约）、core-design/03 §4（文件
 * I/O 不在数据库事务内；发布 staging→校验→ready）、core-design/04 §3
 * （planning Task 使用已确认的需求与规划输入版本，不要求存在有效交付计划）、
 * core-design/05 §3（Attempt 固定输入引用与摘要）。实施契约：
 * docs/p05-1-planning-candidate-contract.md §6/§7。
 *
 * 不变量：
 * - 与编码 execution-input-prepare 同一三阶段纪律，但**不要求业务计划批准**：
 *   1) 捕获：单一 DEFERRED 一致读视图（规划上下文 + planning Task 业务字段 +
 *      Feature 当前身份 + 规划 Run 冻结请求快照）；视图内 fail-fast 重算
 *      inputDigest 并核对规划上下文（漂移/损坏明确拒绝，不修补）、核对目标
 *      Feature 计划摘要（内容身份，不按裸 revision）、planning Task 非终态；
 *   2) 组装与发布（事务外 I/O）：复用 F-004 ExecutionInputService 采集必需
 *      输入（需求制品来源核验归属与 ready；文件来源捕获实际字节发布为不可变
 *      制品）、规划专用纯组装（固定指导 + 冻结请求依据 + 目标身份 + 代码
 *      基线 + 用途策略副本 + 权限面 + 必需引用）、ArtifactPublisher 发布三
 *      正文并逐字节复验；代码基线经可信装配读取器从受管 worktree 现场核对
 *      （只读，不改变开发仓库分支/worktree）；
 *   3) 启动前重核（事务外，供派发/认领在提交或启动前调用）：规划上下文身份
 *      与状态、inputDigest、目标计划摘要、策略副本内容身份、权限面内容
 *      身份、全部制品索引（ready + hash/size/locator 一致）与代码基线逐一
 *      重核；任一漂移结构化拒绝并保留诊断，不以空 prompt 或可变本机绝对
 *      路径代替输入；
 * - 无业务计划（planDigest=null、planStatus=draft）也是完整规划输入：目标
 *   身份如实记录 null/draft，不引用任何业务计划批准身份，不伪造 plan
 *   approval（规划授权由 planning.start 回执与规划上下文承担）；
 * - 失败证据保留：任一必需制品缺失、篡改、超预算或发布失败都不留下可绑定
 *   的半完整制品组——已发布制品保持不可变（本身是可核对证据），不覆盖、
 *   不自动删除任何已有正式输入；
 * - 不创建 Batch/Run/Attempt、不启动 Runtime/Git/检查进程、不应用候选计划
 *   （F-005+ 职责）；凭据始终只有引用；
 * - 秘密纪律：错误 details 只含身份键、摘要、字节数、限制值与脱敏原因，
 *   不含绝对路径或正文内容。
 *
 * 本模块不实现：planning Run 派发与认领（F-005）、候选提交工具通道（F-006）、
 * Runtime 执行（F-007）。
 */
import { createHash } from 'node:crypto';
import { PublicError, mapStorageError } from '../ports/commands.js';
import { isStorageError, StorageError } from '../ports/errors.js';
import type { ArtifactInputRef } from '../ports/artifact-store.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type {
  ExecutionPermissionsFace,
  ExecutionPermissionsReader,
} from '../ports/execution-input-prepare.js';
import { stableStringify } from '../ports/feature-plan.js';
import {
  computePlanningCodeBaselineDigest,
  computePlanningPermissionsDigest,
  computePlanningStrategyCopyDigest,
  PLANNING_FIXED_GUIDANCE,
  PLANNING_GROUP_JSON_MEDIA_TYPE,
  PLANNING_GROUP_PROMPT_MEDIA_TYPE,
  PLANNING_INPUT_GROUP_LOCATOR_PREFIX,
  PLANNING_INPUT_GROUP_SCHEMA_VERSION,
  PLANNING_MANIFEST_ARTIFACT_KIND,
  PLANNING_MANIFEST_DIGEST_DOMAIN,
  PLANNING_PROMPT_ARTIFACT_KIND,
  PLANNING_PROMPT_DIGEST_DOMAIN,
  PLANNING_SNAPSHOT_ARTIFACT_KIND,
  PLANNING_SNAPSHOT_DIGEST_DOMAIN,
  validatePlanningCodeBaseline,
} from '../ports/planning-input-prepare.js';
import type {
  PlanningCodeBaseline,
  PlanningCodeBaselineReader,
  PlanningInputDigests,
  PlanningInputManifest,
  PlanningInputPreparationView,
  PlanningInputPreparationViewStore,
  PlanningInputSnapshot,
  PlanningInputGroupBodyRef,
  PlanningManifestSource,
  PreparedPlanningInputGroup,
} from '../ports/planning-input-prepare.js';
import { computePlanningInputDigest } from '../ports/planning-candidates.js';
import { isContextBuildError, ContextBuildError } from '../ports/context-build.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validateStableId,
  validationError,
} from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';
import { isExecutionInputError } from './execution-input.js';
import type { ExecutionInputService } from './execution-input.js';
import { isArtifactPublishError } from './artifact-publish.js';
import type { ArtifactPublisher } from './artifact-publish.js';
import { isArtifactVerifyError } from './artifact-verify.js';
import type { ArtifactVerifier } from './artifact-verify.js';

/** 规划输入准备操作名（PublicError.operation；内部端口，不是用户命令面）。 */
export const PLANNING_INPUT_PREPARE_OPERATION = 'planning.input.prepare' as const;

/**
 * F-004（P05-1）纯规则（可核对冻结面）：规划输入准备的影响面。发布同项目
 * 不可变规划三正文制品组并在启动前重核身份；不修改任何规划上下文/Run/Task
 * 状态、不创建执行实体、不启动 Runtime/Git/检查进程、不应用候选计划；旧
 * 制品永不改写；全程不进入写事务。
 */
export const PLANNING_INPUT_PREPARE_IMPACT = Object.freeze({
  publishesImmutableGroupArtifacts: true,
  capturesFromConsistentReadView: true,
  assemblesOutsideTransactions: true,
  rechecksOutsideWriteTransactions: true,
  createsExecutionEntities: false,
  startsRuntimeGitOrChecks: false,
  appliesPlanningCandidate: false,
  changesPlanningContextState: false,
  rewritesHistoricalArtifacts: false,
  credentialsRemainReferencesOnly: true,
});

/** 规划组装预算：显式有限（必需内容超限整体结构化失败，绝不截断）。 */
export interface PlanningInputContextBudget {
  readonly maxPromptBytes: number;
  readonly maxRequiredSnapshotBytes: number;
  readonly maxRequiredInputRefs: number;
}

/** 生产/测试共用缺省预算（与编码 DEFAULT_EXECUTION_INPUT_CONTEXT_BUDGET 同量级）。 */
export const DEFAULT_PLANNING_INPUT_CONTEXT_BUDGET: Readonly<PlanningInputContextBudget> =
  Object.freeze({
    maxPromptBytes: 400_000,
    maxRequiredSnapshotBytes: 300_000,
    maxRequiredInputRefs: 64,
  });

/** 准备预算：单次准备的最大必需输入条数（含自动采集的需求制品引用）。 */
export interface PlanningInputPrepareLimits {
  readonly maxRequiredItems: number;
}

export const DEFAULT_PLANNING_INPUT_PREPARE_LIMITS: Readonly<PlanningInputPrepareLimits> =
  Object.freeze({ maxRequiredItems: 16 });

/** planning Task 终态（不可再准备输入）。 */
const PLANNING_TASK_TERMINAL_STATUSES = ['passed', 'failed', 'skipped', 'cancelled'] as const;

/** 准备服务装配依赖（全部窄端口/用例；不接触具体适配器）。 */
export interface PlanningInputPrepareServiceDeps {
  readonly views: PlanningInputPreparationViewStore;
  readonly inputs: ExecutionInputService;
  readonly artifacts: ArtifactStore;
  readonly publisher: ArtifactPublisher;
  readonly verifier: ArtifactVerifier;
  readonly permissions: ExecutionPermissionsReader;
  readonly readCodeBaseline: PlanningCodeBaselineReader;
  readonly limits: PlanningInputPrepareLimits;
  readonly budget?: PlanningInputContextBudget;
  /** 时间源（默认 Date.now；测试注入以获得确定性）。 */
  readonly nowMs?: () => number;
}

/**
 * 规划输入准备端口：供 planning Run 派发/认领（F-005+）在提交或启动前调用。
 * 全程写事务外；不创建执行实体。
 */
export interface PlanningInputPreparePort {
  /** 事务外准备（视图捕获 + 采集 + 组装 + 发布 + 正文复验）；失败抛 PublicError。 */
  preparePlanningInput(
    projectId: string,
    payload: { readonly runId: string; readonly items?: readonly Record<string, unknown>[] },
  ): Promise<PreparedPlanningInputGroup>;
  /** 启动前重核（事务外）：身份/状态/摘要/制品索引/代码基线漂移明确拒绝。 */
  recheckPlanningInputPreparation(
    projectId: string,
    prepared: PreparedPlanningInputGroup,
  ): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

const OPERATION = PLANNING_INPUT_PREPARE_OPERATION;

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

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function domainDigest(domain: string, canonical: string): string {
  return createHash('sha256').update(`${domain}\n${canonical}`, 'utf8').digest('hex');
}

/** 权限面形态核验（fail-closed：装配契约被违反即 corrupt_state，不静默兜底）。 */
function readPermissionsFace(
  reader: ExecutionPermissionsReader,
  input: { readonly projectId: string; readonly featureId: string; readonly taskId: string },
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

/** 视图请求快照重算 inputDigest：以 planning Task 存储的原始请求引用（F-003
 *  原样持久）为基准——Run.inputSnapshot 内是解析后形态（含 version），不是
 *  摘要计算基准；与 F-001 computePlanningInputDigest 同一公式。 */
function recomputeBasisDigest(
  view: PlanningInputPreparationView,
): string {
  const basis = view.run.inputSnapshot;
  return computePlanningInputDigest({
    projectId: view.context.projectId,
    phaseId: view.context.phaseId,
    featureId: view.context.featureId,
    requirementRefs: [...view.planningTask.requirementsRefs],
    constraints: [...basis.constraints],
    acceptance: { criteria: [...basis.acceptance.criteria] },
    strategy: { approvalMode: basis.strategy.approvalMode, taskLimit: basis.strategy.taskLimit },
  });
}

/* ------------------------------------------------------------------ *
 * 纯组装（规划专用 snapshot/manifest/prompt；相同输入逐字节可复现）
 * ------------------------------------------------------------------ */

/** 纯组装输入（全部为已校验形态；无 I/O）。 */
export interface PlanningContextBuildInput {
  readonly view: PlanningInputPreparationView;
  readonly permissions: { readonly grants: readonly string[] };
  readonly requiredInputs: readonly import('../ports/execution-input.js').ExecutionInputRef[];
  readonly codeBaseline: PlanningCodeBaseline;
}

/** 纯组装结果（正文与确定性摘要；由调用方发布为不可变制品）。 */
export interface PlanningContextBuildResult {
  readonly schemaVersion: typeof PLANNING_INPUT_GROUP_SCHEMA_VERSION;
  readonly snapshot: PlanningInputSnapshot;
  readonly manifest: PlanningInputManifest;
  readonly prompt: string;
  readonly digests: PlanningInputDigests;
  readonly promptBytes: number;
}

function buildLimitError(limitName: string, message: string, details: Record<string, unknown>): ContextBuildError {
  return new ContextBuildError('limit_exceeded', `PlanningInputContext.build: ${message}`, {
    field: limitName,
    details,
  });
}

/**
 * 规划输入纯组装（无 I/O、无时钟；相同输入必然产生相同输出）。固定指导 +
 * 冻结请求依据 + 目标身份 + 代码基线 + 用途策略副本 + 权限面 + 必需引用；
 * 必需内容超预算整体结构化失败，绝不截断换取成功。
 */
export function buildPlanningInputBodies(
  input: PlanningContextBuildInput,
  budget: PlanningInputContextBudget = DEFAULT_PLANNING_INPUT_CONTEXT_BUDGET,
): PlanningContextBuildResult {
  const { view, permissions, requiredInputs, codeBaseline } = input;
  const basis = view.run.inputSnapshot;

  if (requiredInputs.length > budget.maxRequiredInputRefs) {
    throw buildLimitError('budget.maxRequiredInputRefs', '必需输入引用数量超限', {
      limitName: 'maxRequiredInputRefs',
      measured: requiredInputs.length,
      limit: budget.maxRequiredInputRefs,
    });
  }

  const strategyCopyDigest = computePlanningStrategyCopyDigest({
    executionConfig: view.planningTask.executionConfig as unknown as Readonly<Record<string, unknown>>,
    configSource: view.planningTask.configSource,
    configSourceKey: view.planningTask.configSourceKey,
  });
  const permissionsDigest = computePlanningPermissionsDigest(permissions.grants);
  const codeBaselineDigest = computePlanningCodeBaselineDigest(codeBaseline);

  const snapshot: PlanningInputSnapshot = {
    schemaVersion: PLANNING_INPUT_GROUP_SCHEMA_VERSION,
    kind: 'planning-input',
    projectId: view.context.projectId,
    phaseId: view.context.phaseId,
    featureId: view.context.featureId,
    runId: view.run.id,
    planningTaskId: view.planningTask.id,
    candidateId: view.context.candidateId,
    request: {
      inputDigest: basis.inputDigest,
      requirementRefs: [...basis.requirementRefs],
      constraints: [...basis.constraints],
      acceptance: { criteria: [...basis.acceptance.criteria] },
      strategy: { approvalMode: basis.strategy.approvalMode, taskLimit: basis.strategy.taskLimit },
    },
    target: {
      featureRevision: view.feature.revision,
      planDigest: view.feature.planDigest,
      planStatus: view.feature.planStatus,
    },
    codeBaseline,
    purposeStrategy: {
      executionConfig: view.planningTask.executionConfig,
      configSource: view.planningTask.configSource,
      configSourceKey: view.planningTask.configSourceKey,
    },
    permissions: { grants: [...permissions.grants] },
    requiredInputs: [...requiredInputs],
  };

  const requiredBytes = utf8Bytes(stableStringify(snapshot));
  if (requiredBytes > budget.maxRequiredSnapshotBytes) {
    throw buildLimitError('budget.maxRequiredSnapshotBytes', '必需正文规范化字节数超限', {
      limitName: 'maxRequiredSnapshotBytes',
      measuredBytes: requiredBytes,
      limitBytes: budget.maxRequiredSnapshotBytes,
    });
  }

  /* prompt 骨架（固定指导 + 全部必需内容；不内联正文）。 */
  const strategyCopy = view.planningTask.executionConfig;
  const lines: string[] = [PLANNING_FIXED_GUIDANCE, ''];
  lines.push('## Planning target');
  lines.push(`- projectId: ${snapshot.projectId}`);
  lines.push(`- phaseId: ${snapshot.phaseId}`);
  lines.push(`- featureId: ${snapshot.featureId}`);
  lines.push(`- runId: ${snapshot.runId}（purpose=plan，一次性规划）`);
  lines.push(`- planningTaskId: ${snapshot.planningTaskId}`);
  lines.push(`- candidateId: ${snapshot.candidateId}`);
  lines.push(
    `- target: featureRevision=${snapshot.target.featureRevision}，planDigest=${snapshot.target.planDigest ?? 'null（首次规划草稿，无既有业务计划）'}，planStatus=${snapshot.target.planStatus}`,
  );
  lines.push('');
  lines.push(`## Planning request (frozen at planning.start; inputDigest=${basis.inputDigest})`);
  lines.push('### Constraints');
  if (basis.constraints.length === 0) {
    lines.push('- （无显式约束）');
  } else {
    for (const constraint of basis.constraints) {
      lines.push(`- ${constraint}`);
    }
  }
  lines.push('### Acceptance (required; complete; 不得删项)');
  for (const criterion of basis.acceptance.criteria) {
    lines.push(`- ${criterion}`);
  }
  lines.push('### Requirement artifacts (read each via reference and verify hash)');
  if (basis.requirementRefs.length === 0) {
    lines.push('- （无需求制品引用）');
  } else {
    for (const ref of basis.requirementRefs) {
      lines.push(
        `- artifactId=${ref.artifactId}${ref.contentHash === undefined ? '' : ` contentHash=${ref.contentHash}`}`,
      );
    }
  }
  lines.push('');
  lines.push('## Approval strategy (human decision boundary)');
  lines.push(`- approvalMode: ${basis.strategy.approvalMode}（候选由人工批准；模型不能自批通过）`);
  lines.push(
    `- taskLimit: ${basis.strategy.taskLimit === null ? 'null（不设上限）' : String(basis.strategy.taskLimit)}`,
  );
  lines.push('');
  lines.push('## Code baseline (designated snapshot; read-only; verify before relying)');
  lines.push(`- worktreeId: ${codeBaseline.worktreeId}`);
  lines.push(`- headCommit: ${codeBaseline.headCommit}`);
  lines.push(`- codeDigest: ${codeBaseline.codeDigest}`);
  lines.push('');
  lines.push(
    `## Purpose strategy (actual copy; source: ${view.planningTask.configSource}${
      view.planningTask.configSourceKey === null ? '' : `; key: ${view.planningTask.configSourceKey}`
    })`,
  );
  lines.push(`- runtime: ${strategyCopy.runtime}`);
  lines.push(`- provider: ${strategyCopy.provider}`);
  lines.push(`- model: ${strategyCopy.model}`);
  if (strategyCopy.credentialRef !== undefined) {
    lines.push(`- credentialRef: ${strategyCopy.credentialRef}（凭据只有引用，不内联正文）`);
  }
  if (strategyCopy.endpointRef !== undefined) {
    lines.push(`- endpointRef: ${strategyCopy.endpointRef}`);
  }
  lines.push('');
  lines.push('## Permissions');
  if (permissions.grants.length === 0) {
    lines.push('- （空集亦是证据：P03 边界宣告，不是读取失败兜底）');
  } else {
    for (const grant of permissions.grants) {
      lines.push(`- ${grant}`);
    }
  }
  lines.push('');
  lines.push('## Required inputs (must read each before planning; verify hash)');
  for (const ref of requiredInputs) {
    lines.push(
      `- purpose=${ref.purpose} artifactId=${ref.artifactId} version=${ref.version} contentHash=${ref.contentHash} sizeBytes=${ref.sizeBytes} locator=${ref.locator}`,
    );
  }
  const prompt = lines.join('\n');
  const promptBytes = utf8Bytes(prompt);
  if (promptBytes > budget.maxPromptBytes) {
    throw buildLimitError('budget.maxPromptBytes', '必需内容 prompt 字节数超限（不删减验收条目）', {
      limitName: 'maxPromptBytes',
      measuredBytes: promptBytes,
      limitBytes: budget.maxPromptBytes,
    });
  }

  /* manifest：逐来源选取证据。 */
  const guidanceHash = domainDigest(PLANNING_SNAPSHOT_DIGEST_DOMAIN, PLANNING_FIXED_GUIDANCE);
  const sources: PlanningManifestSource[] = [
    {
      sourceId: 'planning-guidance',
      kind: 'planning-guidance',
      identity: null,
      version: PLANNING_INPUT_GROUP_SCHEMA_VERSION,
      hash: guidanceHash,
      purpose: 'fixed-planning-guidance',
      selection: 'full',
      required: true,
      reason: 'Core 固定规划指导：候选 schema、独立提交操作、一次性结束与人工批准边界（不可被输入覆盖）',
    },
    {
      sourceId: `planning-request:${basis.inputDigest}`,
      kind: 'planning-request',
      identity: { runId: view.run.id, candidateId: view.context.candidateId },
      version: null,
      hash: basis.inputDigest,
      purpose: 'frozen-planning-request',
      selection: 'full (requirementRefs/constraints/acceptance/strategy)',
      required: true,
      reason: 'planning.start 冻结的一次性规划请求 v1 语义内容（inputDigest 域摘要原样引用）',
    },
    {
      sourceId: `planning-basis:${snapshot.candidateId}`,
      kind: 'planning-basis',
      identity: { featureId: snapshot.featureId, targetRevision: view.context.targetRevision },
      version: null,
      hash: domainDigest(
        PLANNING_SNAPSHOT_DIGEST_DOMAIN,
        stableStringify({
          targetRevision: view.context.targetRevision,
          planDigest: view.context.planDigest,
          candidateId: view.context.candidateId,
          featureRevision: view.feature.revision,
          featurePlanDigest: view.feature.planDigest,
        }),
      ),
      purpose: 'planning-target-basis',
      selection: 'full (target revision/plan digest/candidate identity)',
      required: true,
      reason: '规划目标依据：目标 Feature revision 与计划摘要（首次草稿为 null，如实记录，不伪造批准）',
    },
    {
      sourceId: `code-baseline:${codeBaseline.worktreeId}`,
      kind: 'code-baseline',
      identity: { worktreeId: codeBaseline.worktreeId },
      version: null,
      hash: codeBaselineDigest,
      purpose: 'designated-code-snapshot',
      selection: 'identity (worktreeId/headCommit/codeDigest)',
      required: true,
      reason: '受管 worktree 代码基线身份（指定代码快照；只读绑定，不改变开发仓库分支/worktree）',
    },
    {
      sourceId: `purpose-strategy:${view.planningTask.id}`,
      kind: 'purpose-strategy',
      identity: { planningTaskId: view.planningTask.id },
      version: null,
      hash: strategyCopyDigest,
      purpose: 'purpose-strategy-copy',
      selection: 'full (executionConfig copy/configSource/configSourceKey)',
      required: true,
      reason: '冻结的规划用途策略副本（按副本执行，不重读路由配置）',
    },
    {
      sourceId: 'permissions',
      kind: 'permissions',
      identity: null,
      version: null,
      hash: permissionsDigest,
      purpose: 'permissions-face',
      selection: 'full (grants list)',
      required: true,
      reason: '可信装配注入的权限面（空集亦是证据；模型不获得未选择的全局资源）',
    },
    ...requiredInputs.map((ref, index): PlanningManifestSource => ({
      sourceId: `required-input:${ref.purpose}`,
      kind: 'required-input',
      identity: { artifactId: ref.artifactId },
      version: ref.version,
      hash: ref.contentHash,
      purpose: `required-input:${ref.purpose}`,
      selection: index === 0 && requiredInputs.length === 1 ? 'full' : 'full',
      required: true,
      reason: '必需输入（规划前逐项读取并核对 hash）',
    })),
  ];

  const promptDigest = domainDigest(PLANNING_PROMPT_DIGEST_DOMAIN, prompt);
  const snapshotDigest = domainDigest(PLANNING_SNAPSHOT_DIGEST_DOMAIN, stableStringify(snapshot));
  const manifest: PlanningInputManifest = {
    schemaVersion: PLANNING_INPUT_GROUP_SCHEMA_VERSION,
    projectId: snapshot.projectId,
    phaseId: snapshot.phaseId,
    featureId: snapshot.featureId,
    runId: snapshot.runId,
    planningTaskId: snapshot.planningTaskId,
    candidateId: snapshot.candidateId,
    sources,
    promptDigest,
  };
  const manifestDigest = domainDigest(PLANNING_MANIFEST_DIGEST_DOMAIN, stableStringify(manifest));

  return {
    schemaVersion: PLANNING_INPUT_GROUP_SCHEMA_VERSION,
    snapshot,
    manifest,
    prompt,
    digests: {
      snapshotDigest,
      manifestDigest,
      promptDigest,
      strategyCopyDigest,
      permissionsDigest,
      codeBaselineDigest,
    },
    promptBytes,
  };
}

/* ------------------------------------------------------------------ *
 * 服务装配与编排
 * ------------------------------------------------------------------ */

/**
 * 装配规划输入准备服务。只校验依赖形态与预算（fail-closed），不执行任何
 * I/O；import 本模块无副作用。返回派发/认领消费端口（准备 + 启动前重核）。
 */
export function createPlanningInputPrepareService(
  deps: PlanningInputPrepareServiceDeps,
): PlanningInputPreparePort {
  const context: ValidationContext = { operation: `${OPERATION}.create` };
  if (deps === null || typeof deps !== 'object') {
    throw validationError(context, 'deps', '必须提供 views/inputs/publisher/verifier/permissions/readCodeBaseline/limits 装配依赖');
  }
  for (const [field, value] of [
    ['views', deps.views],
    ['inputs', deps.inputs],
    ['artifacts', deps.artifacts],
    ['publisher', deps.publisher],
    ['verifier', deps.verifier],
    ['permissions', deps.permissions],
    ['readCodeBaseline', deps.readCodeBaseline],
  ] as const) {
    if (typeof value !== 'function' && (value === null || typeof value !== 'object')) {
      throw validationError(context, `deps.${field}`, `必须提供 ${field} 端口/用例实现`);
    }
  }
  const limitsObject = requirePlainObject(deps.limits, context, 'limits');
  rejectUnknownKeys(limitsObject, ['maxRequiredItems'], context, 'limits');
  if (!Number.isSafeInteger(limitsObject.maxRequiredItems) || (limitsObject.maxRequiredItems as number) < 1) {
    throw validationError(context, 'limits.maxRequiredItems', '必须是 ≥1 的安全整数', limitsObject.maxRequiredItems);
  }
  const limits: PlanningInputPrepareLimits = { maxRequiredItems: limitsObject.maxRequiredItems as number };
  const budget = deps.budget ?? DEFAULT_PLANNING_INPUT_CONTEXT_BUDGET;
  const nowMs = deps.nowMs ?? Date.now;
  const { views, inputs, artifacts, publisher, verifier, permissions, readCodeBaseline } = deps;

  /** 发布单个组正文并返回身份引用（expectedHash = 正文字节摘要）。 */
  async function publishGroupBody(
    projectId: string,
    planningTaskId: string,
    part: 'snapshot' | 'manifest' | 'prompt',
    body: string,
  ): Promise<PlanningInputGroupBodyRef> {
    const bodyBuffer = Buffer.from(body, 'utf8');
    const expectedHash = sha256Hex(bodyBuffer);
    const spec = {
      snapshot: { kind: PLANNING_SNAPSHOT_ARTIFACT_KIND, mediaType: PLANNING_GROUP_JSON_MEDIA_TYPE },
      manifest: { kind: PLANNING_MANIFEST_ARTIFACT_KIND, mediaType: PLANNING_GROUP_JSON_MEDIA_TYPE },
      prompt: { kind: PLANNING_PROMPT_ARTIFACT_KIND, mediaType: PLANNING_GROUP_PROMPT_MEDIA_TYPE },
    }[part];
    let published;
    try {
      published = await publisher.publishArtifact({
        projectId,
        kind: spec.kind,
        mediaType: spec.mediaType,
        expectedHash,
        locator: `${PLANNING_INPUT_GROUP_LOCATOR_PREFIX}/${planningTaskId}/${part}`,
        content: [bodyBuffer],
      });
    } catch (cause) {
      if (isArtifactPublishError(cause)) {
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
    ref: PlanningInputGroupBodyRef,
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

  /** 视图读取 + 统一错误映射（not_found/ownership/存储错误）。 */
  function readView(projectId: string, runId: string): PlanningInputPreparationView {
    let view: PlanningInputPreparationView | undefined;
    try {
      view = views.readPlanningInputPreparationView(projectId, runId);
    } catch (cause) {
      if (isStorageError(cause, 'ownership')) {
        throw publicError('forbidden', 'ownership_denied', { entityType: 'run' }, cause);
      }
      if (isStorageError(cause)) {
        throw mapStorageError(cause, { operation: OPERATION });
      }
      throw cause;
    }
    if (view === undefined) {
      throw publicError('not_found', 'planning_run_not_found', { entityType: 'run' });
    }
    return view;
  }

  /** 视图内 fail-fast 一致性核验（捕获与重核共用；漂移明确拒绝）。 */
  function assertViewConsistent(view: PlanningInputPreparationView): void {
    if (view.run.purpose !== 'plan') {
      throw publicError('conflict', 'run_purpose_mismatch', { entityType: 'run', purpose: view.run.purpose });
    }
    if (view.context.status !== 'open') {
      throw publicError('conflict', 'planning_context_not_open', {
        entityType: 'planning_context',
        status: view.context.status,
      });
    }
    if (PLANNING_TASK_TERMINAL_STATUSES.includes(view.planningTask.status as (typeof PLANNING_TASK_TERMINAL_STATUSES)[number])) {
      throw publicError('conflict', 'planning_task_terminal', {
        entityType: 'task',
        status: view.planningTask.status,
      });
    }
    if (view.context.planningTaskId !== view.planningTask.id || view.context.runId !== view.run.id) {
      throw publicError('corrupt_state', 'planning_task_missing', { entityType: 'planning_context' });
    }
    const basis = view.run.inputSnapshot;
    if (basis.candidateId !== view.context.candidateId) {
      throw publicError('corrupt_state', 'input_snapshot_invalid', { entityType: 'planning_context' });
    }
    if (recomputeBasisDigest(view) !== view.context.inputDigest) {
      throw publicError('corrupt_state', 'input_digest_mismatch', {
        entityType: 'planning_context',
        expectedDigest: view.context.inputDigest,
      });
    }
    if (view.feature.planDigest !== view.context.planDigest) {
      throw publicError('conflict', 'feature_plan_drift', {
        entityType: 'feature',
        planningBasis: view.context.planDigest,
        current: view.feature.planDigest,
      });
    }
    /* planning Task 业务字段与 Run 冻结请求快照一致（同一启动事务写入；
     * 验收条目逐字相等，需求引用按 artifactId 集合相等——Run 存储的是解析后
     * 形态（含 version），Task 存储原始请求引用）。漂移即损坏/漂移，fail-closed。 */
    if (JSON.stringify(view.planningTask.acceptance.criteria) !== JSON.stringify(basis.acceptance.criteria)) {
      throw publicError('corrupt_state', 'input_snapshot_invalid', { entityType: 'task' });
    }
    const taskArtifactIds = view.planningTask.requirementsRefs.map((ref) => ref.artifactId).sort();
    const basisArtifactIds = basis.requirementRefs.map((ref) => ref.artifactId).sort();
    if (JSON.stringify(taskArtifactIds) !== JSON.stringify(basisArtifactIds)) {
      throw publicError('corrupt_state', 'input_snapshot_invalid', { entityType: 'task' });
    }
  }

  /** 读取代码基线（可信装配；写事务外真实 I/O；无受管工作区结构化失败）。 */
  async function captureCodeBaseline(projectId: string, featureId: string): Promise<PlanningCodeBaseline> {
    let raw: PlanningCodeBaseline | null;
    try {
      raw = await readCodeBaseline({ projectId, featureId });
    } catch (cause) {
      if (isStorageError(cause)) {
        throw mapStorageError(cause, { operation: OPERATION });
      }
      throw publicError('internal', 'code_baseline_invalid', undefined, cause);
    }
    if (raw === null) {
      throw publicError('conflict', 'code_baseline_unavailable', { entityType: 'feature', featureId });
    }
    try {
      return validatePlanningCodeBaseline(raw, { operation: `${OPERATION}.baseline` }, 'baseline');
    } catch (cause) {
      if (isStorageError(cause)) {
        throw publicError('corrupt_state', 'code_baseline_invalid', undefined, cause);
      }
      throw cause;
    }
  }

  return {
    async preparePlanningInput(projectId, payload) {
      /* 0) 载荷校验（runId 必需；items 可选追加文件来源）。 */
      const rawPayload = requirePlainObject(payload, { operation: OPERATION }, 'payload');
      rejectUnknownKeys(rawPayload, ['runId', 'items'], { operation: OPERATION }, 'payload');
      const runId = validateStableId(rawPayload.runId, { operation: OPERATION }, 'payload.runId');
      const extraItems: readonly Record<string, unknown>[] =
        rawPayload.items === undefined ? [] : (rawPayload.items as readonly Record<string, unknown>[]);

      /* 1) 一致读视图捕获 + fail-fast 一致性核验。 */
      const view = readView(projectId, runId);
      assertViewConsistent(view);

      /* 2) 权限面捕获（可信装配读取器；请求不能伪造）。 */
      const permissionsFace = readPermissionsFace(permissions, {
        projectId,
        featureId: view.feature.id,
        taskId: view.planningTask.id,
      });

      /* 3) 必需输入采集（事务外 I/O）：以 planning Task 持久的原始需求引用（用户
       * 批准的请求语义）自动采集 + 可选追加项。 */
      const basis = view.run.inputSnapshot;
      const requirementItems = view.planningTask.requirementsRefs.map((ref) => ({
        purpose: 'requirements',
        source: { kind: 'artifact', artifactId: ref.artifactId },
      }));
      const seenArtifactIds = new Set(requirementItems.map((item) => (item.source as { artifactId: string }).artifactId));
      const dedupedExtras = extraItems.filter((item) => {
        const source = (item as { source?: { kind?: string; artifactId?: string } }).source;
        if (source?.kind === 'artifact' && typeof source.artifactId === 'string') {
          if (seenArtifactIds.has(source.artifactId)) {
            return false;
          }
          seenArtifactIds.add(source.artifactId);
        }
        return true;
      });
      const items = [...requirementItems, ...dedupedExtras];
      if (items.length > limits.maxRequiredItems) {
        throw publicError('invalid_input', 'limit_exceeded', {
          limit: 'maxRequiredItems',
          maxRequiredItems: limits.maxRequiredItems,
          actualItems: items.length,
        });
      }
      /* 空必需输入集是合法规划状态（空草稿首次规划：冻结请求未引用任何需求
       * 制品且未追加文件来源）——显式记录为空清单，不调用采集（采集契约要求
       * 非空集），不静默省略字段。 */
      let captured: { readonly refs: readonly import('../ports/execution-input.js').ExecutionInputRef[] };
      if (items.length === 0) {
        captured = { refs: [] };
      } else {
        try {
          captured = await inputs.captureRequiredInputs({
            projectId,
            taskId: view.planningTask.id,
            items,
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
      }

      /* 4) 代码基线捕获（事务外真实 Git 现场；只读）。 */
      const codeBaseline = await captureCodeBaseline(projectId, view.feature.id);

      /* 5) 规划专用纯组装（无 I/O；超预算整体结构化失败）。 */
      let built: PlanningContextBuildResult;
      try {
        built = buildPlanningInputBodies(
          { view, permissions: { grants: [...permissionsFace.grants] }, requiredInputs: captured.refs, codeBaseline },
          budget,
        );
      } catch (cause) {
        if (isContextBuildError(cause)) {
          throw publicError(
            'invalid_input',
            cause.code === 'limit_exceeded' ? 'limit_exceeded' : 'context_build_failed',
            { field: cause.field ?? undefined, ...(cause.details ?? {}) },
            cause,
          );
        }
        if (isStorageError(cause)) {
          throw mapStorageError(cause, { operation: OPERATION });
        }
        throw cause;
      }

      /* 6) 三正文序列化 + 发布 + 正文复验（事务外文件 I/O；失败保留证据）。 */
      const snapshotBody = stableStringify(built.snapshot);
      const manifestBody = stableStringify(built.manifest);
      const promptBody = built.prompt;
      const snapshotRef = await publishGroupBody(projectId, view.planningTask.id, 'snapshot', snapshotBody);
      const manifestRef = await publishGroupBody(projectId, view.planningTask.id, 'manifest', manifestBody);
      const promptRef = await publishGroupBody(projectId, view.planningTask.id, 'prompt', promptBody);
      await verifyGroupBody(projectId, 'snapshot', snapshotRef, snapshotBody);
      await verifyGroupBody(projectId, 'manifest', manifestRef, manifestBody);
      await verifyGroupBody(projectId, 'prompt', promptRef, promptBody);

      return {
        projectId,
        phaseId: view.context.phaseId,
        featureId: view.feature.id,
        runId: view.run.id,
        planningTaskId: view.planningTask.id,
        candidateId: view.context.candidateId,
        schemaVersion: built.schemaVersion,
        group: { snapshot: snapshotRef, manifest: manifestRef, prompt: promptRef },
        requiredInputs: captured.refs,
        digests: { ...built.digests },
        preparedAtUtcMs: nowMs(),
      };
    },

    async recheckPlanningInputPreparation(projectId, prepared) {
      /* 1) 一致读视图重核：身份绑定、状态与内容身份。 */
      const view = readView(projectId, prepared.runId);
      if (
        view.context.planningTaskId !== prepared.planningTaskId ||
        view.context.candidateId !== prepared.candidateId ||
        view.planningTask.id !== prepared.planningTaskId ||
        view.run.id !== prepared.runId
      ) {
        throw publicError('conflict', 'planning_task_missing', { entityType: 'planning_context' });
      }
      assertViewConsistent(view);

      /* 2) 策略副本内容身份重核（纯标签/状态推进不改变内容身份）。 */
      const strategyCopyDigest = computePlanningStrategyCopyDigest({
        executionConfig: view.planningTask.executionConfig as unknown as Readonly<Record<string, unknown>>,
        configSource: view.planningTask.configSource,
        configSourceKey: view.planningTask.configSourceKey,
      });
      if (strategyCopyDigest !== prepared.digests.strategyCopyDigest) {
        throw publicError('conflict', 'strategy_copy_changed', { entityType: 'task' });
      }

      /* 3) 权限面内容身份重核（同一装配读取；漂移即拒绝）。 */
      const permissionsFace = readPermissionsFace(permissions, {
        projectId,
        featureId: view.feature.id,
        taskId: view.planningTask.id,
      });
      if (computePlanningPermissionsDigest(permissionsFace.grants) !== prepared.digests.permissionsDigest) {
        throw publicError('conflict', 'permissions_changed', { entityType: 'task' });
      }

      /* 4) 全部制品索引重核：三正文 + 每条必需输入必须 ready 且身份一致；三正文
       *    另做字节级正文复验（readVerifiedContent：ready + 索引一致 + 实测摘要
       *    一致）——正文篡改在启动前明确拒绝，不以索引一致代替内容身份。 */
      const checks: readonly { label: string; ref: { readonly artifactId: string; readonly contentHash: string; readonly sizeBytes: number; readonly locator: string } }[] = [
        { label: 'snapshot', ref: prepared.group.snapshot },
        { label: 'manifest', ref: prepared.group.manifest },
        { label: 'prompt', ref: prepared.group.prompt },
        ...prepared.requiredInputs.map((ref, index) => ({ label: `required-input[${index}]`, ref })),
      ];
      for (const check of checks) {
        let indexRef: ArtifactInputRef;
        try {
          indexRef = await artifacts.getArtifactInputRef(projectId, check.ref.artifactId);
        } catch (cause) {
          if (isStorageError(cause, 'not_found')) {
            throw publicError('conflict', 'artifact_missing', { artifactId: check.ref.artifactId, part: check.label }, cause);
          }
          if (isStorageError(cause, 'conflict')) {
            throw publicError('conflict', 'artifact_not_ready', { artifactId: check.ref.artifactId, part: check.label }, cause);
          }
          if (isStorageError(cause)) {
            throw mapStorageError(cause, { operation: OPERATION });
          }
          throw cause;
        }
        if (
          indexRef.contentHash !== check.ref.contentHash ||
          indexRef.sizeBytes !== check.ref.sizeBytes ||
          indexRef.locator !== check.ref.locator
        ) {
          throw publicError('conflict', 'artifact_changed', { artifactId: check.ref.artifactId, part: check.label });
        }
      }
      const bodyChecks = [
        { part: 'snapshot' as const, ref: prepared.group.snapshot },
        { part: 'manifest' as const, ref: prepared.group.manifest },
        { part: 'prompt' as const, ref: prepared.group.prompt },
      ];
      for (const check of bodyChecks) {
        try {
          const verified = await verifier.readVerifiedContent(projectId, check.ref.artifactId);
          if (
            verified.contentHash !== check.ref.contentHash ||
            verified.sizeBytes !== check.ref.sizeBytes ||
            verified.locator !== check.ref.locator
          ) {
            throw publicError('corrupt_state', 'published_body_mismatch', { part: check.part, artifactId: check.ref.artifactId });
          }
        } catch (cause) {
          if (cause instanceof PublicError) throw cause;
          if (isArtifactVerifyError(cause)) {
            throw publicError(
              cause.code === 'not_found' ? 'conflict' : 'corrupt_state',
              cause.code === 'not_found' ? 'artifact_missing' : 'published_body_mismatch',
              { part: check.part, artifactId: check.ref.artifactId, verifyCode: cause.code },
              cause,
            );
          }
          throw cause;
        }
      }

      /* 5) 代码基线重核（事务外真实 Git 现场；漂移即阻止启动）。 */
      const baseline = await captureCodeBaseline(projectId, view.feature.id);
      if (computePlanningCodeBaselineDigest(baseline) !== prepared.digests.codeBaselineDigest) {
        throw publicError('conflict', 'code_baseline_drift', {
          entityType: 'feature',
          worktreeId: baseline.worktreeId,
        });
      }
    },
  };
}

/** F-004 采集错误 → 规划输入准备公开错误（details 携带脱敏原因/限制；
 *  reason 固定为受控词汇，不被 cause.details 覆盖）。 */
function mapCaptureError(cause: import('./execution-input.js').ExecutionInputError): PublicError {
  const detailsWithoutReason = (): Record<string, unknown> => {
    const { reason: _dropped, ...rest } = (cause.details ?? {}) as Record<string, unknown>;
    return rest;
  };
  switch (cause.code) {
    case 'validation':
      return publicError('invalid_input', 'validation', { purpose: cause.purpose ?? undefined }, cause);
    case 'not_found':
      return publicError('not_found', 'source_unavailable', {
        purpose: cause.purpose ?? undefined,
        artifactId: cause.artifactId ?? undefined,
      }, cause);
    case 'ownership':
      return publicError('forbidden', 'ownership_denied', {
        purpose: cause.purpose ?? undefined,
        artifactId: cause.artifactId ?? undefined,
      }, cause);
    case 'not_ready':
      return publicError('conflict', 'source_unavailable', {
        purpose: cause.purpose ?? undefined,
        artifactId: cause.artifactId ?? undefined,
      }, cause);
    case 'source_unavailable':
    case 'limit_exceeded':
      return publicError('invalid_input', cause.code, detailsWithoutReason(), cause);
    case 'timeout':
      return publicError('internal', 'timeout', detailsWithoutReason(), cause);
    case 'corrupt':
    case 'mismatch':
      return publicError('corrupt_state', 'source_unavailable', {
        purpose: cause.purpose ?? undefined,
        artifactId: cause.artifactId ?? undefined,
      }, cause);
    case 'publish':
      return publicError('internal', 'publish_failed', detailsWithoutReason(), cause);
    case 'file':
      return publicError('internal', 'file_io', detailsWithoutReason(), cause);
    default:
      return publicError('internal', 'source_unavailable', undefined, cause);
  }
}
