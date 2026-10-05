# P02-1 Host 单例发现与本机认证 — 生命周期接口契约

- 对应任务：F-001（核对 P01 放行基线，记录 P02-1 生命周期接口契约）。
- 文档状态：P02-1 实施前置契约（F-002 ~ F-014 的唯一协议依据，**不是**阶段验收报告，也不是已实现能力声明）。
- 适用平台：macOS（首个正式支持平台）；Windows/WSL/Linux 未验收，未知平台启动 Host 必须拒绝。
- 输入依据：PRD `p02-host-lifecycle.md`（版本 0.2，2026-10-01，状态「待审阅的需求文档」）、共同执行约束
  `execution-contract.md`（2026-10-01）与知识目录 `architecture-redesign/`（开发查阅路径在 Harness，
  非本仓库内容、非运行时依赖）。引用版本见 §17.2。
- 本文把设计 08/12 中与 Host 生命周期相关的**草案建议**在 P02-1 范围内定案；未列入的能力
  （项目命令、SSE、Chat、Work 调度等）保持草案或 `unsupported`，后续 Feature 不得反向援引本文占位。
- 本文不静默改变领域语义；发现的编号与语义张力集中记录于 §15.4，并按 §17 请求核对。

---

## 1. P01 放行基线核验（开工核对）

### 1.1 分支与提交

- 实际执行分支：`feat/2026-10-04-23-19-52_p02-1-host`（worktree
  `shiploop-2026-10-04-23-19-52_p02-1-host`），基线 `main`。
- 开工时 HEAD（= P02-1 起点，完整 hash）：
  `24dcb7da41f2cb080c6b01c94a4cb24bddb8e4d3`（`docs(acceptance): record owner approval for P01`）。
- 负责人 P01 放行基线：`5a43a042b98bf2317db7501547def93a4f08f2fa`（`test(acceptance): add P01
  standalone integration checks and review guide`）。`5a43a04` 是当前 HEAD 的祖先
  （`git merge-base --is-ancestor` 为真）。
- P01 产品**受测代码** commit：`0e96535cb2384f0b53911a154aedf477a04b52b7`。
  - `0e96535..5a43a04` 只新增验收 Markdown 与纯 Node 独立验收脚本
    （`scripts/acceptance/p01-scenarios.mjs`、`run-p01.mjs`、`docs/acceptance/p01-review-*.md`），
    不改产品逻辑。
  - `5a43a04..24dcb7d` 只改两份验收 Markdown（追加负责人放行记录），无代码、无脚本变更。
  - 因此当前 HEAD 与放行基线的产品行为一致；**不得把放行基线 hash 与受测产品 commit 混为一谈**。

### 1.2 人工放行依据（不代签、不自动合并）

- `docs/acceptance/p01-review-results.md` 与 `docs/acceptance/p01-review-checklist.md` 均含
  「人工放行记录 / 负责人阶段放行（2026-10-05）」：
  - 授权人：项目负责人 ganlu，经 Harness 对话明确授权（原话记录：“p01帮我修改一下，放行”）。
  - 结论：P01 放行，允许从已合入 `main` 的基线开始 P02；范围仅限 P01 已交付能力，
    不视为 Host/CLI、Runtime、强沙箱或其他平台已验收。
  - 放行依据：原阶段门禁 14 项通过、796 个开发测试通过、两轮独立集成 24/24 通过。
- 诚实记录：人工清单 §6 的逐项填空栏（最终验收 commit、签名行等）保留为**原始审阅模板空白**，
  未逐项勾选；放行记录明确说明「不声称人工清单中每个检查已逐项执行」。
  F-001 的判定：**存在明确的负责人阶段放行依据，满足开工的人工授权条件**；但这是阶段级
  负责人决定，不是逐项人工验收，也不是 P02 任何能力的验收。F-001 不代替验收人补签、
  不自动合并、不扩大放行范围。若后续要求以「逐项签字的清单」为唯一放行形式，需负责人补充；
  当前以在库记录为准，不以此为由阻塞 P02-1。

### 1.3 环境与工具（实际核验）

| 项 | 契约值 | 来源 |
|---|---|---|
| Node | `22.19.0` | 根 `package.json` `engines.node`、`.nvmrc`、`.node-version`；本机 `node --version` 实测一致 |
| npm | `10.9.3` | `engines.npm`、`packageManager: npm@10.9.3`；本机实测一致 |
| engine-strict | 开启（`.npmrc` `engine-strict=true`），另含 `save-exact=true` | `.npmrc` |
| TypeScript | `7.0.2`（devDependency，精确） | 根 `package.json` |
| 测试框架 | vitest `5.0.3`（精确，无前缀；启动器校验身份与版本） | 根 `package.json`、`scripts/run-tests.ts` |
| SQLite 栈 | `better-sqlite3@13.0.3`、`drizzle-orm@0.45.3`（仅 `shiploop-core` 声明） | `packages/core/package.json` |
| 模块体系 | ESM（`"type": "module"`），NodeNext，strict，`verbatimModuleSyntax` | 各 `tsconfig.json` |

不升级、不替换上述版本；新增依赖必须显式声明在使用包清单中（见 §13.4），并经边界检查。

### 1.4 既有脚本与工程入口（复用，不重建）

| 脚本 | 实际命令 | 语义 |
|---|---|---|
| `npm test` | `node scripts/run-tests.ts` | 仅从工作区解析 vitest 5.0.3，run 模式一次性执行；退出码原样传播 |
| `npm run typecheck` | `tsc -p tsconfig.json` | 含 src/test/scripts/examples 全量类型检查（noEmit） |
| `npm run check:boundaries` | `node scripts/check-boundaries.ts` | 单向依赖 + Core 分层 + 禁绑厂商模块，fail-closed |
| `npm run build` | F-004 起先 `node scripts/build-host-lock.ts`，再 `tsc -b` 三包 + `node scripts/smoke-built-entries.ts` | 构建后非源码 cwd 冒烟，扫描路径/依赖/迁移 |
| `npm run verify` | `node scripts/verify.ts` | 锁文件预检 + test/typecheck/build 真实子进程串联，fail-fast |
| `npm run accept:p01` | `node scripts/acceptance/p01-accept.ts` | P01 阶段验收入口；P02-1 **不**新增或冒用 `accept:p02`（属 P02 末项边界） |

开工时在本 worktree 实测：`npm ci`（本机缓存，47 包）、`npm run check:boundaries`
（29 个生产源文件，0 diagnostics）、`npm run typecheck` 退出均为 0。

### 1.5 公共装配接口与 Host/CLI 现状

- `shiploop-core` 公共入口（`packages/core/package.json` exports）：
  - `.` → `dist/index.js`：ports/application 的纯契约与用例（无 I/O、无副作用）。
  - `./assembly` → `dist/adapters/composition.js`：`openCoreApplication(options): Promise<CoreApplication>`
    与 `CoreApplication`（`dataRoot` / `pathService` / `stateStore` / `artifactStore` /
    `artifactFileStore` / `repositoryInspector` / `projectService` / `configurationService` /
    `close()`）。选项校验先于任何 I/O；只创建数据根本身（0700）；打开后执行版本化迁移；
    `close()` 幂等。`capabilityCatalog` 为必注入项，空目录 fail-closed。
- 数据根现状规则（`ports/path-service.ts` + `adapters/fs/path-service.ts`，P02-1 直接复用）：
  - 稳定 `DATA_NAMESPACE = "shiploop"`；默认根纯推导
    `deriveDefaultDataRoot(home) = <home>/Library/Application Support/shiploop`；
    数据库文件 `<root>/core.sqlite`。
  - 显式根必须是 POSIX 绝对路径、非文件系统根、已存在且为真实目录，构造时 `realpathSync` 固定；
    拒绝 NUL、符号链接叶、祖先 realpath 越界。
  - 当前迁移：v1 六表 + v2 `state_events`；未知高版本 Schema 拒写（启动恢复检查沿用此语义）。
