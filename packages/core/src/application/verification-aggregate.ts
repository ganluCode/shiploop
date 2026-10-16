/** P03-7 / F-006: machine-side acceptance rules. Pure and fail-closed. */
import type {
  MachineVerificationCategory,
  MachineVerificationInput,
  MachineVerificationResult,
  VerificationCodeIdentity,
} from '../ports/verification-aggregate.js';

function result(
  input: MachineVerificationInput,
  status: MachineVerificationResult['status'],
  category: MachineVerificationCategory,
  reason: string,
  evidenceRefs: readonly string[] = [],
  checkStatuses: Readonly<Record<string, MachineVerificationResult['checkStatuses'][string]>> = {},
): MachineVerificationResult {
  return {
    schemaVersion: 1, status, machinePassed: status === 'passed', category, reason,
    evidenceRefs: [...new Set(evidenceRefs)], checkedCodeIdentity: input.afterIdentity,
    runtime: input.runtime, diagnostic: input.diagnostic === true,
    ...(input.humanReview === undefined ? {} : { humanReview: input.humanReview }), checkStatuses,
  };
}

function same(a: VerificationCodeIdentity, b: VerificationCodeIdentity, key: keyof VerificationCodeIdentity): boolean {
  const left = a[key];
  const right = b[key];
  return left === undefined && right === undefined ? true : left === right;
}

function safeStop(input: MachineVerificationInput): boolean {
  return input.runtime.stopped?.confirmed === true;
}

function runtimeOkay(input: MachineVerificationInput): boolean {
  const runtime = input.runtime;
  return runtime.failure == null && runtime.result?.terminal === 'completed'
    && runtime.result.exitCode === 0 && runtime.result.signal === null && safeStop(input);
}

function statusForCheck(status: string): MachineVerificationResult['status'] {
  if (status === 'error') return 'error';
  if (status === 'failed') return 'failed';
  return 'inconclusive';
}

/**
 * Aggregate one immutable verification observation. A caller must provide
 * complete evidence observations; a result row alone is never evidence-ready.
 */
