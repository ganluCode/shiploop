/**
 * P04-8 / F-006 取消、超时、强杀、停止不确定与证据完整性离线控制矩阵。
 *
 * 覆盖验收标准：
 * 1. 请求取消、工具取消、执行超时、Host 异常和 Runner 强杀分别验证控制回执、
 *    进程树、Attempt/Run 终态和停止证据；
 * 2. 进程停止无法确认时保留占用和现场，禁止释放工作区、重新认领或把 cleanup
 *    标记为 true；
 * 3. 迟到的模型、工具和进程结果不能覆盖取消或新代次的业务状态，也不能重复
 *    记账或制造通过结果；
 * 4. 报告目录损坏、证据缺失、非空目录重用和清理失败均返回非零并保留可审计现场。
 *
 * 矩阵只使用真实临时 SQLite/Git 夹具、受控三代写入进程与生产公开接口；
 * 不调用模型或网络，不递归启动全量或阶段入口，不遗留后台进程。
 */
import { describe, expect, it } from 'vitest';
import {
  CONTROL_EVENT_IDS,
  LATE_RESULT_IDS,
  REPORT_INTEGRITY_IDS,
  STOP_UNCERTAINTY_IDS,
  runControlEventFaults,
  runLateResultFaults,
  runReportIntegrityFaults,
  runStopUncertaintyFaults,
} from '../../../helpers/p04-8/control-fault-matrix.ts';

const describeMac = describe.skipIf(process.platform !== 'darwin');

