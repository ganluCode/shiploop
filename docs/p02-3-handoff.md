# P02-3 项目接入与获准基线接口交接（P02-3 → p02-acceptance 及后续）

- 来源 Feature：P02-3（项目静态接入、获准基线检查、受监督命令进程、停止与重启恢复），
  实现范围与操作示例见 [p02-3-operations.md](p02-3-operations.md)。
- 交接对象：**p02-acceptance**（P02 阶段验收，组合双客户端演示）及后续 Work/Pi 阶段。
- 协议依据：[p02-3-onboarding-contract.md](p02-3-onboarding-contract.md)（唯一契约）；
  受监督进程 [p02-3-command-process.md](p02-3-command-process.md)、证据
  [p02-3-baseline-evidence.md](p02-3-baseline-evidence.md)、执行编排
  [p02-3-baseline-execution.md](p02-3-baseline-execution.md)、恢复
  [p02-3-baseline-recovery.md](p02-3-baseline-recovery.md)；生命周期与锁仍以
  [p02-1-host-lifecycle-contract.md](p02-1-host-lifecycle-contract.md)、
  [p02-1-writer-lock.md](p02-1-writer-lock.md) 为准；P02-2 应用面见
  [p02-2-handoff.md](p02-2-handoff.md)。
- 本文只交接**已实现并已有真实纵向回归**的公共面、Schema 与失败边界；未实现能力显式标注
  `not_run`。**本 Feature 不提供 `accept:p02`**，也不补建后序 Work/Pi 能力。

## 1. SQLite Schema（迁移 v1..v4，冻结事实）

| 迁移 | 表 | 要点 |
|---|---|---|
| v1 | `projects`、`repository_bindings`、`global_settings`、`project_settings`、`artifacts`、`schema_migrations` | 项目/绑定/当前配置/制品索引；CAS revision、checksum 迁移、高版本拒写 |
| v2 | `state_events` | 持久脱敏事件：全局 `sequence` 游标、event_type CHECK 白名单 |
| v3 | `command_receipts` | `(principal_id, command_id)` 唯一、`result_ref` 唯一、回执状态 CHECK |
| v4 | `baseline_authorizations`、`baseline_operations`、`baseline_check_results`、`baseline_occupancy` | 不可变授权（insert-only）、操作生命周期（终态不可覆盖）、逐项检查结果、全局单并发占用（单例行 + 可恢复 `process_identity`） |

- v4 附带同项目复合外键（授权↔绑定、操作↔授权、检查↔操作）与
  `baseline_check_results.output_artifact_id → artifacts(id)` 外键；`baseline_operations.accepted`
  行以 `command_receipts` 的操作行身份（公开 `operationId`）关联。空库与 v3 库两条迁移路径均
  有真实测试；漂移/高版本拒写沿用既有规则。
- 应用层 camelCase ↔ 落库 snake_case 映射由 `packages/core/src/adapters/sqlite/schema.ts`
  （Drizzle）与迁移 runner 一致维护，真实 pragma 交叉核对测试守护。
- `state_events` 的 event_type 白名单在 v4 扩展新增 `baseline.authorized`、`baseline.started`、
  `baseline.check_completed`、`baseline.completed`、`baseline.cancelled`；事件 payload 只含
  受控脱敏键（无 argv 原文、无 stderr 原文、无路径、无秘密）。

## 2. Core 窄服务（`shiploop-core` / `shiploop-core/assembly`，不得重建）

`openCoreApplication` 返回的 `CoreApplication` 在 P02-2 面之上新增：

