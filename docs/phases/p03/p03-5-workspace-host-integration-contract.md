# P03-5 / F-011 Workspace Host 接线与状态查询契约

状态：F-011 实施契约。前置：F-005/F-006（准备与恢复）、F-007（保留）、F-008
（清理资格）、F-009（清理执行）、F-010（人工丢弃）的端口/适配器契约不变；
本文只冻结「组合根装配 + Host 授权/幂等通道 + 只读状态查询」的接线决定。

## 1. 范围与边界

- 在既有 Core 组合根（`adapters/composition.ts`）装配 workspace 栈：
  `WorkResourceAccess`、`PreparationWorkspaceAuthority`、`TaskClaimStore`、
  准备/保留/清理/丢弃应用服务与只读查询门面；Host 只经既有
  `POST /v1/commands` 与查询路由暴露，不新增 Host、命令队列或事件工作流。
- 已认领 Attempt 的准备入口 = `CoreApplication.workspacePreparation.prepare`，
  输入身份来自 P03-4 已提交认领回执（claimKey/Attempt/owner/host/
  executionVersion），复用 F-005/F-006 交接；不认领、不启动 Runtime。
- 未装配 Runtime/Verifier/提交闭环：本任务不接线调度器消费者与
  `executionDispatchSignal`（`execution.start` 的 Run 仍 queued +
  `scheduler_not_assembled`，能力缺口保留、不认领空 Attempt、不启动
  Fake/Pi）；准备/保留/清理服务作为已装配窄端口暴露，由后续 Runtime
  驱动任务消费。`workspace.discard`/`workspace.discard.preview` 是人工
  显式操作，随本任务真实接线并宣告。
- HostClient/CLI 入口与线响应校验属 F-012；本任务只扩展 Host 服务端
  路由、握手能力白名单与 Core 命令信封校验。

## 2. 组合根装配（Core）

`openCoreApplication` 追加暴露（全部窄端口/应用服务，不暴露会话/驱动）：

| 成员 | 内容 |
| --- | --- |
| `workResources` | `createSqliteWorkResourceAccess`（authority + 可信停止核验器） |
| `workWorkspaceAuthority` | `createWorkWorkspaceAuthority`，`authorizedRoots=[dataRoot]` + `preparationPaths=PathService` |
| `taskClaims` | `createSqliteTaskClaimStore`（同一 authority） |
| `workspacePreparation` | F-005/F-006 准备服务（每次调用按输入 projectId 构造受界 fs 适配器） |
| `workspaceRetention` | F-007 保留服务（无文件系统变更；可信停止核验器注入） |
| `workspaceCleaner` | F-009 清理服务（每次调用按输入 projectId 构造受界 fs 适配器） |
| `workspaceDiscard` | F-010 丢弃服务 `preview`/`confirm`（同上按调用构造） |

可信装配决定：

- **授权根**：worktree 目标一律在数据根内（PathService 派生）；源仓库是
  已登记绑定的规范路径——`createWorkWorkspaceAuthority.verify` 增补一条
  规则：候选路径 realpath 后等于绑定记录自身 `canonicalPath` 即视为已授权
  （绑定登记时已审查 + 每次重新 realpath/repoIdentity/gitCommonDir 核验），
  其余路径仍须在 `authorizedRoots` 内。工作区检查器 `authorizedRoots` 恒为
  `[dataRoot]`（检查目标只有 worktree）。
- **进程身份确认**：`confirmProcessIdentity` 按调用构造，闭包绑定当次
  projectId，先把 `{schemaVersion:1, processIdentity}` 作为
  `workspace_evidence` Artifact（locator `evidence/<launchId>.json`）持久
  提交再放行变更性 argv（满足「durable identity commit before release」）；
  不允许无持久化的纯内存确认进入生产装配。
- **停止核验**：`verifyPreparationStop`/`verifyCleanupStop`/
  `verifyDiscardStop` 与保留的 `WorkResourceStopVerifier` 均接线到同一
  `CommandProcessPort.recoverStop`（整组缺席证明；非 macOS 恒
  `confirmed:false` → 保留/隔离，不释放）；`finalize` 无额外外部收尾，
  恒 `true`（真实证据是整组缺席证明）。
- **证据发布**：`publishEvidence` 不在任何 SQLite 事务内调用（装配不变量
  断言），`workspace_evidence` Artifact 有界（4 MiB）。
- 查询/预览只读：不扣预算、不启动写代码进程、不写业务状态（预览发布的
  不可变证据 Artifact 是唯一持久化，且只经显式命令触发）。

## 3. 命令面（既有 POST /v1/commands）

信封版本/时效/幂等/主体纪律不变；新增一个操作（能力位复用
`workspace.discard`，APP_CAPABILITIES 不变）：

| operation | scope | mutation | 说明 |
| --- | --- | --- | --- |
| `workspace.discard.preview` | project | create | 只读预览 + 不可变证据发布；completed 回执携带预览（绑定摘要/有界条目/不可逆影响/blockers/证据引用）。信封层只要求 JSON 对象 payload；`{featureId}` 深校验在应用层。 |
| `workspace.discard` | project | create | F-010 人工确认（payload 深校验在应用层；本任务接线）。 |

- `workspace.discard.preview` 走通用命令事务：事务外预览（授权 → 只读检查
  → 有界摘要 → 证据发布），事务内只持久化 completed 回执（与
  `execution.preview` 同一纪律）；重放返回原回执，不重复发布。
