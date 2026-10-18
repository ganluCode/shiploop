/**
 * P03-7 / F-016：检查选择与机器验收跨模块集成（验收点 2 第一组）。
 *
 * 在 F-015 共享契约夹具之上做分组集成验证（真实候选校验 → 受信目标解析 →
 * 计划选择/安全回退 → 真实 Node 受监督执行器 → 机器验收聚合，同一管线）：
 * - 局部选择与安全回退：有效候选只选局部检查；候选缺失、解析拒绝与共享高
 *   风险文件变更均安全回退全量；无安全回退的政策返回 error 空计划；
 * - 参数/路径攻击：payload 级（命令/shell/环境/选项形目标/路径穿越）与
 *   解析级（目录穿越、绝对路径、选项形、符号链接逃逸）全部拒绝，候选内容
 *   不进入 argv，回退计划的 argv 仍逐字来自可信政策定义；
 * - 零测试：真实执行器产出 inconclusive，机器验收不折算为通过；
 * - 输出/证据缺口：证据未完成/损坏均不放行；
 * - 检查前后源码变化：before/after 身份漂移使旧证据失效（source_changed /
 *   execution_identity_changed），不因检查输出绿色而放行。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  contractStyle,
  openExecutorContractFixture,
  type ExecutorContractFixture,
} from '../../helpers/p03-7/check-executor-contract.ts';
import type { NodeTaskVerificationResult } from '../../../packages/core/src/application/node-task-verification.ts';
import type { MachineVerificationInput } from '../../../packages/core/src/ports/verification-aggregate.ts';
import { aggregateMachineVerification } from '../../../packages/core/src/application/verification-aggregate.ts';
import { buildVerificationPlan } from '../../../packages/core/src/application/verification-plan.ts';
import { classifyCodeAttempt } from '../../../packages/core/src/application/code-attempt-budget.ts';
import { validateTestCandidatePayload } from '../../../packages/core/src/ports/verification-candidates.ts';
import { createTestTargetResolver } from '../../../packages/core/src/adapters/fs/verification-target-resolver.ts';

const openFixtures: ExecutorContractFixture[] = [];
afterEach(() => {
  for (const fixture of openFixtures.splice(0)) fixture.close();
});
async function openFixture(options: Parameters<typeof openExecutorContractFixture>[1] = {}) {
  const fixture = await openExecutorContractFixture('node', options);
  openFixtures.push(fixture);
  return fixture;
}

const style = contractStyle('node');
const resolver = createTestTargetResolver();

const CONTRACT_IDENTITY = {
  headCommit: 'a'.repeat(40),
  codeDigest: 'b'.repeat(64),
  trackedPathsDigest: 'c',
  untrackedPathsDigest: 'd',
  executionDigest: 'e',
  environmentDigest: 'f',
};

/** 构造机器验收输入（与 F-015 aggregateFor 同构；便于叠加 overrides 后分别
 * 调用聚合与预算分类，验证输出缺口的两层闭环）。 */
function machineInput(
  fixture: ExecutorContractFixture,
  result: NodeTaskVerificationResult,
  overrides: Partial<MachineVerificationInput> = {},
): MachineVerificationInput {
  const evidence: Record<string, { status: 'complete' | 'incomplete'; reference: string | null }> = {};
  const testCounts: Record<string, number> = {};
  const rows = result.results.map((item) => {
    const output = (item.evidence as { output?: { artifactId?: string } } | null)?.output;
    const report = (item.evidence as { report?: { artifactId?: string } } | null)?.report;
    const complete = (item.evidence as { integrity?: { complete?: boolean } } | null)?.integrity?.complete === true;
    evidence[item.checkKey] = { status: complete ? 'complete' : 'incomplete', reference: report?.artifactId ?? null };
    testCounts[item.checkKey] = item.testCount ?? 0;
    return {
      checkKey: item.checkKey,
      required: fixture.plan.selectedChecks.find((check) => check.checkKey === item.checkKey)?.required ?? true,
      status: item.status,
      outputArtifactId: output?.artifactId ?? null,
    } as never;
  });
  return {
    runtime: {
      result: {
        schemaVersion: 1, terminal: 'completed', reason: null, exitCode: 0, signal: null,
        durationMs: 10, usage: null, lastEventSequence: 1,
      },
      failure: null,
      stopped: { schemaVersion: 1, confirmed: true, checkedAtUtc: '2026-01-01T00:00:00.000Z', detail: null },
    },
    workspaceHeld: true,
    beforeIdentity: CONTRACT_IDENTITY,
    afterIdentity: CONTRACT_IDENTITY,
    plan: {
      status: fixture.plan.status,
      selectedChecks: fixture.plan.selectedChecks.map((check) => ({ checkKey: check.checkKey, required: check.required })),
      requiredCheckKeys: fixture.plan.selectedChecks.filter((check) => check.required).map((check) => check.checkKey),
      affectedModules: [...fixture.plan.affectedModules],
      coveredModules: [...fixture.plan.coveredModules],
    },
    results: rows,
    evidence,
    testCounts,
    ...overrides,
  };
}

