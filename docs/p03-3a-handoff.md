# P03-3A 通用恢复协议交接（F-005）

## 1. 范围与权威边界

输入为 `core-design/14-runtime-recovery-and-durable.md` 与 P03-3A Feature 源 PRD。
实现基线：F-001 `88846da`（恢复身份/能力契约）、F-002 `fed3162`（独立能力目录与
来源核验装配）、F-003 `e00f983`（确定性恢复/副作用夹具）、F-004 `a95eb94`
（Pi Durable 1.2.0 锁定实验与 P04 决策）。F-005 只做文档交接与公共入口兼容测试，
不新增产品行为、依赖或迁移。

**Core 权威不变**：授权、Batch/Run/Task/Attempt、预算预占/结算、fencing、取消与
恢复决策由 Core 决定；Runtime 适配器只执行被授权的请求。原生执行成功、SDK
requestId 去重或原生 terminal 都不等于 Task passed，也不会创建/退还额度。
Core SQLite 与原生 Runtime 存储分离，不假设跨库原子提交。

**Work/Chat 独立控制**：恢复请求以判别身份区分 `purpose: 'work'`
（runId/taskId/attemptId）与 `purpose: 'chat'`（sessionId/turnId）；两者共用本契约
与未来的供应商适配代码，但 Chat Session/Turn 业务控制是独立后续服务。本 Feature
**不提前实现** Chat UI/托管 Chat、Scheduler、Attempt 数据库新表或完整生产
Runner/SessionRecorder；现有 P03-3 预占/结算账本语义保持。

## 2. 交接接口（实际交付，唯一一套）

以下均为 `shiploop-core` 公共入口真实导出；后续任务必须引用这些接口，不得重建
第二套恢复协议。

### 2.1 恢复请求与稳定身份 — `packages/core/src/ports/runtime-recovery.ts`

- `RuntimeRecoveryRequest`（schemaVersion=1、projectId/sessionId、executionVersion、
  invocationId、判别 identity、strategy、显式 recovery 选择）、
  `RuntimeRecoveryReference`（不可变来源：同项目 Artifact 身份 + sourceDigest，
  禁止原生路径）、`RuntimeRecoverySelection`（new/auto/required ×
  conversation/checkpoint）、`RuntimeRecoveryDecision`（resume/rejected/new + 确定性
  reasons）。
- `invocationId` 是 Core 授权的适配器入口身份：同一存活 Attempt 内网络重试保持
  不变；新 Attempt/新 Turn 必取新值。SDK requestId、工具 ID、进程启动预占
  startKey 与 invocationId 互相独立，不得混用。
- 纯校验零 I/O，未知字段/非法版本（`unsupported_schema_version`）在适配器调度前
  拒绝。详见 `docs/p03-3a-runtime-recovery-contract.md`，可执行示例
  `test/p03-3a-runtime-recovery.test.ts`。

### 2.2 运行期能力与决策

- `RuntimeRecoveryCapabilities`：五项独立能力 nativeHistory / conversationResume /
  executionRecovery / modelSwitchOnResume / nativeFork，各自携带
  verified/unsupported/unverified、evidenceRef（Core Artifact ID）与显式 limits；
  sdkVersion 可为 null，nativeFormats 版本精确匹配、不推断兼容。
- `decideRuntimeRecovery`：required 缺证据/格式即 rejected（绝不降级）；auto 降级为
  new 并带原因；两种恢复都要求 nativeFork 保持来源不可变；换 provider/model 另需
  modelSwitchOnResume。决策不是启动证明、验收证明或 exactly-once 承诺。

### 2.3 独立恢复目录与策略核验 — `ports/runtime-recovery-catalog.ts`

- `createStaticRuntimeRecoveryCatalog`：可信装配注入的描述符目录，独立于
  `RuntimeCapabilityCatalog` 配置兼容性目录；`duplicate_runtime_id` 与
  `unknown_runtime`（配置目录没有的 Runtime）明确拒绝，且不回写配置目录。
- `validateRuntimeRecoveryStrategy`：先走既有配置兼容性校验，再核恢复描述符；
  `descriptor_runtime_mismatch` 拒绝。未注入目录时返回 undefined，由
  `decideRuntimeRecovery` 报 `capabilities:unverified`。
- 可执行示例：`test/p03-3a-runtime-recovery-assembly.test.ts`。

### 2.4 原生存储所有权与来源核验 — `ports/runtime-recovery-source.ts`、`application/runtime-recovery.ts`

- `RuntimeRecoverySourceReader`（readCurrent/readSource）是**可信内部注入**，绝不从
  客户端载荷反序列化；客户端任意原生绝对路径无法进入恢复流程。
- `RuntimeRecoverySourceEvidence`（kind=`RUNTIME_RECOVERY_EVIDENCE_KIND`）把来源
  身份、原始输入快照、原生档案/检查点 Artifact、代码与权限摘要绑定；缺失停止证据
  （stopped 非 confirmed）拒绝恢复。`RuntimeRecoveryService.evaluate` 只做预检：
  核对 Artifact 身份与内容、输入/代码/权限未漂移、读取期间授权未变，然后交给
  `decideRuntimeRecovery`；**不启动进程、不预占或退还预算、不返回原生路径**。
- 原生档案同时只允许一个写入者属于 Runner/SDK 层责任（F-004 实测 Durable 不强制，
  见 §5）；Core 侧约束是来源不可变 + 新 invocation 分支，不裸复制仍打开的库文件。

### 2.5 记录去重接口（夹具边界）— `test/helpers/runtime-recovery/`

- `SyntheticEventRecorder`：按原生 session/event 稳定身份去重（不按文本或顺序），
  fsync 完整行后才推进持久前缀水位；撕裂尾部、身份冲突、缺字段保持 partial。
