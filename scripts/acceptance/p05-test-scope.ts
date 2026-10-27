/** P05 impact boundary; deferred history remains visible and available to explicit full regression. */
export const P05_REQUIRED_REGRESSIONS = Object.freeze([
  'test/modules/authorization/authorization-contract.test.ts',
  'test/modules/commands/command-receipts-store.test.ts',
  'test/modules/commands/commands-contract.test.ts',
  'test/modules/delivery/p03-8-f004-git-commit-reconciliation.test.ts',
  'test/modules/host/p03-10-feature-report-contract.test.ts',
  'test/modules/execution/budget/p03-3-attempt-budget-reservation.test.ts',
  'test/modules/execution/budget/p03-3-execution-start.test.ts',
  'test/modules/execution/budget/p03-3-work-command-receipts.test.ts',
  'test/modules/recovery/p03-9-f005-startup-recovery.test.ts',
  'test/modules/recovery/p04-9-f007-dispatch-crash-windows.test.ts',
  'test/modules/scheduling/p03-4-work-resources.test.ts',
  'test/modules/scheduling/p04-9-f003-execution-slot.test.ts',
  'test/modules/scheduling/p04-9-f004-dispatch-task-claim.test.ts',
  'test/modules/scheduling/p04-9-f006-dispatch-control-settlement.test.ts',
  'test/modules/storage/sqlite/p04-9-dispatch-intent-schema.test.ts',
  'test/modules/storage/sqlite/p04-9-dispatch-slot-schema.test.ts',
  'test/modules/storage/sqlite/sqlite-cas-and-atomicity.test.ts',
  'test/modules/storage/sqlite/sqlite-migration-runner.test.ts',
  'test/modules/storage/sqlite/sqlite-schema-migrations.test.ts',
]);

export function selectP05TestScope(files: readonly string[], fullRegression = false) {
  const all = [...new Set(files)].sort();
  for (const file of P05_REQUIRED_REGRESSIONS) {
    if (!all.includes(file)) throw new Error(`P05 required regression missing from trusted union: ${file}`);
  }
  const required = new Set<string>(P05_REQUIRED_REGRESSIONS);
  const selected = all.filter(file => fullRegression || file.includes('p05-') || required.has(file));
  const selectedSet = new Set(selected);
  return {
    schemaVersion: 1,
    policy: fullRegression ? 'full-trusted-union' : 'p05-impact-and-required-regressions',
    selected,
    deferred: all.filter(file => !selectedSet.has(file)).map(file => ({
      file, status: 'not_run', reason: 'Historical regression outside reviewed P05 impact boundary; run in CI or with --full-regression.',
    })),
  };
}
