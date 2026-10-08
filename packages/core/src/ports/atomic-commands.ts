/**
 * F-007 原子命令窄端口。同步事务上下文只含应用数据，不含驱动/HTTP/SDK。
 * 回调不得等待 Promise 或做 Git/文件/网络/能力发现；上下文仅在回调内有效。
 * 实现须以同一 BEGIN IMMEDIATE 包住回执重核、业务 CAS/事件和回执保存，
 * 任意写入异常整组回滚；busy 复用已有有限预算。
 * F-008 起新增 registerProject：项目/绑定/创建事件的原子创建原语。
 */
import type { CommandReceipt } from './commands.js';
import type {
  GlobalSettingsRecord,
  ProjectRecord,
  ProjectSettingsRecord,
  ProjectWithRepositoryBindingResult,
} from './state-store.js';

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
  /** F-009：事务内读取全局当前配置（项目配置一致性依赖的权威重核）；未配置返回 null。 */
  getGlobalSettingsOrNull(): GlobalSettingsRecord | null;
  /** F-009：事务内读取项目当前配置；未配置返回 null（项目缺失由 getProject 先行把关）。 */
  getProjectSettingsOrNull(projectId: string): ProjectSettingsRecord | null;
  /**
   * F-009：全局配置 insert-only 首建（P01 同一 SQL/校验），新建成功时同事务追加
   * 唯一一条 settings.global_created 创建事件（P01 直接服务首建不写，契约 §15.3）。
   */
  createGlobalSettings(input: unknown): GlobalSettingsRecord;
  /**
   * F-009：全局配置 expectedRevision CAS 更新；与 P01 同一写入路径，同事务写既有
   * settings.global_updated 事件（不重复写）。
   */
  updateGlobalSettings(input: unknown): GlobalSettingsRecord;
  /**
   * F-009：项目配置 insert-only 首建；输入可携带 consistency.globalRevision（由调用方
   * 事务外一致性视图推导），在同一事务内核对（stale_dependency 拒绝）；新建成功时
   * 同事务追加唯一一条 settings.project_created 创建事件。
   */
  createProjectSettings(projectId: string, input: unknown): ProjectSettingsRecord;
  /** F-009：项目配置 CAS 更新 + consistency 核对 + 既有 settings.project_updated 事件。 */
  updateProjectSettings(projectId: string, input: unknown): ProjectSettingsRecord;
  saveReceipt(receipt: unknown): void;
}

export interface AtomicCommandStore {
  /** 仅预检时效使用；不能替代事务内的权威重读。 */
  findReceipt(principalId: string, commandId: string): CommandReceipt | undefined;
  /**
   * F-009：配置命令一致性视图的事务外只读来源（全局当前配置快照；未配置返回
   * null）。读取到的 revision 作为 consistency.globalRevision 前置条件随写入
   * 传入，由同一写事务内核对；在写事务内调用是编程错误（事务内请用
   * CommandTransaction.getGlobalSettingsOrNull）。
   */
  getGlobalSettingsOrNull(): GlobalSettingsRecord | null;
  transact<T>(operation: string, submit: (transaction: CommandTransaction) => T): T;
}
