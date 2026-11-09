# P05-2 F-007 Phase/Feature Host 与 CLI 接线

日期：2026-10-24。基线 `27f1d083685dd1f48ef12c41863a943c7e8a134f`；当前 Task 的提交 SHA 以 Git 记录为准。

## 公开接口

沿用 `/v1/commands`、线消息 schemaVersion 5、认证绑定主体、项目授权、结构化回执、commandId 幂等与显式 revision CAS。新增的是现有 Core 能力的传输入口，Host 不直接写业务表。

| CLI | Core 命令或查询 | CAS / 输入 |
| --- | --- | --- |
| `phase update <phaseId> --project <id> --revision <n>` | `phase.metadata.update` | 至少一个 `--title`、`--description`、`--label`；省略字段保留原值；`--clear-description`、`--clear-labels` 显式清空 |
| `phase close/reopen/archive <phaseId> --project <id> --revision <n>` | `phase.close/reopen/archive` | Phase revision；Core 核验生命周期与占用 |
| `feature move <featureId> --project <id> --revision <n> --from-phase <id> --to-phase <id> --source-revision <n> --target-revision <n>` | `feature.phase.move` | Feature、来源和目标 Phase 三方 CAS |
| `feature dependencies --project <id> --phase <id> --revision <n> --input <file>` | `feature.dag.update` | Phase revision；文件为 `{ "edges": [...] }`，整体替换该 Phase 的依赖边 |
| `phase graph <phaseId> --project <id> [--limit <n>] [--cursor <c>]` | `phases.graph.get` | 只读；`GET /v1/phases/:phaseId/graph?projectId=...` |

写命令支持 `--command-id`；所有入口支持 `--data-root`、`--json`。同一显式 commandId 的 CLI 重试先读取原 issuedAt，按原信封重放；异参复用得到 conflict。JSON stdout 只输出一个既有结果信封，诊断走 stderr。退出码沿用 0 成功、1 业务拒绝、2 输入错误、3 连接/协议错误、4 观察中断。

依赖文件中每条边至少提供 `featureId` / `dependsOnId`，可提供 `id`、`projectId`、`phaseId`、`codeBaselineRef`，全部由 Core 严格核验；空数组显式清空。文件先有界读取为 UTF-8 JSON，顶层只允许 `edges`，不会执行文件内容。

HostClient 提供 `updatePhaseMetadata`、`closePhase`、`reopenPhase`、`archivePhase`、`moveFeaturePhase`、`updateFeatureDag` 和 `getPhaseGraph`。新增回执和图响应进行严格字段、版本、记录归属及就绪字段校验；新增脱敏事件也能经现有 SSE 解码器读取。

图返回 Phase 状态、分页 Feature、完整依赖边、dependency completion、integration readiness、dependency integration readiness、blockers、readyFeatureIds 和 executableFeatureIds。边覆盖全图，可以引用当前分页之外的节点。Feature 完成且没有固定集成证据时，后继仍显示 integration_not_ready。查询不创建 Batch/Run/Attempt、不写事件、不启动执行；关闭命令 completed 不表示 Phase 已验收通过。

## 纵向验证发现并修复的前置接线缺口

- Core `feature.dag.update` 校验器曾为缺省边字段返回 undefined，使命令规范 JSON 摘要失败；现改为省略缺省字段，保留既有空 baseline 规范化。
- CommandService 已有 DAG 处理器但入口白名单遗漏该操作，现补齐，仍经过同一授权、幂等及短事务路径。
- 权限矩阵补齐本次六类写操作，覆盖 owner、恰切能力和缺能力拒绝；同时补齐 DAG 测试信封的穷尽分支。

## 首轮本地证据与独立验收范围

