# P06-6 / F-003 默认策略重应用 Host 与 CLI

F-003 在已有预览/确认实现上补齐公开协议、CLI 审阅输出、拒绝与回执恢复边界。策略更新不会批准计划或启动执行。

- 查询：`GET /v1/task-strategy-reapplication?projectId=...&taskId=...`，`taskId` 可重复；HostClient 使用 `previewTaskStrategyReapplication(projectId, taskIds)`。
- 确认：既有 `POST /v1/commands`，操作 `task.strategy.reapply`；HostClient 使用 `reapplyTaskStrategy`，要求 `confirmed: true`。全局/项目配置 revision、选中 Task 集和逐 Task revision 必须与冻结预览一致。
- Core 的纯公开 schema 是服务端/客户端的共同来源。预览只返回身份、来源、摘要、差异字段、`changedCount` 和受控阻塞原因。完整候选 executionConfig、凭据引用和物理路径不进入公开预览。
- CLI `--json` 返回既有成功/失败封套；文本输出逐 Task 列出来源、摘要、阻塞原因，确认输出回执状态与实际 Task revision。业务 rejected 返回非零退出码。

用法：

```text
shiploop task strategy-preview --project <project-id> --task <task-id> --json
shiploop task strategy-reapply --project <project-id> --input confirmation.json --confirm --command-id <uuid> --json
```

`confirmation.json` 恰含以下字段；所有值来自审阅过的同一预览，不能在确认时重新获取默认值或自行推导 revision：

```json
{
  "previewDigest": "<identity.candidateDigest>",
  "globalSettingsRevision": 1,
  "projectSettingsRevision": null,
  "selectedTaskIds": ["task-a"],
  "expectedTaskRevisions": [{"taskId": "task-a", "revision": 1}]
}
```

以上为结构示例，不是有效请求。配置不存在时对应 revision 显式使用 null；`--confirm` 提供明确确认。重试保留同一文件和 commandId，CLI 先查回执并沿用原 issuedAt。不同内容复用 commandId 返回 conflict。传输中丢失响应时，HostClient 查询原回执；GET 返回原回执的 replayed 值，重新提交同一信封时才标记 replayed=true。

## 本轮返工与验证

独立验证最初在 `p03-2-host-wiring.test.ts` 失败 3 项：Host schema 仍断言为 5（当前为 6），以及两个输入准备场景缺少当前 Core 要求的已确认 Profile。夹具现登记最小能力模块与候选 Profile，并通过真实 HostClient 确认；原批准、幂等、隔离和正文边界断言保留。没有修改生产 Profile 门槛。

新增真实临时 Git/SQLite、loopback HostClient 和同一 CLI 执行路径覆盖：

- 预览只读；策略差异数量、来源和摘要；策略确认后既有 Task get/list 仍可使用。
- HTTP 未知字段、缺确认、非法 Task 身份、客户端深层未知字段拒绝；过期摘要、错误项目、跨项目 Task、旧 revision 拒绝且 Task 零写入。
- CLI JSON/文本输出、缺确认与未知输入字段、旧摘要非零退出码；同 commandId 重放零写入、异参复用冲突。
- 真实确认响应在代理转发提交完成后断开，客户端先 GET 回执，仅一次 POST、一次策略事件、一次 revision 递增。
- Core/Host 共用 wire 校验，拒绝遗漏字段、伪造计数、响应归属漂移、敏感扩展与路径。

可信范围：`test/index/phases/P06/features/P06-6/tasks/F-003.json`。保留上一轮全部 4 个文件，追加公开 wire 与 F-001/F-002 直接相关回归。

2026-10-29 本地定向结果：7 文件共 49 项通过（两次不重叠执行：Host/wire 8 项 + 其余 41 项）。类型检查、模块边界（463 源文件，0 诊断）、构建及产物冒烟通过。

本轮 invocation：`eb39d82e09c2497585a3adcf38e23a3f`。完整证据位于 Harness 本 Feature 的 `verifications/F-003/runtime-logs/`：

- `test-h4j2lhb4.log`：Host/wire 8 项。
- `test-f7smiudl.log`：CLI/旧 Host/策略编辑/预览/确认 41 项。
- `test-rxtrzxnu.log`：类型检查。
- `test-7w882ob2.log`：模块边界。
- `test-lhy1uest.log`：构建/产物冒烟。

每份日志有 exitcode 和 JSON 旁文件。原独立失败与本轮调试失败记录保留。本地结果不等于 Nezha 独立验收或 Feature/Phase 验收；未运行全仓、Phase 验收或真实模型，没有解除人工门禁。
