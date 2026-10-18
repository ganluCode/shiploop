# F-011 基线输出与证据

`shiploop-core` 导出 `createBaselineEvidenceCollector`、`readBaselineOutput` 及证据类型。
本模块只组合已授权的 `CommandProcessHandle`、`ArtifactStore` 与 `ArtifactFileStore`，
不启动命令、不修改基线业务状态、不增加 HTTP 能力。F-012 编排器核对源码变化、
检查政策和停止证据；`eligibleForPass` 只是必要证据门槛，不是业务 passed。
Core 执行入口、取消与跨根协调待核对项见 [基线执行编排](p02-3-baseline-execution.md)。

## 采集与发布

- 单消费者并行消费输出/结果；每次最多解码 16 KiB，等待写入回调后才消费下一块。
  进程端已有 64 KiB 背压阈值、最多 128 KiB 队列。结果中的 `outputBytes` 是交付队列的
  字节数，`droppedOutputBytes` 单独统计观察到但未交付的 pipe 字节；不承诺观察到被杀
  进程尚未写入 pipe 的正文。
- stdout/stderr 分别使用 UTF-8 增量解码器和有界脱敏状态；持久化前替换明确环境值、
  `protectedValues`，并屏蔽 Authorization/Proxy-Authorization/Cookie/Set-Cookie 行。
  秘密数量 ≤256、单值 ≤4096 字符、合计 ≤65536 B；配置超限拒绝并请求停止。
  未知秘密检测、跨 stdout/stderr 拼接的秘密、强 OS 隔离不在保证范围内。
- 输出为带 `[stdout]`/`[stderr]` 标记的脱敏文本，不是可无歧义重建原始字节的协议。
  未决前缀可能延迟各流文本的写入；coverage 明确为 `per-stream-redacted-tagged-text`，
  不声称两流的全局时间排序。取消尾部未决秘密前缀也会屏蔽。
- 原始观察输出和最终制品各自 ≤8 MiB（标记与脱敏扩展也计入制品预算），尾部 ≤16 KiB，
  不拆 UTF-8。单 collector 同时只接纳一次采集；寿命内预留磁盘预算最多
  `64 × (8 MiB + 64 KiB)`，每次扣除完整输出与报告上限，失败不退还。
  调用方应以一次基线操作为寿命使用同一 collector；它不是跨操作/重启的磁盘配额管理器。
- 动态输出无法预知 hash，先写受控 staging 并 fsync，测量 hash/size 后登记 pending，
  使用既有不覆盖发布与 ready CAS。登记前中断留 staging 孤儿；登记后正式文件存在但
  ready 提交失败，既有 ArtifactVerifier 可校验并补 ready。没有篡改 ArtifactStore 的
  预期 hash 契约，也没有删除失败残留。每次发布均生成新的 Artifact ID，不覆盖历史。
- JSON 报告 ≤64 KiB，经既有 ArtifactPublisher 发布。报告保存 argv 脱敏副本及实际
  argv 的 SHA-256/脱敏标记、cwd、环境引用/变量名（无值）、timeout、代码与进程身份、
  采集起止/耗时、退出码/信号、停止确认、尾部、输出引用/hash/size 和覆盖缺口。
  起止是采集窗口；OS 启动身份另存 `processIdentity.startTime`。F-012 增补受控
  `processReason`，避免编排器在采集已判不确定后再次无限等待原结果 Promise。报告是发布前快照，
  不含自身制品引用；返回证据另含 report 引用及最终核验。数据库只存制品元数据和
  业务输出引用；不把全文塞入事件、回执或队列。

## 缺口、读取与恢复

溢出、丢失、取消、超时、写入/发布失败、结果拒绝、停止未确认和缺失/损坏制品都会
阻止 `eligibleForPass`；采集失败即调用监督句柄 cancel，accepted 不当作 stopped。
检查返回 0 也不绕过完整性门槛。采集等待有 timeout +30s 预算，结果等待最多 15s；
生产文件/进程端口的收尾与发布按既有有界政策执行。原始错误正文不进入公开诊断。
`verify(evidence)` 在使用历史证据前重新核对 output/report；恢复为 ready 不能抹掉本次
已记录的缺口，必须新检查或显式审阅。停止未确认时仍须用 F-010 的占用收尾规则保留隔离。

`readBaselineOutput` 要求 `baseline.read`、项目可见、operation/check 与输出 ID 的归属，
只允许 `baseline-output`。不接受 path/locator，也不开放通用制品读取；最大读取 8 MiB，
经 SHA-256/size 核验。不可见返回 `not_found`；缺失/损坏返回既有公开错误
`corrupt_state`，details.reason=`evidence_incomplete`。未来传输层负责有界流式响应。

真实文件/SQLite/进程测试见 `test/modules/onboarding/baseline-evidence.test.ts`；队列、溢出与停止回归见
`test/modules/runtime/supervised-command-process.test.ts`、`test/modules/runtime/supervised-process-stopping.test.ts`。
ENOSPC/提交故障为确定性注入，不宣称执行过真实磁盘耗尽或断电演练。
