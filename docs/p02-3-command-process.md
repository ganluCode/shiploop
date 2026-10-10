# F-009 受监督命令进程端口

实现入口：`shiploop-core` 导出 `CommandProcessPort`、请求/句柄/错误契约；
`shiploop-core/assembly` 导出 `createCommandProcessAdapter()`。加载入口不启动进程，不引入 Pi SDK。
实现位于 `packages/core/src/adapters/process/`，不是 Spike 代码。
本任务不接线基线执行编排器或 HTTP 能力，不改变基线操作/检查的业务状态。

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

## macOS 监督与占用边界

命令及未改变进程组的后代继承监督组。监督进程即使命令父进程先退出也保持存活，
异步扫描组成员；正常结束必须等待受控后代退出。取消/超时/Host IPC 丢失沿监督组发
SIGTERM，5 秒后仍未结束升级 SIGKILL；Adapter 再独立异步核验全组不存在。
停止收尾最多 10 秒，探测错误不当作停止；无法确认时返回 `confirmed:false`/`uncertain`，
Core **不得释放全局/仓库写占用**。终止时排空 pipe 防止未消费输出阻塞清理；已保留输出不删除。

`ps` 探测也有 1 秒、1 MiB 预算；资源过载导致探测失败时保守返回未知。
OS 启动时间有秒级精度，UUID/活跃监督句柄/PGID 一起用于本次启动核对；这不是完整的重启恢复或
通用 PID 复用安全终止 API。旧身份恢复核对、额外故障注入和占用隔离接线由 F-010/F-013 验收。
Adapter 没有仓库 reset/stash/删除逻辑，没有 CPU/RSS/磁盘硬配额。

**仅 macOS**；未知平台拒绝，不能通过装配 platform 假装非 macOS 已支持。
可信项目模式无法阻止任意恶意进程 setsid、改变组、创建 detached 后代或访问同用户文件/网络；
组不存在仅核验受控范围，不是整个 OS 的恶意逃逸证明，也不是强 OS 沙箱。
停止未确认不能靠父进程 exit、HTTP accepted 或空输出推断安全。

## 验证

`test/supervised-command-process.test.ts` 使用真实 Node 命令、临时 SQLite 和既有测试 TS loader，
覆盖提交前无哨兵、确认失败/握手中断/Host 崩溃、授权输入快照、环境/argv/stdin、
0/非零/缺命令/权限/信号结果、有界输出、挂起查询/取消、父进程先退出后代存活和无消费者超时。
不访问模型、网络或真实凭据；资源回收要求 `stopped.confirmed`。
