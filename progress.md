# P04-4 工作进度

## F-005 — attempt 3 恢复授权夹具返工（2026-10-21）

- 从干净的 `5f358a7` 增量续做，核验 recovery 和独立验收 `0d726d8076d940b18406188d8d399750`：20 文件/399 用例仅 required 恢复正例失败，原因 `work_access_missing`。本次 invocation `82fe917191734daf98ec68723e276af6`。
- 只为旧测试夹具的当前状态和不可变恢复证据补齐相同的合成 Fake workAccess（策略、ready 认证摘要/引用、空资源列表）；reader 遵循 unknown 端口，经真实服务校验。生产校验和所有断言均保留，包含 unknown 停止状态拒绝授权。
- RED `test-oblrziny.log` 复现验收失败；最终输入绑定/访问复核两文件 47 passed、0 failed、0 skipped，`test-g_pft89i.log` exit 0；类型检查 `test-z1aiuivf.log` exit 0。中间类型冲突与已通过运行保留但不重复计数，详见交接文档。全部日志和完成 sidecar 位于 Feature workspace 的 verifications/F-005/runtime-logs/。
- 已复核原 20 文件 v2 索引和 Harness selection，两份本地执行文件均已登记；完整 affected 回归由 Nezha 独立执行。本轮未跑全仓/组合门禁/阶段验收/live 模型，未改官方元数据或人工 hold。提交及本 invocation 的单次 task report 以 Git/Nezha 回执为准。

## F-005 — attempt 2 独立验收返工（2026-10-21）

- 核验 recovery、Git 与现有日志后从 `4eb61ca` 增量续做，保留已提交成果；当前 invocation `ac864a2e5344447195b5a4bbb57c56d1`。初次 completed claim 后独立验收失败，不能沿用旧报告证明本次完成。
- TDD 修复冻结 launch 的回执消费/重放：输入、SQLite 持久读取和绑定共用严格校验；未知字段、无效 ID、与请求不同的 Session/invocation、损坏持久身份均拒绝。数据库重开重放幂等，同 key 换身份冲突，拒绝不产生额外业务写入。两份迁移测试补列 v31，保留历史、回滚、幂等与外键断言。已有原生锁构建成功，Host 实际执行验证加载通过。
- Pi 装配保持 unknown usage 不累加的保守语义，明确断言成功 SDK 结果仍可能因 required 记录 partial 而失败；增加无 usage 的完整消息流成功对照。取消保留 `recording_failed:aborted`，未删除诊断或放宽产品规则。生产恢复记录实现无额外改动。
- 本次定向五文件 13 个不同用例通过：test-6c36o__w.log（回执/绑定/迁移 4）、test-gc8drgel.log（Host 4）、test-5ad35qkk.log（Host race 1）、test-j0og2vp5.log（Pi 装配 4），均 exit 0；类型检查 test-gr8het49.log exit 0，架构边界 test-fb9l8nw0.log exit 0（315 文件/0 diagnostics）。RED test-oqoj2g23.log、test-zhd1u3hn.log 和中间诊断保留；中断且无完整退出码的运行不计成功。完整日志与真实退出码 sidecar 均在当前 Feature workspace verifications/F-005/runtime-logs/。
- [交接文档](docs/p04-4-f005-recovery-recording.md) 已区分首次 18 项与本次 13 项证据。F-005 索引增加 claim/输入绑定两份受影响文件，共 20 文件，Harness selection 继续引用索引；较广 affected 回归由 Nezha 独立运行。本轮没有执行全仓测试、组合门禁、阶段验收或 live 模型，未修改正式 feature.yaml/task_list 或人工 hold。本次提交与单次 task report 结果以 Git/Nezha 为准。

## F-005 — 恢复交接与新增记录边界（2026-10-21）

- 续做 F-003/F-004 后的当前分支，保留前序提交。增加有界 RuntimeRecoveryRecording，并贯通 Pi Adapter、Runner 协议、Core 句柄、Recorder 与失败结算：来源 Attempt/Session、档案摘要、SDK/格式版本、实际模型/决策、Core 旧水位和独立原生条目水位可追溯，不复制历史正文。
- 新调用序列从 1 开始；排除不匹配的历史最终快照，重复消息/事件只记一次。累计或范围不明 usage 不累加、不猜差值；无新 usage 或证据缺失保留 null/partial/unknown。Session 支持 started 后首次补齐异步原生绑定，拒绝身份替换/旧 fence/终态后补写；结算合并旧 gaps，保留取消、失败、模型拒绝和停止不确认事实，并脱敏已知凭据。
- 本地六份定向范围共 18 个不同用例通过，未声称运行这六份文件的全部既有测试。最终日志依次为 test-v1fobwj0.log（Recorder 6）、test-vz9r_ev7.log（原生边界 6）、test-w6qpaoox.log（Runner 2）、test-cqzy2_6g.log（Core 句柄 1）、test-smkicx7o.log（Session 1）、test-g93r_kq2.log（结算 2），均 exit 0。末次类型检查 test-7jg4ts73.log exit 0；边界检查 test-4x5j53yw.log exit 0，315 文件/0 diagnostics。完整输出、真实退出码、RED 与中间诊断均保留在 Feature workspace verifications/F-005/runtime-logs/。
- [恢复记录交接](docs/p04-4-f005-recovery-recording.md) 说明消费契约与验证限制。F-005 v2 索引及 Harness 引用 selection 登记 18 个受影响文件：六份本地文件的完整回归和另十二份仅选择文件交 Nezha 独立验证。未跑全量/组合门禁/阶段验收/live 模型，未修改正式 feature.yaml/task_list；本地提交与 task report 结果以 Git/Nezha 为准。

