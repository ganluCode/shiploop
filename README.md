# ShipLoop 工程工作区

P01-1 工程骨架 + P01-2 SQLite 原子存储与制品落盘 + P01-3 项目身份与当前配置服务：npm workspaces、固定工具链、严格 TypeScript 构建、确定性测试入口，以及可独立调用的 Core 应用服务（项目注册/查询/CAS 编辑/标签筛选、当前配置 CAS/有效合并/脱敏导出、受权路径定位）。Host 网络接口、CLI 命令、Runtime/模型执行、执行表与 DAG 调度仍在后续 Feature 中建设；入口模块加载无副作用，不提供空壳的项目、调度、存储或 Runtime 服务。

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
packages/cli    shiploop-cli    CLI（F-011 Host 生命周期纯解析/帮助/JSON/退出码面层；F-012 执行层与 shiploop bin 纵向命令）
test/           仓库级确定性测试（*.test.{js,ts}）与夹具（test/helpers，不收集为用例）
scripts/        工程检查脚本（TypeScript，受 typecheck 覆盖）：run-tests.ts（测试启动器）、
                smoke-built-entries.ts（构建入口冒烟）、check-boundaries.ts（依赖边界检查）、
                verify.ts（fail-closed 工程检查编排，见下节）、
                acceptance/（P01 阶段验收：p01-accept.ts 控制器、p01-report.ts 报告、
                build-artifact-scan.ts 可发布产物路径/依赖/迁移扫描）
vitest.config.ts 确定性测试配置（一次性、fail-closed）
docs/acceptance/  P01-1 / P01-2 / P01-3 验收报告与脱敏证据（见下文「集成验收报告」「P01-2 存储与制品」「P01-3 项目身份与当前配置」）
docs/storage-operations.md  P01-2 存储操作与恢复说明（F-014）
docs/p01-3-application-contract.md  P01-3 Core 应用契约与范围说明（F-001）
docs/p01-3-operations.md   P01-3 项目身份与当前配置操作说明（F-014）
docs/p01-3-handoff.md       P01-2 → P01-3 接口交接（P01-2 F-014）
docs/p01-4-handoff.md       P01-3 → P01-4 / P02 接口交接（P01-3 F-014）
docs/p02-1-host-lifecycle-contract.md  P02-1 Host 单例发现与本机认证生命周期契约（F-001）
docs/p02-1-operations.md  P02-1 Host 生命周期操作说明（F-014）
docs/p02-1-handoff.md  P02-1 → P02-2 接口交接（P02-1 F-014）
docs/acceptance/p02-1-f014-report.md  P02-1 Feature 交付报告（F-014，证据在同目录 evidence-p02-1/）
docs/p02-2-commands-events-contract.md  P02-2 应用命令、查询与事件接口契约（F-001，实施前置契约；路由/回执/事件/SSE 尚待后续任务实现）
```

### 确定性测试约定（F-003）

`npm test` 实际执行 `node scripts/run-tests.ts`，该启动器 fail-closed：

- 只从本仓库工作区安装解析 `vitest/package.json`（经 `createRequire` 从脚本位置向上查找），**不使用 PATH 全局 vitest，也不通过 npx 临时下载**；
- 校验包名 `vitest` 与精确版本 `5.0.3`，工具缺失、身份不符或版本不符时以退出码 1 失败，输出包含工具名、要求版本与 `npm ci` 修复提示；
- 始终以 `run`（一次性、非 watch）模式 spawn 真实 vitest，透传额外参数，原样继承 stdio，传播退出码；信号退出、超时或进程错误一律非零。

`vitest.config.ts` 固定确定性语义：`watch: false`、`passWithNoTests: false`（找不到真实测试文件即失败）、`cache: false`、`pool: 'forks'`、不随机序、有限的用例/钩子超时、`coverage.enabled: false`；只收集 `test/` 下的真实用例，`test/helpers` 与 `test/fixtures` 显式排除。没有静默 skip、空断言或“未运行即通过”的配置。

临时资源统一经 `test/helpers/temp-sandbox.ts` 创建：每次在系统临时目录 `mkdtemp` 全新目录（拒绝落在受测仓库或用户 HOME 之内），`cleanup()` 递归删除并核验消失；`withTempSandbox()` 以 try/finally 保证回调抛错时同样清理。夹具包含中文多字节内容的 UTF-8 逐字节往返断言（无 BOM、无换行转换）。

`test/deterministic-test-harness.test.ts` 以**真实子进程**（非 mock）回归：空测试集非零、注入失败断言非零、临时项目正向对照为零、`--version` 报出 `vitest/5.0.3`、工具缺失启动器非零且报出身份；子进程带有限超时并在结束后回收，不留下常驻进程。测试不依赖预存 `dist`（任何用例都不得导入三个工作区包名），干净 `npm ci` 后无需先构建即可 `npm test`；F-004 锁测试会显式编译原生锁适配器，需下述 macOS 构建工具。

Core 源码按设计 `core-design/01-system-structure.md` 分层，目录边界由各目录下的 `README.md` 明确（拥有、允许、禁止），F-002 阶段只有无副作用的公共入口 `src/index.ts`：

```text
packages/core/src/
  domain/        状态规则、策略与值类型
  application/   命令、查询、执行编排
  ports/         StateStore、Runtime、凭据等窄接口
  adapters/      sqlite、文件、git、pi 的具体实现（P01-2 F-001 起：sqlite/connection.ts 驱动装配 + 固定版本驱动/ORM；其余为空，不预置空壳）
