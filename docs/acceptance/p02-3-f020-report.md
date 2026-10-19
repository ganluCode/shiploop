# P02-3 Feature 交付报告（F-020：项目初始化与获准基线检查）

- 验收日期：2026-10-10
- 验收平台：macOS 26.6.2（arm64，Build 25G83；Darwin 25.6.0）
- 受测代码 commit：`fdacf2571da66f5b04a8be15516516eefbf61966`（分支
  `feat/2026-10-04-23-19-52_p02-3`，F-019 操作文档/交接 + 文档守护提交；产品代码最后
  变更为 F-018 的 `6c140f8204fada2e6e7ab9e388cad6ecd02dea80`，即真实
  Git/SQLite/进程/Host/CLI 端到端集成回归 + `output_overflow` 终态修复）。
  本报告、脱敏证据与文档守护 `test/modules/onboarding/docs-p02-3-f020-report.test.ts` 作为 F-020 提交在其后，
  只增加文档与守护测试，不改变产品代码。
  - P02-2 交付基线（本 Feature 起点）：`3caca4892423fb33c2ea423edfd426c146314793`
    （P02-2 F-020 交付报告提交）。
- 工具版本：Node `22.19.0` / npm `10.9.3` / TypeScript `7.0.2` / Vitest `5.0.3` /
  better-sqlite3 `13.0.3` / drizzle-orm `0.45.3` / @types/node `22.20.4`（全部精确锁定）。
- 范围界定：本报告是 **P02-3 项目初始化（静态接入）与获准基线检查**的 Feature 交付报告，
  **不是** P02 阶段验收，也不提供 `npm run accept:p02`。结论均来自真实命令退出码与
  可核对证据；不以 Nezha/Harness 的 `completed` 状态代替代码验收，缺证据与未运行
  检查不折算通过。

## 1. 输入需求与已核对契约摘要

- PRD：`features/2026-10-04-23-19-52_p02-3/input/p02-onboarding.md` v0.2（2026-10-01，
  「待审阅的需求文档」），SHA-256 `4faabeb7…3bed`；共同执行约束
  `input/execution-contract.md`（2026-10-01），SHA-256 `89dcd2b2…e069`。
- 需求 **FR-1 静态接入**（只读仓库检查、注册与健康分开展示、Skill 只调用 CLI、
  取消确认 `not_run`、脏文件原样保留）与 **FR-2 基线检查**（明确授权后受监督子进程、
  记录授权内容、取消/超时确认停止后收尾、失败不撤销注册、挂起/缺命令/未知脚本/
  被拒授权独立可查询）；验收标准 §3.3 的 5 条（含 `npm run verify` 全通过、`not_run`
  不折算、记录受测 commit）。
- 实施前置契约：[p02-3-onboarding-contract.md](../p02-3-onboarding-contract.md)
  （F-001 定案，F-002 ~ F-020 唯一协议依据）：线消息 schemaVersion=3、检查计划与
  授权摘要、§8 操作/检查/原因三轴状态、§10 迁移 v4 基线四表、§13 受监督进程与
  停止核验、§14 FR/阶段验收编号映射、§15 设计差异登记与核对请求、§17 输入哈希。
- 沿用前序唯一依据：[p02-2-commands-events-contract.md](../p02-2-commands-events-contract.md)、
  [p02-1-host-lifecycle-contract.md](../p02-1-host-lifecycle-contract.md)、
  [p01-3-application-contract.md](../p01-3-application-contract.md)、
  [p01-4-acceptance-contract.md](../p01-4-acceptance-contract.md)；P02-3 只增加项目
  接入与基线检查面，不重定义 P01/P02-1/P02-2 业务规则。
