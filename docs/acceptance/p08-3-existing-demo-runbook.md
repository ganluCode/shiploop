# P08-3 非 Nezha 存量演示运行手册

用途：给执行者和审阅者一个可复现的存量项目（非 Nezha 创建或维护的小仓库）演示流程：确认基线、
做一次有限增量、保存证据、处理失败、归档重开。配套结果是
[P08-3 演示结果报告模板](p08-3-demo-report-template.md)。

本手册不产生验收结论。Task 状态 completed、Nezha completed、测试数量、退出码 0 或
日志里出现成功文字，都不是产品验收；真实 Pi 执行、Phase 真实 Git/SQLite/Host/进程集成验收和
负责人签署各自是独立门槛，未执行一律记为 `not_run`。本手册不修改 P08-4 阶段报告，也不声称
阶段集成已执行。

## 1. 三层执行与各自含义

| 层级 | 范围 | 当前可复现入口 | 结果含义 |
| --- | --- | --- | --- |
| 夹具与契约层 | 真实临时 Git 仓库、存量检查定义与结果、证据封套、增量与生命周期契约 | `node scripts/run-tests.ts <定向测试文件>`（见 §10） | 只证明该契约/夹具行为；不是产品闭环 |
| 产品级手动演示 | 安装的 `shiploop` CLI + Host + 用户仓库 + 真实 Pi | CLI 步骤见 [新用户安装与操作指南](../p08-1-user-guide.md)；真实 Pi 另需授权 | 逐条命令记录退出码与证据；未跑项 `not_run` |
| Phase 集成验收 | 真实 Git/SQLite/Host/进程/停止/恢复组合 | `accept:p08` 阶段入口；没有自动人工签署 | 由负责人执行并签署；本手册不代替 |

真实 Pi live 现有唯一实现入口是 Todo 演示的 `npm run accept:p08:live -- --approval <批准文件>`
（见 [accept:p08:live 入口](../p08-2-live-acceptance-entry.md)）。存量增量变更**没有**已实现的
真实模型入口：它属于独立授权项，未获授权时保持 `not_run`，不得用 Todo live 报告或夹具通过代替。

## 2. 准备

- 平台：正式支持 macOS；Windows/WSL/Linux 不作为当前通过条件。
- 工具链：发布基线为 Node 22.19.0、npm 10.9.3；Node `engines` 为
  `^22.19.0 || ^24.14.1 || ^26.7.0`，npm 范围为 `>=10.9.3 <12`，
  `packageManager` 为 `npm@10.9.3`。不升级 Node、不切换包管理器、不顺手 `npm ci` 重装。
- 仓库：优先在系统临时目录新建小仓库；也可以使用用户自有小仓库。**禁止**在 ShipLoop 开发仓库
  或 Harness 元数据目录做破坏性演练。
- 依赖与网络：演示前确认所需命令存在；缺失依赖不得现场安装后当成通过，见 §7。
- 数据根：使用隔离的临时数据根，不复用开发机既有业务数据。

### 2.1 准备快照（未记录不得开始变更）

必须在任何变更前记录并保存：

1. `HEAD` 与 `tree` 提交 SHA；
2. `git status --porcelain` 原文，以及脏文件按 `modified_staged` / `modified_unstaged` /
   `untracked` 分类与文件内容摘要；
3. 仓库已有检查：命令、实际退出码、已知失败 ID（`known_failure`）；
4. 仓库身份：`projectId` 与仓库路径摘要（摘要可入报告，绝对路径不入报告）；
5. 仓库外无关旧状态文件的摘要，用于证明清理没有波及仓库外内容。

夹具层可用 `test/helpers/p08-3/legacy-todo-fixture.ts` 的 `createLegacyTodoFixture` 生成等价的
真实临时仓库与基线快照（固定初始提交、可执行既有检查、确定失败检查、三类脏文件、`dispose()`
只删除夹具自有目录）。

### 2.2 需求范围与获准策略

- 需求必须小且单一；写明说明和**批准路径**列表，至少包含一个 code 文件和一个 test 文件，
  列表之外一律视为越界（`increment_scope_invalid` / `out_of_scope_change`）。
- 获准信息固定为：`projectId`、仓库路径摘要、批准路径、显式确认（`confirmed`）。初始化前后
  必须核对 `HEAD` 与脏状态未变；**禁止自动提交**（`automatic_commit_forbidden`）。
- 不改既有失败断言的期望值、不删测试、不跳过检查来换取通过。

### 2.3 检查范围

- 演示门槛 = 新需求定向检查 + 基线已有检查；不把全仓历史矩阵当成本演示必需项。
- 命令不可执行（缺命令、无权限）记 `not_run`，并记录原因码（如 `missing_command`、
  `permission_denied`）；退出码非 0 记 `failed`，不能记 `not_run` 蒙混。
- 检查范围与忽略项要写进报告；全仓 `npm run verify` 属于显式工程门禁，不是本演示的默认步骤。

