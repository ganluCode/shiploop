# P06-4 F-009 交付说明：Session 隔离与故障集成

## 范围

F-009 新增 `test/modules/runtime/p06-4-f009-mcp-integration.test.ts`，使用真实 macOS 子进程 Fake MCP server、真实 stdio、持久 JSON ownership registry 和进程组 census 验证：

- 两个 Session 使用不同获准工具时同时完成启动和调用；工具名称、结果、调用文件和进程身份按 Session 隔离，复制另一个 Session 的工具 binding 在发起 server 调用前拒绝。
- 一个 Session 的挂起调用被取消并清理时，另一个 Session 的同名工具仍可调用，且其登记和进程保持存活。
- 相同身份和计划的重复启动复用同一连接和进程；并发 close 返回同一停止证据，登记只删除一次。
- 真实 Fake server 返回 `isError`、异常退出时，工具结果分类、调用文件和进程登记清理保持一致。
- 停止核验无法证明进程组消失时返回 `unconfirmed`，保留真实登记；夹具清理使用匹配的 PID、进程组和启动时间收尾。

前序资源授权、MCP 审计/Recorder、SQLite 持久记录、Pi Runner 强杀/停止和恢复回归登记在 F-009 Task 索引中，沿用 F-001 至 F-008 的真实测试文件。Task 索引为仓库内唯一测试范围来源，Harness 选择文件仅引用该索引。

## 离线边界

测试仅使用本地 Fake server、临时目录和既有测试夹具；不读取真实凭据、不调用模型、不访问远程 MCP。正式支持平台为 macOS；其他平台未验证。可信项目模式仍不表示强 OS 沙箱。

## 验证记录

工具链：Node `v22.19.0`，npm `10.9.3`。测试与类型检查均在 macOS/darwin 工作树执行。

| 组 | 命令 | 结果 |
| --- | --- | --- |
| F-009 新增集成 | `/Users/ganlu/.local/pipx/venvs/nezha/bin/python -m nezha.dag.test_command --log-dir /Users/ganlu/Documents/my-dev/code/ai-coding/shiploop-harness/workspace/features/2026-10-27-15-09-56_p06-4-stdio-mcp/verifications/F-009/runtime-logs -- node scripts/run-tests.ts test/modules/runtime/p06-4-f009-mcp-integration.test.ts` | 6 passed, 0 failed；退出码 0；3.553 秒；结构化报告 `test-o2xq3azl.log.json`，完整日志 `test-o2xq3azl.log`，旁文件 `test-o2xq3azl.log.exitcode` |
| 直接相关回归 | 同一受控 runner 执行 `p06-4-f009-mcp-integration.test.ts`、`p06-4-f007-mcp-audit-recording.test.ts`、`p06-4-f008-pi-mcp-lifecycle.test.ts`、`p06-4-f008-pi-mcp-recovery.test.ts`、`p04-1-pi-stopping.test.ts` | 5 文件、77 passed、0 failed；退出码 0；14.291 秒；结构化报告 `test-fgotucto.log.json`，完整日志 `test-fgotucto.log`，旁文件 `test-fgotucto.log.exitcode`。该组包含真实 SQLite Recorder、Runner 生命周期和停止/恢复覆盖 |
| 类型检查 | `npm run typecheck` | 退出码 0；完整日志 `tool-logs/F-009-typecheck-final.log`，旁文件 `F-009-typecheck-final.log.exitcode` |
| 模块边界 | `npm run check:boundaries` | 退出码 0；453 个生产源文件、0 diagnostics；完整日志 `tool-logs/F-009-boundaries.log`，旁文件 `F-009-boundaries.log.exitcode` |
| `npm run verify` | 未执行 | `not_run`；这是 PRD 的独立受控全仓门禁，不由 Task Runtime 代跑或以局部绿灯替代 |

新增代码的受测提交为 `98fb38394013fbfb2e9bbdda80de811c699cab59`（提交前工作树基线为 `89d2fd00931181de8252827edbce7ffc4b15932a`）。测试过程中每个夹具均在 `finally` 中按受管身份清理，停止不确定用例明确核对登记保留后再由匹配身份收尾；未发起真实模型、远程 MCP 或后台 Runner。

Feature task_union、完整 verify 和 Phase 验收由编排/独立 Verifier 按各自门禁执行，不能由本说明预先宣称通过。
