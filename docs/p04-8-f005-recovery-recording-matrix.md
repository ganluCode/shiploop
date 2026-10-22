# P04-8 F-005：恢复、记录与用量离线矩阵

## 执行边界

任务索引：`test/index/phases/P04/features/P04-8/tasks/F-005.json`。
索引组合已有公开接口契约与新增的跨边界用例，不复制测试包装文件、不递归调用测试或阶段入口。
本 Task 不修改生产恢复政策、预算、状态机或依赖；不引入 Durable 生产引擎。

新增可复用观察库：`test/helpers/p04-8/recovery-recording-fault-matrix.ts`：

- `runRecordingFault(scenario)`：真实 Git/SQLite/Artifacts 与受控 RuntimeHandle；返回
  scenarioId、coverage、水位、已核验分块序列、父子工具关系、用量、缺口及业务状态比较。
- `runUsageConsistencyFault()`：公开用量规范化/投影接口；返回每 Attempt 与 Feature 的实际去重结果。
- `runLateResultFault(fence)`：真实认领/输入绑定、Session 与 settlement 入口；返回真实回执与持久状态比较。

不依赖网络、凭据或模型。读取 Git HEAD 使用有界同步只读命令；没有后台进程或 sleep。
每场景独立沙箱，并在 finally 关闭连接及清理自有资源。

## 验收矩阵与实现证据

以下文件均相对 `test/modules/`，完整选择以 Task 索引为准。

| 要求 | 用例入口 | 可观察断言 |
|---|---|---|
| 同 Task、停止、来源身份、输入/代码/权限 | `runtime/recovery/p03-3a-runtime-recovery-assembly.test.ts` | 真实 Artifact 索引和文件核验，active/unknown/missing 停止证据、身份矛盾、物理损坏、异步读取中权限变化均拒绝 |
| 当前认证/资源兼容 | `runtime/recovery/p04-4-runtime-recovery-access.test.ts` | 认证/资源不可用或摘要/provider/model 漂移不得复用 |
| auto/new/required、未知副作用、旧占用、已通过 Task | `recovery/p03-9-f007-recovery-continuation.test.ts` | auto 明确记录降级原因、new 忽略旧原生来源但不绕过安全门槛、required 拒绝不支持；unknown-git-effect 在三个模式都拒绝，旧输入/预算不变 |
| 标准 Pi 原生单写入者与档案错误 | `runtime/p04-4-pi-managed-session.test.ts` 的 12 个选定 case | 同目录竞争只有一个写入者、恢复竞争不改来源、损坏 JSONL/版本拒绝、auto/required 分离、checkpoint 不冒充 conversation、authority 变化/停止未知拒绝 |
| 恢复水位、历史累计与重复回放 | `runtime/recovery/p04-4-recovery-recording.test.ts` | Core 水位优先；历史缺口保留；重复新增 usage 只计一次；累计/未知范围不加入新消耗；流失败仍有可核验清单 |
| 事件/usage 重投与父子工具身份 | 新文件 `runtime/p04-8-recovery-recording-fault-matrix.test.ts`，`f005-replayed-recording` | 8 次投递只保存 4 条，父子身份保留；input=7，原生 final=900 独立保存且 notAdditive，不得到 907 |
| Attempt 汇总、子请求、恢复基线 | 新文件 `f005-usage-scopes`；`runtime/p04-6-usage-cross-scenarios.test.ts` 的 3 个选定 case | 旧 100、原生累计 150、历史基线 100 ⇒ 新 50，总计 150；子明细与重复 summary 不加入总数；无法归属的回放保持 partial/unknown |
| 大消息 | 新文件 `f005-large-message` | 超限正文省略而不是伪造完整内容，水位只到 3，Session/manifest 都保留 `event_body_too_large:4` |
| 磁盘写入失败 | 新文件 `f005-disk-write` | 在第二次 staging write 注入 ENOSPC，第一分块仍可读且校验成功，水位=2，失败分块索引保留，取消被请求，coverage=failed |
| 独立原生数据库损坏 | 新文件 `f005-native-database-corrupt` | 创建并关闭真实独立 SQLite 后破坏文件头，重新打开明确拒绝；错误穿过 Runtime 事件流，Recorder 保留序列 1–2、failed 清单与 Session 缺口，Core 库仍可读且业务行不变 |
| 迟到结果、代次与持有者 fencing | 新文件 `f005-late-task-version` / `attempt-version` / `owner` / `host` | Task 代次前进、错误绑定到另一 Attempt 代次、旧 owner/Host 的结果各重复投递两次，全部 ignored/stale_execution_identity；只留一条有界诊断，不发布结果 Artifact |

最后一组比较 Task/Attempt/Run/Batch、预算与启动预占、工作区租约、验证/check、Git 操作、
审批项、命令/认领/Attempt 回执、领域事件的完整持久行；另外比较 Artifact 索引、Session 和真实 Git HEAD。
因此迟到 usage、输出和停止声明不会推进业务状态、释放占用、改变预算、验收或交付。

所有记录故障场景同时断言 Runtime 返回 completed 时 Task 仍为 running，后继未被提前解锁。
Recorder 的成功/失败不冒充独立验收。

### 数据库与 SDK 事实的区别

数据库损坏用例是通用 Runtime 存储故障注入，不声称标准 Pi 使用 SQLite，也不验证 Durable。
它只验证独立存储错误经过现有 Core 记录边界后的业务隔离及缺口保留。
标准 Pi 使用 JSONL 的损坏/格式/单写入者行为由上述真实已安装 SDK 的离线选定 case 验证，
不读取 SDK 私有表，不承诺跨存储原子性或外部副作用 exactly-once。

## 本地验证与交接

- 本次新增文件 9/9 通过，退出码 0；最终日志 `test-c2pofobe.log`。
- TDD：初始 replay RED 为 `test-10rnkapy.log`；最小 GREEN 为 `test-2fer9c4y.log`；
  扩展矩阵 RED 为 `test-tfvsl617.log`。调试失败日志均保留，未删除断言或禁用数据库保护。
- `npm run typecheck` 退出码 1，日志 `test-243qo6ho.log`：仅 3 个既有错误，位于
  `authorization-contract.test.ts:131` 与 `p04-7-f001-stop-diagnostics.test.ts:57`（两处）。
  本任务新增文件没有类型错误；未修改无关测试来消除旧错误。
- 日志及真实退出码 sidecar 位于 Harness 的 `verifications/F-005/runtime-logs/`。
- 其余六个既有文件/选定 case 仅登记给 Nezha，**本次 Runtime 未运行，不宣称通过**。
  独立验证以当前索引及实际结果为准。
- 全量、Phase、live 与负责人签字未运行/未取得；本地结果不代表 P04 已验收或放行 P05。
