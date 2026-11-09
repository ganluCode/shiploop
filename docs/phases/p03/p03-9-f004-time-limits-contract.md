# P03-9 / F-004 分层时间上限与超时归因契约

状态：已实现（2026-10-18）。前置：F-003 的受控停止与证据；本项只接线既有
Session/工具/检查/Run/Batch 上限，不新增第二套调度或进程管理器。

## 1. 分层与来源

| 层 | 授权/快照来源 | 生效规则 |
| --- | --- | --- |
| Session | `policies.executionLimits.workTimeoutMs`（旧字段语义不变），创建 Task 时冻结进 `executionConfig.workTimeoutMs` | 实际请求为 `min(配置值, Run 剩余, Batch 剩余, 租约剩余)`；缺省 `DEFAULT_WORK_TIME_LIMIT_MS=60_000` |
| 单工具 | `policies.executionLimits.toolTimeoutMs` → `executionConfig.toolTimeoutMs` | 实际为 `min(配置值, Session 剩余)`；缺省 `DEFAULT_TOOL_TIME_LIMIT_MS=30_000`；FakeRuntime 再与工具定义自身 `timeoutMs` 取较小者 |
| Verifier 检查 | 已确认 check policy 快照中的 `timeout` | 实际为 `min(check.timeout, 3_600_000, 父 Run/Batch 剩余)`；父 deadline 已过则不启动检查 |
| Run | 预算快照/`runs.run_time_limit_ms` + 持久 `started_at` | `started_at + runTimeLimit`；暂停、重启、resume、新 Session 不改写开始时间 |
| Batch | `execution_batches.deadline_at` 与预算快照绝对 deadline | 取较早者；暂停/重试不延长 |

`ports/execution-time-limits.ts` 提供纯函数 `resolveExecutionDeadlines`：
输入显式 `nowUtcMs` 与持久 `runStartedAtUtcMs`，输出各层绝对截止、最早生效层、
剩余额度及工具/检查子额度。缺字段、非有限/非整数、负数、未知键、未来开始时间
一律结构化拒绝；不使用 Infinity 作为缺省。相同截止时父层优先归因（Run/Batch
先于 Session），因此 Batch/Run 到点不会被同额 Session 掩盖。

## 2. 启动前拒绝

- `RuntimeExecutionLimits.toolTimeoutMs` 是兼容扩展：缺省仍按旧三字段请求有效；
  出现时必须是 1 秒..1 小时整数且不得大于 `timeoutMs`。
- `ExecutionInputBinding` 与 `RuntimeExecutionRequest` 双重校验；`ExecutionService`
  在启动事务内再次拒绝 `toolTimeoutMs > timeoutMs`。
- 设置 schema 仍为 v2：新增 `toolTimeoutMs` 为可选键，旧 v2 payload 语义不变；
  未知/未来版本继续拒绝。Task 策略副本仅在政策配置时写入新键。
- Work 装配在 Run/Batch 已到期或剩余不足最小 Session 上限时不启动新 Runtime；
  已启动执行由监督器按最早持久截止停止。

## 3. 超时归因与停止

`RuntimeControlFacts` 增加可选 `timeout`：

```json
{ "layer": "session|tool|check|run|batch", "stage": "runtime|verification",
  "limitMs": 1000, "elapsedMs": 1000 }
```

- Session 到点：`reason=runtime_timeout`，`timeout.layer=session`。
- 工具到点：Runtime 结果 `terminal=timed_out, reason=tool_timeout`，
  `timeout.layer=tool`，`limitMs` 取请求的单工具上限。
- Run/Batch 到点：`reason=parent_deadline`，`timeout.layer=run|batch`。
- `limitMs/elapsedMs` 未知时为 `null`；耗时使用单调时钟观测，不写 0 冒充已知。
- Attempt 继续保存 `error_kind=timeout`、`execution_stage`、已知
  `duration_ms/exit_code`；停止未确认时 Attempt `interrupted`、租约
  `quarantined`，不释放占用。
- 取消/完成/超时竞争由监督器单次 `stop` 与既有 fenced settlement 决定；后到的
  取消或结果不覆盖已落库的控制事实与证据。

## 4. Fake 与宿主边界

FakeRuntime 支持本契约可核验的 Session/工具上限：Session 由 Core 监督器计时，
工具由既有 `CommandProcess` 的真实进程组超时与停止核验实施；检查由
`NodeTaskVerification` + `CommandProcess` 实施。FakeRuntime 不声称提供 Pi/Durable
原生的模型请求级硬超时；需要该能力时由 P04 适配器显式实现或拒绝，不能把
“模型字符串合法”当成已支持恢复/硬超时。超时测试不调用真实模型。

## 5. 验收证据

- `test/modules/execution/control/p03-9-f004-time-limits.test.ts`：纯受控时钟解析、旧/新配置兼容、非法
  输入拒绝、Run/Batch 已过 deadline 不启动、Session/工具真实受控进程停止、
  Verifier 检查独立超时与父 deadline 不启动、停止未确认隔离、超时后迟到取消
  不覆盖已落库证据。
- 既有 `p03-6-execution-process-stopping`、`p03-6-execution-uncertainty`、
  `p03-6-runtime-settlement` 回归保持通过。
