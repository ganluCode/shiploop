# P01 持久化闭环验收操作说明

- 适用阶段：P01（持久化闭环：项目身份、当前配置、制品落盘与关闭重开）。
- 适用平台：macOS（首个正式支持平台，本轮唯一正式验收平台）；Windows / WSL / Linux 另行验收。
- 设计依据：Harness 知识目录 `architecture-redesign/`（版本见
  [acceptance/p01-4-f010-report.md](acceptance/p01-4-f010-report.md) §1 的 SHA-256 清单）与
  PRD `p01-acceptance.md`（版本 0.2）。验收约定与检查清单见
  [p01-4-acceptance-contract.md](p01-4-acceptance-contract.md)。
- 本文只描述**已实现并已验收**的 Core 能力与真实可复跑命令；未提供的 Host / CLI 业务命令
  一律不编造。完整证据、受测 commit 与退出码见
  [acceptance/p01-4-f010-report.md](acceptance/p01-4-f010-report.md)。

## 1. 范围与入口

P01 交付可在 macOS 上独立运行的 **Core 持久化闭环**：经受控装配入口取得应用服务，
在受控数据根内注册真实 Git 仓库、写入全局/项目当前配置、发布制品，并在关闭重开后逐字段
一致；同时覆盖事务回滚、配置 CAS 竞争、制品缺失/恢复与项目标签。

| 能力 | 端口 / 用例 | 位置 |
|---|---|---|
| 组合根 | `openCoreApplication(options)` → `CoreApplication` | `packages/core/src/adapters/composition.ts`，经 `shiploop-core` 的 `./assembly` 子路径导出 |
| 项目身份 | `ProjectService`（注册 / 查询 / CAS 编辑 / 标签筛选 / 计数） | `packages/core/src/application/project-service.ts` |
| 当前配置 | `ConfigurationService`（创建 / CAS 更新 / 查询 / 有效合并 / 脱敏导出） | `packages/core/src/application/configuration-service.ts` |
| 制品 | `ArtifactStore` / `ArtifactFileStore` / `createArtifactPublisher` / `createArtifactVerifier` | `packages/core/src/ports/*`、`application/artifact-publish.ts`、`application/artifact-verify.ts` |
| 路径 | `PathService`（数据根 / 项目目录 / 受权定位） | `packages/core/src/adapters/fs/path-service.ts` |
| 存储 | `StateStore`、SQLite 事务与版本化迁移（v1 六表 + v2 `state_events`） | `packages/core/src/adapters/sqlite/*` |

阶段验收**只经上述产品公共入口**执行，不以验收脚本直接插业务行替代。本阶段**没有** Host
网络接口、CLI 业务命令、Runtime / Pi SDK 模型调用、执行表或 DAG 调度。

## 2. 先决条件

- 受控源码快照（无 `node_modules` / `dist` 残留），锁定版本由 `package-lock.json`（`lockfileVersion` 3）固定。
- Node.js `22.19.0`（`.nvmrc` / `.node-version`）、npm `10.9.3`（`packageManager` + `engine-strict`）、
  Git（仓库检查使用真实 `git`，本轮记录 `2.50.1 (Apple Git-155)`）。
- `npm ci` 需要网络或已填充的 npm 缓存；运行期不调用模型、不执行 `npm publish`。
- 夹具准备期真实探测 `git --version` 与 SQLite `sqlite_version()`；任一必需工具缺失**显式失败**
  而非跳过。

## 3. 命令

干净快照中按顺序执行；每条命令真实退出码为 0 才算通过（`npm run verify` 已串联前三项）：

```bash
npm ci                 # 按 package-lock.json 干净安装（锁定 47 packages）
npm test               # 本地校验 vitest@5.0.3 后一次性执行全部测试（passWithNoTests:false）
npm run typecheck      # strict 类型检查，覆盖 src / test / scripts
npm run build          # tsc -b 构建三个包 + 构建入口冒烟（含 dist ./assembly 冒烟）
npm run verify         # 工程检查编排：锁文件预检 + test / typecheck / build 全绿才返回 0
npm run accept:p01     # P01 阶段验收：verify + 四个固定场景 + 构建冒烟 + 版本化报告
```

