# P02-1 Feature 验收报告（F-014：Host 单例发现与本机认证交付）

- 验收日期：2026-10-07
- 验收平台：macOS 26.6.2（arm64，Build 25G83；Darwin 25.6.0）
- 受测代码 commit：`8473f306d8bc825356eaa42defc3e512e22edbae`（分支
  `feat/2026-10-04-23-19-52_p02-1-host`，F-013 提交；本报告与配套文档在其后作为 F-014
  文档提交，不改变受测代码）
- 工具版本：Node `22.19.0` / npm `10.9.3` / TypeScript `7.0.2` / Vitest `5.0.3` /
  better-sqlite3 `13.0.3` / drizzle-orm `0.45.3`
- 范围界定：本报告是 **P02-1 Host 单例发现与本机认证**的 Feature 交付报告，**不是** P02 阶段
  验收，也不提供 `npm run accept:p02`。结论均来自真实命令退出码与可核对证据；不以
  Nezha/Harness 的 completed 状态代替代码验收。

## 1. 输入需求与契约摘要

- PRD：`p02-host-lifecycle.md` v0.2（2026-10-01，Feature 输入），需求 **FR-1 启动与发现**、
  **FR-2 认证与停止**；共同约束：`execution-contract.md`（2026-10-01）。
- 实施前置契约：[p02-1-host-lifecycle-contract.md](../p02-1-host-lifecycle-contract.md)（F-001 定案，
  F-002 ~ F-014 共用）：规范数据根与 `dataRootIdentity` 算法、受保护发现/凭据/锁布局、
  发现 Schema、`POST /v1/host/handshake` / `GET /v1/host/status` / `POST /v1/host/stop`
  线协议、版本化 stop 幂等矩阵、Host 生命周期状态机、HostClient/启动器规则、CLI 参数与四档
  退出码、错误码总表、FR/T 编号映射（含 T26 编号不一致核对请求）与明确非目标。
- 锁实现决定：[p02-1-writer-lock.md](../p02-1-writer-lock.md)（实际写入进程直接持 macOS `flock`
  fd，无辅助进程）。
- 设计输入为 Harness 知识目录 `architecture-redesign/`（非本仓库）；本 Feature 依据
  `core-design/08-host-api-and-cli.md`、`core-design/12-end-to-end-flows.md`、
  `core-design/03-storage-and-transactions.md`、`core-design/09-testing-and-implementation.md`
  与 `08-migration-roadmap.md`，版本以契约 §17.2 记录为准（Harness 知识目录不在受测仓库内，
  本报告不复制其内容哈希）。
- 编号说明：PRD 的「T26 命令幂等」与设计 09 §2 的 T26（配置 CAS/计划/审批）编号不一致，
  按行为映射并在契约 §15.4 请求核对；P02-1 只认领「同一实例 stop 的进程内版本化幂等」子集。

## 2. 交付范围（F-001 ~ F-014）

- **F-001**：核对 P01 放行基线与既有入口，冻结 P02-1 生命周期接口契约（本文与全部实现共用）。
- **F-002**：Host 发现/握手/status/stop 的类型与运行时校验、身份与摘要纯函数、结构化错误
  （`packages/host/src/contract/`）。
- **F-003**：受保护文件存储——规范根 realpath 固定、`host/` 0700 与发现/凭据 0600 fail-closed、
  原子发现发布、按实例清理。
- **F-004**：真实 macOS OS 排他锁（极小 N-API `flock` 适配器），获锁先于写库、关闭写入后释锁、
  无辅助持锁进程、`owner_active`/`owner_unknown` 诊断。
- **F-005**：Host/CLI 测试夹具（真实子进程同步屏障、伪服务、脱敏证据、隔离环境）。
- **F-006**：Host 启动装配与显式入口（获锁 → Core/Schema → `127.0.0.1:0` 监听 → 原子发现；
  监听覆盖零容忍）。
- **F-007**：认证握手与只读 status 传输面（Bearer/`Host`/`Origin` 校验、16 KiB 上限、
  有界超时、无 CORS、脱敏错误）。
- **F-008**：显式 stop 的 quiesce、版本化幂等矩阵、收尾顺序、`SIGTERM` 安全收尾、断连不阻断。
- **F-009**：CLI 可复用 `HostClient`（`connectToHost`/`probeDiscoveredHost`，握手双向核验、
  不跟重定向、精确错误分类、`close()` 不 stop）。
- **F-010**：CLI 连接或启动编排与独立后台 Host 启动器（detached 独立 argv、预算内重新发现、
  落选有界回收、owner 诊断）。
