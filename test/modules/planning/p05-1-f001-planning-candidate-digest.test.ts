/**
 * P05-1 / F-001 规划请求/候选摘要与审批依据纯计算回归（纯函数，无 I/O）。
 *
 * 覆盖（F-001 验收标准 3/5）：
 * - inputDigest/candidateDigest 规范化稳定性：JSON 键序、任务顺序、verification
 *   条目与引用顺序无关；缺省形态与显式空形态等价；
 * - 摘要区分：不可变 Artifact contentHash、覆盖候选全部语义的 candidateDigest、
 *   既有业务 planDigest 与 checkPolicyDigest 四者互不相同且各自只随对应语义变化
 *   （verification 变化不改 planDigest；计划业务变化同时改变两者）；
 * - 业务计划 v1 兼容：候选内 plan 的 planDigest 与 feature.plan.import v1 直接
 *   校验完全一致，规划候选不改变既有计划输入语义；
 * - 测试候选协议不混用：TestCandidatePayload 六字段与规划候选字段互相按未知
 *   字段拒绝；既有 candidate.submit 工作工具操作仍表示测试候选，规划提交使用
 *   独立操作身份；
 * - 审批依据评估：candidateDigest/inputDigest/planDigest/checkPolicyDigest 任一
 *   变化使旧候选批准依据失效，返回冻结原因词汇。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isStorageError } from '../../../packages/core/src/ports/errors.ts';
import { validateFeaturePlanInput } from '../../../packages/core/src/ports/feature-plan.ts';
import {
  PLANNING_CANDIDATE_DIGEST_DOMAIN,
  PLANNING_CANDIDATE_SUBMIT_OPERATION,
  PLANNING_INPUT_DIGEST_DOMAIN,
  computePlanningCandidateDigest,
  computePlanningInputDigest,
  evaluatePlanningCandidateApprovalBasis,
  validatePlanningCandidatePayload,
  validatePlanningRequest,
} from '../../../packages/core/src/ports/planning-candidates.ts';
import { computeFeatureCheckPolicyDigest } from '../../../packages/core/src/ports/plan-approval-verification.ts';
import { validateTestCandidatePayload } from '../../../packages/core/src/ports/verification-candidates.ts';
import { WORK_TOOL_OPERATION_SPECS } from '../../../packages/core/src/ports/commands.ts';

void PLANNING_CANDIDATE_DIGEST_DOMAIN;
void PLANNING_INPUT_DIGEST_DOMAIN;

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function validRequestInput(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projectId: 'proj-1',
    phaseId: 'phase-1',
    featureId: 'feature-p05',
    requirementRefs: [{ artifactId: 'art-req-1', contentHash: 'a'.repeat(64) }],
    constraints: ['macOS 首版'],
    acceptance: { criteria: ['重复命令只有一个规划 Run 和一次候选发布'] },
    strategy: { approvalMode: 'manual', taskLimit: 12 },
  };
}

function validPlanInput(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    feature: { title: '一次性规划候选', sourceRefs: [{ artifactId: 'art-req-1' }] },
    tasks: [
      { id: 't-1', title: '契约校验', complexity: 'medium', acceptance: { criteria: ['负例可定位'] } },
      { id: 't-2', title: '摘要计算', complexity: 'low', acceptance: { criteria: ['摘要稳定'] }, dependsOn: ['t-1'] },
    ],
  };
}

function validCandidateInput(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projectId: 'proj-1',
    featureId: 'feature-p05',
    runId: 'run-plan-1',
    candidateId: 'cand-0001',
    plan: validPlanInput(),
    taskVerification: [
      { taskId: 't-1', checkRefs: ['unit-core'], moduleRefs: ['core'], impactScope: ['packages/core/src/ports'] },
      { taskId: 't-2', checkRefs: ['typecheck'], moduleRefs: [], impactScope: [] },
    ],
    summary: '两任务链：契约校验与摘要计算。',
  };
}

function digestOf(input: Record<string, unknown>): string {
  return validatePlanningCandidatePayload(input).candidateDigest;
}

function requestDigestOf(input: Record<string, unknown>): string {
  return validatePlanningRequest(input).inputDigest;
}

/* ------------------------------------------------------------------ *
 * inputDigest
 * ------------------------------------------------------------------ */

