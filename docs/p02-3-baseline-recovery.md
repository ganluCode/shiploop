# F-013 基线活动停止与重启恢复

## 生命周期入口

`BaselineExecutionService.enterQuiesce(policy)` / `awaitQuiesce(budgetMs)` 结构兼容
P02-1 `HostActivityGate`。生产 Host 必须合并基线门控与额外注入门控，不能用 idle gate 覆盖基线。

- 先关闭新 `submit`，统计正在授权的请求、执行及持久占用；授权中的请求也不能被漏成空闲。
- 默认 `wait` 只等待已接受请求安全收尾；可信装配显式 `baselineStopPolicy:'cancel'` 才提交
  cancelling 并请求取消。没有新增 CLI 参数、停止 wire mode 或执行路由。
- 等待预算 0..10s。超出预算/持久占用尚未释放返回未确认，Host 保持 quiescing，不报告 stopped、
  不关闭 Core、不释锁。既有 stop 幂等重试及信号路径复用此门控。
- 装配级 `RunningHost.close()` 也核对活动，不是绕过停止失败的后门。失败可重试。
- Core 直接提交在 quiesce 中返回既有 `resource_busy/quiesce_not_confirmed`；HTTP 生命周期
  拒绝仍为 P02-1 的 `503 not_ready`。不改变公共错误码、握手冻结形状或命令能力清单。

## 恢复顺序与不变量

Host 获得数据根 OS 锁、打开迁移完成的 Core 后，在 starting 中调用 `recover()`；完成核对前
不监听、不发布新 discovery。未确认资源持久隔离；Host 可提供查询，但全局新检查不能执行。

1. `listRecoverableBaselineOperations` 读取非终态及终态占用持有者。原 commandId/授权不可变，
   不重放、不排队、不接管旧检查为 passed。
2. `CommandProcessPort.recoverStop` 校验 UUID、PID=PGID、OS lstart，再以真实 `/bin/ps`
   清点监督身份和整个组。只有完整身份匹配才发组 SIGKILL；PID 不匹配、探测失败、监督已退出
   但后代仍活跃都不能凭旧 PID 杀进程或释放资源。有界核对也覆盖 IPC 丢失与监督退出的竞争。
3. accepted 且无任何已提交进程身份表示未放行：旧监督握手不能得到项目命令。
   已持久确认整个组停止的标记同样可复用（写入后不再启动后继检查）。其余未知身份保留隔离。
4. 收集已索引 output（包含 pending 发布恢复核验）或持久 staging 身份关联的脱敏部分输出。
   staging 只经受控根、稳定项目身份、限定文件名、no-follow、常规文件、8 MiB 预算读取；原残留
   不删除，恢复副本经既有 ArtifactPublisher 发布。未收齐/缺失内容永不证明通过。
5. 未收尾检查一次性 CAS → inconclusive，操作 → interrupted，原因 restart_recovery 或
   stop_unconfirmed；先前已完成检查、制品及终态均不倒写。已退出但结果未提交仍不自动 passed。
6. 停止核验持久化后，核对当前仓库身份、绑定与 Git common dir；只释放同 operationId、同 inode
   的常规 claim。其他属主、损坏、链接或路径身份变化保留 DB 占用。最后短事务释放 DB 占用。
   恢复失败不会触发命令，重复恢复只核对/收尾；显式新 commandId 必须重新 preview/authorize。

### 释放顺序补正

F-012 原「终态+事件+DB 释放同事务，然后 unlink claim」有崩溃窗口：终态已提交且 DB 空闲，
claim 尚未释放，后续恢复无法通过占用定位旧属主。F-013 改为终态+事件+停止标记同事务，
claim 核对释放后才释放 DB。没有文件/SQLite 跨介质原子性假设；任何窗口都保留可恢复占用。

仓库 claim 仍是 F-012 候选最小协作方案；F-001 负责人核对依据尚待补齐。本任务不将其冒充
已人工批准的强锁/沙箱。仅 macOS 可信项目模式；不验证恶意 setsid 逃逸、断电或跨平台。

## 验证入口

- `test/baseline-host-recovery.test.ts`：真实 Host 锁、wait/cancel 策略、idle 注入不能绕过活动，
  quiesce 新提交拒绝、意图收尾、原命令幂等及完成/失败/拒绝基线重启查询。
- `test/baseline-host-faults.test.ts` 与私有 IPC child：真实自有 Host SIGKILL、运行中证据残留、
  已保存授权无启动、持久进程身份未放行、退出结果未提交、监督退出且子进程仍活跃、冻结监督
  与持久身份不匹配。断言实际组停止/保留、claim/DB/Host 锁、实际启动计数及 tracked/untracked
  用户改动保留。夹具有有限屏障与收尾预算，不访问模型、网络、真实凭据或用户仓库。
- `test/baseline-execution.test.ts` 追加授权在途与 quiesce 竞争，证明显式 cancel 零进程启动。

全量门槛：`npm run verify`（npm test、typecheck、build），另 `npm run check:boundaries`。
