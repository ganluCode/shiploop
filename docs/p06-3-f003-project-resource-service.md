# P06-3 F-003 项目资源配置服务

`openCoreApplication().projectResourceService` 提供 `getConfiguration/list`、`select/importCandidate`、`enable/disable`、`revoke` 与 `snapshotForAttempt`。所有调用显式传入可信 `TrustedPrincipal`；请求内容、候选提示词及工具名称不提供主体身份。

项目资源保存在现有 `project_settings.payload.projectResources` 可选 v1 段内，外层 settings schemaVersion 保持 2。无配置行时资源 revision 为 0，首次写入创建 revision 1；已有设置时沿用该行 revision。导入、启停、撤销和普通设置更新共享同一个 CAS，不存在第二个配置权威或配置版本表。本任务没有修改迁移 SQL、checksum 或 Drizzle schema。旧 v2 配置仍有效；旧 Core 遇到新的资源段会按未知字段拒绝，不能用旧二进制忽略授权数据。

资源段保存稳定身份、项目/来源、版本、内容摘要、能力、transport、凭据引用、导入时间、启用状态和撤销状态。候选正文、路径和真实密钥不保存。资源身份/摘要不能通过启停修改；撤销保留条目作为 tombstone。相同身份和候选摘要的重复导入不改 revision/事件/启用状态；不同版本、摘要或授权字段冲突拒绝。已撤销资源不可通过重复导入或启用复活，重复撤销明确 `already_revoked`。

## 受信来源与提交边界

组合根的 `projectResourceSources` 是可信项目级目录端口：`getSource(projectId, sourceId)` 返回带 `projectId` 的明确本地文件描述，缺省为空。资源写请求只含 `sourceId`、`sourceDigest`、`candidateId`、`candidateDigest`，不接受任意路径、候选资源正文、operations、principal 或凭据值。

`select/importCandidate` 先核验 `settings.project.write` 和项目可见性及 expectedRevision，然后通过 F-002 的有界本地文件读取/发现器核验摘要、版本、能力与凭据引用。提交前在事务外再次读取固定摘要的源文件，短事务内重核当前 principal/范围/revision。启用同样重新核验来源与已保存候选摘要；禁用或撤销不依赖文件仍存在。文件读取、JSON 内容解析和候选摘要计算不进入 SQLite 写事务；凭据不解析、资源不加载。

SQLite adapter 复用 StateStore 的 insert-only/CAS 及同事务 `settings.project_created/updated` 审计。普通 settings 写入口不能直接提供资源段，省略资源段的设置替换在事务内保留现有段，防止旧客户端把授权删除或覆盖。审计仅增加可选 `resources: {count, digest}`；Core 事件投影与 HostClient 解码同步严格校验，不输出路径、凭据引用或候选正文。两侧未知键和非法摘要继续拒绝。

缺失/未知候选与来源为稳定 `not_found`；来源摘要变化、陈旧 revision、身份冲突、重复撤销为 `conflict`；来源跨项目为 `ownership`；非法请求和候选版本/能力/密钥字段为 `validation`。权限不足为既有 `forbidden`，不回退 owner。失败不更新资源配置或 revision；审计失败整组回滚。

## 执行快照边界

`snapshotForAttempt` 只选择 active 且 enabled 的资源，包含当前项目 revision、固定资源字段、摘要及既有 WorkAccess 安全操作集合；三个默认扫描开关全部为 false。快照及其嵌套数组/条目递归冻结，后续配置变更不追溯已有对象。本任务也通过真实已认领 Attempt 验证导入/撤销不改写 Attempt 输入、Run/Batch、Task、预算预占或租约。

生产 Run/Attempt 制品绑定与实际 Pi 加载核对属于 F-004；本任务没有宣称快照接口已自动接入 Runtime。资源的 Host 命令/receipt 与 CLI 入口属于 F-005/F-006。文件最后一次重核与数据库提交不具备跨系统原子性；后续加载仍须按固定摘要核验，不把可变化路径当成执行快照。可信项目模式不提供强 OS 文件沙箱。

## 验证与交接

开工基线 `b95f13a5bdbc7fb2c776ce551315bbad0fcce302`。最终代码身份见本任务 Git 提交与 Harness `progress.md` 的提交记录。完整日志/退出码位于 Feature workspace 的 `verifications/F-003/runtime-logs/`。

- 本地最终定向运行 3 文件、35 passed / 0 failed / 0 skipped，日志 `test-qwx_2rvg.log`，exit 0。其中 `test/modules/authorization/p06-3-f003-project-resource-service.test.ts` 为本任务 17 项，另两个文件是抽取安全操作常量直接关联的 `p04-2-work-access.test.ts` 与 `p06-3-project-resources.test.ts`。覆盖导入持久化/重开、版本及摘要冲突、来源缺失/漂移与受信目录摘要约束、CAS、启停/撤销、全部写操作授权、I/O 后重核、冻结快照、审计故障回滚、普通设置入口拒绝、真实双进程竞争、既有 Attempt 隔离、审计 Core/HostClient 往返、组合根和持久数据损坏。
- 最终类型检查：`test-_9q_dazq.log`，exit 0。最终模块边界：`test-o57_jz66.log`，444 个生产源文件、0 诊断、exit 0。构建与 Core/Host/CLI 产物冒烟：`test-qzcjmizd.log`，exit 0。
- 初始 RED 与调试失败日志保留；未把夹具错误算作需求 RED。引用式导入/设置复用的需求 RED 为 `test-ca8ihhta.log`，11 项失败、exit 1；受信目录摘要约束负例 RED 为 `test-4470k2r7.log`。首次构建 `test-1wtf7ih9.log` 暴露 ESM 初始化循环；安全操作常量抽至无依赖 `work-access-operations.ts` 后，保留原导出/取值并通过最终构建。
- 仓库 v2 索引 `test/index/phases/P06/features/P06-3/tasks/F-003.json` 是独立复验范围；Harness selection 引用该索引。上述 3 文件为本地通过，其余 9 个既有回归文件已选择但本地未运行，交 Nezha 独立验证。
- 未运行全仓测试、组合 verify、Phase/Feature 验收、真实模型或远程 MCP。受控竞争子进程在返回前已核验退出，临时资源按夹具 finally 清理。