| 能力 | 入口 | 语义要点 |
|---|---|---|
| 静态接入 | `onboardingService`（`application/onboarding-service.ts`） | `projects.inspect` 只读仓库事实（规范路径/repoIdentity/HEAD/null/脏状态/是否已注册）；`projects.overview` 注册与健康**分轴** |
| 基线授权 | `baselineService`（`application/baseline-service.ts`） | 预览（`previewDigest`、代码身份、检查政策）与明确授权/拒绝；经 `commandService.submit` 走同一幂等/回执/事务纪律 |
| 基线执行 | `baselineExecutionService`（`application/baseline-execution.ts`） | `submit`/`cancel`/`enterQuiesce`/`awaitQuiesce`/`waitForIdle`/`diagnostics`；单并发、绝对 deadline、不自动重试；`accepted` 不是通过 |
| 基线查询 | `baselineQueryService`（`application/baseline-query-service.ts`） | `baselines.list`/`baselines.get`/`artifacts.get` 只读授权查询 |
| 基线存储 | `baselineStore`（`ports/baseline-store.ts`） | 迁移 v4 四表读取端口；写只经原子命令事务 |
| 证据 | `createBaselineEvidenceCollector`、`readBaselineOutput`（`application/baseline-evidence.ts`） | 有界脱敏采集、staging→发布、完整性证据；`eligibleForPass` 只是必要门槛 |
| 进程端口 | `CommandProcessPort`（`ports/command-process.ts`）+ `createCommandProcessAdapter`（`shiploop-core/assembly`） | 放行协议/监督/停止核验；Core 不直接 spawn |

- 主体、幂等命令、回执、快照、事件与 `shiploop-core/protocol` 全部沿用
  [p02-2-handoff.md](p02-2-handoff.md) §1~§4 的结论，不得重建；新增 operation 仍必须进
  契约白名单（`baseline.preview`/`baseline.run`/`baseline.cancel` 已冻结）。
- 生产装配固定 `local-owner` 主体、空能力目录、最小环境（PATH + 显式允许列表）；
  受限主体/故障注入只由测试装配提供。

## 3. Host 路由与握手能力（线消息 schemaVersion=3）

P02-3 新增路由（全部 Bearer 认证、`/v1` 前缀；P02-1/P02-2 路由不变）：

| 方法与路由 | operation | 说明 |
|---|---|---|
| `GET /v1/projects/inspect?path=<abs>` | `projects.inspect` | 唯一的仓库根绝对路径例外；只回仓库元数据，永不返回文件内容 |
| `GET /v1/projects/:projectId/overview` | `projects.overview` | 注册/健康/配置分列概览 |
| `POST /v1/commands` | `baseline.preview` / `baseline.run` / `baseline.cancel` | 经既有命令入口；`baseline.run` authorize 回执为 `accepted` + `operationId` |
| `GET /v1/projects/:projectId/baselines?limit&cursor` | `baselines.list` | 操作分页（默认 20、上限 100） |
| `GET /v1/baselines/:operationId` | `baselines.get` | 操作 + 逐项检查结果（含输出引用与 ≤16 KiB tail） |
| `GET /v1/artifacts/:artifactId/content` | `artifacts.get` | 受控证据读取（有界 ≤8 MiB、授权、脱敏） |

- 握手能力视图（`CURRENT_HOST_CAPABILITIES`）真实宣告 `baseline.preview`/`baseline.run`/
  `baseline.cancel` 与 `projects.inspect`/`projects.overview`/`baselines.list`/`baselines.get`/
  `artifacts.get`；未宣告能力请求即 `unsupported`，客户端对能力视图做精确集合核验。
- `quiescing`/`stopping`/`starting` 下 `POST /v1/commands` 返回 `503 not_ready`，只读查询不受
  影响；体积/分页/超时均为契约 §13 的有限值，不可配置放宽。

## 4. HostClient（`shiploop-host`，P02-3 扩展）

- 新增方法：`inspectRepository(path)`、`getProjectOverview(projectId)`、
  `previewBaseline(projectId, plan, commandId?)`、`runBaseline(projectId, decision, plan,
  previewDigest, commandId?)`、`cancelBaseline(projectId, operationId, commandId?)`、
  `listBaselines(projectId, limit?, cursor?)`、`getBaseline(operationId)`、
  `readArtifactContent(artifactId)`；只访问 §3 正式路由，响应运行时校验（畸形/未知版本 →
  协议错误），不打开 SQLite、不直读业务文件。
