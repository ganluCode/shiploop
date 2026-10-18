# P02-3 脱敏验收证据（F-020：交付报告、FR 验收索引与证据核对）

- 用途：为 [p02-3-f020-report.md](../p02-3-f020-report.md) 提供可核对的验收运行记录、
  FR-1/FR-2 分支到实际测试的证据映射、脱敏核对与清理记录。本文只含计数、状态、
  退出码、进程与命令行形状等非秘密事实。
- 受测代码基线：`fdacf2571da66f5b04a8be15516516eefbf61966`（F-019 文档收尾提交；
  产品代码最后变更为 F-018 的 `6c140f8204fada2e6e7ab9e388cad6ecd02dea80`）。
  分支 `feat/2026-10-04-23-19-52_p02-3`，运行时工作区干净。
- 运行环境：macOS 26.6.2（arm64，Build 25G83；Darwin 25.6.0）、Node `22.19.0`、
  npm `10.9.3`、TypeScript `7.0.2`、Vitest `5.0.3`、better-sqlite3 `13.0.3`、
  drizzle-orm `0.45.3`（全部精确锁定，未隐式升级）。
- 原始命令输出保存在 Harness Feature 工作区 `tool-logs/`（`f020-verify.log`、
  `f020-boundaries.log`、`f020-final-verify.log`、`f020-guard-red.log`、
  `f020-guard-green.log`）；日志正文
  不复制进仓库，本证据与交付报告均为相对路径、脱敏文本。

## 1. 验收运行记录（真实命令与退出码）

| # | 命令 | 退出码 | 结果 | 日志 |
|---|---|---|---|---|
| 1 | `npm run verify`（受测基线 `fdacf25`，干净树） | 0 | `PASS 3/3`：`npm test` **101 files / 2709 tests 全部通过**（62.2s，0 失败）、`npm run typecheck` 无诊断（0.5s）、`npm run build` 三包构建 + dist 冒烟（7.6s） | `tool-logs/f020-verify.log` |
| 2 | `npm run check:boundaries` | 0 | 105 个生产源文件，0 diagnostics | `tool-logs/f020-boundaries.log` |
| 3 | `git diff --check` | 0 | 无空白错误/冲突标记 | 会话命令输出 |
| 4 | `npm run verify`（F-020 文档 + 文档守护提交前复核） | 0 | `PASS 3/3`：`npm test` **102 files / 2713 tests 全部通过**、typecheck、build 全 0 | `tool-logs/f020-final-verify.log` |
| 5 | `node scripts/run-tests.ts test/modules/onboarding/docs-p02-3-f020-report.test.ts`（守护套件定向） | 0 | 1 文件 / 4 用例全过（RED→GREEN：文档缺失时 4 项失败，见 `tool-logs/f020-guard-red.log`） | `tool-logs/f020-guard-green.log` |

计数汇总（受测基线运行）：通过 101 文件 / 2709 用例；失败 0；`not_run` 0
（verify 三步均真实执行，无跳过）；边界扫描 105 文件 / 0 诊断。F-020 复核运行
新增文档守护 1 文件 / 4 用例（102 / 2713），同样 0 失败、0 `not_run`。

## 2. FR-1 静态接入：正常与关键失败分支 → 实际测试

