# 一次性规划 CLI

一次性规划使用 `planning` 顶层命令。命令只通过 HostClient 访问 Core；规划启动的 accepted 回执表示授权身份已持久化，不表示候选已生成、Feature 已交付或编码已授权。

## 启动规划

```text
shiploop planning start <featureId> --project <projectId> --phase <phaseId> --revision <int> --input <file> [--command-id <uuid>] [--json]
```

`--input` 是本次请求的有界 JSON 文件，顶层字段为：

- `requirementRefs`：需求制品引用数组，每项为 `artifactId`，可带 `contentHash`。
- `constraints`：规划约束字符串数组。
- `acceptance.criteria`：验收标准字符串数组。
- `strategy`：必须使用 `approvalMode: "manual"`，可用 `taskLimit` 限制候选 Task 数量。
- `budget`：本次规划的完整有限预算，由 Core 做深层校验。

`--revision` 是目标 Feature 的 CAS。空草稿 Feature 可以首次规划。启动输出会给出 `batchId`、`runId`、`planningTaskId` 和 `candidateId`，并明确候选仍在生成或等待审阅。规划 Run 的取消、暂停和恢复使用既有 `execution cancel`、`execution pause`、`execution resume` 命令；关闭 CLI 不会取消已接受的命令。

## 查看规划和候选

```text
shiploop planning list --project <projectId> [--feature <featureId>] [--limit <int>] [--cursor <id>] [--json]
shiploop planning get <candidateId> --project <projectId> [--json]
shiploop planning candidate <candidateId> --project <projectId> [--json]
```

`list` 返回规划上下文摘要、候选摘要身份、Run 状态和决定状态。`get` 返回 Run、planning Task、Attempt、预算、执行状态和决定来源。`candidate` 返回候选的 `candidateDigest`、摘要、Feature/Task 描述、难度、依赖、验收计划及定向 verification；候选尚未发布时显示 `pending_generation`。

## 批准或拒绝候选

```text
shiploop planning approve <candidateId> --project <projectId> --digest <sha256> --revision <int> [--reason <text>] [--command-id <uuid>] [--json]
shiploop planning reject <candidateId> --project <projectId> --digest <sha256> --revision <int> --reason <text> [--command-id <uuid>] [--json]
```

批准和拒绝都必须显式提供候选身份、`candidateDigest` 和 Feature `revision`。批准只原子应用候选业务计划，不自动开始编码；拒绝保存原因并结束当前规划，不自动重新规划。旧摘要、旧 revision、跨项目或不可见候选由 Core 拒绝。

重复提交使用同一个 `--command-id` 时复用原命令回执。响应丢失会先查询该命令的回执，再在有限范围内使用同一信封重试；不会隐式取消、批准或开始新的规划。

`--json` 时 stdout 只输出一个结构化结果，诊断写入 stderr。退出码沿用 CLI 约定：0 表示成功，1 表示业务拒绝或操作失败，2 表示输入错误，3 表示连接或协议错误。
