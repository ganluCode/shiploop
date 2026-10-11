# P02 阶段验收摘要 — 未通过

- 运行 ID：`20261011T052537Z-4a12b994`
- 生成时间（UTC）：2026-10-11T05:32:08.080Z
- 报告 Schema 版本：1
- 输入计划：P02-4 P02 双客户端与初始化验收（2026-10-04-23-19-52_shiploop-p02-hostcli，版本 0.2，摘要 5b1d2534ce0280ab18b45092dd77d9c7f0cd722f2f699c7bf9290a5d19c5c5ff）
- 范围：FR-1/FR-2 双客户端唯一 Host、共享项目/配置、授权基线、重复初始化/命令重放/源文件保留/认证拒绝/客户端退出/重启查询/基线失败与阶段控制检查（macOS 正式范围）
- 受测 commit：`24b8377872f25c30e3a1efcc25504c9653c2b663`（工作树 clean）
- 前序基线：p02-host-lifecycle @ `7ae5f39bb3d30a82a37a592d938a8e3d933f8c02`（feat/2026-10-04-23-19-52_p02-1-host）
- 前序基线：p02-commands-events @ `3caca4892423fb33c2ea423edfd426c146314793`（feat/2026-10-04-23-19-52_p02-2）
- 前序基线：p02-onboarding @ `18d490e2543c657560c3de22b770e89157d27df3`（feat/2026-10-04-23-19-52_p02-3）
- 平台：Darwin 25.6.0 / arm64
- 工具版本：Node v22.19.0 · npm 10.9.3 · git version 2.50.1 (Apple Git-155) · SQLite 3.53.4 · better-sqlite3 13.0.3 · drizzle-orm 0.45.3
- Schema 版本：settings=2 · 导出格式=1 · SQLite 迁移=[1, 2, 3, 4, 5] · 线消息=3 · 事件封套=1
- 总体结论：**fail**（pass 0 / fail 1 / not_run 14，必需检查共 15 项）

## 必需检查结果

| 检查 ID | 分支 | 状态 | 证据数 |
|---|---|---|---|
| P02-ENG-VERIFY | 工程 | fail | 2 |
| P02-FR1-UNIQUE-HOST | FR-1 唯一 Host | not_run (startup_failure) | 0 |
| P02-FR1-SHARED-STATE | FR-1 共享项目/配置 | not_run (startup_failure) | 0 |
| P02-FR1-BASELINE-OK | FR-1 授权基线 | not_run (startup_failure) | 0 |
| P02-FR2-DUPLICATE-INIT | FR-2 重复初始化 | not_run (startup_failure) | 0 |
| P02-FR2-COMMAND-CONFLICT | FR-2 命令重放/冲突 | not_run (startup_failure) | 0 |
| P02-FR2-SOURCE-PRESERVED | FR-2 源文件保留 | not_run (startup_failure) | 0 |
| P02-FR2-AUTH-REJECT | FR-2 认证拒绝 | not_run (startup_failure) | 0 |
| P02-FR2-CLIENT-EXIT | FR-2 客户端退出 | not_run (startup_failure) | 0 |
| P02-FR1-RESTART-QUERY | FR-1 重启查询 | not_run (startup_failure) | 0 |
| P02-FR2-BASELINE-FAILURE | FR-2 基线失败 | not_run (startup_failure) | 0 |
| P02-PHASE-FIXTURE | 夹具失败 | not_run (startup_failure) | 0 |
| P02-PHASE-NOT-RUN | 必需检查未运行 | not_run (startup_failure) | 0 |
| P02-PHASE-REPORT | 报告完整性 | not_run (startup_failure) | 0 |
| P02-ENG-CLEAN-REPLAY | 重复运行不依赖残留 | not_run (startup_failure) | 0 |

## 命令记录

| 命令 | argv | cwd（逻辑） | 退出码 | 耗时（ms） |
|---|---|---|---|---|
| npm run verify（锁文件预检 + test/typecheck/build 实际执行） | `<node> <npm-cli> run verify` | `<repo>` | 1 | 390503 |

## 阶段外能力（不计入必需项通过数）

| ID | 能力 | 状态 | 说明 |
|---|---|---|---|
| P02-OOS-MODEL-LIVE | Runtime/Pi SDK 模型 Live 调用 | not_run | P02 无模型调用；本阶段不运行也不计入必需项通过数 |
| P02-OOS-WEB-CLIENT | 托管 Web/Electron 客户端 | not_run | 客户端按路线后续建设，本阶段仅 CLI/Host |
| P02-OOS-NON-MACOS | Windows/WSL/Linux 平台验收 | not_run | 正式验收限 macOS；其他平台另行验收 |
| P02-OOS-STRONG-SANDBOX | 强 OS 沙箱 | unsupported | 首版为可信项目模式，强沙箱按路线后续建设 |

## 证据清单

共 4 项，均为报告目录内相对路径（evidence/ 前缀），在临时资源清理前导出；逐项 sha256/sizeBytes 见 report.json。
- `evidence/config.json`（P02-PHASE-FIXTURE） — 4308 bytes
- `evidence/environment.json`（P02-PHASE-FIXTURE） — 802 bytes
- `evidence/commands/01-verify.log` — 63603 bytes
- `evidence/checks/P02-ENG-VERIFY.json`（P02-ENG-VERIFY） — 287 bytes

## 已知限制

- 正式验收平台限 macOS；Windows/WSL/Linux 未验收。
- 可信项目模式不等于强 OS 沙箱；Pi 默认工具无强 OS 沙箱。
- P02-ENG-CLEAN-REPLAY 由 test/p02-4-clean-replay.test.ts 承接（F-012 交付）：入口未交付时该检查 not_run/startup_failure，阶段退出码非零。
- 场景步骤经 scripts/run-tests.ts 以本地锁定 vitest 运行真实测试入口；verify 步骤先行完成锁文件预检/test/typecheck/build。

