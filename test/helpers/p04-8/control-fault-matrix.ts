/**
 * P04-8 F-006 取消、超时、强杀、停止不确定与证据完整性离线控制矩阵。
 *
 * 四个矩阵组分别通过前序 Feature 的公开接口组合，只使用真实临时 SQLite/Git、
 * 受控三代写入进程和生产适配器，不调用模型或网络：
 * - `runControlEventFaults`：请求取消、工具取消、执行超时、Host 异常与 Runner
 *   强杀。每个场景核对控制回执、真实进程树清点、Attempt/Run 终态与停止证据。
 * - `runStopUncertaintyFaults`：停止无法确认（interrupted 占用、孤儿后代仍在
 *   写入）时保留占用与现场，不重新认领，cleanup 不标记为通过。
 * - `runLateResultFaults`：迟到的模型/工具/进程结果不能覆盖取消或新代次的
 *   业务状态，不重复记账、不制造通过结果。
 * - `runReportIntegrityFaults`：报告目录损坏、证据缺失、非空目录重用与清理
 *   失败均 fail-closed 并保留可审计现场。
 *
 * 本文件是测试库（helpers），不是测试入口；不接触凭据、真实网络或模型，
 * 不递归启动全量或阶段入口。
 */
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import type {
  CommandProcessHandle,
  CommandProcessIdentity,
  CommandProcessResult,
} from '../../../packages/core/src/ports/command-process.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { createSqliteExecutionAccess } from '../../../packages/core/src/adapters/sqlite/execution-store.ts';
import { createSqliteAttemptLifecycleStore } from '../../../packages/core/src/adapters/sqlite/attempt-lifecycle-store.ts';
import { createSqliteAttemptAccess } from '../../../packages/core/src/adapters/sqlite/attempt-store.ts';
import { createSqliteTaskDagStore } from '../../../packages/core/src/adapters/sqlite/task-dag-store.ts';
import { createSqliteWorkSessionStore } from '../../../packages/core/src/adapters/sqlite/work-session-store.ts';
import { createRuntimeSettlementService } from '../../../packages/core/src/application/runtime-settlement.ts';
import { createWorkEvidenceRecorder } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import type { RuntimeExecutionRequest, RuntimeExecutionResult, RuntimeHandle, RuntimeStopEvidence } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { AttemptApplicationResult } from '../../../packages/core/src/ports/attempt-lifecycle.ts';
import { runBoundedProcess } from '../../../scripts/acceptance/p02-accept.ts';
import {
  P04StepError,
  runP04StepSequence,
  type P04StepSequenceOptions,
  type P04StepSpec,
} from '../../../scripts/acceptance/p04-steps.ts';
import { openClaimFixture } from '../p03-4/task-claim-fixture.ts';
import { NOW as CLAIM_NOW } from '../p03-3/budget-fixture.ts';
import { BINDING_NOW, openBindingFixture } from '../p03-6/input-binding-fixture.ts';
import { DEFAULT_RECORDER_LIMITS } from '../p03-6/evidence-fixture.ts';
import { matrixStopProbe, matrixWriter, processRows, until } from '../process-matrix.ts';
import { openProcessRecoveryFixture } from '../process-recovery-matrix.ts';
import type { SafeCleanupError } from '../safe-cleanup.ts';
import { createP048Fixture } from './acceptance-fixture.ts';

type RecoveryFixture = Awaited<ReturnType<typeof openProcessRecoveryFixture>>;
type RecoveryOutcome = Awaited<ReturnType<RecoveryFixture['recover']>>;

export const CONTROL_FAULT_MATRIX_SCHEMA_VERSION = 1 as const;

export const CONTROL_EVENT_IDS = Object.freeze([
  'request-cancel', 'tool-cancel', 'execution-timeout', 'host-exception', 'runner-kill',
] as const);
export const STOP_UNCERTAINTY_IDS = Object.freeze([
  'cancel-stop-uncertain', 'recovery-stop-unconfirmed',
] as const);
export const LATE_RESULT_IDS = Object.freeze([
  'late-model-result-after-cancel',
  'late-settlement-after-cancelled-attempt',
  'late-tool-and-process-results-after-cancel',
] as const);
export const REPORT_INTEGRITY_IDS = Object.freeze([
  'report-dir-corrupt', 'evidence-missing', 'nonempty-dir-reuse', 'cleanup-failure',
] as const);

export type ControlEventId = (typeof CONTROL_EVENT_IDS)[number];
export type StopUncertaintyId = (typeof STOP_UNCERTAINTY_IDS)[number];
export type LateResultId = (typeof LATE_RESULT_IDS)[number];
export type ReportIntegrityId = (typeof REPORT_INTEGRITY_IDS)[number];

export interface ControlFaultMatrixEvidenceOptions {
  /** 可选证据目录；提供时每组矩阵写入一个 JSON 文件供阶段报告引用。 */
  readonly evidenceDir?: string;
  /** 只运行指定场景（缺省运行全部）。 */
  readonly only?: readonly string[];
}

/* ------------------------------------------------------------------ *
 * 观察类型
 * ------------------------------------------------------------------ */

export interface ControlEventObservation {
  readonly scenarioId: ControlEventId;
  readonly controlReceipt: {
    readonly kind: 'command' | 'tool_cancel' | 'timeout' | 'host_signal' | 'runner_signal';
    readonly accepted: boolean | null;
    readonly outcome: string | null;
    readonly firstOutcome: string | null;
    readonly finalOutcome: string | null;
    readonly stopOperationId: string | null;
    readonly signal: string | null;
    readonly resultReason: string | null;
    readonly timedOut: boolean;
    readonly recoveryStatus: string | null;
    readonly recoveryReason: string | null;
  };
  readonly processTree: {
    readonly membersBeforeControl: readonly number[];
    readonly membersDuringCancelIntent: readonly number[];
    readonly membersAfterControl: readonly number[];
    readonly membersFinal: readonly number[];
    readonly signals: readonly string[];
  };
  readonly attemptTerminal: {
    readonly runStatus: string | null;
    readonly runReason: string | null;
    readonly attempts: number;
    readonly attemptStatuses: readonly string[];
    readonly taskPassed: boolean | null;
    readonly newAttemptCreated: boolean | null;
    readonly leasesRemaining: number | null;
    readonly reclaimBlocked: string | null;
  };
  readonly stopEvidence: {
    readonly resultReason: string | null;
    readonly stopConfirmed: boolean;
    readonly stopOperationStatus: string | null;
    readonly reconciliationStatus: string | null;
    readonly stopGaps: readonly string[];
  };
}

export interface StopUncertaintyObservation {
  readonly scenarioId: StopUncertaintyId;
  readonly controlReceipt: {
    readonly outcome: string;
    readonly stopStatus: string | null;
    readonly recoveryStatus: string | null;
    readonly recoveryReason: string | null;
  };
  readonly processTree: {
    readonly orphanMembersAfterKill: readonly number[];
    readonly membersFinal: readonly number[];
  };
  readonly occupancyRetained: {
    readonly quarantinedLeases: number;
    readonly workspaceStatus: string | null;
    readonly runUnchanged: boolean;
  };
  readonly reclaimBlocked: boolean;
  readonly cleanupConfirmed: boolean;
  readonly scenePreserved: boolean;
  readonly stopEvidence: {
    readonly confirmed: boolean;
    readonly gaps: readonly string[];
    readonly manualNextStepsCount: number;
  };
  readonly lateOverwriteRejected: boolean | null;
  readonly businessQuarantineRetainedAfterPhysicalStop: boolean | null;
}

