/**
 * P03-7 / F-003 测试目标候选校验编排（application 层）：把不可信候选 Artifact
 * 绑定到当前 Attempt / 当前执行版本 / 当前项目 / 当前代码身份，并委托受信目标
 * 解析器完成路径安全核验。
 *
 * 设计依据：p03-task-verification PRD（版本 0.3）FR-1 与 F-003 验收点。
 *
 * 不变量：
 * - 只依赖 ports 窄接口与 ArtifactVerifier 有效读取，不接触具体适配器/驱动；
 * - 候选内容永远不是命令来源：payload 六字段白名单（ports 纯校验）拒绝一切
 *   命令/shell/环境/执行选项字段；本模块不生成 argv、不启动进程；
 * - 身份绑定（任一不符即冻结原因拒绝，不产出部分结果）：
 *   · Attempt 必须真实存在且属于当前项目（AttemptStore 权威读取），候选
 *     attemptId/projectId 必须与之一致；
 *   · executionVersion 必须是当前版本（输入与候选 payload 双重核对）；
 *   · codeDigest 必须与当前代码身份一致（code_changed 拒绝）；
 *   · 候选 Artifact 必须经 readVerifiedContent 核验（ready + 实测摘要一致），
 *     缺失/pending/损坏/跨项目/超限一律 artifact_untrusted；
 * - 上限 fail-closed：候选正文 ≤ TEST_CANDIDATE_PAYLOAD_MAX_BYTES；模块/目标/
 *   路径/理由上限由端口纯校验承担；
 * - recheckCandidates（启动前重核）：完整重读 Artifact、重核身份绑定并重新解析
 *   路径，候选摘要或解析结果与旧选择任一漂移即 content_changed，旧选择失效；
 * - 合法结果只返回规范化目标、理由、候选身份摘要与 Artifact 身份摘要
 *   （供 F-004 选择计划与 F-002 批次 selection 记录），不降低必需检查。
 *
 * 本模块不实现：局部/全量选择决策（F-004）、检查执行与进程管理（F-005）。
 */

import { isStorageError } from '../ports/errors.js';
import type { AttemptStore } from '../ports/attempt-store.js';
import { validateConfirmedTaskVerificationPolicy } from '../ports/task-verification-policy.js';
import {
  TEST_CANDIDATE_PAYLOAD_MAX_BYTES,
  computeTestCandidateDigest,
  validateTestCandidatePayload,
  validateTestCandidateValidationInput,
} from '../ports/verification-candidates.js';
import type {
  ResolvedCandidateModule,
  TestCandidateRejectionReason,
  TestCandidateValidationInput,
  TestTargetResolver,
} from '../ports/verification-candidates.js';
import { isArtifactVerifyError } from './artifact-verify.js';
import type { ArtifactVerifier } from './artifact-verify.js';
import { validationError } from '../ports/validation.js';
import type { ValidationContext } from '../ports/validation.js';

/** 候选校验通过结果：规范化目标 + 理由 + 候选/Artifact 身份摘要（不执行任何命令）。 */
export interface TestCandidateSelection {
  readonly ok: true;
  /** 候选身份摘要（computeTestCandidateDigest，绑定规范化 payload）。 */
  readonly candidateDigest: string;
  /** 候选 Artifact 身份摘要（同项目 ready 且实测核验通过）。 */
  readonly artifact: {
    readonly artifactId: string;
    readonly contentHash: string;
    readonly sizeBytes: number;
  };
  readonly modules: readonly ResolvedCandidateModule[];
}

export interface TestCandidateRejection {
  readonly ok: false;
  readonly reason: TestCandidateRejectionReason;
  readonly detail: string;
}

export type TestCandidateValidation = TestCandidateSelection | TestCandidateRejection;

export interface VerificationCandidateValidatorDeps {
  /** 权威 Attempt 只读（当前 Attempt/项目归属与执行版本核对）。 */
  readonly attempts: Pick<AttemptStore, 'getAttempt'>;
  /** 候选 Artifact 有效读取（ready + 实测摘要一致；跨项目 ownership）。 */
  readonly verifier: Pick<ArtifactVerifier, 'readVerifiedContent'>;
  /** 受信目标解析器（路径安全核验；不执行候选内容）。 */
  readonly resolver: TestTargetResolver;
}

export interface VerificationCandidateValidator {
  validateCandidates(input: unknown): Promise<TestCandidateValidation>;
  /** 启动前重核：完整重验并比对旧选择；任何漂移使旧选择失效。 */
  recheckCandidates(input: unknown, previous: unknown): Promise<TestCandidateValidation>;
}

function reject(reason: TestCandidateRejectionReason, detail: string): TestCandidateRejection {
  return { ok: false, reason, detail };
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

function validatePreviousSelection(value: unknown): TestCandidateSelection | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.ok !== true || typeof raw.candidateDigest !== 'string' || !/^[0-9a-f]{64}$/.test(raw.candidateDigest)) {
    return null;
  }
  if (!Array.isArray(raw.modules)) return null;
  return value as TestCandidateSelection;
}