/** payload 级身份基础（合法候选的绑定字段）。 */
const payloadBase = () => ({
  schemaVersion: 1,
  projectId: 'proj-1',
  attemptId: 'attempt-1',
  executionVersion: 1,
  codeDigest: 'ab'.repeat(32),
  modules: [{ moduleKey: style.moduleKey, targets: [...style.targets], reason: '受影响模块测试目标' }],
});

describe('F-016 检查选择与安全回退（分组集成）', () => {
  it('有效候选只选局部检查；候选缺失/解析拒绝/共享高风险变更安全回退全量', async () => {
    const local = await openFixture();
    /* 局部选择：模块检查 + 必需快速检查；可选检查不启动。 */
    expect(local.plan).toMatchObject({ status: 'ready', mode: 'candidates', reasonCode: 'candidate_covered' });
    expect([...local.plan.selectedCheckKeys].sort()).toEqual([style.moduleCheckKey, style.quickCheckKey].sort());
    expect(local.plan.unselectedCheckKeys).toContain(style.optionalCheckKey);

    /* 候选缺失：安全回退全量（含可选检查），候选拒绝原因显式记录。 */
    const missing = await openFixture({ candidate: null });
    expect(missing.plan).toMatchObject({
      status: 'ready', mode: 'full_fallback', reasonCode: 'candidate_missing',
    });
    expect([...missing.plan.selectedCheckKeys].sort())
      .toEqual([style.moduleCheckKey, style.quickCheckKey, style.optionalCheckKey].sort());
    expect(missing.plan.candidateRejection).toMatchObject({ reason: 'candidate_missing' });

    /* 解析层拒绝（选项形目标）：不产生部分计划，同样安全回退。 */
    const rejected = await openFixture({ candidate: null });
    const optionShaped = await resolver.resolve({
      workspaceRoot: rejected.workspaceRoot,
      policyModules: rejected.policy.modules as never,
      candidates: [{ moduleKey: style.moduleKey, targets: ['--watch'], reason: '选项形目标' }],
    });
    expect(optionShaped).toMatchObject({ ok: false });
    const fallbackFromRejection = buildVerificationPlan({
      policy: rejected.policy, changedPaths: [{ path: style.changedPath, state: 'modified' }], candidate: null,
    });
    expect(fallbackFromRejection).toMatchObject({ status: 'ready', mode: 'full_fallback' });

    /* 共享高风险文件变更：拒绝局部放行，扩大到全量。 */
    const shared = buildVerificationPlan({
      policy: rejected.policy,
      changedPaths: [{ path: style.sharedHighRiskFiles[0]!, state: 'modified' }],
      candidate: rejected.candidate,
    });
    expect(shared).toMatchObject({ status: 'ready', mode: 'full_fallback', reasonCode: 'shared_high_risk_change' });

    /* 回退计划的 argv 仍逐字来自可信政策定义（候选永不产生命令）。 */
    for (const check of fallbackFromRejection.selectedChecks) {
      expect(check.argv).toEqual(style.argv('pass', style.targets)[check.checkKey]);
    }
  });

  it('无安全全量回退的政策返回 error 空计划，不生成部分计划或零检查放行', async () => {
    const fixture = await openFixture({ candidate: null, policy: undefined });
    const withoutFallback = { ...fixture.policy } as Record<string, unknown>;
    delete withoutFallback.fullFallback;
    const plan = buildVerificationPlan({
      policy: withoutFallback, changedPaths: [{ path: style.changedPath, state: 'modified' }], candidate: null,
    });
    expect(plan.status).toBe('error');
    expect(plan.selectedCheckKeys).toEqual([]);
    expect(plan.selectedChecks).toEqual([]);
    expect(plan.mode).toBe('full_fallback');
  });
});

