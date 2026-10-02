# P01-1 集成验收报告（F-006）

- 验收日期：2026-10-02
- 验收平台：macOS 26.6.2（arm64），Node `22.19.0` / npm `10.9.3`（与 `.node-version` / `engines` / `packageManager` 一致）
- 受测代码 commit：`6a988e3ee3435ba60d4b2e920a487b66a3e8557c`（分支 `feat/2026-10-01-23-44-21_p01-1`，F-005 提交；本报告与证据在其后作为 F-006 文档提交，不改变受测代码）
- 范围界定：本报告是 **P01-1 工程骨架**的集成验收，**不是** P01 持久化验收，也不提供 `accept:p01`。不以 Harness/Nezha 的 completed 状态代替验收；下表所有结论均来自真实命令退出码与可核对证据文件。

## 1. 实现范围（F-001 ~ F-005 交付物）

- npm workspaces 三包私有清单（`shiploop-core` / `shiploop-host` / `shiploop-cli`，均 `private`、`0.0.0`、无运行时依赖），固定工具链（Node 22.19.0、npm 10.9.3、TypeScript 7.0.2、@types/node 22.20.4、Vitest 5.0.3，全部精确锁定），lockfileVersion 3 锁文件，UTF-8/换行/忽略配置。
- 严格 TypeScript（`strict` 等）根 `noEmit` typecheck 覆盖源码/测试/脚本；三包 `composite` 构建产物（`dist/index.js` / `.d.ts` / sourcemap）；构建入口子进程冒烟（非常驻、不写用户数据）。
- fail-closed 测试启动器 `scripts/run-tests.ts`（校验本地 `vitest@5.0.3` 身份，不用全局/npx）、确定性 `vitest.config.ts`（`passWithNoTests:false` 等）、临时资源 UTF-8 中文夹具。
- 工作区单向依赖与 Core 分层边界自动检查 `scripts/check-boundaries.ts`（含正反夹具回归）。
- fail-closed 工程检查编排 `scripts/verify.ts`（锁文件预检 + `npm test` / `typecheck` / `build` 串联、有限超时、进程组收尾、NOT RUN 语义）。
- 仓库级测试 5 个套件共 133 条断言。

## 2. 输入文档版本

设计输入为 Harness 知识目录 `architecture-redesign/`（该目录非 git 仓库，以内容哈希固化版本）。全部 24 篇 Markdown 的 SHA-256 清单见 [evidence-p01-1/26-input-docs-sha256.txt](evidence-p01-1/26-input-docs-sha256.txt)。本 Feature 实际依据的主要文档：

| 文档 | SHA-256（前缀） |
|---|---|
| `08-migration-roadmap.md`（首版范围、macOS 平台、验收纪律） | `c6f527bd…` |
| `core-design/09-testing-and-implementation.md`（测试层次、S1–S5 实验基线、工作包拆分） | `ef923b34…` |
| `core-design/01-system-structure.md`（Core 分层结构） | `1f66552a…` |
| `core-design/05-runtime-and-session-recording.md`（Pi SDK 0.84.2 前期验证依据） | `31922205…` |
| `core-design/10-repository-and-release.md`（分仓与发布边界） | `1149abf7…` |

## 3. 正向验收：干净快照五命令

快照由 `git archive HEAD`（受测 commit `6a988e3`）解包到系统临时目录，确认**无** `node_modules` / `dist` / `*.tsbuildinfo` 残留（38 个受版本控制文件）。按固定工具版本依次执行：