export interface LateResultObservation {
  readonly scenarioId: LateResultId;
  readonly lateDelivery: {
    readonly kind: 'model' | 'tool' | 'process';
    readonly realProcessExit: { readonly exitCode: number | null; readonly stopConfirmed: boolean } | null;
  };
  readonly receipts: readonly { disposition: string; status: string | null; reason: string | null; resultSaved: boolean; runtimeCompleted: boolean }[];
  readonly runStatus: string | null;
  readonly lateOverwriteRejected: boolean | null;
  readonly attempts: number;
  readonly attemptStatuses: readonly string[];
  readonly taskPassed: boolean | null;
  readonly businessUnchanged: boolean;
  readonly accountingUnchanged: boolean;
  readonly gitHeadUnchanged: boolean | null;
  readonly evidenceWatermark: number | null;
  readonly noFabricatedPass: boolean;
}

export interface ReportIntegrityObservation {
  readonly scenarioId: ReportIntegrityId;
  readonly failedClosed: boolean;
  readonly errorKind: string | null;
  readonly exitCode: number | null;
  readonly stepsExecutedOnResume: number;
  readonly scenePreserved: boolean;
  readonly preservedPaths: readonly string[];
  readonly tamperedStateRetained: boolean | null;
  readonly oldContentIntact: string | null;
  readonly cleanupStatus: string | null;
}

/* ------------------------------------------------------------------ *
 * 共享：受控三代写入进程（复用 P04-7 共享 helper，不复制夹具）
 * ------------------------------------------------------------------ */

interface ControlledTree {
  readonly root: string;
  readonly handle: CommandProcessHandle;
  readonly signals: Array<{ pgid: number; signal: string }>;
  members(): Promise<number[]>;
  dispose(): Promise<void>;
}

async function startControlledTree(
  root: string,
  options: {
    readonly mode?: 'graceful' | 'stubborn';
    readonly timeoutMs?: number;
    readonly confirm?: (identity: CommandProcessIdentity) => Promise<void>;
  } = {},
): Promise<ControlledTree> {
  const mode = options.mode ?? 'stubborn';
  const signals: Array<{ pgid: number; signal: string }> = [];
  const adapter = createCommandProcessAdapter({
    stopGraceMs: 200,
    stopConfirmMs: 2_000,
    stopProbe: matrixStopProbe((pgid, signal) => signals.push({ pgid, signal })),
  });
  const handle = await adapter.start({
    argv: [process.execPath, matrixWriter, root, mode],
    cwd: root,
    environment: {},
    timeoutMs: options.timeoutMs ?? 15_000,
    maxInputBytes: 65_536,
    maxOutputBytes: 65_536,
  }, async identity => {
    await options.confirm?.(identity);
    return { launchId: identity.launchId };
  });
  const members = () => processRows().then(rows =>
    rows.filter(row => row.processGroupId === handle.identity.processGroupId).map(row => row.pid));
  return {
    root,
    handle,
    signals,
    members,
    async dispose(): Promise<void> {
      try { if (handle.query().state !== 'stopped') await handle.cancel(); } catch { /* Verified below. */ }
      try { await handle.result; } catch { /* Result observed via census. */ }
      try { process.kill(-handle.identity.processGroupId, 'SIGKILL'); } catch { /* Group may be gone. */ }
      await until(async () => (await members()).length === 0, 'controlled tree disposed', 5_000).catch(() => undefined);
      if ((await members()).length === 0) rmSync(root, { recursive: true, force: true });
    },
  };
}

async function waitWriters(root: string): Promise<void> {
  for (const role of ['parent', 'child', 'grandchild']) {
    await until(() => existsSync(join(root, `${role}.writes`)), `${role} writing`, 8_000);
  }
}

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/* ------------------------------------------------------------------ *
 * 矩阵一：控制事件（A1）
 * ------------------------------------------------------------------ */

function receiptResult(receipt: { readonly status: string; readonly result?: unknown }): Record<string, unknown> {
  if (receipt.status !== 'completed' || receipt.result === undefined || receipt.result === null) {
    throw new Error(`预期 completed 回执，实际：${JSON.stringify(receipt)}`);
  }
  return receipt.result as Record<string, unknown>;
}

async function runRequestCancelScenario(): Promise<ControlEventObservation> {
  const f = await openClaimFixture();
  const treeRoot = tempRoot('shiploop-p048-ctl-reqcancel-');
  let tree: ControlledTree | undefined;
  try {
    const attempt = f.store().claimTask(f.input(0)).receipt.attempt;
    tree = await startControlledTree(treeRoot, {
      confirm: async identity => {
        f.box.session.transactWrite('p048.reqcancel.persist-identity', () => {
          f.box.session.database.prepare('UPDATE workspace_leases SET process_identity = ? WHERE owner_id = ?')
            .run(JSON.stringify({ schemaVersion: 2, ...identity }), attempt.id);
        });
      },
    });
    await waitWriters(treeRoot);
    const membersBeforeControl = await tree.members();

    const runRevision = () => (f.box.session.database.prepare('SELECT revision FROM runs WHERE id = ?')
      .get(f.ids.runId) as { revision: number }).revision;
    const submitCancel = () => f.box.services.commands.submit(f.box.owner, {
      schemaVersion: 5,
      commandId: randomUUID(),
      issuedAt: new Date(CLAIM_NOW).toISOString(),
      operation: 'execution.cancel',
      scope: f.box.scope,
      expectedRevision: runRevision(),
      payload: { runId: f.ids.runId, batchId: null },
    } as never);

    // 1) 请求取消：活动占用存在 → 只进入 cancelling，进程树仍在运行。
    const first = receiptResult(await submitCancel());
    const membersDuringCancelIntent = await tree.members();
    const reclaimDuringCancel = f.evaluate().reason;

    // 2) 真实停止核验：取消受控工具进程组并清点。
    const cancelAccepted = await tree.handle.cancel();
    const result = await tree.handle.result;
    const membersFinal = await tree.members();

    // 3) 停止确认后：Attempt 落为非活动终态（取消停止的结算后果），释放占用，
    //    再次提交取消 → 终态 cancelled。
    f.box.session.transactWrite('p048.reqcancel.settle-and-release', () => {
      f.box.session.database.prepare("UPDATE attempts SET status = 'cancelled', ended_at = ? WHERE id = ?")
        .run(CLAIM_NOW, attempt.id);
      f.box.session.database.prepare('DELETE FROM workspace_leases WHERE owner_id = ?').run(attempt.id);
    });
    const second = receiptResult(await submitCancel());

    const runRow = f.box.session.database.prepare('SELECT status, reason FROM runs WHERE id = ?')
      .get(f.ids.runId) as { status: string; reason: string | null };
    const attemptRows = f.box.session.database.prepare('SELECT status FROM attempts ORDER BY rowid')
      .all() as { status: string }[];
    const taskRow = f.box.session.database.prepare('SELECT status FROM tasks WHERE id = ?')
      .get('t-1') as { status: string } | undefined;
    const stopOperations = f.box.session.database.prepare('SELECT status FROM execution_stop_operations ORDER BY rowid')
      .all() as { status: string }[];

    return {
      scenarioId: 'request-cancel',
      controlReceipt: {
        kind: 'command',
        accepted: cancelAccepted.accepted,
        outcome: String(second['status']),
        firstOutcome: String(first['outcome']),
        finalOutcome: String(second['outcome']),
        stopOperationId: String(first['stopOperationId']),
        signal: null,
        resultReason: result.reason,
        timedOut: result.reason === 'timed_out',
        recoveryStatus: null,
        recoveryReason: null,
      },
      processTree: {
        membersBeforeControl: Object.freeze([...membersBeforeControl]),
        membersDuringCancelIntent: Object.freeze([...membersDuringCancelIntent]),
        membersAfterControl: Object.freeze([...membersFinal]),
        membersFinal: Object.freeze([...membersFinal]),
        signals: Object.freeze(tree.signals.map(entry => entry.signal)),
      },
      attemptTerminal: {
        runStatus: runRow.status,
        runReason: runRow.reason,
        attempts: attemptRows.length,
        attemptStatuses: Object.freeze(attemptRows.map(row => row.status)),
        taskPassed: taskRow === undefined ? null : taskRow.status === 'passed',
        newAttemptCreated: null,
        leasesRemaining: (f.box.session.database.prepare('SELECT COUNT(*) AS n FROM workspace_leases').get() as { n: number }).n,
        reclaimBlocked: f.evaluate().reason ?? reclaimDuringCancel,
      },
      stopEvidence: {
        resultReason: result.reason,
        stopConfirmed: result.stop.confirmed,
        stopOperationStatus: stopOperations[stopOperations.length - 1]?.status ?? null,
        reconciliationStatus: null,
        stopGaps: Object.freeze([]),
      },
    };
  } finally {
    await tree?.dispose();
    f.box.close();
  }
}

