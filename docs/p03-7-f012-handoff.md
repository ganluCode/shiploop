# P03-7 F-012 有限返工与显式验证继续

## 实现范围

- 检查失败后沿用既有调度认领新 Attempt，保留原 worktree 和 tracked/untracked 文件。
- 新输入绑定直接上一 Attempt、当前现场和失败证据，不清除累计代码/父级预算。
- 确定性代码失败按已配置次数返工；基础设施错误单独暂停，停止未知保持隔离。
- 批准不启动 Runtime。`task.verification.continue` 显式复用有效机器证据；同 commandId 重放不重复副作用。
- Task 检查收尾不能清除 Run 的暂停请求，也不能以机器绿色代替人工批准或停止确认。

## 验收修补

2026-10-17 模型会话超时后，在原工作区继续核验并修补：

1. 失败返工与成功收尾仅恢复因验证/审批而暂停的 Run，不覆盖 `pausing`。
2. 新的验证继续命令在写事务外重新检查当前 worktree 内容摘要、环境和证据正文；事务内继续重核 Task revision、执行身份及当前批准。
3. 检查通过但进程停止未知时不放行 Task；占用保持隔离。
4. 同步通用 Host 命令路由的能力声明与严格契约回归；专用 CLI 交互仍由后续任务提供。
5. 修正前序 v24 迁移引入后遗留的旧迁移数量断言，改为对照实际迁移清单，不修改生产迁移或历史 checksum。

首版可复用环境限定为能实际核对的 Node Host：`runner=node`、当前 `nodeVersion` 与 `platform`。
环境缺失、未知环境字段或存在尚未核验的 `environmentRef` 时保守拒绝，要求重新检查，不声称支持任意工具链环境的复用。
文件核对以可信项目、单 Host 写入者为前提，不是强 OS 沙箱或文件系统原子快照。

## 需求与测试对应

| 验收要求 | 证据入口 |
|---|---|
| 同 worktree 增量返工、保留首轮文件 | `test/modules/verification/p03-7-f012-work-loop-rework.test.ts`：真实 Git/SQLite/worktree 与显式 FakeRuntime 接线 |
| 三次含首次耗尽、后继阻断、累计预算 | `test/modules/verification/p03-7-f012-rework-continuation.test.ts` 与既有代码预算回归 |
| 停止未知不得重跑/放行 | 返工测试中的隔离、受信停止凭证与机器通过但停止未知用例 |
| 批准后显式继续、幂等、无新增 Runtime | `test/modules/verification/p03-7-f012-verification-continue.test.ts` |
| 当前代码/环境/证据必须重核 | 继续测试中的事务外检查与代码/环境漂移拒绝用例；生产组装核验实际制品 hash/size |
| 基础设施错误独立暂停、暂停不被覆盖 | 返工测试的 non_code_failure 与成功/失败收尾暂停回归 |
| 恢复新建获准 Attempt、人工阻塞不绕过 | 返工快照一致性、预算与人工阻塞回归 |

## 运行边界

本任务只验收 F-012，不代表整个 Feature 或 P03 已通过。
真实 Pi/live、Host 通用重启恢复、完整阶段验收、后续 CLI/Host 新入口仍按后续任务验收。
原始 GLM 限流和 Kimi 超时记录保留；人工验收记录单独保存，不更改历史 Runtime 结果或虚增模型会话用量。

## 本次验收结果（2026-10-17）

- F-012 专项：3 文件 20 项通过，包含 5 项本次新增回归。
- Nezha affected 独立验证：50 文件 1215 项通过（413.77 秒）；已修正模型测试清单中的不存在文件名。
- 补充 Host/初始化/制品持久化回归：4 文件 136 项通过；与上述 50 文件不重叠，合计 54 文件 1351 项。
- `npm run typecheck`、`npm run check:boundaries`（224 个生产文件，0 diagnostics）、`npm run build`（含 Core/Host/CLI 正式入口烟测）均退出 0。
- 全量测试曾因错误清单安全回退而误启动，已优雅中止并保留记录，不计作全量通过；本次结论仅为 F-012 任务验收通过，Feature 最终门禁仍待后续任务完成。
