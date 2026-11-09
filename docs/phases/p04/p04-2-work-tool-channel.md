# P04-2 F-005 Work 受限业务工具通道

Core 入口为 `createWorkToolChannel`（`packages/core/src/application/work-tool-channel.ts`，从 Core 公共入口导出）。允许操作沿用 F-001 的 `task.read`、`candidate.submit`、`evidence.submit`。不新增 Host 命令、管理能力、SQL 或文件读取入口，也不修改数据库 schema。

可信 Host/Core 调用 `channel.bind(access, binding)`。access 使用 F-001 的访问声明；binding 独立来自当前认证、执行身份和已批准策略。Host 保存返回桥接的 `revoke`，只向 Runner/工具适配层传递 `invoke` 函数。请求不能选择 principal 或创建授权；任何 actorId/principal/role/capabilities 等未知正文键均拒绝。

装配依赖 `currentBinding(context)` 每次必须读取当前可信 authority，返回当前 principal、Host、项目、Work 身份、invocation、executionVersion、策略和当前时刻；返回 null 即撤销。不能把 context、请求、manifest 或原生 sessionId 反向包装为该 authority。`candidateContext` 也只从 Core 已批准策略及当前受管工作区取得 policy/workspaceRoot/codeDigest。Attempt、DAG 与 atomicStore 必须共享同一 SQLite session，使身份和回执检查处在同一短事务快照中；异步制品读取不占用业务写事务。

签发与每次调用核对 F-001 声明、project.read 能力和项目可见性，再核对数据库中的 Run/Task/Attempt 归属、当前 Task 执行 fence、Attempt invocation/Host/执行版本、lease、执行状态及父 Batch 状态。仅 executing Attempt 和 running Run/Task/Batch 可用。异步校验结束、提交回执前再次核对。到期时刻即拒绝；撤销、恢复换 invocation/Host/版本、终态或不可见都不能借历史 commandId 重放绕过。grantId 在该 Core 通道实例内不允许重复绑定；重启后由可信 Host 重新签发并绑定当前身份，不从 Runtime 恢复旧授权。

请求复用当前 schemaVersion=5 命令信封及其字段/时效规则，例如：

```json
{
  "schemaVersion": 5,
  "commandId": "7e3a213c-fde0-4e78-a5db-3d286c63318f",
  "issuedAt": "2030-03-17T17:48:20.000Z",
  "operation": "candidate.submit",
  "scope": { "kind": "project", "projectId": "<current-project-uuid>" },
  "payload": {
    "identity": { "purpose": "work", "runId": "<run>", "taskId": "<task>", "attemptId": "<attempt>" },
    "invocationId": "<invocation>",
    "executionVersion": 1,
    "artifactId": "<managed-ready-artifact-id>"
  }
}
```

payload 身份是请求的范围断言，必须逐项等于桥接绑定的可信身份，不授予权限。查询 payload 不含 artifactId。提交只接受受管 Artifact ID；正文、路径、locator、SQL、command、argv、环境或任意执行选项不能进入工具协议。

- `task.read` 返回 `{ operation, task: { id, title, status, acceptance } }`，只读取绑定的当前任务。不返回输入快照、配置、仓库路径或 Artifact 正文；查询不持久化回执。
- `candidate.submit` 调用现有 `createVerificationCandidateValidator().validateCandidates`，不另写候选规则。受信 policy、codeDigest、工作区和身份由 Core 提供；受管 Artifact 的 project/ready/hash/size 经现有 verifier 核对，校验结果与事务内索引身份再次比较。有效结果只记录 candidateDigest、moduleCount 和制品身份；候选业务拒绝记录统一 rejected 回执及受控原因。
- `evidence.submit` 核验受管 ready Artifact，把其 ID/hash/size 与当前 Work 身份作为提交事实保存在 completed 回执中。不导出 Artifact 正文或内部路径。

两种提交复用统一 completed/rejected 回执、requestDigest、resultRef、`decideCommandReplay` 和原子回执存储。幂等键仍为 principalId + commandId；摘要使用现有规范化语义，覆盖 operation/scope/身份/payload/revision/时间。相同请求重放返回原结果并置 replayed=true；同 commandId 不同摘要冲突，并发在最终事务再检查。新请求的结构、授权和命令时效拒绝不持久化回执；既有回执重放先核对当前授权，再按既有语义解析摘要。回执词汇单独扩展 ReceiptOperation，通用 `validateCommandEnvelope` 的 Host 操作白名单保持原有范围。

completed 仅代表提交已记录。结果显式 `verificationPassed: false`，不标 Task passed、不审批、不改预算、不创建批次、不修改或释放锁/工作区。执行检查、P03 full_fallback 门禁、人审和交付仍由既有 Core 流程处理。Runtime 接线和纵向验证由后续任务继续。

测试与受影响回归索引见 `test/index/phases/P04/features/P04-2/tasks/F-005.json`。本地只运行本任务聚焦测试；受影响的既有回归交由 Nezha 独立执行。日志及本地类型检查限制见 Harness progress.md。