- `SyntheticUsageLedger`：增量/累计模式互斥、显式历史基线、历史/当前消费分离、
  父子覆盖范围互斥；无有效当前用量时总量为 unknown 而非零。
- 这些是 F-003 确定性夹具（见 `docs/p03-3a-synthetic-recovery-fixtures.md`），
  **不是生产 SessionRecorder**；生产 Recorder 必须复用同一身份/水位/范围语义，
  不得把夹具或 SDK 原生库直接当统一审计库。

### 2.6 组合根接线 — `adapters/composition.ts`

- `openCoreApplication` 接受可信注入 `runtimeRecoveryDescriptors`（描述符数组）与
  `runtimeRecoverySources`（来源读取端口）；装配产物暴露
  `app.runtimeRecovery`（RuntimeRecoveryService 预检）。不安装默认生产 Runtime，
  缺 sources 时来源恢复明确拒绝（`source_reader_unavailable`），非法注入在 I/O 前
  拒绝（`source_reader_required`）。

## 3. 公共入口兼容（F-005 新增冻结断言）

`test/p03-3a-runtime-entry-compat.test.ts`：

- 干净 Node 子进程（仅 PATH、沙箱 HOME/cwd，无 vitest、无 dist 构建）加载
  `packages/core/src/index.ts`，恢复契约全部导出可用；加载守卫禁止
  Pi SDK/Durable、Electron、better-sqlite3、Drizzle 与 node 网络模块进入解析，
  并以装配入口（合法使用 better-sqlite3）触发 `forbidden specifier` 证明守卫非
  空转——**无 SDK 依赖仍能加载 Core 公共入口**是可执行事实，不是静态推测。
- 未知/重复 Runtime 经公共入口明确拒绝（`unknown_runtime` /
  `duplicate_runtime_id`），配置目录不被顺带修改。
- 既有面保持兼容：`assessSettingsConfiguration` 仍是 executable:false
  （`execution_capability_not_assembled`，模型配置合法 ≠ 可执行或可恢复）；
  SETTINGS_SCHEMA_VERSION=2、WIRE_MESSAGE_SCHEMA_VERSION=5、
  WORK_ACCEPTED_SCHEMA_VERSION=6、BUDGET_SNAPSHOT_SCHEMA_VERSION=1 冻结；
  恢复契约 schemaVersion≠1 一律 `unsupported_schema_version` 显式拒绝。
  Host 协议、CLI 命令面、预算/授权/迁移在本 Feature 未改动。

## 4. P03-4 / P03-6 / P03-9 实施依据（不得重建第二套）

- **P03-4（Task DAG/Attempt）**：Attempt 与 invocationId 身份取自 §2.1 契约；
  `reserveTaskAttempt` 与 Attempt 创建同事务的既有语义保持，executionVersion 即
  fencing 代；旧执行结果不因恢复身份复用而绕过 fencing。
- **P03-6（FakeRuntime/接口冻结）**：Fake 按 §2.2 能力差异（verified/unsupported/
  unverified）驱动恢复决策分支，覆盖检查点引用、事件重放/去重与停止不确定；
  真实启动边界先走既有 `reserveRuntimeStart` 预占，再用本契约 invocationId 进入
  适配器——进程启动、模型请求、SDK request 是三个独立幂等身份。
- **P03-9（Run 控制与恢复）**：续接或新会话由 `RuntimeRecoveryService.evaluate`
  预检 + `decideRuntimeRecovery` 决策承载；不重开终态 Attempt、不清空累计预算；
  未确认停止（stopped 非 confirmed）的旧进程不得恢复，外部副作用先核验再采纳。
- 各任务的验收必须引用上述真实导出与既有测试文件；发现契约不足时回到本
  Feature 修订，不在下游另起平行协议。

## 5. P04 实验矩阵与 not_run 门槛（可追溯）

- 决策记录：`docs/p03-3a-pi-durable-capability-matrix.md`——**P04 默认保留标准
  Pi SDK，Pi Durable 1.2.0 仅显式 opt-in 实验候选**；真实 SDK 能力矩阵逐行带
  verified/unsupported/not_run 与证据，并与 F-003 Fake 结果分列。
- 证据与版本锁定：`experiments/pi-durable/sources.json`（npm integrity、参考
  tag/commit、spec SHA-256、命令与退出码）、`experiments/pi-durable/evidence.json`
  （原生检查点、工具结果、进程退出信号、副作用次数）；Node 22.19.0/npm 10.9.3。
- 复跑：`SHIPLOOP_PI_DURABLE_SPIKE=1 node scripts/run-tests.ts
  test/p03-3a-pi-durable-spike.test.ts`（14 项真实 SDK 断言；未设置该变量时项目
  测试只做版本隔离，不算 SDK 通过）。
- P04 门槛（矩阵文档 §P04 门槛与 Core 边界）：真实认证/模型、标准 1.0.4 与
  Durable 1.2.0 桥接、真实 Skills/MCP/插件、跨 provider 恢复、原生 fork、JSONL
  backend、跨版本归档等均为 not_run，不折算成功；满足门槛前任何 Runtime 不得
  注册 production `executionRecovery=verified`。

## 6. 不声称与 not_run

- 本交接不声称：完整 Durable/Pi 生产接入、生产 Runner/Scheduler/SessionRecorder、
  托管 Chat、真实认证/付费模型、SIGKILL/断电耐久、外部副作用 exactly-once、
  Token 节省。真实 SDK 的 unsupported/not_run 保持原样，不由文档守护折算通过。
- F-006 负责 Feature 全量回归与独立恢复边界验收；本文件的交接描述以实际代码
  与本节所列测试为准，不替代 F-006 验收。
