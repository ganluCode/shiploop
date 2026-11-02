# P08-1 发布支持矩阵

状态：P08-1 本地 pack 候选，**未发布、未完成 P08 阶段集成验收**。本文件是支持边界说明，不是发布授权，也不是阶段通过证明。机器可读的权威声明是仓库根的 [`distribution-compatibility.json`](../distribution-compatibility.json)；两者不一致时以该 JSON 和实际代码/检查为准，并应先修正文档。

## 1. 分发身份

| 项目 | 当前值 | 状态 |
|---|---|---|
| 分发模式 | `local-pack-only` | 仅本地 tarball；`published: false` |
| 统一版本 | `0.0.0` | 三个工作区包同版本 |
| Core / Host / CLI | `shiploop-core` / `shiploop-host` / `shiploop-cli` | 均为 `private: true`，不是公开包名 |
| 公开发布 | 未授权 | `npm publish`、push、PR、合并均不在本 Feature 范围 |
| 许可证 / npm scope / 公开包名 / 发布身份 | 待负责人确认（`releaseBlockers` 全部 `pending`） | 本文件不替负责人决定 |

## 2. 平台与工具链

| 项目 | 固定值 | 说明 |
|---|---|---|
| 正式支持平台 | macOS（`darwin`） | Windows / WSL / Linux 未验收、不记为通过 |
| Node.js | `22.19.0` | `.nvmrc`、`.node-version`、`engines` 与兼容声明一致 |
| npm | `10.9.3` | `packageManager: npm@10.9.3`；不使用 pnpm/yarn |
| 原生模块 | better-sqlite3 与 Host 写入锁 | 需要 Xcode Command Line Tools；真实安装加载属 Phase 集成 |
| 包管理器 | npm workspaces + 已提交 `package-lock.json` | 不通过 npx/全局工具补齐运行依赖 |

## 3. Host 协议范围

以下值复制自 `distribution-compatibility.json` 的 `hostProtocol`，并通过 `test/modules/engineering/p08-1-f007-release-manifest-docs.test.ts` 守护一致性：

| 字段 | 值 | 语义 |
|---|---|---|
| `wireProtocolVersions` | `[1]` | 当前客户端/Host 只声明协议版本 1 |
| `wireSchemaVersion` | `6` | 当前握手 schema 版本 |
| `legacyHandshakeSchemaVersionsAccepted` | `[5]` | 只接受明确登记的 legacy 版本 |
| `discoverySchemaVersions` | `[1]` | 发现文件 schema |
| `unknownVersionPolicy` | `reject` | 未知/更高版本明确拒绝，不猜测降级 |

## 4. 数据库 Schema 支持范围

| 字段 | 值 | 语义 |
|---|---|---|
| `engine` | `sqlite` | 本地状态库 |
| `readableAppliedVersions` | `1..64` | 可读取已应用迁移版本范围 |
| `writableTargetVersion` | `64` | 当前可写目标版本 |
| `higherVersionPolicy` | `reject` | 更高版本拒写并保留现场，不自动降级/回退覆盖 |

## 5. 已交付与未运行的分层

| 层次 | 状态 | 判据 |
|---|---|---|
| 代码交付 | `delivered` | F-001～F-006 已在分支本地提交；F-007 只补文档、清单与索引 |
| Task 局部单元检查 | `passed` | F-007 的文档/清单守护测试通过；其他 Task 以各自索引和日志为准 |
| Feature 门禁 | `not_run` | 由 Nezha 在最终代码上独立执行去重 Task 索引，文档不代跑、不代签 |
| P08 Phase 集成 | `not_run` | 真实三包安装、Host/CLI 运行、协议兼容/不兼容、进程清理、Todo/存量演示均待 P08 阶段验收 |
| 负责人确认 / live 授权 | 未提供 | 机器结果、文档和清单不能替代人工确认或真实模型授权 |

## 6. 明确不在本阶段通过范围

- 真实三包在独立干净目录安装并运行：`not_run`。
- 安装后 Host 启动、CLI 实际调用与生命周期冒烟：`not_run`。
- 已有 Host 的协议兼容/不兼容矩阵：`not_run`。
- 安装/停止后的原生进程与临时资源清理证据：`not_run`。
- 从干净安装目录完成 Todo 演示、接入存量仓库完成增量变更：`not_run`。
- 公开 npm 发布、签名、跨平台认证、Electron/Chat 与其他 Runtime：未实现或未授权。

上述缺口的机器可读记录见 [`acceptance/p08-1.release-manifest.json`](../acceptance/p08-1.release-manifest.json)，操作步骤见[新用户安装与操作指南](p08-1-user-guide.md)。P08-4 必须重新解析最终提交与真实证据，不能把本矩阵当作阶段放行结论。