日志根目录：`/Users/ganlu/Documents/my-dev/code/ai-coding/shiploop-harness/workspace/features/2026-10-23-18-55-21_p05-2-phasefeature/verifications/F-007/runtime-logs/`。每次调用保留完整输出、实际退出码及 JSON sidecar；早期失败证据保留。

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| 首个生命周期参数测试 RED | 1 failed，未知子命令 | `test-v3v8xwca.log` |
| 首轮三文件定向验证 | 141 passed，exit 0 | `test-tr0uuof6.log` |
| 生产构建及内置 Host/CLI 冒烟 | exit 0 | `test-qyx_oara.log` |
| 架构边界检查 | 367 文件，0 diagnostics，exit 0 | `test-ly9jd2vs.log` |
| 仓库类型检查 | exit 1，既有 TS2554 | `test-18jk8bst.log` |

本地运行文件：`p05-2-f007-phase-graph-cli.test.ts`、`p05-2-f007-phase-graph-host-wiring.test.ts`、`authorization-contract.test.ts`。新增纵向场景使用真实临时 Host/SQLite/Git，覆盖生命周期、归属和依赖更新、三方 CAS、重复命令、响应丢弃后回执找回、分页只读、独立集成就绪轴、未认证/跨项目/未知字段/伪造主体/错误版本拒绝，以及 HostClient 响应归属核对。临时资源均由夹具关闭和清理。

F-007 仓库索引为 `test/index/phases/P05/features/P05-2/tasks/F-007.json`，Harness selection 仅引用该索引。首轮另外八个已有回归文件本地 not_run，交 Nezha 独立复验，覆盖生命周期和归属/DAG事务、Core图查询、旧计划 Host/CLI、HTTP 路由与参数解析；返工后的当前索引范围见下文。

类型检查剩余错误为前序已记录的 `test/modules/planning/p05-1-f014-planning-e2e.test.ts:248`（TS2554，Expected 2 arguments, but got 4）；本 Task 未修改该文件，不能把仓库类型检查记为通过。未运行全仓测试、Feature 合集、阶段验收或真实模型。以上本地结果不等于独立 Task/Feature 验收结论。

## Attempt 2：修复独立验收失败及握手能力遗漏

本轮 invocation：`9ec873264901452e9d4c34e3e5ef5950`。恢复时 HEAD 为 `b2ba08c9746b4fd2e0e5bb0f28f79575bd69a405`，工作树干净，未重放已有提交或写入。

首轮独立证据位于 Feature workspace 的 `verifications/F-007/f3827e705f0e4d7e830fc63018b0e694/`：11 文件中 349 passed / 3 failed，`human_blocked=false`。失败为 CLI 命令清单遗漏已交付的 planning、CLI 身份校验正则遗漏 planning、未知 Host 命令错误中的 supportedOperations 期望遗漏本 Feature 六个写操作。

本轮保持精确枚举及未知字段/操作拒绝断言，同步上述期望。检查同文件握手契约时另发现生产 `APPLICATION_COMMAND_CAPABILITIES` / `APPLICATION_QUERY_CAPABILITIES` 未宣告已经接通的六个写操作和 `phases.graph.get`。先补齐握手测试期望，取得仅握手失败的 RED（`test-58n__pe9.log`，131 passed / 1 failed，exit 1），再补齐 `packages/host/src/contract/lifecycle.ts` 能力声明及既有契约测试。能力声明不授予权限，命令和查询继续经过 Core 原授权与 CAS。

本次最终定向运行以下四个完整文件：`app-cli-args.test.ts`、`host-app-routes.test.ts`、`host-lifecycle-contract.test.ts`、`p05-2-f007-phase-graph-host-wiring.test.ts`。结果 **222 passed，exit 0**，完整日志 `runtime-logs/test-__hsdtx3.log` 及 sidecar 绑定本次 invocation；保持首轮失败证据不变。

当前 F-007 索引为 14 个完整测试文件：保留首轮 11 个文件，追加握手契约、HostClient 连接及应用协议回归，以覆盖能力声明对发现/握手/客户端的影响。本轮只运行上述四个文件，其余十个本轮 not_run，交 Nezha 独立复验；不将首轮或上次独立验证的结果冒充本轮已运行。生产构建、类型和架构边界检查本轮未重跑，首轮结果仍按上表保留。未运行全仓、Feature 合集、Phase 验收或真实模型，未解除人工阻塞。
