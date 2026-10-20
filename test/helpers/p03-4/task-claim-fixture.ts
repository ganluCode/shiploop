import { createWorkWorkspaceAuthority } from '../../../packages/core/src/adapters/fs/work-workspace.ts';
import { createSqliteStateAccess } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { createSqliteTaskClaimStore } from '../../../packages/core/src/adapters/sqlite/task-claim-store.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createTaskDagService } from '../../../packages/core/src/application/task-dag.ts';
import { BUDGET, NOW, openBudgetFixture } from '../p03-3/budget-fixture.ts';
import { publishPreparedInputFixture } from './task-dag-state-fixture.ts';
import type { BudgetFixture } from '../p03-3/budget-fixture.ts';
import type { TaskClaimStore, TaskClaimInput } from '../../../packages/core/src/ports/task-claim.ts';
import type { TaskDagResult } from '../../../packages/core/src/ports/task-dag.ts';
import type { WorkWorkspaceAuthority, VerifiedWorkWorkspace } from '../../../packages/core/src/ports/work-resources.ts';

export interface ClaimFixture {
  box: BudgetFixture;
  ids: { projectId: string; batchId: string; runId: string; taskId: string };
  authority: WorkWorkspaceAuthority;
  workspace: VerifiedWorkWorkspace;
  store(): TaskClaimStore;
  input(index?: number): TaskClaimInput;
  snapshot(): Record<string, unknown[]>;
  evaluate(): TaskDagResult;
}

export async function openClaimFixture(edges: string[][] = [[]]): Promise<ClaimFixture> {
  const { maxTokenTotal: _tokens, maxCostTotal: _cost, ...batch } = BUDGET.batch;
  const box = await openBudgetFixture({ ...BUDGET, batch }, edges.map((dependsOn, i) => ({
    id: `t-${i + 1}`, title: `Task ${i + 1}`, acceptance: { criteria: ['atomic claim'] }, dependsOn,
  })));
  const ids = await box.start();
  const snapshots = edges.map((_, i) => publishPreparedInputFixture(box, ids, `t-${i + 1}`));
  const authority = createWorkWorkspaceAuthority({ authorizedRoots: [box.box.root] });
  const binding = createSqliteStateAccess(box.session).getRepositoryBinding(box.projectId);
  const workspace = await authority.verify(binding, box.box.repoDirA);
  const store = () => createSqliteTaskClaimStore(box.session, { workspaceAuthority: authority, nowUtcMs: () => NOW });
  const input = (index = 0) => ({ claimKey: `claim-${index + 1}`, projectId: box.projectId, runId: ids.runId,
    taskId: `t-${index + 1}`, owner: 'owner-1', hostInstanceId: 'host-1', expectedRevision: 1, executionVersion: 0,
    workspace, leaseUntilUtcMs: NOW + 1000, inputSnapshot: snapshots[index]! });
  const snapshot = () => Object.fromEntries(['tasks', 'attempts', 'execution_batches', 'runs', 'task_attempt_reservations',
    'runtime_start_reservations', 'workspace_leases', 'state_events', 'task_claim_receipts']
    .map(table => [table, box.session.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  const evaluate = () => createTaskDagService({ store: createSqliteTaskDagStore(box.session), nowMs: () => NOW })
    .evaluate(box.projectId, ids.runId);
  return { box, ids, authority, workspace, store, input, snapshot, evaluate };
}