- `shiploop-host` / `shiploop-cli` 现状：
  - **F-001 冻结时**：两包 `src/index.ts` 均为 `export {}` 骨架注释，加载无副作用。
  - **F-002 增量（2026-10-05）**：`shiploop-host` 公共入口改为纯 re-export `src/contract/`
    契约面（版本/路由/预算常量、§3.2 身份与 §10.3 摘要纯函数、发现/握手/status/stop
    类型与运行时校验、§7.3/§14 结构化错误）。契约面仅依赖 `node:crypto`，不导入
    `node:http/net/fs/child_process`、ORM 或 Pi SDK。`shiploop-cli` 仍为 `export {}` 骨架。
  - **F-003 增量（2026-10-05）**：`shiploop-host` 公共入口追加导出 `src/storage/`
    受保护文件存储：`resolveCanonicalDataRoot`（显式根或调用方按 P01
    `deriveDefaultDataRoot` 预推导的 `defaultDataRoot`；仅 start 语义允许
    `createIfMissing` 创建根目录本身 0700；realpath 固定 + §3.2 身份）与
    `createHostFileStore`（host/ 0700、discovery.json/auth.token 0600、属主核验、
    符号链接/权限/形态 fail-closed、randomBytes(32) 凭据、同目录临时文件 + rename
    原子发布、按 hostInstanceId 核对的清理且绝不触碰 writer.lock）。存储层只用
    `node:fs/node:crypto/node:path`，不导入 `node:http/net/child_process`；为保持
    干净树下 `npm run typecheck` 不依赖 core dist，F-003 **未**给 host 包引入
    `shiploop-core` 依赖（默认根推导留待 F-006 装配时注入）；import 公共入口仍无
    任何写文件/监听/进程副作用。F-003 当时 OS 锁与启动/HTTP 尚未实现。
  - **F-004 增量（2026-10-05）**：公共入口追加 `src/locking/`：真实 macOS
    `flock(LOCK_EX | LOCK_NB)`，由实际 Node 写入进程直接持 fd（无辅助者）；
    `acquireWriterLock` 有界获取与 owner 诊断，`openLockedWriter` 保证获锁后才调用
    Core 工厂、关闭写入/持锁清理后才释锁，关闭或清理失败保锁。新编写的极小 N-API C
    适配器经显式 build 编译到 host dist；没有 npm 新依赖、运行时编译或 import 副作用。
    生产边界、原生工具前提与 F-006/F-008 装配要求见 [写入锁决定](p02-1-writer-lock.md)。
    启动入口（F-006）、HTTP 认证探测与 CLI 仍未实现；owner_active 仅由可信探测端口
    的认证成功响应 + 共享双向校验得出，不从 PID/发现推断。
  - **F-005 增量（2026-10-05，仅测试夹具，产品入口零变化）**：新增
    `test/helpers/host/` 夹具公共面并由 `test/host-fixture-kit.test.ts` 自测：
    `isolated-environment`（复用 temp-sandbox、白名单 env、规范数据根与统一回收）、
    `managed-child`（真实 Node 子进程 ready/go 屏障、有界等待、IPC close→SIGTERM→
    SIGKILL 升级与退出核验，`exit_unconfirmed` 不冒充停止）、`fixture-child` 标准
    异常场景（never-ready/early-exit/wrong-pid/crash/ignore-sigterm）、
    `fake-host-server`（真实 127.0.0.1 监听，可编排错误/缺失 token、旧实例、错误
    协议/schema/数据根、能力撒谎、畸形 JSON 与 3xx 重定向）与脱敏 `evidence`
    （认证头只留分类，登记秘密与受保护路径扫描，fail-closed）。Host/CLI 产品包
    源码、依赖与构建行为均未改变。
  - **F-006 增量（2026-10-05）**：公共入口追加 `src/runtime/` 启动装配面，并新增
    显式启动入口 `src/start.ts` → `dist/start.js`（用法 `node …/dist/start.js
    --data-root <abs>`，只接受受控 argv）。启动顺序按 §11：选项/env 监听覆盖
    零容忍（`bind_address_override_rejected`，覆盖值不回显）→ 平台检查 →
    resolveCanonicalDataRoot（start 语义创建根目录 0700）→ openLockedWriter
    （获锁先于 Core）→ openCoreApplication（含版本化迁移；未知高版本 Schema
    拒写并自动释锁）→ 127.0.0.1:0 监听并核验 `server.address()` 恰为回环字面量
    → 新 hostInstanceId + 新凭据 → 原子发现发布（ready 提交点）→ ready。
    失败按获取逆序关闭监听/Core 并释锁，不发布 ready。F-006 监听器是**占位
    传输面**：任何请求一律 404 `unknown_operation`（握手/status/stop 认证路由
    属 F-007/F-008，本阶段未实现）；生产入口注入空能力目录（不装配任何
    runtime/Pi/模型执行）；SIGTERM 安全收尾与按实例清理属 F-008。host 包按
    §13.4 声明 `"shiploop-core": "0.0.0"`，经包名与 `./assembly` 子路径使用
    Core 公共入口；干净树（无 dist）下 `npm test`/`npm run typecheck` 的解析
    路径见 §13.4 的 F-006 定案。边界检查把目标包 exports 声明的公共子路径入口
    （如 `shiploop-core/assembly`）与包名入口同等按单向规则放行，未声明的内部
    子路径仍然违规。`shiploop-cli` 仍为 `export {}` 骨架。
  - **F-007 增量（2026-10-05）**：F-006 的 404 占位监听器由真实生命周期传输面
    替换（`src/runtime/http-transport.ts`，经公共入口导出
    `createHostLifecycleServer` 与有界超时常量）：握手与 status 认证路由按
    §7.2/§8/§9 生效——Bearer timingSafeEqual 认证（子原因不可区分 401）、
    Host 头恰为 `127.0.0.1:<实际端口>`、任何 Origin 拒绝、16 KiB 体积上限
    （413）、POST content-type 核验、GET 带体拒绝、404/405 路由纪律、响应无
    CORS 头且永不含 3xx、错误体脱敏（不回显凭据/原文/路径）。**stop 路由在
    F-008 接线前**经完整传输与认证校验后返回 `501 unsupported`
    （details.reason `stop_not_wired`），绝不触发停止/文件删除/数据库写入；
    `startHost` 装配顺序微调为「新实例/凭据 → 传输面监听核验 → 原子发现发布」
    （先凭据后发现不变，发现仍是就绪提交点）。SIGTERM 收尾、quiesce、按实例
    清理、幂等矩阵与 HostClient 仍属 F-008/F-009。
  - **F-008 增量（2026-10-05）**：stop 路由完成接线，F-007 的 501 中间态移除。
    `src/runtime/host-stop.ts` 提供：§10.2 窄活动门控端口（仅 enterQuiesce/
    awaitQuiesce 两方法）与生产恒空闲门控 `createIdleActivityGate`；停止控制器
    `createHostStopController`（§10.4 幂等矩阵与 §10.5 关闭顺序的进程内编排）；
    `wireHostSignalShutdown`（§10.7：SIGTERM/SIGINT 走同一安全收尾，由
    `dist/start.js` 与测试子进程装配，只在收尾 completed 后以退出码 0 退出）。
    落实行为：stop 经传输/结构/凭据/版本/摘要/实例校验后 → 唯一一次
    enterQuiesce → awaitQuiesce（默认 10 000 ms，受信注入只允许更小有界值）→
    stopping（关 listener，在途响应仍可送达）→ 关 Core → 持锁按实例清理
    发现/凭据 → 200 最终视图（completed/stopping）→ 释锁 → 进程退出码 0。
    同 commandId 同摘要重放回同一结果/进度（replayed: true）；同 ID 不同摘要
    409 conflict；quiescing 中另一 commandId 409 stop_in_progress；starting
    503 not_ready；quiesce 未确认 409 quiesce_not_confirmed 且保持 quiescing、
    锁与隔离（F-008 测试以真实受管子进程充当活动核验竞争者获锁 owner_unknown）。
    被拒操作以同命令重提续跑（不重新 enterQuiesce、不重复关闭，成功回执
    replayed: true）；收尾/清理失败按未确认处理（internal
    stop_teardown_unconfirmed / stop_cleanup_unconfirmed，保锁不伪装成功）；
    客户端断开不触发也不阻断收尾（响应送达失败不改变 §10.4 语义）。
    `startHost` 新增受信注入 `activityGate`/`quiesceBudgetMs`（绝非
    argv/env/发现字段），生产默认恒空闲门控，不新增执行表、不虚构取消能力。
    `shiploop-cli` 仍为 `export {}` 骨架；HostClient/启动器/CLI 属后续任务。
  - **F-009 增量（2026-10-05）**：公共入口追加 `src/client/` HostClient 面
    （§12 的实现），导出 `connectToHost` 与 `probeDiscoveredHost`。
    `connectToHost`：选项纯校验（零 I/O）→ F-003 受保护存储 fail-closed
    读取发现与凭据（本地计算 dataRootIdentity）→ 只连接发现指向的
    127.0.0.1 固定端口 → 认证握手双向核验（§12.2：HTTP 200、协议版本
    支持集、hostInstanceId === 发现实例、dataRootIdentity === 本地计算值、
    能力冻结形态）通过后才允许 status/stop。错误按 §14 精确分类
    （host_not_found / unsafe_discovery / invalid_discovery / unreachable
    （connect_failed/connect_timeout/request_timeout/connection_lost 子原因）/
    unauthorized / protocol_incompatible / instance_mismatch /
    data_root_mismatch / redirect_rejected / response_malformed），互不折算；
    绝不跟随 3xx（不向新地址重发凭据）、不自动另起写入者。请求/响应有
    §7.2 有限超时与 16 KiB 体积预算（覆盖仅允许区间内有限值）。服务端错误
    响应只信任白名单错误码与受控 details 键，不透传服务端 message（防对端
    夹带秘密）。`close()` 幂等且只释放本地观察资源（之后 status/stop 以
    invalid_input/client_closed 本地拒绝），绝不调用 stop；Host 存活由另一
    客户端认证 status 证明。`probeDiscoveredHost` 是只做一次握手核验的窄
    探测，供 F-010 启动器 owner 诊断与 F-004 ownerProbe 真实实现复用。
    client/ 允许 node:http（仅回环）与 node:crypto，禁止文件系统（发现/
    凭据读取一律经 storage/）、其他网络/进程/线程模块、argv 与
    shiploop-core。`shiploop-cli` 仍为 `export {}` 骨架；启动器/CLI
    参数面属 F-010/F-011/F-012。