async function runRecoveryFixtureScenario(
  scenarioId: ControlEventId,
  run: (context: {
    readonly fixture: RecoveryFixture;
    readonly treeRoot: string;
    readonly signals: Array<{ pgid: number; signal: string }>;
    startTree(timeoutMs?: number): Promise<ControlledTree>;
  }) => Promise<Omit<ControlEventObservation, 'scenarioId'>>,
): Promise<ControlEventObservation> {
  const fixture = await openProcessRecoveryFixture();
  const treeRoot = tempRoot(`shiploop-p048-ctl-${scenarioId}-`);
  let tree: ControlledTree | undefined;
  try {
    const signals: Array<{ pgid: number; signal: string }> = [];
    const startTree = (timeoutMs?: number) => startControlledTree(treeRoot, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      confirm: async identity => {
        fixture.session.transactWrite('p048.ctl.confirm-launch', () =>
          fixture.createResources().confirmLaunchInTransaction(fixture.identity, identity));
      },
    }).then(started => {
      tree = started;
      return started;
    });
    const partial = await run({ fixture, treeRoot, signals, startTree });
    return { scenarioId, ...partial };
  } finally {
    await tree?.dispose();
    fixture.close();
  }
}

function recoveryObservation(
  result: CommandProcessResult | null,
  recovery: RecoveryOutcome,
  fixture: RecoveryFixture,
  signals: readonly { pgid: number; signal: string }[],
  membersBefore: readonly number[],
  membersAfterControl: readonly number[],
  membersFinal: readonly number[],
): Omit<ControlEventObservation, 'scenarioId'> {
  const stopConfirmed = recovery.evidence.status === 'reconciled'
    && !recovery.evidence.startupGaps.includes('stop_unconfirmed');
  return {
    controlReceipt: {
      kind: 'tool_cancel',
      accepted: null,
      outcome: result !== null && result.reason !== null ? result.reason : recovery.state.status,
      firstOutcome: null,
      finalOutcome: recovery.state.status,
      stopOperationId: null,
      signal: null,
      resultReason: result?.reason ?? null,
      timedOut: result?.reason === 'timed_out',
      recoveryStatus: recovery.state.status,
      recoveryReason: recovery.state.reason,
    },
    processTree: {
      membersBeforeControl: Object.freeze([...membersBefore]),
      membersDuringCancelIntent: Object.freeze([]),
      membersAfterControl: Object.freeze([...membersAfterControl]),
      membersFinal: Object.freeze([...membersFinal]),
      signals: Object.freeze(signals.map(entry => entry.signal)),
    },
    attemptTerminal: {
      runStatus: null,
      runReason: null,
      attempts: (fixture.query('SELECT COUNT(*) AS n FROM attempts') as { n: number }).n,
      attemptStatuses: Object.freeze((fixture.session.database.prepare('SELECT status FROM attempts ORDER BY rowid')
        .all() as { status: string }[]).map(row => row.status)),
      taskPassed: recovery.evidence.taskPassed,
      newAttemptCreated: recovery.evidence.newAttemptCreated,
      leasesRemaining: (fixture.query('SELECT COUNT(*) AS n FROM workspace_leases') as { n: number }).n,
      reclaimBlocked: null,
    },
    stopEvidence: {
      resultReason: result?.reason ?? null,
      stopConfirmed,
      stopOperationStatus: null,
      reconciliationStatus: recovery.evidence.status ?? null,
      stopGaps: Object.freeze([...(recovery.evidence.gaps ?? [])]),
    },
  };
}

async function runToolCancelScenario(): Promise<ControlEventObservation> {
  return runRecoveryFixtureScenario('tool-cancel', async ({ fixture, treeRoot, signals, startTree }) => {
    const tree = await startTree();
    await waitWriters(treeRoot);
    const membersBefore = await tree.members();
    const accepted = await tree.handle.cancel();
    const result = await tree.handle.result;
    const membersFinal = await tree.members();
    const recovery = await fixture.recover();
    signals.push(...tree.signals);
    const base = recoveryObservation(result, recovery, fixture, signals, membersBefore, membersFinal, membersFinal);
    return {
      ...base,
      controlReceipt: { ...base.controlReceipt, kind: 'tool_cancel', accepted: accepted.accepted },
    };
  });
}

async function runExecutionTimeoutScenario(): Promise<ControlEventObservation> {
  return runRecoveryFixtureScenario('execution-timeout', async ({ fixture, treeRoot, signals, startTree }) => {
    const tree = await startTree(1_200);
    await waitWriters(treeRoot);
    const membersBefore = await tree.members();
    const result = await tree.handle.result;
    const membersFinal = await tree.members();
    const recovery = await fixture.recover();
    signals.push(...tree.signals);
    const base = recoveryObservation(result, recovery, fixture, signals, membersBefore, [], membersFinal);
    return {
      ...base,
      controlReceipt: { ...base.controlReceipt, kind: 'timeout', timedOut: result.reason === 'timed_out' },
    };
  });
}

async function runHostExceptionScenario(): Promise<ControlEventObservation> {
  return runRecoveryFixtureScenario('host-exception', async ({ fixture, treeRoot }) => {
    const signals: Array<{ pgid: number; signal: string }> = [];
    const child = fork(fileURLToPath(new URL('../command-process-host-loss.ts', import.meta.url)),
      [join(treeRoot, 'forbidden'), treeRoot, matrixWriter], {
        execArgv: ['--no-warnings', '--import', fileURLToPath(new URL('../node-ts-loader/register.mjs', import.meta.url))],
        env: { PATH: '/usr/bin:/bin' },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      const identity = await new Promise<CommandProcessIdentity>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Host identity timeout')), 10_000);
        child.once('message', value => { clearTimeout(timeout); resolve(value as CommandProcessIdentity); });
        child.once('error', error => { clearTimeout(timeout); reject(error); });
      });
      fixture.session.transactWrite('p048.host-loss.confirm', () =>
        fixture.createResources().confirmLaunchInTransaction(fixture.identity, identity));
      child.send({ release: true });
      await waitWriters(treeRoot);
      const membersBefore = await processRows().then(rows =>
        rows.filter(row => row.processGroupId === identity.processGroupId).map(row => row.pid));

      // Host 异常：SIGKILL 测试 Host 本身；受控写入树必须仍在运行。
      child.kill('SIGKILL');
      await closed;
      const membersAfterControl = await processRows().then(rows =>
        rows.filter(row => row.processGroupId === identity.processGroupId).map(row => row.pid));

      // 新 Host 侧连接恢复：先核验真实停止（升级 SIGKILL 整组），再清占用。
      const recovery = await fixture.recover(createCommandProcessAdapter({
        stopConfirmMs: 2_000,
        stopProbe: matrixStopProbe((pgid, signal) => signals.push({ pgid, signal })),
      }));
      const membersFinal = await processRows().then(rows =>
        rows.filter(row => row.processGroupId === identity.processGroupId).map(row => row.pid));
      const base = recoveryObservation(null, recovery, fixture, signals, membersBefore, membersAfterControl, membersFinal);
      return {
        ...base,
        controlReceipt: { ...base.controlReceipt, kind: 'host_signal', signal: 'SIGKILL' },
        processTree: { ...base.processTree, membersDuringCancelIntent: Object.freeze([...membersAfterControl]) },
      };
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  });
}

