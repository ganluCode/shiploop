/** Offline assertion bindings. These are not live, cleanup or owner approval evidence. */
import { resolve } from 'node:path';

const file = (module: string) => `test/modules/${module}.test.ts`;
const access = file('runtime/p04-8-access-fault-matrix');
const control = file('execution/control/p04-8-control-fault-matrix');
const recovery = file('runtime/p04-8-recovery-recording-fault-matrix');
const steps = file('acceptance/p04-8-step-runner');
const entry = file('acceptance/p04-8-phase-entry');
const dispatch = file('execution/dispatch/p04-9-f010-dispatch-vertical');
const slot = file('scheduling/p04-9-f003-execution-slot');
const crash = file('recovery/p04-9-f007-dispatch-crash-windows');
export const P04_OFFLINE_TEST_BINDINGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'P04-FR1-FAILURE-MATRIX': [access, control, recovery],
  'P04-FR2-BOUNDED-ENTRY': [steps, entry],
  'P04-T35': [file('verification/p03-7-f003-candidate-validation'), file('verification/p03-7-f004-verification-plan'), steps],
  'P04-T36': [steps, control],
  'P04-T37': [steps, entry],
  'P04-T40': [recovery, file('runtime/p04-4-pi-managed-session'), file('runtime/recovery/p04-4-recovery-recording')],
  'P04-T41': [access, file('acceptance/p04-8-live')],
  'P04-T42': [file('runtime/p04-6-efficiency-projection'), file('cli/p04-6-feature-report-diagnostics')],
  'P04-VERT-OFFLINE-FAIL-CLOSED': [steps, entry, control],
  'P04-P9-AC1-SINGLE-DISPATCH': [dispatch, file('execution/dispatch/p04-9-f002-dispatch-enqueue')],
  'P04-P9-AC2-SLOT-RACE': [slot, dispatch],
  'P04-P9-AC3-RESTART-RESCAN': [crash, dispatch, file('recovery/p04-9-f007-dispatch-startup')],
  'P04-P9-AC4-LATE-RESULT-CONTROL': [crash, file('scheduling/p04-9-f006-dispatch-control-settlement')],
  'P04-P9-AC5-QUOTA-REGRESSION': [slot, dispatch, file('recovery/p04-9-f007-dispatch-resume')],
  'P04-P9-AC6-QUERY-MIGRATION': [file('execution/dispatch/p04-9-f010-upgrade-query'), file('scheduling/p04-9-f008-dispatch-slot-query')],
});
export interface P04TestProof {
  readonly checkId: string;
  readonly passed: boolean;
  readonly bindings: readonly { readonly file: string; readonly assertions: readonly string[]; readonly passed: boolean }[];
}
export function evaluateP04TestEvidence(root: string, raw: unknown): P04TestProof[] {
  const report = raw as { success?: unknown; testResults?: unknown } | null;
  const files = Array.isArray(report?.testResults) ? report.testResults as { name?: unknown; assertionResults?: unknown }[] : [];
  return Object.entries(P04_OFFLINE_TEST_BINDINGS).map(([checkId, names]) => {
    const bindings = names.map(file => {
      const matched = files.filter(f => typeof f?.name === 'string' && resolve(root, f.name) === resolve(root, file));
      const assertions = matched.length === 1 && Array.isArray(matched[0]!.assertionResults)
        ? matched[0]!.assertionResults as { fullName?: unknown; status?: unknown }[] : [];
      const passed = report?.success === true && matched.length === 1 && assertions.length > 0
        && assertions.every(a => typeof a?.fullName === 'string' && a.fullName.length > 0 && a.status === 'passed');
      return { file, assertions: assertions.flatMap(a => typeof a?.fullName === 'string' ? [a.fullName] : []), passed };
    });
    return { checkId, bindings, passed: bindings.length > 0 && bindings.every(b => b.passed) };
  });
}