/** 装配候选校验编排用例；只校验依赖形态，不执行任何 I/O。 */
export function createVerificationCandidateValidator(
  deps: VerificationCandidateValidatorDeps,
): VerificationCandidateValidator {
  const operation = 'TestCandidates.validate';
  const context: ValidationContext = { operation };
  if (deps === null || typeof deps !== 'object') {
    throw validationError(context, 'deps', '必须提供候选校验依赖');
  }
  if (typeof (deps.attempts as { getAttempt?: unknown })?.getAttempt !== 'function') {
    throw validationError(context, 'deps.attempts', '必须提供 AttemptStore.getAttempt 权威读取');
  }
  if (typeof (deps.verifier as { readVerifiedContent?: unknown })?.readVerifiedContent !== 'function') {
    throw validationError(context, 'deps.verifier', '必须提供 ArtifactVerifier.readVerifiedContent 有效读取');
  }
  if (
    typeof (deps.resolver as { resolve?: unknown })?.resolve !== 'function' ||
    typeof (deps.resolver as { recheck?: unknown })?.recheck !== 'function'
  ) {
    throw validationError(context, 'deps.resolver', '必须提供 TestTargetResolver 受信目标解析器');
  }
  const { attempts, verifier, resolver } = deps;

  async function validate(input: TestCandidateValidationInput): Promise<TestCandidateValidation> {
    // 已确认政策（可信配置）：结构非法是配置缺陷，直接抛校验错误；无显式模块清单
    // 时候选无从绑定允许范围，fail-closed 拒绝。
    const policy = validateConfirmedTaskVerificationPolicy(input.policy, {
      operation,
      entity: { type: 'project_settings', projectId: input.projectId },
    });
    if (policy.modules === undefined || policy.modules.length === 0) {
      return reject('no_module_policy', '已确认政策缺少显式模块清单，候选无从绑定允许范围');
    }

    // 当前 Attempt 权威核对：不存在/跨项目/版本不符均拒绝（其他 Attempt 与过期
    // 执行版本的候选不能直接用于局部执行）。
    try {
      const attempt = attempts.getAttempt(input.projectId, input.attemptId);
      if (attempt.executionVersion !== input.executionVersion) {
        return reject('stale_execution_version', '当前 Attempt 执行版本已推进，输入版本过期');
      }
    } catch (error) {
      if (isStorageError(error)) {
        return reject('attempt_mismatch', '当前 Attempt 不存在或跨项目（候选不能用于局部执行）');
      }
      throw error;
    }

    // 候选 Artifact 身份核验读取：缺失/pending/损坏/跨项目/超限一律不可信。
    let content;
    try {
      content = await verifier.readVerifiedContent(input.projectId, input.candidateArtifactId);
    } catch (error) {
      const detail = isArtifactVerifyError(error) ? `候选 Artifact 不可信（${error.code}）` : '候选 Artifact 读取失败';
      return reject('artifact_untrusted', detail);
    }
    if (content.sizeBytes > TEST_CANDIDATE_PAYLOAD_MAX_BYTES || content.content.byteLength > TEST_CANDIDATE_PAYLOAD_MAX_BYTES) {
      return reject('candidate_too_large', `候选正文超过上限 ${TEST_CANDIDATE_PAYLOAD_MAX_BYTES} 字节`);
    }

    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content.content));
    } catch {
      return reject('invalid_payload', '候选正文不是合法 UTF-8 JSON');
    }
    let payload;
    try {
      payload = validateTestCandidatePayload(rawPayload, operation);
    } catch (error) {
      if (isStorageError(error, 'validation')) {
        const field = typeof error.details?.field === 'string' ? error.details.field : 'payload';
        return reject('invalid_payload', `候选 payload 非法（${field}）`);
      }
      throw error;
    }

    // 候选 payload 与当前权威身份逐项绑定。
    if (payload.projectId !== input.projectId) {
      return reject('project_mismatch', '候选绑定的项目与当前项目不一致');
    }
    if (payload.attemptId !== input.attemptId) {
      return reject('attempt_mismatch', '候选不属于当前 Attempt');
    }
    if (payload.executionVersion !== input.executionVersion) {
      return reject('stale_execution_version', '候选绑定的执行版本过期');
    }
    if (payload.codeDigest !== input.codeDigest) {
      return reject('code_changed', '候选绑定的代码身份与当前不一致，需重新生成候选');
    }
    const knownModules = new Set(policy.modules.map((module) => module.moduleKey));
    for (const module of payload.modules) {
      if (!knownModules.has(module.moduleKey)) {
        return reject('unknown_module', `候选引用了未确认的模块 ${module.moduleKey}`);
      }
    }

    // 受信目标解析：存在性/realpath/归属/允许范围核验（不执行候选内容）。
    const resolution = await resolver.resolve({
      workspaceRoot: input.workspaceRoot,
      policyModules: policy.modules,
      candidates: payload.modules,
    });
    if (!resolution.ok) return resolution;
    return {
      ok: true,
      candidateDigest: computeTestCandidateDigest(payload),
      artifact: {
        artifactId: content.artifactId,
        contentHash: content.contentHash,
        sizeBytes: content.sizeBytes,
      },
      modules: resolution.modules,
    };
  }

  return {
    async validateCandidates(input: unknown): Promise<TestCandidateValidation> {
      return validate(validateTestCandidateValidationInput(input, operation));
    },
    async recheckCandidates(input: unknown, previous: unknown): Promise<TestCandidateValidation> {
      const baseline = validatePreviousSelection(previous);
      if (baseline === null) {
        return reject('content_changed', '旧选择形态非法，不能沿用');
      }
      // 完整重验：重读 Artifact（身份摘要）、重核 Attempt/版本/代码绑定并重新解析路径。
      const current = await validate(validateTestCandidateValidationInput(input, operation));
      if (!current.ok) return current;
      if (current.candidateDigest !== baseline.candidateDigest || !modulesEqual(current.modules, baseline.modules)) {
        return reject('content_changed', '启动前重核发现候选或目标身份已变化，旧选择失效');
      }
      return current;
    },
  };
}