### 2.4 清理责任

- 执行者负责：临时仓库、临时数据根、Host 停止确认、进程检查、日志与证据目录。
- 用户自有仓库：默认**保留**；只保留批准的增量提交，预存脏文件保持原样，不 stash、不清理。
- 清理动作本身也要留证据；清理前先确认没有存活进程，见 §7「停止未确认」。

## 3. 注册与基线确认（产品级）

注册与基线授权是两次独立的显式确认；预览只读，不要在没有用户确认时加 `--confirm`。

```sh
node packages/cli/dist/bin.js project init <repository-path> --json
node packages/cli/dist/bin.js project init <repository-path> --name <displayName> --confirm --json
node packages/cli/dist/bin.js baseline preview --project <projectId> --input <plan-file> --json
node packages/cli/dist/bin.js baseline run --project <projectId> --input <plan-file> --confirm --json
node packages/cli/dist/bin.js project overview <projectId> --json
```

- 预览必须原样展示 `HEAD`、脏状态与既有项目；注册成功不等于基线健康（仍是 `not_run`）。
- 用户拒绝或未确认时记录 `not_run`，不得折算成功。
- 基线结果逐项记录：检查 ID、退出码、证据引用、已知失败。夹具/契约层对应的校验入口是
  `scripts/acceptance/p08-existing-demo.ts` 的 `evaluateExistingRepoInitialization`
  与 `createExistingRepoReport`。

## 4. 有限变更

1. 只改批准路径；新增文件也必须在批准列表内。
2. 运行定向检查，保存完整日志、真实退出码和耗时。
3. 用 `git status --porcelain` 与 `git diff` 核对只有批准路径变化；预存脏文件字节不变。
4. 本地提交，提交信息带需求/Task 标识；不使用 `reset`、`checkout`、`stash`、`rebase`、
   `commit --amend` 或强推。
5. 记录增量提交的 `commit` 与 `tree`，以及受控检查命令和退出码。

契约层要求：变更至少一条 code 与一条 test；`committedPaths` 必须与变更集合一致；预存脏文件
出现在提交里直接失败（`original_dirty_file_was_committed`）。

## 5. 分层验收（必须分开记录）

| 层级 | 谁执行 | 需要的证据 | 不能代替什么 |
| --- | --- | --- | --- |
| 代码交付 | 执行者 | 代码 `commit`/`tree`、diff、定向检查日志 | 不是 Task 验收，也不是产品验收 |
| Task 局部验证 | 执行者 | 与 Task 索引一致的定向 unit/integration 文件、退出码、日志 | 不是 Feature 门禁 |
| Feature 门禁 | 编排器（独立复验） | 去重后的 Task 索引并集（`task_union`）重跑结果、日志路径 | 不是 Phase 集成验收 |
| Phase 真实集成验收 | 负责人 | 真实 Git/SQLite/Host/进程/停止恢复证据与清理核验 | 未执行即 `not_run` |
| 真实 Pi live | 负责人授权后执行者 | 批准文件、provider/model、次数与预算、报告身份 | 普通测试、成功日志与夹具不能代替 |

- Task 索引位于 `test/index/phases/P08/features/P08-3/tasks/`，Feature 去重选择入口是
  `test/index/phases/P08/features/P08-3/feature.json`。
- Nezha completed 只表示编排记录，不是产品验收；测试数量多也不等于覆盖了验收项。
- 阶段范围规则见 [Phase 验收范围与门禁性能](phase-test-scope.md)。

## 6. 失败处理

| 情形 | 处理 | 结果 |
| --- | --- | --- |
| 已有失败（`known_failure`） | 逐项保留在 `baselineGaps`，状态 `unresolved`；新失败不得被旧失败豁免 | 整体不高于 `inconclusive`，绝不 `passed` |
| 预存脏文件 | 保持原字节；若落在批准路径内，先停下请负责人确认 | 未确认即 `not_run`/`failed` |
| 缺失依赖 | 记录 `missing_command`、`not_run`；不联网补装、不改夹具绕过 | `not_run` |
| 检查不可执行（权限等） | 记录 `permission_denied`、`not_run` | `not_run` |
| 检查断言失败 | 修代码；不弱化测试 | `failed`，保留证据 |
| 停止未确认 | 不释放工作区、不开始新 Run；先确认进程与停止证据 | `not_run`/`failed` |
| 身份冲突（`projectId`/路径摘要不一致、仓库移动） | 停下，重新预览并显式确认，按绑定 `revision` 做 CAS；不自动合并、不覆盖身份 | 未确认即 `not_run` |
| 无法安全提交 | 不提交；保留工作区与 `status`/`diff` 证据，报告待处理 | `pending`/`failed` |
| 超时或预算耗尽 | 记录真实超时点与退出码；不为通过而反复放宽超时重跑 | `failed`/`not_run` |

