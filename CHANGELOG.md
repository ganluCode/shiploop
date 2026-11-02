# P08-1 变更说明

本文件记录 P08-1「安装包与用户操作文档」的阶段性变更。当前版本仍为 `0.0.0`，分发模式 `local-pack-only`，`published: false`；这不是公开发布公告，也不代表 P08 阶段验收通过。

## 0.0.0（未发布，本地 pack）

### 新增

- F-001：冻结 `shiploop-core` / `shiploop-host` / `shiploop-cli` 的本地分发元数据、统一版本、Node/npm 引擎、平台、Host 协议与数据库 Schema 支持范围；公开发布身份仍为待确认阻塞项。
- F-002：新增 `npm run pack:local`，按依赖顺序生成三个本地 tarball 和带逐文件摘要的 `distribution-manifest.json`；拒绝 workspace/file/开发目录依赖与疑似凭据。
- F-003：新增 `npm run verify:artifacts`，核对清单、commit、制品摘要、入口、依赖闭包、协议/Schema 范围和敏感内容；结果区分 `passed` / `failed` / `not_run`。
- F-004：新增最小发布 CI `release-ci`，固定 `npm ci → verify:ci-config → verify → pack:local → verify:artifacts → 摘要` 顺序；不发布、不推送、不创建 PR、不调用真实模型。
- F-005：新增[新用户安装与操作指南](docs/p08-1-user-guide.md)，覆盖本地 pack、独立安装、数据根、Host/CLI、认证、项目接入、规划、执行、停止、备份恢复与排障。
- F-006：新增并同步 8 份[操作 Skills](docs/skills/)，只通过正式 CLI/API 操作；补齐安装、规划批准、执行观察、停止、备份恢复和排障命令面。
- F-007：新增[发布支持矩阵](docs/p08-1-support-matrix.md)、[制品检查说明](docs/p08-1-artifact-verification.md)、[发布清单模板](docs/acceptance/p08-1-release-manifest.md)与[P08-1 交付报告](docs/acceptance/p08-1-delivery-report.md)，并接入 README 文档导航。

### 兼容性

- Host 协议：`wireProtocolVersions [1]`、`wireSchemaVersion 6`，只接受登记的 legacy schema `5`；未知/更高版本 `reject`。
- 数据库 Schema：可读 `1..64`，当前可写目标 `64`；更高版本拒写。
- 工具链：Node `22.19.0`、npm `10.9.3`；正式平台 macOS（`darwin`）。
- 机器可读权威来源：[`distribution-compatibility.json`](distribution-compatibility.json)。

### 未包含 / 未验证

- 真实三包在独立干净目录安装、Host/CLI 运行、协议兼容/不兼容矩阵、进程清理、Todo 与存量仓库演示：`not_run`。
- 公开 npm 发布、npm scope/许可证/公开包名/发布身份：待负责人确认，`pending`。
- Windows / WSL / Linux、Electron、Chat、其他 Runtime：未支持或后置。
- 全仓历史回归、Feature 门禁和 P08 Phase 集成不由本变更说明宣称通过；以独立验证和阶段验收记录为准。