describeMac('P04-8 F-006 控制事件矩阵：回执、进程树、终态与停止证据', () => {
  it('[case:request-cancel] 请求取消先进入 cancelling，真实停止确认后才 cancelled', async () => {
    const rows = await runControlEventFaults({ only: ['request-cancel'] });
    expect(rows.map(row => row.scenarioId)).toEqual(['request-cancel']);
    const row = rows[0]!;
    expect(row.controlReceipt).toMatchObject({
      kind: 'command', accepted: true, outcome: 'cancelled',
      firstOutcome: 'cancelling', finalOutcome: 'cancelled',
    });
    expect(row.controlReceipt.stopOperationId).toMatch(/^[0-9a-f-]{36}$/);
    // 取消意图本身不是停止证据：命令接受时真实写入进程仍在运行。
    expect(row.processTree.membersDuringCancelIntent.length).toBeGreaterThanOrEqual(3);
    expect(row.processTree.membersFinal).toEqual([]);
    expect(row.attemptTerminal).toMatchObject({
      runStatus: 'cancelled', runReason: 'user_cancel', attempts: 1,
      reclaimBlocked: 'run_not_active', taskPassed: false,
    });
    expect(row.attemptTerminal.attemptStatuses).not.toContain('succeeded');
    expect(row.stopEvidence).toMatchObject({
      resultReason: 'cancelled', stopConfirmed: true, stopOperationStatus: 'stopped',
    });
  }, 25_000);

  it('[case:tool-cancel] 工具取消回执 accepted，整组停止确认后业务只保留一次失败终态', async () => {
    const rows = await runControlEventFaults({ only: ['tool-cancel'] });
    const row = rows[0]!;
    expect(row.scenarioId).toBe('tool-cancel');
    expect(row.controlReceipt).toMatchObject({ kind: 'tool_cancel', accepted: true, outcome: 'cancelled' });
    expect(row.processTree.membersBeforeControl.length).toBeGreaterThanOrEqual(3);
    expect(row.processTree.membersFinal).toEqual([]);
    // 固执写入者忽略 SIGTERM，升级路径必须出现 SIGKILL。
    expect(row.processTree.signals).toContain('SIGKILL');
    expect(row.attemptTerminal).toMatchObject({
      attempts: 1, taskPassed: false, newAttemptCreated: false, leasesRemaining: 0,
    });
    expect(row.attemptTerminal.attemptStatuses).not.toContain('succeeded');
    expect(row.stopEvidence).toMatchObject({
      resultReason: 'cancelled', stopConfirmed: true, reconciliationStatus: 'reconciled',
    });
  }, 25_000);

  it('[case:execution-timeout] 执行超时以 timed_out 终止整组并保留真实超时证据', async () => {
    const rows = await runControlEventFaults({ only: ['execution-timeout'] });
    const row = rows[0]!;
    expect(row.scenarioId).toBe('execution-timeout');
    expect(row.controlReceipt).toMatchObject({ kind: 'timeout', outcome: 'timed_out', timedOut: true });
    expect(row.processTree.membersFinal).toEqual([]);
    expect(row.processTree.signals).toContain('SIGKILL');
    expect(row.attemptTerminal).toMatchObject({
      attempts: 1, taskPassed: false, newAttemptCreated: false, leasesRemaining: 0,
    });
    expect(row.stopEvidence).toMatchObject({ resultReason: 'timed_out', stopConfirmed: true });
  }, 25_000);

  it('[case:host-exception] Host 异常不停止受控树，恢复先核验真实停止再清占用', async () => {
    const rows = await runControlEventFaults({ only: ['host-exception'] });
    const row = rows[0]!;
    expect(row.scenarioId).toBe('host-exception');
    expect(row.controlReceipt).toMatchObject({
      kind: 'host_signal', signal: 'SIGKILL', outcome: 'complete', recoveryStatus: 'complete',
    });
    // Host 死亡本身不是停止证据：受控写入树在 Host 强杀后仍然存活。
    expect(row.processTree.membersAfterControl.length).toBeGreaterThanOrEqual(3);
    expect(row.processTree.membersFinal).toEqual([]);
    expect(row.attemptTerminal).toMatchObject({
      attempts: 1, taskPassed: false, newAttemptCreated: false, leasesRemaining: 0,
    });
    expect(row.stopEvidence).toMatchObject({ stopConfirmed: true, reconciliationStatus: 'reconciled' });
  }, 30_000);

  it('[case:runner-kill] Runner 进程组强杀后按缺席核验确认停止，不伪造运行结果', async () => {
    const rows = await runControlEventFaults({ only: ['runner-kill'] });
    const row = rows[0]!;
    expect(row.scenarioId).toBe('runner-kill');
    expect(row.controlReceipt).toMatchObject({
      kind: 'runner_signal', signal: 'SIGKILL', outcome: 'complete', recoveryStatus: 'complete',
    });
    // 整组被 SIGKILL：监督者来不及上报，结果必须保持 supervisor_lost 而非伪造成功。
    expect(row.controlReceipt.resultReason).toBe('supervisor_lost');
    expect(row.processTree.membersFinal).toEqual([]);
    expect(row.attemptTerminal).toMatchObject({
      attempts: 1, taskPassed: false, newAttemptCreated: false, leasesRemaining: 0,
    });
    expect(row.attemptTerminal.attemptStatuses).not.toContain('succeeded');
    expect(row.stopEvidence.stopConfirmed).toBe(true);
  }, 25_000);

  it('[case:control-event-ids] 五类控制事件 ID 固定且可被矩阵逐一执行', () => {
    expect([...CONTROL_EVENT_IDS]).toEqual([
      'request-cancel', 'tool-cancel', 'execution-timeout', 'host-exception', 'runner-kill',
    ]);
  });
});