describe('F-016 参数/路径攻击（候选校验与受信解析分组）', () => {
  it('payload 级攻击：命令/shell/环境/选项形目标/路径穿越全部拒绝', () => {
    const attacks: readonly { name: string; mutate: (base: ReturnType<typeof payloadBase>) => unknown }[] = [
      { name: '携带命令字段', mutate: base => ({ ...base, command: ['rm', '-rf', '/'] }) },
      { name: '携带 shell 字段', mutate: base => ({ ...base, shell: 'npm test | sh' }) },
      { name: '携带环境修改', mutate: base => ({ ...base, environment: { NODE_OPTIONS: '--inspect' } }) },
      { name: '目录穿越目标', mutate: base => ({ ...base, modules: [{ ...base.modules[0]!, targets: ['../../etc/passwd'] }] }) },
      { name: '外部绝对路径', mutate: base => ({ ...base, modules: [{ ...base.modules[0]!, targets: ['/etc/passwd'] }] }) },
      { name: '选项形目标', mutate: base => ({ ...base, modules: [{ ...base.modules[0]!, targets: ['--experimental-strip-types'] }] }) },
      { name: '点段目标', mutate: base => ({ ...base, modules: [{ ...base.modules[0]!, targets: ['packages/./core'] }] }) },
      { name: '反斜杠逃逸', mutate: base => ({ ...base, modules: [{ ...base.modules[0]!, targets: ['..\\\\etc'] }] }) },
    ];
    for (const attack of attacks) {
      expect(() => validateTestCandidatePayload(attack.mutate(payloadBase()), 'F-016.attack'), attack.name).toThrow();
    }
  });

  it('解析级攻击：穿越/绝对路径/选项形/符号链接逃逸被拒绝，不返回规范化目标', async () => {
    const fixture = await openFixture({ candidate: null });
    /* 叶子符号链接逃逸：工作区内链接指向区外真实文件。 */
    const outside = join(fixture.workspaceRoot, '..', 'outside-secret.txt');
    symlinkSync('/etc/hosts', outside);
    const cases: readonly { name: string; targets: readonly string[] }[] = [
      { name: '目录穿越', targets: ['../../outside-secret.txt'] },
      { name: '外部绝对路径', targets: ['/etc/hosts'] },
      { name: '选项形目标', targets: ['-x'] },
      { name: '政策外目标', targets: [style.outsideTarget] },
      { name: '叶子符号链接', targets: ['../outside-secret.txt'] },
    ];
    for (const entry of cases) {
      const resolution = await resolver.resolve({
        workspaceRoot: fixture.workspaceRoot,
        policyModules: fixture.policy.modules as never,
        candidates: [{ moduleKey: style.moduleKey, targets: [...entry.targets], reason: '攻击目标' }],
      }, );
      expect(resolution.ok, entry.name).toBe(false);
    }
    /* 全部拒绝后：计划层只能安全回退（不携带任何候选目标内容）。 */
    const plan = buildVerificationPlan({
      policy: fixture.policy, changedPaths: [{ path: style.changedPath, state: 'modified' }], candidate: null,
    });
    expect(plan).toMatchObject({ status: 'ready', mode: 'full_fallback' });
    for (const check of plan.selectedChecks) {
      expect(check.argv).toEqual(style.argv('pass', style.targets)[check.checkKey]);
      expect(JSON.stringify(check.argv)).not.toContain('outside-secret');
    }
  });
});

