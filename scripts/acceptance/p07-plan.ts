/** Physical execution plan and scene bindings, shared by entry and its test-only evidence setup. */
export const P07_SCENE_CHECKS: Readonly<Record<string, string>> = {
  'test/modules/acceptance/p07-5-f003-verifier-crash.test.ts': 'P07-T06-VERIFIER-CRASH-RECOVERY',
  'test/modules/delivery/p07-5-f004-git-recovery-boundary.test.ts': 'P07-T08-COMMIT-RECEIPT-RECOVERY',
  'test/modules/acceptance/p07-5-f005-recording-faults.test.ts': 'P07-T11-RECORDER-BACKPRESSURE',
  'test/modules/acceptance/p07-5-f005-recording-recovery.test.ts': 'P07-T11-RECORDER-BACKPRESSURE',
  'test/modules/runtime/recovery/p07-5-f006-native-archive-boundary.test.ts': 'P07-T11-NATIVE-ARCHIVE-SINGLE-WRITER',
  'test/modules/runtime/recovery/p07-5-f006-native-single-writer.test.ts': 'P07-T11-NATIVE-ARCHIVE-SINGLE-WRITER',
  'test/modules/acceptance/p07-5-f006-dual-storage-drift.test.ts': 'P07-T11-NATIVE-ARCHIVE-SINGLE-WRITER',
  'test/modules/lifecycle/p07-5-f007-backup-recovery.test.ts': 'P07-T16-BACKUP-RESTORE-CONSISTENCY',
  'test/modules/lifecycle/p07-5-f008-data-boundary.test.ts': 'P07-T15-ARCHIVE-DELETE-RETENTION',
  'test/modules/acceptance/p07-5-f009-result-query-independence.test.ts': 'P07-T12-NOTIFICATION-INDEPENDENT-RETRY',
  'test/modules/acceptance/p07-5-f009-notification-fault-restart.test.ts': 'P07-T12-NOTIFICATION-INDEPENDENT-RETRY',
  'test/modules/acceptance/p07-5-f010-report.test.ts': 'P07-RERUN-EVIDENCE-INTEGRITY',
};
export const P07_PHYSICAL_STEPS = ['p07-prerequisites', 'p07-trusted-scope', 'p07-recovery-scenarios', 'p07-boundaries', 'p07-engineering'] as const;
export type P07PlannedStep = { id: string; command: string; args: string[]; tests: string[] };
export function buildP07ExecutionPlan(selected: readonly string[], full: boolean): P07PlannedStep[] {
  if (!selected.length || new Set(selected).size !== selected.length) throw new Error('accept:p07:empty_or_duplicate_scope');
  const scenes = selected.filter(file => P07_SCENE_CHECKS[file]);
  const normal = selected.filter(file => !P07_SCENE_CHECKS[file]);
  return [
    { id: 'p07-prerequisites', command: process.execPath, args: ['scripts/build-host-lock.ts'], tests: [] },
    { id: 'p07-trusted-scope', command: full ? 'npm' : process.execPath, args: full ? ['test', '--'] : ['scripts/run-tests.ts', ...normal], tests: full ? [...selected] : normal },
    ...(!full && scenes.length ? [{ id: 'p07-recovery-scenarios', command: process.execPath, args: ['scripts/run-tests.ts', ...scenes], tests: scenes }] : []),
    { id: 'p07-boundaries', command: 'npm', args: ['run', 'check:boundaries'], tests: [] },
    { id: 'p07-engineering', command: process.execPath, args: ['scripts/verify.ts', '--checks-only'], tests: [] },
  ];
}
