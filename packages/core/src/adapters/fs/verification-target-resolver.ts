/**
 * P03-7 / F-003 受信测试目标解析器（adapters 层，ports/verification-candidates.ts
 * 的 TestTargetResolver 真实文件系统实现）。
 *
 * 不变量：
 * - 只核验路径与身份并返回规范化目标（相对路径 + 类型 + 身份指纹）；绝不执行候选
 *   内容、不生成 argv、不拼接 shell、不读取候选中的执行语义字段（端口白名单已拒绝）；
 * - 路径安全三层防线（沿用 path-service / workspace-inspector 的核对方式）：
 *   1. 词法：POSIX 相对路径，无绝对/~ /盘符/反斜杠/空段/. /.. /控制字符，前导 -
 *      （可被解释为选项）单独拒绝；
 *   2. 逐段 lstat no-follow：目标链上任一符号链接（叶子或祖先）一律拒绝；
 *   3. realpath 核对：目标真实位置必须与词法位置一致且位于 canonical 工作区根内；
 * - 目录归属：目标必须属于候选模块在已确认政策中的 allowedTargets（词法前缀边界，
 *   无符号链接时词法即真实）；
 * - recheck（启动前重核）：以同一输入重新解析并与旧选择逐项比较，任何内容/身份
 *   漂移（content_changed）或当前解析失败都使旧选择失效；
 * - 上限：候选/模块/目标数量、路径长度与深度由端口常量限定，本适配器复核，
 *   超限 fail-closed；fs 调用次数由目标数 × 深度上界约束；
 * - 错误脱敏：detail 只含相对目标与受控说明，不含绝对路径或正文内容；
 * - import 本模块无副作用；createTestTargetResolver 不执行任何 I/O。
 *
 * 可信项目模式边界：lstat/realpath 核对与实际启动之间的并发替换窗口由
 * 「单 Host 写入者 + 启动前 recheck」前提收窄，本适配器不宣称强 OS 沙箱。
 */

import { lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, sep } from 'node:path';
import {
  TEST_CANDIDATE_MODULES_MAX_COUNT,
  TEST_CANDIDATE_TARGETS_TOTAL_MAX_COUNT,
  validateCandidateModules,
  validateCandidateTarget,
} from '../../ports/verification-candidates.js';
import type {
  ResolvedCandidateModule,
  ResolvedTestTarget,
  TestCandidateRejectionReason,
  TestTargetCandidateModule,
  TestTargetResolveInput,
  TestTargetResolver,
  TestTargetResolution,
} from '../../ports/verification-candidates.js';
import { isStorageError } from '../../ports/errors.js';
import { isPlainObject } from '../../ports/validation.js';
import type { ValidationContext } from '../../ports/validation.js';

const OPERATION = 'TestTargetResolver.resolve';

type Rejection = { readonly ok: false; readonly reason: TestCandidateRejectionReason; readonly detail: string };

function reject(reason: TestCandidateRejectionReason, detail: string): Rejection {
  return { ok: false, reason, detail };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** 目标词法复核：把端口校验错误分类为受控拒绝原因（选项形单独识别）。 */
function lexicalRejection(target: unknown, context: ValidationContext, field: string): Rejection | null {
  try {
    validateCandidateTarget(target, context, field);
    return null;
  } catch {
    return typeof target === 'string' && target.startsWith('-')
      ? reject('target_option_like', '目标以前导 - 开头，可被解释为命令选项，拒绝')
      : reject('target_invalid', '目标词法非法（绝对路径/穿越/反斜杠/控制字符/冗余段/超限）');
  }
}

/** 候选结构复核；失败时定位首个非法目标分类原因，其余结构问题归 invalid_payload。 */
function validateCandidates(value: unknown, context: ValidationContext): TestTargetCandidateModule[] | Rejection {
  try {
    return validateCandidateModules(value, context, 'input.candidates');
  } catch (error) {
    if (isStorageError(error, 'validation') && Array.isArray(value)) {
      for (const [index, raw] of value.entries()) {
        if (!isPlainObject(raw) || !Array.isArray(raw.targets)) continue;
        for (const [targetIndex, target] of raw.targets.entries()) {
          const found = lexicalRejection(target, context, `input.candidates[${index}].targets[${targetIndex}]`);
          if (found !== null) return found;
        }
      }
    }
    return reject('invalid_payload', '候选结构或上限非法（字段白名单/数量/长度/深度）');
  }
}

interface PolicyModuleView {
  readonly moduleKey: string;
  readonly allowedTargets: readonly string[];
}

/** 已确认模块清单复核（可信配置的防御纵深；词法允许范围来源）。 */
function validatePolicyModules(value: unknown, context: ValidationContext): PolicyModuleView[] | Rejection {
  if (!Array.isArray(value) || value.length < 1 || value.length > TEST_CANDIDATE_MODULES_MAX_COUNT) {
    return reject('invalid_payload', '已确认模块清单必须是 1..上限 项数组');
  }
  const result: PolicyModuleView[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw) || typeof raw.moduleKey !== 'string' || !Array.isArray(raw.allowedTargets)) {
      return reject('invalid_payload', `已确认模块清单第 ${index} 项结构非法`);
    }
    if (seen.has(raw.moduleKey)) {
      return reject('invalid_payload', `已确认模块身份重复（第 ${index} 项）`);
    }
    seen.add(raw.moduleKey);
    for (const [targetIndex, target] of raw.allowedTargets.entries()) {
      if (lexicalRejection(target, context, `input.policyModules[${index}].allowedTargets[${targetIndex}]`) !== null) {
        return reject('invalid_payload', '已确认模块允许范围词法非法');
      }
    }
    result.push({ moduleKey: raw.moduleKey, allowedTargets: raw.allowedTargets as string[] });
  }
  return result;
}