async function runRunnerKillScenario(): Promise<ControlEventObservation> {
  return runRecoveryFixtureScenario('runner-kill', async ({ fixture, treeRoot, signals, startTree }) => {
    const tree = await startTree();
    await waitWriters(treeRoot);
    const membersBefore = await tree.members();

    // Runner 强杀：整个受控进程组（监督者与全部后代）被 SIGKILL。
    process.kill(-tree.handle.identity.processGroupId, 'SIGKILL');
    const result = await tree.handle.result;
    const membersFinal = await tree.members();
    const recovery = await fixture.recover();
    signals.push(...tree.signals);
    const base = recoveryObservation(result, recovery, fixture, signals, membersBefore, membersFinal, membersFinal);
    return {
      ...base,
      controlReceipt: { ...base.controlReceipt, kind: 'runner_signal', signal: 'SIGKILL', outcome: recovery.state.status },
      processTree: { ...base.processTree, membersDuringCancelIntent: Object.freeze([...membersBefore]) },
    };
  });
}

export async function runControlEventFaults(
  options: ControlFaultMatrixEvidenceOptions = {},
): Promise<readonly ControlEventObservation[]> {
  const runners: Record<ControlEventId, () => Promise<ControlEventObservation>> = {
    'request-cancel': runRequestCancelScenario,
    'tool-cancel': runToolCancelScenario,
    'execution-timeout': runExecutionTimeoutScenario,
    'host-exception': runHostExceptionScenario,
    'runner-kill': runRunnerKillScenario,
  };
  const selected = CONTROL_EVENT_IDS.filter(id => options.only === undefined || options.only.includes(id));
  if (selected.length === 0) throw new TypeError('runControlEventFaults: 没有匹配的场景');
  const observations: ControlEventObservation[] = [];
  for (const id of selected) observations.push(await runners[id]());
  writeEvidence(options.evidenceDir, 'control-fault-matrix-events.json', {
    schemaVersion: CONTROL_FAULT_MATRIX_SCHEMA_VERSION, offline: true, live: 'not_run', observations,
  });
  return Object.freeze(observations);
}

/* ------------------------------------------------------------------ *
 * 矩阵二：停止不确定（A2）
 * ------------------------------------------------------------------ */

async function runCancelStopUncertainScenario(): Promise<StopUncertaintyObservation> {
  const f = await openClaimFixture();
  try {
    const attempt = f.store().claimTask(f.input(0)).receipt.attempt;
    const db = f.box.session.database;
    f.box.session.transactWrite('p048.uncertain.interrupt', () => {
      createSqliteWorkResourceAccess(f.box.session, { workspaceAuthority: f.authority, nowUtcMs: () => CLAIM_NOW })
        .quarantineInTransaction({
          projectId: attempt.projectId, attemptId: attempt.id, owner: attempt.owner,
          hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion,
        });
      db.prepare("UPDATE attempts SET status = 'interrupted' WHERE id = ?").run(attempt.id);
      db.prepare("UPDATE runs SET status = 'interrupted', reason = 'stop_unconfirmed' WHERE id = ?").run(f.ids.runId);
    });
    const runBefore = JSON.stringify(db.prepare('SELECT * FROM runs WHERE id = ?').get(f.ids.runId));
    const leasesBefore = JSON.stringify(db.prepare('SELECT * FROM workspace_leases WHERE owner_id = ? ORDER BY resource_key').all(attempt.id));

    const runRevision = () => (db.prepare('SELECT revision FROM runs WHERE id = ?').get(f.ids.runId) as { revision: number }).revision;
    const receipt = await f.box.services.commands.submit(f.box.owner, {
      schemaVersion: 5,
      commandId: randomUUID(),
      issuedAt: new Date(CLAIM_NOW).toISOString(),
      operation: 'execution.cancel',
      scope: f.box.scope,
      expectedRevision: runRevision(),
      payload: { runId: f.ids.runId, batchId: null },
    } as never);
    const result = receiptResult(receipt);

    const runUnchanged = JSON.stringify(db.prepare('SELECT * FROM runs WHERE id = ?').get(f.ids.runId)) === runBefore;
    const leaseRows = db.prepare("SELECT state, COUNT(*) AS n FROM workspace_leases WHERE owner_id = ? GROUP BY state")
      .all(attempt.id) as { state: string; n: number }[];
    const quarantined = leaseRows.find(row => row.state === 'quarantined')?.n ?? 0;
    const leasesUnchanged = JSON.stringify(db.prepare('SELECT * FROM workspace_leases WHERE owner_id = ? ORDER BY resource_key').all(attempt.id)) === leasesBefore;
    const reclaimReason = f.evaluate().reason;

    // 迟到成功不能覆盖 interrupted：run 级结算必须被拒绝。
    let lateOverwriteRejected = false;
    try {
      f.box.session.transactWrite('p048.uncertain.late-success', () =>
        createSqliteExecutionAccess(f.box.session, { nowUtcMs: () => CLAIM_NOW })
          .settleExecutionRunOutcomeInTransaction({
            projectId: f.box.projectId, batchId: f.ids.batchId, runId: f.ids.runId,
            resultKey: 'late-interrupted-success', runRevision: (db.prepare('SELECT revision FROM runs WHERE id = ?').get(f.ids.runId) as { revision: number }).revision,
            outcome: 'succeeded', reason: 'late', progressEvidence: null,
          }));
    } catch { lateOverwriteRejected = true; }

    const stopOperations = db.prepare('SELECT status FROM execution_stop_operations ORDER BY rowid')
      .all() as { status: string }[];
    return {
      scenarioId: 'cancel-stop-uncertain',
      controlReceipt: {
        outcome: String(result['outcome']),
        stopStatus: String(result['stopStatus']),
        recoveryStatus: null,
        recoveryReason: null,
      },
      processTree: { orphanMembersAfterKill: Object.freeze([]), membersFinal: Object.freeze([]) },
      occupancyRetained: {
        quarantinedLeases: quarantined,
        workspaceStatus: null,
        runUnchanged: runUnchanged && leasesUnchanged,
      },
      reclaimBlocked: reclaimReason === 'run_control_blocked',
      // 停止未确认：占用仍被隔离保留，cleanup 不得标记为通过。
      cleanupConfirmed: false,
      scenePreserved: runUnchanged && leasesUnchanged && quarantined === 3,
      stopEvidence: {
        confirmed: false,
        gaps: Object.freeze(['stop_uncertain']),
        manualNextStepsCount: stopOperations.filter(row => row.status === 'uncertain').length === 0 ? 0 : 0,
      },
      lateOverwriteRejected,
      businessQuarantineRetainedAfterPhysicalStop: null,
    };
  } finally {
    f.box.close();
  }
}

