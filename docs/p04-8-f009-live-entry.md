# P04-8 F-009：显式授权的 Pi live 工具

`npm run accept:p04:live -- --approval /absolute/private/approval.json` 是独立、手工调用的标准 Pi SDK 小样本工具。普通 CI、Task 索引、`accept:p04` 离线执行均不会调用它。无参数调用退出 2，输出 `status=not_run, realCalls=0`。没有显式授权或对应真实证据的场景始终保持 **not_run**。

工具只支持一个临时 Git 仓库的一次 Attempt，将唯一跟踪文件 `greeting.txt` 从 `hello\n` 改为 `hello pi\n`。模型只能调用 `read_greeting`、`write_greeting` 两个同步文件工具；工具没有路径参数，不创建外部进程。标准工具、Bash、Skills、MCP、扩展、上下文文件、缓存预热、自动压缩和自动重试均关闭。不自动重试或切换 provider/model；首版备用策略必须显式为 `[]`，其他资源/认证形式明确拒绝。

这是独立 SDK 探针：`runId/taskId/attemptId` 是本次探针的关联身份，**不是 Core 数据库中的业务 Run/Task/Attempt**。输入、工具和终态证据按这些身份关联；`coreBusinessAcceptance=not_run`，不能据此宣布 Core 调度、Recorder、预算持久化或阶段闭环已通过。后续真实阶段验收仍须核对 Core Work 链路和独立人工门槛。

## 获准输入

负责人先准备一个真实临时仓库：位于操作系统临时目录下、独立 `.git` 目录、无 remote、干净 HEAD，仅跟踪包含 `hello` 和换行的 `greeting.txt`。使用规范绝对路径；macOS 的 `/var` 路径需先解析为实际路径，符号链接和已有报告目录会拒绝。报告目录位于仓库外，与仓库互不包含。工具不会创建/批准授权、查找本机登录、读取用户凭据目录或推断批准的 provider/model。

仓库提供 [默认拒绝的输入模板](../acceptance/p04.live.example.json)，其中 `approved=false` 且已过期；不能将模板视为授权。以下是输入结构示意，**不是可执行授权**；所有占位值由负责人明确确认后填写。`expiresAt` 是未来的 UTC 毫秒，`expectedCommit` 是该临时仓库的当前 SHA。不要在 JSON 中写 API key。

```json
{
  "schemaVersion": 1,
  "authorization": {
    "approved": true,
    "id": "owner-approved-live-id",
    "expiresAt": 0
  },
  "provider": "APPROVED_PROVIDER",
  "model": "APPROVED_MODEL",
  "authentication": {
    "kind": "environment",
    "sourceRef": "approved-api-key-reference",
    "variable": "SHIPLOOP_APPROVED_API_KEY"
  },
  "repository": "/canonical/temporary/repo",
  "expectedCommit": "REPLACE_WITH_40_CHARACTER_SHA",
  "resources": ["read_greeting", "write_greeting"],
  "fallback": [],
  "budgets": {
    "maxAttempts": 1,
    "maxRequests": 3,
    "timeoutMs": 60000,
    "maxInputTokens": 12000,
    "maxOutputTokens": 1024,
    "maxTokens": 40000
  },
  "scenario": "change",
  "reportDir": "/canonical/temporary/new-live-report"
}
```

获准认证引用只解析指定环境变量；外层不继承其他供应商密钥、npm 配置或 `NODE_OPTIONS`。秘密经独立子进程的最小环境交接，在构造 SDK 前删除环境项，SDK 使用内存 credential/model store 和内存会话，不写认证文件或原生 prompt 历史。凭据不进入 prompt、argv、输入快照和普通日志；任意 SDK 错误正文和 stderr 不写报告。证据写入前过滤秘密原文、JSON 转义、URL 编码、Base64 和 Bearer 形状。此边界不构成 OS 沙箱。

## 预算、检查与交付

每次 SDK 模型请求先核对 provider/model、授权到期、绝对 deadline、请求数和累计 Token 预占；完整预占 `maxInputTokens + maxOutputTokens`，未知/失败用量不退还。上下文按 UTF-8 字节数再加 4096 余量限制，输出通过 `maxTokens` 限制。这是保守的本地预算约束，不能作为供应商精确计费或套餐余额证明。

