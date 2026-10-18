import { expect, test } from 'vitest';
import { createWorkScheduler } from '../../../packages/core/src/application/work-scheduler.ts';
import { createSqliteSchedulerStore } from '../../../packages/core/src/adapters/sqlite/scheduler-store.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createTaskDagService } from '../../../packages/core/src/application/task-dag.ts';
import { openClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';

test('[case:verification-pause-preserved] 补偿扫描保留验证暂停原因及 revision', async () => {
  const f = await openClaimFixture();
  f.box.session.transactWrite('fixture.verification-pause', () => {
    f.box.session.database.prepare("UPDATE runs SET status = 'paused', reason = 'verification_not_assembled'").run();
  });
  const read = () => f.box.session.database.prepare('SELECT status, reason, revision FROM runs').get();
  const before = read();
  const scheduler = createWorkScheduler({
    store: createSqliteSchedulerStore(f.box.session, { nowUtcMs: () => NOW }),
    dag: createTaskDagService({ store: createSqliteTaskDagStore(f.box.session), nowMs: () => NOW }),
  });
  try {
    for (let i = 0; i < 2; i++) {
      expect((await scheduler.scan()).runs[0]).toMatchObject({ reason: 'run_control_blocked', claimed: false });
      expect(read()).toEqual(before);
      expect(f.box.session.database.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
    }
  } finally { await scheduler.close(); f.box.close(); }
});