- **未解决的契约核对请求（保持未完成，不静默决定）**：契约 §15.1 inspect 身份/权限
  范围、§15.2 独立授权输入（不扩展 `SettingsPayload`）、§15.3 当前工作区基线（无隔离
  副本）、§15.4 状态映射（未知脚本→`error`、停止未确认→`inconclusive`+占用保留）、
  §15.5 线消息升 v3、§15.6 首次启用 `accepted`+operationId 异步模型、§15.7 证据内容
  读取路由（窄化解除 P02-2 禁令）、§15.8 基线作用域表 vs 设计 11 通用验证表、
  §15.9 实施值、§15.10 携带项（含设计 06 哈希变更核对）。以上均按契约冻结行为实施，
  **未获负责人变更结论前保持待核对**；T26 编号不一致（PRD「T26 命令幂等」vs 设计 09
  T26 配置 CAS）按具体行为映射（契约 §14.3），编号冲突仍为文档问题。

## 2. 实现范围（F-001 ~ F-020）

- **F-001**（`96930ef`）：核对 P01/P02-1/P02-2 放行基线，冻结 P02-3 实施契约
  （纯文档 + 守护）。
- **F-002**（`01bafe6`）：静态接入/基线命令纯契约（公共类型 + 运行时校验 + 结果摘要
  纯函数，无 I/O）。
- **F-003**（`25a9212`）：基线检查确定性夹具（命令样例、仓库变体、挂起进程树、恶意
  初始化脚本、证据故障注入）。
- **F-004**（`bcbb367`）：Core 静态 inspect 与注册/健康分离 overview 用例
  （OnboardingService + 窄端口 + 真实 Git/SQLite 测试）。
- **F-005**（`3d9465f`）：project init/overview CLI 参数解析、静态预览、确认文案与
  结构化格式化。
- **F-006**（`4f904b0`）：静态接入 HostClient 纵向接线（线消息 v3 + inspect/overview
  路由/能力 + 先预览后确认注册闭环）。
- **F-007**（`09844dc`）：迁移 v4 基线四表与窄存储端口（不可变授权/操作 CAS/检查种子
  与一次性收尾/全局单并发占用）。
- **F-008**（`a5afbe1`）：基线预览与明确授权（previewDigest 绑定代码身份、
  `preview_stale`/decline `not_run`、cwd realpath 核验）。
- **F-009**（`e4d1859`）：macOS 受监督命令进程适配器（持久确认执行身份后放行脚本、
  无 shell argv、异步结果与输出流）。
- **F-010**（`06db1f4`，返工 1 次）：取消/超时升级终止与停止核验，无法确认时保留
  占用隔离（`stop_unconfirmed`）。
- **F-011**（`00d6c3f`）：有界脱敏输出采集与制品发布/完整性证据。
- **F-012**（`759991a`）：基线启动、逐项检查、取消与结果收尾编排（授权/单并发/占用/
  幂等一致）。
- **F-013**（`50fd56f`）：基线活动接入 Host quiesce/stop 与保守重启恢复（核对旧进程后
  才允许新检查）。
- **F-014**（`cfad03e`）：`/v1` 基线路由（预览/授权/启动/取消/分页查询/证据读取）与
  HostClient 扩展。
- **F-015**（`94ef8df`）：基线 CLI 输入文件/argv、独立授权、查询/取消参数与格式化。
- **F-016**（`4d13b43`）：基线 CLI 接线 HostClient（授权后启动、`--wait`/`--follow`、
  显式取消、overview 健康查询）。
- **F-017**（`ce700cc`）：最小 project init/overview 操作 Skill（只经正式 CLI）。
- **F-018**（`6c140f8`）：整 Feature 真实 Git/SQLite/进程/Host/CLI 端到端集成回归
  （`test/modules/onboarding/p02-3-integration-regression.test.ts` 10 项）+ `output_overflow` 终态修复。
- **F-019**（`fdacf25`）：`docs/p02-3-operations.md`、`docs/p02-3-handoff.md`、README
  索引与文档守护 `test/modules/onboarding/docs-p02-3-operations.test.ts`。