- **F-011**：CLI 纯解析/帮助/JSON 信封/四档退出码面层。
- **F-012**：可运行的 `start`/`status`/`stop` 纵向命令与 `dist/bin.js` 显式入口。
- **F-013**：整 Feature 真实多进程集成回归（29 项）与脱敏证据映射。
- **F-014**（本报告）：[p02-1-operations.md](../p02-1-operations.md) 操作说明、
  [p02-1-handoff.md](../p02-1-handoff.md) 接口交接与本文，含文档示例运行核验守护
  [test/docs-p02-1-operations.test.ts](../../test/docs-p02-1-operations.test.ts)。

## 3. 环境与版本

| 项 | 值 |
|---|---|
| 平台 | macOS 26.6.2（arm64，Build 25G83；Darwin 25.6.0） |
| Node.js | `22.19.0` |
| npm | `10.9.3` |
| TypeScript | `7.0.2`（精确锁定） |
| 测试运行器 | Vitest `5.0.3`（精确锁定） |
| better-sqlite3 / drizzle-orm | `13.0.3` / `0.45.3`（精确锁定，Core 适配层） |
| OS 锁 | 新编写 N-API 适配器直接调用 macOS `flock`（构建需 `/usr/bin/clang`、macOS SDK、Node 头文件） |

环境/命令事实见 F-013 证据
[evidence-p02-1/f013-regression-evidence.md](evidence-p02-1/f013-regression-evidence.md)，
以及本次 F-014 文档核验记录 [evidence-p02-1/f014-commands.md](evidence-p02-1/f014-commands.md)。

## 4. 正向验收

### 4.1 F-013 受测实现 commit 的证据（`8473f30`）

F-013 在受测 commit 上完成整 Feature 真实多进程回归，主要命令与结论（详见
[evidence-p02-1/f013-regression-evidence.md](evidence-p02-1/f013-regression-evidence.md) §5）：

| 命令 | 结果 | 退出码 |
|---|---|---|
| `npm test` | 58 files / **1329 tests** 全绿（含 29 项集成回归） | 0 |
| `npm run typecheck` | 无诊断 | 0 |
| `npm run check:boundaries` | 62 个生产 TS 文件、0 诊断 | 0 |
| `npm run build` | 原生锁 + 三包 `tsc -b` + `prepare-cli-bin` + dist 冒烟全 0 | 0 |
| `npm run verify` | test/typecheck/build `PASS 3/3` | 0 |

### 4.2 F-014 文档核验与工作区回归

- 操作说明 [p02-1-operations.md](../p02-1-operations.md) 的命令示例使用真实构建入口
  `packages/cli/dist/bin.js` 与真实参数（`--data-root`/`--json`/`--start-timeout-ms`/
  `--stop-command-id`/`--confirm-timeout-ms`）与默认值/范围（`15000` / `1000..60000` /
  `10000` / `0..30000`）。
- 新增 [test/docs-p02-1-operations.test.ts](../../test/docs-p02-1-operations.test.ts)（3 用例）：
  在真实临时数据根与真实 Host 子进程上用生产执行层 `runHostCli` 跑通 start → 二次 start 同实例
  → status → stop（三证据 `stopped`）→ 无实例 status（`host_not_found`，退出码 3），并交叉核对
  文档记录的命令、参数、默认值、退出码、诊断码，断言文档不含开发机绝对路径或凭据样例。
- F-014 工作区回归：`npm test` → 0（**59 files / 1332 tests**）；`npm run verify` → 0（`PASS 3/3`）；
  `npm run check:boundaries` → 0（62 个生产 TS 文件、0 诊断）。命令/退出码/时间与日志摘要记录于
  [evidence-p02-1/f014-commands.md](evidence-p02-1/f014-commands.md)，完整日志保存在 Harness
  Feature 工作区的 `tool-logs/`（非仓库运行产物）。
- 文档中不存在未提供的 `project`/`run`/`feature` 命令；README 与文档示例均指向真实入口。

### 4.3 FR 分支 → 测试映射（P02-1 子集）