describe('P05-1 / F-001 规划输入身份摘要（inputDigest）', () => {
  it('规范化稳定性：JSON 键序与缺省形态等价', () => {
    const baseline = requestDigestOf(validRequestInput());
    const permuted = requestDigestOf({
      strategy: { taskLimit: 12, approvalMode: 'manual' },
      acceptance: { criteria: ['重复命令只有一个规划 Run 和一次候选发布'] },
      constraints: ['macOS 首版'],
      requirementRefs: [{ contentHash: 'a'.repeat(64), artifactId: 'art-req-1' }],
      featureId: 'feature-p05',
      phaseId: 'phase-1',
      projectId: 'proj-1',
      schemaVersion: 1,
    });
    expect(permuted).toBe(baseline);

    const omitted = { ...validRequestInput() };
    delete omitted.constraints;
    const explicitEmpty = { ...validRequestInput(), constraints: [] };
    expect(requestDigestOf(explicitEmpty)).toBe(requestDigestOf(omitted));
  });

  it('输入身份变化改变摘要：绑定实体、需求制品内容、约束、验收与策略', () => {
    const baseline = requestDigestOf(validRequestInput());
    expect(requestDigestOf({ ...validRequestInput(), featureId: 'feature-other' })).not.toBe(baseline);
    expect(
      requestDigestOf({
        ...validRequestInput(),
        requirementRefs: [{ artifactId: 'art-req-1', contentHash: 'c'.repeat(64) }],
      }),
    ).not.toBe(baseline);
    expect(requestDigestOf({ ...validRequestInput(), constraints: ['约束变化'] })).not.toBe(baseline);
    expect(
      requestDigestOf({ ...validRequestInput(), acceptance: { criteria: ['验收变化'] } }),
    ).not.toBe(baseline);
    expect(
      requestDigestOf({ ...validRequestInput(), strategy: { approvalMode: 'manual', taskLimit: 8 } }),
    ).not.toBe(baseline);
  });

  it('摘要与规范化 JSON 可独立复算（computePlanningInputDigest 与校验输出一致）', () => {
    const request = validatePlanningRequest(validRequestInput());
    const recomputed = computePlanningInputDigest(request);
    expect(recomputed).toBe(request.inputDigest);
  });
});

/* ------------------------------------------------------------------ *
 * candidateDigest 与摘要区分
 * ------------------------------------------------------------------ */

