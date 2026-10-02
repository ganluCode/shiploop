# P01 阶段验收摘要 — 通过

- 运行 ID：`20261002T230217Z-19e2b169`
- 生成时间（UTC）：2026-10-02T23:02:31.493Z
- 报告 Schema 版本：1
- 输入计划：P01-4 P01持久化闭环验收（2026-10-01-23-44-21_shiploop-p01，版本 0.2，摘要 c305e02bbdf16612684a3d88a6cd4d7b7e414497305e388e6ea6e76833cbc914）
- 范围：FR-1/FR-2 持久化闭环、回滚/CAS、制品缺失/恢复、当前配置/项目标签（macOS 正式范围）
- 受测 commit：`815e9e6f3e6bb2387c2d0d949a17ffd6fb33d1dd`（工作树 clean）
- 前序基线：p01-engineering @ `44c8c30997c46b55d514bc429fcaf9337d755484`（feat/2026-10-01-23-44-21_p01-1）
- 前序基线：p01-state-artifacts @ `74934acba07f6a33c9957ec66ad2ccec2606f828`（feat/2026-10-01-23-44-21_p01-2-sqlite）
- 前序基线：p01-project-config @ `2578a66e28f49155fabdd5935bc228b9702459b5`（feat/2026-10-01-23-44-21_p01-3）
- 平台：Darwin 25.6.0 / arm64
- 工具版本：Node v22.19.0 · npm 10.9.3 · git version 2.50.1 (Apple Git-155) · SQLite 3.53.4 · better-sqlite3 13.0.3 · drizzle-orm 0.45.3
- Schema 版本：settings=2 · 导出格式=1 · SQLite 迁移=[1, 2]
- 总体结论：**pass**（pass 14 / fail 0 / not_run 0，必需检查共 14 项）

## 必需检查结果

| 检查 ID | 分支 | 状态 | 证据数 |
|---|---|---|---|
| P01-ENG-VERIFY | 工程 | pass | 2 |
| P01-FR1-NORMAL | FR-1 正常 | pass | 2 |
| P01-FR1-REOPEN | FR-1 重开 | pass | 2 |
| P01-FR1-ROLLBACK | FR-1 回滚 | pass | 2 |
| P01-FR2-CONFIG | FR-2 正常/拒绝 | pass | 2 |
| P01-FR2-ROLLBACK | FR-2 回滚 | pass | 2 |
| P01-FR2-CAS | FR-2 CAS | pass | 2 |
| P01-FR2-TAGS | T32 项目标签 | pass | 2 |
| P01-FR2-ARTIFACT-MISSING | FR-2 制品缺失 | pass | 2 |
| P01-FR2-ARTIFACT-RECOVERY | FR-2 制品恢复 | pass | 2 |
| P01-PHASE-FIXTURE | 夹具失败 | pass | 2 |
| P01-PHASE-NOT-RUN | 必需检查未运行 | pass | 0 |
| P01-ENG-BUILD-SMOKE | 构建产物 | pass | 2 |
| P01-PHASE-REPORT | 报告完整性 | pass | 0 |

## 命令记录

| 命令 | argv | cwd（逻辑） | 退出码 | 耗时（ms） |
|---|---|---|---|---|
| npm run verify（test/typecheck/build） | `<node> <npm-cli> run verify` | `<repo>` | 0 | 7499 |
| 持久化闭环场景（P01-FR1-NORMAL / P01-FR1-REOPEN） | `<node> scripts/run-tests.ts test/p01-4-persistence-closed-loop.test.ts` | `<repo>` | 0 | 1257 |
| SQLite 回滚与配置 CAS 场景（P01-FR1-ROLLBACK / P01-FR2-ROLLBACK / P01-FR2-CAS） | `<node> scripts/run-tests.ts test/p01-4-sqlite-rollback-and-cas.test.ts` | `<repo>` | 0 | 1427 |
| 制品缺失/恢复负例场景（P01-FR2-ARTIFACT-MISSING / P01-FR2-ARTIFACT-RECOVERY） | `<node> scripts/run-tests.ts test/p01-4-artifact-negative.test.ts` | `<repo>` | 0 | 1712 |
| 当前配置与项目标签场景（P01-FR2-CONFIG / P01-FR2-TAGS） | `<node> scripts/run-tests.ts test/p01-4-config-and-tags.test.ts` | `<repo>` | 0 | 1599 |
| 构建产物冒烟与路径扫描（非源码 cwd 装配 + 制品关闭重开） | `<node> scripts/run-tests.ts test/p01-4-build-smoke.test.ts` | `<repo>` | 0 | 705 |

