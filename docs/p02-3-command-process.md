# F-009/F-010 受监督命令进程端口与停止路径

实现入口：`shiploop-core` 导出 `CommandProcessPort`、请求/句柄/错误契约；
`shiploop-core/assembly` 导出 `createCommandProcessAdapter()`。加载入口不启动进程，不引入 Pi SDK。
实现位于 `packages/core/src/adapters/process/`，不是 Spike 代码。
F-009 不接线基线执行编排器或 HTTP 能力，不改变基线操作/检查的业务状态；
F-010 补齐取消/超时/升级终止/停止核验与无法确认时的占用隔离接线，仍不装配编排器。

## 放行协议与持久边界

1. Core 先完成授权、代码身份检查和占用获取；向端口提交完整获准 argv、绝对 cwd、环境和预算快照。
2. Adapter 用固定最小环境启动私有 Node 监督进程（`detached:true`，独立 session/进程组）。
   启动标识使用 UUID；监督进程此时**没有收到任何项目命令**，只发 ready 并等待。
3. Adapter 核对握手 PID/进程组，再异步调用 macOS `/bin/ps`，核对 PID、PGID、OS `lstart`
   和命令行启动标识，生成 `{launchId,pid,processGroupId,startTime}`。
4. `confirm(identity)` 必须由可信 Core 装配提供，在短事务提交
   `baseline_occupancy.process_identity` **之后**返回相同 `launchId`。Adapter 不写数据库，
   也不能独立证明一个不诚实的回调真的提交了；回调不是网络/仓库可控扩展点。
5. 确认失败、错误 acknowledgement、5 秒握手预算耗尽、AbortSignal 或 IPC/监督进程中断，
   都不放行；有界终止并核验监督组不存在后抛结构化错误。无法核验抛 `stop_unconfirmed`，
   Core 必须保留占用/隔离，不能当作安全重试。
6. 确认成功后才传送获准输入并 `spawn(argv[0], argv.slice(1), {shell:false})`。
   argv/环境/stdin 在等待确认前复制，调用方之后的修改不会扩大授权。

不提供 shell 选项，不拼接脚本。端口不解析 argv 内容；Core 的授权摘要必须覆盖完整 argv
（包括解释器参数中的脚本文本）、cwd、环境引用和预算，不能只授权命令名。
P02-3 的公开检查计划仍遵守 §6.1 的无 shell 拼接校验。

## 输出、预算和异步结果

- `output` 是单消费者 AsyncIterable，区分 stdout/stderr；必须与 `result` 并行消费。
  Host 不等待命令结束才开始采集，也不在 Adapter 累积全文。
- 保留队列背压阈值 65,536 B；Node pipe 单块最多 65,536 B，队列最多 131,072 B。
  stdout/stderr 一起暂停；监督端 `pipe()` 继续向工作负载传播背压。
  另有 Node 流和 OS pipe 的有限缓冲，不宣称整个进程 RSS 只有队列大小。
- 完整启动输入（argv/cwd/解析环境 + stdin）≤ `maxInputBytes` ≤ 65,536 B；
  合并输出 ≤ `maxOutputBytes` ≤ 8,388,608 B；运行 timeout 1..3,600,000 ms。
  输出超限保留预算内已收数据并受控停止，结果 reason=`output_overflow`。
- 环境不使用 `process.env`，默认仅固定系统 PATH + 明确提供的获准变量。
  macOS/libuv 实测可额外注入 `__CF_USER_TEXT_ENCODING`（OS locale 元数据），即使显式 env
  也不能以 Node spawn 消除此项；测试排除这一已知 OS 项后严格核对其余环境集合。
  最小环境不是恶意代码的凭据隔离。
- `query()` 可在挂起执行期间立即返回状态和缓冲字节数；`cancel()` 只表示请求接受。
  `stopped.confirmed` 才表达**整个受控组不存在**，`result.stop` 同步携带该证据。
- 退出 0、非零、信号终止分别保留真实 exitCode/signal；ENOENT/EACCES/EPERM 映射为
  `missing_command`/`permission_denied`，不回显命令、绝对路径、stderr 或回调异常。
  Runtime/命令正常结束不是基线通过，业务映射由后续 Core 编排器负责。

F-011 的输出脱敏、制品发布、缺口门槛及授权读取见
[p02-3-baseline-evidence.md](p02-3-baseline-evidence.md)。进程结果另外保存
`droppedOutputBytes`（观察到但未交付队列的 pipe 字节），不把停止时丢失正文宣称完整。

## F-010 取消/超时/升级终止与停止核验

取消、超时、输出超限、消费者退出和监督 IPC 失联全部汇入**同一条有界停止路径**：

1. **请求正常停止**：Host 向监督者发 cancel，监督者沿受控组发 SIGTERM；
   用户取消与超时分别保留 `cancelled`/`timed_out` 原因（首个停止原因生效，
   不因后续事件覆盖），终端态只解析一次；
