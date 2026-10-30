# P07-2 F-005 Recorder 期限与监督结算

Recorder 从 `record()` 开始以 `request.limits.timeoutMs` 建立真实单调时钟的绝对期限。
事件读取、result、公开正文、证据分块、核验、停止观察和正常 Manifest 发布共用该期限；
持续小事件或成功发布不续期。既有 `tailWaitMs` 仍限制单侧结束后的尾部等待，并作为
一次失败收尾的总保留预算，包含取消等待、排空、未完成发布清理和失败 Manifest。
没有新增配置字段或改变请求/Manifest 版本。整体业务预算至多为请求期限加一次尾部保留预算；
外层监督的 stop/drain、ArtifactPublisher 自身清理和 OS 停止证明分别受既有有限预算约束。
JS 不抢占同步内核调用；同步操作返回后按真实单调时间失败关闭。

发布和投影获得 AbortSignal。撤销后，迟到正文不推进索引/水位，已 ready 的证据和残留保留。
整体期限耗尽使用 `recording_deadline_exceeded`；该分支只关闭 SQLite 元数据，不再开启
新的 Manifest 正文写入。其他失败至多尝试一次失败 Manifest；没有新的 Attempt、额度重置或
循环增加 Manifest。原围栏在每次水位/元数据推进及结算事务中重核。

`recordingRequiresStop()` 由监督和结算复用：required 缺口阻止进入 verifying；即便
Runtime completed 也结算失败，阻断验证、Git 交付与依赖 Task。已有 Runtime 原始失败类别
保留；记录失败另存为证据。监督在 fallback 之前检查记录阻断条件，不用换模型掩盖记录失败。
显式 best_effort 的普通记录缺口继续可进入业务验证；队列/输出/存储额度硬限制、期限耗尽、
错误元数据不可持久化和清理未确认仍停止。模式只从可信装配读取，Runtime 输入不得覆盖。

取消接受与 stopped 独立保存。`WorkEvidenceRecordingError.cleanupStatus` 及结算制品的
`recording.cleanupStatus` 保留文件清理事实，和 Runtime 的 `stop.evidence` 分开。
Runtime 或文件清理未确认时不进入保留/释放流程，完成结果返回 `cleanup_unconfirmed`，
原占用保持隔离。结算证据持久化失败返回 `execution_finalization_failed` 并保留占用。
迟到 stopped 不自动释放，安全处理仍走原可信保留流程。

## 验收映射

| 范围 | 本 Task 新测试与事实 |
| --- | --- |
| 整体期限 | `recording-supervision` 的 `deadline-both-hang`、`deadline-small-events`、`deadline-body-hang`、`deadline-manifest-hang`：独立于两侧结束；真实临时文件/SQLite；超时后放行屏障不推进水位。采集不依赖查询/UI 消费者。 |
| required/best_effort 与 fallback | 两种 `hard-limit`、两种 `best-effort-body-*`：completed 交错仍失败、不调用 fallback；原 session-recorder 的 best_effort 普通缺口/排空继续通过；`runtime-cannot-switch-mode` 拒绝输入覆盖。 |
| 真实进程/保留 | `recording-process` 两例：进程自写 PID/heartbeat 屏障，记录超限；一次取消接受、可信停止后才保留；acceptOnly 时真实进程继续写，业务结果在有限预算返回，三组租约仍 quarantined。随后可信夹具清理，独立断言 OS 进程缺席；tracked/untracked、Git HEAD、已收证据及预算保留。 |
| 默认公开链路/槽位 | `recording-host` 两例复用 P07-1：公开命令建立项目、计划、授权、Run，默认 Host 装配运行 FakeRuntime，真实受控工具并登记身份；Runtime completed 与记录缺口分别读取制品核验。无验证批次/Git 操作，依赖仍 pending；停止未确认时 workspace 租约和 execution slot 均 quarantined。没有直接补库创建通过/交付事实。 |
| 幂等与围栏 | `hard-limit` 精确重放原结算输入，仅一条通知/一个 Attempt；`failure-stale-executionVersion` 在发布屏障处撤销代次，旧记录和重复结算不得改业务/Manifest/预算；`old-owner-failure-receipt` 屏障放行旧 owner，拒绝且当前状态不变。真实写入者用例同时核对只取消一次和无重复扣账。 |
| 错误与清理独立 | `failure-metadata`、`failure-cleanup`：错误元数据/结算无法保存仍阻断，文件 cleanup_unconfirmed 不被 Runtime stopped=true 掩盖。失败/停止占用分别核对，夹具 finally 清理失败会单独抛出。 |

## 本地验证与交接

Node 22.19.0 / npm 10.9.3。完整日志和退出码保存在 Harness
`verifications/F-005/runtime-logs/`，包括初始错误夹具日志及修正后的真实 RED，不覆盖历史失败。

- `test-y2f5t74j.log`：6 项真实 RED（整体挂起及 best_effort 硬限制未阻断）。
- `test-dsqi1b_r.log`：6 文件、73 项通过，包含新增三文件与直接相关的 SessionRecorder、settlement、execution uncertainty。随后扩展正文硬限制及第二个 Host 隔离场景。
- `test-2n4a3dia.log`：最终扩展的 supervision + Host 两文件、15 项全部通过；Host 两例真实 Runtime completed、工作区/槽位和清理已核对。
- `test-hsbmmocf.log`：最终类型检查通过；`test-8pp24_b5.log`：边界检查通过，475 个生产源码文件、0 诊断。

仓库 v2 索引 `test/index/phases/P07/features/P07-2/tasks/F-005.json` 登记 14 个文件；
Harness selection 只引用该索引。六个文件有本地执行证据，其余八个为独立 Verifier 的受影响
回归选择（停止/进程、F-004 磁盘、Runner、恢复、fallback、dispatch settlement、Artifact 期限），
未把它们记作本地通过。不运行全仓、Phase 验收或真实模型；本 Task 声明不代替 Nezha 独立验收。

当前分支由编排者分配为 `feat/2026-10-29-21-59-22_p07-2-recorder`，和新分支命名规范不同；
按 Runtime 禁止创建/改名/切换分支的约束原地工作，不擅自迁移。