- `runBaseline` 的 `accepted` 回执：超时/响应丢失先查回执（`GET /v1/receipts/:commandId`），
  仍未知才以**完全相同信封**重发；`accepted` 后不自动轮询终态（由 CLI `--wait`/`--follow`
  或验收驱动显式查询）。`close()`/Abort 只释放本地观察资源，不触发 cancel/stop。
- 复用 `connectToHost`/`probeDiscoveredHost`/`ensureHostRunning`/`resolveConnectDataRoot` 的
  发现、双向核验、错误分类与有限预算（P02-1 §7.2/§14 不变）。

## 5. CLI 退出码（五档，值不变）

| 退出码 | 类别 | P02-3 相关情形 |
|---|---|---|
| 退出码 0 | 成功 | init 预览/注册、overview/preview/list/status/evidence 查询、run 返回 `accepted`、`--decline` 记录 `not_run`、`--wait` 且「completed 且全 required passed」 |
| 退出码 1 | 业务拒绝/操作失败 | `forbidden`/`conflict`/`not_ready`/`resource_busy`/`unsupported`/`corrupt_state`/`internal`、`preview_stale`、`stop_unconfirmed`、`--wait` 终态非全 passed |
| 退出码 2 | 输入错误 | 参数/检查计划/`--confirm`↔`--decline` 冲突或缺席/非法 ID 与分页/本地不安全发现 |
| 退出码 3 | 连接/协议错误 | `host_not_found`/不可达/超时/`protocol_incompatible`/`response_malformed`/`start_timeout` |
| 退出码 4 | 观察中断 | `baseline run --wait/--follow` 或 `events` 被中断（`observation_interrupted`）：操作未取消、Host 未停止 |

## 6. 受监督停止与恢复约束（组合演示必须遵守）

- **放行协议**：授权与代码身份核对完成后，监督进程先 ready/握手、`confirm` 回调在短事务提交
  进程身份后才放行用户命令；握手预算 5 s、失败有界终止并核验。argv 直接 spawn（无 shell）、
  独立进程组、最小环境；完整 argv/cwd/环境在放行前冻结进授权摘要。
- **停止升级**：取消/超时 SIGTERM → 5 s → SIGKILL；停止确认以「进程组不存在」的真实探测为准
  （PID/PGID/OS lstart 身份匹配后才允许组终止）。**无法核验 = `stop_unconfirmed`**：保留
  占用隔离，不重跑、不释放资源，绝不把探测失败当作已停止。
- **重启恢复**：Host 获锁并打开迁移完成的 Core 后、在 starting 中 `recover()`；未收尾检查一次性
  CAS → `inconclusive`（`restart_recovery`/`stop_unconfirmed`），操作 → `interrupted`，
  已完成检查/制品/终态不倒写；恢复不触发命令，显式新 `commandId` 必须重新 preview/authorize。
  释放顺序：先提交终态与停止核验标记 → 按 inode 释放仓库 claim → 短事务释放 DB 占用。
- **quiesce**：`baselineExecutionService.enterQuiesce/awaitQuiesce` 与 Host 停止门控合并
  （0..10 s 预算）；预算外返回未确认，Host 保持 quiescing，不报告 stopped、不关闭 Core、不释锁。
- 操作占用为**全局单并发**：演示中第二个基线操作在途时新提交返回 `resource_busy` /
  `baseline_in_progress`；查询不受影响。

## 7. 测试与证据入口（p02-acceptance 组合双客户端演示可复用）