## F-002 — 标准 Pi 原生 Session 新建与安全加载（2026-10-21）

- 从恢复基线 `3eb47c8` 及当前 `feat/p04/p04-session-recovery` 分支增量续做。核实锁定标准 SDK 1.0.4 的 `SessionManager.forkFrom` 和 JSONL v3，修正旧格式常量。新 Session 通过原子目录认领隔离；恢复只从不可变 Artifact 字节生成只读快照，再 fork 独立原生身份/文件，不重置已有代码。
- 加载前拒绝跨项目/用途/Task、非直接上一 Attempt/Session、已完成 Task、SDK/格式不兼容、损坏 Artifact/JSONL、停止未确认、过期 owner/fence 或非独占 writer。异步读取与 SDK 启动前后重核资格；当前获准 provider/model 和推理配置显式覆盖来源。返回实际身份/格式/版本和恢复事实；只提供 adapter 权限释放，不直接写 Core SQLite、预算、资源锁或 Task 验收。
- 生产默认恢复能力保持 unsupported，checkpoint 和复杂/未核实原生条目明确拒绝。可信装配可注入环境证据；离线 SDK fork 和受控装配不冒称真实模型续聊或跨供应商恢复已验证。后续 Core 来源选择、持久化与纵向接线见 [F-002 交接](docs/p04-4-f002-managed-pi-session.md)。
- 本地 TDD：初始 RED `test-dqjk1j6y.log`；三文件 `test-l69q_y31.log` 53 passed。增加停止不确定用例后发现测试结果字段误写为 status，改为契约 terminal，仅重跑受影响 managed-session 文件：`test-ye8o65y0.log` 37 passed/0 failed/0 skipped；加上已通过的相邻两文件 17 项，共覆盖 54 项。类型检查 `test-uylhgsiq.log` exit 0；边界检查 `test-jpbdacb8.log` exit 0（313 源码/0 diagnostics）。全部完整日志、真实退出码及中间诊断保存在本 Feature workspace `verifications/F-002/runtime-logs/`。
- 仓库 F-002 v2 索引与 Harness 引用 selection 登记 10 个文件；七个较广关联回归仅选择，交 Nezha 独立执行。本轮未跑全量/组合门禁/阶段验收/live 模型；正式 feature.yaml/task_list 只读。提交与任务报告结果以 Git/Nezha 为准。

# P04-3 工作进度

## F-007 — 故障路由组合接线与确定性矩阵（2026-10-21）

- 从 b15b50a、当前 feat/p04/p04-failure-routing 分支续做。可信 Core/Host assembly 贯通冻结备用计划和逐次授权；只在当前 fence 的失败结算持久化、记录完整且停止确认后创建备用 Attempt，沿用预算/deadline/占用转移事务。仅自动恢复 runtime_failed 暂停，拒绝用户暂停/关闭/取消等控制状态；统一启动预占 key，修复备用一次启动被重复计数。
- 失败结果采用有限 drain，避免终端事件未落盘；全链失败停止并保留原因。查询增加按 Attempt 的有界 routing 分类、前序失败和策略摘要，保持旧 wire 兼容并排除 credential/endpoint。新增 19 项组合矩阵、6 项查询边界和 3 项 SDK 边界测试；已有 fallback 事务测试补充控制拒绝与恢复回滚。
- 实测安装 Pi 1.0.4 的 Anthropic stream：内部 maxRetries=2 时 fetch=3；外层控制器包装后仍 fetch=3/requestCount=3/retryCount=2/runtimeStarts=1，Session 自动重试关闭。发现 Bedrock 不读取 maxRetries；未核实的 API 限为一次外层调用，避免内部与外层相乘。OpenAI 依据锁定源码确认配置边界，未声称真实网络测量。详见 [SDK 边界与交接](docs/p04-3-f007-failure-routing-integration.md)。
- 最终本地证据：组合矩阵 19 passed（test-mz2rliax.log）；查询 6 passed（test-wmlcekx3.log）；SDK/request/settlement 26 passed（test-2dz3l_4r.log）；停止、结算、fallback 及架构相关 117 passed（test-yxz7fle5.log）。最后加严控制守卫后只复测相关 5 项，26 skipped（test-6x__d3qa.log），未冒称重跑整矩阵。typecheck exit 0（test-fe0cekqw.log）。所有完整日志及真实退出码 sidecar 在本 Feature workspace verifications/F-007/runtime-logs/，中间失败保留。
- F-007 v2 仓库索引与 Harness selection 已写入，19 个现有文件的路径、模式和唯一性已检查。表外关联回归交 Nezha 独立执行；未运行全仓/组合门禁/Feature 或 Phase 验收/live 模型。没有直接修改正式 task_list.json/feature.yaml；提交与单次 task report 的结果以 Git/Nezha 记录为准。

# P04-2 工作进度

## F-007 — 访问边界集成验证与交接（2026-10-20）

