# F-009 — FakeRuntime 异常、输出与恢复负例

本任务增加 23 项局部负例，复用真实 SQLite、输入绑定、FakeRuntime、Recorder、Runtime settlement 和受控工具子进程。未访问真实厂商或 SDK。任务索引见 `test/index/phases/P03/features/P03-10/tasks/F-009.json`；局部通过不代表完整 Feature 或阶段验收。

## 覆盖与行为

| 范围 | 用例及核对 |
| --- | --- |
| 分类与预算 | authentication-budget、quota-budget、server-budget、protocol-budget、unknown-terminal：保留 kind/reason，诊断检查全绿仍为 runtime_error；失败暂停且后继 pending，不自动重启。 |
| 预算和时间 | infrastructure-parent-budgets：退回代码槽位但保留 Attempt/Starts，有限父级上限、绝对截止时间及 Run 时间预算仍拒绝；supervised-timeout：真实 1 秒监督取消、停止确认、失败结算和现场留存。 |
| 三路证据 | independent-events/stopped/result 分别延迟公开观察；另外两路可以先完成。缺失事件或结果生成 partial 清单；缺 stopped 保持 execution_uncertain；required-evidence 缺必需检查证据不得通过。 |
| 信息告警与未知值 | rate-limit-notice 是 warning，不转换为 rate_limited；Fake 用量 basis=synthetic、notAdditive=true，未计入真实 Attempt 用量。未知终止按协议异常保存，未知退出码、耗时及真实用量保持 null。 |
| 大消息与上限 | large-stream-backpressure 核对 128 条多字节消息、单事件队列、字节高水位、分块 hash/size 与总量；body-cap-artifact 精确核对 UTF-8 正文上限及超一字节拒绝；oversize-gap 保存缺口并阻止放行；runtime-output-cap 显式失败。 |
| 工具输出和脱敏 | tool-overflow-artifact 使用真实 Node 子进程，保留输出字节、丢弃字节、摘要、停止证据和可读前缀制品。redacted-evidence/redacted-final-result 检查事件、清单及结算制品不含随机合成凭据，断言只输出布尔值；脱敏后的原因仍符合清单 token schema。 |
| 恢复边界 | recovery-false-claim、recovery-format、conversation-not-checkpoint：缺证据的 verified 声明、未注册 Runtime、格式版本不兼容及无执行恢复能力时 required 拒绝；auto 明确 new；required-before-start 经真实输入绑定核对来源证据缺失，零 RuntimeStarts。 |

## 生产修复

`attempt-lifecycle-store.ts` 在失败结算事务内调用既有 `reclassifyTaskAttemptAsInfrastructure`，返还临时占用的代码预算，累计 Attempt 与 RuntimeStarts 保持。Runtime 异常不等同于确定性代码检查失败；通知重放仍由既有幂等回执处理。初始认证负例为 RED：code_attempts_used 期望 0、实际 1；修复后为 0。

`work-evidence-recorder.ts` 在持久化前脱敏结果原因和 RuntimeError 原因。结果原因中的 `[REDACTED]` 转为受限 token `redacted` 并保留 128 字符上限，避免脱敏后的清单无法通过自身校验。新增结果原因测试曾复现这一 schema 问题，修复后通过。

当前基础设施失败策略为暂停并要求显式授权继续；本任务核对没有热重试、没有隐式厂商切换，继续受父级预算约束。当前没有自动 Runtime 重试/指数退避定时器，因此没有宣称验证非零自动退避间隔，也未新增自动重试策略。

## 本地验证与独立回归

所有执行均经 `nezha.dag.test_command`，完整 stdout/stderr、真实退出码和 sidecar 存于 Feature workspace：

`/Users/ganlu/Documents/my-dev/code/ai-coding/shiploop-harness/workspace/features/2026-10-11-17-45-49_p03-10-p03/verifications/F-009/runtime-logs/`

- `test-cenp9epa.log`：exit 0，三个新增文件，23 passed / 0 failed / 0 skipped。
- `test-ruzh4vt6.log`：`npm run typecheck`，exit 0。
- `test-fb0xnsey.log`：`npm run check:boundaries`，exit 0，286 个生产文件，0 diagnostics。
- `test-88ws5otv.log`：调用 Nezha 的实际 selection resolver，exit 0；11 个路径/schema 合法，`selection-validation.json` 区分三个本地文件和八个未执行回归。
- 中间 RED、来源身份修正、脱敏 schema 失败与超时诊断日志均保留；`test-v1ai3pct.log.interrupted.json` 记录早期阻塞运行的中止和进程清理。后续重跑均有相关代码或测试修正。

测试在临时真实资源中读回制品、核对现场及持久事实后清理资源；监督用例使用既有 retention 服务并核对调用引用的 settlement 制品。工具输出溢出用例显式将保留前缀发布到测试制品存储后核验，并未声称默认产品装配自动发布所有工具输出。

任务索引还登记八个既有回归文件：FakeRuntime、lifecycle、settlement、Recorder、输入绑定、恢复、代码预算和时间限制。这八个文件本轮未执行，交 Nezha 独立运行。Harness selection 只引用仓库索引；收尾核对路径、schema 与 case ID。不运行全量、组合门禁或 Phase 验收。

保留 F-007/F-008 原有未提交改动。本任务提交仅包含自身生产修复、夹具、测试、索引与交接；共享文档只暂存 F-009 增量。官方任务状态不直接编辑，完成后只经 `nezha task report F-009` 报告一次。
