# P04-7 F-008：真实进程与资源故障矩阵

F-008 使用生产 CommandProcessAdapter、真实临时 SQLite/Git/Artifact 和 startup recovery/reconciler，验证停止确认、保守隔离和测试所有权清理。生产代码未改动。当前 macOS 进程实现对应的四个新增测试文件均限定 Darwin；其他平台跳过不代表能力通过。

## 本地结果

所有测试命令通过分配中的 `nezha.dag.test_command` 包装，完整 stdout/stderr、原始退出码和 JSON sidecar 保存在当前 Feature workspace 的 `verifications/F-008/runtime-logs/`。

| 范围 | 结果 | 日志 |
| --- | --- | --- |
| 进程矩阵、资源矩阵、分层 deadline、失败证据四个新增文件 | 22 passed / 0 failed / 0 skipped，exit 0 | `test-j4ja3q2_.log` |
| 原 supervised-command-process 的 `fails closed when the Host dies` 精确用例 | 1 passed / 14 skipped，exit 0 | `test-kz4xvrj9.log` |
| `npm run typecheck` | exit 1，只有两个未改动文件的三条既有诊断 | `test-h5qu8x94.log` |

类型检查的剩余诊断为 `authorization/authorization-contract.test.ts:131` 的 TS2366，以及 `execution/control/p04-7-f001-stop-diagnostics.test.ts:57` 的两条 TS2322（unknown/confirmed 和 null/string）。这两个文件与 HEAD 一致；新增夹具和测试没有类型错误。未通过忽略文件或放宽类型来掩盖这些诊断。

分层 deadline 早期误读 Attempt diagnostic 而非 Session settlement、资源夹具的状态契约/过期计数等 RED 和中间失败日志仍保留，最终通过只以表中日志为准。

## 覆盖与边界

- 三代 Node writer 真实持续写入：正常结束、取消、SIGTERM 宽限后真实 SIGKILL、Tool timeout、父命令提前退出但孙进程仍持续写入。测试在父退出后明确要求 handle 仍 running，随后才确认整组缺席。
- 完整 ExecutionService/FakeRuntime 运行 Tool、Session、Run、Batch 四层超时，核对持久 settlement 的原始原因/层级/时限、flush、停止、一次 Attempt、三项 lease 释放、后续写入未执行，以及迟到取消不覆盖 timeout。
- 真实测试 Host 在身份持久化但尚未 ack、以及 writer 已启动两处被 SIGKILL；新连接/新恢复服务只读持久身份，核对整组停止、恢复 reconciled、lease 释放、无新 Attempt、重复恢复幂等。原 Host-loss helper 的无 ack 协议兼容用例另外精确验证。
- PID 指向测试 runner、PGID 观测失配、startTime 失配、probe unknown、停止 census 缺失、启动回执缺失、原生 Session 占用、flush 缺口、lease 过期，共九项资源负例。所有负例均保留三项 quarantined lease 和隔离工作区，拒绝认领替代 Task，Attempt 数保持 1。身份/探测负例不发信号，适用场景继续观察孙进程写入；原生占用/flush 场景即使 OS 进程已停止，业务隔离仍保留。
- 故障事实在测试夹具明确 seed；PGID 失配在观测端注入，不写入协议不允许的矛盾身份。原生占用和 recording 缺口使用持久 Session 事实，未运行真实模型或私有 SDK Session。

## 清理证据

设置 `SHIPLOOP_PROCESS_MATRIX_EVIDENCE_DIR` 可指定 sandbox 外的证据根，本次最终运行位于当前 Feature workspace 的 `verifications/F-008/process-evidence/`。每个场景包含：

- `cleanup-manifest.json`：PID/PGID/startTime/角色、已观察退出结果、整组和各身份缺席、停止证据、文件 SHA-256、资源表快照、业务隔离/恢复证据和未确认项。
- `files.json`：writer 与控制文件内容；资源库存另记录 fixture 文件路径、类型、大小和可用摘要。SQLite 使用业务表快照，不复制活跃原生数据库。
- `cleanup.json`：兼容既有 acceptance cleanup 的 `status`、`processTreeStopped`、`processGroupsStopped`、`resourcesRemoved`、`retainedRoot`、`failures`，另含 `matrixStatus` 和主 manifest 路径。

`pass` 表示场景断言通过，且最终测试所有权清理已确认。资源负例中的业务结果仍以 observation/resource 的 `manual_required`、quarantined lease 和拒绝新 Attempt 为准；测试移除自己创建的资源不授予业务重试权限。`unconfirmed` 保留失败断言和已停止现场；`manual_required` 保留未确认项并阻止删除；真实模型/外部通知始终 `not_run`。非父进程退出状态无法直接 wait 时保持 `exit: null`，不会把缺席伪装成 exitCode 0；真实 Host 退出信号另记在 observation。

最终清理始终使用全新真实 adapter，避免复用故障 probe。只有整个受控组和全部已观察身份缺席、没有未知对象且场景未失败，才删除 matrix sandbox。两个专门的失败证据测试证明：断言失败后保留 root、内容和退出证据；未知资源/符号链接出现时输出 `manual_required`，不跟随链接删除无关工作区。

最终审计已读取本次 22 份 manifest 和 companion，并重新对照真实进程 census：87 个已观察进程身份均缺席、所有受控 PGID 均缺席；20 个成功 sandbox 已删除，两个预期失败证据 sandbox 按设计保留。摘要见 `verifications/F-008/manifest-audit.json`。历史 RED/失败现场不清空。

## 独立验证交接

仓库索引为 `test/index/phases/P04/features/P04-7/tasks/F-008.json`，Harness `verifications/F-008/test-selection.json` 只引用该索引。共 14 个文件：本地四个新增文件已完整执行；supervised-command-process 仅执行上述一个兼容用例，其余用例和其他九个回归文件交 Nezha 独立执行，不能据本地结果宣称通过。

没有运行全仓测试、verify、accept:p04、Feature/Phase 或 live 验收，没有调用真实模型或发送外部通知。全仓类型检查的既有错误仍是明确限制；最终 Feature 门禁、人工处置和生产 Host 验收由 Nezha 独立执行。正式 task_list.json/feature.yaml 保持只读，提交与 completed 报告以 Git/Nezha 回执为准。