- `npm run verify` 是**工程检查编排**，不是业务 Verifier，也不等于阶段验收通过。
- `npm run accept:p01` 是 **P01 阶段验收入口**，串联 `verify` 与必需检查组并输出报告。
- 可复现的干净安装复跑工具为 `scripts/acceptance/clean-snapshot-replay.ts`（见 §7）。

## 4. accept:p01 配置、CLI 与报告位置

执行配置为版本化文件 [`acceptance/p01.config.json`](../acceptance/p01.config.json)：

- `configVersion`：配置 Schema 版本（当前 `1`），未知版本拒绝。
- `reportRoot`：报告根目录（默认 `artifacts/acceptance/p01`，相对仓库根）。
- `requiredChecks`：有序必需检查 ID（14 项，见 §5）。运行时校验拒绝未知版本、非正超时，
  以及任何试图移除/关闭/重排必需检查的配置；CLI/环境变量只能**覆盖**，不得放宽必需检查集合。
- `timeouts`：有限毫秒预算（`verifyMs` / `scenarioMs` / `smokeMs` / `overallMs`）。
- `plan` / `priorBaselines` / `schemaVersions`：输入计划版本与摘要、前序基线 commit、
  settings / 导出 / SQLite 迁移版本声明。

CLI 覆盖（显式 `argv`，未经不可信 Shell 拼接）：

```bash
npm run accept:p01 -- --run-id <id> --report-dir <dir> \
  --step-timeout-ms <ms> --verify-timeout-ms <ms> --config <path>
```

环境变量：`SHIPLOOP_ACCEPT_P01_RUN_ID`、`SHIPLOOP_ACCEPT_P01_REPORT_DIR`、
`SHIPLOOP_ACCEPT_P01_STEP_TIMEOUT_MS`，并复用 `SHIPLOOP_VERIFY_STEP_TIMEOUT_MS`。

报告目录：`<reportRoot>/<run-id>/`（每次运行独立、互不覆盖）：

- `report.json`：版本化机器可读报告（`reportSchemaVersion=1`，与摘要同源）；
- `summary.md`：简明可读摘要；
- `evidence/`：清理临时资源**之前**写出/序列化的证据副本（逐项 `sha256` / `sizeBytes`）。

`run-id` 形如 `<UTC YYYYMMDDThhmmssZ>-<8 hex>`，必须匹配
`^[A-Za-z0-9][A-Za-z0-9._-]*$`、不含路径分隔符；非法或已存在的 `run-id` 被拒绝。
示例：`artifacts/acceptance/p01/20261002T225338Z-e417cf37/{report.json,summary.md,evidence/}`。
报告内证据引用一律为报告目录内**相对路径**；命令 `argv`/`cwd` 使用逻辑位置
（`<node>` / `<npm-cli>` / `<repo>`），不写个人绝对路径。

## 5. 必需检查与结果含义

14 个稳定必需检查 ID（与执行配置 `requiredChecks` 顺序一致）：