- **F-020**（本报告）：交付报告、FR 验收索引、脱敏证据核对与清理记录
  （[evidence-p02-3/f020-verification-evidence.md](evidence-p02-3/f020-verification-evidence.md)、
  文档守护 `test/modules/onboarding/docs-p02-3-f020-report.test.ts`）。

## 3. 环境与版本

| 项 | 值 |
|---|---|
| 平台 | macOS 26.6.2（arm64，Build 25G83；Darwin 25.6.0） |
| Node.js | `22.19.0` |
| npm | `10.9.3` |
| TypeScript | `7.0.2`（精确锁定） |
| 测试运行器 | Vitest `5.0.3`（精确锁定，经本地 fail-closed 启动器 `scripts/run-tests.ts`） |
| better-sqlite3 / drizzle-orm | `13.0.3` / `0.45.3`（精确锁定，Core 适配层） |
| @types/node | `22.20.4` |

## 4. 正向验收（真实命令与退出码）

在受测 commit `fdacf25`（工作区干净）上，按 P01 锁定工具链执行：

| # | 命令 | 退出码 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | `npm run verify` 第 1 步 `npm test` | 0 | **101 files / 2709 tests 全部通过**（62.2s；0 失败） | `tool-logs/f020-verify.log` |
| 2 | `npm run verify` 第 2 步 `npm run typecheck` | 0 | 无诊断（0.5s） | `tool-logs/f020-verify.log` |
| 3 | `npm run verify` 第 3 步 `npm run build` | 0 | 三包 `tsc -b` + `prepare-cli-bin` + dist 冒烟全过（7.6s） | `tool-logs/f020-verify.log` |
| 4 | `npm run verify` | 0 | 预检 OK，`PASS 3/3` | `tool-logs/f020-verify.log` |
| 5 | `npm run check:boundaries` | 0 | **105 个生产源文件，0 diagnostics** | `tool-logs/f020-boundaries.log` |
| 6 | `git diff --check` | 0 | 无空白/冲突标记 | 会话命令输出 |
| 7 | `npm run verify`（F-020 文档 + 守护提交前复核） | 0 | `PASS 3/3`：102 files / 2713 tests、typecheck、build 全 0 | `tool-logs/f020-final-verify.log` |

- dist 冒烟覆盖：迁移资源 in-place（v1..v4）核验、`shiploop-core`/`shiploop-host`/
  `shiploop-cli` 公共入口无副作用加载（public import）、host 生命周期（**固定回环
  127.0.0.1**、发现==socket、bind override 拒绝、SIGKILL 后新实例/新 token、无 token
  泄漏）、CLI 纵向冒烟（同一实例、CLI 退出后 Host 存活、证据化 stopped、退出码
  0/1/2/3）。
- 计数：通过 101 文件 / 2709 用例（复核 102 / 2713，新增 F-020 文档守护 4 用例）；
  失败 0；`not_run` 0（verify 三步均真实执行）；边界 105 文件 0 诊断。`not_run` 缺口
  见 §7，不计入通过。

## 5. FR 覆盖索引（逐项引用用例与证据）

索引来源：契约 §14.1/§14.2、脱敏证据
[evidence-p02-3/f020-verification-evidence.md](evidence-p02-3/f020-verification-evidence.md)
§2~§5，以及本报告 §4 的真实运行退出码。每一项均指向实际测试文件；缺证据与未运行
检查显式记 `not_run`，不折算通过。

### 5.1 FR-1 静态接入（证据 §2）