| # | 命令 | 退出码 | 证据（相对本文件） |
|---|---|---|---|
| 1 | `npm ci` | 0（0 vulnerabilities） | [01-npm-ci.log](evidence-p01-1/01-npm-ci.log) / [.exit](evidence-p01-1/01-npm-ci.exit) |
| 2 | `npm test` | 0（5 套件 133/133 通过） | [02-npm-test.log](evidence-p01-1/02-npm-test.log) / [.exit](evidence-p01-1/02-npm-test.exit) |
| 3 | `npm run typecheck` | 0 | [03-typecheck.log](evidence-p01-1/03-typecheck.log) / [.exit](evidence-p01-1/03-typecheck.exit) |
| 4 | `npm run build` | 0（三包产物 + 入口冒烟全过） | [04-build.log](evidence-p01-1/04-build.log)、[06-build-artifacts.log](evidence-p01-1/06-build-artifacts.log) |
| 5 | `npm run verify` | 0（预检 OK，`PASS 3/3`） | [05-verify.log](evidence-p01-1/05-verify.log) / [.exit](evidence-p01-1/05-verify.exit) |

环境记录见 [00-environment.log](evidence-p01-1/00-environment.log)。

## 4. 负向验收：七类场景重跑

每个场景在快照的独立 APFS 克隆副本（含已装依赖）中注入，仅修改临时副本，不删除正式源码测试、不降低检查门槛、不调用模型：

| # | 场景 | 注入方式 | 命令 | 预期 | 实际退出码 | 关键诊断（证据） |
|---|---|---|---|---|---|---|
| N1 | 缺锁文件 | 删除 `package-lock.json`（保留已装 `node_modules`） | `npm run verify` | 拒绝，预检失败且不被已装依赖掩盖 | 1 | `FAIL precheck: 缺少 package-lock.json…不会被已安装的 node_modules 掩盖`，三步 NOT RUN（[log](evidence-p01-1/10-n1-missing-lockfile.log)） |
| N2 | 无测试 | 移除全部 `test/*.test.*` | `npm test` | 拒绝（无 passWithNoTests 兜底） | 1 | `No test files found, exiting with code 1`（[log](evidence-p01-1/11-n2-no-tests.log)） |
| N3 | 失败断言 | 注入 `expect(1).toBe(2)`（含中文用例名） | `npm test` | 拒绝并定位用例 | 1 | `FAIL … > 注入的失败断言`，`1 failed | 5 passed (6)`（[log](evidence-p01-1/12-n3-failing-assertion.log)） |
| N4 | 类型错误 | `packages/core/src` 注入 `number = "not a number"` | `npm run verify` | 拒绝，typecheck 步失败、build NOT RUN | 1 | `error TS2322`、`[2/3] FAIL npm run typecheck`、`NOT RUN … npm run build`（[log](evidence-p01-1/13-n4-type-error.log)） |
| N5 | 构建失败 | `packages/host/src` 注入 `string = 12345` | `npm run build` | 构建子命令非零 | 2（tsc -b 编译错误退出码，非零） | `error TS2322`（[log](evidence-p01-1/14-n5-build-failure.log)） |
| N6 | 缺必需工具 | 删除 `node_modules/vitest` | `npm test` | 拒绝并报出工具身份，不经 npx 恢复 | 1 | `required test tool "vitest"@5.0.3 is not installed locally … npm ci`（[log](evidence-p01-1/15-n6-missing-tool.log)） |
| N7 | 违规依赖 | `packages/core/src` 注入 `import "shiploop-host"` | `npm run check:boundaries` | 拒绝，诊断含文件与目标模块 | 1 | `[violation/reverse-dependency] packages/core/src/index.ts:15 -> 'shiploop-host'`（[log](evidence-p01-1/16-n7-boundary-violation.log)） |

## 5. 无厂商 SDK 加载与产物/清单卫生