- 边界检查现状（`scripts/check-boundaries.ts`，P02-1 必须持续通过）：
  - 工作区单向依赖仅允许 `host → core`、`cli → host`；CLI 禁止绕过 Host 直连 Core；
    清单 `dependencies` 与源码导入同时检查，未声明依赖即违规。
  - 禁止跨包内部子路径导入、自包名引用、相对路径逃逸出本包 `src`、非字面量 import。
  - Core 契约区（domain/application/ports/公共入口）禁止 Pi/Electron/HTTP 框架/better-sqlite3/
    Drizzle 与 `node:http(s)/net/dgram`；基础设施绑定只能在 adapters 层。

**结论：P01 基线、人工放行依据与环境均符合开工条件，无阻塞项；P02-1 不重建 P01 工程、
不隐式升级依赖，仅做增量。**

## 2. 本 Feature 范围与非目标

### 2.1 范围内（FR-1、FR-2 的生命周期子集）

1. 每规范数据根一个持 OS 排他锁的 Host：实例身份、密码学随机本机凭据、受保护发现文件、
   127.0.0.1 随机端口、原子发布与按实例清理。
2. 版本化本机协议：握手、只读状态查询、版本化显式停止；Bearer 本机认证、Host/Origin 校验、
   协议/实例/数据根双向核验、结构化脱敏错误。
3. CLI 的 `host start/status/stop`：连接或受控启动、重复 start 接同一实例、客户端退出不停 Host、
   显式 stop 的收尾确认与退出/释锁证据。

### 2.2 明确不提供（后续任务不得以占位宣称已实现）

- 项目注册 / 配置 / 基线（onboarding）任何命令或路由（属 P02-2、P02-3）。
- SSE / 事件游标 / 快照重连、Work/Batch/Run/Attempt 调度、Scheduler、Runner、Pi SDK 与模型执行、
  执行取消（含进程树强制终止业务能力）、Chat、Web/Electron 配对与 CSRF、通知。
- 通用命令回执体系与 `command_receipts` 持久化：本 Feature 的「幂等」仅指**同一 Host 实例的
  停止请求**在进程生命期内的版本化去重（§10.4），不新建项目命令表、不跨重启保留回执。
- 跨平台验收或实现承诺：macOS 之外启动 Host 返回 `unsupported_platform`；WSL/Linux 锁另行验收。
- 任何公网监听能力；不通过配置、环境变量、CLI 参数放宽监听地址（§5.1、§13.2）。
- 停机活动控制只允许接入本契约定义的**窄活动控制端口**（§10.2）。P01 没有 Scheduler/Runner，
  生产装配的活动数恒为 0（idle-only stop）；测试用受控假活动验证顺序，**不得**据此宣称
  执行取消、Work quiesce 或 Pi 停止已实现。
- 运行产物（文档、测试、报告、构建冒烟）不得包含开发机绝对路径、真实凭据或 Harness 路径依赖；
  本文出现的开发查阅路径仅作 F-001 核对记录，后续代码与测试不得依赖它们。

## 3. 数据根规范化与身份算法

### 3.1 规范根（canonical data root）

1. 显式 `dataRoot`：非空 POSIX 绝对路径，不含 NUL，不等于 `/`；Host 启动时确保其存在
   （仅创建根目录本身，mode 0700，沿用 `openCoreApplication` 行为），随后 `realpathSync`
   取真实路径。
2. 默认根：未显式提供时由 `os.homedir()` 经 `deriveDefaultDataRoot` 推导
   （`<home>/Library/Application Support/shiploop`）；测试必须注入临时 home，不读真实用户目录。
3. **规范根 = 成功 realpath 后的字符串**。锁、发现、凭据、数据库全部以规范根为基准；
   同一真实根的路径别名（如 macOS `/tmp` 与 `/private/tmp`、含符号链接的前缀）获得同一数据根
   身份与同一把锁；不同 realpath 是不同数据根，可各自持锁。
4. 规范根之外的符号链接逃逸、非普通文件叶、不安全权限按 §3.3/§5.2 fail-closed。

### 3.2 数据根身份（dataRootIdentity）

```
dataRootIdentity = lower_hex(sha256(utf8Bytes(canonicalRoot)))
```

- 输出 64 个小写十六进制字符；输入是 realpath 的**原样返回字符串**（realpath 不带尾分隔符；
  根 `/` 已被拒绝）。不做额外大小写折叠或尾斜杠归一——归一责任只属于 realpath。
- 身份是非秘密标识符，用于发现文件、握手与状态响应；它**不是**认证凭据。
- Host 与 CLI 必须共用同一纯函数实现（放在 F-002 的契约模块，见 §13.1），禁止两边各写一份。

### 3.3 Host 私有目录布局

```text
<canonicalRoot>/
  core.sqlite                 # P01 既有，openCoreApplication 拥有
  host/                       # Host 私有目录，0700，当前用户所有
    discovery.json            # 发现文件，0600，内容见 §5
    auth.token                # 本机 Bearer 凭据，0600，内容见 §4.2
    writer.lock               # OS 排他锁目标文件，0600；永不被业务清理删除
    .<name>.<uuid>.tmp        # 同目录原子写临时文件，0600，发布后 rename 替换
```

- 三个受保护文件的相对位置：`host/discovery.json`、`host/auth.token`、`host/writer.lock`
  （均位于规范根内）。`host/` 必须在获锁前创建或核验（0700），以提供 OS 锁目标父目录；
  获锁前只允许根解析、私有目录与锁文件创建/安全核验，发现与凭据发布及 Core 写入均须获锁之后。
  发现文件不得包含任意 URL、公网地址或根外凭据路径；本协议没有「凭据路径」字段，
  客户端只从规范根 `host/auth.token` 读取。
- 权限与所有权核验（Host 发布前与 CLI 读取前都做）：目录 0700、文件 0600、属主为当前进程用户；
  权限过宽、根外符号链接、目标不是普通文件、JSON 损坏或校验失败一律 fail-closed
  （拒绝信任，不尝试 chmod「修复」、不覆盖可疑位置）。具体 fail-closed 矩阵由 F-003 实现并测试。

## 4. 实例身份与凭据

### 4.1 hostInstanceId

- 每次**成功获锁启动**生成新的 `hostInstanceId`：RFC 4122 UUID v4 字符串（`randomUUID()`）。
- 实例身份只代表「本次持锁写入进程」；重启必换新身份与新凭据。旧发现/旧凭据对新实例一律无效
  （握手以服务端当前身份为准）。