| 检查 ID | 分支 | 承接测试 / 命令入口 |
|---|---|---|
| `P01-ENG-VERIFY` | 工程 | `npm run verify`（test / typecheck / build） |
| `P01-FR1-NORMAL` | FR-1 正常 | `test/p01-4-persistence-closed-loop.test.ts` |
| `P01-FR1-REOPEN` | FR-1 重开 | 同上 |
| `P01-FR1-ROLLBACK` | FR-1 回滚（预期负例） | `test/p01-4-sqlite-rollback-and-cas.test.ts` |
| `P01-FR2-CONFIG` | FR-2 正常/拒绝（预期负例） | `test/p01-4-config-and-tags.test.ts` |
| `P01-FR2-ROLLBACK` | FR-2 回滚（预期负例） | `test/p01-4-sqlite-rollback-and-cas.test.ts` |
| `P01-FR2-CAS` | FR-2 CAS 竞争 | 同上 |
| `P01-FR2-TAGS` | T32 项目标签 | `test/p01-4-config-and-tags.test.ts` |
| `P01-FR2-ARTIFACT-MISSING` | FR-2 制品缺失（预期负例） | `test/p01-4-artifact-negative.test.ts` |
| `P01-FR2-ARTIFACT-RECOVERY` | FR-2 制品恢复 | 同上 |
| `P01-PHASE-FIXTURE` | 夹具失败 | `test/p01-4-acceptance-controller.test.ts` |
| `P01-PHASE-NOT-RUN` | 必需检查未运行 | `test/p01-4-report-aggregation.test.ts` |
| `P01-ENG-BUILD-SMOKE` | 构建产物 | `test/p01-4-build-smoke.test.ts` |
| `P01-PHASE-REPORT` | 报告完整性 | `test/p01-4-report-aggregation.test.ts` |

结果状态只有三种：

- `pass`：命令/断言真实通过；**预期负例**必须同时满足「预期错误」与「零副作用的副作用断言」
  才计 `pass`，仅有错误类型不算通过。
- `fail`：步骤非零退出、断言失败或夹具失败。
- `not_run`：未提交结果、启动失败（`startup_failure`）、超时（`timeout`）或跳过（`skipped`）；
  未启动的必需步骤一律 `not_run`，**绝不**默认成功。

聚合：任一必需检查 `fail` 或 `not_run`、证据缺失/损坏、报告写入失败 → 阶段结论非通过且
`accept:p01` 非零退出；空结果集不得聚合为通过。报告同时列出阶段外能力（`P01-OOS-*`：
模型 Live、强 OS 沙箱、非 macOS、Host/CLI），仅 `not_run`/`unsupported`，**不计入必需项通过数**。

## 6. 临时资源与安全边界

- 夹具每次在系统临时目录创建独立根：隔离临时 `home/`、受控 `data-root/` 与真实 Git 仓库，
  路径含 Unicode/空格；不读取用户 Git 全局配置、凭据或真实数据根。
- 只删除本次持有且位于临时授权根内的资源；拒绝用户仓库、未知根与符号链接逃逸；根外哨兵
  文件保持不变。证据先写入独立报告目录，再删除临时业务资源——业务根删除后证据仍可读。
- 证据文本按快照根/仓库根/用户目录/临时目录替换为逻辑占位符（`<SNAPSHOT-ROOT>` /
  `<REPO-ROOT>` / `<HOME>` / `<TMPDIR>`）；报告与证据不含凭据、执行就绪标记或开发机绝对路径。
- **可信项目模式 ≠ 强 OS 沙箱**：首版为用户明确授权的可信项目模式，要求强隔离
  （`strong_sandbox`）被明确拒绝，不静默降级。

## 7. 干净安装复跑

在**无 `node_modules` / `dist` 残留的已提交干净快照**中复跑（源仓库工作树必须 clean；
dirty 检查结果不能冒充已提交基线）：

```bash
node scripts/acceptance/clean-snapshot-replay.ts \
  --root . --out docs/acceptance/evidence-p01-4
```

工具行为：

1. 校验源仓库工作树 clean，解析受测 `commit`/`branch`；
2. `git clone --no-hardlinks` 到系统临时目录并 `checkout --detach <commit>`，断言快照无
   `node_modules` / `dist`；
3. 依次真实运行 §3 命令，**连续两次** `npm run accept:p01`（验证运行之间无残留依赖）；
4. 每条命令的脱敏日志、退出码、耗时写入 `logs/` 与 `commands.json`，环境事实写入
   `environment.json`；两次 accept 的 `report.json` / `summary.md` 复制到
   `accept-runs/accept-1|accept-2/`；任一命令非零或报告非 `pass` 即返回非零；
5. 仅删除本次创建的临时快照（授权根 + 非符号链接校验）。

