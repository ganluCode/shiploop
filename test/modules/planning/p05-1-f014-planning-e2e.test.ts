/**
 * P05-1 / F-014：一次性规划 Core/Host/CLI 定向端到端接线。
 *
 * 这份测试只保留一条代表性纵向链：真实临时 SQLite/Git、生产 Host
 * startFakeHost、runAppCli、FakeRuntime 和受限 planning candidate 工具。
 * 竞争、取消、恢复、迟到 owner、预算耗尽等矩阵复用前序职责测试的完整文件，
 * 不在此复制第二套大夹具。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runAppCli, type AppCliIo, type AppCliRunResult } from '../../../packages/cli/src/app-execute.ts';
import { createFakeRuntimeGate } from '../../../packages/core/src/adapters/testing.ts';
import type { FakeRuntimeScriptStep } from '../../../packages/core/src/ports/fake-runtime-script.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import type { SqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { PLANNING_CANDIDATE_SUBMIT_OPERATION } from '../../../packages/core/src/ports/planning-candidates.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { startFakeHost } from '../../../packages/host/src/testing.ts';
import type { RunningHost } from '../../../packages/host/src/runtime/index.ts';
import { createCommandsTestFixture } from '../../helpers/p02-2/index.ts';
import type { CommandsTestFixture } from '../../helpers/p02-2/index.ts';
import { seedFeatureWorkspace } from '../../helpers/planning/p05-1-f007-fixture.ts';

const NOW = 1_900_000_000_000;
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const FUTURE_MS = Date.now() + 3_600_000;
const FAKE_STRATEGY = { runtime: 'fake', provider: 'test-provider', model: 'fake-model' } as const;
const TOOL_STRATEGY = { runtime: 'pi', provider: 'provider', model: 'model' } as const;
const FAKE_CATALOG = createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] },
]);
const SCRIPT_STEPS: readonly FakeRuntimeScriptStep[] = [
  { op: 'message', role: 'assistant', text: 'planning candidate ready' },
  { op: 'await_gate', name: 'submit' },
  { op: 'message', role: 'assistant', text: 'planning finished' },
];

interface Envelope {
  readonly ok: boolean;
  readonly command: string | null;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly details?: Record<string, unknown> };
}

interface Rig {
  readonly box: CommandsTestFixture;
  readonly host: RunningHost;
  readonly session: SqliteStorageSession;
  readonly gate: ReturnType<typeof createFakeRuntimeGate>;
  readonly owner: ReturnType<CommandsTestFixture['localOwner']>;
}

const rigs: Rig[] = [];

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: process.cwd(), timeout: 60_000 });
});

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    rig.gate.release();
    try { await rig.host.close(); } catch { /* 失败现场由测试证据保留，继续关闭连接。 */ }
    try { rig.session.close(); } catch { /* closed */ }
    rig.box.cleanup();
  }
});