- `pid` 仅作诊断提示字段，**不**用于授权、存活判定或杀进程依据；PID 陈旧或被无关活进程复用
  不授权删除锁、杀进程或启动第二写入者。

### 4.2 本机凭据

- `auth.token` 内容：`randomBytes(32)` 的小写 hex（64 字符），来自密码学安全随机源
  （`node:crypto.randomBytes`），每次启动重新生成。
- 凭据只经两个通道传递：受保护文件（0600）与 HTTP `Authorization: Bearer <token>` 请求头。
  禁止进入 URL/query、命令行参数（`process.argv`）、环境变量、日志、普通状态 JSON、
  错误消息、发现文件、报告或证据附件。
- 服务端比较使用等长 `timingSafeEqual`；缺失/格式错误/错误 token 返回不可区分的
  `401 unauthorized`（不区分「不存在」与「错误」，避免探测）。
- 退出客户端不删除、不轮换凭据；仅显式停止且核对实例身份后，由 Host 删除自己的
  discovery.json 与 auth.token（§10.5）。

## 5. 发现文件契约（discovery.json）

### 5.1 内容（schemaVersion 1，唯一允许形态）

```json
{
  "schemaVersion": 1,
  "protocolVersion": 1,
  "hostInstanceId": "0c9c2e51-9a91-4f63-8d92-4b7b9a7c2f10",
  "dataRootIdentity": "9f2a000000000000000000000000000000000000000000000000000000000000",
  "listenAddress": "127.0.0.1",
  "port": 54321,
  "pid": 48210,
  "startedAt": "2026-10-05T00:20:00.000Z"
}
```

| 字段 | 规则 |
|---|---|
| `schemaVersion` | 发现文档结构版本，当前固定 `1`；未知值拒绝（不猜测降级） |
| `protocolVersion` | Host 生命周期线协议版本，当前固定 `1`（§7.1） |
| `hostInstanceId` | 规范 UUID v4 字符串 |
| `dataRootIdentity` | 64 小写 hex，必须等于客户端对本地规范根的计算值 |
| `listenAddress` | 必须恰为 `"127.0.0.1"`；`localhost`、`::1`、`0.0.0.0`、域名、外网 IP 一律拒绝 |
| `port` | 整数 1..65535；发布值必须等于套接字实际分配端口（绑定时传 0）；禁止 0 |
| `pid` | 1..2³¹-1 的整数；仅诊断 |
| `startedAt` | ISO 8601 UTC 日期时间字符串（形如 `2026-10-05T00:20:00.000Z`） |
| 未知字段 | 一律拒绝（沿用 P01 `rejectUnknownKeys` 约定），不向前宽容忍 |

### 5.2 发布与读取规则

- 发布时机：OS 锁已获取 → Core 已打开且 Schema 检查通过 → 套接字已绑定并核验
  `server.address().address === '127.0.0.1'` 且取得实际端口 → 此后才原子发布。
- 原子发布：同文件系统临时文件（0600）写完整 JSON 与刷盘策略由 F-003 定案，`rename` 替换；
  发布失败不得留下可被连接的半文件，不发布 ready。
- 读取信任条件（全部满足才允许连接）：普通文件、0600、属主当前用户、位于规范根 `host/` 内、
  无符号链接组件、Schema 校验通过、`dataRootIdentity` 与本地计算一致、`listenAddress` 为
  回环字面量、端口在范围。任何一条不满足：拒绝连接，按 §14 给出可诊断错误码，不删文件、
  不另起写入者。
- 发现文件不是存活证明：读不到、损坏或指向无人监听的端口时，只能走 §12.4 的重新发现/
  owner 诊断流程。

## 6. OS 排他锁与单例语义（F-004 的契约面）

- 锁粒度：**每规范数据根一把** OS 级排他锁，目标文件 `<root>/host/writer.lock`。
  别名路径竞争同一把锁；不同规范根互不阻塞。
- 方案基线：S3 Spike（2026-10-01，macOS arm64）验证过 `/usr/bin/lockf`：8 路并发仅 1 个 Host、
  竞争方退出码 75。**Spike 不是生产代码**；F-004 必须实现真实 macOS 排他锁并证明锁与
  「实际写入进程」生命周期绑定（若使用辅助进程持锁，写入者停止前辅助者不得先退出造成
  接管窗口），同时记录生产边界。不得以 PID 文件、时间戳、SQLite busy、目录创建或
  「尝试 bind 端口」替代 OS 锁；不得直接复制 Spike 源码。
- **F-004 生产决定**：新编写 N-API 适配器直接调用 macOS `flock` 非阻塞排他锁，
  实际 Node 写入者持 fd，关闭 fd 或该进程退出由 OS 释锁，FD_CLOEXEC 不继承给 exec
  子进程。无辅助进程，不复制 Spike。构建要求 clang/macOS SDK/Node 头文件，缺失明确失败；
  运行时原生模块不可加载 → unsupported_platform，不自动编译或降级。
  详见 [p02-1-writer-lock.md](p02-1-writer-lock.md)。
- 顺序不变量：获锁 **先于** `openCoreApplication`、SQLite 迁移与任何业务写入；
  竞争失败者不打开写库。释锁在关闭写入之后（§10.5 顺序）。
- 陈旧信息处理：发现缺失/损坏、陈旧 PID、PID 被无关活进程占用，都**不**授权删锁/杀进程/
  启动第二写入者。冲突诊断必须二选一可区分：
  - `owner_active`：锁被持有且存在可核验实例（发现通过校验并完成认证握手）；
  - `owner_unknown`：锁被持有但实例无法核验（发现缺失/损坏/不安全、握手身份或认证失败、
    协议不兼容）。此时只能有限预算等待/重新发现，或返回诊断由用户处理。
- 崩溃语义：写入者崩溃或被 SIGKILL 后由 OS 自动释放锁；新进程获锁前旧锁仍在则拒绝接管。
  「未确认旧写入者停止」永远优先于「重启成功」。
- 平台：非 macOS（或缺少经验证的锁工具）启动 Host 直接返回 `unsupported_platform`，不尝试
  降级方案。
- 获取等待有有限预算（默认 10 000 ms，内部实现常量；CLI 侧启动预算见 §13.2），不无限等待。

## 7. 线协议通用规则

### 7.1 版本

- `protocolVersion`（线协议）当前为整数 `1`；发现 `schemaVersion` 当前 `1`。两者独立演进、
  独立校验。本 Feature 只实现 v1/v1；不兼容的 `protocolVersion` → `426 protocol_incompatible`；
  未知 `schemaVersion` → `400 unsupported_schema_version`。不做静默降级或版本猜测。

### 7.2 传输

- HTTP/1.1 over TCP，仅 127.0.0.1；JSON（UTF-8）；路由前缀 `/v1/host/`。
- Host **永不**发出 3xx；客户端**绝不**跟随重定向（收到 3xx 即协议错误，不向新地址重发 token）。
- 响应头：`content-type: application/json; charset=utf-8`、`cache-control: no-store`；
  不发任何 CORS 响应头（`Access-Control-*`）。
- 请求头：
  - `Authorization: Bearer <token>` 为所有路由必需（无匿名路由；不设 /health 类免认证端点）。
  - `Host` 必须恰为 `127.0.0.1:<实际端口>`。
  - `Origin` 必须**缺席**（无 Origin 的 CLI 请求合法）；携带任何外部 Origin 或伪造域名 → 401。
  - POST 的 `content-type` 须为 `application/json`（字符集后缀允许）。
- 体积：请求体与响应体上限均 `16 384` 字节；超限 → `413 request_too_large` 并停止读取。
- 畸形 JSON / 编码错误 → `400 invalid_input`；未知路由 → `404 unknown_operation`；
  方法不允许 → `405 method_not_allowed`（允许方法在错误中明示）。GET 请求带请求体 → 400。
- 客户端预算：TCP 连接 2 000 ms；握手/状态整体（含完整响应体读取）10 000 ms；
  stop 整体 15 000 ms（含 §10 的 10 000 ms quiesce 预算 + 5 000 ms 余量）。均为有限默认值。
- 服务端预算（F-007 定案，内部常量，不开放配置）：`headersTimeout` 5 000 ms、
  `requestTimeout` 15 000 ms（超时由服务器以 408/关闭连接处理）；每个响应
  `connection: close`，不留持久空闲连接；HTTP/1.1 缺失 Host 头的请求由 Node
  内核在业务处理器之前以 400 拒绝（同为有界、零副作用的明确拒绝）。