/** 目标必须在所属模块允许范围内：等于允许前缀或位于其下（词法前缀边界）。 */
function isTargetAllowed(target: string, allowedTargets: readonly string[]): boolean {
  return allowedTargets.some((allowed) => target === allowed || target.startsWith(`${allowed}/`));
}

/** 目标身份指纹：dev/ino/size/mtimeNs/kind 的 SHA-256；内容或元数据变化即改变。 */
function fingerprint(stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }, kind: 'file' | 'directory'): string {
  return createHash('sha256')
    .update(`${String(stat.dev)}:${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeNs)}:${kind}`)
    .digest('hex');
}

/** 工作区根 canonical 化：必须已存在且为真实目录；拒绝把文件系统根当工作区。 */
async function canonicalizeRoot(workspaceRoot: string): Promise<string | Rejection> {
  if (
    typeof workspaceRoot !== 'string' ||
    workspaceRoot.length === 0 ||
    workspaceRoot.length > 4096 ||
    !workspaceRoot.startsWith('/') ||
    workspaceRoot.includes('\0')
  ) {
    return reject('workspace_untrusted', '工作区根必须是有界 POSIX 绝对路径');
  }
  let rootReal: string;
  try {
    rootReal = await realpath(workspaceRoot);
  } catch (error) {
    return reject('workspace_untrusted', `工作区根不可用（${errorCode(error) ?? 'unknown'}）`);
  }
  if (rootReal === sep) {
    return reject('workspace_untrusted', '拒绝把文件系统根作为工作区');
  }
  try {
    const stat = await lstat(rootReal);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return reject('workspace_untrusted', '工作区根必须是真实目录');
    }
  } catch (error) {
    return reject('workspace_untrusted', `工作区根不可用（${errorCode(error) ?? 'unknown'}）`);
  }
  return rootReal;
}

/**
 * 逐段 no-follow 核验并返回目标身份。链上任一符号链接拒绝；缺失即失效目标；
 * 非常规文件拒绝；最终 realpath 必须与词法位置一致且在 canonical 根内。
 */
async function resolveTarget(rootReal: string, target: string): Promise<ResolvedTestTarget | Rejection> {
  const segments = target.split('/');
  const abs = join(rootReal, ...segments);
  if (!abs.startsWith(rootReal + sep)) {
    return reject('target_outside_workspace', `目标 ${target} 越出受管工作区`);
  }
  let current = rootReal;
  let stat;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const last = index === segments.length - 1;
    try {
      stat = await lstat(current, { bigint: true });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return reject('target_missing', `目标 ${target} 不存在（失效目标）`);
      }
      if (code === 'ELOOP') {
        return reject('target_symlink', `目标 ${target} 链上检测到符号链接（no-follow 拒绝）`);
      }
      return reject('io_error', `目标 ${target} 核验失败（${code ?? 'unknown'}）`);
    }
    if (stat.isSymbolicLink()) {
      return reject('target_symlink', `目标 ${target} 链上检测到符号链接（不跟随、不穿透）`);
    }
    if (!last) {
      if (!stat.isDirectory()) {
        return reject('target_missing', `目标 ${target} 祖先不是目录（失效目标）`);
      }
      continue;
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      return reject('target_special', `目标 ${target} 是非常规文件（fifo/socket/设备等），拒绝`);
    }
  }
  const kind: 'file' | 'directory' = stat!.isDirectory() ? 'directory' : 'file';
  let real: string;
  try {
    real = await realpath(abs);
  } catch (error) {
    const code = errorCode(error);
    return reject(
      code === 'ELOOP' ? 'target_symlink' : 'io_error',
      `目标 ${target} realpath 核验失败（${code ?? 'unknown'}）`,
    );
  }
  if (real !== abs) {
    return reject('target_outside_workspace', `目标 ${target} 真实位置与词法位置不一致（不信任）`);
  }
  return { target, kind, fingerprint: fingerprint(stat!, kind) };
}

