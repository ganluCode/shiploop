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
| Vitest | `5.0.3` | 一次性（非 watch）确定性测试运行器；设计文档建议的候选，精确锁定，不使用 `^`/`~` 范围。由 `scripts/run-tests.ts` 启动器校验本地安装的工具身份与精确版本后调用，不回退全局实现或 npx 下载。 |
| better-sqlite3 | `13.0.3` | SQLite 驱动（P01-2 / F-001 起固定于 `shiploop-core` 适配层）。设计 `core-design/03` S2 实验（2026-10-01，macOS arm64 / Node 22.19.0）已验证的候选版本：跨进程认领、预算竞争、回滚、busy 超时、迁移回退与 WAL 在线备份用例均通过，预编译 `darwin-arm64` 原生模块本机加载成功。 |
| drizzle-orm | `0.45.3` | SQLite ORM（P01-2 / F-001 起固定于 `shiploop-core` 适配层）。S2 实验在同一驱动上验证了 `immediate` 事务的提交/回滚；精确锁定，不使用 `^`/`~` 范围。 |
| @types/better-sqlite3 | `9.6.0` | better-sqlite3 官方包不携带类型声明，锁定 DefinitelyTyped 对应版本；仅作为 `shiploop-core` 开发依赖。 |

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
test/           仓库级确定性测试（*.test.{js,ts}）与夹具（test/helpers，不收集为用例）
scripts/        工程检查脚本（TypeScript，受 typecheck 覆盖）：run-tests.ts（测试启动器）、
                smoke-built-entries.ts（构建入口冒烟）、check-boundaries.ts（依赖边界检查）、
                verify.ts（fail-closed 工程检查编排，见下节）
vitest.config.ts 确定性测试配置（一次性、fail-closed）
docs/acceptance/  P01-1 / P01-2 验收报告与脱敏证据（见下文「集成验收报告」「P01-2 存储与制品」）
docs/storage-operations.md  P01-2 存储操作与恢复说明（F-014）
docs/p01-3-handoff.md       P01-3 接口交接（F-014）
```

### 确定性测试约定（F-003）

`npm test` 实际执行 `node scripts/run-tests.ts`，该启动器 fail-closed：

- 只从本仓库工作区安装解析 `vitest/package.json`（经 `createRequire` 从脚本位置向上查找），**不使用 PATH 全局 vitest，也不通过 npx 临时下载**；
- 校验包名 `vitest` 与精确版本 `5.0.3`，工具缺失、身份不符或版本不符时以退出码 1 失败，输出包含工具名、要求版本与 `npm ci` 修复提示；
- 始终以 `run`（一次性、非 watch）模式 spawn 真实 vitest，透传额外参数，原样继承 stdio，传播退出码；信号退出、超时或进程错误一律非零。

`vitest.config.ts` 固定确定性语义：`watch: false`、`passWithNoTests: false`（找不到真实测试文件即失败）、`cache: false`、`pool: 'forks'`、不随机序、有限的用例/钩子超时、`coverage.enabled: false`；只收集 `test/` 下的真实用例，`test/helpers` 与 `test/fixtures` 显式排除。没有静默 skip、空断言或“未运行即通过”的配置。

临时资源统一经 `test/helpers/temp-sandbox.ts` 创建：每次在系统临时目录 `mkdtemp` 全新目录（拒绝落在受测仓库或用户 HOME 之内），`cleanup()` 递归删除并核验消失；`withTempSandbox()` 以 try/finally 保证回调抛错时同样清理。夹具包含中文多字节内容的 UTF-8 逐字节往返断言（无 BOM、无换行转换）。

`test/deterministic-test-harness.test.ts` 以**真实子进程**（非 mock）回归：空测试集非零、注入失败断言非零、临时项目正向对照为零、`--version` 报出 `vitest/5.0.3`、工具缺失启动器非零且报出身份；子进程带有限超时并在结束后回收，不留下常驻进程。测试不依赖 `dist`（任何用例都不得导入三个工作区包名），干净 `npm ci` 后无需先构建即可 `npm test`。

Core 源码按设计 `core-design/01-system-structure.md` 分层，目录边界由各目录下的 `README.md` 明确（拥有、允许、禁止），F-002 阶段只有无副作用的公共入口 `src/index.ts`：

```text
packages/core/src/
  domain/        状态规则、策略与值类型
  application/   命令、查询、执行编排
  ports/         StateStore、Runtime、凭据等窄接口
  adapters/      sqlite、文件、git、pi 的具体实现（P01-2 F-001 起：sqlite/connection.ts 驱动装配 + 固定版本驱动/ORM；其余为空，不预置空壳）