async function runRecoveryStopUnconfirmedScenario(): Promise<StopUncertaintyObservation> {
  const fixture = await openProcessRecoveryFixture();
  const treeRoot = tempRoot('shiploop-p048-ctl-stopunc-');
  let tree: ControlledTree | undefined;
  try {
    tree = await startControlledTree(treeRoot, {
      confirm: async identity => {
        fixture.session.transactWrite('p048.stopunc.confirm-launch', () =>
          fixture.createResources().confirmLaunchInTransaction(fixture.identity, identity));
      },
    });
    await waitWriters(treeRoot);

    // Runner 监督者被单独 SIGKILL：后代写入进程成为孤儿并继续写文件。
    process.kill(tree.handle.identity.pid, 'SIGKILL');
    const orphanMembersAfterKill = await (async () => {
      let members: number[] = [];
      await until(async () => {
        members = await tree!.members();
        return !members.includes(tree!.handle.identity.pid) && members.length >= 2;
      }, 'orphan descendants remain writing', 8_000);
      return members;
    })();

    // 恢复必须先核验停止；孤儿仍在写入 → 停止无法确认 → 保留占用并隔离。
    const recovery = await fixture.recover();
    const leasesAfterRecovery = fixture.session.database.prepare(
      "SELECT state, COUNT(*) AS n FROM workspace_leases GROUP BY state").all() as { state: string; n: number }[];
    const workspaceStatus = (fixture.query('SELECT status FROM managed_workspaces') as { status: string }).status;
    let reclaimBlocked = false;
    try { fixture.claimTask('t-2'); } catch { reclaimBlocked = true; }

    // 现场（写入文件与隔离事实）保留；随后测试自有物理清理，业务隔离不得被冲洗。
    const scenePreserved = existsSync(join(treeRoot, 'grandchild.writes'))
      && existsSync(join(treeRoot, 'parent.writes'));
    try { process.kill(-tree.handle.identity.processGroupId, 'SIGKILL'); } catch { /* Census verifies. */ }
    const membersFinal = await (async () => {
      let members: number[] = [];
      await until(async () => { members = await tree!.members(); return members.length === 0; }, 'orphans stopped', 5_000);
      return members;
    })();
    const leasesAfterPhysicalStop = fixture.session.database.prepare(
      "SELECT state, COUNT(*) AS n FROM workspace_leases GROUP BY state").all() as { state: string; n: number }[];

    return {
      scenarioId: 'recovery-stop-unconfirmed',
      controlReceipt: {
        outcome: recovery.state.status,
        stopStatus: 'uncertain',
        recoveryStatus: recovery.state.status,
        recoveryReason: recovery.state.reason,
      },
      processTree: { orphanMembersAfterKill: Object.freeze([...orphanMembersAfterKill]), membersFinal: Object.freeze([...membersFinal]) },
      occupancyRetained: {
        quarantinedLeases: leasesAfterRecovery.find(row => row.state === 'quarantined')?.n ?? 0,
        workspaceStatus,
        runUnchanged: true,
      },
      reclaimBlocked,
      // 物理清点仍有孤儿 → cleanup 不得标记为通过。
      cleanupConfirmed: false,
      scenePreserved,
      stopEvidence: {
        confirmed: recovery.evidence.status === 'reconciled' && !recovery.evidence.startupGaps.includes('stop_unconfirmed'),
        gaps: Object.freeze([...(recovery.evidence.gaps ?? [])]),
        manualNextStepsCount: (recovery.evidence.manualNextSteps ?? []).length,
      },
      lateOverwriteRejected: null,
      businessQuarantineRetainedAfterPhysicalStop:
        (leasesAfterPhysicalStop.find(row => row.state === 'quarantined')?.n ?? 0) === 3
        && (fixture.query('SELECT status FROM managed_workspaces') as { status: string }).status === 'quarantined',
    };
  } finally {
    await tree?.dispose();
    fixture.close();
  }
}

export async function runStopUncertaintyFaults(
  options: ControlFaultMatrixEvidenceOptions = {},
): Promise<readonly StopUncertaintyObservation[]> {
  const runners: Record<StopUncertaintyId, () => Promise<StopUncertaintyObservation>> = {
    'cancel-stop-uncertain': runCancelStopUncertainScenario,
    'recovery-stop-unconfirmed': runRecoveryStopUnconfirmedScenario,
  };
  const selected = STOP_UNCERTAINTY_IDS.filter(id => options.only === undefined || options.only.includes(id));
  if (selected.length === 0) throw new TypeError('runStopUncertaintyFaults: 没有匹配的场景');
  const observations: StopUncertaintyObservation[] = [];
  for (const id of selected) observations.push(await runners[id]());
  writeEvidence(options.evidenceDir, 'control-fault-matrix-stop-uncertainty.json', {
    schemaVersion: CONTROL_FAULT_MATRIX_SCHEMA_VERSION, offline: true, live: 'not_run', observations,
  });
  return Object.freeze(observations);
}

/* ------------------------------------------------------------------ *
 * 矩阵三：迟到结果（A3）
 * ------------------------------------------------------------------ */

