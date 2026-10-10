# F-012 Core 基线执行编排

入口：`shiploop-core` 导出 `createBaselineExecutionService`；组合根返回
`CoreApplication.baselineExecutionService`。加载不启动进程。

## 使用与边界

- **首次提交**获准请求必须调用 `baselineExecutionService.submit(principal, envelope)`。
  它先复用 `commandService` 的授权、信封、时效、摘要、事务和回执，再异步执行。
  `accepted` 不是通过；持久状态经 `baselineStore` 查询。
- 原 `commandService` / `baselineService` 保持授权事务接口，供前序测试及显式装配使用；
  单独提交授权不会启动进程，之后重放同 commandId 也不会自动补跑。
- 明确取消入口为 `baselineExecutionService.cancel(principal, projectId, operationId)`。
  它重核当前权限，通过操作 revision 与当前 launchId fencing，等待结果收尾。
  停止或发布未确认时返回 `resource_busy`，不会伪装取消成功。
- `activeOperationIds`、`waitForIdle`、有界 `diagnostics` 供可信装配使用；失败诊断同时尽力
  保存到操作 reason。`waitForIdle` 只表示本服务调用已结束，**不证明占用已释放**。
- 本任务不接线 Host 活动控制、恢复或 HTTP；`baseline.cancel` 信封仍未开放，HTTP 能力仍
  不宣告基线操作。F-013/F-014 必须显式使用执行入口，不能绕回只提交授权的接口。
  `CoreApplication.close` 拒绝仍在本服务执行的操作；停止未确认的持久隔离仍须由 F-013 核对。

## 不变量

1. Git、文件、cwd 和环境解析在写事务外。授权提交重核绑定两种 revision、planDigest/
   previewDigest；占用初始快照保存绑定 revision 与绝对 `deadlineUtcMs`。
2. 按持久 `checkKey` 顺序串行，不自动重试、不排队；仍受 1..64 检查数、单项 timeout、
   输出/证据预算约束。绝对 deadline 阻止后继启动并请求受控停止；停止、采集、发布另遵守
   F-009/F-011 的有限收尾预算，不能以期限到达证明进程已经停止。
3. 监督放行回调再次读取当前代码/cwd；短事务重核 principal、绑定、操作 revision、占用，
   提交 launchId/PID/PGID/启动身份和 started 事件后才放行。授权漂移不沿用旧 HEAD。
4. 一项结果与 check_completed 事件同事务；终态、最终事件与 DB 占用释放同事务。
   取消先提交 cancelling revision，迟到成功不能覆盖它；终态不能倒写。
5. 停止未确认 → failed / inconclusive / stop_unconfirmed，保留隔离。发布缺口 → 非终态 /
   evidence_incomplete，保留隔离。事件、结果或收尾提交故障同样不解锁、不自动重跑。
6. 退出 0 仍要求完整、核验过的 output/report、非空输出和不变的代码。冻结的
   `command-evidence-v1` 保守拒绝已识别的 `0 tests`、`Tests 0`、`No tests found` 等尾部摘要。
   这不是通用测试协议解析或全部需求覆盖证明，任意命令的检查范围仍需用户确认。
   npm/pnpm/yarn 的已识别缺脚本诊断记 unknown_script；其他非零保留真实失败，不自动 install。
7. 每次执行发布 `baseline-summary`（有界 JSON，locator `baseline/<operationId>/summary`），
   保存 before/after 代码身份、检查政策、收尾前结果快照和输出/报告引用；标记
   `phase=pre-finalization`、采集时刻及未收尾项，最终状态以同事务提交的 DB 结果/事件为准。
   每项 report 仍记录放行前
   身份；summary 补充操作后身份。制品在释放前核验，源文件修改保留，绝不 reset/stash/删除。
   summary 是 Core 制品证据，不新增任意文件读取或公开内容路由。

## 跨数据根协调：待核对的契约缺口

**F-012 验收第二项要求遵循「F-001 已核对最小锁方案」，但 F-001 的任务验收与
`p02-3-onboarding-contract.md` 均未记录该方案。** §13 只冻结数据根内的单行
`baseline_occupancy`，不能独自协调两个数据根。这里不把新实现冒充 F-001 已核对结论。

候选实现 `BaselineRepositoryGuard` / `createBaselineRepositoryGuard`：在规范 Git common dir
以 `O_CREAT|O_EXCL|O_NOFOLLOW` 创建 0600 `shiploop-baseline.claim`，写入 operationId 并 fsync。
共享 common dir 的路径别名、同仓库以及 linked worktree 使用同一个排他目标；竞争不等待。
只有停止/证据核验和 DB 收尾提交后才按原 inode 释放。没有 PID/TTL 自动抢占；停止不确定、
持久故障或 Host 崩溃留下占用，不能用新数据根或 commandId 绕过。正常竞争者未启动进程时
记录 failed / baseline_in_progress、检查 not_run，并仅释放自己的 DB 槽位。

这是可信用户的持久协作占用，不是 OS 沙箱，不防外部 Git、编辑器或同用户恶意进程绕过。
未验收断电/目录 fsync、其他平台或完整恢复；F-013 恢复必须核对旧进程和 claim 归属，不按
「PID 不见/文件陈旧」自动删除。**仍需负责人提供 F-001 的核对依据，或确认此候选方案及
恢复责任；此前不能声称 F-012 全部验收通过。**

## 验证

`test/baseline-execution.test.ts`：真实 Git/SQLite/Node 进程与制品，覆盖顺序/幂等、真实
失败/缺命令/相对未知脚本/npm 缺脚本/权限、空输出/零测试、代码修改及 summary、真实挂起
取消/超时、取消与迟到成功、启动前取消、放行前代码变化、停止不确定、发布/逐项事件/最终
事件故障和两个数据根共享公共 Git 资源。受控 fake 仅用于确定性竞争/停止未确认，不冒充真实
进程核验。前序测试保留；无模型、网络访问或真实凭据。
