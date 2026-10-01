# ShipLoop 工程工作区

P01-1 工程骨架：npm workspaces、固定工具链、严格 TypeScript 构建与确定性测试入口。本仓库当前只包含工程基础设施，**不包含**任何 ShipLoop 业务实现（领域状态机、持久化、Host 网络接口、模型调用均在后续 Feature 中建设）；入口模块加载无副作用，不提供空壳的项目、调度、存储或 Runtime 服务。

## 验收平台

- 首个正式支持与验收平台为 **macOS**。Windows / WSL / Linux 另行验收，当前不记为已通过。
- 所有验收命令在不包含 `node_modules`、`dist` 等本机残留的临时源码副本中执行。

## 固定工具链

| 工具 | 精确版本 | 选择依据 |
|---|---|---|
| Node.js | `22.19.0` | 2026-10-01 在本机（macOS, nvm）已验证的 LTS 线上版本；Vitest 5 要求 `^22.12.0 \|\| ^24.0.0 \|\| >=26`，该版本满足；22.18+ 原生支持直接运行仅含可擦除语法的 TypeScript，工程脚本据此运行。 |
| npm | `10.9.3` | 随 Node 22.19.0 的本机 npm，已实际验证 `npm ci` / `npm test` 闭环。 |
| TypeScript | `7.0.2` | 严格类型检查与构建编译器（`tsc -b` 产物含 `.js` / `.d.ts` / sourcemap），精确锁定；已在干净副本验证。 |
| @types/node | `22.20.4` | Node 内置模块类型；TS 7 不再自动纳入全部 `@types/*`，由 `tsconfig.base.json` 显式 `types: ["node"]`。 |
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
scripts/        工程检查脚本（TypeScript，受 typecheck 覆盖）
```

Core 源码按设计 `core-design/01-system-structure.md` 分层，目录边界由各目录下的 `README.md` 明确（拥有、允许、禁止），F-002 阶段只有无副作用的公共入口 `src/index.ts`：

```text
packages/core/src/
  domain/        状态规则、策略与值类型
  application/   命令、查询、执行编排
  ports/         StateStore、Runtime、凭据等窄接口
  adapters/      sqlite、文件、git、pi 的具体实现（当前为空，不预置空壳）
packages/host/src/index.ts   Host 公共入口（当前不是启动入口，不监听端口）
packages/cli/src/index.ts    CLI 公共入口（当前不解析 argv、不发请求）
```

各包 `package.json` 的 `main` / `types` / `exports['.']` 均指向 `dist` 构建产物；`npm run build` 通过 `tsc -b` 为三个包各自生成 `dist/index.js` 与 `dist/index.d.ts`（含 sourcemap 与增量构建信息）。构建结束后执行 `scripts/smoke-built-entries.ts`：在独立 Node 子进程中加载三个入口（5 秒超时），并将 `HOME` / XDG 目录 / cwd 重定向到系统临时目录沙箱，断言退出码 0、非常驻、不写用户数据、产物与声明文件存在。

命名决定（2026-10-02）：

- 三个包均为 `private: true`，**不会发布**，因此使用不带 scope 的私有名称 `shiploop-core` / `shiploop-host` / `shiploop-cli`。
- **不假定 `@shiploop` scope 已获授权**；设计文档记录 npm 上裸名 `shiploop` 已被占用，正式发布前需另行确定 scope 与 CLI bin 命名冲突处理。
- 当前初始版本统一为 `0.0.0`。

### 单向依赖规则

工程包之间为**单向依赖**，后续 Feature（F-004）会落实为自动检查：

- **Host 可依赖 Core 公共入口**（仅经包名 `shiploop-core` 的 `exports`，不导入 Core 内部实现文件）。
- **CLI 只在需要时依赖 Host 公共客户端或契约**；**不导入 Host 启动入口**或 Core 实现，不绕过 Host 直读 SQLite。
- **Core 不反向依赖** Host/CLI；Core 全树（含公共入口）不导入或重导出 Pi SDK、Electron、HTTP 框架、`better-sqlite3`、Drizzle 或 `node:http`/`node:net`。
- 没有实际使用的依赖不为占位而添加；当前三个包均无任何运行时依赖，只有根工作区持有固定版本的开发工具（typescript、@types/node、vitest）。

类型系统上，根 `tsconfig.json` 以 `noEmit` 统一覆盖 `test/**/*.ts`、`scripts/**/*.ts` 与三个包的 `src/**/*.ts`；各包自己的 `tsconfig.json`（`composite`、`rootDir: src`、`outDir: dist`）只负责产物构建。

## 常用命令

```bash
npm ci             # 按 package-lock.json 干净安装
npm test           # 一次性执行全部测试（vitest run），失败返回非零；无需先手工构建
npm run typecheck  # 严格类型检查（strict），覆盖源码、测试与 scripts/ 下的 TypeScript，不产出文件
npm run build      # tsc -b 构建三个包到各自 dist，并运行构建入口冒烟脚本
```

在没有 `dist` 与类型缓存的干净临时副本中，`typecheck` 与 `build` 均须返回 0；注入明确类型错误时 `typecheck` 返回非零。`verify` 工程检查编排将在 F-005 加入；当前不存在该脚本。

## Pi SDK 接入基线（本任务不接入）

- 前期验证依据：设计文档 `core-design/05-runtime-and-session-recording.md` 与 `core-design/09-testing-and-implementation.md` 记录的 2026-09-30 / 2026-10-01 macOS 实验，使用 **Pi Node SDK 0.84.2**（S1–S5：事件、工具、取消、存档、资源清单、Token 口径、凭据与进程组清理边界）。
- 结论基线：Pi 默认工具不具备强 OS 沙箱，首版按用户明确授权的可信项目模式推进；Runner 强杀后的进程组停止核验须在 Host 监督逻辑中实现。
- 本任务**不安装、不调用 Pi SDK**；正式接入时需在 adapter 层重新核验当时的 SDK 能力、套餐与认证政策，并锁定精确版本。
- 本任务同样不引入 SQLite / better-sqlite3 / Drizzle 或任何业务持久化实现。

## 非目标

- 不发布任何 npm 包，不修改既有 `LICENSE`。
- 不依赖 Nezha 仓库、Harness 目录、用户模型凭据即可安装与测试。
- 源码、清单与锁文件不得包含开发机绝对路径或凭据。
