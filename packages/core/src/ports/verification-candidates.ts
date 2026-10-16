/**
 * P03-7 / F-003 当前 Attempt 测试目标候选校验与受信目标解析（ports 契约层：
 * 类型、常量、纯校验函数与解析器窄端口，无任何 I/O）。
 *
 * 设计依据：p03-task-verification PRD（版本 0.3）FR-1「分层检查与候选范围」——
 * 命令由可信定义提供，候选只选模块/目标；校验存在性、真实路径、符号链接、允许
 * 范围、参数注入、Attempt 归属及影响覆盖；缺候选、路径越界等安全回退全量。
 *
 * 契约要点：
 * - 候选是**不可信模型输出**：只接受当前 Attempt 的模块标识、实际测试目标和理由
 *   （schemaVersion/projectId/attemptId/executionVersion/codeDigest/modules 六字段
 *   白名单）；候选携带命令、shell、环境修改或任意执行选项（command/shell/argv/
 *   environment/options 等未知字段）一律拒绝，本契约不定义也不执行任何候选命令；
 * - 目标词法规则与 F-001 已确认模块清单（task-verification-policy validatePathReference）
 *   一致：POSIX 相对路径，无 NUL/控制字符、无绝对路径/~ /盘符/反斜杠、无空段/. /..；
 *   另拒绝可被解释为选项的目标（前导 -，如 -x/--watch/--experimental-strip-types）；
 * - 候选身份摘要 computeTestCandidateDigest 把规范化 payload 锚定到领域前缀，
 *   供 VerificationBatch selection 记录候选身份；内容已改变（摘要/Artifact 核验
 *   不一致）的候选不能直接用于局部执行；
 * - 解析器端口只返回**规范化目标与理由**（相对路径 + 文件/目录类型 + 身份指纹），
 *   绝不生成 argv、不拼接 shell、不读取候选中的执行语义字段；启动前 recheck 重核
 *   路径与身份，变更后旧选择失效；
 * - 明确上限（fail-closed）：模块数、每模块目标数、总目标数、路径长度、路径深度、
 *   理由长度与候选 payload 字节数；
 * - 拒绝原因使用冻结受控词汇（TEST_CANDIDATE_REJECTION_REASONS），detail 只含
 *   相对目标与受控说明，不含绝对路径或正文内容。
 *
 * 本契约不实现：局部/全量检查计划选择与安全回退决策（F-004）、检查执行（F-005）。
 */

import { createHash } from 'node:crypto';
import { stableStringify } from './feature-plan.js';
import type { VerificationModuleDefinition } from './task-verification-policy.js';
import {
  rejectUnknownKeys,
  requirePlainObject,
  validatePositiveInteger,
  validateSha256Digest,
  validateStableId,
  validationError,
} from './validation.js';
import type { ValidationContext } from './validation.js';

/** 候选 payload 契约版本（固定 v1）。 */
export const TEST_CANDIDATE_SCHEMA_VERSION = 1;

/** 候选模块数量上限。 */
export const TEST_CANDIDATE_MODULES_MAX_COUNT = 128;
/** 单模块候选目标数量上限。 */
export const TEST_CANDIDATE_MODULE_TARGETS_MAX_COUNT = 64;
/** 单次候选全部模块合计目标数量上限。 */
export const TEST_CANDIDATE_TARGETS_TOTAL_MAX_COUNT = 256;
/** 单个目标路径最大字符数。 */
export const TEST_CANDIDATE_PATH_MAX_LENGTH = 1024;
/** 单个目标路径最大深度（POSIX 段数）。 */
export const TEST_CANDIDATE_PATH_MAX_DEPTH = 64;
/** 选择理由最大码点数。 */
export const TEST_CANDIDATE_REASON_MAX_CODE_POINTS = 500;
/** 候选 Artifact 正文最大字节数（解析前 fail-closed）。 */
export const TEST_CANDIDATE_PAYLOAD_MAX_BYTES = 65_536;

/** 候选身份摘要领域前缀：锚定「测试目标候选 v1」语义，防止跨领域摘要碰撞。 */
export const TEST_CANDIDATE_DIGEST_DOMAIN = 'shiploop:test-candidates:v1';

/**
 * 候选拒绝原因（冻结受控词汇）。fail-closed：任何一项不满足即整体拒绝，
 * 不产出部分可用的局部目标；上层据以决定安全全量回退（F-004）。
 */