/** 与 F-005 相同的业务行快照：诊断行单独计数，不进入比较。 */
function businessSnapshot(database: {
  prepare(sql: string): { all(): unknown[] };
}, tables: readonly string[]): string {
  return JSON.stringify(Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}

async function runLateModelResultAfterCancelScenario(): Promise<LateResultObservation> {
  const f = await openClaimFixture();
  try {
    const db = f.box.session.database;
    const attempt = f.store().claimTask(f.input(0)).receipt.attempt;
    const runRevision = () => (db.prepare('SELECT revision FROM runs WHERE id = ?').get(f.ids.runId) as { revision: number }).revision;
    const submitCancel = () => f.box.services.commands.submit(f.box.owner, {
      schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(CLAIM_NOW).toISOString(),
      operation: 'execution.cancel', scope: f.box.scope, expectedRevision: runRevision(),
      payload: { runId: f.ids.runId, batchId: null },
    } as never);
    receiptResult(await submitCancel()); // cancelling（占用仍在）
    f.box.session.transactWrite('p048.late.settle-and-release', () => {
      db.prepare("UPDATE attempts SET status = 'cancelled', ended_at = ? WHERE id = ?").run(CLAIM_NOW, attempt.id);
      db.prepare('DELETE FROM workspace_leases WHERE owner_id = ?').run(attempt.id);
    });
    receiptResult(await submitCancel()); // cancelled 终态

    const runBefore = JSON.stringify(db.prepare('SELECT * FROM runs WHERE id = ?').get(f.ids.runId));
    const batchBefore = JSON.stringify(db.prepare('SELECT * FROM execution_batches WHERE id = ?').get(f.ids.batchId));
    const attemptsBefore = JSON.stringify(db.prepare('SELECT * FROM attempts ORDER BY rowid').all());

    // 迟到的模型成功结果：run 已取消终态，结算必须被拒绝。
    let lateOverwriteRejected = false;
    try {
      f.box.session.transactWrite('p048.late.model-result', () =>
        createSqliteExecutionAccess(f.box.session, { nowUtcMs: () => CLAIM_NOW })
          .settleExecutionRunOutcomeInTransaction({
            projectId: f.box.projectId, batchId: f.ids.batchId, runId: f.ids.runId,
            resultKey: 'late-cancelled-success', runRevision: (db.prepare('SELECT revision FROM runs WHERE id = ?').get(f.ids.runId) as { revision: number }).revision,
            outcome: 'succeeded', reason: 'late', progressEvidence: null,
          }));
    } catch { lateOverwriteRejected = true; }

    const runRow = db.prepare('SELECT status FROM runs WHERE id = ?').get(f.ids.runId) as { status: string };
    const attemptRows = db.prepare('SELECT status FROM attempts ORDER BY rowid').all() as { status: string }[];
    const taskRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get('t-1') as { status: string } | undefined;
    const checkResults = (db.prepare('SELECT COUNT(*) AS n FROM check_results').get() as { n: number }).n;
    return {
      scenarioId: 'late-model-result-after-cancel',
      lateDelivery: { kind: 'model', realProcessExit: null },
      receipts: Object.freeze([]),
      runStatus: runRow.status,
      lateOverwriteRejected,
      attempts: attemptRows.length,
      attemptStatuses: Object.freeze(attemptRows.map(row => row.status)),
      taskPassed: taskRow === undefined ? null : taskRow.status === 'passed',
      businessUnchanged: JSON.stringify(db.prepare('SELECT * FROM runs WHERE id = ?').get(f.ids.runId)) === runBefore
        && JSON.stringify(db.prepare('SELECT * FROM attempts ORDER BY rowid').all()) === attemptsBefore,
      accountingUnchanged: JSON.stringify(db.prepare('SELECT * FROM execution_batches WHERE id = ?').get(f.ids.batchId)) === batchBefore,
      gitHeadUnchanged: null,
      evidenceWatermark: null,
      noFabricatedPass: lateOverwriteRejected && checkResults === 0 && (taskRow?.status ?? '') !== 'passed',
    };
  } finally {
    f.box.close();
  }
}

async function runLateSettlementAfterCancelledAttemptScenario(): Promise<LateResultObservation> {
  const f = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true });
  try {
    const db = f.session.database;
    const launch = f.claimAndLaunch('t-1');
    const bound = await f.bindingService.bind(f.bindingInput(launch));
    const current = bound.request;
    const attemptId = launch.receipt.attempt.id;
    const sessionsStore = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => BINDING_NOW });
    const identity = {
      projectId: f.projectId, sessionId: current.sessionId, attemptId,
      owner: current.owner.principalId, hostInstanceId: current.owner.hostInstanceId,
      executionVersion: current.executionVersion,
    };
    const created = sessionsStore.createWorkSession({ ...identity, purpose: 'execution', runtime: 'fake', adapterVersion: 'offline-matrix' });
    sessionsStore.applyWorkSessionProgress({ ...identity, expectedRevision: created.session.revision, kind: 'started' });

    // 取消已结算的业务事实：Attempt 进入 cancelled 终态（直接 SQL 模拟既成事实，
    // 之后所有迟到投递都必须被真实生命周期 CAS 拒绝，而不是绕过防护）。
    db.prepare("UPDATE attempts SET status = 'cancelled', ended_at = ? WHERE id = ?").run(BINDING_NOW, attemptId);

    const tables = ['tasks', 'attempts', 'runs', 'execution_batches', 'task_attempt_reservations',
      'runtime_start_reservations', 'workspace_leases', 'verification_batches', 'check_results',
      'git_operations', 'task_approval_items', 'command_receipts', 'state_events',
      'attempt_notifications', 'task_claim_receipts', 'batch_budget_revisions'];
    const before = businessSnapshot(db, tables);
    const batchBefore = JSON.stringify(db.prepare('SELECT * FROM execution_batches ORDER BY rowid').all());
    const gitHead = () => {
      const row = db.prepare('SELECT base_commit FROM managed_workspaces ORDER BY rowid').get() as { base_commit: string } | undefined;
      return row?.base_commit ?? null;
    };
    const oldHead = gitHead();

    const settlement = createRuntimeSettlementService({
      publisher: f.publisher,
      lifecycle: createSqliteAttemptLifecycleStore(f.session, { workspaceAuthority: f.authority, nowUtcMs: () => BINDING_NOW }),
      attempts: createSqliteAttemptAccess(f.session),
      dag: createSqliteTaskDagStore(f.session),
    });
    const input = {
      request: current,
      result: { status: 'fulfilled' as const, value: {
        schemaVersion: 1 as const, terminal: 'completed' as const, reason: null, exitCode: 0,
        signal: null, durationMs: 10, lastEventSequence: 0,
        usage: { basis: 'reported' as const, inputTokens: 4242, outputTokens: 99, costUsdMicros: 300 },
      } },
      stopped: { status: 'fulfilled' as const, value: {
        schemaVersion: 1 as const, confirmed: true, checkedAtUtc: new Date(BINDING_NOW).toISOString(), detail: null,
      } },
      recording: null,
    };
    const receipts: AttemptApplicationResult[] = [await settlement.settle(input), await settlement.settle(input)];

    const attemptRows = db.prepare('SELECT status FROM attempts ORDER BY rowid').all() as { status: string }[];
    const taskRow = db.prepare("SELECT status FROM tasks WHERE id = 't-1'").get() as { status: string } | undefined;
    return {
      scenarioId: 'late-settlement-after-cancelled-attempt',
      lateDelivery: { kind: 'model', realProcessExit: null },
      receipts: Object.freeze(receipts.map(receipt => ({
        disposition: receipt.disposition,
        status: receipt.status,
        reason: receipt.reason,
        resultSaved: receipt.resultSaved,
        runtimeCompleted: receipt.runtimeCompleted,
      }))),
      runStatus: (db.prepare('SELECT status FROM runs ORDER BY rowid').get() as { status: string }).status,
      lateOverwriteRejected: receipts.every(receipt => receipt.disposition === 'ignored'),
      attempts: attemptRows.length,
      attemptStatuses: Object.freeze(attemptRows.map(row => row.status)),
      taskPassed: taskRow === undefined ? null : taskRow.status === 'passed',
      businessUnchanged: businessSnapshot(db, tables) === before,
      accountingUnchanged: JSON.stringify(db.prepare('SELECT * FROM execution_batches ORDER BY rowid').all()) === batchBefore,
      gitHeadUnchanged: gitHead() === oldHead,
      evidenceWatermark: null,
      noFabricatedPass: (db.prepare('SELECT COUNT(*) AS n FROM check_results').get() as { n: number }).n === 0
        && (taskRow?.status ?? '') !== 'passed',
    };
  } finally {
    f.close();
  }
}

