import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { requiredP03TestBindings, evaluateP03TestEvidence } from '../../../scripts/acceptance/p03-test-evidence.ts';
import { P03_REQUIRED_CHECK_IDS } from '../../../scripts/acceptance/p03-config.ts';
import { scanTextForCredentialShapes } from '../../../scripts/acceptance/p03-report.ts';

const root = process.cwd();
function report() {
  const files = new Map<string, Set<string>>();
  for (const binding of requiredP03TestBindings(root)) {
    const names = files.get(binding.file) ?? new Set<string>();
    for (const id of binding.cases) names.add(`[case:${id}] real assertion`);
    if (binding.cases.length === 0) names.add('real state assertion');
    files.set(binding.file, names);
  }
  return { success: true, testResults: [...files].map(([file, names]) => ({
    name: resolve(root, file), assertionResults: [...names].map(fullName => ({ fullName, status: 'passed' })),
  })) };
}

describe('P03 phase results require actual indexed assertions', () => {
  it('[case:literal-final-retry-id] matches the real final retry case name, not a name invented from the index', () => {
    const input = report();
    const file = input.testResults.find(file => file.name.endsWith('/p03-10-f013-finalization-retry.test.ts'))!;
    file.assertionResults = [{ fullName: '[case:f013-three-task-finalization-retry] actual finalization retry', status: 'passed' }];
    expect(evaluateP03TestEvidence(root, input).find(check => check.checkId === 'P03-VERT-RETRY-FINAL')!.passed).toBe(true);
  });
  it('[case:redacted-whitespace] recognizes redacted values without whitespace backtracking bypasses', () => {
    for (const space of ['', ' ', '  ', '\n  ']) {
      expect(scanTextForCredentialShapes(`{"token":${space}"[REDACTED:fixture]"}`)).toEqual([]);
      expect(scanTextForCredentialShapes(`{"token":${space}"unredacted-value"}`).length).toBeGreaterThan(0);
    }
  });
  it('[case:exact-mapping] maps all required checks to executed nonempty assertions', () => {
    const result = evaluateP03TestEvidence(root, report());
    expect(result.map(item => item.checkId)).toEqual([...P03_REQUIRED_CHECK_IDS]);
    expect(result.every(item => item.passed && item.bindings.length > 0)).toBe(true);
  });
  it('[case:no-report-no-pass] exit zero or success=true without tests cannot pass any check', () => {
    expect(evaluateP03TestEvidence(root, { success: true, testResults: [] }).every(item => !item.passed)).toBe(true);
    expect(evaluateP03TestEvidence(root, null).every(item => !item.passed)).toBe(true);
  });
  it('[case:skipped-not-pass] missing, skipped and failed required cases cannot be counted as passed', () => {
    for (const status of ['failed', 'pending', 'skipped', 'todo']) {
      const input = report();
      input.testResults[0]!.assertionResults[0]!.status = status;
      expect(evaluateP03TestEvidence(root, input).some(item => !item.passed)).toBe(true);
    }
    const input = report();
    input.testResults.shift();
    expect(evaluateP03TestEvidence(root, input).some(item => !item.passed)).toBe(true);
  });
  it('[case:duplicates-rejected] duplicate file/case evidence is not accepted', () => {
    const input = report();
    input.testResults.push(input.testResults[0]!);
    expect(evaluateP03TestEvidence(root, input).some(item => !item.passed)).toBe(true);
  });
  it('[case:outside-rejected] similarly named files outside the tested repository do not satisfy a binding', () => {
    const input = report();
    input.testResults[0]!.name = '/outside/' + input.testResults[0]!.name.split('/').pop();
    expect(evaluateP03TestEvidence(root, input).some(item => !item.passed)).toBe(true);
  });
});