| 分支 | 用例（`test/`） | 证据 |
|---|---|---|
| 正常：inspect 只读预览 HEAD/脏状态；init `--confirm` 经命令路径注册；overview 注册/健康分开 | `test/modules/onboarding/p02-3-inspect-overview.test.ts`、`test/modules/onboarding/p02-3-init-overview-vertical.test.ts`、`test/modules/onboarding/p02-3-integration-regression.test.ts`（FR-1）、`test/modules/cli/app-cli-execute.test.ts` | 证据 §2；f020-verify.log |
| 失败：非 Git/不存在/非法路径拒绝、不新建目录/不 git init | `test/modules/onboarding/p02-3-inspect-overview.test.ts`、`test/modules/onboarding/p02-3-init-overview-vertical.test.ts` | 证据 §2 |
| 失败：已注册别名复用 / 不可见项目 forbidden | `test/modules/onboarding/p02-3-inspect-overview.test.ts`、`test/modules/onboarding/p02-3-init-overview-vertical.test.ts` | 证据 §2 |
| 失败：脏工作区原样保留（**源文件不变**） | `test/modules/onboarding/p02-3-inspect-overview.test.ts`、`test/modules/onboarding/p02-3-init-overview-vertical.test.ts`、`test/modules/onboarding/p02-3-integration-regression.test.ts`、`test/modules/cli/app-cli-execute.test.ts` | 证据 §4「源文件不变」 |
| 失败：无 HEAD 明确确认（不猜 main/不建 commit）；取消确认 → `not_run` 零副作用 | `test/modules/onboarding/p02-3-inspect-overview.test.ts`、`test/modules/onboarding/p02-3-init-overview-vertical.test.ts` | 证据 §2 |
| 失败：恶意初始化脚本绝不执行（哨兵缺失、摘要不变） | `test/modules/onboarding/p02-3-inspect-overview.test.ts`、`test/modules/onboarding/p02-3-init-overview-vertical.test.ts`、`test/modules/onboarding/p02-3-fixture-kit.test.ts` | 证据 §2 |

### 5.2 FR-2 基线检查（证据 §3）

| 分支 | 用例（`test/`） | 证据 |
|---|---|---|
| 正常：授权 → 受监督进程 → 逐项结果/输出制品/代码身份 | `test/modules/onboarding/p02-3-baseline-preview-authorize.test.ts`、`test/modules/onboarding/baseline-execution.test.ts`、`test/modules/onboarding/p02-3-baseline-cli-vertical.test.ts`、`test/modules/onboarding/p02-3-integration-regression.test.ts`（FR-2） | 证据 §3、§4「授权内容」 |
| 正常：取消/超时确认停止后收尾（**进程树已停止**） | `test/modules/runtime/supervised-process-stopping.test.ts`、`test/modules/runtime/supervised-command-process.test.ts`、`test/modules/onboarding/p02-3-integration-regression.test.ts`、`test/modules/onboarding/baseline-host-recovery.test.ts` | 证据 §4「进程树已停止」 |
| 失败：缺命令/未知脚本/权限拒绝（`error`） | `test/modules/onboarding/p02-3-baseline-preview-authorize.test.ts`、`test/modules/onboarding/baseline-execution.test.ts`、`test/modules/onboarding/p02-3-integration-regression.test.ts` | 证据 §3 |
| 失败：超时/取消/停止未确认/源变化/证据缺口/输出溢出（`inconclusive`） | `test/modules/runtime/supervised-process-stopping.test.ts`、`test/modules/onboarding/baseline-evidence.test.ts`、`test/modules/onboarding/baseline-execution.test.ts`、`test/modules/onboarding/p02-3-integration-regression.test.ts` | 证据 §3 |
| 失败：被拒授权（`not_run`，**拒绝零启动**） | `test/modules/onboarding/p02-3-baseline-preview-authorize.test.ts`、`test/modules/onboarding/p02-3-baseline-cli-vertical.test.ts` | 证据 §4「拒绝零启动」 |
| 失败：检查失败不撤销项目注册 | `test/modules/onboarding/p02-3-integration-regression.test.ts`、`test/modules/onboarding/p02-3-baseline-cli-vertical.test.ts`、`test/modules/onboarding/p02-3-inspect-overview.test.ts` | 证据 §3 |
| 失败：单并发占用冲突（`resource_busy`） | `test/modules/onboarding/p02-3-integration-regression.test.ts`、`test/modules/storage/sqlite/sqlite-baseline-store.test.ts`、`test/modules/onboarding/baseline-execution.test.ts` | 证据 §3 |

