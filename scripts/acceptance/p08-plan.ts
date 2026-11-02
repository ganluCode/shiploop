/** P08-4 / F-003 确定性阶段步骤计划。 */

const TEST_FILE_PATTERN = /^test\/modules\/(?:[\w.-]+\/)*[\w.-]+\.test\.(?:ts|js)$/;
export const P08_SCOPE_BATCH_SIZE = 16;
export const P08_SCENE_CHECKS: Readonly<Record<string, string>> = Object.freeze({
  'test/modules/acceptance/p08-2-f003-todo-delivery-check.test.ts': 'P08-TODO-DETERMINISTIC-CLOSURE',
  'test/modules/acceptance/p08-2-f007-todo-install-smoke.test.ts': 'P08-INSTALL-CLEAN-DIRECTORY',
  'test/modules/acceptance/p08-2-f008-existing-demo.test.ts': 'P08-EXISTING-INCREMENTAL-CLOSURE',
  'test/modules/acceptance/p08-3-f003-existing-demo-incremental.test.ts': 'P08-EXISTING-INCREMENTAL-CLOSURE',
  'test/modules/acceptance/p08-3-f004-existing-demo-lifecycle.test.ts': 'P08-EXISTING-LIFECYCLE',
  'test/modules/acceptance/p08-4-f002-identity-validation.test.ts': 'P08-RUN-IDENTITY-INTEGRITY',
});
export const P08_PHYSICAL_STEPS = [
  'p08-prerequisites', 'p08-source-identity', 'p08-deterministic-scope',
  'p08-installation', 'p08-phase-integration', 'p08-live-import', 'p08-report', 'p08-manual-gate',
] as const;
export const P08_ENTRY_STEP_ORDER = P08_PHYSICAL_STEPS;
export type P08PhysicalStep = (typeof P08_PHYSICAL_STEPS)[number];
export type P08PlannedStep = {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly tests: readonly string[];
  readonly kind: 'preflight' | 'tests' | 'evidence-import' | 'report' | 'manual';
};
export type P08StepStatus = 'pass' | 'fail' | 'not_run';
export type P08StepOutcome = { readonly status: P08StepStatus; readonly exitCode: number | null; readonly reason?: string };
export type P08PlannedStepResult = P08PlannedStep & { readonly status: P08StepStatus; readonly exitCode: number | null; readonly reason: string | null };

function fail(code: string, detail?: string): never { throw new Error(detail ? `accept:p08:${code}:${detail}` : `accept:p08:${code}`); }
function validateFiles(files: readonly string[]): string[] {
  const sorted = [...files].sort();
  if (sorted.length === 0 || new Set(sorted).size !== sorted.length) fail('empty_or_duplicate_scope');
  if (sorted.some(file => !TEST_FILE_PATTERN.test(file))) fail('invalid_scope_file', sorted.find(file => !TEST_FILE_PATTERN.test(file)));
  if (sorted.some(file => file.includes('scripts/acceptance/p08-accept.ts'))) fail('recursive_entry');
  return sorted;
}
function internalStep(id: Exclude<P08PhysicalStep, 'p08-deterministic-scope'>, kind: P08PlannedStep['kind']): P08PlannedStep {
  return { id, command: 'internal', args: [id], tests: [], kind };
}

/** 以稳定字典序把默认范围分批；每个文件恰好进入一个测试步骤。 */
export function buildP08ExecutionPlan(selected: readonly string[], full: boolean): P08PlannedStep[] {
  const files = validateFiles(selected);
  const deterministic: P08PlannedStep[] = [];
  if (full) {
    deterministic.push({ id: 'p08-deterministic-scope', command: 'npm', args: ['test'], tests: files, kind: 'tests' });
  } else {
    for (let start = 0; start < files.length; start += P08_SCOPE_BATCH_SIZE) {
      const tests = files.slice(start, start + P08_SCOPE_BATCH_SIZE);
      deterministic.push({ id: start === 0 ? 'p08-deterministic-scope' : `p08-deterministic-scope-batch-${start / P08_SCOPE_BATCH_SIZE + 1}`,
        command: process.execPath, args: ['scripts/run-tests.ts', ...tests], tests, kind: 'tests' });
    }
  }
  return [
    internalStep('p08-prerequisites', 'preflight'),
    internalStep('p08-source-identity', 'preflight'),
    ...deterministic,
    internalStep('p08-installation', 'evidence-import'),
    internalStep('p08-phase-integration', 'evidence-import'),
    internalStep('p08-live-import', 'evidence-import'),
    internalStep('p08-report', 'report'),
    internalStep('p08-manual-gate', 'manual'),
  ];
}

/** 把步骤结果按固定顺序传播；失败后所有后继只能是 not_run。 */
export function propagateP08StepStatuses(plan: readonly P08PlannedStep[], outcomes: Readonly<Record<string, P08StepOutcome>>): P08PlannedStepResult[] {
  const result: P08PlannedStepResult[] = [];
  let halted = false;
  for (const step of plan) {
    const supplied = outcomes[step.id];
    if (halted) {
      result.push({ ...step, status: 'not_run', exitCode: null, reason: 'halted_by_prior_failure' });
      continue;
    }
    if (!supplied) {
      result.push({ ...step, status: 'not_run', exitCode: null, reason: 'not_run' });
      halted = true;
      continue;
    }
    const status = supplied.status;
    result.push({ ...step, status, exitCode: supplied.exitCode, reason: supplied.reason ?? null });
    if (status !== 'pass') halted = true;
  }
  return result;
}
