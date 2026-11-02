# P08-2 F-007 干净安装目录启动打包 CLI 的 Todo 演示安装冒烟

`scripts/acceptance/p08-todo-install-smoke.ts` 在全新的干净安装目录里只用本地打包 tarball（`npm install --offline`，不访问 registry）安装 `shiploop-core/host/cli` 三包，启动安装产物中的 CLI 入口，核对发布产物、入口、运行依赖、数据目录隔离与 CLI 协议和源码模式一致。它是 fail-closed 工程检查器，不是 ShipLoop 业务 Verifier；`passed=false` 时不得宣称安装验收通过。

## 1. 入口与前置

真实三包产物的执行顺序（在已提交、干净的源码仓库副本内）：

```sh
npm ci
npm run build                                # 源码模式基线 packages/cli/dist/bin.js
npm run pack:local -- --output artifacts/local-pack
npm run verify:artifacts                     # 制品完整性先行把关
node scripts/acceptance/p08-todo-install-smoke.ts \
  --input artifacts/local-pack \
  --output artifacts/local-pack/todo-install-smoke.json
```

- 工具链固定 Node `22.19.0`、npm `10.9.3`、平台 `darwin`；漂移直接退出码 2。
- 缺分发清单、缺 `distribution-compatibility.json` 或缺源码基线 dist 时以结构化错误退出码 2 拒绝，不产生报告。
- 退出码 0 仅当全部检查 `passed`；报告写入 `<input>/todo-install-smoke.json`（默认）。

unit 守护测试（`test/modules/acceptance/p08-2-f007-todo-install-smoke.test.ts`）不依赖真实三包产物：使用打包夹具 CLI（`test/helpers/p08-2/todo-fixture-pack-cli.mjs`）经真实 `npm pack` 生成 tarball 与分发清单，在真实临时沙箱中执行真实 `npm install --offline` 与真实子进程，验证检查器全部判定路径。

## 2. 检查项（12 项，状态仅 passed/failed）

| id | 内容 |
|---|---|
| `distribution-inputs` | 分发清单存在、三包 tarball 名称/摘要/逐文件清单复验（复用 pack-local `validateDistributionManifest`） |
| `compatibility-declared` | 协议兼容声明存在且线协议/Schema 范围可用 |
| `clean-install-offline` | 全新安装目录 `npm install --offline` 成功；安装目录符号链接不得逃逸安装目录（拒绝源码链接/开发机依赖证据） |
| `packaged-entry-startable` | 安装产物 `node_modules/shiploop-cli/dist/bin.js` 存在、shebang、可执行位、`.bin/shiploop` 链接，且完成 `started` 握手回执 |
| `runtime-dependency-inventory` | 顶层 `node_modules` 清单记录；三包工作区包版本与分发清单一致 |
| `isolated-data-root` | 安装/源码两模式各用独立数据根；实例身份与数据根身份互不相同；发现/token 只落在各自根内 |
| `minimal-command-receipt` | `host start/status` 成功信封、`host status`（无实例）`host_not_found` 结构化拒绝（退出码 3）、`host stop` 确认 `stopped` 且发现移除 |
| `protocol-scope-consistent` | 实测 `protocolVersion`/discovery `schemaVersion` 处于 `distribution-compatibility.json` 声明范围 |
| `protocol-consistency-with-source` | 打包模式与源码模式（`packages/cli/dist/bin.js`）的稳定协议字段一致 |
| `secret-handling` | auth token 为 64 位 hex、文件 0600，绝不出现在任何命令输出中 |
| `output-hygiene` | 命令输出不含绝对路径/`Bearer ` 形态 |
| `report-hygiene` | 报告本身不含绝对路径/凭据材料 |

## 3. not_run 边界（owner=phase-integration）

`real-registry-install`（经 registry 的真实安装与网络矩阵）、`native-module-matrix`（better-sqlite3/Host 原生写入锁全新机器构建加载）、`git-integration`（Todo 演示 Git 全链）、`sqlite-business-flows`（真实 SQLite 业务/迁移/备份矩阵）、`cross-process-matrix`（并发 CLI、崩溃恢复、双 Host 竞争）、`todo-live-delivery`（真实 Pi live 交付，`accept:p08:live`）。以上不折算为通过，安装冒烟不替代 Phase 集成验收。

## 4. 失败处理

- 任一检查 `failed` 时报告 `passed=false`、入口退出码 1；分发输入缺失/不可读时结构化错误退出码 2，不伪造报告。
- 保留完整 stdout/stderr 与报告 JSON；不覆盖之前的失败记录；不要通过改摘要、删检查或放松脱敏放行。
- 夹具违约注入（`dist/fault.json`：`leak-token`/`absolute-path`/`protocol-drift`）仅用于验证检查器判定，不得写入真实三包。