### 5.3 F-020 六项关键证据 → 实际用例（证据 §4 逐项展开）

| 证据项 | 用例（`test/`） |
|---|---|
| 源文件不变 | `test/modules/onboarding/p02-3-inspect-overview.test.ts`、`test/modules/onboarding/p02-3-init-overview-vertical.test.ts`、`test/modules/runtime/supervised-process-stopping.test.ts`、`test/modules/onboarding/p02-3-integration-regression.test.ts`、`test/modules/cli/app-cli-execute.test.ts` |
| 授权内容 | `test/modules/onboarding/p02-3-baseline-preview-authorize.test.ts`、`test/modules/storage/sqlite/sqlite-baseline-store.test.ts`、`test/modules/onboarding/p02-3-baseline-host-routes.test.ts` |
| 进程树已停止 | `test/modules/runtime/supervised-process-stopping.test.ts`、`test/modules/onboarding/p02-3-fixture-kit.test.ts`、`test/modules/onboarding/p02-3-integration-regression.test.ts`、`test/modules/onboarding/p02-3-baseline-cli-vertical.test.ts` |
| 拒绝零启动 | `test/modules/onboarding/p02-3-baseline-preview-authorize.test.ts`、`test/modules/onboarding/p02-3-baseline-cli-vertical.test.ts`、`test/modules/onboarding/p02-3-init-overview-vertical.test.ts` |
| 重启可查询 | `test/modules/onboarding/baseline-host-recovery.test.ts`、`test/modules/onboarding/p02-3-baseline-host-routes.test.ts`、`test/modules/onboarding/p02-3-baseline-cli-vertical.test.ts`、`test/modules/onboarding/p02-3-integration-regression.test.ts`、`test/modules/onboarding/docs-p02-3-operations.test.ts` |
| 重复请求无副作用 | `test/modules/onboarding/p02-3-baseline-preview-authorize.test.ts`、`test/modules/onboarding/p02-3-integration-regression.test.ts`、`test/modules/commands/atomic-commands.test.ts`、`test/modules/onboarding/p02-3-baseline-host-routes.test.ts`、`test/modules/onboarding/p02-3-init-overview-vertical.test.ts` |

### 5.4 验收要求类别 → 证据（PRD §3.3 / F-020 验收）

| 类别 | 覆盖用例与证据 |
|---|---|
| 不执行未知脚本/不改源文件/不自动安装依赖 | `test/modules/onboarding/p02-3-inspect-overview.test.ts`、`test/modules/onboarding/p02-3-init-overview-vertical.test.ts`、`test/modules/onboarding/p02-3-integration-regression.test.ts`（哨兵缺失、源文件字节/摘要不变）；`docs/skills/` Skill 明确不自动安装；证据 §4 |
| 拒绝授权 `not_run`；失败/超时独立结果；挂起可取消且进程已停止 | `test/modules/onboarding/p02-3-baseline-preview-authorize.test.ts`、`test/modules/runtime/supervised-process-stopping.test.ts`、`test/modules/onboarding/p02-3-integration-regression.test.ts`、`test/modules/onboarding/p02-3-baseline-cli-vertical.test.ts`；证据 §3/§4 |
| 正常路径 + 关键失败分支逐项、以实际状态/文件/返回断言 | 证据 §2/§3 映射表；全部经真实 SQLite/Git/进程/HTTP 断言，非日志文字检查 |
| `npm run verify` 测试/类型/构建通过；`not_run` 不折算 | §4 命令 1~7 真实退出码；§7 `not_run` 显式记录 |
| 记录受测 commit、命令/退出码、证据位置与已知缺口 | 本报告头部、§4、§5、§7 |
| 新增测试进入 `npm test`/`verify` | 证据 §5：磁盘 101 个测试文件 = 运行收集 101 文件，`verify` 第 1 步即 `npm test` 无过滤 |
| 前序迁移/认证/固定回环/public import/构建回归 | 证据 §5：`sqlite-schema-migrations`/`sqlite-migration-runner`（迁移）、`host-lifecycle-contract`/`authorization-contract`/`host-http-transport`（认证）、`host-startup`/`host-cli-execute` + dist 冒烟（固定回环）、`core-assembly`/`app-cli-args`/`typescript-build`（public import）、`npm run build` 退出 0（构建）——全部通过 |
| 未解决契约矛盾保持未完成 | §1 列出契约 §15.1~§15.10 待核对项与 T26 编号不一致，全部保持「待核对」，不据此增减行为 |

