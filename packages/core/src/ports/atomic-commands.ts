/**
 * F-007 原子命令窄端口。同步事务上下文只含应用数据，不含驱动/HTTP/SDK。
 * 回调不得等待 Promise 或做 Git/文件/网络/能力发现；上下文仅在回调内有效。
 * 实现须以同一 BEGIN IMMEDIATE 包住回执重核、业务 CAS/事件和回执保存，
 * 任意写入异常整组回滚；busy 复用已有有限预算。
 * F-008 起新增 registerProject：项目/绑定/创建事件的原子创建原语。
 * P02-3 / F-007 起新增基线原语（§10 窄存储端口的事务面）：不可变授权插入、
 * 操作生命周期 CAS、检查种子与一次性 CAS 收尾、全局占用与 §9.2 事件追加；
 * Git/进程/文件输出/人审都在事务外，事务内不执行文件流/SDK/Git/网络/长检查。
 */
import type { CommandReceipt } from './commands.js';
import type { ArtifactInputRef } from './artifact-store.js';
import type {
  BaselineAuthorizationRecord,
  BaselineCheckResultRecord,
  BaselineOccupancySnapshot,
  BaselineOperationRecord,
} from './baseline-store.js';
import type {
  FeatureRecord,
  PhaseRecord,
  TaskDependencyRecord,
  TaskRecord,
} from './plan-store.js';
import type {
  GlobalSettingsRecord,
  ProjectRecord,
  RepositoryBindingRecord,
  ProjectSettingsRecord,
  ProjectWithRepositoryBindingResult,
} from './state-store.js';

export interface CommandTransaction {
  findReceipt(principalId: string, commandId: string): CommandReceipt | undefined;
  getProject(projectId: string): ProjectRecord;
  /** F-012: binding revision recheck without filesystem I/O. */
  getRepositoryBinding(projectId: string): RepositoryBindingRecord;
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
  /* ---------------------------------------------------------------- *
   * P02-3 / F-007 基线原语（§10 窄存储端口；同一事务内原子生效）
   * ---------------------------------------------------------------- */
  /** §6.2 不可变授权插入（insert-only；无任何更新原语）。 */
  insertBaselineAuthorization(input: unknown): BaselineAuthorizationRecord;
  /** §10 操作生命周期行插入（初始状态；后续经 updateBaselineOperation CAS）。 */
  insertBaselineOperation(input: unknown): BaselineOperationRecord;
  /** 按规范化计划为操作种子逐项检查行（获准输入快照；初始 not_run/退出码 null）。 */
  insertBaselineCheckResults(operationId: string, plan: unknown): readonly BaselineCheckResultRecord[];
  /** 一次性 CAS 收尾单检查（迟到执行版本/已收尾证据均 conflict）。 */
  finalizeBaselineCheckResult(
    operationId: string,
    checkKey: string,
    input: unknown,
  ): BaselineCheckResultRecord;
  /** 操作 CAS 更新（非终态→任意；终态不可覆盖；迟到版本 conflict）。 */
  updateBaselineOperation(operationId: string, input: unknown): BaselineOperationRecord;
  /** §13 全局占用获取（同持有者幂等；另一在途操作 conflict baseline_in_progress）。 */
  acquireBaselineOccupancy(input: unknown): BaselineOccupancySnapshot;
  /** 占用心跳 + 可恢复进程身份更新（仅持有者）。 */
  heartbeatBaselineOccupancy(
    operationId: string,
    processIdentity?: unknown,
  ): BaselineOccupancySnapshot;
  /** 释放占用（仅持有者；清空持有者/时刻/进程身份）。 */
  releaseBaselineOccupancy(operationId: string): BaselineOccupancySnapshot;
  /** §9.2 基线事件追加（payload 只含受控脱敏键；与公开白名单同形）。 */
  appendBaselineEvent(input: unknown): void;
  /* ---------------------------------------------------------------- *
   * P03-1 / F-002 计划结构原语（迁移 v6 四表；同一事务内原子生效）
   *
   * 输入一律 unknown，经 ports/plan-store.ts 校验器后才进入持久化；归属
   * （同项目/同 Feature）在同一事务内核验，环检测在事务内 DFS 复核；
   * Phase/Feature 创建恒为 open/draft(+plan_status=draft)，Task 保留计划
   * 作者稳定 ID 且状态恒为 pending；事件/回执写入由后续命令用例
   * （F-004/F-005）在其自身事务内组合，不在本原语内预支。
   * ---------------------------------------------------------------- */
  /** 创建 open Phase（适配器生成 UUID v4 与 UTC 毫秒；revision=1）。 */
  insertPhase(input: unknown): PhaseRecord;
  /** 创建 draft Feature（含最小 plan_status=draft、可选 planDigest 与来源引用）。 */
  insertFeature(input: unknown): FeatureRecord;
  /** 创建 pending Task（保存完整验收/引用/complexity/executionConfig 及来源）。 */
  insertTask(input: unknown): TaskRecord;
  /** 插入同 Feature 依赖边（自依赖/重复边/跨 Feature/环均结构化拒绝）。 */
  insertTaskDependency(input: unknown): TaskDependencyRecord;
  /**
   * F-004：计划域脱敏事件追加（phase.created；payload 恒 {created:true}）。由命令
   * 用例在同一事务内与业务行/回执组合（F-002 不预支进插入原语）；F-005 起随
   * 对应功能扩展白名单。
   */
  appendPlanEvent(input: unknown): void;
  /* ---------------------------------------------------------------- *
   * P03-1 / F-005 计划导入事务内重核原语（只读；同一 BEGIN IMMEDIATE 内）
   *
   * 导入用例在提交前以这些原语重核父 Phase（归属/open/CAS）、既有任务身份
   * （重复业务 ID/跨 Feature 依赖解析）与需求-验收引用制品身份（复用
   * ArtifactStore.getArtifactInputRef 同一契约语义：缺失 not_found、跨项目
   * ownership、非 ready/缺内容身份 conflict）；文件完整性 I/O 不在事务内。
   * ---------------------------------------------------------------- */
  /** 读取目标 Phase（同项目；缺失 not_found、跨项目 ownership）。 */
  getPhase(projectId: string, phaseId: string): PhaseRecord;
  /** 读取同项目 ready 制品的有效输入引用（与 ArtifactStore 同一契约语义）。 */
  getArtifactInputRef(projectId: string, artifactId: string): ArtifactInputRef;
  /** 既有任务 → 所属 Feature 的解析（仅返回存在的行；跨 Feature 依赖定位用）。 */
  getTaskFeatureLinks(taskIds: readonly string[]): ReadonlyMap<string, string>;
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
