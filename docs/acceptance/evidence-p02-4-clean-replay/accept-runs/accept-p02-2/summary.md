# P02 阶段验收摘要 — 通过

- 运行 ID：`20261011T060655Z-3737aea6`
- 生成时间（UTC）：2026-10-11T06:11:02.507Z
- 报告 Schema 版本：1
- 输入计划：P02-4 P02 双客户端与初始化验收（2026-10-04-23-19-52_shiploop-p02-hostcli，版本 0.2，摘要 5b1d2534ce0280ab18b45092dd77d9c7f0cd722f2f699c7bf9290a5d19c5c5ff）
- 范围：FR-1/FR-2 双客户端唯一 Host、共享项目/配置、授权基线、重复初始化/命令重放/源文件保留/认证拒绝/客户端退出/重启查询/基线失败与阶段控制检查（macOS 正式范围）
- 受测 commit：`e6a3a46239b35fb1f89684b374bf94a08737a500`（工作树 clean）
- 前序基线：p02-host-lifecycle @ `7ae5f39bb3d30a82a37a592d938a8e3d933f8c02`（feat/2026-10-04-23-19-52_p02-1-host）
- 前序基线：p02-commands-events @ `3caca4892423fb33c2ea423edfd426c146314793`（feat/2026-10-04-23-19-52_p02-2）
- 前序基线：p02-onboarding @ `18d490e2543c657560c3de22b770e89157d27df3`（feat/2026-10-04-23-19-52_p02-3）
- 平台：Darwin 25.6.0 / arm64
- 工具版本：Node v22.19.0 · npm 10.9.3 · git version 2.50.1 (Apple Git-155) · SQLite 3.53.4 · better-sqlite3 13.0.3 · drizzle-orm 0.45.3
- Schema 版本：settings=2 · 导出格式=1 · SQLite 迁移=[1, 2, 3, 4, 5] · 线消息=3 · 事件封套=1
- 总体结论：**pass**（pass 15 / fail 0 / not_run 0，必需检查共 15 项）

## 必需检查结果

| 检查 ID | 分支 | 状态 | 证据数 |
|---|---|---|---|
| P02-ENG-VERIFY | 工程 | pass | 2 |
| P02-FR1-UNIQUE-HOST | FR-1 唯一 Host | pass | 2 |
| P02-FR1-SHARED-STATE | FR-1 共享项目/配置 | pass | 2 |
| P02-FR1-BASELINE-OK | FR-1 授权基线 | pass | 2 |
| P02-FR2-DUPLICATE-INIT | FR-2 重复初始化 | pass | 2 |
| P02-FR2-COMMAND-CONFLICT | FR-2 命令重放/冲突 | pass | 2 |
| P02-FR2-SOURCE-PRESERVED | FR-2 源文件保留 | pass | 2 |
| P02-FR2-AUTH-REJECT | FR-2 认证拒绝 | pass | 2 |
| P02-FR2-CLIENT-EXIT | FR-2 客户端退出 | pass | 2 |
| P02-FR1-RESTART-QUERY | FR-1 重启查询 | pass | 2 |
| P02-FR2-BASELINE-FAILURE | FR-2 基线失败 | pass | 2 |
| P02-PHASE-FIXTURE | 夹具失败 | pass | 2 |
| P02-PHASE-NOT-RUN | 必需检查未运行 | pass | 2 |
| P02-PHASE-REPORT | 报告完整性 | pass | 2 |
| P02-ENG-CLEAN-REPLAY | 重复运行不依赖残留 | pass | 2 |

## 命令记录

| 命令 | argv | cwd（逻辑） | 退出码 | 耗时（ms） |
|---|---|---|---|---|
| npm run verify（锁文件预检 + test/typecheck/build 实际执行） | `<node> <npm-cli> run verify` | `<repo>` | 0 | 92755 |
| test/p02-4-dual-cli-acceptance.test.ts（真实临时 Git/SQLite/进程，经公共 CLI/Host） | `<node> scripts/run-tests.ts test/p02-4-dual-cli-acceptance.test.ts` | `<repo>` | 0 | 14619 |
| test/p02-4-idempotency-acceptance.test.ts（真实临时 Git/SQLite/进程，经公共 CLI/Host） | `<node> scripts/run-tests.ts test/p02-4-idempotency-acceptance.test.ts` | `<repo>` | 0 | 14320 |
| test/p02-4-repo-preservation-acceptance.test.ts（真实临时 Git/SQLite/进程，经公共 CLI/Host） | `<node> scripts/run-tests.ts test/p02-4-repo-preservation-acceptance.test.ts` | `<repo>` | 0 | 16420 |
| test/p02-4-negative-acceptance.test.ts（真实临时 Git/SQLite/进程，经公共 CLI/Host） | `<node> scripts/run-tests.ts test/p02-4-negative-acceptance.test.ts` | `<repo>` | 0 | 19238 |
| test/p02-4-restart-acceptance.test.ts（真实临时 Git/SQLite/进程，经公共 CLI/Host） | `<node> scripts/run-tests.ts test/p02-4-restart-acceptance.test.ts` | `<repo>` | 0 | 44943 |
| test/p02-4-baseline-failure-acceptance.test.ts（真实临时 Git/SQLite/进程，经公共 CLI/Host） | `<node> scripts/run-tests.ts test/p02-4-baseline-failure-acceptance.test.ts` | `<repo>` | 0 | 38995 |
| test/p02-4-acceptance-controller.test.ts（真实临时 Git/SQLite/进程，经公共 CLI/Host） | `<node> scripts/run-tests.ts test/p02-4-acceptance-controller.test.ts` | `<repo>` | 0 | 4332 |
| test/p02-4-report-aggregation.test.ts（真实临时 Git/SQLite/进程，经公共 CLI/Host） | `<node> scripts/run-tests.ts test/p02-4-report-aggregation.test.ts` | `<repo>` | 0 | 343 |
| test/p02-4-acceptance-report.test.ts（真实临时 Git/SQLite/进程，经公共 CLI/Host） | `<node> scripts/run-tests.ts test/p02-4-acceptance-report.test.ts` | `<repo>` | 0 | 374 |
| test/p02-4-clean-replay.test.ts（真实临时 Git/SQLite/进程，经公共 CLI/Host） | `<node> scripts/run-tests.ts test/p02-4-clean-replay.test.ts` | `<repo>` | 0 | 353 |

