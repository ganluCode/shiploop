/**
 * P04-9 / F-002 Run 持久入队编排（application 层；无 I/O、无进程、无时钟）。
 *
 * 设计依据：input/p04-dispatch-foundation.md §3.1（SQLite 保存待派发状态；重复
 * 入队返回同一工作身份；消费前重核授权/状态；内存信号只唤醒，Host 重启或丢失
 * 信号后可从持久状态补扫）、§3.4（不开放原始队列编辑入口）。
 *
 * 职责边界：
 * - 本模块只在调用方已开启的命令写事务内登记「Run 已授权的持久执行意图」：
 *   启动（首次授权/同父 Batch 重试）、显式 resume、仅收尾重试都在各自原有事务
 *   内调用，与 Run、命令回执、脱敏事件同生共死；
 * - 授权身份摘要以事务内权威 Run 行重算（项目/Feature/Batch/Run/purpose/
 *   scopeDigest/workKey/dispatchOrdinal），不采信调用方自报的身份；
 * - 存储原语负责归属/状态重核与「同 Run 复用、异摘要冲突」；本模块不重复
 *   创建 Batch/Run/预算，不启动 Runner，也不预扣 Attempt/Runtime 启动额度；
 * - 唤醒仍是命令服务在事务提交后的 best-effort 窄端口信号；入队本身不唤醒、
 *   不自动恢复暂停或取消的工作。
 */
import type { CommandTransaction } from '../ports/atomic-commands.js';
import {
  computeRunDispatchAuthorizationDigest,
  type RunDispatchIntentRegistration,
  type RunDispatchIntentSource,
} from '../ports/execution-dispatch.js';

/** 入队编排输入（身份级；Run 的 Feature/Batch 由事务内 Run 行确定，不采信入参）。 */
export interface EnqueueAuthorizedRunInput {
  readonly projectId: string;
  readonly runId: string;
  readonly source: RunDispatchIntentSource;
  /** 有界排队原因（如未装配调度器；不含正文/凭据）。 */
  readonly reason?: string | null;
}

/**
 * 在调用方写事务内登记 Run 的持久入队意图。
 * Run 缺失/跨项目直接抛出（整组回滚）；已是终态/取消/暂停中的工作不重开。
 */
export function enqueueAuthorizedRunInTransaction(
  transaction: CommandTransaction,
  input: EnqueueAuthorizedRunInput,
): RunDispatchIntentRegistration {
  const run = transaction.getExecutionRun(input.projectId, input.runId);
  const authorizationDigest = computeRunDispatchAuthorizationDigest({
    projectId: run.projectId,
    featureId: run.featureId,
    batchId: run.batchId,
    runId: run.id,
    purpose: run.purpose,
    scopeDigest: run.scopeDigest,
    workKey: run.workKey,
    dispatchOrdinal: run.dispatchOrdinal,
  });
  return transaction.registerRunDispatchIntent({
    projectId: run.projectId,
    featureId: run.featureId,
    batchId: run.batchId,
    runId: run.id,
    source: input.source,
    authorizationDigest,
    reason: input.reason ?? null,
  });
}