完整分支映射见 F-013 证据文档 §1。要点：FR-1 覆盖获锁→开 Core→Schema→回环端口→原子发现、
重复 start 同实例、多候选竞争唯一持锁者、路径别名同锁、独立数据根、陈旧发现、假服务、
持锁但发现缺失/损坏（`owner_unknown`）、监听覆盖被拒、崩溃后重新发现；FR-2 覆盖 Bearer 握手、
只读 status、显式 stop 三证据、错误/陈旧 token、错误实例/数据根、协议不兼容、外部 Origin/Host、
重复 stop 幂等、停机未确认保留锁、客户端退出 Host 存活、`SIGTERM` 安全收尾。T10/T15/T17/T23
按行为认领子集；T26 仅「同一实例 stop 进程内版本化幂等」子集（编号不一致见 §1）。

## 5. 安全说明

- 首版仅面向**用户明确授权的可信本机单用户**场景，且**仅正式验收 macOS**；Windows/WSL/Linux、
  共享 NAS、通用/签名二进制分发未验收（`not_run`）。
- 锁是**协作式 advisory**（`flock`/N-API）边界：**不防**同一操作系统用户的恶意进程主动替换
  锁 inode、绕过 API 直接写 SQLite、关闭任意 fd 或加载恶意原生代码；要求强 OS 沙箱的任务不得
  复用本模式（首版不提供强隔离）。
- 发现文件中的本机 `token` 只防未授权的本机读取，**不防**所有同用户攻击；凭据只经受保护文件
  （0600）与 `Authorization: Bearer` 头传递，不进 URL/query、argv、env、日志、普通状态 JSON、
  错误或证据附件；服务端比较用等长 `timingSafeEqual`。
- 错误与证据一律脱敏：不含 token、`Authorization` 头、绝对路径或堆栈；本报告与全部运行产物
  不含真实凭据或开发机绝对路径。

## 6. 已知缺口与 not_run（不以注入或冒充折算通过）

| 项目 | 状态 |
|---|---|
| Windows / WSL / Linux 平台锁与生命周期验收 | not_run（macOS 是唯一正式验收平台） |
| 强 OS 沙箱 / 隔离执行 | 未支持（可信本机模式） |
| 项目注册 / 配置 / 基线命令与 `/v1/...` 业务路由 | not_run（P02-2/P02-3） |
| SSE / 事件游标 / 快照重连 | not_run |
| Work/Batch/Run/Attempt 调度、Scheduler、Runner | not_run |
| Pi SDK 与模型 Live 调用、执行取消（进程树强制终止） | not_run |
| Chat、Web/Electron 配对与 CSRF、通知 | not_run |
| 通用命令回执体系与 `command_receipts` 持久化 | not_run（本 Feature 仅同一实例 stop 版本化幂等） |
| `npm run accept:p02`（P02 阶段末项） | not_run（本 Feature 不提供整阶段通过脚本） |
| T10/T15/T23/T26 **完整**验收 | not_run（仅认领子集，见 §4.3） |
| 真实断电 / 磁盘满生产链路演练 | not_run（本轮为确定性故障注入） |

## 7. Harness 验证策略交接（本任务不修改 executor/agent 配置）

- 仓库级验证为 `npm test`（开发内循环）；`npm run verify`（锁文件预检 + `npm test` /
  `typecheck` / `build` 串联，fail-closed）为工程检查编排，以编排退出码为通过依据。
- 建议 Harness 将本仓库 Feature 验证命令对齐 `npm run verify`；阶段验收 `npm run accept:p02`
  属 P02 阶段末项，不由本 Feature 提供。
- 本任务**未**自动修改任何 executor / agent / YAML 配置；负向验收纪律（不得删测试、降低门槛
  或扩大权限恢复）记录于操作说明与交接文档。

## 8. 结论

P02-1 在 macOS（arm64，Node 22.19.0 / npm 10.9.3）上交付每规范数据根单写入者的 Host 生命周期：
真实 macOS OS 排他锁、受保护发现/凭据、`127.0.0.1` 随机端口、版本化认证协议与 CLI
`start`/`status`/`stop`。受测实现 commit `8473f30…` 的 `npm test`（58 files / 1329 tests）、
`npm run typecheck`、`npm run check:boundaries`（62 文件 0 诊断）、`npm run build`、
`npm run verify`（`PASS 3/3`）真实退出码全部为 0；F-014 新增文档守护后工作区 `npm test`
59 files / 1332 tests、`npm run verify` 仍 `PASS 3/3`。操作说明、交接文档与报告引用的命令、
参数、公共面与锁边界由文档守护测试核验；运行产物无开发机绝对路径、无凭据、未执行 npm 发布。
本结论仅限 P02-1 的 Host 生命周期子集，不声称项目接入、执行取消、SSE、Web 配对、跨平台或
整个 P02 已验收；`accept:p02` 留给 P02 阶段末项。