- 恢复基线 19e01fa，沿用当前分支。仅新增测试/证据索引和夹具窄钩子；真实 startHost 启动恢复后认领当前实例 Attempt，同临时数据根验证查询、候选/证据提交、并发幂等、摘要冲突、越权/伪造/过期/撤销及恢复不匹配，拒绝请求保持完整业务快照不变；同根重启拒绝旧 token、旧授权签发和 owner 路由回退。
- 真实 SDK 显式加载获准 skill、计算实际文件摘要生成 manifest，未选全局/项目 skill 零加载；必需能力未核实拒绝、可选能力记录降级、未知枚举拒绝。真实认证文件预检 ready/inference unknown，受控 provider 仍失败；检查 prompt、磁盘输入/Runtime 快照、Runner argv/stdin/environment、普通日志、事件、回执错误及报告不含合成秘密。
- 本地四文件 29 passed/0 failed/0 skipped，exit 0，8269 ms，日志 `verifications/F-007/runtime-logs/test-ygriuwf6.log`；补强 Runtime 磁盘输入/实际 manifest 后仅复测该文件 2 passed，exit 0，1084 ms，`test-h0134pc2.log`。RED/中间诊断及真实退出码 sidecar 全保留。
- typecheck `test-kvx1gnvl.log` exit 1，仅前序已记录 `p04-1-pi-f007-contract.test.ts:77` TS18046，本次文件无新类型错误，不修改其他任务。Task v2 索引共 9 文件，另五个仅选未跑回归交 Nezha。交接 [访问边界验证](docs/p04-2-f007-access-integration.md)，实际证据在 Feature workspace `verifications/F-007/evidence/`。live/全仓测试/Feature 与 Phase 验收为 not_run；正式任务元数据只读，提交和单次报告以 Git/Nezha 记录为准。

## F-005 — attempt 2 验收返工（2026-10-20）

- 从 recovery 核对 HEAD 71e885b 和干净工作树后续做；独立验收 6d1f74dc13a54301a023e8a59e701c91 记录 382/383，通过状态为 false，human_blocked=false。唯一失败是 commands-contract 对未知操作 supportedOperations 顺序的兼容性断言，不能把上次 completed 报告当作验收通过。
- 修复共享信封校验：允许可信调用方指定错误响应的操作顺序，Host 显式传入既有 COMMAND_OPERATIONS；Work 默认仍列本通道 spec。实际白名单判断仍使用原 spec，不增加 Host/Work 操作，不修改或放宽原失败断言。
- 本轮仅复测已知失败文件 commands-contract（110 项）与 task-local work-tool-channel（13 项）：123/123，exit=0，日志 verifications/F-005/runtime-logs/test-1de2bcqy.log。Core 定向类型检查 exit=0，日志 test-dkd7m0jr.log；完整输出、真实退出码和本次 invocation 均由 wrapper 保存。此前全仓 F-007 TS18046 记录保留，本轮未重复全仓检查。
- 审阅并保留 F-005 v2 索引及 selection 的 8 个有效文件；其余 6 个回归本轮未本地重跑，由 Nezha 独立复验。未运行全仓或阶段验收，未改官方任务元数据或解除人工阻塞。本次结果须由继承 invocation 重新单次提交。

## F-005 — Work 受限业务工具通道（2026-10-20）

- 新增 Core createWorkToolChannel：可信 Host/Core 绑定 F-001 授权，仅开放 task.read/candidate.submit/evidence.submit；每次调用、重放和异步校验后核对当前可信主体、project.read/项目可见性、Run/Task/Attempt、Host/invocation/执行 fence、lease、有效期和撤销。请求身份仅作范围断言，伪造主体/管理操作/SQL/文件字段拒绝。
- 候选沿用 verification-candidates 和真实受管 Artifact verifier；证据/候选提交事实存于现有原子 completed/rejected 回执，复用 commandId/requestDigest/resultRef/重放冲突；ReceiptOperation 扩展不增加 Host 操作。提交只记事实，verificationPassed=false，Task/审批/预算/批次/锁/工作区均不变。
- 新增真实 SQLite/Artifact/文件系统聚焦 13 项测试。本地最终 test-7s_ai55o.log：exit 0，13 passed/0 failed/0 skipped（约 7 秒）。首轮缺模块 RED test-gp5qed6z.log 及中间夹具修正失败全部保留；修正依据真实 claim.receipt 和 SQLite 不可变身份约束，未放宽产品规则。
- 全仓类型检查 test-abfv3532.log：exit 1，仅既有 test/modules/runtime/p04-1-pi-f007-contract.test.ts:77 TS18046；此前 F-001/F-004 已记录同一问题，本任务生产代码和测试无新类型错误。日志及真实退出码 sidecar 均在本 Feature workspace verifications/F-005/runtime-logs/。
- 交接文档 docs/p04-2-work-tool-channel.md；索引 test/index/phases/P04/features/P04-2/tasks/F-005.json 和 Harness selection 引用已核对 8 个实际路径。本地只执行新增文件；其余 7 个相关回归未运行，交 Nezha 独立验证。未运行全仓/组合门禁/Phase 验收或真实模型；正式 feature.yaml/task_list 只读。Runtime 接线和纵向验证仍由后续任务处理。

# P04-1 工作进度

## F-005 — Pi Runner 最小取消、有限时限与停止证据（2026-10-20）

- 在 F-002/F-004 基础上连接 Core cancel → CommandProcess 受控信号 → Runner AbortSignal → SDK abort；取消幂等且有限观察，cancel_receipt、terminal result、stopped evidence 独立输出。执行 timeoutMs 到期走同一 abort 路径，保留部分消息、usage、水位、退出信号与原生结果。
- Host inspect 分别记录进程请求接受、SDK 回执、事件流结束、原生终态、进程退出及资源核验；SDK idle/Runner exit 不足以 confirmed=true。注入既有 WorkResourceStopVerifier 时按完整执行和 OS 进程身份核对 token；证据缺失、拒绝或超时返回 false，Core 保留/quarantine 占用并阻止重跑。
- 新增 31 项停止测试，包含真实受监督 Node Runner 的 SIGTERM/SDK abort/进程组核验，以及真实 Core SQLite/Git 的并发取消、一次结算、三个 lease 隔离与重跑拒绝。修复真实 Runner 暴露的 Core usage 外层白名单遗漏 completeness/accounting。
- 最终本地聚焦：3 文件、49 passed/0 failed/0 skipped；test-7axqxts6.log。typecheck：test-escx3giw.log，exit 0；boundaries：test-kfqwk97q.log，291 文件/0 diagnostics。完整日志和退出码 sidecar 位于本 Feature workspace verifications/F-005/runtime-logs/；中间 RED 与夹具诊断保留。
- 交接见 [F-005 停止证据](docs/p04-1-f005-pi-stopping.md)。仓库 F-005 测试索引及 Harness 引用选择已落盘；另五个 Core 受影响回归仅登记交 Nezha。未运行全量、组合门禁、阶段验收或真实模型；未改正式 feature.yaml/task_list，提交与报告以 Git/Nezha 为准。

