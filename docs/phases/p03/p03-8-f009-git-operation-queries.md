# P03-8 F-009：Git 意图、实际提交与操作回执查询契约

Feature delivery 的 Git 事实经既有授权查询面只读暴露。协议保持 protocolVersion 1 /
schemaVersion 5，握手在 v5 能力视图内追加两个查询宣告（接线后宣告，不漂移）。
能力位复用 `project.read`，不新增能力位；Host 不做业务授权，全部能力/可见性
判定在 Core 应用层。

| Operation | Route | Behavior |
| --- | --- | --- |
| `git.operations.list` | `GET /v1/git-operations?projectId=&featureId=\|runId=&limit?=&cursor?=` | 同项目 Feature 或 Run（父级二选一）的 Git 操作分页：稳定 id 升序、有界分页（默认 50/上限 200）、`plcur_v1_` 受控游标绑定数据根 + 项目 + 父级。 |
| `git.operations.get` | `GET /v1/git-operations/:operationId?projectId=` | 单次操作的完整意图 + 实际事实 + 权威回执投影。 |

## 公开记录

公开记录是 F-002 持久事实（迁移 v26 `git_operations`，已经
`validateGitOperationRecord` fail-closed 复核）的脱敏投影：提交边界
（`expectedHead`/`candidateTree`/`codeDigest`）、实际事实
（`actualParent`/`actualCommit`/`actualTree`/`exitCode`/`durationMs`）、
验证/审批引用（`verificationRefs`/`approvalRefs`，kind/id/digest）、
用户身份来源（`gitIdentity`，用户明确配置并确认，`confirmed` 恒 true，不回落
开发机全局身份）、Runtime/provider/model 独立审计（`runtimeSource`）、
消息、政策摘要、状态/原因码、`deliveryStatus` 与权威回执。

- `actualParent`：succeeded 时恒等于 `expectedHead`（F-003/F-004 执行/核对已
  验证实际提交的唯一 parent）；其余状态无已核对 parent（null，不冒充事实）。
- 待核对绝不显示为成功：`pending`（回执缺失）无回执/无终态事实；`unknown`
  恒 `deliveryStatus='pending'`、actual 事实为 null；`no_change` 的
  `actualCommit` 等于预期 HEAD，不捏造提交。
- 脱敏纪律：不投影 `worktreePath`（开发机固定绝对路径）、`ownerId`/
  `hostInstanceId`（内部执行归属），不携带凭据、敏感环境值或原始堆栈。

## 错误与不变量

- 跨项目读取、无权限主体、不可见项目：`project.read` 缺失先行 `forbidden`；
  不可见与不存在/跨项目目标统一 `not_found`（同一形状，不回显归属或存在性）。
- 父级必须且只能为 Feature 或 Run 之一；非法游标/跨父级/跨项目重放一律
  `invalid_input(invalid_cursor)`，绝不当从零读取；超限 limit（1..200 之外）、
  未知键（含提权字段）在任何 SQL 之前 `invalid_input`。
- 查询零写入、零事件、零续租，不触发 Git 或执行；真实 SQLite 重开后查询
  得到相同意图与 Git 事实（一致读视图）。
- HostClient（`listGitOperations`/`getGitOperation`）复用既有查询模板：
  输入校验（父级二选一）先于任何请求；响应经 `validateAppQueryResponse`
  冻结字段集精确键校验与持久 CHECK 同源的生命周期不变量复核（pending 携带
  回执、unknown 携带 actual 事实、succeeded tree 与候选 tree 不符、未知键等
  一律 `response_malformed`）；归属与请求不符拒绝（`scope_mismatch`）。

## 实现入口

- `packages/core/src/ports/git-operation-query.ts`（纯契约：公开形状、父级
  校验、只读窄端口）；游标 scope 扩展在 `ports/queries.ts`
  （`feature-git-operations`/`run-git-operations`）。
- `packages/core/src/adapters/sqlite/git-operation-query-store.ts`（真实
  SQLite 只读装配；一致读事务、可见谓词下推、id 键集分页）；门面接入
  `adapters/sqlite/query-store.ts`。
- `packages/core/src/application/query-service.ts`（`listGitOperations`/
  `getGitOperation`；能力/可见性/分页/游标单一权威）。
- Host：`contract/constants.ts`（路由）、`contract/errors.ts`（APP_OPERATIONS）、
  `contract/lifecycle.ts`（能力宣告）、`runtime/app-transport.ts`（路由/白名单/
  分发）；HostClient：`client/app-wire.ts`（线校验）、`client/app-client.ts`。

Task-local 验证在 `test/modules/delivery/p03-8-f009-git-operation-queries.test.ts`（真实
SQLite + 真实 Host 纵向）：正常/no_change/failed/unknown（核对后记录）/
pending（回执缺失）均有查询断言，含授权/分页/游标/脱敏/重开一致性。
