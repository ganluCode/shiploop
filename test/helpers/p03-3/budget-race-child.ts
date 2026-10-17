import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { mapToPublicError } from '../../../packages/core/src/ports/commands.ts';
import { readChildConfig, runBarrierChild } from '../host/child-runtime.ts';
import { budgetServices } from './budget-fixture.ts';

const config = readChildConfig();
const session = openSqliteStorageSession({ path: String(config.dbPath), busyTimeoutMs: 250, busyRetryAttempts: 4 });
const services = budgetServices(session);
void runBarrierChild({
  scenario: {
    name: 'budget-race',
    onGo: async () => {
      try {
        try {
          const mode = config.mode;
          let result: Record<string, unknown>;
          if (mode === 'command') {
            const receipt = await services.commands.submit(
              createLocalOwnerPrincipal(),
              config.envelope as Parameters<typeof services.commands.submit>[1],
            );
            result = { receipt };
          } else {
            const record = services.atomic.transact('test.budgetRace', tx => {
              if (mode === 'attempt') return tx.reserveTaskAttempt(config.input);
              if (mode === 'runtime') return tx.reserveRuntimeStart(config.input);
              if (mode === 'attempt-budget-settlement') return tx.settleTaskAttemptBudget(config.input);
              if (mode === 'settlement') return tx.settleExecutionRunOutcome(config.input);
              throw new Error(`Unsupported race mode: ${String(mode)}`);
            });
            result = { record };
          }
          process.send?.({ kind: 'race-result', ...result, signals: services.signals.length });
        } catch (error) {
          process.send?.({
            kind: 'race-result',
            error: mapToPublicError(error, { operation: config.mode === 'command' ? String((config.envelope as { operation: string }).operation) : 'test.budgetRace' }).toErrorShape(),
            signals: services.signals.length,
          });
        }
      } finally { session.close(); }
    },
  },
  goTimeoutMs: 10_000,
  watchdogMs: 30_000,
});