# P03-10 工作进度

## F-010 — 输入装配历史增长与必需输入完整性确定性回归（2026-10-19）

- 在既有输入装配测试中增加 7 个 `[case:f010-*]` 确定性回归用例（T37 子集），全部沿用前序夹具（p03-2-context-build 的 makeInput/makeBuilder 形态与 p03-6 input-binding-fixture），不调用模型、不新增知识平台、不改生产代码，不宣称缓存命中或 Token 节省。
- 历史增长对照（`f010-history-small-vs-grown-readable`）：同一 Task 小历史 vs 60×2000 字 progress/报告增长，固定指导原样位于历史段之前、历史全文零内联、prompt 有界不随正文总量膨胀；省略/截断在 snapshot 与 manifest 如实标注；描述/全部 acceptance/依赖结果两个规模下逐项可读；必需输入走 sha256 不可变引用；必需区逐字节一致、9 类固定来源摘要不变。
- 输入完整性（`f010-input-manifest-evidence-digest-artifacts`、`f010-progress-report-growth-keeps-fixed-input`）：manifest/读取证据/attempts.input_digest 逐项关联真实制品与可复算哈希（manifest.promptDigest 按 prompt 字节域分离摘要绑定）；t-2 依赖结果与 acceptance 在准备制品组可读；增长 progress/报告 + 源路径内容改变后三正文逐字节不变、增长标记零内联，受限读取返回固定正文。
- 启动拒绝（`f010-required-input-missing-or-corrupt-rejected`、`f010-path-escape-and-permission-expansion-rejected`、`f010-required-input-budget-rejected`、`f010-required-budget-structured-failure`）：缺失/损坏/越界/权限扩大/超预算均以受控原因（input_missing/input_corrupt/cwd_root_unknown/workspace_untrusted/permission_expansion/limit_exceeded/missing_required_input）拒绝并保留证据，不静默截断 acceptance、不扩大读取权限。
- 本地验证（Nezha wrapper 日志在 `verifications/F-010/runtime-logs/`）：`test-kvbewphj.log` exit 0（p03-2-context-build 全量 58 passed）；`test-kcdmlu8r.log` exit 0（p03-6-execution-input-binding 全量 38 passed）；`test-n4rcd7_t.log` typecheck exit 0。中间两轮失败日志（`test-719tr8ww.log` 依赖认领 DAG 门控、`test-dojx9jf3.log` promptDigest 域分离假设）保留未重跑读取。
- 索引 `test/index/phases/P03/features/P03-10/tasks/F-010.json` 登记 4 文件（all:true）；Harness selection 只引用仓库索引。p03-2-execution-input/p03-2-execution-input-prepare 两份回归文件仅登记交 Nezha；未运行全仓、组合门禁或 Phase 验收。
- 交接见 [F-010 输入装配回归](docs/p03-10-f010-input-assembly-regression.md)。未改生产代码或官方元数据；无未解决阻塞，收尾按合同仅提交一次 `nezha task report F-010`。

## F-009 — FakeRuntime 异常、输出与恢复负例（2026-10-19）

- 新增三个 Runtime 测试文件、23 项局部用例：结构化异常及信息型 rate limit、基础设施代码预算退款与累计父级限制、三路证据独立观察、required 证据缺失、大消息/UTF-8/背压/输出溢出、脱敏与恢复能力边界。监督超时用例经真实取消、停止确认和 retention 留存；失败后暂停，不进入自动重试。
- 修复 Runtime 异常结算误扣代码预算，保留 Attempt/RuntimeStarts；Recorder 在持久化前脱敏结果/错误原因，并保持清单原因 token 合法。保留认证预算 RED、脱敏 schema RED、中间失败及阻塞运行清理日志。
- 最终本地验证：`test-cenp9epa.log` exit 0（3 文件、23 passed、0 failed、0 skipped）；`test-ruzh4vt6.log` typecheck exit 0；`test-fb0xnsey.log` boundaries exit 0（286 生产文件、0 diagnostics）。日志及 sidecar 位于 Feature workspace `verifications/F-009/runtime-logs/`。
- 交接见 [F-009 Runtime 负例组](docs/p03-10-f009-runtime-negatives.md)。仓库任务索引登记三个新增文件及八个本轮未运行的受影响回归，Harness selection 引用该索引，独立回归交 Nezha。未运行全量、组合门禁或 Phase 验收；没有声称当前不存在的自动指数退避定时器已验证。
- 保留 F-007/F-008 原有未提交内容，共享文件仅提交 F-009 增量。官方元数据保持只读，收尾按协议仅报告一次 F-009 completed。

## F-007 — 预算、竞争认领与执行范围负例（2026-10-19）