function collectIo(): { readonly io: AppCliIo; readonly stdout: () => string; readonly stderr: () => string } {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function runCli(rig: Rig, args: readonly string[]): Promise<{ result: AppCliRunResult; envelope: Envelope; stdout: string; stderr: string }> {
  const collected = collectIo();
  const result = await runAppCli({
    args: [...args, '--data-root', rig.box.dataRoot, '--json'],
    env: {},
    platform: 'darwin',
    userHomeDir: rig.box.homeDir,
    io: collected.io,
  });
  const stdout = collected.stdout();
  expect(stdout.trim().split('\n'), stdout).toHaveLength(1);
  return { result, envelope: JSON.parse(stdout) as Envelope, stdout, stderr: collected.stderr() };
}

async function seedDraft(rig: Rig): Promise<{ projectId: string; featureId: string; revision: number }> {
  const { host, owner } = rig;
  const submit = async (operation: string, scope: Record<string, unknown>, payload: Record<string, unknown>, expectedRevision?: number) => {
    const receipt = await host.core.commandService.submit(owner, {
      schemaVersion: 5,
      commandId: randomUUID(),
      issuedAt: new Date().toISOString(),
      operation,
      scope,
      payload,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    } as never);
    expect(['completed', 'accepted']).toContain(receipt.status);
    return receipt as { status: 'completed'; result: Record<string, unknown> };
  };

  const registered = await submit('project.register', { kind: 'registration' }, {
    repositoryPath: rig.box.repoDirA,
    displayName: 'P05-1 F-014 E2E',
    description: null,
    labels: [],
  });
  const projectId = String(registered.result.project && (registered.result.project as { id: string }).id);
  await submit('settings.global.create', { kind: 'global' }, {
    schemaVersion: 2,
    strategies: { defaultStrategy: FAKE_STRATEGY, purposeStrategies: { planner: FAKE_STRATEGY } },
  });
  await submit('phase.create', { kind: 'project', projectId }, {
    id: 'phase-1', title: 'P05-1 F-014', description: null, labels: [],
  });
  const imported = await submit('feature.plan.import', { kind: 'project', projectId }, {
    phaseId: 'phase-1',
    plan: {
      schemaVersion: 1,
      feature: { title: '一次性规划 E2E', description: null, labels: [], sourceRefs: [] },
      tasks: [{ id: 't-1', title: '既有草稿编码任务', acceptance: { criteria: ['草稿保持可查询'] }, dependsOn: [] }],
    },
  }, 1);
  const feature = imported.result.feature as { id: string; revision: number };
  return { projectId, featureId: feature.id, revision: feature.revision };
}

async function openRig(): Promise<Rig> {
  const box = createCommandsTestFixture({ prefix: 'shiploop-p051-f014-' });
  const gate = createFakeRuntimeGate();
  let session: SqliteStorageSession | undefined;
  const owner = box.localOwner();
  try {
    const host = await startFakeHost({
      dataRoot: box.dataRoot,
      platform: 'darwin',
      env: {},
      capabilityCatalog: FAKE_CATALOG,
      fake: {
        providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
        gates: { submit: gate },
        script: {
          schemaVersion: 1,
          steps: SCRIPT_STEPS,
          result: { terminal: 'completed', reason: null, exitCode: 0, signal: null, durationMs: 12, usage: null },
        },
      },
    });
    session = openSqliteStorageSession({ path: box.dbPath, busyTimeoutMs: 10_000, busyRetryAttempts: 5 });
    const rig: Rig = { box, host, session, gate, owner };
    rigs.push(rig);
    return rig;
  } catch (error) {
    try { session?.close(); } catch { /* closed */ }
    box.cleanup();
    throw error;
  }
}

function planningInput(): Record<string, unknown> {
  return {
    requirementRefs: [],
    constraints: ['保持规划与编码授权分离'],
    acceptance: { criteria: ['候选必须可审阅并带 verification'] },
    strategy: { approvalMode: 'manual', taskLimit: null },
    budget: {
      batch: { maxRuns: 1, maxTotalAttempts: 1, maxRuntimeStarts: 1, maxNoProgressRuns: 1, deadlineUtcMs: FUTURE_MS },
      run: { maxAttemptsPerRun: 1, runTimeLimitMs: 3_600_000 },
    },
  };
}

function candidateBody(projectId: string, featureId: string, runId: string, candidateId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    projectId,
    featureId,
    runId,
    candidateId,
    plan: {
      schemaVersion: 1,
      feature: { title: '已审批的一次性规划', description: null, labels: [], sourceRefs: [] },
      tasks: [
        { id: 't-1', title: '既有草稿编码任务', acceptance: { criteria: ['草稿保持可查询'] }, dependsOn: [] },
        { id: 'p-1', title: '实现规划闭环', acceptance: { criteria: ['规划闭环可验证'] }, dependsOn: [] },
        { id: 'p-2', title: '覆盖规划重放', acceptance: { criteria: ['重放不重复应用'] }, dependsOn: ['p-1'] },
      ],
    },
    taskVerification: [{ taskId: 'p-1', checkRefs: ['unit-core'], moduleRefs: ['planning'], impactScope: ['packages/core'] }],
    summary: '一次候选、一次人工决策。',
  });
}