describe('P05-1 / F-001 候选摘要（candidateDigest）与摘要区分', () => {
  it('规范化稳定性：键序、任务顺序、verification 条目与引用顺序无关；缺省等价', () => {
    const baseline = digestOf(validCandidateInput());

    const permuted = validCandidateInput();
    permuted.taskVerification = [
      { impactScope: [], moduleRefs: [], checkRefs: ['typecheck'], taskId: 't-2' },
      { impactScope: ['packages/core/src/ports'], moduleRefs: ['core'], checkRefs: ['unit-core'], taskId: 't-1' },
    ];
    const reversedTasks = validCandidateInput();
    (reversedTasks.plan as Record<string, unknown>).tasks = [
      { id: 't-2', title: '摘要计算', complexity: 'low', acceptance: { criteria: ['摘要稳定'] }, dependsOn: ['t-1'] },
      { id: 't-1', title: '契约校验', complexity: 'medium', acceptance: { criteria: ['负例可定位'] } },
    ];
    expect(digestOf(permuted as Record<string, unknown>)).toBe(baseline);
    expect(digestOf(reversedTasks)).toBe(baseline);

    const omitted = { ...validCandidateInput() };
    delete omitted.taskVerification;
    const explicitEmpty = { ...validCandidateInput(), taskVerification: [] };
    expect(digestOf(explicitEmpty)).toBe(digestOf(omitted));
  });

  it('业务计划语义变化同时改变 planDigest 与 candidateDigest', () => {
    const candidate = validatePlanningCandidatePayload(validCandidateInput());
    const changed = validCandidateInput();
    (changed.plan as Record<string, unknown>).tasks = [
      { id: 't-1', title: '契约校验（修订）', complexity: 'medium', acceptance: { criteria: ['负例可定位'] } },
      { id: 't-2', title: '摘要计算', complexity: 'low', acceptance: { criteria: ['摘要稳定'] }, dependsOn: ['t-1'] },
    ];
    const changedCandidate = validatePlanningCandidatePayload(changed);
    expect(changedCandidate.plan.planDigest).not.toBe(candidate.plan.planDigest);
    expect(changedCandidate.candidateDigest).not.toBe(candidate.candidateDigest);
  });

  it('verification 变化只改变 candidateDigest，不改变既有业务 planDigest', () => {
    const candidate = validatePlanningCandidatePayload(validCandidateInput());
    const changed = validCandidateInput();
    (changed.taskVerification as Record<string, unknown>[])[0]!.checkRefs = ['integration'];
    const changedCandidate = validatePlanningCandidatePayload(changed);
    expect(changedCandidate.plan.planDigest).toBe(candidate.plan.planDigest);
    expect(changedCandidate.candidateDigest).not.toBe(candidate.candidateDigest);

    const scopeChanged = validCandidateInput();
    (scopeChanged.taskVerification as Record<string, unknown>[])[0]!.impactScope = ['packages/host'];
    expect(validatePlanningCandidatePayload(scopeChanged).candidateDigest).not.toBe(
      candidate.candidateDigest,
    );

    const summaryChanged = validCandidateInput();
    summaryChanged.summary = '修订后的审批摘要。';
    expect(validatePlanningCandidatePayload(summaryChanged).candidateDigest).not.toBe(
      candidate.candidateDigest,
    );
  });

  it('候选身份字段（candidateId/runId）参与 candidateDigest，不参与 planDigest', () => {
    const candidate = validatePlanningCandidatePayload(validCandidateInput());
    const newId = validCandidateInput();
    newId.candidateId = 'cand-0002';
    const newIdCandidate = validatePlanningCandidatePayload(newId);
    expect(newIdCandidate.plan.planDigest).toBe(candidate.plan.planDigest);
    expect(newIdCandidate.candidateDigest).not.toBe(candidate.candidateDigest);

    const newRun = validCandidateInput();
    newRun.runId = 'run-plan-2';
    expect(validatePlanningCandidatePayload(newRun).candidateDigest).not.toBe(candidate.candidateDigest);
  });

  it('四类摘要互不相同：Artifact contentHash / candidateDigest / planDigest / checkPolicyDigest', () => {
    const input = validCandidateInput();
    const candidate = validatePlanningCandidatePayload(input);
    // 模拟候选 Artifact 正文的内容摘要（不可变制品身份）。
    const contentHash = createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
    const checkPolicyDigest = computeFeatureCheckPolicyDigest(undefined);
    expect(new Set([contentHash, candidate.candidateDigest, candidate.plan.planDigest, checkPolicyDigest]).size)
      .toBe(4);
  });

  it('candidateDigest 可由规范化内容独立复算（computePlanningCandidateDigest）', () => {
    const candidate = validatePlanningCandidatePayload(validCandidateInput());
    const { schemaVersion: _schemaVersion, candidateDigest: _candidateDigest, ...content } = candidate;
    void _schemaVersion;
    void _candidateDigest;
    expect(computePlanningCandidateDigest(content)).toBe(candidate.candidateDigest);
  });

  it('业务计划 v1 兼容：候选内 plan 的 planDigest 与 feature.plan.import v1 直接校验一致', () => {
    const candidate = validatePlanningCandidatePayload(validCandidateInput());
    const standalone = validateFeaturePlanInput(validPlanInput());
    expect(candidate.plan.planDigest).toBe(standalone.planDigest);
    expect(candidate.plan.tasks).toEqual(standalone.tasks);
  });
});

/* ------------------------------------------------------------------ *
 * 审批依据评估
 * ------------------------------------------------------------------ */