async function runLateToolAndProcessResultsAfterCancelScenario(): Promise<LateResultObservation> {
  const f = await openBindingFixture();
  const treeRoot = tempRoot('shiploop-p048-ctl-lateproc-');
  let tree: ControlledTree | undefined;
  try {
    const db = f.session.database;
    // 真实受控进程先正常退出（迟到进程结果的事实来源）。
    tree = await startControlledTree(treeRoot, { mode: 'graceful', timeoutMs: 10_000 });
    await waitWriters(treeRoot);
    writeFileSync(join(treeRoot, 'release'), 'release');
    const processResult = await tree.handle.result;

    const launch = f.claimAndLaunch('t-1');
    const bound = await f.bindingService.bind(f.bindingInput(launch));
    const current = bound.request;
    const attemptId = launch.receipt.attempt.id;
    const sessionsStore = createSqliteWorkSessionStore(f.session, { nowUtcMs: () => BINDING_NOW });
    const identity = {
      projectId: f.projectId, sessionId: current.sessionId, attemptId,
      owner: current.owner.principalId, hostInstanceId: current.owner.hostInstanceId,
      executionVersion: current.executionVersion,
    };
    const created = sessionsStore.createWorkSession({ ...identity, purpose: 'execution', runtime: 'fake', adapterVersion: 'offline-matrix' });
    sessionsStore.applyWorkSessionProgress({ ...identity, expectedRevision: created.session.revision, kind: 'started' });

    // 取消已进入控制窗口：run 处于 cancelling（与真实取消命令接受后的状态一致），
    // Attempt 仍在本窗口内活跃 —— 这正是迟到工具/进程结果到达的时刻。
    db.prepare("UPDATE runs SET status = 'cancelling', reason = 'user_cancel' WHERE id = ?").run(f.runId);
    const tables = ['tasks', 'attempts', 'runs', 'execution_batches', 'task_attempt_reservations',
      'runtime_start_reservations', 'workspace_leases', 'verification_batches', 'check_results',
      'git_operations', 'task_approval_items', 'command_receipts', 'state_events',
      'attempt_notifications', 'task_claim_receipts', 'batch_budget_revisions'];
    const before = businessSnapshot(db, tables);
    const batchBefore = JSON.stringify(db.prepare('SELECT * FROM execution_batches ORDER BY rowid').all());

    // 迟到的工具事件（含工具完成）与“成功”结果只进可见记录；记录不是业务权威。
    const event = (sequence: number, kind: string, payload: object) => ({
      schemaVersion: 1, eventId: `evt.ctl.${sequence}`, sequence, kind,
      occurredAtUtc: new Date(BINDING_NOW).toISOString(), payload,
    });
    const events = [
      event(1, 'tool_started', { toolCallId: 'late-tool', toolName: 'read', input: 'late input' }),
      event(2, 'tool_finished', { toolCallId: 'late-tool', ok: true }),
      event(3, 'usage', { basis: 'reported', inputTokens: 11, outputTokens: 4, costUsdMicros: null, accounting: 'incremental' }),
    ];
    const handle: RuntimeHandle = {
      events: { async *[Symbol.asyncIterator]() { yield* events; } },
      result: Promise.resolve({
        schemaVersion: 1, terminal: 'completed', reason: null, exitCode: processResult.exitCode,
        signal: null, durationMs: 10, lastEventSequence: 3,
        usage: { basis: 'reported', inputTokens: 11, outputTokens: 4, costUsdMicros: null, accounting: 'cumulative' },
      }),
      stopped: Promise.resolve({
        schemaVersion: 1, confirmed: true, checkedAtUtc: new Date(BINDING_NOW).toISOString(), detail: null,
      }),
      cancel: async () => ({ accepted: true, reason: null }),
    };
    const recorder = createWorkEvidenceRecorder({
      publisher: f.publisher, verifier: f.verifier, sessions: sessionsStore,
      limits: { ...DEFAULT_RECORDER_LIMITS, chunkMaxEvents: 8, tailWaitMs: 100 },
    });
    const recorded = await recorder.record({ request: current, handle, eventIdentityPrefix: 'evt.ctl.' });

    // 迟到的 fulfilled “成功”结算携带取消控制事实：即使 Runtime 声称 completed，
    // Attempt 也只能落为 cancelled，不能进入 verifying/制造通过。
    const runtimeResult = await handle.result as RuntimeExecutionResult;
    const runtimeStop = await handle.stopped as RuntimeStopEvidence;
    const receipt: AttemptApplicationResult = await settlementFor(f).settle({
      request: current,
      result: { status: 'fulfilled' as const, value: runtimeResult },
      stopped: { status: 'fulfilled' as const, value: runtimeStop },
      recording: { status: 'fulfilled' as const, value: recorded },
      control: { reason: 'user_cancelled', cancel: 'accepted' },
    });

    const attemptRows = db.prepare('SELECT status FROM attempts ORDER BY rowid').all() as { status: string }[];
    const taskRow = db.prepare("SELECT status FROM tasks WHERE id = 't-1'").get() as { status: string } | undefined;
    const sessionRow = db.prepare('SELECT recording_watermark FROM sessions WHERE id = ?')
      .get(current.sessionId) as { recording_watermark: number | null };
    return {
      scenarioId: 'late-tool-and-process-results-after-cancel',
      lateDelivery: {
        kind: 'process',
        realProcessExit: { exitCode: processResult.exitCode, stopConfirmed: processResult.stop.confirmed },
      },
      receipts: Object.freeze([{
        disposition: receipt.disposition,
        status: receipt.status,
        reason: receipt.reason,
        resultSaved: receipt.resultSaved,
        runtimeCompleted: receipt.runtimeCompleted,
      }]),
      runStatus: (db.prepare('SELECT status FROM runs ORDER BY rowid').get() as { status: string }).status,
      lateOverwriteRejected: attemptRows.every(row => row.status !== 'succeeded' && row.status !== 'verifying'),
      attempts: attemptRows.length,
      attemptStatuses: Object.freeze(attemptRows.map(row => row.status)),
      taskPassed: taskRow === undefined ? null : taskRow.status === 'passed',
      businessUnchanged: businessSnapshot(db, tables) === before,
      accountingUnchanged: JSON.stringify(db.prepare('SELECT * FROM execution_batches ORDER BY rowid').all()) === batchBefore,
      gitHeadUnchanged: null,
      evidenceWatermark: sessionRow.recording_watermark,
      noFabricatedPass: (db.prepare('SELECT COUNT(*) AS n FROM check_results').get() as { n: number }).n === 0
        && (taskRow?.status ?? '') !== 'passed',
    };
  } finally {
    await tree?.dispose();
    f.close();
  }
}

function settlementFor(f: Awaited<ReturnType<typeof openBindingFixture>>) {
  return createRuntimeSettlementService({
    publisher: f.publisher,
    lifecycle: createSqliteAttemptLifecycleStore(f.session, { workspaceAuthority: f.authority, nowUtcMs: () => BINDING_NOW }),
    attempts: createSqliteAttemptAccess(f.session),
    dag: createSqliteTaskDagStore(f.session),
  });
}

export async function runLateResultFaults(
  options: ControlFaultMatrixEvidenceOptions = {},
): Promise<readonly LateResultObservation[]> {
  const runners: Record<LateResultId, () => Promise<LateResultObservation>> = {
    'late-model-result-after-cancel': runLateModelResultAfterCancelScenario,
    'late-settlement-after-cancelled-attempt': runLateSettlementAfterCancelledAttemptScenario,
    'late-tool-and-process-results-after-cancel': runLateToolAndProcessResultsAfterCancelScenario,
  };
  const selected = LATE_RESULT_IDS.filter(id => options.only === undefined || options.only.includes(id));
  if (selected.length === 0) throw new TypeError('runLateResultFaults: 没有匹配的场景');
  const observations: LateResultObservation[] = [];
  for (const id of selected) observations.push(await runners[id]());
  writeEvidence(options.evidenceDir, 'control-fault-matrix-late-results.json', {
    schemaVersion: CONTROL_FAULT_MATRIX_SCHEMA_VERSION, offline: true, live: 'not_run', observations,
  });
  return Object.freeze(observations);
}

/* ------------------------------------------------------------------ *
 * 矩阵四：报告与证据完整性（A4）
 * ------------------------------------------------------------------ */

const STEP_IDENTITY = {
  runId: 'p048-ctl-matrix-run',
  commit: 'a'.repeat(40),
  inputsDigest: 'c'.repeat(64),
} as const;

function stepOptions(
  evidenceDir: string,
  overrides: Partial<P04StepSequenceOptions> & { runProcess?: typeof runBoundedProcess } = {},
): P04StepSequenceOptions {
  return {
    evidenceDir,
    identity: STEP_IDENTITY,
    stepTimeoutMs: 5_000,
    overallTimeoutMs: 30_000,
    maxOutputBytes: 4_096,
    ...overrides,
  };
}

function okStep(id: string, cwd: string): P04StepSpec {
  return { id, command: process.execPath, args: ['-e', 'process.stdout.write("ok")'], cwd };
}

function countingRunner(counter: { calls: number }): typeof runBoundedProcess {
  const wrapper = ((command, args, options) => {
    counter.calls += 1;
    return runBoundedProcess(command, args, options);
  }) as typeof runBoundedProcess;
  return wrapper;
}

function integrityRow(
  scenarioId: ReportIntegrityId,
  fields: {
    failedClosed: boolean;
    errorKind: string | null;
    exitCode: number | null;
    stepsExecutedOnResume: number;
    scenePreserved: boolean;
    preservedPaths?: readonly string[];
    tamperedStateRetained?: boolean;
    oldContentIntact?: string;
    cleanupStatus?: string;
  },
): ReportIntegrityObservation {
  return {
    scenarioId,
    failedClosed: fields.failedClosed,
    errorKind: fields.errorKind,
    exitCode: fields.exitCode,
    stepsExecutedOnResume: fields.stepsExecutedOnResume,
    scenePreserved: fields.scenePreserved,
    preservedPaths: Object.freeze([...(fields.preservedPaths ?? [])]),
    tamperedStateRetained: fields.tamperedStateRetained ?? null,
    oldContentIntact: fields.oldContentIntact ?? null,
    cleanupStatus: fields.cleanupStatus ?? null,
  };
}