- 增加 `test/modules/acceptance/p03-10-execution-negatives.test.ts`，复用真实构建 CLI/Host、SQLite、Git 和制品夹具。持续检查真实 Node 进程三次失败，由生产 Verification/Task completion 结算；首次加两次修复后 Task failed、Feature 非 completed，后继无 Attempt，Run paused/code_attempts_exhausted。调度公开契约为 run_control_blocked、readiness blocked、零 readyTaskIds。
- 两次修复先核对前次 tracked/untracked 内容再 append，最终同 worktree 保留两次增量修复。独立核对三份失败 CheckResult 的退出码/超时/输出制品、三次已停止 Session、Run/Attempt/Runtime 启动累计 1/3/3、资源 lease 释放；重放原授权请求不增加执行、预算、事件、回执或启动记录。失败现场和检查输出导出后，夹具确认进程树/组停止并清理。
- 补强三个真实 SQLite 跨进程认领竞争场景：唯一有效 owner/version、Task fence 和三项 lease 一致、零 Runtime 启动、数据库重开后持久事实不变。其余既有负例增加精确稳定 ID，未删减行为断言。
- 最终本地验证：`test-8trgi67z.log` exit 0（纵向 1 passed）；`test-yzuigm86.log` exit 0（认领竞争 3 passed / 32 skipped，未声称整文件通过）；`test-jfq6snmu.log` typecheck exit 0。均在 Feature workspace `verifications/F-007/runtime-logs/`，完整 stdout/stderr、真实退出码及 sidecar 保留。早期 RED、中间调度契约断言失败和首次 GREEN 日志均保留；最终重跑基于新增持久副作用与认领身份断言。
- 最终场景证据 `verifications/F-007/scenarios/persistent-check-failure-29071521-f093-497e-aac6-8686d1b77b08/` 含三个失败现场、summary、完整 evidence 和 cleanup；cleanup passed，树/组停止、资源删除，耗时 291ms。
- 索引 `test/index/phases/P03/features/P03-10/tasks/F-007.json` 已登记 Feature 目录；Harness selection 只引用仓库索引。经 Nezha 路径/schema 规则和 Vitest 仅收集核对，11 文件、35 个展开后唯一 case。`selection-validation.json` 保存结果；其中本地已执行 4 项，其余 31 项交 Nezha 独立运行，未运行全仓、组合门禁或 Phase 验收。
- 交接见 [F-007 执行负例组](docs/p03-10-f007-execution-negatives.md)。未修改生产代码、feature.yaml 或 task_list；无未解决阻塞，收尾按合同仅通过 Nezha CLI 提交一次 completed 报告。局部通过不代表完整 Feature 交付或阶段验收。

## F-008 — 过期审批、人工阻塞竞争与 Task 策略快照负例（2026-10-19）

F-008 的交接文档和测试索引分别见 [F-008 审批、阻塞与策略快照负例组](docs/p03-10-f008-approval-blocking-snapshot-negatives.md) 与 `test/index/phases/P03/features/P03-10/tasks/F-008.json`。最终 Runtime 聚焦命令的完整 Nezha 日志为 `test-wfndf7k6.log`，exit 0：7 个文件、20 passed、0 failed、83 skipped；类型检查的完整日志为 `test-e4gua1fj.log`，exit 0。两次日志均在 Feature workspace `verifications/F-008/runtime-logs/`，保留完整输出、原始退出码和 sidecar。为使正式继续路径复用规范验证身份，测试种子改用 `verificationCodeIdentity`；F-016 正式装配夹具显式配置完整交付政策，默认夹具保持原形态。F-008 只完成 task-local 聚焦验证，广泛 affected 回归与 Feature/阶段结论交由 Nezha；收尾仍需按 DAG 只提交一次 `nezha task report F-008`。

## F-005 — 授权 Host 与正式构建 CLI 完整执行报告（2026-10-19）

- 已复用现有授权查询通道接入 GET /v1/features/:featureId/report、HostClient.getFeatureReport 和 feature report CLI；报告 JSON 原样保留 Core schemaVersion=1，逐字段输出完整跨 Run 历史、检查/审批/operation 及证据引用，CLI 不打开 SQLite。
- Host 与客户端统一使用 16 MiB 原子响应上限；超限返回 internal/response_budget_exceeded，不截断为最近历史。响应校验复用已有协议，核验嵌套字段/版本、项目归属、身份、历史计数、时间与 partial；缺历史 Session/Artifact 保持 partial。可信身份、读取能力、Feature 归属与证据成员检查仍由 Core 复核。
- 正式构建测试发现并修复 dist/bin.js 立即 process.exit 导致管道 JSON 在 65,536 字节处截断；改用 process.exitCode 等待输出排空。保留初始路由 RED、构建截断 RED（test-p6uwkcvj.log）及所有中间失败日志；后续重跑均有相关代码或用例修正。
- 最终新增 Host/CLI 八项真实临时资源测试通过：130 Attempt、130 审批、失败/取消/interrupted、人工等待、历史正文、逐字段 Core 比对、无越权/路径/凭据泄露、读取中状态变化不混合、缺历史、版本/归属/格式/大小拒绝与全库快照无写入。verifications/F-005/runtime-logs/test-lt64xmaw.log：exit 0，8 passed / 0 failed / 0 skipped；内含正式 npm run build 与构建入口烟测通过。
- 原 Host 握手能力清单同步增加 features.report.get；只运行该受影响用例：test-31bza_dm.log exit 0，1 passed / 0 failed / 18 skipped，未宣称整个 Host routes 文件通过。
- 最终静态检查：test-0zj45do9.log typecheck exit 0；test-hmcxnn6x.log boundaries exit 0（285 production files，0 diagnostics）；git diff --check 无错误。
- 交接文档 docs/p03-10-f005-host-cli-report.md；任务索引 test/index/phases/P03/features/P03-10/tasks/F-005.json，Harness verifications/F-005/test-selection.json 引用该索引；已核对 15 个现有测试路径及 14 个唯一显式 case ID，并登记 Feature 索引。P01/P02 授权、分页、握手/协议拒绝、CLI 及既有报告查询回归按清单交 Nezha 独立运行；除上述聚焦范围外未在本轮执行，未跑全量、组合 verify 或 Phase 验收。
- 无未解决阻塞。仅处理 F-005；正式 feature.yaml/task_list 保持只读，任务收尾仅经 Nezha CLI 提交一次 completed 报告；独立验收结论由 Nezha 负责。

