# P05-1 / F-014 定向端到端接线报告

状态：本地代表性纵向通过；受影响兼容索引已登记，较宽回归、类型/边界/构建和真实模型保持独立门禁。

## 范围与变更

- `packages/cli/src/app/planning.ts`：`planning start` 只向 `HostClient.startPlanning` 传递允许的 `projectId/phaseId/featureId`、规划输入和 `expectedRevision`，过滤解析器内部的 `kind/command/operation/revision` 字段。
- `test/modules/planning/p05-1-f014-planning-e2e.test.ts`：新增真实临时 SQLite/Git、生产 `startFakeHost`、`runAppCli`、FakeRuntime 和 Core 受限候选工具的定向纵向测试。
- `test/helpers/planning/p05-1-f007-fixture.ts`：导出既有工作区准备夹具，避免复制 F-007 的大夹具。
- `test/index/phases/P05/features/P05-1/tasks/F-014.json` 与 `feature.json`：登记新增测试和受影响兼容测试。
- 任务选择清单：`verifications/F-014/test-selection.json`。

## FR 映射

| 需求 | 通过证据 | 复用/独立范围 |
| --- | --- | --- |
| FR-1：需求输入、一次规划授权、重复命令复用 | `planning-e2e-single-run-candidate-apply` 写入有界规划输入，经 CLI `planning start` 返回 Batch/Run/planning Task/candidate 四重身份；同 `commandId` 重放后 `runs WHERE purpose='plan'` 和 `planning_contexts` 各为 1 | F-003/F-012 的命令与 Host 协议回归进入 F-014 索引 |
| FR-2：Fake/Pi 工具提交候选及候选内容 | FakeRuntime 以 `await_gate` 形成脚本化执行窗口；Core 受限提交桥提交包含 Task、依赖、验收和 verification 的候选；重复提交同命令只保留 1 个 `planning-candidate` Artifact；CLI candidate 查询核对 `candidateDigest` | F-006/F-007/F-012 既有工具桥、执行收尾和 Host 入口进入索引 |
| FR-3：候选校验、摘要绑定、人工批准 | 批准前 `execution preview` 返回成功的只读预览，但 `authorization.confirmed=false`、`execution.started=false`、`runtimeExecution=false`；CLI `planning approve` 携带 candidate digest/CAS 应用计划；同命令重放后 `planning_context.status='applied'`、Feature `plan_status='approved'`、coding Task 数为 3，决策回执只有 1 条 | 非法结构/环、过期摘要/CAS、越权、拒绝和旧计划兼容由 F-001/F-006/F-008/F-012 及 P03 计划回归覆盖 |
| FR-4：规划与编码边界、去重和恢复事实 | 重复扫描不增加规划 Run；批准前没有编码授权或新 Run；批准后总 Run 数仍为 1，planning Task 与 coding Task 分离 | 同项目竞争、取消、停止不明、预算/deadline、重启核对、旧 owner 迟到由 F-005/F-007/F-009/F-010 索引覆盖 |

## 实际验证

- 命令：`/Users/ganlu/.local/pipx/venvs/nezha/bin/python -m nezha.dag.test_command --log-dir /Users/ganlu/Documents/my-dev/code/ai-coding/shiploop-harness/workspace/features/2026-10-23-18-55-21_p05-1/verifications/F-014/runtime-logs -- node scripts/run-tests.ts test/modules/planning/p05-1-f014-planning-e2e.test.ts`
- 最终退出码：`0`
- 最终日志：`verifications/F-014/runtime-logs/test-feksdt01.log`
- 结果：1 个文件、1 个测试通过，0 失败，0 跳过；日志由受控测试执行器保存。
- 受测代码 SHA：提交前工作树基线 `7b557d8804eea06fac55b93f23c20a98f21036f3`；最终 Task 提交在本地提交后回填。
- Task 提交：待本地提交后回填；只包含 F-014 接线、覆盖、索引和报告。

## 范围状态

- 本地运行：新增 F-014 聚焦测试已通过。
- 已选择但本次 Runtime 未运行：F-005/F-006/F-007/F-008/F-009/F-010/F-012、P03 计划导入/修订/批准、P04 派发兼容文件；它们已进入 F-014 可信索引，交由 Nezha 独立 `task_union` 复验。
- 未运行：`npm run typecheck`、`npm run check:boundaries`、`npm run build`；这些是 F-014 需求指定由 Feature 验收执行者保存的独立检查，不由本 Task Runtime 扩大范围重复。
- 未运行：全仓 `npm test`、`npm run verify`、历史 Phase/P05 阶段验收及真实 provider/model；真实模型未获单独授权，保持 `not_run`。
- 真实 Git/SQLite 资源在测试收尾后由夹具清理；模型凭据、业务数据库路径和 Host token 未进入候选或报告。