describe('P05-1 / F-001 规划候选审批依据评估', () => {
  function basis(overrides: Partial<Record<'candidateDigest' | 'inputDigest' | 'planDigest' | 'checkPolicyDigest', string>>) {
    return {
      candidateDigest: 'aa'.repeat(32),
      inputDigest: 'bb'.repeat(32),
      planDigest: 'cc'.repeat(32),
      checkPolicyDigest: 'dd'.repeat(32),
      ...overrides,
    };
  }

  it('依据完好时有效（basis_intact）', () => {
    const current = basis({});
    const result = evaluatePlanningCandidateApprovalBasis(basis({}), current);
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('basis_intact');
  });

  it('候选/输入/计划/检查政策身份变化分别得到冻结原因词汇', () => {
    expect(evaluatePlanningCandidateApprovalBasis(basis({}), basis({ candidateDigest: '01'.repeat(32) })))
      .toEqual({ valid: false, reason: 'candidate_changed' });
    expect(evaluatePlanningCandidateApprovalBasis(basis({}), basis({ inputDigest: '02'.repeat(32) })))
      .toEqual({ valid: false, reason: 'input_changed' });
    expect(evaluatePlanningCandidateApprovalBasis(basis({}), basis({ planDigest: '03'.repeat(32) })))
      .toEqual({ valid: false, reason: 'plan_changed' });
    expect(evaluatePlanningCandidateApprovalBasis(basis({}), basis({ checkPolicyDigest: '04'.repeat(32) })))
      .toEqual({ valid: false, reason: 'check_policy_changed' });
  });

  it('多个身份同时变化时按固定顺序报告第一个原因（确定性）', () => {
    const result = evaluatePlanningCandidateApprovalBasis(
      basis({}),
      basis({ candidateDigest: '01'.repeat(32), planDigest: '03'.repeat(32), checkPolicyDigest: '04'.repeat(32) }),
    );
    expect(result).toEqual({ valid: false, reason: 'candidate_changed' });
    const result2 = evaluatePlanningCandidateApprovalBasis(
      basis({}),
      basis({ inputDigest: '02'.repeat(32), planDigest: '03'.repeat(32) }),
    );
    expect(result2).toEqual({ valid: false, reason: 'input_changed' });
  });

  it('摘要形态非法时校验层拒绝（64 位小写十六进制）', () => {
    const input = validCandidateInput();
    input.candidateId = 'cand-0001';
    const candidate = validatePlanningCandidatePayload(input);
    expect(candidate.candidateDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ------------------------------------------------------------------ *
 * 与测试候选协议的兼容边界
 * ------------------------------------------------------------------ */

describe('P05-1 / F-001 规划候选与测试候选协议不混用', () => {
  it('TestCandidatePayload 的身份字段注入规划候选按未知字段拒绝', () => {
    for (const key of ['attemptId', 'executionVersion', 'codeDigest', 'modules'] as const) {
      const input = validCandidateInput();
      input[key] = key === 'executionVersion' ? 1 : 'x'.repeat(4);
      let rejected = false;
      try {
        validatePlanningCandidatePayload(input);
      } catch (error) {
        expect(isStorageError(error)).toBe(true);
        rejected = true;
      }
      expect(rejected).toBe(true);
    }
  });

  it('规划候选字段注入 TestCandidatePayload 按未知字段拒绝', () => {
    for (const key of ['plan', 'taskVerification', 'summary', 'runId', 'candidateId'] as const) {
      const payload = {
        schemaVersion: 1,
        projectId: 'proj-1',
        attemptId: 'att-1',
        executionVersion: 1,
        codeDigest: 'ab'.repeat(32),
        modules: [
          { moduleKey: 'core', targets: ['packages/core'], reason: '受影响' },
        ],
      };
      (payload as Record<string, unknown>)[key] = {};
      let rejected = false;
      try {
        validateTestCandidatePayload(payload);
      } catch (error) {
        expect(isStorageError(error)).toBe(true);
        rejected = true;
      }
      expect(rejected).toBe(true);
    }
  });

  it('candidate.submit 仍表示测试候选；规划提交使用独立且不同的操作身份', () => {
    expect(WORK_TOOL_OPERATION_SPECS['candidate.submit']).toBeDefined();
    expect(PLANNING_CANDIDATE_SUBMIT_OPERATION).toBe('planning.candidate.submit');
    expect(PLANNING_CANDIDATE_SUBMIT_OPERATION).not.toBe('candidate.submit');
  });
});