## F-004 — Core 完整 Feature 执行报告（2026-10-19）

- 新增 `QueryService.getFeatureReport` 和只读 report 端口/SQLite 适配器，默认 Core 装配已接入。复用既有分轴判断；全部 Task、跨 Run Attempt、返工/取消/interrupted、子 Session、检查、审批、operation、诊断与证据按稳定身份重建。
- ID keyset 分页在单一一致读事务内排空，附项目事件水位；正文按快照 hash/size 与执行归属校验。缺字段、缺/坏证据保留并标 partial；未知 token/cache/cost 为 null，Fake 标 synthetic；Session 累计时间与墙钟跨度分列。
- 聚焦真实 SQLite 六项测试全部通过：三 Task、两 Run、130 Attempt/130 审批、重叠 Session、WAL 第二连接中途写入隔离、重复关联、缺历史字段/证据、正文损坏/缺文件/归属错误、授权与查询前后全库快照不变。`verifications/F-004/runtime-logs/test-xvpyhlc9.log` exit 0，6 passed / 0 failed / 0 skipped。
- `test-157mv3ds.log` typecheck exit 0；`test-gw93ei8l.log` 边界检查 exit 0（284 文件，0 diagnostics）。早期 RED/失败日志均保留，后续重跑均基于相关实现或用例修正。
- 交接：`docs/p03-10-f004-feature-report.md`；索引 `test/index/phases/P03/features/P03-10/tasks/F-004.json`；Harness selection 已引用索引。既有 Feature delivery / Work Session 查询回归只登记，交 Nezha 独立运行；未跑全量/组合门禁/Phase 验收。
- 无未解决阻塞。Host/CLI 报告暴露由 F-005 继续；未修改正式 feature.yaml/task_list 状态，收尾只经 Nezha CLI 报告。

## F-001 — 独立真实资源验收夹具

实现与局部验证完成；提交与任务报告以 Git/Nezha 记录为准。仅处理 F-001，没有修改 feature.yaml、task_list 或其他任务状态。

- 受测基线：`14386921209e98f6bfc49f2c93373aeacc0473a5`，与 P03-9 累计分支一致；P02 `0e76ad8d9ae7a9e03949c8af4bae8e7e236acd56` 祖先检查通过。
- 新增 `test/helpers/p03-10/acceptance-fixture.ts` 和显式构建 Fake Host 脚本，复用 P02 隔离资源、CLI session、只读探针、监督器、OwnedProcessTree 与真实 CommandProcess。业务数据只由构建 CLI/Host 写入。
- 证据覆盖基线/工具、CLI 实际结果、只读 SQLite 实体及 operation 关联、Git、进程身份、有界输出与 Fake unknown 用量。先导出再停树/组，全部确认后删除；失败保留并允许重试，cleanup 保留各次结果和耗时。
- 六项自测覆盖准备/Host 中断、真实执行、只读拒写、脱敏和输出边界、外部路径/悬空链接保护、停止未确认、活跃工具树与导出失败。
- 本地 TDD：缺夹具 RED → 最小 GREEN → 四场景 RED/GREEN → 六场景及强化断言。发现预算未知量保护和 requirementsRefs/prepare 不一致后，按公开契约修正装配；没有放宽产品保护。悬空链接测试验证了底层清理拒绝，修正测试创建链接的 finally 回收后六测再次 GREEN。
- 最终聚焦日志 `test-1ezmbjj1.log`：exit 0，6 passed / 0 failed / 0 skipped，含真实 build 与 Core/Host/CLI 入口烟测。`test-vgwkdhqe.log`：typecheck exit 0。日志位于 Feature workspace `verifications/F-001/runtime-logs/`；所有旧失败证据保留。
- 最终工具树在异常前仍活跃、异常后进程组消失；cleanup 341ms。两处本次早期失败遗留根经身份/无进程使用与安全边界核对后已清理，保留额外清理报告。
- 测试索引：`test/index/phases/P03/features/P03-10/tasks/F-001.json`；Harness selection 只引用该索引。P03 Phase 仍为人工验收、not_accepted；广泛回归交由 Nezha。
- 使用、P03-1～9 接口映射、实际版本、六项证据目录、清理语义与限制见 [F-001 交接](docs/p03-10-f001-fixture.md)。

本地通过只表示资源夹具满足本任务验证范围。真实 Pi/LLM、完整 P03 故障矩阵、Verifier/最终交付场景、跨平台及全阶段验收均未在本轮运行；Fake completed 不折算 Task passed 或 Feature completed。

## F-002 — P03 阶段验收机器可读检查清单与受校验配置

实现与局部验证完成；提交与任务报告以 Git/Nezha 记录为准。仅处理 F-002，未修改 feature.yaml、task_list 或其他任务状态。