describeMac('P04-8 F-006 停止不确定：保留占用、现场与失败清理证据', () => {
  it('[case:cancel-stop-uncertain] interrupted 占用未确认时取消只返回 stop_uncertain，占用与现场保持', async () => {
    const rows = await runStopUncertaintyFaults({ only: ['cancel-stop-uncertain'] });
    const row = rows[0]!;
    expect(row.scenarioId).toBe('cancel-stop-uncertain');
    expect(row.controlReceipt).toMatchObject({ outcome: 'stop_uncertain', stopStatus: 'uncertain' });
    expect(row.occupancyRetained).toMatchObject({ quarantinedLeases: 3, runUnchanged: true });
    expect(row.reclaimBlocked).toBe(true);
    // 停止未确认：cleanup 不得标记为通过，业务现场（行/占用）保持不变。
    expect(row.cleanupConfirmed).toBe(false);
    expect(row.scenePreserved).toBe(true);
    expect(row.stopEvidence).toMatchObject({ confirmed: false, manualNextStepsCount: 0 });
    // 迟到成功不能覆盖 interrupted 状态。
    expect(row.lateOverwriteRejected).toBe(true);
  }, 20_000);

  it('[case:recovery-stop-unconfirmed] 孤儿后代仍写入时恢复隔离资源并禁止认领，物理清理不冲洗业务隔离', async () => {
    const rows = await runStopUncertaintyFaults({ only: ['recovery-stop-unconfirmed'] });
    const row = rows[0]!;
    expect(row.scenarioId).toBe('recovery-stop-unconfirmed');
    expect(row.controlReceipt).toMatchObject({
      outcome: 'blocked', recoveryStatus: 'blocked', recoveryReason: 'workspace_reconciliation_required',
    });
    expect(row.processTree.orphanMembersAfterKill.length).toBeGreaterThanOrEqual(2);
    expect(row.processTree.membersFinal).toEqual([]);
    expect(row.occupancyRetained).toMatchObject({ quarantinedLeases: 3, workspaceStatus: 'quarantined' });
    expect(row.reclaimBlocked).toBe(true);
    expect(row.cleanupConfirmed).toBe(false);
    expect(row.scenePreserved).toBe(true);
    expect(row.stopEvidence).toMatchObject({ confirmed: false });
    expect(row.stopEvidence.gaps).toContain('stop_unconfirmed');
    expect(row.stopEvidence.manualNextStepsCount).toBeGreaterThan(0);
    // 测试自有物理清理后，业务隔离与占用结论仍保持（物理停止 ≠ 业务恢复）。
    expect(row.businessQuarantineRetainedAfterPhysicalStop).toBe(true);
  }, 30_000);

  it('[case:stop-uncertainty-ids] 停止不确定场景 ID 固定', () => {
    expect([...STOP_UNCERTAINTY_IDS]).toEqual(['cancel-stop-uncertain', 'recovery-stop-unconfirmed']);
  });
});

describe('P04-8 F-006 迟到结果矩阵：不覆盖业务状态、不重复记账、不制造通过', () => {
  it('[case:late-model-result-after-cancel] Run 取消终态后的迟到成功提交被拒绝且预算不变', async () => {
    const rows = await runLateResultFaults({ only: ['late-model-result-after-cancel'] });
    const row = rows[0]!;
    expect(row.scenarioId).toBe('late-model-result-after-cancel');
    expect(row.lateDelivery.kind).toBe('model');
    expect(row.lateOverwriteRejected).toBe(true);
    expect(row.runStatus).toBe('cancelled');
    expect(row.attempts).toBe(1);
    expect(row.businessUnchanged).toBe(true);
    expect(row.accountingUnchanged).toBe(true);
    expect(row.noFabricatedPass).toBe(true);
  }, 20_000);

  it('[case:late-settlement-after-cancelled-attempt] 已取消 Attempt 的迟到 fulfilled 结算被忽略且不落业务', async () => {
    const rows = await runLateResultFaults({ only: ['late-settlement-after-cancelled-attempt'] });
    const row = rows[0]!;
    expect(row.scenarioId).toBe('late-settlement-after-cancelled-attempt');
    expect(row.lateDelivery.kind).toBe('model');
    expect(row.receipts).toHaveLength(2);
    for (const receipt of row.receipts) {
      expect(receipt.disposition).toBe('ignored');
      expect(receipt.resultSaved).toBe(false);
      expect(receipt.runtimeCompleted).toBe(false);
    }
    expect(row.attemptStatuses).toEqual(['cancelled']);
    expect(row.businessUnchanged).toBe(true);
    expect(row.accountingUnchanged).toBe(true);
    expect(row.gitHeadUnchanged).toBe(true);
    expect(row.noFabricatedPass).toBe(true);
  }, 20_000);

  it('[case:late-tool-and-process-results-after-cancel] 真实进程迟到退出与迟到工具事件不改取消业务状态', async () => {
    const rows = await runLateResultFaults({ only: ['late-tool-and-process-results-after-cancel'] });
    const row = rows[0]!;
    expect(row.scenarioId).toBe('late-tool-and-process-results-after-cancel');
    expect(row.lateDelivery.kind).toBe('process');
    expect(row.lateDelivery.realProcessExit).toMatchObject({ exitCode: 0, stopConfirmed: true });
    // 取消控制窗口（run cancelling）内：迟到工具事件进入可见记录（水位前进）。
    expect(row.evidenceWatermark).toBeGreaterThan(0);
    // 迟到的“成功”结算携带取消控制事实：Attempt 只能落为 cancelled，不进 verifying。
    expect(row.receipts[0]).toMatchObject({ disposition: 'applied', status: 'cancelled' });
    expect(row.attemptStatuses).toEqual(['cancelled']);
    expect(row.runStatus).toBe('cancelling');
    expect(row.taskPassed).toBe(false);
    expect(row.accountingUnchanged).toBe(true);
    expect(row.noFabricatedPass).toBe(true);
  }, 25_000);

  it('[case:late-result-ids] 迟到结果场景 ID 固定', () => {
    expect([...LATE_RESULT_IDS]).toEqual([
      'late-model-result-after-cancel',
      'late-settlement-after-cancelled-attempt',
      'late-tool-and-process-results-after-cancel',
    ]);
  });
});

