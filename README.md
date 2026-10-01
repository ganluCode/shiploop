# ShipLoop 工程工作区

P01-1 工程骨架：npm workspaces、固定工具链与确定性测试入口。本仓库当前只包含工程基础设施，**不包含**任何 ShipLoop 业务实现（领域状态机、持久化、Host 网络接口、模型调用均在后续 Feature 中建设）。

## 验收平台

- 首个正式支持与验收平台为 **macOS**。Windows / WSL / Linux 另行验收，当前不记为已通过。
- 所有验收命令在不包含 `node_modules`、`dist` 等本机残留的临时源码副本中执行。

## 固定工具链

| 工具 | 精确版本 | 选择依据 |
|---|---|---|
| Node.js | `22.19.0` | 2026-10-01 在本机（macOS, nvm）已验证的 LTS 线上版本；Vitest 5 要求 `^22.12.0 \|\| ^24.0.0 \|\| >=26`，该版本满足。 |
| npm | `10.9.3` | 随 Node 22.19.0 的本机 npm，已实际验证 `npm ci` / `npm test` 闭环。 |
| Vitest | `5.0.3` | 一次性（非 watch）确定性测试运行器；设计文档建议的候选，精确锁定，不使用 `^`/`~` 范围。 |

版本一致性由以下位置共同保证，改动时必须全部同步：

- `.node-version` 与 `.nvmrc`：`22.19.0`
- 根 `package.json` 的 `engines.node` / `engines.npm` 与 `packageManager`
- 各工作区包的 `engines.node`
- `.npmrc` 启用 `engine-strict=true`（版本不符直接安装失败）与 `save-exact=true`（新增依赖默认锁定精确版本）

## 目录与包结构

```text
packages/core   shiploop-core   Core 领域与应用逻辑（后续 Feature 实现）
packages/host   shiploop-host   Host（后续 Feature 实现）
packages/cli    shiploop-cli    CLI（后续 Feature 实现）
test/           仓库级确定性测试
```

命名决定（2026-10-02）：

- 三个包均为 `private: true`，**不会发布**，因此使用不带 scope 的私有名称 `shiploop-core` / `shiploop-host` / `shiploop-cli`。
- **不假定 `@shiploop` scope 已获授权**；设计文档记录 npm 上裸名 `shiploop` 已被占用，正式发布前需另行确定 scope 与 CLI bin 命名冲突处理。
- 当前初始版本统一为 `0.0.0`。

依赖规则（后续 Feature 细化为自动检查）：Host 可依赖 Core 公共入口；CLI 仅在需要时依赖 Host 公共客户端/契约；Core 不反向依赖 Host/CLI。当前骨架没有任何运行时依赖。

## 常用命令

```bash
npm ci     # 按 package-lock.json 干净安装
npm test   # 一次性执行全部测试（vitest run），失败返回非零
```

`typecheck`、`build`、`verify` 将在后续 Feature（F-002、F-005）加入；当前不存在这些脚本。

## Pi SDK 接入基线（本任务不接入）

- 前期验证依据：设计文档 `core-design/05-runtime-and-session-recording.md` 与 `core-design/09-testing-and-implementation.md` 记录的 2026-09-30 / 2026-10-01 macOS 实验，使用 **Pi Node SDK 0.84.2**（S1–S5：事件、工具、取消、存档、资源清单、Token 口径、凭据与进程组清理边界）。
- 结论基线：Pi 默认工具不具备强 OS 沙箱，首版按用户明确授权的可信项目模式推进；Runner 强杀后的进程组停止核验须在 Host 监督逻辑中实现。
- 本任务**不安装、不调用 Pi SDK**；正式接入时需在 adapter 层重新核验当时的 SDK 能力、套餐与认证政策，并锁定精确版本。
- 本任务同样不引入 SQLite / better-sqlite3 / Drizzle 或任何业务持久化实现。

## 非目标

- 不发布任何 npm 包，不修改既有 `LICENSE`。
- 不依赖 Nezha 仓库、Harness 目录、用户模型凭据即可安装与测试。
- 源码、清单与锁文件不得包含开发机绝对路径或凭据。