| 分支 | 用例（`test/`） | 断言证据要点 |
|---|---|---|
| 正常：`projects.inspect` 只读预览 HEAD/脏状态 | `p02-3-inspect-overview.test.ts`、`p02-3-init-overview-vertical.test.ts` | 真实 Git 临时仓库返回规范路径/实际 HEAD/脏状态；无文件正文 |
| 正常：`project init --confirm` 经命令路径注册 | `p02-3-init-overview-vertical.test.ts`、`p02-3-integration-regression.test.ts`（FR-1）、`app-cli-execute.test.ts` | 独立只读 SQLite 探针核对项目/绑定行与真实 HEAD；注册行与回执一致 |
| 正常：`overview` 注册与健康分开展示 | `p02-3-inspect-overview.test.ts`、`p02-3-init-overview-vertical.test.ts` | `registration=registered` 且尚无检查时 `health=not_run/no_baseline`；配置存在不等于健康通过 |
| 失败：非 Git/不存在/非法路径拒绝 | `p02-3-inspect-overview.test.ts`、`p02-3-init-overview-vertical.test.ts` | 结构化 `invalid_input` 细分原因；不新建目录、不自动 git init、不误绑外层仓库 |
| 失败：已注册复用 / 不可见项目 forbidden | `p02-3-inspect-overview.test.ts`、`p02-3-init-overview-vertical.test.ts` | 同路径别名返回 `alreadyRegistered`；不可见项目统一 forbidden，不泄漏存在性 |
| 失败：脏工作区原样保留（FR-1 边界） | `p02-3-inspect-overview.test.ts`、`p02-3-init-overview-vertical.test.ts`、`p02-3-integration-regression.test.ts`、`app-cli-execute.test.ts` | 见 §4「源文件不变」 |
| 失败：无初始 commit 明确确认（不猜 main） | `p02-3-inspect-overview.test.ts`、`p02-3-init-overview-vertical.test.ts` | `headCommit=null`、不创建 commit；未确认则不注册（`not_run`） |
| 失败：取消确认 → `not_run` 零副作用 | `p02-3-init-overview-vertical.test.ts`（无 `--confirm` 预览）、`p02-3-integration-regression.test.ts`（非 Git 拒绝零副作用、客户端中断恰一行） | 无注册行/无事件/无文件写入 |
| 失败：恶意初始化脚本绝不执行 | `p02-3-inspect-overview.test.ts`、`p02-3-init-overview-vertical.test.ts`、`p02-3-fixture-kit.test.ts` | 哨兵文件不存在；源文件摘要不变 |

## 3. FR-2 基线检查：正常与关键失败分支 → 实际测试

| 分支 | 用例（`test/`） | 断言证据要点 |
|---|---|---|
| 正常：授权 → 受监督进程 → 逐项结果 + 输出制品 + 代码身份 | `p02-3-baseline-preview-authorize.test.ts`、`baseline-execution.test.ts`、`p02-3-baseline-cli-vertical.test.ts`（验收 1）、`p02-3-integration-regression.test.ts`（FR-2） | 逐项状态/原因/退出码/耗时/代码身份/制品引用；SSE 事件与持久 `state_events` 逐行一致 |
| 正常：取消/超时确认进程停止后收尾 | `supervised-process-stopping.test.ts`、`supervised-command-process.test.ts`、`p02-3-integration-regression.test.ts`（进程纪律）、`baseline-host-recovery.test.ts` | 见 §4「进程树已停止」 |
| 失败：缺命令/未知脚本/权限拒绝 → `error` | `p02-3-baseline-preview-authorize.test.ts`、`p02-3-integration-regression.test.ts`、`baseline-execution.test.ts` | 独立可查询状态与原因码（缺命令/未知脚本/permission），不折算 passed |
| 失败：超时/取消/停止未确认/源变化/证据缺口/输出溢出 → `inconclusive` | `supervised-process-stopping.test.ts`（`stop_unconfirmed` 不报 stopped、占用保留）、`baseline-evidence.test.ts`（证据缺口/`output_overflow`）、`baseline-execution.test.ts`（`source_changed` 改动保留）、`p02-3-integration-regression.test.ts` | 证据写入失败（真实 HTTP 面 + 故障注入）运行不折算通过、占用保留、新运行拒绝 |
| 失败：被拒授权 → `not_run` | `p02-3-baseline-preview-authorize.test.ts`、`p02-3-baseline-cli-vertical.test.ts`（验收 2） | 见 §4「拒绝零启动」 |
| 失败：检查失败不撤销项目注册（FR-2 边界） | `p02-3-integration-regression.test.ts`、`p02-3-baseline-cli-vertical.test.ts`（验收 1）、`p02-3-inspect-overview.test.ts` | 失败/取消后注册仍在、健康独立派生；`overview` 可查询 |
| 失败：单并发占用冲突 | `p02-3-integration-regression.test.ts`（`resource_busy`、竞争恰一次启动）、`sqlite-baseline-store.test.ts`、`baseline-execution.test.ts` | 全局占用 1；取消升级窗口内新运行拒绝；确认停止后可再运行 |

## 4. F-020 六项关键证据（逐项定位）

