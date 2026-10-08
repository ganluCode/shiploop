/**
 * F-007 原子命令窄端口。同步事务上下文只含应用数据，不含驱动/HTTP/SDK。
 * 回调不得等待 Promise 或做 Git/文件/网络/能力发现；上下文仅在回调内有效。
 * 实现须以同一 BEGIN IMMEDIATE 包住回执重核、业务 CAS/事件和回执保存，
 * 任意写入异常整组回滚；busy 复用已有有限预算。
 * F-008 起新增 registerProject：项目/绑定/创建事件的原子创建原语。
 */
import type { CommandReceipt } from './commands.js';
import type { ProjectRecord, ProjectWithRepositoryBindingResult } from './state-store.js';

export interface CommandTransaction {
  findReceipt(principalId: string, commandId: string): CommandReceipt | undefined;
  getProject(projectId: string): ProjectRecord;
  /** 复用 P01 CAS + 单条 metadata_updated 事件，不开启内层事务。 */
  updateProjectMetadata(projectId: string, input: unknown): ProjectRecord;
  /**
   * F-008：项目 + 仓库绑定原子创建（canonicalPath 幂等复用 P01 规则）。
   * 新建（registered）时同事务追加唯一一条 project.registered 创建事件；
   * already_exists 不写事件、不覆盖既有名称/标签。绑定输入由事务外只读
   * 仓库检查产出；注册成功不表示基线健康或执行就绪。
   */
  registerProject(project: unknown, binding: unknown): ProjectWithRepositoryBindingResult;
  saveReceipt(receipt: unknown): void;
}

export interface AtomicCommandStore {
  /** 仅预检时效使用；不能替代事务内的权威重读。 */
  findReceipt(principalId: string, commandId: string): CommandReceipt | undefined;
  transact<T>(operation: string, submit: (transaction: CommandTransaction) => T): T;
}
