---
name: shiploop
description: 当需要初始化 ShipLoop 项目、编写 PRD 或设计文档、规划 Phase 和 Feature，或操作执行、审批、交付及故障恢复时使用。
---

# ShipLoop 项目操作 Skill

按全局 `locale=zh-CN` 使用中文解释、报告和回复；命令、ID、状态值及引用原文保持不变，交付物明确要求其他语言时遵从。全局支持 `en-US` / `zh-CN`，代码默认英文。

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

编写需求、设计或开始规划前，先读取 [文档规范](references/documentation.md)，遵循已有目录约定或建立项目文档索引。文档放在项目仓库，业务状态只通过 CLI 管理；init 不自动生成 PRD 或扫描 docs 开始规划。

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

- 拆分 Phase/Feature、编写 PRD 或优化并发边界：使用 [Feature 规划 Skill](../shiploop-plan-feature/SKILL.md)，由当前 Harness 模型规划，不自动启动额外模型。先核对已有计划，保留真实依赖和共享文件所有权。

- 创建/更新项目根目录 shiploop.yaml、配置主备模型或开启文件同步：[references/configuration-files.md](references/configuration-files.md)。先确认实际可用模型与分档，不自动覆盖现有文件或启用监视。
- 文档目录、命名、规划前检查：[references/documentation.md](references/documentation.md)。PRD 和技术设计模板由该规范链接，按需读取。
- 初始化、重复同步：[references/project-init.md](references/project-init.md)。
- Provider、low/medium/high 策略：[references/providers.md](references/providers.md)。
- 生产工具、连续重试、Feature 自动修复、auto_push 和飞书：[references/production-runtime.md](references/production-runtime.md)。先核对预算和开关；不因配置存在就自动发送真实请求。
- 启动、停止、幂等：[references/execution.md](references/execution.md)。
- 排障与验收：[references/diagnostics.md](references/diagnostics.md)。
- 规划、审批、资源、Git、备份及全部命令参数：[references/cli.md](references/cli.md)。先搜索命令，再读取对应段，不必全量加载。
- Host/桌面端接入：[references/host.md](references/host.md)。

Skill 只提供操作方法，不自动授权模型请求、执行、删除、推送或审批。沿用用户已经明确授权的范围；缺少关键预算或人工决策时先展示预览。