## 8. 失败与复跑

- 某必需检查失败：`accept:p01` 非零退出，报告仍写出并保留已取得证据；从报告
  `checks[].status` / `notRunReason` 与 `commands[].exitCode` 定位首个失败步骤。
- **修复后复跑**：先修实现/测试（不得删测试、降低门槛或把 `skipped` 转 `pass`），提交后
  重新执行 `npm run accept:p01`；如需阶段级干净复跑，执行 §7 并比较两次 `report.json`。
- 超时：控制器对整体进程组 SIGKILL 并核验停止后再清理；可用 `--step-timeout-ms` /
  `--verify-timeout-ms` / `SHIPLOOP_ACCEPT_P01_STEP_TIMEOUT_MS` 调整有限预算（不得放宽必需检查集合）。
- 报告目录已存在：拒绝覆盖，换 `--run-id`；报告写入失败非零且尽力回收半成品目录。
- 工具缺失（git / better-sqlite3 驱动等）：准备失败，`P01-PHASE-FIXTURE` `fail`、其余
  `not_run`，报告保留配置/环境快照，阶段非零。

## 9. 实际 Core 调用范围

阶段验收真实调用（经 `shiploop-core/assembly` 的 `openCoreApplication`）：

- 命令（写）：`registerRepository`、`updateProjectMetadata`、`createSettings`、`updateSettings`、
  `publishArtifact`（`createArtifactPublisher`）。
- 查询（读）：`getProject`、`getRepositoryBinding`、`listProjects`、`countProjectLabels`、
  `getCurrentSettings`、`getEffectiveSettings`、`exportSettings`、`locateProjectResource`、
  `readVerifiedContent`（`createArtifactVerifier`）。
- 目标身份只来自 `scope` 或显式 `projectId`；`credentialRef` / `endpointRef` 只传引用字符串；
  命令失败不得把回滚后的旧值/日志当作新状态。

## 10. T03 / T24 / T26 / T32 覆盖子集

P01 只覆盖下列**子集**，不冒充完整验收，也不提前建执行表：

| 索引 | P01 实际覆盖 | 明确不覆盖（后续） |
|---|---|---|
| T03 | 当前存储原子性/竞争子集：组合创建/配置写入失败整组回滚、跨进程 CAS 恰一胜者、失败重开无残留 | 活动执行锁、Run/Attempt 认领与取消、迟到结果 |
| T26 | 当前配置 CAS 基础：insert-only、`expectedRevision` 条件写入、`stale_dependency`、脱敏审计同事务 | 完整配置历史版本表、跨层策略编排 |
| T32 | 项目标签：规范化、非法输入拒绝、任一/全部筛选、去重计数 | Phase/Feature/Task 层级标签与跨层求和、按标签启动 Batch |
| T24 | 默认/完整策略与**来源基础**：完整条目整体替换、政策段级覆盖、逐项来源 | 完整 **Task 策略复制**（`tasks.execution_config`）属 P03 |

## 11. 未实现 / not_run（不得冒充）

- Host 网络接口（HTTP/SSE）与认证、CLI 命令与参数解析：未实现。
- Runtime / Pi SDK 与模型调用（Live）、完整执行表（Phase/Feature/Task/Run/Attempt/Batch/Session）、
  DAG 调度与认领、桌面端、强 OS 沙箱、rebind / 源代码迁移、存量基线扫描：未实现 / `not_run`。
- Windows / WSL / Linux：`not_run`（macOS 是唯一正式验收平台）。
- 阶段外能力以报告 `P01-OOS-*` 标注，不计入 P01 必需项通过数。

## 12. 验证

仓库级验证：`npm test`（开发内循环）；`npm run verify`（锁文件预检 + test / typecheck / build
串联，fail-closed）；阶段验收：`npm run accept:p01`。本文引用的命令、检查 ID、配置字段与
证据形态由 `test/p01-4-delivery.test.ts` 交叉核对，防止文档与实现漂移。
