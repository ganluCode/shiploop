# P05-7 F-004 确定性集成应用服务

`createDeterministicIntegrationService().start()` 在 Core 内连接冻结计划、既有 Git operation 和独立 Git 工作区。请求只带 project/operation/command 身份、Feature revision 与冻结输入摘要；Git 路径、身份、批准状态、预算和资源证据只能来自可信 Core 装配。

## 事务与重放

1. 在短 `AtomicCommandStore.transact` 内重读 P05-6 冻结计划，核对输入集合、固定顺序、验证范围、target base、前置交付 SHA/证据和前置 Feature 的完成状态/revision，以及 successor、Run/Batch 和 repository binding 的归属。
2. 原累计 Batch 预算与绝对 deadline 继续生效。父固定 Batch 的批准范围/预算及当前交付证据有效性，由 `readAuthorization(tx, request)` 从 Core 事实重核；该同步 reader 不能执行 Git、文件或网络 I/O。`approvalCurrent` 包含 branch HEAD 漂移导致旧交付证据失效的判断，不能用当前 HEAD 替换冻结 SHA。外部进程停止核验在事务外执行，再在同一意图事务中重读身份。
3. 集成工作区必须持有 `project:<projectId>:worktree:<execution-integrationId>` 排他资源及项目 `feature-code` 共享门控，沿用 P05-5 资源声明、租约与 ownerVersion。未确认停止、过期/隔离租约、其他排他持有者或 owner 变化均拒绝。
4. 同一事务注册唯一 Git operation、绑定内部 commandId，并使用既有 `updateIntegrationPlanResult` 将源计划关联到 pending operation；任何一步失败整组回滚。只有新注册成功的调用能执行 Git。
5. 每次 worktree 创建、merge 和 commit 前都调用 `beforeWrite`，重新执行同步 Core 核验；锁等待不持有数据库事务。每步 Git 完成后通过 `onStep` 在另一短事务保存实际 parent/tree/commit。
6. 合并完成仅返回 `pending_verification` 候选，operation 保持 pending，源计划仍不能解锁后继。工作区和前置独立交付事实保留；不合 main、不调用模型、不预占 Runtime 启动、不自行清理。

同 commandId 不同摘要拒绝；同意图重复调用或重建服务读取持久观察结果。另一个服务/数据库连接遇到已登记但缺少完整观察的 operation，只返回 `reconciliation_required`，不会重复创建、merge 或 commit。未知停止、冲突和失败观察同样只重放证据。

## 持久化与后续消费

迁移 v44 只追加 `git_integration_commands` 和 `git_integration_observations`。两表无独立 operation 生命周期，分别保存内部命令关联和追加式观察事实，以复合外键引用 `git_operations`。命令按项目/commandId 唯一，观察按 operation/sequence 唯一；更新、删除被触发器拒绝。观察重读校验固定输入顺序、真实 parent 链、owner、路径、repo、tree、计划与提交身份，损坏 fail-closed。

不把私有工作区句柄放进公开 `state_events`、Host 回执或 SSE。Host/CLI 的版本化命令鉴权、对外回执和脱敏仍由 F-007 接线。

P05-6 计划身份与 P05-7 执行身份使用不同摘要域，因此不能假定两者 ID 或 inputDigest 相等。既有 operation 的不可变 `budgetSnapshot` 绑定 `sourcePlanId`、`sourcePlanRevision`、`predecessorRevisions` 和 `ownerVersion`。源计划开始 pending 后只允许本次受控 revision +1，其他修改均拒绝。

F-005 应消费 journal 的 `pending_verification` 候选，并按上述 `sourcePlanId` 使用既有计划结果事务完成组合验证与后继门控；不能把 execution integrationId 当作源计划主键，不能把带 `inputDigest` 的执行结果原样写入 P05-6 `IntegrationResult`。F-006 对只有意图/部分步骤/未知结果的 operation 核对真实 Git 后再决定恢复；`start` 不承担不确定副作用的恢复重放。

Core 公共入口只导出端口与应用服务；已移除前序 F-003 的 fs adapter 越层导出。Git adapter 保留在 adapters 路径，现有调用方均直接从该路径导入。

## 验证与影响范围

可信索引：`test/index/phases/P05/features/P05-7/tasks/F-004.json`。Harness selection 只引用该索引。

| 范围 | 证据与责任 |
| --- | --- |
| F-004 应用流程 26 项 | 本地通过：真实 SQLite、跨连接竞争、真实 Git A/B 顺序与 parent/tree、main 保持、冲突/脏状态/基线漂移、计划与前置 revision、批准/预算/owner/租约/旧 writer、服务重建、未知结果、回滚与损坏拒绝 |
| F-003 Git adapter 4 项 | 本地通过：既有正常/失败/清理场景；新增 guard/onStep 不替换底层流程 |
| v44 定向 schema 2 项 | 本地通过：v43 升级、保留历史、重复升级、FK/CHECK 与整组回滚 |
| Schema/Drizzle 对齐 65 项 | 本地通过：新增表列/检查/索引/外键纳入既有一致性断言 |
| TypeScript 与分层扫描 | 本地通过；分层首次发现前序入口越层导出后定向修复 |
| Git operation 持久化、源计划存储/门控、迁移器 | 已登记完整测试文件，交 Nezha 独立回归，本地未重复执行 |
| 全仓/Phase/真实模型/最终组合验证与恢复 | `not_run`；属于另行验收或后续 Task |

完整日志和真实退出码在 Harness `verifications/F-004/runtime-logs/`。初始 RED 为服务模块缺失；一次类型错误和一次分层错误的原始日志保留，修复后复验。

- 最终应用 26 项：`test-a107ykcy.log`，退出 0。
- 应用及 F-003 adapter：`test-lrz5n_gn.log`，当时应用 25 项 + adapter 4 项，退出 0；之后增加的租约竞争用例已在最终应用文件复验。
- schema 两文件及当时应用：`test-vf3335kr.log`，88 项，退出 0；之后 schema 未改动。
- 类型：`test-oyk73hh7.log`，退出 0。
- 分层修复复验：`test-epe4cllq.log`，386 文件、0 diagnostics，退出 0。

上述本地测试按最终覆盖去重为 97 项；不同轮次的执行数不累加为新增覆盖。独立 Verifier、Feature gate 和阶段验收仍分别保留其结论。

## F-004 返工：迁移器表清单同步（attempt 2）

上次独立验收执行原索引 8 文件，共 124 项，结果为 123 passed / 1 failed。唯一失败是 `sqlite-migration-runner.test.ts` 的空库迁移完整表清单尚未加入 v44 的 `git_integration_commands`、`git_integration_observations`；原始失败证据保留在 Harness `verifications/F-004/b1a2e8727f01492abd96470f4e585997/verification.json`。

本次仅补齐该完整表清单，保留精确相等断言、既有业务实现、迁移内容和 8 文件测试选择。定向复验 `test/modules/storage/sqlite/sqlite-migration-runner.test.ts`：16 passed，exit 0；日志 `verifications/F-004/runtime-logs/test-ktfl11ap.log` 及其 `.exitcode`/`.json` 旁文件绑定本次 invocation `12deba48ad5b4edbadb2d2a622485330`。其余索引文件交 Nezha 独立复验，本次不重复运行未改动组；不据此宣称 124 项已经全部复验通过。