### 7.3 结构化错误（脱敏）

```json
{
  "error": {
    "code": "resource_busy",
    "message": "可理解的人类可读原因（不含秘密）",
    "operation": "host.stop",
    "details": { "reasonCode": "quiesce_not_confirmed" }
  }
}
```

- 错误保留操作身份（`operation`）与可理解原因；`details` 只含受控枚举与非秘密标识
  （commandId、reasonCode、supported 列表等）。
- 禁止回显：token、Authorization 头、任意堆栈、绝对路径、环境变量、请求体原文。
- HTTP 状态到错误码的映射见 §14。

## 8. 握手：`POST /v1/host/handshake`

用途：认证 + 双向核验（协议、预期实例、数据根）。**握手通过前客户端不得发送 status/stop**；
握手本身不触发停止、文件删除或数据库写入。

请求体：

```json
{
  "schemaVersion": 1,
  "protocolVersion": 1,
  "hostInstanceId": "<发现文件中的预期实例>",
  "dataRootIdentity": "<客户端对本地规范根计算的身份>"
}
```

校验顺序（先失败先返回，认证不区分内部子原因）：

1. 传输层：方法/路由/Host/Origin/Authorization/体积/JSON。
2. 严格结构：仅上述 4 个字段，类型与格式合法（UUID、64 hex）。
3. 凭据：timingSafeEqual 失败 → `401 unauthorized`。
4. `schemaVersion` 未知 → `400 unsupported_schema_version`。
5. `protocolVersion` 不兼容 → `426 protocol_incompatible`（`details.supportedProtocolVersions: [1]`）。
6. `hostInstanceId` ≠ 当前实例 → `409 instance_mismatch`。
7. `dataRootIdentity` ≠ 当前规范根身份 → `409 data_root_mismatch`。

成功 `200`：

```json
{
  "schemaVersion": 1,
  "protocolVersion": 1,
  "hostInstanceId": "…",
  "dataRootIdentity": "…",
  "lifecycleState": "starting | ready | quiescing | stopping",
  "startedAt": "…",
  "capabilities": {
    "lifecycleRoutes": ["handshake", "status", "stop"],
    "stop": {
      "modes": ["graceful"],
      "idempotency": "commandId+requestDigest",
      "activityScope": "idle-only"
    },
    "events": "unsupported",
    "projectCommands": "unsupported"
  }
}
```

- `lifecycleState` 为真实当前状态（§11 状态机）；`starting` 允许握手与只读查询，
  但不接受 stop（`503 not_ready`）。
- `capabilities` 只描述真实支持：P02-1 无事件、无项目命令、活动控制 idle-only。
  客户端必须以此（而非名称猜测）判断能力；请求未列能力返回 `unsupported`。

## 9. 状态：`GET /v1/host/status`

- 仅认证（+ Host/Origin）；无请求体；**只读、零副作用**：不写库、不改文件、不触发 quiesce。
- 成功 `200`：

```json
{
  "schemaVersion": 1,
  "protocolVersion": 1,
  "hostInstanceId": "…",
  "dataRootIdentity": "…",
  "lifecycleState": "starting | ready | quiescing | stopping",
  "pid": 48210,
  "startedAt": "…",
  "activities": { "accepted": 0, "quiescing": 0 },
  "stop": null
}
```

- `stop` 在有停止操作时为停止操作视图：
  `{ "commandId": "…", "status": "accepted|completed|rejected", "stopState":
  "quiescing|stopping|resource_busy", "replayed": false, "reasonCode?": "quiesce_not_confirmed" }`；
  否则为 `null`。
- P02-1 生产装配的 `activities` 恒为 0（无 Scheduler/Runner）；非 0 值只能来自 F-008 测试中
  显式注入的受控假活动端口，产品代码不得虚构活动来源。

## 10. 显式停止：`POST /v1/host/stop`

### 10.1 请求

```json
{
  "schemaVersion": 1,
  "commandId": "fa3d1b0e-4b6f-4b7a-9c0d-2e6a8f1b3d55",
  "hostInstanceId": "<预期实例，必填>",
  "requestDigest": "<64 hex，见 §10.3>",
  "options": { "mode": "graceful" }
}
```

- `commandId`：UUID v4，由客户端生成（CLI 未显式传入时自行生成），标识本次停止操作。
- `options` 可省略（等价 `{"mode":"graceful"}`）。未知字段或类型错误 → `400 invalid_input`；
  请求命名了未实现的停止能力（如 `mode:"force"`、`cancelWorkers`、`killProcessTree`、
  `mode:"cancelWork"`）→ `501 unsupported`（`details.supportedModes: ["graceful"]`），
  绝不默默执行其他控制行为。
- 预期实例不匹配 → `409 instance_mismatch`（错误实例不能停止当前 Host，零副作用）。
- 服务端必须重新计算并核对 `requestDigest`（不接受客户端自报）；不匹配 →
  `400 request_digest_mismatch`。
- 服务端校验顺序（与 §8 握手同原则，先失败先返回）：传输层 → 严格结构/能力
  （400/501）→ 凭据（401）→ schema 版本（400）→ requestDigest 重算核对（400）
  → 预期实例（409）→ 生命周期前置与幂等矩阵（503/409，见 §10.4）→ §10.5 收尾。
  注意：v1 选项空间下「同 commandId 不同摘要」经传输层不可达（任何与登记不同
  的摘要都先被重算核对以 400 拒绝）；§10.4 的 conflict 行由停止控制器在
  commandId 维度先行比对后实现，作为选项空间演进时的冻结行为。

### 10.2 窄活动控制端口（唯一允许接入的活动面）

Host 内部定义只含两个方法的活动门控端口（具体接口名实现时确定，语义在此冻结）：

- `enterQuiesce(): { accepted: number }`：关闭新业务工作入口，返回当时已接受活动数。
- `awaitQuiesce(budgetMs): Promise<{ confirmed: boolean; pending: string[] }>`：在有限预算内
  等待已接受活动收尾；只有 `confirmed === true` 才允许进入关闭。

P02-1 生产实现为恒空闲门控（没有 Runner/Verifier/调度器接入点）。F-008 用受控真实子进程
提供假活动实现以测试 quiesce 顺序、超时与未确认分支；**不得**新增执行表、不得接入 Pi、
不得宣称执行取消。未来 Work 能力接入时是另一个 Feature 的契约变更。

### 10.3 requestDigest 算法

```
canonical = stableCanonicalJson({ commandId, hostInstanceId, options: normalizedOptions })
requestDigest = lower_hex(sha256(utf8Bytes(canonical)))
```

- `stableCanonicalJson`：对象键按 UTF-16 码点递归升序排列、无任何空白、UTF-8 紧凑 JSON
  （数组保序）；`normalizedOptions` 为缺省补全后的服务端形态（省略 options 时补
  `{"mode":"graceful"}`），客户端用同一规范形态计算。
- 摘要绑定「命令身份 + 目标实例 + 停止选项」；不把 token 纳入摘要。

### 10.4 版本化幂等与冲突矩阵（进程生命期内）

| 请求情形 | 响应 | 副作用 |
|---|---|---|
| 新 commandId + 摘要自洽 + 状态 ready | 进入 quiescing（见 §10.5） | 首次且仅一次触发收尾 |
| 进行中：**同 commandId 同摘要**重复提交 | `200`，回同一停止结果/当前进度，`replayed: true` | 不重复 enterQuiesce、不重复关闭资源 |
| 同 commandId **不同摘要** | `409 conflict` | 零副作用 |
| quiescing 中另一 commandId | `409 resource_busy`（reasonCode `stop_in_progress`） | 不接受第二个停止流程 |
| 状态 starting | `503 not_ready` | 零副作用 |
| 收尾超时/活动停止无法确认 | `409 resource_busy`（reasonCode `quiesce_not_confirmed`，附当时停止视图） | 保留 quiescing、隔离与锁；不报告 stopped、不允许第二写入者 |
| 凭据/实例/摘要/选项非法 | 对应 401/409/400/501 | 零副作用 |

- 同 commandId 的重复语义只在**同一 Host 实例进程**内成立；重启后是新实例（新身份/新凭据），
  旧 commandId 随旧进程消失，新实例以 `instance_mismatch` 拒绝旧请求。这不是跨重启的项目
  命令回执体系，本 Feature 不建持久回执表。