2. **宽限**：监督者 5s 后自行升级 SIGKILL（不变）；Host 侧另有停止宽限预算
   （默认 10s，覆盖监督者升级窗口的兑底）；宽限内监督者完成收尾则直接进入核验；
3. **身份核对后强制终止**：宽限期满仍未结束时，Host 重新用 `/bin/ps` 核对
   持久提交的身份（PID/PGID/OS `lstart`/命令行启动标识）——一致才对**整个受控组**
   发 SIGKILL；身份探测失败或 PID 被无关进程复用/旧启动标识不一致时**不发任何
   信号**（不误杀无关进程），返回不确定；
4. **有界核验**：升级/收尾后在确认预算（§13 默认 5s）内轮询组成员清点，
   只有成功的清点显示全组不存在才 `stopped.confirmed=true`；清点失败不折算为
   已停止，`query().state='uncertain'`。

决策核心位于 `adapters/process/stop-escalation.ts`（纯逻辑，探测/信号/延时全部
注入；生产装配注入真实 `/bin/ps` 与 `kill`）。`createCommandProcessAdapter()` 接受
可信装配选项 `stopGraceMs`/`stopConfirmMs`/`stopProbe`（只能收窄不能放宽冻结
预算上限），用于确定性测试，不是请求可控的能力协商面。

**停止未确认时的资源隔离接线**：`application/baseline-process-stop.ts` 提供
`finalizeBaselineOccupancyAfterProcessStop`——在原子命令事务内，仅当
`stop.confirmed=true` 才释放全局占用（仅持有者，幂等）；未确认时保留占用，
竞争检查经既有占用获取原语被 `baseline_in_progress` 拒绝，不能启动（§8.3：
停止未确认 → 操作 `failed`、检查 `inconclusive`、reason `stop_unconfirmed`）。
停止/等待/信号路径不含任何仓库 reset/stash/删除逻辑；失败与取消保留源文件与
已收输出。旧句柄重复取消幂等、不影响新执行；旧执行标识/PID 复用不会覆盖较新
状态。旧身份的恢复核对（重启后）属 F-013。

## macOS 监督与占用边界

命令及未改变进程组的后代继承监督组。监督进程即使命令父进程先退出也保持存活，
异步扫描组成员；正常结束必须等待受控后代退出。取消/超时/Host IPC 丢失沿监督组发
SIGTERM，5 秒后仍未结束升级 SIGKILL；Adapter 再独立异步核验全组不存在。
停止收尾最多 10 秒，探测错误不当作停止；无法确认时返回 `confirmed:false`/`uncertain`，
Core **不得释放全局/仓库写占用**。终止时排空 pipe 防止未消费输出阻塞清理；已保留输出不删除。

`ps` 探测也有 1 秒、1 MiB 预算；资源过载导致探测失败时保守返回未知。
OS 启动时间有秒级精度，UUID/活跃监督句柄/PGID 一起用于本次启动核对；这不是完整的重启恢复或
通用 PID 复用安全终止 API。旧身份恢复核对（重启后）由 F-013 验收；F-010 已
覆盖停止路径内的 PID 复用/旧标识负例与占用隔离接线。Adapter 没有仓库 reset/stash/删除逻辑，没有 CPU/RSS/磁盘硬配额。

**仅 macOS**；未知平台拒绝，不能通过装配 platform 假装非 macOS 已支持。
可信项目模式无法阻止任意恶意进程 setsid、改变组、创建 detached 后代或访问同用户文件/网络；
组不存在仅核验受控范围，不是整个 OS 的恶意逃逸证明，也不是强 OS 沙箱。
停止未确认不能靠父进程 exit、HTTP accepted 或空输出推断安全。

## 验证

`test/supervised-command-process.test.ts` 使用真实 Node 命令、临时 SQLite 和既有测试 TS loader，
覆盖提交前无哨兵、确认失败/握手中断/Host 崩溃、授权输入快照、环境/argv/stdin、
0/非零/缺命令/权限/信号结果、有界输出、挂起查询/取消、父进程先退出后代存活和无消费者超时。
`test/supervised-process-stopping.test.ts`（F-010）覆盖升级终止决策核心的正反例
（身份匹配/复用/探测失败/预算耗尽）、真实忽略 SIGTERM、父进程先退出后代持续写入、
监督者被 SIGSTOP 冻结后的 Host 侧升级、探测谁报下的不确定终态与占用保留/竞争拒绝、
重复取消幂等、自然完成后迟到取消、旧句柄不影响新执行、源文件与已收输出保留、
以及停止路径无 reset/stash/删除的源码扫描。
不访问模型、网络或真实凭据；所有真实进程用例有外层预算与退出核验，资源回收
要求 `stopped.confirmed`（不确定用例单独核验后清理）。
