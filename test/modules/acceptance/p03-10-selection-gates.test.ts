import { readFileSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import {
  createSelectionFixture,
  runFinalGate,
  runNonNodeContract,
  runAuthorizedSelection,
  type SelectionCandidate,
} from '../../helpers/p03-10/verification-selection-fixture.ts';

const fixtures: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function candidate(overrides: Partial<SelectionCandidate> = {}): SelectionCandidate {
  return {
    targetId: 'p03-task-local',
    definitionRevision: 'selection-v1',
    files: ['modules/core.test.mjs', 'modules/host.test.mjs'],
    selectionReason: 'F-011 local multi-module acceptance target',
    ...overrides,
  };
}

test('[case:authorized-multimodule-evidence] 合法当前 Attempt 只能执行授权多模块目标并记录完整证据', () => {
  const fixture = createSelectionFixture('shiploop-f011-authorized-');
  fixtures.push(fixture);

  const result = runAuthorizedSelection(fixture, candidate());

  expect(result).toMatchObject({ status: 'passed', mode: 'local', exitCode: 0 });
  expect(result.selectionReason).toContain('F-011');
  expect(result.cwd).toBe(fixture.root);
  expect(result.timeoutMs).toBe(5_000);
  expect(result.argv[0]).toBe(process.execPath);
  expect(result.argv).toContain('modules/core.test.mjs');
  expect(result.argv).toContain('modules/host.test.mjs');
  expect(result.resultArtifact).toBeTruthy();
  const evidence = JSON.parse(readFileSync(result.resultArtifact!, 'utf8')) as Record<string, unknown>;
  expect(evidence).toMatchObject({
    targetId: 'p03-task-local',
    executedModules: ['core', 'host'],
    exitCode: 0,
  });
  expect(result.shell).toBe(false);
});

test('[case:unsafe-candidate-fallback] 缺失/过期/越界/符号链接/参数注入/漏选与共享配置变化均安全回退', () => {
  const cases: Array<{ name: string; overrides: Partial<SelectionCandidate>; expected: string }> = [
    { name: 'missing target', overrides: { targetId: 'missing-target' }, expected: 'unknown_target' },
    { name: 'stale definition', overrides: { definitionRevision: 'old-revision' }, expected: 'stale_definition' },
    { name: 'missing file', overrides: { files: ['modules/core.test.mjs', 'modules/missing.test.mjs'] }, expected: 'file_missing' },
    { name: 'out of bounds', overrides: { files: ['../outside.test.mjs', 'modules/host.test.mjs'] }, expected: 'path_out_of_bounds' },
    { name: 'symlink', overrides: { files: ['modules/linked.test.mjs', 'modules/host.test.mjs'] }, expected: 'symlink' },
    { name: 'argument injection', overrides: { files: ['modules/core.test.mjs', '--require=./evil.mjs'] }, expected: 'argument_injection' },
    { name: 'multi-module omission', overrides: { files: ['modules/core.test.mjs'] }, expected: 'required_module_missing' },
  ];

  for (const item of cases) {
    const fixture = createSelectionFixture(`shiploop-f011-${item.name.replaceAll(' ', '-')}-`);
    fixtures.push(fixture);
    const result = runAuthorizedSelection(fixture, candidate(item.overrides));
    expect(result.status, item.name).toBe('passed');
    expect(result.mode, item.name).toBe('full');
    expect(result.fallbackReason, item.name).toContain(item.expected);
    expect(result.executedModules, item.name).toEqual(['core', 'host']);
  }

  const changed = createSelectionFixture('shiploop-f011-shared-config-');
  fixtures.push(changed);
  const changedResult = runAuthorizedSelection(changed, candidate({ sharedConfigDigest: 'wrong-digest' }));
  expect(changedResult).toMatchObject({ status: 'passed', mode: 'full' });
  expect(changedResult.fallbackReason).toContain('shared_config_changed');
});

test('[case:no-trusted-fallback] 无可信回退时以 error/inconclusive 结束，不执行猜测目标', () => {
  const fixture = createSelectionFixture('shiploop-f011-no-fallback-');
  fixtures.push(fixture);

  const result = runAuthorizedSelection(fixture, {
    ...candidate({ files: [] }),
    fallback: 'none',
  });

  expect(result.status).toBe('inconclusive');
  expect(result.reason).toBe('zero_tests');
  expect(result.exitCode).toBeNull();
  expect(result.resultArtifact).toBeNull();
});

test('[case:negative-evidence-gates] 零测试、零退出但缺证据、部分模块和原有门禁失败都不可 passed', () => {
  const zero = createSelectionFixture('shiploop-f011-zero-tests-');
  fixtures.push(zero);
  const zeroResult = runAuthorizedSelection(zero, candidate({ files: [], fallback: 'none' }));
  expect(zeroResult).toMatchObject({ status: 'inconclusive', reason: 'zero_tests' });

  const missingEvidence = createSelectionFixture('shiploop-f011-missing-evidence-', { omitResultArtifact: true });
  fixtures.push(missingEvidence);
  const missingEvidenceResult = runAuthorizedSelection(missingEvidence, candidate());
  expect(missingEvidenceResult).toMatchObject({ status: 'inconclusive', reason: 'missing_execution_evidence' });

  const partial = createSelectionFixture('shiploop-f011-partial-', { modulesToExecute: ['core'] });
  fixtures.push(partial);
  const partialResult = runAuthorizedSelection(partial, candidate());
  expect(partialResult).toMatchObject({ status: 'inconclusive', reason: 'required_module_missing' });

  const gate = createSelectionFixture('shiploop-f011-gate-');
  fixtures.push(gate);
  const local = runAuthorizedSelection(gate, candidate());
  expect(local.status).toBe('passed');
  const failedGate = runFinalGate(gate, { failStep: 'typecheck' });
  expect(failedGate.status).toBe('failed');
  expect(failedGate.steps).toEqual([
    expect.objectContaining({ name: 'test', status: 'passed', exitCode: 0 }),
    expect.objectContaining({ name: 'typecheck', status: 'failed', exitCode: expect.any(Number) }),
    expect.objectContaining({ name: 'build', status: 'not_run' }),
    expect.objectContaining({ name: 'integration', status: 'not_run' }),
  ]);
  expect(failedGate.passed).toBe(false);

  const baseline = createSelectionFixture('shiploop-f011-baseline-', { baselineFailure: true });
  fixtures.push(baseline);
  const baselineGate = runFinalGate(baseline);
  expect(baselineGate).toMatchObject({ status: 'failed', passed: false });
  expect(baselineGate.steps[0]).toMatchObject({ name: 'test', status: 'failed' });
});

test('[case:gate-definition-integrity] 全量测试/类型/构建/集成门禁定义不可通过篡改降低', () => {
  const fixture = createSelectionFixture('shiploop-f011-gate-integrity-');
  fixtures.push(fixture);

  const tampered = runFinalGate(fixture, { definition: ['test', 'build', 'integration'] });
  expect(tampered).toMatchObject({ status: 'error', reason: 'gate_definition_tampered', passed: false });
  expect(tampered.steps).toEqual([]);

  const passed = runFinalGate(fixture);
  expect(passed.status).toBe('passed');
  expect(passed.passed).toBe(true);
  expect(passed.steps.map((step) => step.name)).toEqual(['test', 'typecheck', 'build', 'integration']);
  expect(passed.steps.every((step) => step.status === 'passed' && step.exitCode === 0)).toBe(true);
  expect(passed.resultArtifact).toBeTruthy();
});

test('[case:non-node-protocol] 受信 Python 目标复用同一解析/执行器协议，不引入多语言 Profile', () => {
  const fixture = createSelectionFixture('shiploop-f011-python-');
  fixtures.push(fixture);

  const result = runNonNodeContract(fixture);

  expect(result).toMatchObject({ status: 'passed', language: 'python', exitCode: 0 });
  expect(result.protocol).toEqual({
    targetId: 'p03-non-node-contract',
    argvIsArray: true,
    cwdIsAbsolute: true,
    timeoutIsFinite: true,
    evidenceRequired: true,
  });
  expect(result.profileCount).toBe(1);
});
