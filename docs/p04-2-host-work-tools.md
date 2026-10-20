# P04-2 F-006 Host Work 窄业务桥接

F-006 将 F-005 的 `task.read`、`candidate.submit`、`evidence.submit` 接到 loopback Host 的 `POST /v1/work/tools`，并导出 `createWorkToolClient({ port, token }).invoke(envelope)` 供受控工具/CLI 适配层调用。请求仍使用 Core schemaVersion=5 信封；身份字段只是范围断言，不能创建主体或授权。Core 操作、回执和幂等规则见 [Work 通道契约](p04-2-work-tool-channel.md)。

可信装配入口：

- `CoreApplication.createWorkToolChannel(authority)` 使用当前 writer 的同一 SQLite session 装配 atomicStore、Attempt、DAG，以及已有 Artifact verifier、候选校验和目标解析器。不会开启另一套业务存储或引入新的命令执行器。
- `startHost({ ..., workToolAuthority: { currentBinding, candidateContext } })` 只接受可信代码注入。回调必须独立读取当前 principal、Work、Host、invocation、fence、授权时刻及已批准策略/受管工作区，不得从 HTTP、CLI、项目文本、模型输出或 native sessionId 重建。Host 额外校验回调中的 hostInstanceId 必须等于实际当前实例。
- `RunningHost.workTools.issue(access, binding)` 仅交给可信控制器。`binding` 来自上述独立 authority；`access` 只是经核验的声明。返回 `{ token, revoke() }`；工具侧只接收当前端口和受限 token。注册表只保存 token 的 SHA-256 索引，token 使用 256 bit 随机值，最多 1024 个在用映射。
- 缺省不配置 authority 时仍提供窄路由，但没有可用授权，签发失败，调用返回受控 unauthorized。不会把 local-owner 自动绑定到 Work 通道。

可信控制器的装配顺序如下；`liveAuthority`、`access` 和 `liveBinding` 必须已由当前可信 Work/策略服务提供：

```ts
const host = await startHost({ dataRoot, capabilityCatalog, workToolAuthority: liveAuthority });
const grant = host.workTools.issue(access, liveBinding);
const tools = createWorkToolClient({ port: host.port, token: grant.token });
const result = await tools.invoke(envelope);
// Work 结束或主动撤销时：
grant.revoke();
```

端口/凭据交接需要受控工具通道。此任务不新增命令行主体、角色、权限、SQL、路径参数，也不把 owner token 交给 Runner。Runner 侧的工具注入及纵向验证由后续 F-007 接续。

传输约束沿用现有 Host：只监听 `127.0.0.1`，精确核验 Host 头，拒绝 Origin，限制 JSON 请求/响应体积，不接受 query 参数，响应 `no-store`。Work 只认证该 Host 内存中的受限凭据，不使用 owner Bearer；反向也不能用 Work token 调用通用命令、项目、回执或生命周期接口。未知/管理/SQL/文件操作返回 unsupported，非法字段返回 invalid_input；授权错误返回 forbidden。错误映射使用固定分类，不回显 caller 字段名、Artifact 路径、存储错误正文或不可见项目资料。

`task.read` 返回当前绑定 Task 的 id/title/status/acceptance。提交返回已有 completed/rejected 回执，completed 只表示提交事实已记录，`verificationPassed=false`。客户端验证回执结构、commandId、operation、项目范围及 HTTP 状态；业务 rejected 回执可结构化读取。其他错误抛 HostProtocolError。客户端直接使用显式端口和受限 token，依赖中没有 discovery、owner token 文件读取、Host launcher、提权或自动重试。

每次查询、提交、重放及异步校验后的最终事务继续由 F-005 核验当前主体、可见性、允许操作、有效期、Run/Task/Attempt、Host/invocation/fence/lease 和执行终态。撤销立即移除凭据并 revoke Core bridge。Host 进入 quiescing/stopping、close 或启动失败时撤销全部映射，在途提交在最终事务前拒绝。注册表不持久化；新 Host 不加载旧 token，也不接受旧 Host 身份的重新签发，恢复后需基于新的可信 Work 身份重新授权。

幂等键沿用 principalId + commandId。相同摘要重放返回原回执并置 replayed=true，不再提交；不同摘要返回 conflict。已失效的授权不能借历史回执绕过重新核验。新的可信授权可以在相同主体及仍有效的业务身份下读取原稳定回执。

任务索引：`test/index/phases/P04/features/P04-2/tasks/F-006.json`。本地运行 Host 新增 11 项和 F-005 通道 13 项，24/24 通过；覆盖真实 SQLite/Artifact/候选验证、并发重放、冲突、脱敏、身份伪造、跨范围、授权撤销与过期、lease/fence/终态、在途停止、注册表重建及实际 startHost。索引中的其他既有回归交 Nezha 独立执行。Core/Host 定向 TypeScript 构建通过；全仓类型检查仍受既有 `test/modules/runtime/p04-1-pi-f007-contract.test.ts:77` TS18046 影响。没有运行全仓测试、组合 verify、Phase 验收或真实模型。