- 新增 `acceptance/p03.checklist.json`（33 项 = 30 必需 + 3 deferred）与 `acceptance/p03.config.json`，固定 FR-1～FR-3 正常/关键负例、T02～T40 验收编号（T38 仅报告结构、T40 仅通用恢复决策）与证据要求映射；完成、预算耗尽、人工阻塞、最终检查失败、仅收尾重试五个纵向演示独立成项，unit/feature-integration/phase-acceptance 分层标注。
- 新增 `scripts/acceptance/p03-config.ts`：冻结基线 + fail-closed 校验，拒绝无效配置、重复/未知/deferred 检查 ID、删减断言、改写 FR/T 映射、降级层次、业务版本表/凭据字段；配置沿用 npm 与 P01/P02 版本约束，含有限步骤/总时间与输出上限、显式 Fake 身份、临时资源与报告范围；live/Pi、强沙箱、后序能力 deferred（not_run/postponed），不计入已通过数。
- 测试：`test/modules/acceptance/p03-10-checklist-config.test.ts` 9 个 `[case:...]`；索引 `test/index/phases/P03/features/P03-10/tasks/F-002.json`，Harness selection 仅引用该索引。
- 验证：`test-yex50_3h.log` exit 0（9 passed / 0 failed / 0 skipped）；`test-64bt5d0y.log` typecheck exit 0。日志在 Feature workspace `verifications/F-002/runtime-logs/`。
- 交接与映射表见 `docs/p03-10-f002-checklist.md`。

本地通过只覆盖本任务清单/配置校验范围。`accept:p03` 控制器与阶段报告聚合由后续任务交付；真实 Pi/live、强沙箱、真实用量/缓存收益未运行且不折算通过。

## F-003 — 三 Task 链诊断与受控提交阻塞

F-003 尚未满足验收，收尾应报告 `blocked`；正式 feature.yaml、task_list 及其状态未修改。负责人需协调逐 Task 受控提交契约与实现，不能用 Feature 最终提交补认 Task 放行证据。

- 新增正式构建 CLI/Host 三 Task 场景：项目内真实检查配置、导入/摘要审批/显式执行授权；Fake 实际写文件，真实 Node 检查及 Git 身份检查，生产 VerificationStore/制品/Task 完成服务负责结算，无业务表 SQL seed。
- 真实顺序为 1 → 2 首次 → 2 返工 → 3，检查退出码 0/1/0/0、testCount 1/2/2/3。第二项新 Attempt 保留同 worktree 的 tracked README 和 untracked marker，先核对原内容再 append 增量修复；新输入含现场与失败证据；第二项通过前第三项零启动。Task Attempt/代码次数分别 1/2/1。
- 修复实际 RED：补偿扫描用 run_control_blocked 覆盖验证暂停原因，导致真实检查通过后 completion ignored/invalid_transition。现在保留持久暂停原因，控制诊断留在内存；新增重复扫描的 SQLite 回归。
- 动态确认关键缺口：三个 Task 最终均 passed，但 git_operations 为零、HEAD 未改变。诊断报告 `status: failed / task_passed_without_controlled_commit`；端口与数据库约束均仅支持 feature_final_commit。Feature 全量检查与收尾为 not_run，未宣称 Feature/阶段通过。
- 同 commandId 原请求经 CLI 重放后，starts/Attempt/Session=4，Run/Batch=1，事件=50，回执=24，Git operation=0，全部不增加；最终 Git HEAD/tree 不变，修改仍未提交。检查前阶段轨迹、两次输入、真实输出、Git 事实及回执完整导出；cleanup passed，进程树/组停止、资源删除。
- TDD 与诊断日志均在 Feature workspace `verifications/F-003/runtime-logs/`：初始缺三 Task RED `test-xc4kk71y.log`；事务装配 RED `test-232ar8hv.log`；验证暂停 RED `test-dimzs0a5.log`；最终 `test-paeuc6he.log` exit 0，2 passed / 0 failed / 0 skipped；`test-wqdu81jm.log` typecheck exit 0。两项测试 GREEN 仅证明诊断与修复有效，不表示 F-003 验收成功。
- 最终证据目录：`evidence/three-task-chain-38487165-20bb-4707-944c-43db748a63b1/`，含 three-task-chain.json、stage-*.json、evidence.json、cleanup.json。受测 HEAD 为 `9c81be306ba4a8de462f777fdc4972dad93a524d`，dirty=true 记录本次待提交代码；最终实现以 Git 提交为准。
- 索引 `test/index/phases/P03/features/P03-10/tasks/F-003.json`，Harness selection 已落盘并引用它。新增两文件已本地执行；F-001 六项及旧 scheduler 五项为已选未运行回归，交 Nezha。未运行全仓/组合 verify/阶段验收。
- 具体装配、阻塞接口、证据与后续门禁见 [F-003 交接](docs/p03-10-f003-three-task-chain.md)。

## F-006 — 执行报告可审阅文本视图与人工操作提示

仅处理 F-006；未修改 feature.yaml、task_list 或其他任务状态。