| 证据项 | 断言位置（`test/`） | 证据要点 |
|---|---|---|
| **源文件不变** | `p02-3-inspect-overview.test.ts`、`p02-3-init-overview-vertical.test.ts`、`supervised-process-stopping.test.ts`、`p02-3-integration-regression.test.ts`、`app-cli-execute.test.ts` | 脏工作区已跟踪/未跟踪文件**字节不变**；恶意仓库源文件摘要不变；取消/停止路径无 reset/stash/删除源码（`preserves source files and already-collected output across cancel`）；运行期源码变化 `source_changed` 改动保留；CLI 不写源仓库文件 |
| **授权内容** | `p02-3-baseline-preview-authorize.test.ts`、`sqlite-baseline-store.test.ts`、`p02-3-baseline-host-routes.test.ts` | `authorize` 提交事务含**不可变授权行**（accepted 回执 + 获准输入种子 + 占用 + 事件）；insert-only 保存完整获准输入摘要/代码身份并原样读回、端口无更新面；预览列出 argv/规范 cwd/环境变量名（不含环境值） |
| **进程树已停止** | `supervised-process-stopping.test.ts`、`p02-3-fixture-kit.test.ts`、`p02-3-integration-regression.test.ts`、`p02-3-baseline-cli-vertical.test.ts`（验收 3） | 父进程退出、孙进程持续写入时终止**整棵进程树**并核验孙进程停止写入；忽略 SIGTERM 经升级终止后父/孙 pid 真实死亡核验；身份探测失败从不报告 stopped；`cancel 不提前声称进程已停` |
| **拒绝零启动** | `p02-3-baseline-preview-authorize.test.ts`、`p02-3-baseline-cli-vertical.test.ts`（验收 2）、`p02-3-init-overview-vertical.test.ts` | `decline` 持久 `not_run` + `authorization_rejected` 原因 + **启动次数为零**（零哨兵/不占用/不发事件）；无 `--confirm` 预览 `not_run` 零副作用 |
| **重启可查询** | `baseline-host-recovery.test.ts`、`p02-3-baseline-host-routes.test.ts`、`p02-3-baseline-cli-vertical.test.ts`（验收 4）、`p02-3-integration-regression.test.ts`（FR-4）、`docs-p02-3-operations.test.ts` | 显式 `host stop` → 重启后注册/历史检查/不可变制品/拒绝记录照常可查且可再运行；SIGKILL 崩溃恢复 `interrupted` 可查、原 commandId 不重放启动；saved authorization 无 release 被中断后 replay 从不启动 |
| **重复请求无副作用** | `p02-3-baseline-preview-authorize.test.ts`、`p02-3-integration-regression.test.ts`（FR-3）、`atomic-commands.test.ts`、`p02-3-baseline-host-routes.test.ts`、`p02-3-init-overview-vertical.test.ts` | 同 commandId 同摘要重放返回原回执（不重复建行/不重复占用/不重复启动）；不同摘要 conflict 零副作用；过期授权 `command_expired` 零副作用；迟到取消不改写终态；取消幂等恰一次收尾 |

## 5. 新增测试进入 `npm test`/`npm run verify` 与前序回归核对

- **收集核对**：`npm test` → `scripts/run-tests.ts`（fail-closed Vitest 启动器）→
  `vitest.config.ts` include `**/*.test.?(c|m)[jt]s?(x)`（仅排除 `test/helpers/`、
  `test/fixtures/`）。运行前磁盘匹配测试文件 101 个 = 运行输出 `Test Files 101 passed
  (101)`，P02-3 新增套件（`p02-3-inspect-overview`、`p02-3-init-overview-vertical`、
  `p02-3-baseline-preview-authorize`、`p02-3-baseline-host-routes`、`p02-3-cli-baseline`、
  `p02-3-baseline-cli-vertical`、`p02-3-skills`、`p02-3-fixture-kit`、
  `p02-3-integration-regression`、`baseline-*`、`supervised-*`、`docs-p02-3-*`）全部在内；
  `npm run verify` 第 1 步即 `npm test`，未按套件过滤。
- **前序迁移**：`sqlite-schema-migrations.test.ts`、`sqlite-migration-runner.test.ts`、
  `sqlite-cas-and-atomicity.test.ts`（迁移 v1..v4、空库/旧库升级）——通过。
- **认证**：`host-lifecycle-contract.test.ts`、`authorization-contract.test.ts`、
  `host-http-transport.test.ts`、`host-protected-storage.test.ts`（握手、Bearer 认证面、
  受限主体、受保护存储 fail-closed）——通过。