仅允许已具备 `maxRetries=0` 控制证据的 API：`anthropic-messages`、`openai-completions`、`openai-responses`；默认从锁定的 SDK 1.0.4 模型目录选择。模型目录网络刷新关闭。每次 transport 调用还核对取消、到期和预占数，不允许隐藏的重试突破预占。

自定义厂商可显式提供以下 `customModel` 字段（首版仅支持 `openai-responses`）。
仅在内存注册获准的 provider/model，不加载本机 `models.json`、插件或任何其他厂商；
认证仍单独经环境引用传递，不能放入模型描述。未知字段、HTTP、URL 内凭据、查询参数、
本机/IP 地址和端口均拒绝；transport 只允许该 origin 及基础路径下的请求，拒绝重定向。
模型价格未配置，不将零占位价格当成真实免费或费用统计。

```json
"customModel": {
  "api": "openai-responses",
  "baseUrl": "https://ark.cn-beijing.volces.com/api/plan/v3",
  "contextWindow": 256000,
  "maxTokens": 4096,
  "reasoning": true,
  "supportsDeveloperRole": false
}
```

此入口不提供通用网络沙箱或 DNS 重绑定防护；endpoint 必须由负责人确认。描述仅扩展
探针的显式装配能力，不代表 Core 的生产自定义厂商接入已完成验收。

`admittedRequests` 是 SDK 请求预占数，`realCalls` 是在 transport 边界观察到的 fetch 调用数；未知 Runner 结果为 `null`，不能写成零。这里统计客户端调用，不证明供应商成功执行或扣费。usage 按请求身份保留 SDK 可得值，重复终态不重复累计，失败/取消的零占位记 `null/unknown`；即使有小计也只标 `partial`。

只有 Runner 已核验停止、结果身份/provider/model/水位一致、实际工具与最终消息证据齐备，才启动固定的独立 Node 定向检查。检查环境不带供应商凭据。检查成功后再核对原 HEAD 和仅有的文件差异，通过固定 argv、禁用 hooks/签名的 Git 操作只提交 `greeting.txt`，核对父提交及干净状态；不 push。失败不自动重跑，保留现场。

## 三个单独批准的场景

- `change`：获准的小改动、工具过程、最终回复、独立检查和本地受控提交。退出 0 只说明该探针完成，不表示 Phase 通过。
- `cancel`：另加正整数 `cancelAfterMs`，必须小于 `timeoutMs`。在当前 Session 请求取消，等待 idle/dispose，并记录取消、停止及 partial/unknown usage；不会交付 Git 提交。真实取消未执行时仍为 `not_run`。
- `resume-required`：同一探针 Task 的 required conversation 续接准备。当前生产能力默认不支持，工具记录 `production_conversation_resume_unsupported`，真实调用零次，退出非零并保留 `partial`。不伪造来源档案、不重新打开终态 Attempt、不将持久历史当 checkpoint。

取消模式和 required 模式都需要各自的新临时仓库/报告目录和明确授权。它们不会被一次 `change` 运行隐式触发。外部工具进程停止始终 `not_run`：本工具只核对两个同步文件工具和自有 Runner，不能为 Bash/MCP/孤儿进程停止背书。

## 证据与验证交接

报告目录不覆盖；不确定停止时保留现场，不做自动恢复或清理。`state.json` 保存启动意图，`report.json` 保存终态，`events.jsonl` 的完整行构成采集前缀，`runner-result.json` 记录终态水位/用量。`evidence-index.json` 保存允许导出的证据相对路径、大小和 SHA-256。`runner-input.json` 和 `agent/` 是私有运行输入，包含本地路径，不在导出索引中。

live 目录与 F-007 的离线矩阵/阶段目录独立；注入执行器的单元测试报告明确 `executionMode=fake`。缺真实证据不能由离线成功覆盖。`phaseAccepted` 永远为 false，人工汇总仍须逐项检查真实 live、Core 闭环、外部进程、工程/集成门禁和负责人确认。

本地新增 `test/modules/acceptance/p04-8-live.test.ts` 定向验证：缺授权/输入/认证的零调用、各预算与策略拒绝、定向检查和 Git 交付、证据身份/水位拒绝、未知停止/usage、凭据脱敏、真实 CLI 零调用、真实隔离 Runner 的 required 拒绝，以及安装 SDK 的离线工具循环、401 和取消。模型流/HTTP 在测试中受控替换，不计作真实 live 验收。范围登记于 `test/index/phases/P04/features/P04-8/tasks/F-009.json`；较广回归交 Nezha 执行。