- 被拒（`quiesce_not_confirmed`/收尾未确认）的操作仍登记同一 commandId：客户端以**同
  commandId 同摘要**重提即续跑该操作（不重新 enterQuiesce、不重复关闭资源；成功回执
  `replayed: true`）；在 quiescing 中换用新 commandId 仍按 `stop_in_progress` 拒绝，
  操作员兜底是 SIGTERM（§10.7 同一安全收尾）。
- HTTP 响应送达失败、连接断开都不改变上述语义；客户端只能按 §10.6 的外部证据判定完成。

### 10.5 关闭顺序（ready 且 quiesce 确认；P02-1 生产恒空闲）

1. `enterQuiesce()`：生命周期转 `quiescing`，关闭新业务入口（在途请求给有限时间完成）。
2. `awaitQuiesce(10 000 ms)`：生产空闲立即确认；假活动测试可致超时 → resource_busy 并停留。
3. 确认后状态转 `stopping`：关闭 HTTP listener（不再接受新连接）。
4. 经 P01 公共装配关闭 Core：`CoreApplication.close()`（关闭 SQLite 会话/文件句柄）。
5. **持锁状态下**核对 `discovery.json.hostInstanceId === 当前实例`，仅当一致时删除
   `discovery.json` 与 `auth.token`；旧实例的迟到清理回调核对不一致必须放弃删除
   （不能删除新实例文件）。删除失败不删锁、不伪装成功，按未确认处理。
6. 发送最终响应（见下），随后释放 OS 锁并以退出码 0 退出进程。
7. `writer.lock` 文件本身**永不**因停止而删除；发现/凭据删除不替代、不移动锁文件。

最终响应语义（避免把「accepted」当「已停止」）：空闲路径在第 5 步完成后、释锁退出前回
`200`，停止视图固定为 `{ "commandId": "…", "status": "completed", "stopState":
"stopping", "replayed": false }`。`completed/stopping` 的含义是「Host 已完成收尾、正在退出」，
**不是**进程已退出的证明。

### 10.6 完成判据（客户端与测试共用）

只有同时取得以下外部证据才可向用户报告 stopped：

1. Host 进程已退出（退出码可核验，子进程被回收）；
2. 该规范根的 OS 锁已可被新候选获取（锁释放证据）；
3. 发现文件已按实例删除或被新实例替换。

HTTP 200、连接被重置、CLI 自身退出都不算完成。无法确认时返回 `stop_not_confirmed`
诊断并保留现场（锁与进程仍在），不报告 stopped，不启动替代写入者。

### 10.7 信号与客户端断开

- `SIGTERM`/`SIGINT` 走与 §10.5 相同的安全收尾顺序（无 commandId、无回执承诺）；
  `SIGKILL`/崩溃由 OS 释锁，发现可能残留为陈旧文件（按 §12.4 处理）。
- 客户端关闭连接、退出进程、取消观察：**不触发**任何停止流程；Host 继续存活，
  另一客户端可经认证 status 证实其存活。

## 11. Host 生命周期状态机

```text
(startup)
  starting ──锁/Core/Schema/bind/发布全部成功──▶ ready
     │ 任一失败：关闭已打开资源、按逆序释锁、非零退出、不发布 ready
     ▼
  (进程退出，无就绪发现)

ready ──合法 stop（或 SIGTERM）──▶ quiescing
quiescing ──活动全部确认收尾──▶ stopping ──清理发现/凭据、响应、释锁──▶ (exit 0)
quiescing ──预算内无法确认──▶ 保持 quiescing（resource_busy；锁与隔离保留）
```

- 状态只能按上图迁移；`stopped` 不是网络状态（进程已不存在），只用于证据/报告表述。
- 启动中数据库/监听/发布失败：已打开的 Core 会话、文件句柄、监听套接字、锁按获取逆序关闭；
  未知高版本 Schema 拒写，且不把原数据库/旧发现伪装为就绪实例。
- 每次启动都是新 `hostInstanceId` 与新 token；不声明、不尝试恢复未存在的执行记录
  （P01 无 Run/Attempt，可恢复的只有「无活动写入者」这一事实）。

## 12. HostClient 与启动器（CLI 侧契约，F-009/F-010）

### 12.1 发现读取与连接

- 只连接 `127.0.0.1:<discovery.port>`；即使发现内容异常也不连接其他地址，不做 DNS 解析、
  不跟随 3xx、不向其他地址发送 token。
- 读取并核验 discovery.json 与 auth.token（§5.2、§3.3），本地计算 dataRootIdentity。
- 请求/响应均有 §7.2 的有限超时与体积预算；流式读取到上限即判定错误。

### 12.2 握手通过前不发业务请求

- 先发握手；响应必须同时满足：HTTP 200、`protocolVersion` 在客户端支持集内、
  `hostInstanceId === 发现文件实例`、`dataRootIdentity === 本地计算值`。
- 任一不满足：拒绝该服务，不发送 status/stop；错误分类按 §14（假服务、错误 token、旧实例、
  错误根、协议不兼容、畸形响应、重定向均有独立码）。
- 握手失败**不**自动另起写入者、不绕过锁、不删锁、不按 PID 杀进程。

### 12.3 客户端资源语义

- `close()`、超时、连接断开只释放本地观察资源，绝不调用 stop。
- Host 存活能力由「客户端退出后，另一个客户端认证 status 成功」证明（F-009/F-013 必测）。
- 所有输出（stdout/stderr/JSON/日志/证据）不得包含 token 与 Authorization 头。

### 12.4 连接或启动流程（`host start`）

1. 先尝试发现 → 握手：成功则直接返回该实例（同一 hostInstanceId），不启动新进程。
2. 无有效发现时，仅经**正式 Host 启动入口**（§13.1）用独立 argv 数组 spawn（不经 shell、
   不做字符串拼接、不 `shell:true`）；后台进程 detached、stdio 独立、不依赖 CLI 的
   stdin/父进程存活；CLI 进程自身不打开 SQLite。
3. 在有限启动预算内轮询重新发现（建议 100 ms 间隔），发现胜者后完成握手。
4. 竞争处理：多 CLI 同步竞争时，未获锁者在预算内重新发现**同一胜者**；锁被占且发现
   缺失/损坏、遇到假服务或认证/协议失败：返回 `owner_unknown`/对应诊断，不绕过锁。
5. 只有「获锁且确认旧实例不再持有写入权」的新 Host 才能替换失效发现（获锁本身即 OS 层
   确认；替换仍须按 §5.2 原子发布并换新身份/凭据）。陈旧 PID 指向无关活进程时不得终止该
   无关进程。
6. 任何失败路径不得留下未经管理的额外 Host 进程；启动候选由启动器在有界预算内回收核验。

`status`/`stop` **永不**启动 Host：无实例时直接返回 `host_not_found`（§14）。

## 13. CLI 契约（F-011/F-012 定案）

### 13.1 命令面与入口

```text
shiploop host start  [--data-root <abs>] [--json] [--start-timeout-ms <int>]
shiploop host status [--data-root <abs>] [--json]
shiploop host stop   [--data-root <abs>] [--json] [--stop-command-id <uuid>] [--confirm-timeout-ms <int>]
shiploop host --help
shiploop --help
```

- 仅这三个生命周期子命令；不新增 `project`/`run`/`feature` 等后续命令，不改产品发布命名决定。
- 参数解析与执行分离（纯解析模块可表驱动单测，F-011）；公共 CLI 模块 import 无副作用
  （不解析 argv、不联网、不 spawn）；仅显式可执行入口调用 HostClient/启动器。
- 显式入口（后续任务创建，F-001 不预先建立空文件）：
  - Host：`packages/host/src/start.ts` → 构建 `dist/start.js`，用法
    `node …/dist/start.js --data-root <abs>`；只接受受控 argv，无 shell。
  - CLI：`packages/cli/src/bin.ts`（shebang）→ `dist/bin.js`；在 F-012 连入客户端并补
    package.json `bin` 字段（不提前声明不存在的文件）。
  - 契约类型与运行时校验函数集中在 `shiploop-host` 包内纯模块（建议 `src/contract/`），
    经公共入口导出：不导入 `node:http/net`、ORM、Pi SDK；import 无端口/目录/进程副作用
    （F-002 验收点）。CLI 只依赖该公共面，不引用内部子路径。