describe('P04-8 F-006 报告与证据完整性矩阵：fail-closed 且保留现场', () => {
  it('[case:report-dir-corrupt] 损坏的 state 水位使 resume 非零失败并保留原现场', async () => {
    const rows = await runReportIntegrityFaults({ only: ['report-dir-corrupt'] });
    const row = rows[0]!;
    expect(row.scenarioId).toBe('report-dir-corrupt');
    expect(row.failedClosed).toBe(true);
    expect(row.errorKind).toBe('evidence_corrupt');
    expect(row.scenePreserved).toBe(true);
    // 篡改后的水位文件与全部既有步骤证据在失败后逐字节保留。
    for (const path of row.preservedPaths) expect(path).toBeTruthy();
    expect(row.tamperedStateRetained).toBe(true);
  }, 20_000);

  it('[case:evidence-missing] 步骤证据缺失使 resume 非零失败，不伪造成功前缀', async () => {
    const rows = await runReportIntegrityFaults({ only: ['evidence-missing'] });
    const row = rows[0]!;
    expect(row.scenarioId).toBe('evidence-missing');
    expect(row.failedClosed).toBe(true);
    expect(row.errorKind).toBe('evidence_corrupt');
    expect(row.scenePreserved).toBe(true);
    expect(row.stepsExecutedOnResume).toBe(0);
  }, 20_000);

  it('[case:nonempty-dir-reuse] 非空报告目录拒绝复用，旧内容不被覆盖', async () => {
    const rows = await runReportIntegrityFaults({ only: ['nonempty-dir-reuse'] });
    const row = rows[0]!;
    expect(row.scenarioId).toBe('nonempty-dir-reuse');
    expect(row.failedClosed).toBe(true);
    expect(row.errorKind).toBe('evidence_dir_not_empty');
    expect(row.stepsExecutedOnResume).toBe(0);
    expect(row.scenePreserved).toBe(true);
    expect(row.oldContentIntact).toBe('original');
  }, 20_000);

  it('[case:cleanup-failure] 清理失败保留现场且 cleanup 证据不标记为通过', async () => {
    const rows = await runReportIntegrityFaults({ only: ['cleanup-failure'] });
    const row = rows[0]!;
    expect(row.scenarioId).toBe('cleanup-failure');
    expect(row.failedClosed).toBe(true);
    expect(row.errorKind).toBe('cleanup_not_authorized');
    expect(row.scenePreserved).toBe(true);
    expect(row.cleanupStatus).not.toBe('passed');
  }, 20_000);

  it('[case:report-integrity-ids] 报告完整性场景 ID 固定', () => {
    expect([...REPORT_INTEGRITY_IDS]).toEqual([
      'report-dir-corrupt', 'evidence-missing', 'nonempty-dir-reuse', 'cleanup-failure',
    ]);
  });
});