describe('P05-1 / F-014 一次性规划生产 Core/Host/CLI 纵向', () => {
  it('[case:planning-e2e-single-run-candidate-apply] 重复命令与丢失唤醒只产生一次规划、候选和计划应用，未批准不能编码', async () => {
    const rig = await openRig();
    const seed = await seedDraft(rig);
    const inputPath = `${rig.box.root}/planning-input.json`;
    writeFileSync(inputPath, `${JSON.stringify(planningInput())}\n`, { encoding: 'utf8', flag: 'wx' });

    const startCommandId = randomUUID();
    const startArgs = [
      'planning', 'start', seed.featureId, '--project', seed.projectId, '--phase', 'phase-1',
      '--revision', String(seed.revision), '--input', inputPath, '--command-id', startCommandId,
    ];
    const started = await runCli(rig, startArgs);
    expect(started.result.exitCode, started.stdout + started.stderr).toBe(0);
    expect(started.envelope).toMatchObject({ ok: true, command: 'planning.start' });
    const startView = started.envelope.result!;
    expect(startView).toMatchObject({ status: 'accepted', planning: { encodingAuthorized: false } });
    const runId = String(startView.runId);
    const planningTaskId = String(startView.planningTaskId);
    const candidateId = String(startView.candidateId);

    const replayedStart = await runCli(rig, startArgs);
    expect(replayedStart.result.exitCode).toBe(0);
    expect(replayedStart.envelope.result).toMatchObject({ runId, candidateId, replayed: true });
    expect(rig.session.database.prepare('SELECT COUNT(*) AS n FROM runs WHERE purpose = \'plan\'').get()).toEqual({ n: 1 });
    expect(rig.session.database.prepare('SELECT COUNT(*) AS n FROM planning_contexts').get()).toEqual({ n: 1 });

    await seedFeatureWorkspace(rig.box, rig.session, seed.projectId, seed.featureId, runId, NOW);
    await rig.host.core.workExecution.scan();
    await rig.host.core.workExecution.scan();
    await expect.poll(() => rig.session.database.prepare<[string], { n: number }>(
      "SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND status = 'executing'",
    ).get(planningTaskId)?.n ?? 0, { timeout: 20_000 }).toBe(1);

    await expect.poll(() => rig.session.database.prepare<[string], { invocation_id: string | null }>(
      'SELECT invocation_id FROM attempts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ).get(planningTaskId)?.invocation_id ?? null, { timeout: 20_000 }).toBeTruthy();

    const attempt = rig.session.database.prepare<[string], {
      id: string; invocation_id: string; execution_version: number; host_instance_id: string;
    }>('SELECT id, invocation_id, execution_version, host_instance_id FROM attempts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(planningTaskId)!;
    const preflight = rig.session.database.prepare<[string, string], Record<string, unknown>>(
      "SELECT (SELECT status FROM attempts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1) AS attempt_status, "
      + "(SELECT status FROM runs WHERE id = ?) AS run_status, "
      + "(SELECT status FROM tasks WHERE id = ?) AS task_status, "
      + "(SELECT status FROM execution_batches WHERE id = (SELECT batch_id FROM runs WHERE id = ?)) AS batch_status",
    ).get(planningTaskId, runId, planningTaskId, runId);
    expect(preflight).toMatchObject({ attempt_status: 'executing', run_status: 'running', task_status: 'running', batch_status: 'running' });
    const binding = authorityBinding(rig, seed.projectId, runId, planningTaskId, attempt);
    const channel = rig.host.core.createWorkToolChannel({
      currentBinding: () => binding,
      candidateContext: () => { throw new Error('coding candidate context is unavailable'); },
    });
    const grant = channel.bind({
      schemaVersion: 1,
      context: {
        grantId: randomUUID(), principalId: rig.owner.principalId, projectId: seed.projectId,
        hostInstanceId: attempt.host_instance_id,
        identity: binding.identity, invocationId: attempt.invocation_id,
        executionVersion: attempt.execution_version, issuedAtUtcMs: Date.now() - 100, expiresAtUtcMs: Date.now() + 3_600_000,
        operations: [PLANNING_CANDIDATE_SUBMIT_OPERATION],
      },
      runtime: 'pi', provider: 'provider', model: 'model',
      authentication: { kind: 'local_login', sourceRef: randomUUID(), pluginId: null, environmentRefs: [] },
      resources: [],
    } as never, binding);
    const candidate = candidateBody(seed.projectId, seed.featureId, runId, candidateId);
    const submitCommandId = randomUUID();
    const submitPayload = {
      schemaVersion: 5, commandId: submitCommandId, issuedAt: new Date().toISOString(),
      operation: PLANNING_CANDIDATE_SUBMIT_OPERATION,
      scope: { kind: 'project', projectId: seed.projectId },
      payload: {
        identity: binding.identity, invocationId: attempt.invocation_id,
        executionVersion: attempt.execution_version, candidate,
      },
    };
    const submitted = await grant.invoke(submitPayload);
    const submittedAgain = await grant.invoke(submitPayload);
    expect(submitted).toMatchObject({ status: 'completed' });
    expect(submittedAgain).toMatchObject({ status: 'completed' });
    expect(rig.session.database.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE kind = \'planning-candidate\'').get()).toEqual({ n: 1 });
    grant.revoke();

    rig.gate.release();
    await expect.poll(() => rig.session.database.prepare<[string], { status: string }>('SELECT status FROM runs WHERE id = ?').get(runId)?.status,
      { timeout: 20_000 }).toBe('succeeded');

    const candidateView = await runCli(rig, ['planning', 'candidate', candidateId, '--project', seed.projectId]);
    expect(candidateView.result.exitCode).toBe(0);
    const candidateDigest = String((candidateView.envelope.result!.candidate as { candidateDigest: string }).candidateDigest);
    expect(candidateDigest).toMatch(/^[0-9a-f]{64}$/);

    const budgetPath = `${rig.box.root}/execution-budget.json`;
    writeFileSync(budgetPath, JSON.stringify({
      batch: { maxRuns: 1, maxTotalAttempts: 1, maxRuntimeStarts: 1, maxNoProgressRuns: 1, deadlineUtcMs: FUTURE },
      run: { maxAttemptsPerRun: 1, runTimeLimitMs: 3_600_000 },
    }), { encoding: 'utf8', flag: 'wx' });
    const beforeApproval = await runCli(rig, [
      'execution', 'preview', seed.featureId, '--project', seed.projectId, '--input', budgetPath,
    ]);
    expect(beforeApproval.result.exitCode).toBe(0);
    expect(beforeApproval.envelope).toMatchObject({
      ok: true,
      result: {
        authorization: { confirmed: false },
        execution: { started: false, runtimeExecution: false },
      },
    });
    expect(rig.session.database.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });

    const approveCommandId = randomUUID();
    const approveArgs = [
      'planning', 'approve', candidateId, '--project', seed.projectId, '--digest', candidateDigest,
      '--revision', String(seed.revision), '--command-id', approveCommandId,
    ];
    const approved = await runCli(rig, approveArgs);
    expect(approved.result.exitCode, approved.stdout + approved.stderr).toBe(0);
    expect(approved.envelope).toMatchObject({ ok: true, command: 'planning.approve' });
    const approvedAgain = await runCli(rig, approveArgs);
    expect(approvedAgain.result.exitCode).toBe(0);
    expect(approvedAgain.envelope.result).toMatchObject({ replayed: true });

    expect(rig.session.database.prepare<[string], { status: string }>('SELECT status FROM planning_contexts WHERE candidate_id = ?').get(candidateId)).toEqual({ status: 'applied' });
    expect(rig.session.database.prepare<[string], { plan_status: string }>('SELECT plan_status FROM features WHERE id = ?').get(seed.featureId)).toEqual({ plan_status: 'approved' });
    expect(rig.session.database.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
    expect(rig.session.database.prepare('SELECT COUNT(*) AS n FROM command_receipts WHERE operation = \'planning.candidate.decide\'').get()).toEqual({ n: 1 });
    expect(rig.session.database.prepare('SELECT COUNT(*) AS n FROM tasks WHERE feature_id = ? AND kind = \'planning\'').get(seed.featureId)).toEqual({ n: 1 });
    expect(rig.session.database.prepare('SELECT COUNT(*) AS n FROM tasks WHERE feature_id = ? AND kind = \'coding\'').get(seed.featureId)).toEqual({ n: 3 });
  }, 120_000);
});

function authorityBinding(
  rig: Rig,
  projectId: string,
  runId: string,
  taskId: string,
  attempt: { id: string; invocation_id: string; execution_version: number; host_instance_id: string },
) {
  return {
    principal: rig.owner,
    projectId,
    hostInstanceId: attempt.host_instance_id,
    identity: { purpose: 'work' as const, runId, taskId, attemptId: attempt.id },
    invocationId: attempt.invocation_id,
    executionVersion: attempt.execution_version,
    nowUtcMs: Date.now(),
    strategy: TOOL_STRATEGY,
  };
}