export function aggregateMachineVerification(input: MachineVerificationInput): MachineVerificationResult {
  if (!input || typeof input !== 'object' || !input.beforeIdentity || !input.afterIdentity) {
    return result(input, 'error', 'invalid_input', '验证输入缺少受信代码身份');
  }
  if (!input.workspaceHeld) {
    return result(input, 'inconclusive', 'workspace_not_held', '工作区占用未保持，不能开始或完成正式验证');
  }
  if (!safeStop(input)) {
    return result(input, 'inconclusive', 'runtime_not_stopped', 'Runtime 未提供确认停止证据');
  }
  if (!runtimeOkay(input)) {
    return result(input, 'error', 'runtime_error',
      input.runtime.failure?.reason ?? input.runtime.result?.reason ?? 'Runtime 未正常结束');
  }
  if (input.diagnostic === true) {
    return result(input, 'error', 'diagnostic_only', '诊断检查结果不能改变 Runtime 错误或 Task 未通过状态');
  }
  if (input.expectedCodeDigest !== undefined && input.beforeIdentity.codeDigest !== input.expectedCodeDigest) {
    return result(input, 'inconclusive', 'source_changed', '验证开始时的代码身份与批次身份不一致');
  }
  if (input.expectedExecutionDigest !== undefined && input.beforeIdentity.executionDigest !== input.expectedExecutionDigest) {
    return result(input, 'inconclusive', 'execution_identity_changed', '验证开始时的执行定义与批次身份不一致');
  }
  if (input.plan.status !== 'ready') {
    return result(input, 'inconclusive', 'plan_not_ready', '验证计划未就绪，不能产生机器成功结论');
  }
  const selected = input.plan.selectedChecks;
  if (selected.length === 0) {
    return result(input, 'inconclusive', 'empty_check_set', '验证检查集合为空');
  }
  const selectedKeys = new Set(selected.map((check) => check.checkKey));
  const missingPlanRequired = (input.plan.requiredCheckKeys ?? []).filter((key) => !selectedKeys.has(key));
  if (missingPlanRequired.length > 0) {
    return result(input, 'inconclusive', 'missing_required_check',
      `验证计划缺少必需检查：${missingPlanRequired.join(',')}`);
  }
  if (input.plan.affectedModules !== undefined
    && (input.plan.coveredModules === undefined
      || input.plan.affectedModules.some((module) => !input.plan.coveredModules!.includes(module)))) {
    return result(input, 'inconclusive', 'coverage_incomplete', '验证计划未覆盖全部受影响范围');
  }
  if (input.plan.coveredModules !== undefined && input.plan.affectedModules === undefined) {
    return result(input, 'inconclusive', 'coverage_incomplete', '验证计划缺少受影响范围依据');
  }
  const expected = new Map<string, boolean>();
  for (const check of selected) {
    if (expected.has(check.checkKey)) return result(input, 'error', 'invalid_input', '验证计划包含重复检查身份');
    expected.set(check.checkKey, check.required);
  }
  const byKey = new Map<string, typeof input.results[number]>();
  for (const check of input.results) {
    if (byKey.has(check.checkKey)) return result(input, 'error', 'invalid_input', `检查结果重复：${check.checkKey}`);
    byKey.set(check.checkKey, check);
  }
  const statuses: Record<string, typeof input.results[number]['status']> = {};
  const refs: string[] = [];
  for (const [key, required] of expected) {
    const check = byKey.get(key);
    if (!check) return result(input, required ? 'inconclusive' : 'inconclusive',
      required ? 'missing_required_check' : 'missing_check_result', `缺少检查结果：${key}`, refs, statuses);
    statuses[key] = check.status;
    if (check.outputArtifactId !== null) refs.push(check.outputArtifactId);
    const evidence = input.evidence?.[key];
    if (evidence?.reference) refs.push(evidence.reference);
    if (check.status === 'passed' && (!evidence || evidence.status !== 'complete')) {
      return result(input, 'inconclusive', 'evidence_incomplete', `检查证据未完成：${key}`, refs, statuses);
    }
    if (evidence?.status === 'incomplete') {
      return result(input, 'inconclusive', 'evidence_corrupt', `检查证据损坏或摘要不匹配：${key}`, refs, statuses);
    }
    if (check.status !== 'passed') {
      const category: MachineVerificationCategory = check.status === 'error' ? 'check_not_passed'
        : check.status === 'failed' ? 'check_not_passed' : check.status === 'not_run' ? 'missing_check_result' : 'check_not_passed';
      return result(input, statusForCheck(check.status), category,
        `${required ? '必需' : '可选'}检查未通过：${key}`, refs, statuses);
    }
    const testCount = input.testCounts?.[key];
    if (testCount !== undefined && (!Number.isSafeInteger(testCount) || testCount < 1)) {
      return result(input, 'inconclusive', 'zero_tests', `检查未收集到测试：${key}`, refs, statuses);
    }
  }
  if (input.baseline && input.baseline.status !== 'passed') {
    return result(input, input.baseline.status === 'error' ? 'error' : 'failed', 'baseline_failed',
      `已有 baseline 状态为 ${input.baseline.status}`, refs, statuses);
  }
  for (const key of ['headCommit', 'codeDigest', 'trackedPathsDigest', 'untrackedPathsDigest', 'ignoredPathsDigest'] as const) {
    if (!same(input.beforeIdentity, input.afterIdentity, key)) {
      return result(input, 'inconclusive', 'source_changed', `源码身份在验证期间变化：${key}`, refs, statuses);
    }
  }
  for (const key of ['executionDigest', 'environmentDigest'] as const) {
    if (!same(input.beforeIdentity, input.afterIdentity, key)) {
      return result(input, 'inconclusive', 'execution_identity_changed', `执行依据变化：${key}`, refs, statuses);
    }
  }
  return result(input, 'passed', 'passed', '全部匹配检查通过且证据完整', refs, statuses);
}

export type RuntimeVerificationMode = 'formal' | 'diagnostic' | 'blocked';

/** Runtime errors never enter formal acceptance; diagnostics require confirmed stop. */
export function runtimeVerificationMode(runtime: MachineVerificationInput['runtime']): RuntimeVerificationMode {
  if (runtime.stopped?.confirmed !== true) return 'blocked';
  if (runtime.failure != null || runtime.result?.terminal !== 'completed'
    || runtime.result.exitCode !== 0 || runtime.result.signal !== null) return 'diagnostic';
  return 'formal';
}

export const aggregateVerification = aggregateMachineVerification;
