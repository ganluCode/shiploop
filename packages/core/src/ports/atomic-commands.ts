/**
 * F-007 原子命令窄端口。同步事务上下文只含应用数据，不含驱动/HTTP/SDK。
 * 回调不得等待 Promise 或做 Git/文件/网络/能力发现；上下文仅在回调内有效。
 * 实现须以同一 BEGIN IMMEDIATE 包住回执重核、业务 CAS/事件和回执保存，
 * 任意写入异常整组回滚；busy 复用已有有限预算。
 */
import type { CommandReceipt } from './commands.js';
import type { ProjectRecord } from './state-store.js';

export interface CommandTransaction {
  findReceipt(principalId: string, commandId: string): CommandReceipt | undefined;
  getProject(projectId: string): ProjectRecord;
  /** 复用 P01 CAS + 单条 metadata_updated 事件，不开启内层事务。 */
  updateProjectMetadata(projectId: string, input: unknown): ProjectRecord;
  saveReceipt(receipt: unknown): void;
}

export interface AtomicCommandStore {
  /** 仅预检时效使用；不能替代事务内的权威重读。 */
  findReceipt(principalId: string, commandId: string): CommandReceipt | undefined;
  transact<T>(operation: string, submit: (transaction: CommandTransaction) => T): T;
}
