# P07-2 F-008 Recorder/Runner 集成矩阵

F-008 增加真实临时 Git/SQLite/Artifact 文件、默认 Core/Host/HostClient/CLI 投影和真实受控 CommandProcess 子进程的有限故障矩阵。测试不连接模型；FakeRuntime 只提供确定性事件脚本和工具命令装配，工具进程仍由生产 `createCommandProcessAdapter` 启动、限流和停止。

## 场景与证据

`test/modules/runtime/p07-2-f008-recording-integration.test.ts` 按稳定 case ID 覆盖：

- `f008-normal-continuous`：两条消息包围真实工具子进程，读取公开正文并计算 SHA-256，核对消息/工具序列、Manifest coverage、停止观察、Attempt/Run 次数、依赖 Task 保持 pending，并通过 CLI 投影读取。
- `f008-long-output-overflow`：受控子进程持续写 64 KiB，工具上限为 4 KiB。CommandProcess 产生 `output_overflow`，记录器仍保存完整公开失败事件流；Attempt 仍停在验证前，不能凭 Runtime 失败进入交付。
- `f008-slow-write-backpressure`：首个事件发布由屏障暂停，生产者和慢消费者必须重叠；从 FakeRuntime 真实 bounded channel 读取事件/字节高水位，并核对累计记录上限。
- `f008-disk-write-failure`：默认 Host 的 Artifact staging 写入注入 ENOSPC，Manifest 为 failed、保留受控缺口，Attempt 失败且不创建验证批次/解锁依赖。
- `f008-deadline-manifest-failure`：事件流和 Runtime result 永久等待，1 秒共享期限到达后返回 `recording_deadline_exceeded` 与 `safeStopRequired`；迟到操作不推进水位。
- `f008-restart-prefix`：真实恢复核对只返回 `verified_prefix`/`metadata_only`，不授权 Runtime continuation 或 Task passed。
- `f008-recorder-faults`：真实 SQLite/Artifact 故障观察已收前缀、队列/正文缺口、重复回放去重、上游故障与迟到完成交错的幂等结果。

每个场景将触发条件、组件、结果、失败原因、实际 argv/退出码和结构化事实写入 `SHIPLOOP_F008_EVIDENCE_DIR`；默认目录是仓库 `tool-logs/p07-2-f008-evidence/`。失败清理在测试 finally 中先释放屏障并关闭受控进程，再关闭临时 SQLite/Git 资源。

## 局部验证

本地定向命令：

```text
node scripts/run-tests.ts test/modules/runtime/p07-2-f008-recording-integration.test.ts
```

最近一次结果：7 tests passed，exit 0，约 54.60 秒；完整日志与退出码见 Harness `verifications/F-008/runtime-logs/f008-green-6.log` 和 `.exitcode`。F-007/F-005 等受影响回归已登记在 F-008 v2 索引，交由独立 Nezha 验证执行；未运行全仓 `npm test`、`npm run verify`、Phase 验收或真实模型。

该测试事实不签署 Feature/Phase，也不把 Attempt 的 `verifying` 或 CLI 查询成功解释为 Task/Feature 通过。`npm run verify` 仍保留为 Feature 收尾门禁，由独立门禁按确认范围执行。