- **双客户端纵向参照**：`test/modules/onboarding/p02-3-baseline-cli-vertical.test.ts` 验收 3（一客户端
  `baseline run --follow` 观察、另一客户端 `baseline status`/`baseline cancel`；观察中断退出码 4
  后操作仍可查）、`test/modules/onboarding/p02-3-init-overview-vertical.test.ts`（两客户端同数据根唯一 Host、
  重启后注册可查）、`test/modules/onboarding/p02-3-integration-regression.test.ts`（两客户端同数据根唯一 Host、
  竞争基线单次启动、重放/冲突、取消与完成竞争、过期授权、stop/崩溃恢复）。
- **夹具**：`test/helpers/p02-3/`（组合夹具 `createBaselineFixture`、仓库变体、命令样例、
  进程工具、证据故障注入）、`test/helpers/host/`（隔离环境/受管子进程/伪 Host/脱敏证据日志）、
  `test/helpers/p02-2/storage-probe.ts`（独立只读 SQLite 探针）。
- **证据入口**：检查输出与报告经 `baseline status` 的 `checks[].output.artifactId` →
  `baseline evidence <artifactId>`（或 HostClient `readArtifactContent`）读取；证据完整性
  （hash/size/覆盖缺口）在报告与 `test/modules/storage/artifacts/artifact-verify.test.ts`/`test/modules/onboarding/baseline-evidence.test.ts`
  守护。历史阶段证据在 `docs/acceptance/evidence-p0*/`（已脱敏）。
- 仓库级验证入口：`npm test`（确定性一次性全量）、`npm run verify`（锁文件预检 +
  test/typecheck/build fail-closed）、`npm run check:boundaries`。建议 Harness 将 Feature
  验证命令对齐 `npm run verify`；本任务不修改 executor/agent 配置。

## 8. p02-acceptance 组合演示建议（不代为实现）

1. 两个真实 CLI 客户端共享一个显式 `--data-root`：A 执行 `project init` 预览/确认 →
   `baseline preview` → `baseline run --confirm --follow`；B 并行 `project overview`、
   `baseline list/status` 查询并（必要时）`baseline cancel --confirm`。
2. 覆盖正常与关键失败分支：`--decline`（`not_run` 零启动）、缺命令/未知脚本（`error`）、
   超时、显式取消、停止未确认、输出缺口、`preview_stale`、观察中断（退出码 4）后继续查询。
3. 结束后显式 `host stop`（三证据），重启后再次查询注册与历史——**不得**人工改数据库；
   演示结论只引用 `baseline status`/`baseline evidence` 的结构化事实，不从日志文字推断 `passed`。
4. 已知基线失败是演示中如实记录的检查事实，**不是** p02-acceptance 的豁免项；验收必须自行
   取得全部证据。

## 9. 待实现能力（后续阶段，不得冒充）

- `npm run accept:p02`（P02 阶段验收命令）由阶段末项定义；本 Feature 不提供。
- Work/Batch/Run/Attempt、DAG/Scheduler/Runner、Pi SDK 与真实模型执行、Work 级取消、
  审批流、通知投递；`project init` 的 Profile/技术栈推断、移动 rebind、多 clone 归档；
  托管 Chat、Web/Electron、NAS/云端、强 OS 沙箱、非 macOS 平台。
- 配置历史版本表、跨层策略编排（沿用 P02-2 §8 结论）。

## 10. 交接前置与安全边界

- 继续遵守：输入运行时校验、破坏性操作走 CAS、终态不可覆盖、错误脱敏、`writer.lock` 永不
  删除、获锁先于写库、可见性先于分页、重放重核权限、`not_run`/`inconclusive` 不折算通过。
- 首版仅正式验收 **macOS** 且仅面向用户明确授权的**可信本机单用户**模式；**可信项目不等于
  强文件/进程沙箱**，本机 token 不防同一 OS 用户的恶意进程。要求强隔离的验收不得复用本假设。
- 本文与产物不含开发机/Harness 固定路径与凭据；示例状态只落在显式 `--data-root` 内。