## 阶段外能力（不计入必需项通过数）

| ID | 能力 | 状态 | 说明 |
|---|---|---|---|
| P01-OOS-MODEL-LIVE | Runtime/Pi SDK 模型 Live 调用 | not_run | P01 无模型调用；本阶段不运行也不计入必需项通过数 |
| P01-OOS-STRONG-SANDBOX | 强 OS 沙箱 | unsupported | 首版为可信项目模式，强沙箱按路线后续建设 |
| P01-OOS-NON-MACOS | Windows/WSL/Linux 平台验收 | not_run | 正式验收限 macOS；其他平台另行验收 |
| P01-OOS-HOST-CLI | Host 网络接口与 CLI 业务命令 | not_run | 本阶段无 Host 网络接口/CLI 业务能力，不编造未实现命令 |

## 证据清单

共 19 项，均为报告目录内相对路径（evidence/ 前缀）；逐项 sha256/sizeBytes 见 report.json。
- `evidence/config.json`（P01-PHASE-FIXTURE） — 1746 bytes
- `evidence/environment.json`（P01-PHASE-FIXTURE） — 713 bytes
- `evidence/commands/01-verify.log` — 3254 bytes
- `evidence/checks/P01-ENG-VERIFY.json`（P01-ENG-VERIFY） — 285 bytes
- `evidence/commands/02-scenario-closed-loop.log` — 757 bytes
- `evidence/checks/P01-FR1-NORMAL.json`（P01-FR1-NORMAL） — 313 bytes
- `evidence/checks/P01-FR1-REOPEN.json`（P01-FR1-REOPEN） — 313 bytes
- `evidence/commands/03-scenario-rollback-cas.log` — 788 bytes
- `evidence/checks/P01-FR1-ROLLBACK.json`（P01-FR1-ROLLBACK） — 463 bytes
- `evidence/checks/P01-FR2-ROLLBACK.json`（P01-FR2-ROLLBACK） — 463 bytes
- `evidence/checks/P01-FR2-CAS.json`（P01-FR2-CAS） — 312 bytes
- `evidence/commands/04-scenario-artifact-negative.log` — 788 bytes
- `evidence/checks/P01-FR2-ARTIFACT-MISSING.json`（P01-FR2-ARTIFACT-MISSING） — 481 bytes
- `evidence/checks/P01-FR2-ARTIFACT-RECOVERY.json`（P01-FR2-ARTIFACT-RECOVERY） — 336 bytes
- `evidence/commands/05-scenario-config-tags.log` — 759 bytes
- `evidence/checks/P01-FR2-CONFIG.json`（P01-FR2-CONFIG） — 459 bytes
- `evidence/checks/P01-FR2-TAGS.json`（P01-FR2-TAGS） — 311 bytes
- `evidence/commands/06-build-smoke.log` — 1543 bytes
- `evidence/checks/P01-ENG-BUILD-SMOKE.json`（P01-ENG-BUILD-SMOKE） — 299 bytes

## 已知限制

- 正式验收平台限 macOS；Windows/WSL/Linux 未验收。
- 可信项目模式不等于强 OS 沙箱；Pi 默认工具无强 OS 沙箱。
- T03/T24/T26/T32 仅覆盖 P01 已实现子集（验收契约 §4）；完整 Task 策略复制属 P03，本阶段不建执行表。
- P01-ENG-BUILD-SMOKE 由 test/p01-4-build-smoke.test.ts 承接：临时编译 dist 在非源码 cwd 装配并发布/重开制品，同时扫描个人绝对路径/被禁运行依赖/缺失迁移资源；verify 的 build 在它之前完成。