packages/host/src/index.ts   Host 公共入口（当前不是启动入口，不监听端口）
packages/cli/src/index.ts    CLI 公共入口（当前不解析 argv、不发请求）
```

各包 `package.json` 的 `main` / `types` / `exports['.']` 均指向 `dist` 构建产物；`npm run build` 通过 `tsc -b` 为三个包各自生成 `dist/index.js` 与 `dist/index.d.ts`（含 sourcemap 与增量构建信息）。构建结束后执行 `scripts/smoke-built-entries.ts`：在独立 Node 子进程中加载三个入口（5 秒超时），并将 `HOME` / XDG 目录 / cwd 重定向到系统临时目录沙箱，断言退出码 0、非常驻、不写用户数据、产物与声明文件存在。

命名决定（2026-10-02）：

- 三个包均为 `private: true`，**不会发布**，因此使用不带 scope 的私有名称 `shiploop-core` / `shiploop-host` / `shiploop-cli`。
- **不假定 `@shiploop` scope 已获授权**；设计文档记录 npm 上裸名 `shiploop` 已被占用，正式发布前需另行确定 scope 与 CLI bin 命名冲突处理。
- 当前初始版本统一为 `0.0.0`。

### 工程检查编排 verify（F-005）

`npm run verify` 实际执行 `node scripts/verify.ts`，这是**开发工程检查编排**，不是未来 ShipLoop 的业务 Verifier；本阶段**不提供 accept:p01 验收命令**，verify 通过不代表任何业务验收。编排 fail-fast，输出中可核对每个检查命令、退出码与失败项：

- **预检（不启动子命令）**：根 `package.json` 可解析且声明 `test` / `typecheck` / `build` 三个脚本（缺失即失败，检查不得跳过）；`package-lock.json` 存在、可解析、`lockfileVersion` 有效、`name`/`version` 与根清单一致。预检不看 `node_modules`，锁文件缺失不会被“依赖已安装”的表象掩盖。
- **串联真实子命令**：依次运行 `npm test`、`npm run typecheck`、`npm run build`；只有全部退出码为 0，verify 才返回 0。优先使用 `npm_execpath` 指定的当前 npm，否则回退 PATH 上的 npm；**不通过 npx 临时下载工具，也不跳过检查恢复成功**。
- **有限超时与进程收尾**：单步默认 600s 超时（可用 `--step-timeout-ms` 或 `SHIPLOOP_VERIFY_STEP_TIMEOUT_MS` 覆盖，供隔离夹具验收）；子命令以独立进程组运行，超时对整个进程组 SIGKILL；退出码非 0、信号退出、超时或无法启动一律算失败。
- **NOT RUN 语义**：任一步失败即停止，后续未执行步骤明确标记 NOT RUN，绝不把未运行项标为通过。

负向验收见 `test/verify.test.ts`：在系统临时目录构建独立夹具工作区（真实锁文件、真实断言的有限测试集合、真实 tsc 与构建脚本），以真实子进程运行同一个生产 `verify.ts`，分别验证缺锁文件、无测试文件、注入失败断言、注入类型错误、构建非零、必需工具被删、步骤超时与信号死亡等场景均非零退出；夹具测试子命令不回跳本仓库 `npm test`，不产生递归验收。

### 集成验收报告（F-006）

P01-1 的干净安装与工程检查集成验收已在 macOS（arm64，Node 22.19.0 / npm 10.9.3）上完成：由 `git archive` 生成无 `node_modules` / `dist` / 本机残留的独立源码快照，`npm ci`、`npm test`、`npm run typecheck`、`npm run build`、`npm run verify` 五条命令真实退出码均为 0；缺锁文件、无测试、失败断言、类型错误、构建失败、缺必需工具与违规依赖七类负向场景在隔离副本中全部非零拒绝；Core 公共入口在无厂商 SDK 的子进程环境中加载成功；源码、构建产物与 `npm pack` 清单无开发机路径、Harness 依赖或凭据，未执行 npm 发布。完整命令/退出码、证据相对路径、输入文档版本（SHA-256 清单）、已知缺口与 `not_run` 项见 [docs/acceptance/p01-1-f006-report.md](docs/acceptance/p01-1-f006-report.md)（证据在同目录 `evidence-p01-1/`，已脱敏）。该验收仅限工程骨架，不代表 P01 持久化或 `accept:p01` 通过。

### P01-2 存储与制品落盘（F-014）

P01-2 在 macOS（arm64，Node 22.19.0 / npm 10.9.3 / SQLite 3.53.4 / better-sqlite3 13.0.3 / drizzle-orm 0.45.3）上完成 SQLite 原子存储与制品落盘闭环：六张基础表（`projects`、`repository_bindings`、`global_settings`、`project_settings`、`artifacts`、`schema_migrations`）、版本化迁移与一致性备份、连接会话与有限 busy 预算、项目/配置 CAS 与原子组合写入、制品 `pending→ready/failed` 索引与受控文件发布、关闭重开后中断核对与损坏诊断。干净快照六条命令（`npm ci` / `npm test` / `npm run typecheck` / `npm run build` / `npm run verify` / dist 非源码 cwd 闭环）真实退出码全部为 0。

- [docs/storage-operations.md](docs/storage-operations.md)：最小端口使用示例、`schemaVersion`/`revision` 含义、busy 预算、受控 locator、`pending`/`ready`/`failed` 与 corrupt 诊断、核对与迁移失败的恢复步骤、备份边界。
- [docs/acceptance/p01-2-f014-report.md](docs/acceptance/p01-2-f014-report.md)：输入文档版本、实现范围、受测 commit、命令与退出码、证据相对路径、已建表/字段/约束、已知缺口与 `not_run`（证据在同目录 `evidence-p01-2/`，已脱敏）。
- [docs/p01-3-handoff.md](docs/p01-3-handoff.md)：P01-3 可复用的项目/配置/CAS/制品端口、受控文件定位边界与待定组合根。

该验收仅限 P01-2 存储与制品落盘，不代表 P01 阶段验收或任何业务 Live 验收通过。

### 单向依赖规则（F-004 起自动强制）

工程包之间为**单向依赖**，由 `scripts/check-boundaries.ts`（`npm run check:boundaries`，并经 `npm test` 中的回归套件执行）自动强制；任何违规或无法解析的生产导入都使退出码为 1，诊断包含违规文件（含行号）与目标模块：

- **Host 可依赖 Core 公共入口**（仅经包名 `shiploop-core` 的 `exports`，不导入 Core 内部实现文件）。
- **CLI 只在需要时依赖 Host 公共客户端或契约**；**不导入 Host 启动入口**或 Core 实现，不绕过 Host 直读 SQLite，也不绕过 Host 直接依赖 Core。
- **Core 不反向依赖** Host/CLI；Core 契约区（domain/application/ports/公共入口）不导入或重导出 Pi SDK、Electron、HTTP 框架、`better-sqlite3`、Drizzle 或 `node:http`/`node:net`；better-sqlite3 与 Drizzle 只允许出现在 `adapters` 层及装配入口（P01-2 F-001 起在 `shiploop-core` 适配层以精确版本固定安装）。
- 没有实际使用的依赖不为占位而添加；当前仅 `shiploop-core` 持有运行时依赖（better-sqlite3@13.0.3、drizzle-orm@0.45.3，适配层装配使用，另有 @types/better-sqlite3 开发依赖），Host/CLI 无任何依赖；根工作区只持有开发工具（typescript、@types/node、vitest）。

检查器同时强制的其余边界：

- **扫描范围明确**：只读取根 `package.json` 的 workspaces 与各包清单，扫描 `packages/*/src/**/*.ts` 生产源码（排除 `node_modules`/`dist`/`*.d.ts`）；`test/`、`scripts/` 与测试夹具不在扫描范围内。覆盖静态 `import`/`export from`（含 type-only）、副作用 import、字面量 dynamic `import()` 与字面量 `require()`；非字面量 `import()`/`require()` 直接报错；注释与字符串字面量中的导入文本不误判。
- **禁止跨包内部导入**：另一工作区包的子路径（如 `shiploop-core/src/...`）、逃逸出本包 `src` 根的相对路径，以及逃逸的已声明路径别名（`package.json` 的 `imports`、`tsconfig.json` 的 `paths`）一律拒绝；自包名引用同样拒绝。无法解析的生产导入（缺目标文件、未声明别名、未声明且不可解析的包名）明确报错，不默认为合法。
- **禁止反向依赖与循环依赖**：清单依赖与源码导入共同构成依赖图，Core→Host/CLI、Host→CLI、CLI→Core 及任何环形引用均被拒绝（如 Host↔CLI 循环会同时报出方向违规与 `dependency-cycle`）。
- **Core 分层方向**：`domain` 仅可自引用；`ports` 可导入 `domain`；`application` 可导入 `domain`/`ports`；`adapters` 可导入 `domain`/`application`/`ports`；公共入口与契约区（domain/application/ports）禁止导入 `adapters` 实现，也禁止绑定 Pi SDK、Electron、HTTP 框架、`better-sqlite3`、Drizzle 与 `node:http`/`node:https`/`node:net`/`node:dgram`；`adapters` 层对 `ports`/`domain` 类型、已声明第三方依赖与 Node 内置模块的合法引用不被误拒。
- 正反夹具回归见 `test/boundary-check.test.ts`：合法单向依赖返回 0；注入 Core→Host/CLI 反向引用、Host↔CLI 循环、跨包内部导入、别名逃逸、契约区基础设施导入、分层方向违规等夹具均断言拒绝结果，且检查器在真实子进程中对本仓库返回 0。

类型系统上，根 `tsconfig.json` 以 `noEmit` 统一覆盖 `test/**/*.ts`、`scripts/**/*.ts` 与三个包的 `src/**/*.ts`；各包自己的 `tsconfig.json`（`composite`、`rootDir: src`、`outDir: dist`）只负责产物构建。

## 常用命令

```bash
npm ci             # 按 package-lock.json 干净安装
npm test           # 启动器校验本地 vitest@5.0.3 后一次性执行全部测试，失败返回非零；无需先手工构建
npm run typecheck  # 严格类型检查（strict），覆盖 vitest.config.ts、源码、测试（含 helpers）与 scripts/，不产出文件
npm run build      # tsc -b 构建三个包到各自 dist，并运行构建入口冒烟脚本
npm run check:boundaries  # 工作区单向依赖与 Core 分层边界检查（fail-closed），合法返回 0
npm run verify     # 工程检查编排：锁文件预检 + npm test / typecheck / build 全绿才返回 0
```

测试夹具与子进程只使用系统临时目录和重定向后的 HOME / XDG / TMPDIR，不读写用户仓库之外的用户数据、凭据或全局 Pi 配置，也不调用真实模型；重复运行互不依赖，不留下临时文件或受测子进程。

在没有 `dist` 与类型缓存的干净临时副本中，`typecheck` 与 `build` 均须返回 0；注入明确类型错误时 `typecheck` 返回非零。`npm run verify`（F-005）把锁文件预检与上述检查串成单一 fail-closed 入口，用于干净副本的集成验收。

## Pi SDK 接入基线（本任务不接入）

- 前期验证依据：设计文档 `core-design/05-runtime-and-session-recording.md` 与 `core-design/09-testing-and-implementation.md` 记录的 2026-09-30 / 2026-10-01 macOS 实验，使用 **Pi Node SDK 0.84.2**（S1–S5：事件、工具、取消、存档、资源清单、Token 口径、凭据与进程组清理边界）。
- 结论基线：Pi 默认工具不具备强 OS 沙箱，首版按用户明确授权的可信项目模式推进；Runner 强杀后的进程组停止核验须在 Host 监督逻辑中实现。
- 本任务**不安装、不调用 Pi SDK**；正式接入时需在 adapter 层重新核验当时的 SDK 能力、套餐与认证政策，并锁定精确版本。
- SQLite / better-sqlite3 / Drizzle 自 P01-2 / F-001 起已按上述设计基线在 Core 适配层固定引入（仅驱动与 ORM 装配，不含业务持久化 Schema、迁移或 StateStore 实现）。

## 非目标

- 不发布任何 npm 包，不修改既有 `LICENSE`。
- 不依赖 Nezha 仓库、Harness 目录、用户模型凭据即可安装与测试。
- 源码、清单与锁文件不得包含开发机绝对路径或凭据。