- **无厂商 SDK 环境加载 Core 公共入口**：快照安装树中 Pi/Electron/HTTP 框架/better-sqlite3/Drizzle 扫描 0 命中（[20-vendor-scan.log](evidence-p01-1/20-vendor-scan.log)）；以 `env -i`（仅 PATH，HOME/TMPDIR 重定向到空沙箱）的独立 Node 子进程 `import('shiploop-core')` 成功，exit 0，沙箱无写入残留（[21-core-entry-load.log](evidence-p01-1/21-core-entry-load.log) / [.exit](evidence-p01-1/21-core-entry-load.exit)）。
- **npm pack 清单（dry-run，未发布、未写 tgz）**：三包清单均仅含 `dist/*` 与 `package.json`（[22-pack-filelists.log](evidence-p01-1/22-pack-filelists.log)，逐包 JSON：[core](evidence-p01-1/22-pack-core.json) / [host](evidence-p01-1/22-pack-host.json) / [cli](evidence-p01-1/22-pack-cli.json)）。
- **路径与凭据扫描**：源码 + 构建产物无 `/Users/` 等开发机绝对路径、无 Harness 路径、无凭据模式命中；锁文件 86 处 `resolved` 除 3 处工作区自链接（`link: true`，相对路径 `packages/*`）外全部指向 `registry.npmjs.org`；清单无 `file:`/`link:` 依赖规格；`tsbuildinfo` 与 sourcemap 均为相对路径（[23-source-artifact-scan.log](evidence-p01-1/23-source-artifact-scan.log)、[24-lockfile-workspace-links.log](evidence-p01-1/24-lockfile-workspace-links.log)）。
- **进程与文件卫生**：`pack --dry-run` 未产生 tgz；验收结束无 vitest/verify/fixture 残留进程（[25-hygiene-check.log](evidence-p01-1/25-hygiene-check.log)）。临时快照目录已在验收后删除；提交的证据文件已脱敏（机器绝对路径以 `<SNAPSHOT-ROOT>` / `<HOME>` 占位）。

## 6. 已知缺口与未运行项目（not_run）

以下为设计路线中明确的后续 Feature 范围，本阶段**未实现也未验收**，Live/真实集成验收一律记为 `not_run`：

| 项目 | 状态 |
|---|---|
| SQLite 项目/配置/制品持久化（better-sqlite3 + Drizzle） | not_run（后续 Feature） |
| 完整领域与执行表（Project/Phase/Feature/Task、Batch/Run/Attempt） | not_run（后续 Feature） |
| Host 网络接口与认证、CLI bin | not_run（后续 Feature） |
| Pi SDK 接入与模型调用（含真实 Pi 冒烟） | not_run（后续 Feature，需单独授权） |
| `accept:p01` 业务验收命令 | not_run（本阶段 verify 仅为开发工程检查，见 README「工程检查编排 verify」） |
| Windows / WSL / Linux 平台验收 | not_run（macOS 是本次唯一正式验收平台） |

## 7. Harness 验证策略交接事项（本任务不修改 executor/agent 配置）

- 当前 Harness 对本仓库的默认验证命令为 `npm test`。F-005 起仓库提供 fail-closed 的 `npm run verify`（锁文件预检 + `npm test` / `typecheck` / `build` 串联），建议 Harness 验证策略从 `npm test` 对齐为 `npm run verify`，以工程检查编排的退出码作为 Feature 通过依据（`npm test` 仍作为开发内循环命令）。
- 交接点：executor 的验证命令配置、agent 提示中的「项目规范 — Node.js」测试命令模板、以及负向验收不得通过删测试/降门槛恢复的纪律说明。
- 本任务**未**自动修改任何 executor 或 agent 配置；以上为待 Harness 侧确认的交接记录。

## 8. 结论

P01-1 工程骨架在 macOS 干净快照上的五条正向命令（`npm ci` / `npm test` / `npm run typecheck` / `npm run build` / `npm run verify`）真实退出码全部为 0；七类负向场景全部以非零退出拒绝且诊断可定位；Core 公共入口可在无厂商 SDK 环境加载；源码、产物与 pack 清单无开发机路径、Harness 依赖或凭据；未执行 npm 发布。本结论仅限上述工程骨架范围，不代表 P01 持久化或任何业务 Live 验收通过。