- **固定回环**：`host-startup.test.ts`、`host-cli-execute.test.ts` + `npm run build` 的
  dist 冒烟（`scripts/smoke-built-entries.ts`：loopback 127.0.0.1 监听、发现==socket、
  bind override 拒绝、SIGKILL 后新实例/新 token、无 token 泄漏）——通过。
- **public import**：`core-assembly.test.ts`、`app-cli-args.test.ts`（公共入口纯 re-export
  无副作用）、`typescript-build.test.ts` + dist 冒烟（`shiploop-core`/`shiploop-host`/
  `shiploop-cli` 公共入口无副作用加载）——通过。
- **构建回归**：`npm run build` 退出 0（`tsc -b` 三包 + `prepare-cli-bin` + dist 冒烟）；
  P01/P02 集成回归 `p01-*-*.test.ts`、`p02-1-integration-regression.test.ts`、
  `p02-2-integration-regression.test.ts` 全部在 101 文件内通过。

## 6. 脱敏核对

- 本证据与 [p02-3-f020-report.md](../p02-3-f020-report.md) 逐项复核：**不含**真实凭据、
  认证头取值、64 位十六进制秘密形状、开发机绝对路径或用户文件正文；输入文档
  SHA-256 以缩写形式（`4faabeb7…3bed`）呈现。
- 自动守护：`test/modules/onboarding/docs-p02-3-f020-report.test.ts` 在 `npm test` 内断言报告/证据不含
  macOS 用户主目录绝对路径（`/Users` 一级目录形态）、`[0-9a-f]{64}`、Bearer 值与认证头
  取值，并核验报告引用的每个 `test/*.test.ts` 真实存在；既有
  `test/modules/onboarding/docs-p02-3-operations.test.ts` 继续守护操作/
  交接/README 无开发机路径与凭据样例。
- 人工 grep 复核（开发机绝对路径、64hex 秘密、Bearer 值三类模式，同时指向两份文档）
  0 命中。
- 测试仅操作临时沙箱内独立 HOME/tmp/数据根，不读真实凭据、不联网、不调用模型；
  测试中出现的凭据均为运行时生成的一次性秘密。

## 7. 临时资源与进程清理记录

- 清理前审计发现**此前任务运行遗留**夹具进程 19 个（本 worktree）：13 个
  `packages/host/dist/start.js --data-root $TMPDIR/shiploop-f016-dist-*/data/default`
  夹具 Host、5 个 `shiploop-smoke-*/cli-bin/data` 冒烟夹具 Host、1 个
  `shiploop-stopping-*` 冻结夹具（其监督者被 SIGSTOP 挂起、哨兵持续写入约 10 小时）。
  逐个核验命令行与临时数据根身份后终止。
- `$TMPDIR` 下 1993 个 `shiploop-*` 前缀遗留夹具目录（此前各轮调试残留）同批清理。
- **清理瑕疵（如实记录）**：保留清单匹配逻辑按空格分隔但实际含换行，导致 p02-2
  worktree 遗留孤儿 Host（pid 34682，数据根 `shiploop-smoke-uOcYcL`）的临时数据根被
  一并误删；该进程数据根已失、无法继续服务，经身份核验后一并终止。该进程与目录
  均非 F-020 验收运行创建，也不被任何受测用例依赖；不影响上述验收结论。
- **夹具回收缺口（已知缺口，如实记录）**：`npm test` 全量运行本身会遗留少量夹具
  资源——复核运行（`f020-final-verify.log`）后审计发现 1 个 `shiploop-f016-dist-*`
  夹具 Host（`p02-3-baseline-cli-vertical.test.ts` 夹具链路，dispose 未覆盖重启后的
  Host 实例）与 26 个夹具目录（`shiploop-f007-*`、`shiploop-p01-4-guard-*`）。经身份
  核验后全部终止/删除。该缺口不影响测试断言（2713 项全部通过），但列入交付报告
  已知缺口，建议后续 Feature 修复夹具 dispose。
- 清理后复核：夹具进程 0 个、`$TMPDIR/shiploop-*` 目录 0 个；除上述误删项外仅删除
  已核验身份的自有夹具资源，未触碰用户文件或开发仓库。