`not_run` 不折算为通过；`inconclusive` 同样不是通过。缺少证据的退出码 0 仍按 `inconclusive`
处理。

## 7. 归档与重开

```sh
node packages/cli/dist/bin.js project archive <projectId> --revision <revision> --json
node packages/cli/dist/bin.js project restore <projectId> --revision <revision> --json
```

- 归档后项目状态为 `archived`（不是 active）：新基线预览/运行会被结构化拒绝（`project_not_active`，零副作用），
  也不得派发工作；归档后**拒绝**新执行，不靠改数据库绕过。
- 归档不清理源仓库；在途基线操作会阻塞归档收尾，先把状态查清。
- `project restore` 是显式重开：保留原 `projectId`、仓库绑定、检查历史与证据引用，不启动 Run。
- 项目归档/恢复**不是**整库备份恢复（整库恢复使用 `shiploop restore`）。
- 重开后重新做一次准备快照与基线确认；不复用旧运行的证据当作新运行结果。

## 8. 证据与报告

- 使用 [P08-3 演示结果报告模板](p08-3-demo-report-template.md) 填写。
- 每条命令记录：可复制的 argv、工作目录范围、时间、真实退出码、完整日志路径（报告根内相对
  路径）和证据摘要。
- 报告类型要区分：脚本层存量增量契约是 `shiploop.existing-repo.incremental-evidence`；
  Todo live 是 `shiploop.todo.live-acceptance`；证据封套见
  `packages/core/src/ports/brownfield-evidence.ts`（脱敏收集与摘要校验）。不要复制说明把
  不同类型合并成一个通过结论。
- 禁止记录：凭据、令牌、OAuth/认证完整内容、模型完整 transcript、原始大输出、绝对路径。
  大输出落制品并记录相对引用与摘要。
- 未运行项、已知缺口和遗留问题必须单独列出，且与计数一致。

## 9. 未运行项（当前实现事实）

以下项目前没有已实现的仓库入口，默认 `not_run`，由负责人独立发起：

- 真实用户仓库的完整产品闭环（`project init` → 基线 → 规划/批准 → 执行 → 检查 → 提交）；
- 存量增量变更的真实 Pi 执行（无专用入口；`accept:p08:live` 只覆盖 Todo 演示）；
- 真实 Host 重启、跨进程 SQLite 持久性、真实生产仓库移动与归档恢复演练；
- Phase 真实 Git/SQLite/Host/进程集成验收与停止确认；
- 负责人逐项确认与签署（P08-4 阶段报告不由本手册修改）。

`not_run` 不折算为通过。测试通过、产品报告存在、报告完整性有效，都不能替代这些逐项证据。

## 10. 已核验入口

夹具与契约层（真实临时 Git；F-003 还使用真实 Host/CLI/SQLite，F-004 使用真实 Core/SQLite/Git；
普通运行不调用模型）：

```sh
node scripts/run-tests.ts test/modules/acceptance/p08-3-f001-baseline-snapshot.test.ts
node scripts/run-tests.ts test/modules/acceptance/p08-3-f001-existing-demo-fixture.test.ts
node scripts/run-tests.ts test/modules/acceptance/p08-3-f002-evidence-envelope.test.ts
node scripts/run-tests.ts test/modules/acceptance/p08-3-f003-existing-demo-incremental.test.ts
node scripts/run-tests.ts test/modules/acceptance/p08-3-f004-lifecycle-contract.test.ts
node scripts/run-tests.ts test/modules/acceptance/p08-3-f004-existing-demo-lifecycle.test.ts
```

工程门禁（按影响显式选择，不是每次演示都全跑）：

```sh
npm run typecheck
npm run check:boundaries
npm run build
npm run verify
```

真实模型入口（只对 Todo 演示有效，需负责人批准文件；普通 CI 不调用）：

```sh
npm run accept:p08:live -- --approval <批准文件绝对路径> --output <报告路径>
```

清理前确认没有遗留进程；报告与日志保存在演示决定的证据目录中，并保留原始退出码。

### 10.1 已核验文件清单

以上入口、夹具、索引与依据文件（本 Task 编写时逐一确认存在）：

- 夹具：`test/helpers/p08-3/legacy-todo-fixture.ts`
- 存量契约：`scripts/acceptance/p08-existing-demo.ts`、`packages/core/src/ports/brownfield-evidence.ts`
- 测试：`test/modules/acceptance/p08-3-f001-existing-demo-fixture.test.ts`、
  `test/modules/acceptance/p08-3-f002-evidence-envelope.test.ts`
- 索引：`test/index/phases/P08/features/P08-3/feature.json`、
  `test/index/phases/P08/features/P08-3/tasks/F-005.json`
- 依据：`docs/p08-2-existing-demo.md`、`docs/p08-2-live-acceptance-entry.md`、
  `docs/p08-1-user-guide.md`、`docs/acceptance/phase-test-scope.md`、`package.json`、`package-lock.json`、
  `scripts/run-tests.ts`
