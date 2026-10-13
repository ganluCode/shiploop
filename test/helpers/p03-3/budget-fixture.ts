import type { ExecutionBudgetProposal } from '../../../packages/core/src/ports/execution-budget.ts';
import { randomUUID } from 'node:crypto';
import { createCommandService } from '../../../packages/core/src/application/command-service.ts';
import { createExecutionPreviewService } from '../../../packages/core/src/application/execution-preview.ts';
import { createExecutionStartService } from '../../../packages/core/src/application/execution-start.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqlitePlanAccess } from '../../../packages/core/src/adapters/sqlite/plan-store.ts';
import { openSqliteStorageSession, type SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createBaselineWorkspaceReader } from '../../../packages/core/src/adapters/fs/baseline-workspace.ts';
import { createRepositoryInspector } from '../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { TRUSTED_PROJECT_PERMISSIONS_READER } from '../../../packages/core/src/ports/execution-input-prepare.ts';
import { createCommandsTestFixture } from '../p02-2/index.ts';

export const NOW = 1_900_000_100_000;
export const BUDGET = {
  batch: {
    maxRuns: 2, maxTotalAttempts: 2, maxRuntimeStarts: 2, maxNoProgressRuns: 2,
    deadlineUtcMs: NOW + 3_600_000, maxTokenTotal: 1000, maxCostTotal: 10,
  },
  run: { maxAttemptsPerRun: 2, runTimeLimitMs: 3_600_000 },
};

export function budgetServices(session: SqliteStorageSession) {
  const nowUtcMs = () => NOW;
  const atomic = createSqliteAtomicCommandStore(session, { nowUtcMs });
  const inspector = createRepositoryInspector();
  const preview = createExecutionPreviewService({
    views: createSqlitePlanAccess(session, { nowUtcMs }), inspector,
    workspace: createBaselineWorkspaceReader(), permissions: TRUSTED_PROJECT_PERMISSIONS_READER,
    nowMs: nowUtcMs,
  });
  const signals: unknown[] = [];
  const commands = createCommandService({
    atomicStore: atomic, repositoryInspector: inspector,
    capabilityCatalog: createStaticRuntimeCapabilityCatalog([
      { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet', 'claude-sonnet-2'] }] },
    ]),
    executionPreview: preview,
    executionStart: createExecutionStartService({ preview, permissions: TRUSTED_PROJECT_PERMISSIONS_READER, nowMs: nowUtcMs }),
    executionDispatchSignal: { signalRunDispatched: input => { signals.push(input); } },
    nowUtcMs,
  });
  return { atomic, commands, preview, signals };
}

export async function openBudgetFixture(budget: ExecutionBudgetProposal = BUDGET, tasks = [{ id: 't-1', title: 'Task', acceptance: { criteria: ['budget consistency'] }, dependsOn: [] as string[] }]) {
  const box = createCommandsTestFixture({ prefix: 'shiploop-f013-budget-' });
  try {
    const harness = await box.openTransactionalHarness();
    let session = harness.session;
    let services = budgetServices(session);
    const owner = createLocalOwnerPrincipal();
    const envelope = (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
      schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(NOW).toISOString(),
      operation, payload, ...extra,
    });
    const submit = (operation: string, payload: unknown, extra: Record<string, unknown> = {}) =>
      services.commands.submit(owner, envelope(operation, payload, extra));
    const requireCompleted = async (promise: ReturnType<typeof submit>) => {
      const receipt = await promise;
      if (receipt.status !== 'completed') throw new Error(`fixture command failed: ${JSON.stringify(receipt)}`);
      return receipt.result;
    };
    const registered = await requireCompleted(submit('project.register', {
      repositoryPath: box.repoDirA, displayName: 'Budget race', description: null, labels: [],
    }, { scope: { kind: 'registration' } }));
    const projectId = (registered as { project: { id: string } }).project.id;
    const scope = { kind: 'project', projectId };
    await requireCompleted(submit('settings.global.create', {
      schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
    }, { scope: { kind: 'global' } }));
    await requireCompleted(submit('phase.create', { id: 'phase-1', title: 'Budget', description: null, labels: [] }, { scope }));
    const imported = await requireCompleted(submit('feature.plan.import', {
      phaseId: 'phase-1', plan: {
        schemaVersion: 1, feature: { title: 'Budget race', description: null, labels: [], sourceRefs: [] },
        tasks,
      },
    }, { scope, expectedRevision: 1 }));
    const featureId = (imported as { feature: { id: string } }).feature.id;
    const feature = session.database.prepare('SELECT plan_digest, revision FROM features WHERE id = ?').get(featureId) as { plan_digest: string; revision: number };
    await requireCompleted(submit('feature.plan.decide', {
      featureId, planDigest: feature.plan_digest, decision: 'approve', reason: 'test authorization',
    }, { scope, expectedRevision: feature.revision }));
    const preview = await services.preview.previewExecution(projectId, { featureIds: [featureId], budget: { ...budget } });
    if (preview.status !== 'ready') throw new Error(`fixture not ready: ${JSON.stringify(preview)}`);
    const startEnvelope = () => envelope('execution.start', { featureIds: [featureId], budget, previewDigest: preview.previewDigest }, { scope });
    const retryEnvelope = (batchId: string) => envelope('execution.start', { featureIds: [featureId], retryBatchId: batchId }, { scope });
    const revisionEnvelope = (batchId: string) => envelope('execution.budget.revise', {
      batchId, budget: { ...budget, batch: { ...budget.batch, maxRuns: budget.batch.maxRuns + 1, maxTotalAttempts: budget.batch.maxTotalAttempts + 1, maxRuntimeStarts: budget.batch.maxRuntimeStarts + 1 } }, reason: 'explicit increase',
    }, { scope, expectedRevision: 1 });
    const snapshot = () => Object.fromEntries([
      'execution_batches', 'runs', 'batch_budget_revisions', 'task_attempt_reservations',
      'runtime_start_reservations', 'run_outcome_settlements', 'tasks', 'command_receipts', 'state_events',
    ].map(table => [table, session.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
    return {
      box, projectId, featureId, owner, scope, budget, envelope, startEnvelope, retryEnvelope, revisionEnvelope, snapshot,
      get session() { return session; }, get services() { return services; },
      submit,
      async start() {
        const receipt = await services.commands.submit(owner, startEnvelope());
        if (receipt.status !== 'accepted' || !('runId' in receipt)) throw new Error(`fixture start failed: ${JSON.stringify(receipt)}`);
        return { projectId, batchId: receipt.batchId, runId: receipt.runId, taskId: 't-1' };
      },
      reopen() {
        session.close();
        session = openSqliteStorageSession({ path: box.dbPath });
        services = budgetServices(session);
      },
      close() { session.close(); box.cleanup(); },
    };
  } catch (error) { box.cleanup(); throw error; }
}

export type BudgetFixture = Awaited<ReturnType<typeof openBudgetFixture>>;