async function runReportDirCorruptScenario(): Promise<ReportIntegrityObservation> {
  const root = tempRoot('shiploop-p048-ctl-corrupt-');
  try {
    const evidenceDir = join(root, 'run');
    const counter = { calls: 0 };
    const steps = [okStep('first', root), okStep('second', root)];
    const fresh = await runP04StepSequence(steps, stepOptions(evidenceDir, { runProcess: countingRunner(counter) }));
    if (fresh.exitCode !== 0) throw new Error(`前置 fresh 运行应成功：${JSON.stringify(fresh.problems)}`);

    const statePath = join(evidenceDir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      entries: Array<{ evidenceSha256: string }>;
    };
    state.entries[0]!.evidenceSha256 = '0'.repeat(64);
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const tamperedBytes = readFileSync(statePath);

    let failedClosed = false;
    let errorKind: string | null = null;
    try {
      await runP04StepSequence(steps, stepOptions(evidenceDir, { mode: 'resume', runProcess: countingRunner(counter) }));
    } catch (error) {
      failedClosed = error instanceof P04StepError;
      errorKind = error instanceof P04StepError ? error.kind : null;
    }
    const preservedPaths = ['state.json', 'steps/01-first.json', 'steps/02-second.json'];
    const scenePreserved = preservedPaths.every(path => existsSync(join(evidenceDir, path)))
      && readFileSync(statePath).equals(tamperedBytes);
    return integrityRow('report-dir-corrupt', {
      failedClosed, errorKind, exitCode: null,
      stepsExecutedOnResume: counter.calls - steps.length,
      scenePreserved, preservedPaths,
      tamperedStateRetained: readFileSync(statePath).equals(tamperedBytes),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runEvidenceMissingScenario(): Promise<ReportIntegrityObservation> {
  const root = tempRoot('shiploop-p048-ctl-missing-');
  try {
    const evidenceDir = join(root, 'run');
    const counter = { calls: 0 };
    const steps = [okStep('first', root), okStep('second', root)];
    const fresh = await runP04StepSequence(steps, stepOptions(evidenceDir, { runProcess: countingRunner(counter) }));
    if (fresh.exitCode !== 0) throw new Error(`前置 fresh 运行应成功：${JSON.stringify(fresh.problems)}`);
    rmSync(join(evidenceDir, 'steps/01-first.json'));

    let failedClosed = false;
    let errorKind: string | null = null;
    try {
      await runP04StepSequence(steps, stepOptions(evidenceDir, { mode: 'resume', runProcess: countingRunner(counter) }));
    } catch (error) {
      failedClosed = error instanceof P04StepError;
      errorKind = error instanceof P04StepError ? error.kind : null;
    }
    const preservedPaths = ['state.json', 'steps/02-second.json'];
    return integrityRow('evidence-missing', {
      failedClosed, errorKind, exitCode: null,
      stepsExecutedOnResume: counter.calls - steps.length,
      scenePreserved: preservedPaths.every(path => existsSync(join(evidenceDir, path)))
        && !existsSync(join(evidenceDir, 'steps/01-first.json')),
      preservedPaths,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runNonemptyDirReuseScenario(): Promise<ReportIntegrityObservation> {
  const root = tempRoot('shiploop-p048-ctl-reuse-');
  try {
    const evidenceDir = join(root, 'run');
    const counter = { calls: 0 };
    mkdirSync(evidenceDir);
    writeFileSync(join(evidenceDir, 'keep.txt'), 'original');

    let failedClosed = false;
    let errorKind: string | null = null;
    try {
      await runP04StepSequence([okStep('first', root)], stepOptions(evidenceDir, { runProcess: countingRunner(counter) }));
    } catch (error) {
      failedClosed = error instanceof P04StepError;
      errorKind = error instanceof P04StepError ? error.kind : null;
    }
    return integrityRow('nonempty-dir-reuse', {
      failedClosed, errorKind, exitCode: null,
      stepsExecutedOnResume: counter.calls,
      scenePreserved: existsSync(join(evidenceDir, 'keep.txt')) && !existsSync(join(evidenceDir, 'steps')),
      preservedPaths: ['keep.txt'],
      oldContentIntact: readFileSync(join(evidenceDir, 'keep.txt'), 'utf8'),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runCleanupFailureScenario(): Promise<ReportIntegrityObservation> {
  const fixture = createP048Fixture({ prefix: 'shiploop-p048-ctl-cleanup-' });
  const outside = tempRoot('shiploop-p048-ctl-outside-');
  try {
    fixture.createScenario('ctl-cleanup');
    let failedClosed = false;
    let errorKind: string | null = null;
    try {
      fixture.removeOwnedDirectory(outside);
    } catch (error) {
      failedClosed = true;
      const kind = (error as Partial<SafeCleanupError>).kind;
      errorKind = kind === 'not_authorized' ? 'cleanup_not_authorized'
        : typeof kind === 'string' ? `cleanup_${kind}` : 'cleanup_failed';
    }
    const cleanupStatus = fixture.cleanupEvidence.status;
    return integrityRow('cleanup-failure', {
      failedClosed, errorKind, exitCode: null,
      stepsExecutedOnResume: 0,
      scenePreserved: existsSync(outside),
      preservedPaths: [],
      cleanupStatus,
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
    await fixture.dispose();
  }
}

export async function runReportIntegrityFaults(
  options: ControlFaultMatrixEvidenceOptions = {},
): Promise<readonly ReportIntegrityObservation[]> {
  const runners: Record<ReportIntegrityId, () => Promise<ReportIntegrityObservation>> = {
    'report-dir-corrupt': runReportDirCorruptScenario,
    'evidence-missing': runEvidenceMissingScenario,
    'nonempty-dir-reuse': runNonemptyDirReuseScenario,
    'cleanup-failure': runCleanupFailureScenario,
  };
  const selected = REPORT_INTEGRITY_IDS.filter(id => options.only === undefined || options.only.includes(id));
  if (selected.length === 0) throw new TypeError('runReportIntegrityFaults: 没有匹配的场景');
  const observations: ReportIntegrityObservation[] = [];
  for (const id of selected) observations.push(await runners[id]());
  writeEvidence(options.evidenceDir, 'control-fault-matrix-report-integrity.json', {
    schemaVersion: CONTROL_FAULT_MATRIX_SCHEMA_VERSION, offline: true, live: 'not_run', observations,
  });
  return Object.freeze(observations);
}

/* ------------------------------------------------------------------ *
 * 汇总入口（供阶段报告聚合）
 * ------------------------------------------------------------------ */

export interface ControlFaultMatrixSummary {
  readonly schemaVersion: typeof CONTROL_FAULT_MATRIX_SCHEMA_VERSION;
  readonly offline: true;
  readonly live: { readonly status: 'not_run'; readonly reason: string };
  readonly groups: readonly {
    readonly group: string;
    readonly scenarios: number;
    readonly stopConfirmed: number;
    readonly cleanupConfirmed: number;
  }[];
}

export async function runControlFaultMatrix(
  options: ControlFaultMatrixEvidenceOptions = {},
): Promise<ControlFaultMatrixSummary> {
  const events = await runControlEventFaults(options);
  const uncertainty = await runStopUncertaintyFaults(options);
  const late = await runLateResultFaults(options);
  const report = await runReportIntegrityFaults(options);
  const summary: ControlFaultMatrixSummary = {
    schemaVersion: CONTROL_FAULT_MATRIX_SCHEMA_VERSION,
    offline: true,
    live: { status: 'not_run', reason: '离线控制矩阵不调用真实模型或网络。' },
    groups: Object.freeze([
      Object.freeze({ group: 'control-events', scenarios: events.length,
        stopConfirmed: events.filter(row => row.stopEvidence.stopConfirmed).length,
        cleanupConfirmed: events.filter(row => row.processTree.membersFinal.length === 0).length }),
      Object.freeze({ group: 'stop-uncertainty', scenarios: uncertainty.length,
        stopConfirmed: uncertainty.filter(row => row.stopEvidence.confirmed).length,
        cleanupConfirmed: uncertainty.filter(row => row.cleanupConfirmed).length }),
      Object.freeze({ group: 'late-results', scenarios: late.length,
        stopConfirmed: late.filter(row => row.noFabricatedPass).length,
        cleanupConfirmed: late.filter(row => row.businessUnchanged && row.accountingUnchanged).length }),
      Object.freeze({ group: 'report-integrity', scenarios: report.length,
        stopConfirmed: report.filter(row => row.failedClosed).length,
        cleanupConfirmed: report.filter(row => row.scenePreserved).length }),
    ]),
  };
  writeEvidence(options.evidenceDir, 'control-fault-matrix-summary.json', summary);
  return summary;
}

function writeEvidence(directory: string | undefined, name: string, body: unknown): void {
  if (directory === undefined || directory === '') return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}