describe('F-016 零测试与证据缺口（真实执行器 + 机器验收分组）', () => {
  it('零测试：真实 Node 执行器产出 inconclusive，机器验收不折算为通过', async () => {
    const fixture = await openFixture({ scenario: 'zero-tests' });
    const result = await fixture.start();
    for (const item of result.results) {
      expect(item.status).not.toBe('passed');
      expect(item.reason).toBe('invalid_result_protocol');
    }
    const aggregate = fixture.aggregate(result);
    expect(aggregate.machinePassed).toBe(false);
    expect(aggregate.status).not.toBe('passed');
    /* 验收协议层：收集数量为零同样不放行（与 F-015 语义一致的聚合分组）。 */
    const passFixture = await openFixture({ scenario: 'pass' });
    const passResult = await passFixture.start();
    const zero = passFixture.aggregate(passResult, {
      testCounts: Object.fromEntries(passFixture.plan.selectedChecks.map(check => [check.checkKey, 0])),
    });
    expect(zero).toMatchObject({ machinePassed: false, category: 'zero_tests' });
  });

  it('输出/证据缺口：证据未完成或损坏均不放行，输出引用缺失不冒充完整证据', async () => {
    const fixture = await openFixture({ scenario: 'pass' });
    const result = await fixture.start();
    /* 基线：完整证据放行。 */
    expect(fixture.aggregate(result)).toMatchObject({ machinePassed: true, category: 'passed' });
    /* 证据未完成（passed 但 evidence 状态非 complete）。 */
    const incomplete = fixture.aggregate(result, {
      evidence: Object.fromEntries(fixture.plan.selectedChecks.map(check => [check.checkKey, { status: 'incomplete' }])),
    });
    expect(incomplete).toMatchObject({ machinePassed: false, category: 'evidence_incomplete' });
    /* 证据损坏（incomplete 状态在结果行未通过时判损坏，此处直接构造损坏态）。 */
    const corrupt = fixture.aggregate(result, {
      results: (result.results as unknown as { status: string }[]).map(item => ({ ...item, status: 'failed' })) as never,
      evidence: Object.fromEntries(fixture.plan.selectedChecks.map(check => [check.checkKey, { status: 'incomplete' }])),
    });
    expect(corrupt.machinePassed).toBe(false);
    /* 输出引用缺失：验收聚合单独不拒绝（引用计入 refs），但预算分类层
     * （classifyCodeAttempt）对无输出制品的结果 fail-closed：非代码失败不
     * 放行、也不误扣代码额度 —— 输出缺口跨模块闭环。 */
    const noOutputRows = (result.results as unknown as Record<string, unknown>[])
      .map(item => ({ ...item, outputArtifactId: null }));
    const noOutputInput = machineInput(fixture, result, { results: noOutputRows as never });
    expect(aggregateMachineVerification(noOutputInput).machinePassed).toBe(true);
    const classified = classifyCodeAttempt(noOutputInput, {});
    expect(classified).toMatchObject({ outcome: 'non_code_failure', reason: 'evidence_incomplete' });
  });

  it('检查前后源码变化：before/after 身份漂移使旧证据失效', async () => {
    const fixture = await openFixture({ scenario: 'pass' });
    const result = await fixture.start();
    /* 基线：身份一致放行。 */
    expect(fixture.aggregate(result).machinePassed).toBe(true);
    const identity = {
      headCommit: 'a'.repeat(40), codeDigest: 'b'.repeat(64),
      trackedPathsDigest: 'c', untrackedPathsDigest: 'd',
    };
    /* 源码变化：检查期间 tracked/untracked 内容漂移。 */
    const sourceChanged = fixture.aggregate(result, {
      beforeIdentity: identity,
      afterIdentity: { ...identity, trackedPathsDigest: 'c2' },
    });
    expect(sourceChanged).toMatchObject({ machinePassed: false, category: 'source_changed' });
    /* 执行依据变化：executionDigest 漂移。 */
    const executionChanged = fixture.aggregate(result, {
      beforeIdentity: { ...identity, executionDigest: 'e' },
      afterIdentity: { ...identity, executionDigest: 'e2' },
    });
    expect(executionChanged).toMatchObject({ machinePassed: false, category: 'execution_identity_changed' });
    /* 批次身份与验证开始身份不一致（expectedCodeDigest 锚点核验）。 */
    const anchored = fixture.aggregate(result, {
      beforeIdentity: identity,
      afterIdentity: identity,
      expectedCodeDigest: 'f'.repeat(64),
    });
    expect(anchored).toMatchObject({ machinePassed: false, category: 'source_changed' });
  });
});