export const TEST_CANDIDATE_REJECTION_REASONS = [
  /** payload 结构或目标词法非法（含携带命令/shell/环境/执行选项等未知字段）。 */
  'invalid_payload',
  /** 候选正文超过 TEST_CANDIDATE_PAYLOAD_MAX_BYTES。 */
  'candidate_too_large',
  /** 候选 Artifact 缺失/pending/failed/损坏/跨项目/超限，不能作为可信候选。 */
  'artifact_untrusted',
  /** 候选不属于当前 Attempt（或 Attempt 不存在/跨项目）。 */
  'attempt_mismatch',
  /** 候选绑定的执行版本不是当前 executionVersion。 */
  'stale_execution_version',
  /** 候选绑定的项目与当前项目不一致。 */
  'project_mismatch',
  /** 候选绑定的代码身份与当前 codeDigest 不一致。 */
  'code_changed',
  /** 已确认政策没有显式模块清单，候选无从绑定。 */
  'no_module_policy',
  /** 候选引用了已确认模块清单之外的模块。 */
  'unknown_module',
  /** 工作区根缺失/非常规目录/不可信。 */
  'workspace_untrusted',
  /** 目标词法非法（防御纵深：解析层独立复核）。 */
  'target_invalid',
  /** 目标可被解释为命令选项（前导 -）。 */
  'target_option_like',
  /** 目标越出受管工作区（穿越/绝对路径/realpath 不在根内）。 */
  'target_outside_workspace',
  /** 目标不存在（失效文件）。 */
  'target_missing',
  /** 目标或祖先为符号链接（不跟随、不穿透）。 */
  'target_symlink',
  /** 目标是非常规文件（fifo/socket/设备等）。 */
  'target_special',
  /** 目标不在所属模块的 allowedTargets 允许范围内。 */
  'target_not_allowed',
  /** 启动前重核发现路径或身份已变化，旧选择失效。 */
  'content_changed',
  /** 扫描/候选数量/路径/输出大小超上限。 */
  'limit_exceeded',
  /** 文件系统运行期错误（权限/IO；detail 只含脱敏错误码）。 */
  'io_error',
] as const;

export type TestCandidateRejectionReason = (typeof TEST_CANDIDATE_REJECTION_REASONS)[number];

/** 单个模块的候选：模块身份 + 实际测试目标 + 选择理由（不含任何执行语义）。 */
export interface TestTargetCandidateModule {
  readonly moduleKey: string;
  readonly targets: readonly string[];
  readonly reason: string;
}

/** 不可信候选 Artifact 的已校验 payload（仅选择信息，身份绑定字段齐全）。 */
export interface TestCandidatePayload {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly attemptId: string;
  readonly executionVersion: number;
  readonly codeDigest: string;
  readonly modules: readonly TestTargetCandidateModule[];
}

/** 经真实文件系统核验的规范化目标：相对路径 + 类型 + 身份指纹（启动前重核基线）。 */
export interface ResolvedTestTarget {
  /** 规范化 POSIX 相对路径（与候选一致；词法校验已排除冗余形态）。 */
  readonly target: string;
  readonly kind: 'file' | 'directory';
  /** sha256(dev|ino|size|mtimeNs|kind) 身份指纹；内容或元数据变化即改变。 */
  readonly fingerprint: string;
}

/** 已解析的模块候选：规范化目标与理由（不含命令/环境/执行选项）。 */
export interface ResolvedCandidateModule {
  readonly moduleKey: string;
  readonly reason: string;
  readonly targets: readonly ResolvedTestTarget[];
}

/** 目标解析结果：要么整体可用，要么携带冻结拒绝原因（不产出部分结果）。 */
export type TestTargetResolution =
  | { readonly ok: true; readonly modules: readonly ResolvedCandidateModule[] }
  | { readonly ok: false; readonly reason: TestCandidateRejectionReason; readonly detail: string };

/** 解析器输入：工作区根 + 已确认模块清单（允许范围来源）+ 已纯校验候选。 */
export interface TestTargetResolveInput {
  /** 受管 worktree 绝对路径；适配器负责 canonical 化与归属核验。 */
  readonly workspaceRoot: string;
  /** 已确认政策模块清单（allowedTargets 的唯一可信来源）。 */
  readonly policyModules: readonly VerificationModuleDefinition[];
  readonly candidates: readonly TestTargetCandidateModule[];
}

/**
 * 受信目标解析器窄端口。实现者：adapters/fs/verification-target-resolver.ts。
 * 只核验路径与身份并返回规范化结果；不执行、不生成命令。
 */
export interface TestTargetResolver {
  resolve(input: unknown): Promise<TestTargetResolution>;
  /**
   * 启动前重核：以同一输入重新解析并与 previous 比较；任何路径/身份变化
   * （content_changed）或当前解析失败都使旧选择失效。
   */
  recheck(input: unknown, previous: unknown): Promise<TestTargetResolution>;
}