packages/host/src/index.ts   Host 公共入口：F-002 契约、F-003 存储、F-004 直接持 fd 的真实 OS 锁、F-006 启动装配、F-007 认证传输面、F-008 stop/quiesce 控制器、F-009 HostClient、F-010 连接或启动启动器（import 无副作用）
packages/host/src/contract/  P02-1 协议契约：发现/握手/status/stop 校验、身份与摘要纯函数、结构化错误（仅依赖 node:crypto）
packages/host/src/storage/   P02-1 受保护文件存储：规范根 realpath 固定与身份、host/ 0700 与发现/凭据 0600、fail-closed 权限/符号链接核验、原子发现发布、按实例清理（仅用 node:fs/crypto/path，不触碰网络与进程）
packages/host/src/locking/   macOS flock 与写入生命周期包装（显式调用才获锁，关闭失败保锁；无持锁辅助进程）
packages/host/src/runtime/   F-006 启动装配（startHost：获锁→开 Core/Schema→127.0.0.1:0 监听→新实例/凭据→原子发现）与受控 argv 入口逻辑；F-007 认证传输面（http-transport.ts：握手/status 路由、Bearer/Host/Origin 校验、16 KiB 上限、有界超时、脱敏错误）；F-008 停止控制器（host-stop.ts：§10.2 门控、§10.4 幂等矩阵、§10.5 收尾、§10.7 信号收尾）；允许 node:http 与 shiploop-core 公共入口，import 无副作用
packages/host/src/client/    F-009 HostClient（connectToHost/probeDiscoveredHost）：受保护发现/凭据读取 → 握手双向核验后才允许 status/stop；不跟重定向、§14 错误精确分类、close 只释放本地资源（允许 node:http 回环与 node:crypto，不触文件系统/进程/argv）
packages/host/src/launcher/  F-010 连接或启动编排（ensureHostRunning）：先发现→握手，无实例才以独立 argv spawn detached 正式入口候选，预算内轮询重新发现胜者；落选/失败候选有界回收核验，owner_active/owner_unknown 诊断（允许 node:child_process/os/url/path/timers，不触文件系统/网络直连/argv/SQLite）
packages/host/src/start.ts   F-006 显式启动入口 → dist/start.js（node …/dist/start.js --data-root <abs>；握手/status 认证路由 F-007 已生效，stop 与 SIGTERM 安全收尾 F-008 已接线）
packages/host/native/        极小 N-API C 适配器，显式构建输出 dist/native/writer-lock.node
packages/cli/src/index.ts    CLI 公共入口（F-011：re-export src/host/ 纯面层；加载不解析 argv、不读 env、不发请求；不 re-export F-012 执行层）
packages/cli/src/host/        F-011 纯面层 args.ts/help.ts/output.ts（参数解析、帮助、§13.3 JSON 信封与四档退出码）；F-012 执行层 execute.ts（runHostCli：start 接启动器、status/stop 接 HostClient、§10.6 三证据停止确认；允许 node:os/node:timers，HTTP/spawn/fs 能力只经 shiploop-host 公共面）
packages/cli/src/bin.ts       F-012 唯一显式可执行入口（shebang → dist/bin.js，package.json bin: shiploop）；唯一读 process.argv/env 与退出进程的文件
```

各包 `package.json` 的 `main` / `types` / `exports['.']` 均指向 `dist` 构建产物；`npm run build` 通过 `tsc -b` 为三个包各自生成 `dist/index.js` 与 `dist/index.d.ts`（含 sourcemap 与增量构建信息）。tsc 之后 `scripts/prepare-cli-bin.ts` 校验 `packages/cli/dist/bin.js` 的 shebang 与 package.json `bin` 字段并置可执行位 0755。构建结束后执行 `scripts/smoke-built-entries.ts`：在独立 Node 子进程中加载三个入口（5 秒超时），并将 `HOME` / XDG 目录 / cwd 重定向到系统临时目录沙箱，断言退出码 0、非常驻、不写用户数据、产物与声明文件存在；其中 Core 的 `./assembly` 入口还会在非源码 cwd 下执行「注册项目 → 全局/项目配置 → 发布固定正文制品 → 关闭重开逐字段核验正文」闭环（`scripts/core-assembly-smoke.mjs`），CLI 的 `dist/bin.js` 会在临时数据根真实跑通 start/第二次 start/status/stop/重启纵向命令（断言回环地址、实例身份、退出码、CLI 退出后 Host 存活、§10.6 停止证据与输出不泄密）。P01 阶段验收检查 `P01-ENG-BUILD-SMOKE` 由 `test/p01-4-build-smoke.test.ts` 承接：把 Core 真实编译到临时目录（不写受测仓库），运行上述冒烟并扫描可发布构建文件/入口/依赖清单/配置，拒绝固定个人绝对路径、Nezha/供应商 SDK 运行依赖与缺失的已编译迁移资源；运行时合法的临时仓库 canonicalPath 不会被误判。

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

### P01-3 项目身份与当前配置（F-014）

P01-3 在 macOS（arm64，Node 22.19.0 / npm 10.9.3 / SQLite 3.53.4 / better-sqlite3 13.0.3 / drizzle-orm 0.45.3）上交付可独立调用的 Core 应用服务：仓库注册与幂等复用（稳定 `projectId` + 规范 `canonicalPath`）、项目元数据 CAS 编辑与标签筛选/计数、全局/项目当前配置的 insert-only 创建与 CAS 更新、有效配置合并与逐项来源、脱敏导出、统一 `PathService` 受权定位；迁移 v2 新增 `state_events` 脱敏审计。干净快照六条命令（`npm ci` / `npm test` / `npm run typecheck` / `npm run build` / `npm run verify` / dist 非源码 cwd 装配闭环）真实退出码全部为 0。

- [docs/p01-3-application-contract.md](docs/p01-3-application-contract.md)：P01-3 Core 应用契约、配置语义、存储最小扩展、范围边界与待核对的设计张力。
- [docs/p01-3-operations.md](docs/p01-3-operations.md)：项目身份（注册/重复结果、仓库支持范围、标签规则/筛选/计数）、当前配置（scope/schemaVersion/revision、首次写入与 CAS、完整策略覆盖/来源、凭据引用）、`PathService` 稳定 namespace 与最小可运行示例。
- [docs/acceptance/p01-3-f014-report.md](docs/acceptance/p01-3-f014-report.md)：输入文档版本、受测 commit、命令与退出码、FR 分支映射、已建表/迁移、已知缺口与 `not_run`（证据在同目录 `evidence-p01-3/`，已脱敏）。
- [docs/p01-4-handoff.md](docs/p01-4-handoff.md)：P01-4 可复跑持久化闭环与失败注入入口、P02 可包装的命令/查询契约及明确未交付边界。

该验收仅限 P01-3 项目身份与当前配置服务，不代表 P01 阶段验收或任何业务 Live 验收通过；阶段最终报告与 `accept:p01` 由 P01-4 交付。

### P01-4 P01 持久化闭环阶段验收（F-010）

P01-4 在 macOS 干净源码快照中交付 P01 阶段验收：`npm ci` 后真实运行 `npm test`（45 files / 792 tests）/ `npm run typecheck` / `npm run build` / `npm run verify` / `npm run accept:p01`（连续两次），七条命令退出码均为 0；两次 `accept:p01` 结论均为 `pass`（`pass 14 / fail 0 / not_run 0`），生成独立 `artifacts/acceptance/p01/<run-id>/` 报告与证据。干净快照复跑发现并修复了 F-002 安全清理测试对受测仓库位置的隐式依赖（仓库根位于临时目录内时 `not_authorized`/`symlink_escape` 断言失效）。

- [docs/p01-4-acceptance-contract.md](docs/p01-4-acceptance-contract.md)：P01-4 验收契约、14 个稳定必需检查 ID、FR 分支映射与报告/证据约定。
- [docs/p01-4-operations.md](docs/p01-4-operations.md)：验收命令、配置与报告位置、结果三态与负例双断言、临时资源安全边界、干净复跑与失败复跑步骤、实际 Core 调用范围、T03/T24/T26/T32 子集。
- [docs/acceptance/p01-4-f010-report.md](docs/acceptance/p01-4-f010-report.md)：受测 commit、干净复跑命令/退出码/耗时、两次 accept 报告位置与结论、前序回归修复、已知缺口与 `not_run`（证据在同目录 `evidence-p01-4/`，已脱敏）。

该验收仅限 P01 持久化闭环（FR-1/FR-2 子集）；Host/CLI、Runtime/Pi SDK、执行表与 DAG、强 OS 沙箱、非 macOS 平台均 `not_run`/未支持，不计入 P01 必需项通过数。

### P02-1 Host 单例发现与本机认证（F-001，契约先行）

P01 已由项目负责人于 2026-10-05 阶段放行（依据见 [docs/acceptance/p01-review-results.md](docs/acceptance/p01-review-results.md)，放行基线 `5a43a04`，受测产品 commit `0e96535`）。P02-1 开工首项只交付**生命周期接口契约**，不含实现：

- [docs/p02-1-host-lifecycle-contract.md](docs/p02-1-host-lifecycle-contract.md)：P01 基线与放行依据核对、规范数据根与 `dataRootIdentity` 算法、受保护发现/凭据/锁布局、发现 Schema、`/v1/host/handshake|status|stop` 协议、版本化 stop 幂等矩阵、Host 生命周期状态机、HostClient/启动器规则、CLI `host start/status/stop` 参数与四档退出码、错误码总表、FR/T 编号映射（含 T26 编号不一致核对请求）与明确非目标。F-002 ~ F-014 共用此契约，不各自定义协议。
- 文档守护测试：`test/docs-p02-1-host-lifecycle-contract.test.ts`（冻结事实与仓库基线一致性）。
- F-004 已交付 [macOS 写入锁决定与装配交接](docs/p02-1-writer-lock.md)：实际 Node
  写入者直接持 flock fd，无辅助者；有界获取、获锁后打开 Core 的工厂端口、关闭失败保锁。
  `npm run build` 先显式编译极小 N-API 模块；要求 `/usr/bin/clang`、macOS SDK
  （Xcode Command Line Tools）与当前 Node 安装的 `include/node/node_api.h`。不新增 npm
  依赖，不运行时编译；缺失原生模块/未知平台明确拒绝。真实测试覆盖同步 Core 竞争、
  别名/独立根、实际写入者 SIGKILL/SIGABRT、锁文件安全、有限 owner 探测和关闭/清理失败。
  Host 启动、HTTP 认证/CLI/Work 仍未实现，不声明 P02 通过。
- F-005 交付 Host/CLI **测试夹具套件**（`test/helpers/host/`，自测 `test/host-fixture-kit.test.ts`，26 项；不进 packages/、不被 vitest 收集为用例）：
  - `isolated-environment`：复用 temp-sandbox，沙箱内独立 home/tmp/data 与经 `resolveCanonicalDataRoot` 固定的数据根；子进程 env 为显式白名单（只透传 PATH，HOME/TMPDIR 重定向）；dispose 按「伪服务 → 受管进程 → 沙箱目录」顺序回收并核验。
- F-006 交付 **Host 启动装配与显式入口**（`packages/host/src/runtime/` + `src/start.ts`，回归 `test/host-startup.test.ts`，45 项）：
  - 顺序：选项/env/argv 监听覆盖零容忍（`bind_address_override_rejected`）→ 平台检查 → 规范根 → OS 锁 → openCoreApplication（含 Schema 检查，未知高版本拒写并释锁）→ 127.0.0.1:0 监听并核验套接字地址 → 新 hostInstanceId + 新凭据 → 原子发现发布 → ready；失败按逆序关闭并释锁，不发布 ready。
  - host 包按契约 §13.4 声明 `"shiploop-core": "0.0.0"`（经包名与 `./assembly` 公共入口）；干净树（无 dist）下 `npm test`/`npm run typecheck` 由根 tsconfig paths、vitest alias 与测试子进程加载器的精确映射保障；边界检查放行 exports 声明的公共子路径入口，未声明内部子路径仍违规。
  - 生产入口注入空能力目录，不装配 Pi/模型执行。构建冒烟 `scripts/smoke-built-entries.ts` 从 dist、非源码 cwd 真实启动 Host：断言回环监听/发现一致/凭据不外泄、SIGKILL 后释锁且重启换新实例与凭据、`--bind` 覆盖以退出码 2 拒绝且零副作用。
  - `managed-child` + `fixture-child`：真实 Node 子进程 ready/go IPC 屏障、有界等待、真实 127.0.0.1 监听地址采集；标准场景 ready-listen / never-ready / early-exit(7) / wrong-pid-ready / crash-after-go(SIGKILL) / ignore-sigterm；回收只针对 spawn 句柄的真实 pid，IPC close→SIGTERM→SIGKILL 升级后仍无法核验退出即 `exit_unconfirmed`，绝不把无法探测当停止。
  - `fake-host-server` + `http-probe`：真实回环伪 Host，可编排错误/缺失 token、旧实例、错误协议/schema/数据根、非法生命周期状态、能力撒谎、畸形 JSON、3xx 重定向（探针绝不跟随）、stop 重放；`discovery-fixture` 经生产 `createHostFileStore` 发行 0700/0600 伪凭据与发现。
  - `evidence`：证据仅记录 PID/实例/状态/退出码/路由等非秘密字段；Authorization 头只保留 `bearer/absent/other-scheme` 分类，登记秘密与真实 HOME/仓库路径做深度扫描，违例即 fail-closed，认证头与 token 正文不进证据。
- F-007 交付 **Host 认证握手与状态查询传输面**（`packages/host/src/runtime/http-transport.ts`，回归 `test/host-http-transport.test.ts`，29 项）：
  - 真实生命周期路由替换 F-006 的 404 占位监听器：握手按契约 §8 冻结顺序（传输层 → 结构 → 凭据 → schema/协议版本 → 实例 → 数据根）返回真实实例/生命周期/冻结能力；status 只读零副作用（不写库、不改文件、不触发 quiesce），确认同一实例存活。
  - Bearer timingSafeEqual 认证（缺失/错误/陈旧 token 不可区分 401）；Host 头恰为 `127.0.0.1:<实际端口>`、任何 Origin 拒绝、无 Origin 的合法 CLI 请求可通过；凭据只经受保护文件与认证头传递，不进 URL/响应/日志。
  - 畸形 JSON（400 不回显原文）、16 KiB 超限（413）、GET 带体（400）、未知路由（404）、方法不允许（405 + 允许方法）、POST content-type 核验；服务端 `headersTimeout` 5 s / `requestTimeout` 15 s 有界常量、每响应 `connection: close`、无 CORS 头、永不含 3xx。
  - stop 路由在 F-008 接线前经完整传输与认证校验后返回 501 unsupported，绝不触发停止/文件删除/数据库写入；负例矩阵执行后发现/凭据/数据库/锁文件逐字节不变。
- F-008 交付 **显式 stop 的 quiesce/幂等/收尾与信号安全收尾**（`packages/host/src/runtime/host-stop.ts`，回归 `test/host-stop-lifecycle.test.ts`，18 项）：
  - §10.2 窄活动门控端口（仅 enterQuiesce/awaitQuiesce 两方法）与生产恒空闲门控；停止控制器编排 §10.4 幂等矩阵与 §10.5 关闭顺序：ready → quiescing →（恒空闲立即确认）→ stopping（关 listener）→ 关 Core → 持锁按实例清理发现/凭据 → 200 最终视图（completed/stopping，不等于进程已退出）→ 释锁 → 退出码 0。
  - 同 commandId 同摘要重放返回同一结果/进度（replayed:true，不重复 enterQuiesce/关闭）；同 ID 不同摘要 409 conflict（控制器级；v1 选项空间下经传输层不可达，传输层先以 400 重算核对拒绝）；quiescing 中另一 commandId 409 stop_in_progress；starting 503 not_ready；错误实例 409、摘要篡改 400、未实现停止能力 501（supportedModes 明示），全部零副作用。
  - quiesce 未确认（真实受管子进程充当活动 + 注入 300ms 预算）→ 409 quiesce_not_confirmed：Host 保持 quiescing、发现/凭据不变、竞争者真实获锁尝试 owner_unknown（无第二写入者）；活动收尾后同命令重提续跑成功（replayed:true）。收尾/清理失败按未确认处理并保锁。
  - 客户端断开/退出不触发 stop；stop 途中断开不阻断收尾（响应送达失败不改变语义），完成判据只看进程退出+锁释放+发现清理；SIGTERM 真实子进程安全收尾（exit 0 + 按实例清理 + 释锁，`dist/start.js` 与测试子进程经 `wireHostSignalShutdown` 装配）；HTTP stop 与信号并发只跑一次收尾。
  - `startHost` 新增受信注入 `activityGate`/`quiesceBudgetMs`（有界，绝非 argv/env/发现字段）；生产默认恒空闲门控，不新增执行表、不虚构取消能力。
- F-009 交付 **CLI 可复用 HostClient**（`packages/host/src/client/`，回归 `test/host-client.test.ts`，26 项）：
  - `connectToHost`：选项纯校验（零 I/O）→ F-003 受保护存储 fail-closed 读取发现/凭据 → 只连接发现指向的 127.0.0.1 固定端口 → 握手双向核验（§12.2）通过后才允许 status/stop；握手失败不另起写入者、不绕过锁。
  - 错误按 §14 精确分类且互不折算：host_not_found / unsafe_discovery / invalid_discovery / unreachable（连接失败/连接超时/请求超时/断连子原因）/ unauthorized / protocol_incompatible / instance_mismatch / data_root_mismatch / redirect_rejected（绝不跟随 3xx，不向新地址重发凭据）/ response_malformed（含响应超 16 KiB 上限）。服务端错误响应只信任白名单错误码与受控 details 键，不透传服务端文案。
  - §7.2 有限预算：TCP 连接 2s、握手/status 10s、stop 15s（覆盖仅允许区间内有限值）；`close()` 幂等、只释放本地观察资源、绝不调用 stop，Host 存活由另一客户端认证 status 证明（有真实用例）。
  - `probeDiscoveredHost` 为只做一次握手核验的窄探测，供 F-010 启动器 owner 诊断与 F-004 ownerProbe 真实实现复用；真实 Host 端到端用例覆盖「发现→握手→status→stop→外部三证据」。
- F-010 交付 **CLI 的连接或启动流程与独立后台 Host 启动器**（`packages/host/src/launcher/`，回归 `test/host-launcher.test.ts`，34 项）：
  - `ensureHostRunning`（契约 §12.4）：先「发现→握手」——有效既有实例直接返回同一 hostInstanceId（already_running，不启动进程）；仅 host_not_found/unreachable/invalid_discovery 允许继续启动，认证/协议/假服务/不安全发现一律返回对应诊断（不另起写入者）。
  - 启动只经正式 Host 入口：独立 argv 数组 spawn（nodeExecutable + entryArgv + `--data-root` 规范根；不经 shell、不拼接），候选 detached + stdio ignore + unref，子进程 env 默认白名单 PATH/HOME/TMPDIR（注入 env 含 SHIPLOOP_HOST_* 覆盖即 bind_address_override_rejected）；启动器自身不打开 SQLite。
  - 预算内轮询重新发现胜者（默认 15 000 ms 预算 / 100 ms 间隔）；成功路径核对「候选即所连实例」（发现 hostInstanceId 与 pid 同时匹配），落选候选由启动器 SIGTERM→SIGKILL 有界回收并核验退出；失败路径先回收候选再做锁所有者诊断（probeDiscoveredHost 经 F-004 ownerProbe，获锁即释、不开 Core）→ owner_active/owner_unknown/start_candidate_failed(internal)/start_timeout，任何失败路径不留未管理进程。
  - 真实多进程用例：两启动器竞争同一胜者实例、陈旧发现（死端口 + 陈旧 PID 指向无关活进程，原子替换且无关进程存活）、锁被占+发现损坏 owner_unknown（不绕过锁/不覆盖损坏文件/原 Host 仍可认证）、客户端正常退出与启动中途被 SIGKILL 后 Host 仍存活并可被另一客户端认证停止。
- F-011 交付 **Host 生命周期 CLI 纯面层**（`packages/cli/src/host/`，回归 `test/host-cli-args.test.ts`，127 项；解析与执行分离，127 项表驱动正反例）：
  - `parseHostCliArgs`（§13.1/§13.2）：仅识别 `host start/status/stop`；同步纯函数，env 必须显式注入（不读 process.argv/env、不读发现、不联网、不启动 Host、不生成 stop commandId）。相对/空/NUL/`/` 数据根、未知参数、缺值、非整数/越界预算、错误命令参数、重复参数、位置参数、非 UUID v4 commandId、`--bind/--host/--address/--port/--listen*` 参数与非空 `SHIPLOOP_HOST_*` env 覆盖全部在任何 I/O 之前拒绝（退出码 2，覆盖值不回显）。默认 start 15 000（1 000..60 000）、confirm 10 000（0..30 000）。
  - `getHostCliHelp`：top/host/start/status/stop 五个作用域，准确说明退出客户端不停止 Host、显式 `host stop` 语义、stop 回执不等于已退出、status 不启动 Host、首版仅 macOS 与可信本机边界、token 不防同一操作系统用户恶意进程；不含 token 样例与开发机路径。
  - §13.3 JSON 成功/失败信封与 `exitCodeForHostErrorCode`：错误码穷尽映射 1/2/3（2＝输入/本地不安全发现/监听覆盖；3＝连接/协议；其余与未知码 fail-closed →1）。CLI 包声明且仅声明 `"shiploop-host": "0.0.0"`（只经包名公共面复用 isUuidV4/错误码表/env 覆盖键表/启动预算常量）。
- F-012 交付 **可运行的 start/status/stop 纵向命令**（执行层 `packages/cli/src/host/execute.ts` 的 `runHostCli`，回归 `test/host-cli-execute.test.ts`，17 项；显式入口 `src/bin.ts` → `dist/bin.js`，package.json `bin: { "shiploop": "./dist/bin.js" }`，构建经 `scripts/prepare-cli-bin.ts` 校验 shebang 并置 0755）：
  - `host start` 只经 `ensureHostRunning` 连接或启动（成功结果含 outcome `already_running`/`started` 与握手核验的实例/回环端口/状态；两次 start 同一实例，CLI 退出后 Host 存活）；`host status`/`host stop` 经 launcher 新增的 `resolveConnectDataRoot`（`createIfMissing=false`）与 `connectToHost` 只读连接，**永不**启动 Host（无实例 host_not_found 退出码 3，不创建数据根）。
  - `host stop` 省略 commandId 时由 HostClient 生成 UUID v4；HTTP accepted/completed 回执不当已退出——在 `--confirm-timeout-ms`（默认 10 000，0..30 000）预算内轮询 §10.6 三证据（进程 ESRCH、非阻塞 flock 获锁即释、发现删除或实例替换），齐备才输出 `stopped`（退出码 0），否则 `stop_not_confirmed`（退出码 1，details 只含受控枚举）。
  - 公共 barrel（`src/index.ts`、`src/host/index.ts`）不 re-export 执行层，加载仍无副作用；执行层只导入 `shiploop-host` 包名公共面与 `node:os`/`node:timers`，不直连 Core、不直接使用 HTTP/child_process/fs。构建冒烟在非源码 cwd 用临时数据根真实跑通 start/start/status/stop/重启，断言监听地址、实例身份、退出码、Host 存活与停止后锁可获，且全部输出不含 token。
- F-013 交付 **整 Feature 真实多进程集成回归**（`test/p02-1-integration-regression.test.ts`，29 项；CLI 驱动子进程夹具 `test/helpers/host/cli-driver-child.ts` 以 ready/go 同步屏障在独立真实子进程中运行生产 `runHostCli`；产品源码/依赖/构建脚本零改动）：
  - FR-1：两/三 CLI 同步屏障竞争唯一持锁 Host（各成功连接同一实例、失败候选进程 OS 核验退出、CLI 退出后 Host 存活）、规范路径别名同锁、独立数据根双 Host 并存、陈旧 PID 指向无关活进程、持锁但发现缺失/损坏（owner_unknown 不产生第二写入者）、崩溃后重新发现、旧清理迟到不删新实例文件、公开监听覆盖（argv/env × 0.0.0.0/::/非回环 IP/域名）退出码 2。
  - FR-2：token 第三方篡改 unauthorized、假服务与真 Host HTTP 负例矩阵（协议 426/实例与数据根 409/Origin 与伪造 Host 401/302）零文件副作用、不安全发现权限 unsafe_discovery、同 commandId 停止进行中重放（enterQuiesce 恰一次）、quiesce 未确认保留锁且 CLI 竞争者不产生第二写入者、合法 stop 三证据→重启新实例→重开 Core 前序持久数据未损坏且旧身份/token 被拒绝。
  - 脱敏证据映射与 not_run 记录：[docs/acceptance/evidence-p02-1/f013-regression-evidence.md](docs/acceptance/evidence-p02-1/f013-regression-evidence.md)（文档守护核对；不声称项目接入、执行取消或整个 P02 已验收）。
- F-014 交付 **P02-1 操作说明、Feature 交付报告与接口交接**（仅文档与文档守护测试，不改变受测产品代码）：
  - [docs/p02-1-operations.md](docs/p02-1-operations.md)：`host start|status|stop` 真实构建入口
    `packages/cli/dist/bin.js` 与参数/默认值/退出码、临时数据根可复跑示例、发现/凭据/锁布局与
    权限、停止三证据与 `stop_not_confirmed`/`owner_unknown` 诊断、证据获取与脱敏、可信本机/
    同用户攻击/macOS 边界、未实现 `not_run`。
  - [docs/p02-1-handoff.md](docs/p02-1-handoff.md)：`shiploop-host` 公共面（`connectToHost`/
    `ensureHostRunning`/`acquireWriterLock`/`openLockedWriter`/`createHostFileStore`/`runHostCli`）、
    锁持有要求与装配顺序、组合根/单向依赖、待实现能力与 Harness 验证策略交接。
  - [docs/acceptance/p02-1-f014-report.md](docs/acceptance/p02-1-f014-report.md)：受测 commit
    `8473f30…`、命令与退出码、FR/T 子集、安全说明、已知缺口与 `not_run`、结论（证据
    [docs/acceptance/evidence-p02-1/](docs/acceptance/evidence-p02-1/)，已脱敏）。
  - 文档守护 [test/docs-p02-1-operations.test.ts](test/docs-p02-1-operations.test.ts)：在真实临时
    数据根与真实 Host 子进程上跑通操作说明纵向命令，并交叉核对命令/参数/默认值/退出码；
    `npm run verify`（test/typecheck/build）仍 `PASS 3/3`。不提供 `accept:p02`。

### 单向依赖规则（F-004 起自动强制）

工程包之间为**单向依赖**，由 `scripts/check-boundaries.ts`（`npm run check:boundaries`，并经 `npm test` 中的回归套件执行）自动强制；任何违规或无法解析的生产导入都使退出码为 1，诊断包含违规文件（含行号）与目标模块：

- **Host 可依赖 Core 公共入口**（仅经包名 `shiploop-core` 的 `exports`，不导入 Core 内部实现文件）。
- **CLI 只在需要时依赖 Host 公共客户端或契约**；**不导入 Host 启动入口**或 Core 实现，不绕过 Host 直读 SQLite，也不绕过 Host 直接依赖 Core。
- **Core 不反向依赖** Host/CLI；Core 契约区（domain/application/ports/公共入口）不导入或重导出 Pi SDK、Electron、HTTP 框架、`better-sqlite3`、Drizzle 或 `node:http`/`node:net`；better-sqlite3 与 Drizzle 只允许出现在 `adapters` 层及装配入口（P01-2 F-001 起在 `shiploop-core` 适配层以精确版本固定安装）。
- 没有实际使用的依赖不为占位而添加；当前 `shiploop-core` 持有运行时依赖（better-sqlite3@13.0.3、drizzle-orm@0.45.3，适配层装配使用，另有 @types/better-sqlite3 开发依赖），`shiploop-host` 工作区依赖 `shiploop-core@0.0.0`，`shiploop-cli` 工作区依赖 `shiploop-host@0.0.0`（F-011 起；三者均无第三方运行时依赖传递到 CLI）；根工作区只持有开发工具（typescript、@types/node、vitest）。

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
npm run accept:p01 # P01 阶段验收：verify + 四个固定场景 + 构建冒烟，写出 artifacts/acceptance/p01/<run-id>/ 报告与证据
node scripts/acceptance/clean-snapshot-replay.ts --root . --out docs/acceptance/evidence-p01-4  # 干净已提交快照复跑七条命令（两次 accept:p01）
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