function validateResolvedModules(value: unknown): ResolvedCandidateModule[] | null {
  if (!Array.isArray(value)) return null;
  const result: ResolvedCandidateModule[] = [];
  for (const raw of value) {
    if (!isPlainObject(raw) || typeof raw.moduleKey !== 'string' || typeof raw.reason !== 'string' || !Array.isArray(raw.targets)) {
      return null;
    }
    const targets: ResolvedTestTarget[] = [];
    for (const entry of raw.targets) {
      if (
        !isPlainObject(entry) ||
        typeof entry.target !== 'string' ||
        (entry.kind !== 'file' && entry.kind !== 'directory') ||
        typeof entry.fingerprint !== 'string' ||
        !/^[0-9a-f]{64}$/.test(entry.fingerprint)
      ) {
        return null;
      }
      targets.push({ target: entry.target, kind: entry.kind, fingerprint: entry.fingerprint });
    }
    result.push({ moduleKey: raw.moduleKey, reason: raw.reason, targets });
  }
  return result;
}

function modulesEqual(left: readonly ResolvedCandidateModule[], right: readonly ResolvedCandidateModule[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((module, index) => {
    const other = right[index]!;
    return module.moduleKey === other.moduleKey &&
      module.reason === other.reason &&
      module.targets.length === other.targets.length &&
      module.targets.every((target, targetIndex) => {
        const otherTarget = other.targets[targetIndex]!;
        return target.target === otherTarget.target &&
          target.kind === otherTarget.kind &&
          target.fingerprint === otherTarget.fingerprint;
      });
  });
}

async function resolveAll(input: unknown): Promise<TestTargetResolution> {
  const context: ValidationContext = { operation: OPERATION };
  if (!isPlainObject(input)) {
    return reject('invalid_payload', '解析输入必须是对象');
  }
  const candidates = validateCandidates(input.candidates, context);
  if (!Array.isArray(candidates)) return candidates;
  const policyModules = validatePolicyModules(input.policyModules, context);
  if (!Array.isArray(policyModules)) return policyModules;
  if (candidates.reduce((total, module) => total + module.targets.length, 0) > TEST_CANDIDATE_TARGETS_TOTAL_MAX_COUNT) {
    return reject('limit_exceeded', `候选目标总数超过上限 ${TEST_CANDIDATE_TARGETS_TOTAL_MAX_COUNT}`);
  }
  const rootReal = await canonicalizeRoot(input.workspaceRoot as string);
  if (typeof rootReal !== 'string') return rootReal;
  const modules: ResolvedCandidateModule[] = [];
  for (const candidate of candidates) {
    const policy = policyModules.find((entry) => entry.moduleKey === candidate.moduleKey);
    if (policy === undefined) {
      return reject('unknown_module', `候选引用了未确认的模块 ${candidate.moduleKey}`);
    }
    const targets: ResolvedTestTarget[] = [];
    for (const target of candidate.targets) {
      const lexical = lexicalRejection(target, context, 'target');
      if (lexical !== null) return lexical;
      const resolved = await resolveTarget(rootReal, target);
      if (!('fingerprint' in resolved)) return resolved;
      if (!isTargetAllowed(resolved.target, policy.allowedTargets)) {
        return reject('target_not_allowed', `目标 ${resolved.target} 不在模块 ${candidate.moduleKey} 的允许范围内`);
      }
      targets.push(resolved);
    }
    modules.push({ moduleKey: candidate.moduleKey, reason: candidate.reason, targets });
  }
  return { ok: true, modules };
}

/** 装配真实文件系统受信目标解析器（无任何启动副作用）。 */
export function createTestTargetResolver(): TestTargetResolver {
  return {
    resolve: resolveAll,
    async recheck(input: unknown, previous: unknown): Promise<TestTargetResolution> {
      const baseline = validateResolvedModules(previous);
      if (baseline === null) {
        return reject('content_changed', '旧选择形态非法，不能沿用');
      }
      const current = await resolveAll(input);
      if (!current.ok) return current;
      if (!modulesEqual(current.modules, baseline)) {
        return reject('content_changed', '启动前重核发现目标路径或身份已变化，旧选择失效');
      }
      return current;
    },
  };
}
