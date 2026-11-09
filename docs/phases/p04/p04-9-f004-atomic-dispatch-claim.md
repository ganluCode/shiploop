# P04-9 F-004：Run 归属与 Task 原子认领

## 实现边界

- `adapters/sqlite/attempt-dispatch.ts` 是受信同事务接点；`claimTask` 仍自行提交，拒绝外层事务。Run 认领、槽位、Task 围栏、Attempt、原有预算预占、工作区三组租约、事件及回执一起提交或回滚。没有新增预算账本或内存正确性锁。
- 首次认领创建一代 Run 归属并取得槽位。同 Run 后续 Task/返工使用相同 owner/Host，复用归属和槽位；新 Attempt 仍独立累计既有计数。过期、隔离或缺失的既有槽位不得通过新 Task 自动重建。
- `TaskClaimReceipt.dispatch = {claimId, claimVersion, slotId}` 保存在既有不可变回执中，关联回执内的 Attempt ID/executionVersion。Run 代次和 Task 围栏是两个独立计数器。`TaskClaimInput.dispatch` 可携带准备时读取的身份，事务中逐项重核。
- `beginLaunchInTransaction` 重核当前 Run/Batch 控制、授权意图摘要、DAG/审批、权限、持久回执关联与槽位。`ExecutionService` 在异步输入绑定之后、Session/Runtime 启动预占事务内再次重核归属，拒绝准备期间的失效。
- 备用切换经过相同接点，不绕过槽位。旧执行停止核验和资源释放成功后，若 owner/Host 确实改变，则在原切换事务内释放旧槽位/认领并建立显式前代引用的新一代；新代创建失败时连同旧代释放一起回滚。未启动且已重分类为基础设施失败的安全替换沿用同样的受控转移检查。普通认领不能靠更换 owner 接管。
- 重放只返回历史提交证据，不续租、不重新预占，也不代表可以再次启动。启动后故障保留 Attempt/认领/回执，由后续恢复核对。历史无 `dispatch` 的回执仍可读取，但不能授权新的 Runtime 启动。

没有修改迁移或已有历史提交。资源测试改用真实 `claimTask` 建立启动前提，不再靠合成 Attempt 绕过归属；Task claim 旧迁移断言改为按真实迁移清单派生，保留历史数据/校验和断言。

## 定向验证

完整日志及 `.exitcode`/`.json` 位于 Harness `verifications/F-004/runtime-logs/`：

| 命令范围 | 结果 | 日志 |
| --- | --- | --- |
| 新增派发原子认领测试（首轮 RED） | 2 failed（缺持久关联、隔离槽位仍可启动） | `test-5nzncr5r.log` |
| ExecutionService、备用切换、返工三文件 | 56 passed | `test-82xmvqfg.log` |
| 新增派发认领、原 Task claim、原 Work resources 三文件 | 70 passed | `test-7x4omrn2.log` |
| 修复夹具预算对象 TypeScript 类型后，重跑新增派发认领文件 | 20 passed | `test-dezqjjyz.log` |
| `npm run typecheck`（最新） | exit 0 | `test-v38ntv89.log` |
| `npm run check:boundaries` | exit 0，336 文件，0 diagnostics | `test-zdbmbete.log` |

新增覆盖：八个持久写入边界回滚、真实跨进程竞争、其他 Run 占槽时整组回滚、同 Run 后续 Task 复用、旧代次/owner 拒绝、提交后启动前漂移、重开后的过期回执重放，以及异步准备后的认领代次/槽位失效。返工与备用各包含正常及隔离拒绝分支。日志也保留中途夹具约束/类型错误，不将失败运行计为通过。

仓库索引：`test/index/phases/P04/features/P04-9/tasks/F-004.json`；Harness selection 仅引用它。
其中前七个文件已本地定向通过；其余三个（输入绑定、Attempt 生命周期、F-003 槽位原语）未由 Runtime 本地运行，交 Nezha 独立复验。范围保持原十文件不缩减。

### 独立复验后的定向修复

首次独立复验（`verifications/F-004/8f40b8cdf823456b9ed4063427c1af3f/`）为 220 passed / 1 failed，未通过。失败来自 `p03-3-runtime-start-reservation.test.ts` 中 v11 升级测试的两个旧版本上限断言（仍停在 v30）。修复为从当前迁移清单派生待应用版本，并继续断言全部版本从 1 连续递增；保留原有升级后数据、累计预占和额度断言，不修改历史迁移或删除测试。

修复后只定向执行该预算文件：18 passed，exit 0（`test-a1agy61j.log`）；最新 typecheck exit 0（`test-kzdaiwwv.log`）。其余已通过文件不重复执行；整体索引是否通过仍以 Nezha 本次独立复验为准。

## 后续与未运行

本 Task 不实现 F-005 的持久补扫/组合根、F-006 的 Run 结束/暂停/取消释放及心跳续租、F-007 的重启恢复接管。当前保守保留槽位，不能把 Promise 结束当作安全释放。首次认领缺失持久意图、历史 Attempt 缺失回执关联时均 fail-closed，不伪造历史授权。

全量、Feature/Phase 门禁、live、真实模型均 `not_run`；局部通过不代表阶段验收通过。无人工待确认阻塞。