### 5.5 阶段验收编号子集（只认领已覆盖子集，契约 §14.2）

| 编号 | 本次覆盖结论 | not_run |
|---|---|---|
| T10 | 项目隔离与凭据脱敏子集（inspect/overview/基线查询/证据读取授权矩阵、跨项目越权拒绝、错误/证据/事件不含秘密与路径） | 审批、运行时凭据注入 |
| T15 | init 子集（init 重复、无 HEAD/脏工作区、缺命令/未知脚本、被拒授权、失败不撤销注册） | 移动 rebind、多 clone 归档、删除边界（R2） |
| T17 | 沿用 P02-1/P02-2 完整覆盖；基线路由不绕过握手认证与单例 Host | — |
| T23 | 沿用 P02-1/P02-2 完整覆盖；未新增监听/CORS 面，dist 冒烟持续断言 bind override 拒绝 | — |
| T26（命令幂等） | 基线命令沿用 `(principal,commandId)` 唯一、摘要复用/冲突、回执持久化、超时查回执、`accepted` 不重复启动进程 | 设计 09 T26「计划修改越过活动执行/过期审批」（无执行域） |
| 设计 09 T26（配置 CAS） | 基线 `expectedRevision`/`preview_stale` 复用同一 CAS 纪律 | 配置历史版本表、跨层策略编排 |

## 6. 脱敏证据核对

- 证据文档 `docs/acceptance/evidence-p02-3/f020-verification-evidence.md`
  （同目录相对链接 [evidence-p02-3/f020-verification-evidence.md](evidence-p02-3/f020-verification-evidence.md)）
  只含非秘密的计数、状态、退出码、进程与命令行形状；复核确认**不含**真实凭据、
  认证头取值、64 位十六进制秘密形状、开发机绝对路径或用户文件正文（证据 §6）。
- 文档守护 `test/modules/onboarding/docs-p02-3-f020-report.test.ts` 在 `npm test` 内断言本报告与证据文档
  不含 macOS 用户主目录绝对路径（`/Users` 一级目录形态）、`[0-9a-f]{64}`、Bearer 值与
  认证头取值，并核验引用的每个 `test/*.test.ts` 真实存在；既有
  `test/modules/onboarding/docs-p02-3-operations.test.ts` 继续守护操作/
  交接/README。
- 测试仅操作临时沙箱内独立 HOME/tmp/数据根，不读真实凭据、不联网；完整原始日志保存
  在 Harness Feature 工作区 `tool-logs/`（`f020-verify.log`、`f020-boundaries.log`、
  `f020-final-verify.log`、`f020-guard-red.log`、`f020-guard-green.log`），正文不复制
  进仓库。
- 临时资源与进程清理：对审计发现的遗留夹具进程与临时目录执行身份核验后清理，并如实
  记录清理瑕疵（p02-2 worktree 孤儿 Host 数据根误删与补救）与夹具回收缺口（全量
  `npm test` 后遗留 1 个夹具 Host 与 26 个夹具目录，已终止/删除）；详见证据 §7。

## 7. 已知缺口与 not_run（显式记录，不折算通过）

