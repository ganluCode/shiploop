/**
 * F-010（P02-3）受监督基线进程停止后的占用收尾（application 层）。
 *
 * 协议依据：docs/p02-3-onboarding-contract.md §8.3（停止未确认 → 操作 failed、
 * 检查 inconclusive、reason=stop_unconfirmed，且**保留占用**）、§8.4（操作终态
 * 在全部检查收尾且进程确认停止后写回；写回失败占用保留）、§13（全局单并发
 * 占用：另一在途操作 → resource_busy baseline_in_progress）。
 *
 * 不变量：
 * - 只依赖 ports 窄接口（CommandTransaction 的释放原语 + 占用读取面）；不接触
 *   适配器、驱动、HTTP 或 Pi SDK；本模块不 spawn、不杀进程、不做 Git 操作；
 * - **只有停止经核验（stopConfirmed=true）才允许释放全局占用**；停止未确认时
 *   保留占用（资源隔离），竞争检查经既有占用获取原语被 baseline_in_progress
 *   拒绝，不能启动；
 * - 释放仅对持有者生效（非持有者由存储原语拒绝，ownership 错误原样传播）；
 *   已释放后重复收尾幂等；
 * - 输入在事务内校验（holderOperationId 必须是 UUID v4、stopConfirmed 必须是
 *   布尔），非法输入在副作用前抛 TypeError，事务由调用方回滚。
 */
import type { CommandTransaction } from '../ports/atomic-commands.js';
import type { BaselineOccupancySnapshot } from '../ports/baseline-store.js';
import { isUuidV4 } from '../ports/commands.js';

/** 受监督进程停止证据（来自 CommandProcessResult.stop / CommandProcessStop）。 */
export interface BaselineProcessStopEvidence {
  /** 整个受控组不存在的核验结果；false＝无法确认（unknown/uncertain）。 */
  readonly stopConfirmed: boolean;
}

/** 占用收尾所需的最窄端口面（可信装配提供）。 */
export interface BaselineProcessStopPorts {
  readonly transaction: Pick<CommandTransaction, 'releaseBaselineOccupancy'>;
  readonly occupancyReader: { readBaselineOccupancy(): BaselineOccupancySnapshot };
}

export interface BaselineOccupancyStopFinalization {
  /** 是否实际释放了全局占用（仅停止确认后为 true）。 */
  readonly released: boolean;
  /** 停止未确认时占用是否仍由持有者持有（保留资源隔离）。 */
  readonly retained: boolean;
  readonly occupancy: BaselineOccupancySnapshot;
}

/**
 * 受监督进程停止后的占用收尾：stopConfirmed=true → 释放全局占用（仅持有者，
 * 幂等）；stopConfirmed=false → 保留占用并返回当前快照（竞争检查随后被
 * baseline_in_progress 拒绝）。调用方在原子命令事务内执行本函数。
 */
export function finalizeBaselineOccupancyAfterProcessStop(
  ports: BaselineProcessStopPorts,
  holderOperationId: string,
  evidence: BaselineProcessStopEvidence,
): BaselineOccupancyStopFinalization {
  if (ports === null || typeof ports !== 'object') {
    throw new TypeError('finalizeBaselineOccupancyAfterProcessStop: ports 必须是对象（可信装配编程错误）');
  }
  if (
    ports.transaction === null ||
    typeof ports.transaction !== 'object' ||
    typeof ports.transaction.releaseBaselineOccupancy !== 'function'
  ) {
    throw new TypeError('finalizeBaselineOccupancyAfterProcessStop: transaction 必须提供 releaseBaselineOccupancy 方法（可信装配编程错误）');
  }
  if (
    ports.occupancyReader === null ||
    typeof ports.occupancyReader !== 'object' ||
    typeof ports.occupancyReader.readBaselineOccupancy !== 'function'
  ) {
    throw new TypeError('finalizeBaselineOccupancyAfterProcessStop: occupancyReader 必须提供 readBaselineOccupancy 方法（可信装配编程错误）');
  }
  if (typeof holderOperationId !== 'string' || !isUuidV4(holderOperationId)) {
    throw new TypeError('finalizeBaselineOccupancyAfterProcessStop: holderOperationId 必须是 UUID v4');
  }
  if (evidence === null || typeof evidence !== 'object' || typeof evidence.stopConfirmed !== 'boolean') {
    throw new TypeError('finalizeBaselineOccupancyAfterProcessStop: evidence.stopConfirmed 必须是布尔值');
  }
  if (evidence.stopConfirmed) {
    // 停止经核验：仅持有者可释放；已释放时存储原语幂等返回空闲快照。
    const occupancy = ports.transaction.releaseBaselineOccupancy(holderOperationId);
    return { released: true, retained: false, occupancy };
  }
  // 停止未确认：保留占用（不释放）；占用已不在本持有者名下时不宣称 retained。
  const occupancy = ports.occupancyReader.readBaselineOccupancy();
  return { released: false, retained: occupancy.holderOperationId === holderOperationId, occupancy };
}