// ---------------------------------------------------------------------------
// 纯校验
// ---------------------------------------------------------------------------

const PAYLOAD_KEYS = ['schemaVersion', 'projectId', 'attemptId', 'executionVersion', 'codeDigest', 'modules'] as const;
const MODULE_KEYS = ['moduleKey', 'targets', 'reason'] as const;

/**
 * 目标词法校验（与 F-001 模块清单路径规则一致，另加选项形拒绝）。
 * 纯函数：不接触文件系统；非法一律抛 StorageError(kind='validation')。
 */
export function validateCandidateTarget(value: unknown, context: ValidationContext, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > TEST_CANDIDATE_PATH_MAX_LENGTH) {
    throw validationError(context, field, `必须是 1..${TEST_CANDIDATE_PATH_MAX_LENGTH} 字符的相对目标`, value);
  }
  if (/[\0-\x1f\x7f]/.test(value)) {
    throw validationError(context, field, '不允许 NUL 或控制字符');
  }
  if (value.startsWith('-')) {
    throw validationError(context, field, '目标不得以前导 - 开头（可被解释为命令选项）');
  }
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value)) {
    throw validationError(context, field, '必须是工作区内相对目标，不允许绝对路径或盘符', value);
  }
  if (value.includes('\\')) {
    throw validationError(context, field, '必须使用 POSIX 相对路径，不允许反斜杠');
  }
  const segments = value.split('/');
  if (segments.length > TEST_CANDIDATE_PATH_MAX_DEPTH) {
    throw validationError(context, field, `路径深度不得超过 ${TEST_CANDIDATE_PATH_MAX_DEPTH}`);
  }
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw validationError(context, field, '不允许空段、. 或 ..（目标必须保持在工作区内）');
  }
  return value;
}

/** 候选模块清单纯校验（payload 与解析器输入共用同一规则）。 */
export function validateCandidateModules(
  value: unknown,
  context: ValidationContext,
  field: string,
): TestTargetCandidateModule[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > TEST_CANDIDATE_MODULES_MAX_COUNT) {
    throw validationError(context, field, `必须是 1..${TEST_CANDIDATE_MODULES_MAX_COUNT} 项候选模块数组`, value);
  }
  const result: TestTargetCandidateModule[] = [];
  const seenModules = new Set<string>();
  let totalTargets = 0;
  for (const [index, raw] of value.entries()) {
    const itemField = `${field}[${index}]`;
    const object = requirePlainObject(raw, context, itemField);
    rejectUnknownKeys(object, MODULE_KEYS, context, itemField);
    for (const key of MODULE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) {
        throw validationError(context, `${itemField}.${key}`, '缺少必填字段');
      }
    }
    const moduleKey = validateStableId(object.moduleKey, context, `${itemField}.moduleKey`);
    if (moduleKey.length > 256) {
      throw validationError(context, `${itemField}.moduleKey`, '模块身份长度不得超过 256');
    }
    if (seenModules.has(moduleKey)) {
      throw validationError(context, `${itemField}.moduleKey`, '候选模块身份重复', object.moduleKey);
    }
    seenModules.add(moduleKey);
    if (
      !Array.isArray(object.targets) ||
      object.targets.length < 1 ||
      object.targets.length > TEST_CANDIDATE_MODULE_TARGETS_MAX_COUNT
    ) {
      throw validationError(
        context,
        `${itemField}.targets`,
        `必须是 1..${TEST_CANDIDATE_MODULE_TARGETS_MAX_COUNT} 项目标数组`,
      );
    }
    totalTargets += object.targets.length;
    if (totalTargets > TEST_CANDIDATE_TARGETS_TOTAL_MAX_COUNT) {
      throw validationError(context, `${itemField}.targets`, `候选目标总数不得超过 ${TEST_CANDIDATE_TARGETS_TOTAL_MAX_COUNT}`);
    }
    const targets: string[] = [];
    const seenTargets = new Set<string>();
    for (const [targetIndex, target] of object.targets.entries()) {
      const targetField = `${itemField}.targets[${targetIndex}]`;
      const validated = validateCandidateTarget(target, context, targetField);
      if (seenTargets.has(validated)) {
        throw validationError(context, targetField, '模块内候选目标重复', target);
      }
      seenTargets.add(validated);
      targets.push(validated);
    }
    if (typeof object.reason !== 'string') {
      throw validationError(context, `${itemField}.reason`, '必须是有界文本理由', object.reason);
    }
    const reasonLength = [...object.reason].length;
    if (reasonLength === 0 || reasonLength > TEST_CANDIDATE_REASON_MAX_CODE_POINTS) {
      throw validationError(
        context,
        `${itemField}.reason`,
        `必须是 1..${TEST_CANDIDATE_REASON_MAX_CODE_POINTS} 码点的选择理由`,
      );
    }
    if (/[\0-\x1f\x7f]/.test(object.reason)) {
      throw validationError(context, `${itemField}.reason`, '理由不得含控制字符');
    }
    result.push({ moduleKey, targets, reason: object.reason });
  }
  return result;
}