- `workspace.discard`（确认）不经通用回执事务：F-010 存储在 begin 事务内
  以真实 `principalId + commandId` 持久化用户回执（幂等锚点，请求摘要 =
  `computeWorkspaceDiscardRequestDigest(存储输入)`，该纯函数移入
  `ports/workspace-discard.ts` 供命令层复核）。命令层顺序：
  1. 既有回执查找（同主体同 commandId）：命中则重算摘要比对——不一致
     409 conflict（`command_reused`），一致交回原丢弃服务：终态仅回放，pending
     按持久 journal 与实际 Git 状态核对恢复，不能把意图回执当作最终结果；
  2. 未命中：时效核验 → 事务外执行确认编排（应用层主体/能力/可见性/
     payload 深校验 + begin 门禁 + Git 锁内复核删除 + 回执提交）→
  3. 回读用户回执返回。
  begin 前门禁失败（预览过期/占用/停止证据缺失/状态不可丢弃/身份冲突）
  抛出结构化 conflict/forbidden（零回执、零删除，与 execution.start 冲突
  同一纪律）；begin 后业务拒绝由 F-010 记录为 failed operation。
- 并发重复提交：begin 为同一 commandId 复用同一 operation；终态回放不再
  删除，pending 经短 Git 锁互斥。未取得锁的请求得到受控 resource_busy/conflict，
  不隔离正在持锁执行的操作。不同参数同 commandId 在摘要比对处 409。
  同命令重试标记 replayed=true；completed 回执仍不等于丢弃操作成功。
- 未装配丢弃服务（理论上不可能的生产装配除外）→ 501 unsupported。
- 命令 completed ≠ 丢弃成功；实际结果经 workspace 操作查询读取。

## 4. 查询面（只读，能力位复用 `project.read`）

新增四个查询操作（Core `WORKSPACE_QUERY_OPERATIONS`，Host 握手能力同名单
向同步；v5 内增量接线变化，沿用 P03-3/P03-4 先例不升版）：

| operation | 路由（全 GET + Bearer） | 参数 |
| --- | --- | --- |
| `workspaces.list` | `/v1/workspaces` | `projectId` 必填，`featureId`/`limit`/`cursor` 可选 |
| `workspaces.get` | `/v1/workspaces/:featureId` | `projectId` 必填（查询串） |
| `workspace.operations.list` | `/v1/workspace-operations` | `projectId` 必填，`featureId`/`limit`/`cursor` 可选 |
| `workspace.operations.get` | `/v1/workspace-operations/:operationId` | `projectId` 必填（查询串） |

- 授权顺序：能力核验 → 身份形态校验 → 项目可见；跨项目/不存在统一
  not_found（不泄漏存在性），路径参数原样传入 Core 校验（400
  invalid_input），未知/重复查询参数 400 定位 `query.<字段>`。
- 公开投影不含绝对路径与内部哈希（剔除 `canonicalPath`/`gitCommonDir`/
  `repoIdentity`）：workspace 视图含 id/projectId/featureId/runId/attemptId/
  status/revision/branch/baseCommit/headCommit/codeDigest/绑定身份/准备
  operationId/时间戳；`workspaces.get` 另含准备 operation 与最新 operation
  的完整视图（准备阶段/保留/复用/隔离/清理原因）。
- operation 视图含 kind/executionStage/status/revision/principalId/
  commandId/requestDigest/result（证据与错误引用、已知耗时/退出码，未知
  为 null）+ 实际回执引用 `{commandId, resultRef, status, reason}`（reason
  从持久回执结果白名单解析，缺失为 null；绝不回显正文/路径）。
  operation 的 principalId/commandId 是原用户命令身份；receipt 是其当前
  receipt_id 指向的持久回执。终态可能指向 core-workspace-discard-result
  的内部结果回执，不能伪造成原用户意图回执，两层审计分别保留。
- 列表分页：limit 默认 100/上限 500，键集排他下界按 id 升序；不透明游标
  `wscur_v1_` 绑定数据根身份指纹 + scope（kind/projectId/featureId），
  跨根/跨项目/跨 Feature/畸形游标一律 invalid_cursor，绝不当从零读取。
- 权威状态来自 SQLite 一致读视图（BEGIN DEFERRED）与持久回执/证据引用；
  不解析 logger；查询零写入、零事件、零预算、零进程。

## 5. 既有面不回退

- 信封 schemaVersion 5、发现版本 1、配置 payload 版本 2 不变；旧版本
  握手/信封继续 400/426；能力清单只增不改语义（冻结测试同步更新计数）。
- 既有项目/Artifact/回执/baseline/事件读取负例全部保留；既有路由未匹配
  形态（含 `/v1/workspaces/*` 多段、POST 到查询路由）仍 404/405。
- Host 生命周期：本任务不新增常驻定时器/后台循环；CoreApplication.close
  语义不变（fs 适配器无持有资源，Git 锁按 operation 释放）。

## 6. 验证

- `test/modules/workspace/p03-5-workspace-host-integration.test.ts`：真实临时 Git/SQLite/
  Host（startHost + 真实 HTTP）。组合根纵向：命令面真实链路
  （register→phase→import→decide→input.prepare→preview→start）→ 认领
  （CoreApplication.taskClaims + authority）→ 准备（workspacePreparation，
  真实 worktree 落盘、源仓库 HEAD/refs/脏内容不变）→ 保留（not_started
  释放）→ 丢弃预览/确认命令（目录确证删除、分支/审计保留）→ 四查询
  读取基线/分支/摘要/阶段/原因/回执引用。
- 负例：未认证 401 不可区分、跨项目折叠 not_found、同 commandId 不同
  参数 409、并发重复提交幂等、畸形/未知版本消息 400、未知/重复查询参数
  400、坏游标 invalid_cursor、未认领/伪造身份准备拒绝且零 Git 副作用、
  Run 保持 scheduler_not_assembled（无空 Attempt/无 Runtime 启动）。
- 受影响回归：commands/authorization 契约、query/schedule 查询、Host
  路由/握手能力、core-assembly、F-005~F-010 既有 workspace 测试。
