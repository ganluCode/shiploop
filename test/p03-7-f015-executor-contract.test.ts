/**
 * P03-7 / F-015 跨检查执行器契约用例（参数化同一组契约，不复制整套资源夹具）。
 *
 * 定位：证明「选择与验收协议」不依赖 Node 测试目录、npm 约定或任何语言特例。
 * 同一组契约用例分别跑在：
 * - 真实 Node 执行器（生产 createNodeTaskVerificationExecutor + 真实受监督 Node 进程）；
 * - 受信测试执行器（确定性测试替身；仅契约用途，不代表已实现 Python/Java adapter，
 *   也不安装额外语言工具链）。
 *
 * 断言真实计划（buildVerificationPlan）、真实结果与保存记录、真实拒绝原因
 * （受控拒绝码），不用空测试成功代替协议证明。各职责自身的正常/负例仍由
 * F-001..F-006 实现任务交付，本文件只补充跨执行器一致性。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHECK_EXECUTOR_CATALOG,
  CONTRACT_SCENARIOS,
  CONTRACT_STYLES,
  CheckExecutorSelectionError,
  contractPolicyFor,
  contractStyle,
  openExecutorContractFixture,
  outcomeOf,
  scenarioReportPayload,
  selectCheckExecutor,
  type ContractScenario,
  type ExecutorContractFixture,
} from './helpers/p03-7/check-executor-contract.ts';
import {
  validateNodeCheckReport,
} from '../packages/core/src/application/node-task-verification.ts';
import { buildVerificationPlan } from '../packages/core/src/application/verification-plan.ts';
import { createTestTargetResolver } from '../packages/core/src/adapters/fs/verification-target-resolver.ts';
import { validateConfirmedTaskVerificationPolicy } from '../packages/core/src/ports/task-verification-policy.ts';
import { isStorageError } from '../packages/core/src/ports/errors.ts';

const STYLE_IDS = CONTRACT_STYLES.map((style) => style.styleId);

const openFixtures: ExecutorContractFixture[] = [];
afterEach(() => {
  for (const fixture of openFixtures.splice(0)) fixture.close();
});
async function openFixture(
  styleId: (typeof STYLE_IDS)[number],
  options: Parameters<typeof openExecutorContractFixture>[1] = {},
) {
  const fixture = await openExecutorContractFixture(styleId, options);
  openFixtures.push(fixture);
  return fixture;
}

describe.each(STYLE_IDS)('P03-7 F-015 跨执行器契约（%s）', (styleId) => {
  const style = contractStyle(styleId);

  it('有效局部选择：候选覆盖受影响模块、必需快速检查保留、无安全回退、argv 逐字来自可信定义', async () => {
    const fixture = await openFixture(styleId, { scenario: 'pass' });
    // 真实计划：candidates 模式放行局部检查，安全全量回退未被触发。
    expect(fixture.plan.status).toBe('ready');
    expect(fixture.plan.mode).toBe('candidates');
    expect(fixture.plan.reasonCode).toBe('candidate_covered');
    expect(fixture.plan.candidateRejection).toBeNull();
    // 受影响模块与候选覆盖一致；模块检查与必需快速（task）检查保留，可选检查不启动。
    expect(fixture.plan.affectedModules).toEqual([style.moduleKey]);
    expect([...fixture.plan.selectedCheckKeys].sort()).toEqual([style.moduleCheckKey, style.quickCheckKey].sort());
    expect(fixture.plan.unselectedCheckKeys).toContain(style.optionalCheckKey);
    // 可信 argv：候选只选目标，argv 逐字来自已确认 CheckDefinition，无 Node/npm 特例改写。
    for (const check of fixture.plan.selectedChecks) {
      expect(check.argv).toEqual(style.argv('pass', style.targets)[check.checkKey]);
    }
    if (styleId === 'trusted-test') {
      const argv = fixture.plan.selectedChecks.find((check) => check.checkKey === style.moduleCheckKey)?.argv ?? [];
      expect(argv).toEqual(['python3', '-m', 'pytest', 'tests/test_alpha.py', 'suites/unit']);
      expect(argv.some((token) => token === 'npm' || token === 'node')).toBe(false);
    }
    // 目标标识原样通过模块/目标解析（无语言归一化）。
    expect(fixture.candidate.modules[0]?.targets.map((target) => target.target)).toEqual([...style.targets]);
  });

  it('执行真实计划：逐项状态、覆盖证据与输出引用齐全，机器验收聚合放行', async () => {
    const fixture = await openFixture(styleId, { scenario: 'pass' });
    const result = await fixture.start();
    const outcomes = outcomeOf(result);
    expect(outcomes.map((item) => item.checkKey).sort()).toEqual([style.moduleCheckKey, style.quickCheckKey].sort());
    for (const item of outcomes) {
      expect(item.status).toBe('passed');
      expect(item.reason).toBeNull();
      expect(item.resultId).toBeTruthy();
      expect(item.testCount ?? 0).toBeGreaterThanOrEqual(1);
      expect(item.outputArtifactId).toBeTruthy();
    }
    // 逐项保存记录携带状态与输出引用（不是内存返回值冒充）。
    const saved = fixture.recording.resultRecords();
    expect(saved).toHaveLength(outcomes.length);
    for (const row of saved) {
      expect(row.status).toBe('passed');
      expect(row.outputArtifactId).toBeTruthy();
    }
    // 批次检查快照保留可信 argv（与政策定义逐字一致）。
    const snapshot = fixture.recording.batchInput().checkSnapshot as readonly { checkKey: string; argv: readonly string[] }[];
    const moduleSnapshot = snapshot.find((entry) => entry.checkKey === style.moduleCheckKey);
    expect(moduleSnapshot?.argv).toEqual(style.argv('pass', style.targets)[style.moduleCheckKey]);
    // 覆盖证据：结果覆盖计划目标（共享协议），机器验收放行。
    const aggregate = fixture.aggregate(result);
    expect(aggregate).toMatchObject({ machinePassed: true, status: 'passed', category: 'passed' });
  });

  it('零测试不放行：协议拒绝收集声明，验收语义对两种执行器一致', async () => {
    const fixture = await openFixture(styleId, { scenario: 'zero-tests' });
    // 共享协议：零测试的覆盖报告不是有效覆盖证据（受控拒绝码 testCount）。
    expect(() => validateNodeCheckReport(scenarioReportPayload('zero-tests', style.targets), style.targets))
      .toThrow(/testCount/);
    const result = await fixture.start();
    for (const item of outcomeOf(result)) {
      expect(item.status).not.toBe('passed');
      expect(item.reason).toBe('invalid_result_protocol');
      expect(item.testCount).toBeNull();
      // 即使拒绝通过，输出引用仍逐项保留。
      expect(item.outputArtifactId).toBeTruthy();
    }
    expect(fixture.aggregate(result).machinePassed).toBe(false);
    // 验收协议层：零测试不得折算为通过（同一聚合语义）。
    const passFixture = await openFixture(styleId, { scenario: 'pass' });
    const passResult = await passFixture.start();
    const zero = passFixture.aggregate(passResult, {
      testCounts: Object.fromEntries(passFixture.plan.selectedChecks.map((check) => [check.checkKey, 0])),
    });
    expect(zero).toMatchObject({ machinePassed: false, category: 'zero_tests' });
  });

  it('不完整覆盖不放行：报告缺目标与计划覆盖缺口结论一致', async () => {
    const fixture = await openFixture(styleId, { scenario: 'incomplete-coverage' });
    expect(() => validateNodeCheckReport(scenarioReportPayload('incomplete-coverage', style.targets), style.targets))
      .toThrow(/target_coverage/);
    const result = await fixture.start();
    for (const item of outcomeOf(result)) {
      expect(item.status).not.toBe('passed');
      expect(item.reason).toBe('invalid_result_protocol');
    }
    expect(fixture.aggregate(result).machinePassed).toBe(false);
    // 计划覆盖缺口（coveredModules 未覆盖受影响模块）同样不放行。
    const passFixture = await openFixture(styleId, { scenario: 'pass' });
    const passResult = await passFixture.start();
    const gap = passFixture.aggregate(passResult, {
      plan: {
        status: 'ready',
        selectedChecks: passFixture.plan.selectedChecks.map((check) => ({ checkKey: check.checkKey, required: check.required })),
        affectedModules: [...passFixture.plan.affectedModules],
        coveredModules: [],
      },
    });
    expect(gap).toMatchObject({ machinePassed: false, category: 'coverage_incomplete' });
  });

  it('不合法结果协议拒绝通过：受控拒绝码与逐项不放行', async () => {
    const fixture = await openFixture(styleId, { scenario: 'invalid-protocol' });
    expect(() => validateNodeCheckReport(scenarioReportPayload('invalid-protocol', style.targets), style.targets))
      .toThrow(/protocol_or_collection/);
    // 其他不合法协议形态同样按受控原因拒绝（同一共享校验器）。
    const base = scenarioReportPayload('pass', style.targets);
    for (const [payload, code] of [
      [{ ...base, schemaVersion: 2 }, 'protocol_or_collection'],
      [{ ...base, collected: false }, 'collected'],
      [{ ...base, extraField: 1 }, 'unknown_field'],
      [{ ...base, targets: [] }, 'targets'],
      [{ ...base, testCount: 1.5 }, 'testCount'],
      ['{"ok":true}', 'object_required'],
    ] as const) {
      expect(() => validateNodeCheckReport(payload, style.targets), String(code)).toThrow(new RegExp(code));
    }
    const result = await fixture.start();
    for (const item of outcomeOf(result)) {
      expect(item.status).not.toBe('passed');
      expect(item.reason).toBe('invalid_result_protocol');
    }
    expect(fixture.aggregate(result).machinePassed).toBe(false);
  });

  it('未知执行器被拒绝：执行器目录与可信政策两侧均 fail-closed', async () => {
    const fixture = await openFixture(styleId, { scenario: 'pass' });
    // 执行器目录：未登记的执行器（如未来 Python/Java adapter）不返回可用执行器。
    expect(() => selectCheckExecutor('shiploop.python-adapter', style.targets)).toThrow(CheckExecutorSelectionError);
    try {
      selectCheckExecutor('shiploop.python-adapter', style.targets);
      expect.unreachable('未知执行器必须被拒绝');
    } catch (error) {
      expect(error).toBeInstanceOf(CheckExecutorSelectionError);
      expect((error as CheckExecutorSelectionError).reason).toBe('unknown_executor');
    }
    // 可信政策边界：未知检查执行类型（kind）拒绝，且不产出可启动计划。
    const policy = {
      ...fixture.policy,
      checkDefinitions: (fixture.policy.checkDefinitions as readonly Record<string, unknown>[]).map((check) => ({
        ...check,
        kind: 'python-adapter',
      })),
    };
    try {
      validateConfirmedTaskVerificationPolicy(policy, {
        operation: 'F-015.contract',
        entity: { type: 'project_settings', projectId: 'verification-plan' },
      });
      expect.unreachable('未知检查执行类型必须被拒绝');
    } catch (error) {
      expect(isStorageError(error)).toBe(true);
      expect((error as { details?: Record<string, unknown> }).details?.reason).toBe('unsupported_execution_kind');
    }
    const plan = buildVerificationPlan({
      policy,
      changedPaths: [{ path: style.changedPath, state: 'modified' }],
      candidate: fixture.candidate,
    });
    expect(plan.status).toBe('error');
    expect(plan.selectedCheckKeys).toEqual([]);
  });

  it('未知执行器的计划不放行：两种执行器均不启动任何检查', async () => {
    for (const id of STYLE_IDS) {
      const policy = contractPolicyFor(id);
      policy.checkDefinitions = (policy.checkDefinitions as readonly Record<string, unknown>[]).map((check) => ({
        ...check,
        kind: 'python-adapter',
      }));
      const fixture = await openFixture(id, { policy });
      expect(fixture.plan.status).toBe('error');
      const result = await fixture.start();
      expect(result.status).not.toBe('passed');
      expect(fixture.aggregate(result)).toMatchObject({ machinePassed: false, category: 'plan_not_ready' });
    }
  });

  it('未声明目标能力与未声明目标均被拒绝', async () => {
    const fixture = await openFixture(styleId, { scenario: 'pass' });
    // 执行器未声明的目标能力（如 Node 执行器 + 非 Node 标识）拒绝选择。
    expect(() => selectCheckExecutor('shiploop.node-check-executor', ['suite:alpha', 'pytest:tests/test_alpha.py::test_ok']))
      .toThrow(new RegExp('undeclared_target_capability'));
    try {
      selectCheckExecutor('shiploop.node-check-executor', ['suite:alpha']);
      expect.unreachable('未声明目标能力必须被拒绝');
    } catch (error) {
      expect((error as CheckExecutorSelectionError).reason).toBe('undeclared_target_capability');
    }
    // 声明目录本身不含未登记执行器。
    expect(CHECK_EXECUTOR_CATALOG.map((item) => item.executorId)).toEqual([
      'shiploop.node-check-executor',
      'shiploop.trusted-test-executor',
    ]);
    // 政策未声明的目标（模块 allowedTargets 之外）由受信目标解析拒绝。
    const resolver = createTestTargetResolver();
    const resolution = await resolver.resolve({
      workspaceRoot: fixture.workspaceRoot,
      policyModules: fixture.policy.modules as never,
      candidates: [{ moduleKey: style.moduleKey, targets: [style.outsideTarget], reason: 'r' }],
    });
    expect(resolution).toMatchObject({ ok: false, reason: 'target_not_allowed' });
    // 结果协议要求报告覆盖计划目标：未声明/未覆盖的目标集合被拒绝。
    expect(() => validateNodeCheckReport(scenarioReportPayload('pass', [style.outsideTarget]), style.targets))
      .toThrow(/target_coverage/);
  });
});

describe('P03-7 F-015 跨执行器一致性', () => {
  it.each(CONTRACT_SCENARIOS)('%s 场景两种执行器结论一致', async (scenario: ContractScenario) => {
    const node = await openFixture('node', { scenario });
    const trusted = await openFixture('trusted-test', { scenario });
    const nodeResult = await node.start();
    const trustedResult = await trusted.start();
    const shape = (fixture: ExecutorContractFixture, result: typeof nodeResult) => ({
      outcomes: outcomeOf(result).map((item) => ({
        status: item.status,
        reason: item.reason,
        hasOutput: item.outputArtifactId !== null,
        testCount: item.testCount,
      })),
      // 验收结论一致（evidenceRefs 等随夹具随机身份变化，不属于协议语义）。
      aggregate: (({ status, category, machinePassed }) => ({ status, category, machinePassed }))(
        fixture.aggregate(result),
      ),
    });
    expect(shape(trusted, trustedResult)).toEqual(shape(node, nodeResult));
  });

  it('受信测试执行器允许非 Node 风格目标标识；共享协议不解析 Node 路径或 npm', async () => {
    const fixture = await openFixture('trusted-test', { scenario: 'pass' });
    const opaqueTargets = ['suite:alpha', 'pytest:tests/test_alpha.py::test_ok'];
    // 执行器目录允许（已声明 opaque-identifier 能力）。
    expect(selectCheckExecutor('shiploop.trusted-test-executor', opaqueTargets).executorId)
      .toBe('shiploop.trusted-test-executor');
    // 共享结果协议对非 Node 标识原样接受，不做路径/npm 归一化。
    const report = scenarioReportPayload('pass', opaqueTargets);
    const validated = validateNodeCheckReport(report, opaqueTargets);
    expect(validated.targets).toEqual(opaqueTargets);
    // 测试执行器按同一契约运行该目标集合：覆盖通过，目标标识原样保留。
    const result = await fixture.executor.start(fixture.input({ targets: opaqueTargets }));
    for (const item of outcomeOf(result)) {
      expect(item.status).toBe('passed');
      expect(item.testCount ?? 0).toBeGreaterThanOrEqual(1);
      expect(item.outputArtifactId).toBeTruthy();
    }
    expect(fixture.aggregate(result).machinePassed).toBe(true);
    // 同一协议校验器也拒绝未覆盖该目标集合的报告（能力与覆盖是同一契约面）。
    expect(() => validateNodeCheckReport(scenarioReportPayload('pass', ['suite:alpha']), opaqueTargets))
      .toThrow(/target_coverage/);
  });
});