/**
 * 校验不可信候选 payload（六字段白名单）：只含模块/目标/理由与身份绑定；
 * 任何命令、shell、环境或执行选项字段都因未知字段被拒绝——候选永远不是命令来源。
 */
export function validateTestCandidatePayload(
  value: unknown,
  operation = 'TestCandidates.validatePayload',
): TestCandidatePayload {
  const context: ValidationContext = { operation };
  const object = requirePlainObject(value, context, 'payload');
  rejectUnknownKeys(object, PAYLOAD_KEYS, context, 'payload');
  for (const key of PAYLOAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      throw validationError(context, `payload.${key}`, '缺少必填字段');
    }
  }
  if (object.schemaVersion !== TEST_CANDIDATE_SCHEMA_VERSION) {
    throw validationError(context, 'payload.schemaVersion', `必须是 ${TEST_CANDIDATE_SCHEMA_VERSION}`, object.schemaVersion);
  }
  return {
    schemaVersion: TEST_CANDIDATE_SCHEMA_VERSION,
    projectId: validateStableId(object.projectId, context, 'payload.projectId'),
    attemptId: validateStableId(object.attemptId, context, 'payload.attemptId'),
    executionVersion: validatePositiveInteger(object.executionVersion, context, 'payload.executionVersion'),
    codeDigest: validateSha256Digest(object.codeDigest, context, 'payload.codeDigest'),
    modules: validateCandidateModules(object.modules, context, 'payload.modules'),
  };
}

/**
 * 候选身份摘要：SHA-256(领域前缀 + 规范化 payload)。与 Artifact 正文摘要
 * 共同构成候选身份（内容变化即摘要变化，旧候选不能直接用于局部执行）。
 */
export function computeTestCandidateDigest(payload: TestCandidatePayload): string {
  return createHash('sha256')
    .update(`${TEST_CANDIDATE_DIGEST_DOMAIN}\n${stableStringify(payload)}`, 'utf8')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// 编排输入（application 层使用；端口侧纯校验）
// ---------------------------------------------------------------------------

/** 候选校验编排输入：当前 Attempt 绑定 + 候选 Artifact 引用 + 已确认政策 + 工作区根。 */
export interface TestCandidateValidationInput {
  readonly projectId: string;
  readonly attemptId: string;
  readonly executionVersion: number;
  /** 当前代码身份（权威捕获值）；候选绑定摘要不一致即 code_changed。 */
  readonly codeDigest: string;
  readonly candidateArtifactId: string;
  /** 用户确认的 Task 检查政策（application 层重新校验后才可信）。 */
  readonly policy: unknown;
  /** 受管 worktree 绝对路径（来自权威工作区记录，不是候选内容）。 */
  readonly workspaceRoot: string;
}

const INPUT_KEYS = [
  'projectId', 'attemptId', 'executionVersion', 'codeDigest', 'candidateArtifactId', 'policy', 'workspaceRoot',
] as const;

export function validateTestCandidateValidationInput(
  value: unknown,
  operation = 'TestCandidates.validate',
): TestCandidateValidationInput {
  const context: ValidationContext = { operation };
  const object = requirePlainObject(value, context, 'input');
  rejectUnknownKeys(object, INPUT_KEYS, context, 'input');
  for (const key of INPUT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      throw validationError(context, `input.${key}`, '缺少必填字段');
    }
  }
  if (
    typeof object.workspaceRoot !== 'string' ||
    object.workspaceRoot.length === 0 ||
    object.workspaceRoot.length > 4096 ||
    !object.workspaceRoot.startsWith('/') ||
    object.workspaceRoot.includes('\0')
  ) {
    throw validationError(context, 'input.workspaceRoot', '必须是有界 POSIX 绝对路径（受管 worktree 根）', object.workspaceRoot);
  }
  return {
    projectId: validateStableId(object.projectId, context, 'input.projectId'),
    attemptId: validateStableId(object.attemptId, context, 'input.attemptId'),
    executionVersion: validatePositiveInteger(object.executionVersion, context, 'input.executionVersion'),
    codeDigest: validateSha256Digest(object.codeDigest, context, 'input.codeDigest'),
    candidateArtifactId: validateStableId(object.candidateArtifactId, context, 'input.candidateArtifactId'),
    policy: object.policy,
    workspaceRoot: object.workspaceRoot,
  };
}