### 13.2 参数规则

- `--data-root <path>`：必须显式提供**绝对** POSIX 路径，或省略（省略 = P01 默认根）。
  相对路径、空值、NUL、`/` → 输入错误（退出码 2），解析失败时不读发现、不访问网络、不启动。
  仅 `start` 允许创建数据根；`status`/`stop` 不创建。
- `--json`：stdout 只输出一个可解析 JSON 对象；人类诊断全部到 stderr。
- `--start-timeout-ms`：仅 start，默认 15 000，允许整数范围 1 000..60 000。
- `--stop-command-id`：仅 stop，必须是 UUID v4；省略时 CLI 生成。
- `--confirm-timeout-ms`：仅 stop，等待进程退出/释锁证据的预算，默认 10 000，范围 0..30 000。
- 未知参数、缺值、非整数、越界、错误子命令、给错误命令的参数（如 status 传
  `--stop-command-id`）→ 退出码 2，不发生任何 I/O 或网络。
- **监听地址覆盖零容忍**：任何 `--bind/--host/--address/--port/--listen*` 参数，以及
  `SHIPLOOP_HOST_BIND`、`SHIPLOOP_HOST_HOST`、`SHIPLOOP_HOST_PORT` 等环境变量形式的覆盖尝试
  （至少覆盖 `0.0.0.0`、`::`、非回环 IP/域名用例），在解析/启动检查阶段明确拒绝
  （输入错误码 `bind_address_override_rejected`）；Host 侧同样独立拒绝配置/env 覆盖。
  产品不提供修改监听地址的能力（开源用户自行改源码不在承诺内）。

### 13.3 输出与退出码（最终码表）

JSON 成功信封：

```json
{ "ok": true, "command": "host.start", "result": {}
}
```

JSON 失败信封（stdout，仅 `--json`；诊断细节在 stderr）：

```json
{ "ok": false, "command": "host.stop", "error": { "code": "stop_not_confirmed", "message": "…" } }
```

| 退出码 | 类别 | 情形（error.code 示例） |
|---|---|---|
| 0 | 成功 | start 已连接既有实例（`already_running`）或启动并握手成功（`started`）；status 取到真实状态（含 `starting`）；stop 取得 §10.6 全部证据（`stopped`） |
| 1 | 业务拒绝 / 操作失败 | `unauthorized`、`forbidden`、`conflict`、`instance_mismatch`、`data_root_mismatch`、`resource_busy`、`stop_not_confirmed`、`unsupported`、`unsupported_platform`、`not_ready`、`owner_unknown`、服务端 `internal` |
| 2 | 输入错误 | 参数解析失败、未知参数/缺值、非法数据根、非法停止选项结构、监听地址覆盖参数/env、发现/凭据文件本地校验不安全或损坏（`unsafe_discovery`/`invalid_discovery`，尚未联网） |
| 3 | 连接 / 协议错误 | `host_not_found`、不可达、连接/确认超时、畸形/超限响应、收到 3xx、`protocol_incompatible`、`unsupported_schema_version`（对端）、假服务握手不符、`start_timeout` |

- 细分原因只看 `error.code`；退出码保持四档粗分类。同用户恶意进程不在强隔离保证内，
  错误文案不泄露秘密。
- `stop` 不得把 HTTP completed/accepted 或连接断开显示为已退出；必须按 §10.6 报告。
- 帮助文本必须准确说明：退出客户端不会停止 Host；停止需显式 `host stop`；首版仅 macOS、
  可信本机边界、token 不防所有同用户攻击。

### 13.4 依赖与构建边界（新增代码必须遵守）

- F-006 在 host 包导入 `shiploop-core/assembly` 时，同时在 `packages/host/package.json`
  声明 `"shiploop-core": "0.0.0"`；F-009/F-012 CLI 使用 Host 公共面时声明
  `"shiploop-host": "0.0.0"`。版本随工作区固定，不引入新第三方依赖（如确需，必须先在本契约
  或后续契约中显式批准；Node 内置 HTTP 能力仅允许在 host 包 src 的非契约区使用）。
  F-003 结论：存储层不依赖 `shiploop-core`（默认根由调用方按 P01 `deriveDefaultDataRoot`
  预推导后传入），以免干净树（无 dist）下 `npm run typecheck` 失效；F-006 引入该依赖时
  须同时解决干净树类型检查路径（如构建顺序或引用调整），不得回归 P01 的干净树检查。
  **F-006 定案**：host 包已声明 `"shiploop-core": "0.0.0"`，生产源码经包名与
  `shiploop-core/assembly` 公共入口导入。干净树解析路径：(a) 根 `tsconfig.json`
  以 `paths` 把两个公共入口说明符精确映射到 Core 源码（仅 noEmit 类型检查使用）；
  (b) `vitest.config.ts` 以精确 alias 做同一映射（测试进程直接运行 packages/ 源码）；
  (c) 测试子进程加载器 `test/helpers/node-ts-loader/hooks.mjs` 对同样两个精确说明符
  做源码重映射（干净树下真实子进程测试）。生产构建/运行仍由 node_modules 工作区
  链接解析到 dist 产物；host `tsconfig.json` 以 project reference 引用 core
  （TS 7 原生编译器不保证独立项目的构建顺序，reference 保证 core 先于 host 发射，
  并把 dist 声明重定向到源码），已实测全干净树（三包 dist 均移除）下 `npm run build`
  退出 0；同时实测干净树下 `npm run typecheck` 与 `npm test` 退出 0。
- 公共包 import 持续无副作用；显式入口须能从 dist、非源码 cwd 启动。
- 新增测试进入 `npm test` 默认收集（`test/` 下，helpers 放 `test/helpers/`）；
  不修改 verify 的步骤定义，不为本 Feature 增加 `accept:p02`。

## 14. 错误码与 HTTP 映射总表

| code | HTTP | 触发点 | 备注 |
|---|---|---|---|
| `invalid_input` | 400 | 结构/类型/未知字段/JSON 畸形/GET 带体 | 不回显原文 |
| `unsupported_schema_version` | 400 | 未知消息/发现 schemaVersion | 不降级 |
| `request_digest_mismatch` | 400 | stop 摘要核对失败 | |
| `request_too_large` | 413 | 体积超 16 384 B | |
| `unauthorized` | 401 | 缺失/错误/陈旧 token、Origin/Host 不符 | 子原因不可区分 |
| `forbidden` | 403 | 认证通过但授权拒绝（本版本无额外授权层，预留） | |
| `instance_mismatch` | 409 | 预期实例与当前实例不同 | 零副作用 |
| `data_root_mismatch` | 409 | 数据根身份不同 | 零副作用 |
| `conflict` | 409 | 同 commandId 不同摘要 | 零副作用 |
| `resource_busy` | 409 | quiesce 未确认 / 已有停止在途 | 保留锁与隔离 |
| `not_ready` | 503 | starting 时收到 stop | |
| `protocol_incompatible` | 426 | protocolVersion 不兼容 | details 给支持版本 |
| `unsupported` | 501 | 请求未实现能力/停止选项/SSE/项目命令 | 不猜默认实现 |
| `unknown_operation` | 404 | 未知路由 | |
| `method_not_allowed` | 405 | 路由存在但方法不支持 | 错误体给允许方法 |
| `internal` | 500 | 服务端未预期错误 | 仅脱敏消息，无堆栈 |

仅客户端侧（无 HTTP 响应）的码：`host_not_found`、`unreachable`、`response_malformed`、
`redirect_rejected`、`owner_active`、`owner_unknown`、`unsafe_discovery`、`invalid_discovery`、
`start_timeout`、`stop_not_confirmed`、`bind_address_override_rejected`、`unsupported_platform`。
客户端不得把这些不同情况统一折算成「发现不存在」。

## 15. 需求与测试编号映射

### 15.1 FR 分支映射

| 需求 | 正常分支 | 关键失败分支（每项至少一正一负） |
|---|---|---|
| FR-1 启动与发现 | 获锁→开 Core→Schema→回环端口→原子发现；重复 start 接同一实例 | 多候选竞争唯一持锁者；路径别名同锁；错误/陈旧发现；假服务；持锁但发现缺失（owner_unknown）；公网覆盖被拒；崩溃后释锁重获 |
| FR-2 认证与停止 | Bearer 握手双向核验；只读 status；显式 stop 收尾→清理→释锁→退出 | 缺失/错误/陈旧 token；错误实例/数据根；协议不兼容；外部 Origin/Host；同 ID 不同摘要 conflict；重复 stop 幂等；stop 未确认保留锁；客户端退出 Host 存活；SIGTERM 安全收尾 |

