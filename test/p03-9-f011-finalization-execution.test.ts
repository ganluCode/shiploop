/**
 * P03-9 / F-011 finalization-only Run 确定性重验与 Feature 全量门禁。
 *
 * 真实临时 Git/SQLite/Artifact；不启动 Runtime、不调用模型。验证：
 * - 只执行 F-009 scope 列出的 Task 重验与最终检查；
 * - 重验批次与 Feature 全量批次真实落库，失败/缺证据/零测试不得完成；
 * - 检查期间源码变化使本次结果失效；
 * - 取消/暂停边界不覆盖控制状态；
 * - 认领边界与调度不创建编码 Attempt，且同一 handoff 不重复执行。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { createSqliteAttemptAccess } from '../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createCommandProcessAdapter } from '../packages/core/src/adapters/process/command-process.ts';
import { createSqliteSchedulerStore } from '../packages/core/src/adapters/sqlite/scheduler-store.ts';
import { createSqliteVerificationStore } from '../packages/core/src/adapters/sqlite/verification-store.ts';
import { createSqliteExecutionResumeFactsReader } from '../packages/core/src/adapters/sqlite/execution-resume.ts';
import { createSqliteTaskDagStore } from '../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createFinalizationExecutionService } from '../packages/core/src/application/finalization-execution.ts';
import { createNodeFinalizationVerifier } from '../packages/core/src/application/finalization-node-verifier.ts';
import { createVerificationStopControl } from '../packages/core/src/application/verification-stop-control.ts';
import { createWorkScheduler } from '../packages/core/src/application/work-scheduler.ts';
import {
  FINALIZATION_TASK_VERIFICATION_OPERATION,
  type FinalizationFeatureVerificationInput,
  type FinalizationTaskRevalidationInput,
  type FinalizationVerifier,
  type FinalizationVerificationEvidence,
  type FinalizationCheckEvidence,
} from '../packages/core/src/ports/finalization-execution.ts';
import { FEATURE_VERIFICATION_OPERATION } from '../packages/core/src/ports/feature-verification.ts';
import type { CheckDefinition } from '../packages/core/src/ports/task-verification-policy.ts';
import { BUDGET, NOW } from './helpers/p03-3/budget-fixture.ts';
import {
  changeSource,
  openFinalizationFixture,
  plannerFor,
  prepareEligibleFixture,
  retryCommandsFor,
  retryPayload,
  row,
  tableRows,
  type EligibleFinalizationFixture,
} from './helpers/p03-9/finalization-retry-fixture.ts';

interface Definition {
  readonly checkKey: string;
  readonly scope: 'task' | 'module' | 'project';
  readonly kind: 'command';
  readonly argv: readonly string[];
  readonly cwdRef: null;
  readonly environmentRef: null;
  readonly timeout: number;
  readonly required: boolean;
  readonly requirementRefs: readonly string[];
}

function definitions(taskCount: number): readonly Definition[] {
  const base = {
    scope: 'task' as const, kind: 'command' as const, cwdRef: null, environmentRef: null,
    timeout: 60_000, required: true, requirementRefs: [] as string[],
  };
  return taskCount === 2
    ? [{ ...base, checkKey: 'tests', argv: ['node', '--test', 'a'] },
       { ...base, checkKey: 'lint', argv: ['node', 'lint'] }]
    : [{ ...base, checkKey: 'tests', argv: ['node', '--test'] }];
}

function retryBudget(maxRuns = 4) {
  return {
    ...BUDGET,
    batch: {
      ...BUDGET.batch,
      maxRuns,
      maxTotalAttempts: Math.max(maxRuns, BUDGET.run.maxAttemptsPerRun),
      maxRuntimeStarts: Math.max(maxRuns, BUDGET.run.maxAttemptsPerRun),
      maxNoProgressRuns: Math.max(maxRuns, 1),
    },
  };
}

function completed(receipt: { readonly status: string; readonly result?: unknown }): { readonly runId: string } {
  if (receipt.status !== 'completed' || receipt.result === null || typeof receipt.result !== 'object') {
    throw new Error(`retryFinal failed: ${JSON.stringify(receipt)}`);
  }
  const result = receipt.result as { readonly runId?: unknown };
  if (typeof result.runId !== 'string') throw new Error('missing runId');
  return { runId: result.runId };
}

async function createFinalizationRun(f: EligibleFinalizationFixture, staleSource: boolean): Promise<string> {
  if (staleSource) changeSource(f);
  const receipt = await retryCommandsFor(f).submit(randomUUID(), retryPayload(f));
  return completed(receipt).runId;
}

async function publishJson(f: EligibleFinalizationFixture, kind: string, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  return (await f.publisher.publishArtifact({
    projectId: f.box.projectId,
    kind,
    mediaType: 'application/json',
    expectedHash: createHash('sha256').update(body).digest('hex'),
    locator: `evidence/f011-${randomUUID()}.json`,
    content: [body],
  })).artifact;
}

interface AttemptRow {
  readonly id: string;
  readonly run_id: string;
  readonly task_id: string;
  readonly feature_id: string;
  readonly execution_version: number;
}

function attemptForTask(f: EligibleFinalizationFixture, taskId: string): AttemptRow {
  const attempt = row<AttemptRow>(f,
    'SELECT id, run_id, task_id, feature_id, execution_version FROM attempts WHERE task_id = ? ORDER BY number DESC LIMIT 1',
    taskId);
  if (attempt === undefined) throw new Error(`attempt missing for ${taskId}`);
  return attempt;
}

type EvidenceMode = 'passed' | 'failed' | 'inconclusive' | 'missing' | 'zero_tests';

interface RecordOptions {
  readonly status?: EvidenceMode;
  readonly testCount?: number;
  readonly omitCheckKeys?: readonly string[];
}

async function recordEvidence(
  f: EligibleFinalizationFixture,
  input: FinalizationTaskRevalidationInput | FinalizationFeatureVerificationInput,
  operation: string,
  checkKeys: readonly string[],
  options: RecordOptions = {},
): Promise<FinalizationVerificationEvidence> {
  const status = options.status ?? 'passed';
  const anchorTaskId = 'taskId' in input ? input.taskId : 't-1';
  const attempt = attemptForTask(f, anchorTaskId);
  const taskCount = row<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM tasks')!.n;
  const all = definitions(taskCount);
  const selected = checkKeys
    .filter(checkKey => !(options.omitCheckKeys ?? []).includes(checkKey))
    .map(checkKey => all.find(definition => definition.checkKey === checkKey)!)
    .filter((definition): definition is Definition => definition !== undefined);
  if (selected.length === 0) throw new Error('no checks selected');
  const batchId = randomUUID();
  const later = NOW + 10_000;
  const verification = createSqliteVerificationStore(f.box.session, { nowUtcMs: () => later });
  const atomic = createSqliteAtomicCommandStore(f.box.session, { nowUtcMs: () => later });
  const checks: FinalizationCheckEvidence[] = [];
  let batchStatus: 'passed' | 'failed' | 'inconclusive' = 'passed';
  for (const definition of selected) {
    const resultStatus = status === 'passed' ? 'passed'
      : status === 'failed' ? 'failed'
        : status === 'zero_tests' ? 'passed' : 'not_run';
    if (resultStatus !== 'passed') batchStatus = status === 'failed' ? 'failed' : 'inconclusive';
    const output = await publishJson(f, 'verification_output', {
      schemaVersion: 1, checkKey: definition.checkKey, codeDigest: input.codeDigest, status: resultStatus,
    });
    checks.push({
      checkKey: definition.checkKey,
      status: resultStatus,
      resultId: randomUUID(),
      outputArtifactId: output.id,
      testCount: status === 'zero_tests' ? (options.testCount ?? 0) : resultStatus === 'passed' ? 2 : null,
    });
  }
  atomic.transact('F011.recordEvidence', transaction => {
    verification.createVerificationBatchInTransaction(transaction, {
      batchId, projectId: f.box.projectId, featureId: attempt.feature_id,
      runId: attempt.run_id, taskId: attempt.task_id, attemptId: attempt.id,
      executionVersion: attempt.execution_version, operation, codeDigest: input.codeDigest,
      policyDigest: input.checkPolicyDigest,
      environmentSummary: { workspace: { headCommit: input.headCommit, codeDigest: input.codeDigest } },
      checkSnapshot: selected.map(definition => ({
        checkKey: definition.checkKey, scope: definition.scope, kind: definition.kind,
        argv: [...definition.argv], cwdRef: definition.cwdRef, environmentRef: definition.environmentRef,
        timeout: definition.timeout, required: definition.required,
        requirementRefs: [...definition.requirementRefs],
      })),
      selection: { schemaVersion: 1, mode: 'full_fallback', reason: 'F-011 finalization verification',
        selectedCheckKeys: selected.map(definition => definition.checkKey) },
      startedAtUtcMs: later,
    });
    for (const check of checks) {
      verification.saveCheckResultInTransaction(transaction, {
        resultId: check.resultId, projectId: f.box.projectId, batchId, checkKey: check.checkKey,
        status: check.status, exitCode: check.status === 'passed' ? 0 : 1, signal: null, timedOut: false,
        outputArtifactId: check.outputArtifactId, outputTail: 'f011 evidence', startedAtUtcMs: later, endedAtUtcMs: later + 1,
      });
    }
    verification.finalizeVerificationBatchInTransaction(transaction, {
      projectId: f.box.projectId, batchId, expectedRevision: 1, status: batchStatus, endedAtUtcMs: later + 2,
    });
  });
  return {
    batchId,
    operation,
    status: batchStatus,
    invalidated: false,
    checks,
  };
}

function verifierFor(
  f: EligibleFinalizationFixture,
  options: {
    readonly task?: RecordOptions;
    readonly feature?: RecordOptions;
    readonly afterFeature?: () => void;
    readonly onRevalidate?: () => void;
  } = {},
): FinalizationVerifier {
  return {
    async revalidateTask(input) {
      options.onRevalidate?.();
      return recordEvidence(f, input, FINALIZATION_TASK_VERIFICATION_OPERATION,
        input.checkKeys, options.task);
    },
    async verifyFeature(input) {
      const evidence = await recordEvidence(f, input, FEATURE_VERIFICATION_OPERATION,
        input.checkKeys, options.feature);
      options.afterFeature?.();
      return evidence;
    },
  };
}

function serviceFor(f: EligibleFinalizationFixture, verifier: FinalizationVerifier) {
  const verification = createSqliteVerificationStore(f.box.session, { nowUtcMs: () => NOW });
  return createFinalizationExecutionService({
    facts: createSqliteExecutionResumeFactsReader(f.box.session, { nowUtcMs: () => NOW }),
    planner: plannerFor(f),
    atomic: createSqliteAtomicCommandStore(f.box.session, { nowUtcMs: () => NOW }),
    verification,
    artifacts: f.verifier,
    verifier,
    nowMs: () => NOW,
  });
}

function counts(f: EligibleFinalizationFixture) {
  return {
    runs: row<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM runs')!.n,
    attempts: row<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM attempts')!.n,
    runtimeStarts: row<{ n: number }>(f, 'SELECT runtime_starts AS n FROM execution_batches WHERE id = ?', f.ids.batchId)!.n,
  };
}

describe('P03-9 / F-011 finalization execution', () => {
  it('只执行 scope 列出的 Task 重验与 Feature 全量检查，并真实落库证据且不启动 Runtime', async () => {
    const f = await prepareEligibleFixture({ taskCount: 2, budget: retryBudget() });
    try {
      const runId = await createFinalizationRun(f, true);
      const before = counts(f);
      const tasksBefore = tableRows(f, 'SELECT * FROM tasks ORDER BY id');
      const oldBatches = tableRows<{ id: string }>(f, 'SELECT id FROM verification_batches ORDER BY rowid');
      const calls: { revalidate: string[]; feature: string[] } = { revalidate: [], feature: [] };
      const verifier = verifierFor(f);
      const recording: FinalizationVerifier = {
        revalidateTask(input) {
          calls.revalidate.push(input.taskId);
          return verifier.revalidateTask(input);
        },
        verifyFeature(input) {
          calls.feature.push(...input.checkKeys);
          return verifier.verifyFeature(input);
        },
      };
      const result = await serviceFor(f, recording).execute({ projectId: f.box.projectId, runId });
      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'verification_passed',
        runId,
        featureId: f.box.featureId,
        runtimeStarts: 0,
        newAttempts: 0,
      });
      expect(calls.revalidate.sort()).toEqual(['t-1', 't-2']);
      expect(calls.feature.sort()).toEqual(['lint', 'tests']);
      expect(result.missingSteps).not.toContain('task_revalidation');
      expect(result.missingSteps).not.toContain('feature_verification');
      expect(counts(f)).toEqual(before);
      expect(tableRows(f, 'SELECT * FROM tasks ORDER BY id')).toEqual(tasksBefore);
      const revalidated = tableRows<{ operation: string; status: string }>(f,
        'SELECT operation, status FROM verification_batches WHERE operation = ? ORDER BY rowid',
        FINALIZATION_TASK_VERIFICATION_OPERATION);
      expect(revalidated).toHaveLength(2);
      expect(revalidated.every(batch => batch.status === 'passed')).toBe(true);
      const featureBatches = tableRows<{ status: string; code_digest: string }>(f,
        'SELECT status, code_digest FROM verification_batches WHERE operation = ? ORDER BY rowid',
        FEATURE_VERIFICATION_OPERATION);
      expect(featureBatches).toHaveLength(2);
      expect(featureBatches[featureBatches.length - 1]).toMatchObject({ status: 'passed' });
      expect(tableRows<{ id: string }>(f, 'SELECT id FROM verification_batches ORDER BY rowid')
        .map(batch => batch.id)).toEqual(expect.arrayContaining(oldBatches.map(batch => batch.id)));
      expect(row(f, 'SELECT status FROM runs WHERE id = ?', runId)).toMatchObject({ status: 'queued' });
    } finally { f.box.close(); }
  }, 60_000);

  it('受信 Node Verifier 适配器用真实命令执行 Task 重验与 Feature 全量检查', async () => {
    const script = (key: string) => `const fs=require('node:fs');const ok=fs.readFileSync('src/a.ts','utf8').includes('changed-after-pass');console.log('SHIPLOOP_NODE_CHECK_RESULT='+JSON.stringify({schemaVersion:1,protocol:'shiploop.node-check',collected:true,testCount:2,targets:['tests','lint']}));if(!ok)process.exitCode=1;`;
    const definitions = ['tests', 'lint'].map(checkKey => ({
      checkKey, scope: 'task' as const, kind: 'command' as const,
      argv: [process.execPath, '-e', script(checkKey)], cwdRef: null, environmentRef: null,
      timeout: 30_000, required: true, requirementRefs: [] as string[],
    })) satisfies readonly CheckDefinition[];
    const f = await prepareEligibleFixture({ taskCount: 2, budget: retryBudget(), checkDefinitions: definitions });
    try {
      const runId = await createFinalizationRun(f, true);
      const attempts = createSqliteAttemptAccess(f.box.session);
      const anchor = [...attempts.listTaskAttempts(f.box.projectId, 't-1')]
        .sort((left, right) => left.number - right.number).at(-1)!;
      const verifier = createNodeFinalizationVerifier({
        processes: createCommandProcessAdapter({ stopGraceMs: 500, stopConfirmMs: 1_000 }),
        verification: createSqliteVerificationStore(f.box.session, { nowUtcMs: () => NOW + 20_000 }),
        atomic: createSqliteAtomicCommandStore(f.box.session, { nowUtcMs: () => NOW + 20_000 }),
        artifacts: f.artifacts,
        files: createArtifactFileStore({ dataRoot: f.box.box.dataRoot }),
        attempts,
        readPolicy: () => ({ requireChecksBeforeDone: true, checkDefinitions: definitions,
          fullFallback: { checkRefs: definitions.map(definition => definition.checkKey) } }),
        resolveCwd: async () => f.box.box.repoDirA,
        resolveEnvironment: () => ({}),
        resolveFeatureAnchor: () => ({ taskId: anchor.taskId, attemptId: anchor.id, runId: anchor.runId, executionVersion: anchor.executionVersion }),
        stopControl: createVerificationStopControl({ waitMs: 2_000 }),
        nowUtcMs: () => NOW + 20_000,
      });
      const result = await serviceFor(f, verifier).execute({ projectId: f.box.projectId, runId });
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'verification_passed', runtimeStarts: 0, newAttempts: 0 });
      expect(tableRows(f, 'SELECT status FROM verification_batches WHERE operation = ?', FINALIZATION_TASK_VERIFICATION_OPERATION))
        .toEqual([{ status: 'passed' }, { status: 'passed' }]);
      expect(tableRows(f, 'SELECT status FROM verification_batches WHERE operation = ? ORDER BY created_at DESC LIMIT 1',
        FEATURE_VERIFICATION_OPERATION)).toEqual([{ status: 'passed' }]);
      expect(row<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM attempts')!.n).toBe(2);
    } finally { f.box.close(); }
  }, 120_000);

  it('最终检查失败时 Run 失败，保留 worktree、有效 Task 与新旧失败证据，不创建新 Run/Attempt', async () => {
    const f = await prepareEligibleFixture({ taskCount: 2, budget: retryBudget() });
    try {
      const runId = await createFinalizationRun(f, true);
      const before = counts(f);
      const tasksBefore = tableRows(f, 'SELECT * FROM tasks ORDER BY id');
      const featureBatchesBefore = tableRows(f, 'SELECT id, status FROM verification_batches WHERE operation = ? ORDER BY rowid',
        FEATURE_VERIFICATION_OPERATION);
      const result = await serviceFor(f, verifierFor(f, { feature: { status: 'failed' } }))
        .execute({ projectId: f.box.projectId, runId });
      expect(result.status).toBe('verification_failed');
      expect(result.runStatus).toBe('failed');
      const run = row<{ status: string; reason: string }>(f, 'SELECT status, reason FROM runs WHERE id = ?', runId)!;
      expect(run.status).toBe('failed');
      expect(run.reason).toContain('feature_verification_failed');
      expect(counts(f)).toMatchObject({ runs: before.runs, attempts: before.attempts, runtimeStarts: before.runtimeStarts });
      expect(tableRows(f, 'SELECT * FROM tasks ORDER BY id')).toEqual(tasksBefore);
      expect(existsSync(f.box.box.repoDirA)).toBe(true);
      const featureBatchesAfter = tableRows<{ id: string; status: string }>(f,
        'SELECT id, status FROM verification_batches WHERE operation = ? ORDER BY rowid',
        FEATURE_VERIFICATION_OPERATION);
      expect(featureBatchesBefore.every(batch => featureBatchesAfter.some(after => after.id === batch.id))).toBe(true);
      expect(featureBatchesAfter.some(batch => batch.status === 'failed')).toBe(true);
      expect(row<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM runs')!.n).toBe(before.runs);
      expect(row<{ n: number }>(f, "SELECT COUNT(*) AS n FROM state_events WHERE event_type = 'execution.run.dispatched'")!.n).toBe(2);
    } finally { f.box.close(); }
  }, 60_000);

  it('缺必需检查、零测试或 not_run 证据均不得完成', async () => {
    const cases: readonly { name: string; feature: RecordOptions; additionalMissing?: boolean }[] = [
      { name: 'missing check', feature: { omitCheckKeys: ['lint'] } },
      { name: 'zero tests', feature: { status: 'zero_tests', testCount: 0 } },
      { name: 'not_run', feature: { status: 'inconclusive' } },
    ];
    for (const item of cases) {
      const f = await prepareEligibleFixture({ taskCount: 2, budget: retryBudget() });
      try {
        const runId = await createFinalizationRun(f, true);
        const result = await serviceFor(f, verifierFor(f, { feature: item.feature }))
          .execute({ projectId: f.box.projectId, runId });
        expect(result.status, item.name).toBe('verification_failed');
        expect(row(f, 'SELECT status FROM runs WHERE id = ?', runId), item.name).toMatchObject({ status: 'failed' });
      } finally { f.box.close(); }
    }
  }, 120_000);

  it('检查期间源码变化使本次结果失效并保留失败证据', async () => {
    const f = await prepareEligibleFixture({ taskCount: 2, budget: retryBudget() });
    try {
      const runId = await createFinalizationRun(f, true);
      const result = await serviceFor(f, verifierFor(f, {
        afterFeature: () => writeFileSync(join(f.box.box.repoDirA, 'src/a.ts'), 'export const project = "changed-during-finalization";\n'),
      })).execute({ projectId: f.box.projectId, runId });
      expect(result.status).toBe('invalidated');
      expect(row(f, 'SELECT status FROM runs WHERE id = ?', runId)).toMatchObject({ status: 'failed' });
      expect(tableRows(f, 'SELECT status FROM tasks ORDER BY id').every(task => (task as { status: string }).status === 'passed')).toBe(true);
      expect(existsSync(join(f.box.box.repoDirA, 'src/a.ts'))).toBe(true);
    } finally { f.box.close(); }
  }, 60_000);

  it('取消/暂停边界不覆盖控制状态，也不继续执行最终检查', async () => {
    const f = await prepareEligibleFixture({ taskCount: 2, budget: retryBudget() });
    try {
      const runId = await createFinalizationRun(f, true);
      let featureCalls = 0;
      const verifier = verifierFor(f, {
        onRevalidate: () => {
          f.box.session.database.prepare("UPDATE runs SET status = 'cancelling', revision = revision + 1 WHERE id = ?").run(runId);
        },
      });
      const recording: FinalizationVerifier = {
        revalidateTask: input => verifier.revalidateTask(input),
        verifyFeature: input => { featureCalls += 1; return verifier.verifyFeature(input); },
      };
      const result = await serviceFor(f, recording).execute({ projectId: f.box.projectId, runId });
      expect(result.status).toBe('control_interrupted');
      expect(featureCalls).toBe(0);
      expect(row(f, 'SELECT status FROM runs WHERE id = ?', runId)).toMatchObject({ status: 'cancelling' });
    } finally { f.box.close(); }
  }, 60_000);

  it('已到父 deadline 或显式 abort 时不启动任何检查', async () => {
    const f = await prepareEligibleFixture({ taskCount: 2, budget: retryBudget() });
    try {
      const runId = await createFinalizationRun(f, true);
      const verifier = verifierFor(f);
      const recording: FinalizationVerifier = {
        revalidateTask: vi.fn(input => verifier.revalidateTask(input)),
        verifyFeature: vi.fn(input => verifier.verifyFeature(input)),
      };
      f.box.session.database.prepare('UPDATE execution_batches SET deadline_at = ? WHERE id = ?')
        .run(NOW - 1, f.ids.batchId);
      const timedOut = await serviceFor(f, recording).execute({ projectId: f.box.projectId, runId });
      expect(timedOut.status).toBe('control_interrupted');
      expect(timedOut.reason).toBe('batch_deadline_exceeded');
      expect(recording.revalidateTask).not.toHaveBeenCalled();
      expect(recording.verifyFeature).not.toHaveBeenCalled();

      const controller = new AbortController();
      controller.abort();
      f.box.session.database.prepare('UPDATE execution_batches SET deadline_at = ? WHERE id = ?')
        .run(NOW + 3_600_000, f.ids.batchId);
      const aborted = await serviceFor(f, recording).execute({
        projectId: f.box.projectId, runId, signal: controller.signal,
      });
      expect(aborted.status).toBe('control_interrupted');
      expect(aborted.reason).toBe('cancelled');
      expect(recording.revalidateTask).not.toHaveBeenCalled();
      expect(recording.verifyFeature).not.toHaveBeenCalled();
    } finally { f.box.close(); }
  }, 60_000);

  it('调度 handoff 在认领前处理 finalization Run，不创建编码 Attempt 且只执行一次', async () => {
    const f = await prepareEligibleFixture({ taskCount: 2, budget: retryBudget() });
    try {
      const runId = await createFinalizationRun(f, false);
      const before = counts(f);
      const execute = vi.fn(async () => ({ recordHandoff: true }));
      const prepareClaim = vi.fn(async () => { throw new Error('coding claim must not be prepared'); });
      const claims = { claimTask: vi.fn(() => { throw new Error('coding claim must not be called'); }) };
      const dag = { evaluate: vi.fn(() => { throw new Error('DAG must not be consulted for finalization-only Run'); }) };
      const scheduler = createWorkScheduler({
        store: createSqliteSchedulerStore(f.box.session, { nowUtcMs: () => NOW }),
        dag,
        claims,
        prepareClaim,
        consumeClaim: vi.fn(async () => undefined),
        finalization: { execute },
        timers: { setTimeout: () => 0, clearTimeout: () => undefined },
      });
      const first = await scheduler.scan();
      expect(first.runs).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ projectId: f.box.projectId, runId }));
      expect(prepareClaim).not.toHaveBeenCalled();
      expect(claims.claimTask).not.toHaveBeenCalled();
      expect(dag.evaluate).not.toHaveBeenCalled();
      expect(counts(f)).toMatchObject(before);
      expect(row<{ reason: string }>(f, 'SELECT reason FROM runs WHERE id = ?', runId)!.reason)
        .toBe('feature_final_verification_handed_off');
      const second = await scheduler.scan();
      expect(second.runs).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);
      await scheduler.close();
    } finally { f.box.close(); }
  }, 60_000);

  it('非 finalization Run 不执行任何重验或最终检查', async () => {
    const f = await openFinalizationFixture({ taskCount: 1 });
    try {
      const run = row<{ id: string }>(f, 'SELECT id FROM runs LIMIT 1')!;
      const verifier = {
        revalidateTask: vi.fn(),
        verifyFeature: vi.fn(),
      } as unknown as FinalizationVerifier;
      const service = createFinalizationExecutionService({
        facts: createSqliteExecutionResumeFactsReader(f.box.session, { nowUtcMs: () => NOW }),
        planner: { prepare: vi.fn() },
        atomic: createSqliteAtomicCommandStore(f.box.session, { nowUtcMs: () => NOW }),
        verification: createSqliteVerificationStore(f.box.session, { nowUtcMs: () => NOW }),
        artifacts: { verifyArtifact: vi.fn() } as never,
        verifier,
        nowMs: () => NOW,
      });
      const result = await service.execute({ projectId: f.box.projectId, runId: run.id });
      expect(result.status).toBe('not_finalization_run');
      expect(verifier.revalidateTask).not.toHaveBeenCalled();
      expect(verifier.verifyFeature).not.toHaveBeenCalled();
    } finally { f.box.close(); }
  }, 60_000);
});
