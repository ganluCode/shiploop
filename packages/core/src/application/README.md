# Core · application

应用层：命令、查询与执行编排（用例服务、调度、预算、验收编排）。

- 允许：依赖 `domain` 与 `ports` 中声明的窄接口；以显式调用组织用例；依赖注入在边界装配。
- 禁止：依赖具体适配器实现（`adapters/*`）；导入或重导出 Pi SDK、Electron、HTTP 框架、`better-sqlite3`、Drizzle；直接发起网络监听或持有用户数据路径之外的写入；空壳的项目/调度/存储/Runtime 服务。

当前阶段（P01-2 / F-011、F-012）：`artifact-publish.ts` 为首个用例服务——制品流式发布编排（pending 登记 → 事务外 staging 流式写入与同步 → hash 核验 → 同文件系统不覆盖发布 → 短事务 CAS ready），只依赖 `ports` 的 ArtifactStore/ArtifactFileStore 窄接口与 node 内置模块；限制（大小/时间/取消）显式有限，失败保留阶段化证据与 staging 残留。`artifact-verify.ts`（F-012）为制品中断核对与损坏诊断用例：关闭重开后的 pending 恢复（正式文件核验通过后 CAS 补 ready，冲突时按 revision 重新核对、不让旧结果倒写）、ready 完整性核对与三种 corrupt 诊断（missing/size_mismatch/hash_mismatch）、必要完整性检查的有效读取（缓冲受显式上限约束）与项目级批量核对/孤儿扫描（原文件保留 kept_in_place，不制造索引、不删除未知文件）。其余用例实现从后续 Feature 开始按设计 `core-design/04-scheduling-and-recovery.md` 等进入。

P01-3 / F-005 起新增 `project-service.ts`：ProjectService 仓库注册用例（registerRepository）——输入运行时校验（元数据复用 F-002 共用校验器，非法输入先于任何 I/O 拒绝）→ 只读仓库检查（RepositoryInspector，数据库写事务之外）→ 单个短事务原子保存项目 + 绑定（StateStore.createProjectWithRepositoryBinding，同 canonicalPath 幂等复用返回 already_exists，不同 clone 分别注册）。只依赖 ports 窄接口，不接触适配器/驱动/HTTP/Pi SDK。

P01-3 / F-006 起同一 `project-service.ts` 补充：`getProject` / `getRepositoryBinding`（按 projectId 查询身份与完整绑定，未知 ID 为 not_found）与 `updateProjectMetadata`（名称/描述/标签 CAS 编辑，先经 F-002 共用校验器拒绝非法字段/标签，再交 `StateStore.updateProject` 在同一短事务内完成 CAS 更新与 `state_events` 脱敏变更记录）。改元数据不触碰 projectId、canonicalPath、配置、PathService 位置或已有制品。

P01-3 / F-007 起同一 `project-service.ts` 补充 `listProjects` / `countProjectLabels` 只读查询，直接复用 `StateStore.listProjects` / `StateStore.countProjectLabels`（任一/全部标签筛选、稳定 `id` 升序键集分页、项目层去重计数）；应用层不另立第二套标签规则，不实现按标签启动 Batch 或 Phase/Feature/Task 标签查询。

P01-3 / F-009 起新增 `effective-settings.ts`：全局默认与项目当前覆盖的**有效配置合并纯函数** `mergeEffectiveSettings`——键级继承、完整策略条目整体替换（不跨来源拼接 runtime/provider/model）、政策段级整体覆盖（段内不跨来源继承、数组整体替换、空段 `{}` 继承全局）、逐项来源解释（`global_default`/`project_default` + `sourceKey` + 来源 scope revision）。输入边界为 `unknown`：两个来源的 payload 合并前重新经 `validateSettingsPayload`（schemaVersion=2）校验，未知版本/未知键/不完整条目/非法政策带字段定位拒绝，不静默降级；双方均无策略时返回 `configured:false` 的明确未配置结果，不注入默认 Claude/API。纯函数：不修改原始 payload、不解析凭据引用、不创建 Task、不写执行快照；只依赖 ports。从 StateStore 组装来源输入的查询服务由 F-011 交付。

P01-3 / F-010 起新增 `configuration-service.ts`：ConfigurationService 命令切片（`createSettings` insert-only / `updateSettings` expectedRevision CAS）——严格顺序为 scope/输入运行时校验（先于任何 I/O，写入端口不被调用）→（project scope）读取全局当前配置作为一致性视图来源 → F-009 合并校验 + 合并后策略集合的能力兼容复检（F-008 目录，继承条目随当前目录复检）→ 存储端口条件写入；读取到的全局 revision 作为 `consistency.globalRevision` 前置条件随写入传入（调用方不得自行声明该键），与默认更新竞争时返回 conflict（stale_dependency），不提交基于陈旧依赖校验过的结果。成功的 CAS 更新由存储端口同事务追加 `settings.global_updated`/`settings.project_updated` 脱敏审计记录（`settingsChangeSummary` 摘要，不含值/引用/秘密）；首次创建不写审计记录。scope 即唯一目标身份渠道（项目 A 范围不能更新项目 B）；事务内只有 SQL，不进行网络/Git/模型/凭据解析。查询（当前值/有效配置/脱敏导出）由 F-011 交付。
