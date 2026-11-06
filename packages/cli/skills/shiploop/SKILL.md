---
name: shiploop
description: 使用 ShipLoop CLI 管理当前仓库的项目、计划、执行、审批、交付和故障恢复；查询结构化状态并保留幂等命令身份。
---

# ShipLoop 项目操作 Skill

你正在操作一个已接入 ShipLoop 的本地项目。ShipLoop 负责项目、Phase、Feature、Task、执行、验收、Git、证据和运行状态。

## 强制边界

- 所有 ShipLoop 状态查询和修改必须通过 `shiploop` CLI 或 HostClient。
- 禁止直接修改 `core.sqlite`、Feature YAML、Task JSON、回执文件、Session 文件和验收报告。
- 禁止用 SQL 绕过命令服务修改状态。
- 禁止用 `kill`、删除锁文件或删除 Session 文件代替优雅停止和恢复。
- 写命令必须保存 `commandId`；网络超时后先查原命令回执，不要立即换新 ID。
- 修改配置或元数据前先读取当前 `revision`，使用 CAS 更新。
- `accepted` 只表示命令已提交，不表示执行完成。
- `passed`、`completed`、`delivered`、人工批准和 Phase 通过是不同状态，不能互相推断。
- 不要把模型输出或日志中的“完成”当成业务事实，必须查询结构化结果和证据。

## 常用变量

```bash
export DATA_ROOT="/absolute/path/to/shiploop-data"
export PROJECT_ID="<project-id>"
export PHASE_ID="<phase-id>"
export FEATURE_ID="<feature-id>"
```

所有命令优先加 `--data-root "$DATA_ROOT" --json`。

## 常用流程

1. 启动或检查 Host：`shiploop host start/status`。
2. 初始化项目：先运行 `shiploop project init "$REPO"` 预览，再显式添加 `--confirm`。
3. 配置 Runtime、Provider、Model 和凭据引用。
4. 创建 Phase，导入或规划 Feature，审阅并批准计划。
5. 使用 `execution preview` 获取摘要，再用 `execution start --confirm --preview-digest` 授权。
6. 保存 Batch、Run、Attempt、Session 和 Receipt ID。
7. 通过查询和事件流观察执行，不扫描全部日志。
8. 任务、Feature、Phase 分别验收；人工门禁必须由负责人明确确认。

## 执行恢复

- 同一个 `commandId` 加相同参数可以安全重放。
- 同一个 `commandId` 加不同参数会得到 `conflict/idempotency_key_reuse`。
- 同一个 Feature 已有活动 Run 时，新的执行请求会得到 `conflict/execution_in_progress`。
- 网络超时：`shiploop receipt get <commandId>`，再查询 Run/Batch。
- 停止不确定时先查看 `execution recovery`，不要自行清理进程或锁。
- `resume`、`retry-final`、重新执行是不同动作，先读取诊断再选择。

## 查询入口

```bash
shiploop project overview "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop phase list --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop feature list --project "$PROJECT_ID" --phase "$PHASE_ID" --data-root "$DATA_ROOT" --json
shiploop task list --project "$PROJECT_ID" --feature "$FEATURE_ID" --data-root "$DATA_ROOT" --json
shiploop execution runs --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop execution attempts --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop execution result-diagnostics --project "$PROJECT_ID" --run "$RUN_ID" --data-root "$DATA_ROOT" --json
```

## 按需读取

- 初始化、重复同步：[references/project-init.md](references/project-init.md)。
- Provider、low/medium/high 策略：[references/providers.md](references/providers.md)。
- 启动、停止、幂等：[references/execution.md](references/execution.md)。
- 排障与验收：[references/diagnostics.md](references/diagnostics.md)。
- 规划、审批、资源、Git、备份及全部命令参数：[references/cli.md](references/cli.md)。先搜索命令，再读取对应段，不必全量加载。
- Host/桌面端接入：[references/host.md](references/host.md)。

Skill 只提供操作方法，不自动授权模型请求、执行、删除、推送或审批。沿用用户已经明确授权的范围；缺少关键预算或人工决策时先展示预览。