| 项目 | 状态 |
|---|---|
| Windows / WSL / Linux 平台验收 | not_run（macOS 是唯一正式验收平台） |
| 强 OS 沙箱 / 隔离执行 / 隔离副本与 worktree 基线 | 未支持（用户明确授权的可信本机模式；契约 §15.3） |
| Work/Batch/Run/Attempt 调度、Scheduler、Runner、模型执行取消、审批流、通知投递 | not_run |
| Pi SDK 与真实模型执行、真实 Pi runtime session | not_run（本 Feature 全程**未调用真实 Pi**/模型） |
| Profile/复杂技术栈推断、移动 rebind、多 clone 归档、删除边界（R2） | not_run |
| 托管 Chat、Web/Electron 配对、NAS/云端 | not_run |
| 契约 §15.1~§15.10 核对请求、T26 编号不一致 | **待负责人核对**（保持未完成；按冻结行为实施，不静默改语义） |
| 设计 09 T26「计划修改越过活动执行/过期审批」、配置历史版本表、通用 `check_definitions`/`verification_batches` | not_run（无执行域/属后续 Feature） |
| `npm run accept:p02`（P02 阶段末项） | not_run（本 Feature 不提供整阶段通过脚本） |
| 真实断电/磁盘满生产链路演练 | not_run（本轮为确定性故障注入） |
| F-020 清理中的 p02-2 worktree 孤儿 Host 数据根误删 | 已如实记录并补救（证据 §7）；不影响受测验收结论 |
| 测试夹具回收缺口（全量 `npm test` 后遗留 ≤1 个 `shiploop-f016-dist-*` 夹具 Host 与 `shiploop-f007-*`/`shiploop-p01-4-guard-*` 夹具目录） | 已知缺口（测试卫生，不影响断言；F-020 已清理并记录，建议后续 Feature 修复夹具 dispose） |

## 8. Harness 验证策略交接（本任务不修改 executor/agent YAML）

- 仓库级开发内循环为 `npm test`；工程检查编排为 `npm run verify`（锁文件预检 +
  `npm test` / `typecheck` / `build` 串联，fail-closed），以编排退出码为通过依据；
  边界检查为 `npm run check:boundaries`。
- 建议 Harness 将本仓库 Feature 验证命令对齐 `npm run verify`；阶段验收
  `npm run accept:p02` 属 P02 阶段末项，不由本 Feature 提供。
- 本任务**未**修改任何 executor / agent / YAML 配置，**不自动合并**分支、**不代替
  人工放行**；负向验收纪律（不得删测试、降低门槛、扩大权限或跳过必测行为来恢复）
  记录于操作说明与交接文档。

## 9. 结论

P02-3 在 macOS（arm64，Node 22.19.0 / npm 10.9.3）上交付项目静态接入与获准基线检查
闭环：只读 inspect/注册/健康分离 overview、明确授权（不可变授权内容 + previewDigest
绑定代码身份）、受监督进程（无 shell argv、放行协议、SIGTERM→SIGKILL 升级与停止
核验）、有界脱敏输出证据、取消/超时/恢复语义、`/v1` 基线路由与 HostClient/CLI/Skill
纵向接线。受测 commit `fdacf25` 的 `npm run verify`（`PASS 3/3`：101 files / 2709
tests、typecheck、build + dist 冒烟）、`npm run check:boundaries`（105 文件 0 诊断）、
`git diff --check` 真实退出码全部为 0；FR-1/FR-2 正常与关键失败分支、六项关键证据
（源文件不变、授权内容、进程树已停止、拒绝零启动、重启可查询、重复请求无副作用）、
前序迁移/认证/固定回环/public import/构建回归与 `not_run` 逐项记录于 §4/~§7 与脱敏
证据。契约 §15.1~§15.10 的核对请求保持未完成并继续携带。本结论仅限 P02-3 静态接入
与获准基线检查子集，不声称非 macOS 平台、强沙箱、Pi/Work 执行或整个 P02 已验收；
Nezha `completed` 不替代代码验收，`accept:p02` 留给 P02 阶段末项，最终放行由人工决定。
