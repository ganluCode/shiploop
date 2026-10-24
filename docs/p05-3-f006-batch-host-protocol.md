# P05-3 F-006 Batch Host 协议交接

受测基线：`6de922b49bcf8683339a9ca1cfc6f756962fec52` 加本 Task 工作区差异。最终提交由 Git 历史中 `F-006: 同步多成员 Batch 跨层协议与查询` 标识。

- `previewExecution` 接受互斥的 `phaseId` / `featureIds`，显式集合最多 16 个、禁止重复。旧 `{featureIds: []}` 保留 `no_work`。启动仍提交预览解析出的固定 `featureIds` 与摘要，不在启动时重新选择整个 Phase。命令仍为 v5；创建类命令的 `expectedRevision` 由 Core 固定为 null，主体来自认证上下文。
- 预览 wire 接收 Phase revision、请求成员、闭包成员、持久成员 revision/planDigest、逐 Feature Task/权限和代码基线。拒绝别名集合漂移、重复或缺失成员、摘要身份冲突、错误 Task 归属、计数/待执行列表矛盾，以及 ready/blocked/no_work 不变量违反。不同 Feature 允许拥有同名 Task。
- Work accepted 沿用 v6，增加可选 `runIds`（2～16 项，首项等于兼容的 `runId`）。多成员新授权返回完整列表；旧单 Feature v6 可以缺省。Core 工厂、持久化边界及 HostClient 使用同一形状校验；未知字段、未知版本继续拒绝。v5 rejected、v7 planning、握手能力和路由清单未新增版本。
- 无新表/迁移/第二套计数。初始 Run 关联取自不可变 Batch 范围及已有 `purpose=execute, dispatchOrdinal=1` 的 Run，写入时核对全部成员；回执重读/幂等重放按同一顺序恢复关联。同 Batch 后续重试 Run 不混入初始回执。
- 预算查询从固定成员读取全部 Task 和 Run，多成员 Task 补 `featureId` 以区分同名身份；控制查询简报补固定 `phaseId/featureIds`。旧单成员输出保持兼容。预算、deadline、累计计数均来自现有事实；Phase 后来新增成员不进入旧 Batch。

## 验证证据

证据目录为 Harness `verifications/F-006/runtime-logs/`；每条命令均经分配的 `nezha.dag.test_command` 助手执行，保存完整日志和退出码旁文件。

| 检查 | 结果 | 日志 |
|---|---|---|
| 新增真实 Host/SQLite/Git 与 wire 两文件 | 37 passed，exit 0 | `test-u1nuck1s.log` |
| 既有预算查询文件 | 11 passed，exit 0 | `test-favos9fe.log` |
| 新增两文件与旧单 Feature Client | 52 passed（新增 37、旧 Client 15），exit 0 | `test-xx5nxhkm.log` |
| `npm run check:boundaries` | 367 source files，0 diagnostics，exit 0 | `test-55leu2t6.log` |
| `npm run typecheck` | exit 1，仅基线已有 TS2554 | `test-3y745zog.log` |

新增行为覆盖真实 Phase 预览、多 Run 回执读取/重放、同 Batch 重试后初始关联不扩张、累计计数/deadline、范围外新 Feature、查询零写入、跨项目存在性折叠、能力/认证拒绝、未知/重复查询参数与分页边界。畸形 wire 用例覆盖成员/Task/权限/计数/状态组合以及旧 v6 兼容。

RED 已记录：`test-2c79aivr.log` 为缺少 Phase 输入支持；`test-nhts77rv.log` 为初始关联在回执重读时丢失。后续夹具预算约束和 P04 forbidden/not_found 错误口径调试日志保留，不作为通过证据。

类型检查的唯一剩余错误为 `test/modules/planning/p05-1-f014-planning-e2e.test.ts:248`：`TS2554: Expected 2 arguments, but got 4`。前序 F-005 的 progress 已记录同一错误，文件未在本 Task 修改；不能将类型检查标为通过。

较广受影响回归交 Nezha，范围以 `test/index/phases/P05/features/P05-3/tasks/F-006.json` 为准，所有文件显式 `all:true`。未本地执行的授权/路由/回执存储/控制恢复/F-004/F-005 回归保持 `not_run`；全仓、Phase、构建和真实模型均 `not_run`。
