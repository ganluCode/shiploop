/**
 * F-010（P02-3）受控进程组升级终止决策核心（adapters/process 私有模块）。
 *
 * 职责：取消/超时/监督者失联共用的**有界**停止路径的最后一级——宽限期满后，
 * 先核对持久提交的监督进程身份（PID/PGID/OS lstart/命令行启动标识），核对
 * 一致才对**整个受控进程组**发出 SIGKILL，随后在有限确认预算内清点组成员；
 * 只有成功的清点显示全组不存在才报告 stopped。
 *
 * 不变量：
 * - 本模块是纯决策核心：不 import 任何 node 模块、不执行 I/O；探测、信号与
 *   延时全部由可信装配注入（生产装配注入真实 /bin/ps 与 process.kill）；
 * - 身份探测失败（ps 错误）→ 不发出任何信号，也**绝不**折算为 stopped；
 * - 身份不一致（PID 被 OS 复用为无关进程、旧执行标识、lstart 变化）→ 不发出
 *   任何信号（不误杀无关进程），报告 mismatched 且 confirmed=false；
 * - 监督者已退出（行不存在）→ 无需信号，仅核验组成员缺席；迟到清点失败同样
 *   不折算为 stopped；
 * - 成员清点有界轮询（confirmMs 预算，§13 升级后确认停止预算 5 000 ms），
 *   预算耗尽仍有成员 → confirmed=false（调用方保留占用/隔离）。
 */
import type { CommandProcessIdentity } from '../../ports/command-process.js';

/** 监督进程的一次 /bin/ps 身份行（pid/pgid/lstart/完整命令行）。 */
export interface SupervisedProcessRow {
  readonly pid: number;
  readonly processGroupId: number;
  readonly startTime: string;
  readonly command: string;
}

/** 注入的停止探测面（生产装配提供真实实现；测试注入确定性假实现）。 */
export interface StopEscalationProbe {
  /**
   * 读取监督进程身份行。
   * 返回 null＝进程已不存在；undefined 或抛错＝探测失败（未知，保守处理）。
   */
  readSupervisorRow(pid: number): Promise<SupervisedProcessRow | null | undefined>;
  /** 列出进程组成员 pid；undefined 或抛错＝探测失败（未知，保守处理）。 */
  listGroupMembers(processGroupId: number): Promise<readonly number[] | undefined>;
  /** 对整个受控组发信号；返回是否送达（false＝ESRCH 等失败，不视为已停止）。 */
  signalGroup(processGroupId: number, signal: 'SIGKILL'): boolean;
  /** 有界等待（注入以保持纯度与可测性）。 */
  delay(ms: number): Promise<void>;
  /** Monotonic test/adapter clock; production defaults to Date.now. */
  readonly nowUtcMs?: () => number;
}

/** 有界停止预算（§13：升级后确认停止预算 5 000 ms 默认）。 */
export interface StopEscalationBudgets {
  readonly confirmMs: number;
  readonly pollMs: number;
}

/** 升级前的身份核对结果。 */
export type StopIdentityVerification =
  | 'matched'
  | 'absent'
  | 'mismatched'
  | 'probe_failed';

export interface StopEscalationOutcome {
  /** 仅在成功的成员清点显示全组不存在时为 true；探测失败绝不折算为 true。 */
  readonly confirmed: boolean;
  /** 是否实际对受控组发出了 SIGKILL（仅身份核对一致时才可能）。 */
  readonly escalated: boolean;
  readonly identity: StopIdentityVerification;
}

/** 持久提交的进程身份与当前 ps 行是否同一启动（PID 复用/旧标识防护）。 */
export function matchesSupervisorIdentity(
  row: SupervisedProcessRow,
  identity: CommandProcessIdentity,
): boolean {
  return (
    row.pid === identity.pid &&
    row.processGroupId === identity.processGroupId &&
    row.startTime === identity.startTime &&
    row.command.endsWith(` ${identity.launchId}`)
  );
}

/**
 * 有界核验受控组缺席：轮询成员清点直到成功的清点返回空（confirmed=true）
 * 或确认预算耗尽（confirmed=false）。清点失败不折算为已停止。
 */
export async function confirmGroupAbsence(
  identity: CommandProcessIdentity,
  probe: StopEscalationProbe,
  budgets: StopEscalationBudgets,
): Promise<boolean> {
  const now = probe.nowUtcMs ?? Date.now;
  const deadline = now() + budgets.confirmMs;

  for (;;) {
    let members: readonly number[] | undefined;
    try {
      members = await probe.listGroupMembers(identity.processGroupId);
    } catch {
      members = undefined; // 探测失败＝未知，绝不当作空组。
    }
    if (members !== undefined && members.length === 0) return true;
    if (now() >= deadline) return false;

    await probe.delay(budgets.pollMs);
  }
}

/**
 * 宽限期满后的升级终止：核对身份 → 一致才 SIGKILL 整个受控组 → 有界核验缺席。
 * 身份探测失败或 PID 复用不一致时不发出任何信号，返回 confirmed=false
 * （调用方必须保留占用/隔离，不得当作安全重试）。
 */
export async function forceStopControlledGroup(
  identity: CommandProcessIdentity,
  probe: StopEscalationProbe,
  budgets: StopEscalationBudgets,
): Promise<StopEscalationOutcome> {
  let row: SupervisedProcessRow | null | undefined;
  try {
    row = await probe.readSupervisorRow(identity.pid);
  } catch {
    row = undefined; // 探测失败＝未知：不发出任何信号，也不折算为已停止。
  }
  if (row === undefined) {
    return { confirmed: false, escalated: false, identity: 'probe_failed' };
  }
  if (row !== null && !matchesSupervisorIdentity(row, identity)) {
    // PID 已被无关进程复用或命令行启动标识不一致：绝不误杀，报告不确定。
    return { confirmed: false, escalated: false, identity: 'mismatched' };
  }
  let escalated = false;
  if (row !== null) {
    try {
      escalated = probe.signalGroup(identity.processGroupId, 'SIGKILL');
    } catch {
      // A failed delivery is still uncertain. The follow-up census may prove
      // that the group disappeared, but it must never turn the signal failure
      // itself into a successful escalation.
      escalated = false;
    }
  }
  const confirmed = await confirmGroupAbsence(identity, probe, budgets);
  let exitedBeforeDelivery = false;
  if (row !== null && !escalated && confirmed) {
    // IPC disconnect may stop the supervisor between identity check and signal.
    // A failed signal is not proof: require a fresh successful supervisor-absence probe too.
    try { exitedBeforeDelivery = await probe.readSupervisorRow(identity.pid) === null; }
    catch { /* failed probes remain uncertain */ }
  }
  return { confirmed: confirmed && (row === null || escalated || exitedBeforeDelivery), escalated,
    identity: row === null ? 'absent' : 'matched' };
}