### 15.2 设计 09 验收编号（本 Feature 只认领子集）

| 编号 | 设计 09 行为 | P02-1 覆盖结论 |
|---|---|---|
| T10 | 项目隔离、审批、凭据脱敏和不可信内容 | **仅凭据基础子集**：发现/凭据文件 0600/0700、Bearer-only、错误与日志不泄密、Origin/Host 拒绝；审批与项目隔离不属本 Feature |
| T15 | init 重复/中断/移动/已有失败/多 clone，归档删除边界 | **仅 Host 单例基础子集**：重复 start 接同一实例、启动中断不残留、规范根别名（移动等价类）、多候选/多客户端；项目注册语义不覆盖 |
| T17 | Host 竞争、认证、协议版本、客户端退出 | **本 Feature 完整覆盖**（多进程真实子进程） |
| T23 | 本地 Host 不可改公网监听，配置/env/CLI 覆盖被拒绝 | **本 Feature 完整覆盖**（0.0.0.0/::/非回环 IP/域名） |
| T26 | 见 §15.4 | **仅「版本化 stop 幂等」行为子集** |

### 15.3 覆盖纪律

- 映射按**行为**而非编号字面：FR-1/FR-2 的正常与失败分支必须进入 F-013 的真实多进程回归；
  not_run 显式记录，不折算通过。
- 不声称项目接入、执行取消、SSE、Web 配对或整个 P02 已验收；`npm run accept:p02` 属阶段末项。

### 15.4 T26 编号不一致记录（按行为映射，请求核对）

- **PRD（`p02-host-lifecycle.md` v0.2 §3.3）原文**：「本阶段设计验收索引：T10基础、T15基础、T17、T23、**T26命令幂等**」——
  此处把 T26 当作「命令幂等」。
- **设计 09（`core-design/09-testing-and-implementation.md` §2）T26 原文**：「当前配置 CAS 冲突、
  计划修改禁止越过活动执行、过期审批失效」——是配置/计划/审批的并发行为；其「重复请求」语义
  另由 T03（原子认领、并发冲突、重复请求、状态事件事务一致）承载。
- 另：设计 08 §2 与 12 §4 明确命令幂等规则：同 commandId + 同请求摘要返回原回执，同 ID 不同
  摘要为 conflict；`command_receipts` 为后续持久表。P01-4 已实现设计-09 T26 的**配置 CAS 子集**
  （见 `docs/p01-4-operations.md` 的 T03/T24/T26/T32 子集声明），与本 Feature 无关。
- **F-001 判定**：这是**文档编号不一致**，未发现必须停工的语义冲突——P02-1 需要的「命令幂等」
  行为在设计 08/12 有独立依据，本文 §10.4 已将其范围冻结为「同一实例 stop 的进程内版本化
  去重 + 身份冲突」，明确**不**扩建项目命令回执体系、不实现设计-09 T26 的配置 CAS/计划/审批行为。
- **请求核对**：请负责人/审阅确认 PRD 的「T26命令幂等」指向设计 08/12（及 T03 重复请求）的幂等
  语义，而非设计 09 §2 的 T26；若原意是后者，P02-1 不覆盖且应改写 PRD 索引。确认前实现按
  §10.4 行为执行，不自行扩大解释。

## 16. 对后续任务的契约约束（摘要）

| 任务 | 必须遵守的本契约条目 |
|---|---|
| F-002 类型与校验 | §3.2 身份算法、§5 发现、§7 版本/错误、§8–§10 消息形状；纯模块无副作用 |
| F-003 受保护文件存储 | §3.3 布局与权限、§4 凭据、§5.2 原子发布与 fail-closed、按实例清理 |
| F-004 OS 锁 | §6 全部；真实 macOS 锁、获锁先于写库、owner_active/owner_unknown |
| F-005 沙箱夹具 | 真实临时根/伪服务/屏障/脱敏；不得使用真实 HOME |
| F-006 Host 入口 | §11 启动顺序、§5.2 发布时机、T23 覆盖、失败逆序关闭 |
| F-007 认证握手/status | §7.2、§8、§9；负例零副作用 |
| F-008 stop/quiesce | §10 全部；窄活动端口、幂等矩阵、完成判据、SIGTERM |
| F-009 HostClient | §12 全部；握手前不发业务请求、断线不 stop、不跟重定向 |
| F-010 连接或启动 | §12.4、§6 owner 诊断；detached、无 shell、失败不残留进程 |
| F-011 CLI 解析 | §13.1–§13.3；表驱动、帮助文本、零副作用公共模块 |
| F-012 纵向命令 | §13 全部 + §10.6；dist/非源码 cwd 冒烟 |
| F-013 多进程回归 | §15 映射；证据脱敏；`npm run verify` 全 0 |
| F-014 文档与交接 | 操作示例只用构建入口；安全边界同 §2.2/§13.3；不提供虚假 accept:p02 |

任何任务发现本文与实际需求/设计冲突，记录依据并请求核对，不擅自改协议或领域语义。

## 17. 待核对事项与引用版本

### 17.1 待核对 / 后续定案项

1. **T26 编号语义**：见 §15.4，需负责人确认 PRD 索引指向。
2. **锁实现形态已由 F-004 定案**：实际 Node 写入者通过极小 N-API 适配器直接持 macOS
   flock fd，无辅助者；真实同步竞争、正常退出、SIGKILL/SIGABRT 与未确认关闭保锁测试落实 §6。
   原生构建/发布边界见写入锁决定；其他平台与正式二进制分发未验收。
3. 数值预算（16 384 B、2s/10s/15s、10s quiesce、15s 启动等待）为首版有限默认值；
   实现可在有测试依据时调整并回写本文，不得改为无界，也不得开放为用户可配的监听/安全放宽项。
4. 未来项目命令路由（`/v1/...`，设计 08 候选名）与 SSE 在 P02-2 契约中定案；本文不冻结其字段。

### 17.2 输入文档版本

| 文档 | 版本/日期 | 用途 |
|---|---|---|
| `features/2026-10-04-23-19-52_p02-1-host/input/p02-host-lifecycle.md` | v0.2，2026-10-01 | 本 Feature PRD（FR-1/FR-2、验收标准） |
| `features/…/input/execution-contract.md` | 2026-10-01 | 共同执行约束 |
| `core-design/08-host-api-and-cli.md` | 2026-09-24 草案 | 单例发现、命令幂等、CLI 退出码建议 |
| `core-design/12-end-to-end-flows.md` | 2026-09-28 | §4 发现认证、§13 取消、§17.2 停 Host/升级 |
| `core-design/02-domain-and-lifecycle.md` | 2026-09-24 草案 | 状态语义（Run/Batch 状态不属本 Feature） |
| `core-design/04-scheduling-and-recovery.md` | 2026-09-24 草案 | §2 占用模型、§4 取消、§5 重启恢复 |
| `core-design/03-storage-and-transactions.md` | 2026-09-24 草案（含 2026-10-01 S2 记录） | §4 数据根布局（`host/`）、§5 幂等 |
| `core-design/01-system-structure.md` | 2026-09-24 草案 | §2 包与进程、§5 保护边界 |
| `core-design/05-runtime-and-session-recording.md` | 2026-09-24 草案（含 2026-10-01 S4 记录） | §10 外部宿主边界（不放宽本机约束） |
| `core-design/09-testing-and-implementation.md` | 2026-09-24 草案（2026-10-01 S1–S5 更新） | T 编号表、S3 lockf Spike 事实 |
| `08-migration-roadmap.md` | 2026-10-01 更新 | P02 所处 R1 边界与首版限制 |

S3 Spike 事实仅作方案依据：macOS `/usr/bin/lockf`、8 路竞争 1 胜、退出码 75、
0600/0700 权限、401/409/426 拒绝分支已在隔离实验观察到；其 HTTP 字段名（如 `discoveryVersion`、
`/v1/handshake`、`rootIdentity`）**不是**生产协议，生产字段与路由以本文 §5、§8–§10 为准。