- 新增 `packages/cli/src/app/report.ts` 纯视图层：`buildFeatureReportTextView` / `formatFeatureReportTextView` 从同一 `feature-execution-report` 投影重新生成文本，不倾倒 JSON、不追加历史报告内容；纯函数零写入、重复生成语义稳定。
- Task 表稳定排序并区分 latest/cumulative；Attempt 历史按 Task 分组稳定排序并标注各 Run 归属；Run/Session 记录独立列示。
- 最终检查、人工批准/阻塞原因、要求的交付状态、证据引用与下一步显式操作单独成段；未批准但机器全绿时 `waiting=true` 显示保持等待，不显示已通过、不建议跳过人审；下一步全部 `automatic=false`。
- unknown/partial、Fake 合成指标（basis=fake-synthetic）、累计 Session 时间与墙钟时间清晰标识；null 保持 unknown 不填 0；声明不计算加权缓存率、不生成真实模型分组收益、余额或节省额度结论。
- `shiploop feature report`（非 --json）文本输出改用该视图；`--json` 信封与 Core 投影逐字段一致（不变）。
- 测试：`test/modules/cli/p03-10-feature-report-text.test.ts` 4 个 `[case:...]`；索引 `test/index/phases/P03/features/P03-10/tasks/F-006.json`，Harness selection 仅引用该索引。
- 验证：`test-2tpux2gn.log` RED（模块未实现）→ `test-fkk1ci_8.log` exit 0（4 passed）；受影响回归 `test-wfsmcilu.log` exit 0（14 passed：构建 CLI 文本契约 2、报告投影 6、Host 契约 6）；typecheck `test-4hbicdoh.log` exit 0；索引约束 `test-5ogqoqe3.log` exit 0；`check-boundaries-f006.log` PASS。日志在 Feature workspace `verifications/F-006/runtime-logs/`。
- 交接见 [F-006 交接](docs/p03-10-f006-report-text.md)。

本地通过只覆盖文本视图与直接影响的报告契约回归；较广回归与最终门禁由 Nezha 独立执行。真实 Pi/live、强沙箱与完整用量/缓存平台未运行且不折算通过。

## F-017 — P03 阶段入口与严格报告编排（2026-10-19）

- 新增 `scripts/acceptance/p03-accept.ts` 并在根 `package.json` 注册 `accept:p03`。控制器在启动任何 Host/场景前校验冻结配置与清单，按 `verify` → `build` → P03 索引确定性测试顺序执行，使用显式 argv/cwd、受控 Fake 环境、输出上限、步骤/整体时间预算和受管进程停止确认。
- 每项必需检查均生成独立状态、真实断言、执行身份、副作用标记和清单声明的证据类别；失败、超时、入口缺失或前序失败保留 `fail`/`not_run` 语义，不提升为通过。报告写入后重验整目录 hash/引用/cleanup/product report，临时环境在报告写入前清理。
- `npm run typecheck -- --pretty false` exit 0；控制器用注入全通过执行器完成报告装配、写入和整目录复核，exit 0，临时验证报告已删除。F-016 聚焦报告测试 `artifacts/acceptance/p03/validation/f016-phase-report.log` exit 0（6 passed）。
- F-017 垂直测试通过 Nezha task-local runner 重新执行：`verifications/F-017/runtime-logs/test-dwzexeyv.log` exit 0，1 个文件、10/10 passed、0 failed、0 skipped；JSON sidecar 记录真实退出码、耗时 284256ms 和 runner invocation。此前缺失的 `verifications/F-017/test-selection.json` 已按 P03-9 F-017 索引补齐为 schema v2，独立验证拒绝原因已消除。
- 未修改正式 `feature.yaml`、`task_list.json` 或任务索引；当前工作树保留实现、脚本注册、验证日志和任务选择证据，待按本次 attempt-2 结果提交任务报告。

## F-018 — 累计接口缺口修复与双次干净快照复跑（进行中）

- 修复 P03 阶段控制器的累计接口缺口：`npm run verify` 已包含正式构建时不再重复追加 `build`；控制器内部临时根改为继承每轮隔离的 `TMPDIR`，报告仍通过显式 `--report-dir` 和固定 `--run-id` 写入独立目录。
- 新增 `scripts/acceptance/p03-clean-replay.ts` 与 `accept:p03:clean-replay`：只从已提交 commit 创建无 `node_modules/dist` 的干净 clone，执行锁文件安装、构建及两轮公共 `npm run accept:p03`；各轮隔离 HOME/TMP/XDG/npm cache/报告根，报告复制后逐目录重验，保存命令日志、退出码、报告 hash、证据目录摘要和 cleanup manifest。
- 已验证类型检查 exit 0；P03 报告契约测试 exit 0（1 文件、6/6 passed），完整日志和真实退出码在 Feature workspace `verifications/F-018/runtime-logs/`。
- 尚未在固定提交快照上运行双次阶段验收；本段完成后补充两轮结果、受测 commit、证据目录和剩余问题。

## P04-5 F-001 — Work 公开记录索引与 recording manifest

- 新增严格的公开消息/工具/附件引用和 manifest 端口模型；公开覆盖范围明确排除隐藏推理、原生私有档案和统一审计。正文只通过 ready Artifact 引用，unknown 水位、事件数和 SDK 版本保持 null。
- SQLite v32 新增 `session_messages` / `recording_manifests`：同项目外键与 Session/Attempt/run/invocation/version 核对、有界 JSON、序列/事件/消息去重、不可变更新、Artifact 摘要身份保护、追加版本与单调持久水位。v1–v31 checksum 保持不变。
- 本地定向验证：`test-hjx4mj1v.log` exit 0（3 文件，123 passed）；旧 Session 受影响迁移断言 `test-5ubwhrmj.log` exit 0（5 passed，16 未选执行）；Artifact trigger 优化后 `test-v6756xnm.log` exit 0（SQLite 11 passed），最终 typecheck `test-n735a0kd.log` exit 0，依赖边界 `test-63az2rjt.log` exit 0。完整日志及真实退出码在本 Feature workspace `verifications/F-001/runtime-logs/`。
- 索引为 `test/index/phases/P04/features/P04-5/tasks/F-001.json`，Harness selection 引用它，已用 Nezha resolver 核实七个选中文件均存在且符合项目配置。其余受影响回归交 Nezha；未运行全仓、阶段验收或真实模型。
- 本任务仅交付持久模型；队列、Runtime 事件归一化及对外查询由后继任务接入。字段映射、完整度约束与证据见 [F-001 交接](docs/p04-5-f001-work-recording-model.md)。