## 阶段外能力（不计入必需项通过数）

| ID | 能力 | 状态 | 说明 |
|---|---|---|---|
| P02-OOS-MODEL-LIVE | Runtime/Pi SDK 模型 Live 调用 | not_run | P02 无模型调用；本阶段不运行也不计入必需项通过数 |
| P02-OOS-WEB-CLIENT | 托管 Web/Electron 客户端 | not_run | 客户端按路线后续建设，本阶段仅 CLI/Host |
| P02-OOS-NON-MACOS | Windows/WSL/Linux 平台验收 | not_run | 正式验收限 macOS；其他平台另行验收 |
| P02-OOS-STRONG-SANDBOX | 强 OS 沙箱 | unsupported | 首版为可信项目模式，强沙箱按路线后续建设 |

## 证据清单

共 28 项，均为报告目录内相对路径（evidence/ 前缀），在临时资源清理前导出；逐项 sha256/sizeBytes 见 report.json。
- `evidence/config.json`（P02-PHASE-FIXTURE） — 4308 bytes
- `evidence/environment.json`（P02-PHASE-FIXTURE） — 802 bytes
- `evidence/commands/01-verify.log` — 4384 bytes
- `evidence/checks/P02-ENG-VERIFY.json`（P02-ENG-VERIFY） — 286 bytes
- `evidence/commands/02-dual-cli.log` — 770 bytes
- `evidence/checks/P02-FR1-UNIQUE-HOST.json`（P02-FR1-UNIQUE-HOST） — 295 bytes
- `evidence/checks/P02-FR1-SHARED-STATE.json`（P02-FR1-SHARED-STATE） — 296 bytes
- `evidence/checks/P02-FR1-BASELINE-OK.json`（P02-FR1-BASELINE-OK） — 295 bytes
- `evidence/commands/03-idempotency.log` — 779 bytes
- `evidence/checks/P02-FR2-DUPLICATE-INIT.json`（P02-FR2-DUPLICATE-INIT） — 362 bytes
- `evidence/checks/P02-FR2-COMMAND-CONFLICT.json`（P02-FR2-COMMAND-CONFLICT） — 381 bytes
- `evidence/commands/04-repo-preservation.log` — 797 bytes
- `evidence/checks/P02-FR2-SOURCE-PRESERVED.json`（P02-FR2-SOURCE-PRESERVED） — 393 bytes
- `evidence/commands/05-auth-reject.log` — 773 bytes
- `evidence/checks/P02-FR2-AUTH-REJECT.json`（P02-FR2-AUTH-REJECT） — 376 bytes
- `evidence/commands/06-restart.log` — 767 bytes
- `evidence/checks/P02-FR2-CLIENT-EXIT.json`（P02-FR2-CLIENT-EXIT） — 351 bytes
- `evidence/checks/P02-FR1-RESTART-QUERY.json`（P02-FR1-RESTART-QUERY） — 295 bytes
- `evidence/commands/07-baseline-failure.log` — 794 bytes
- `evidence/checks/P02-FR2-BASELINE-FAILURE.json`（P02-FR2-BASELINE-FAILURE） — 391 bytes
- `evidence/commands/08-controller.log` — 776 bytes
- `evidence/checks/P02-PHASE-FIXTURE.json`（P02-PHASE-FIXTURE） — 296 bytes
- `evidence/commands/09-report-aggregation.log` — 801 bytes
- `evidence/checks/P02-PHASE-NOT-RUN.json`（P02-PHASE-NOT-RUN） — 311 bytes
- `evidence/commands/10-acceptance-report.log` — 798 bytes
- `evidence/checks/P02-PHASE-REPORT.json`（P02-PHASE-REPORT） — 308 bytes
- `evidence/commands/11-clean-replay.log` — 939 bytes
- `evidence/checks/P02-ENG-CLEAN-REPLAY.json`（P02-ENG-CLEAN-REPLAY） — 302 bytes

## 已知限制

- 正式验收平台限 macOS；Windows/WSL/Linux 未验收。
- 可信项目模式不等于强 OS 沙箱；Pi 默认工具无强 OS 沙箱。
- P02-ENG-CLEAN-REPLAY 由 test/p02-4-clean-replay.test.ts 承接（F-012 交付）：入口未交付时该检查 not_run/startup_failure，阶段退出码非零。
- 场景步骤经 scripts/run-tests.ts 以本地锁定 vitest 运行真实测试入口；verify 步骤先行完成锁文件预检/test/typecheck/build。

