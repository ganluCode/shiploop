# P08 一期负责人 walkthrough（干净安装 → 两类项目演示 → 签署）

状态：待负责人执行。本文是操作与核对说明，不是验收结论；机器报告、测试数量、文档完整或
`nezha task report` 的 completed 都不能代替签署。配套文档：

- [P08 一期能力矩阵](../p08-capability-matrix.md)
- [P08 交付报告模板](p08-delivery-report-template.md)
- [P08 总验收契约](../p08-acceptance.md)、`acceptance/p08.checklist.json` / `p08.config.json` / `p08.entry.json`
- [P08-1 新用户安装与操作指南](../p08-1-user-guide.md)
- [P08-2 `accept:p08:live` 入口](../p08-2-live-acceptance-entry.md)
- [P08-3 存量演示运行手册](p08-3-existing-demo-runbook.md) / [结果报告模板](p08-3-demo-report-template.md)

## 1. 受测身份与前提

- 平台：**仅正式支持 macOS（darwin）**；Windows/WSL/Linux 不在本期通过范围。
- 工具链：Node `22.19.0`、npm `10.9.3`、`package-lock.json`（npm，不用 pnpm/yarn）。
- 受测 commit：入口记录 `git rev-parse HEAD` 的完整 SHA；执行前工作树必须干净
  （`accept:p08` 对脏工作树 fail-closed）。
- 源码准备：在干净源码副本执行 `npm ci`、`npm run build`、`npm run pack:local -- --output <pack-dir>`、
  `npm run verify:artifacts`；任一步非零即停止，不安装、不沿用旧制品摘要。
- 隔离资源：安装目录、数据根、`HOME`/`XDG`/`TMPDIR` 和演示仓库都使用独立临时目录；
  不复用开发机业务数据、不复用旧 run 目录。
- 不在本 walkthrough 中执行 `npm publish`、`git push`、PR 或合并 main。

## 2. 从干净安装目录启动打包 CLI

```sh
INSTALL_DIR=$(mktemp -d)
cd "$INSTALL_DIR"
npm install "<pack-dir>/shiploop-core-0.0.0.tgz" \
            "<pack-dir>/shiploop-host-0.0.0.tgz" \
            "<pack-dir>/shiploop-cli-0.0.0.tgz"
export PATH="$INSTALL_DIR/node_modules/.bin:$PATH"
shiploop host --help
DATA_ROOT=$(mktemp -d)/data
shiploop host start --data-root "$DATA_ROOT" --json
shiploop host status --data-root "$DATA_ROOT" --json
```

核对点：

| # | 核对项 | 通过事实 | 不算通过 |
| --- | --- | --- | --- |
| 1 | 三包同批安装 | `shiploop-core`/`host`/`cli` 同名同版本，缺包或版本漂移在安装层失败 | 只安装 CLI 或复用开发目录 `node_modules` |
| 2 | 打包 CLI 可执行 | `shiploop host --help` 正常打印，`bin` 有可执行位与 shebang | 直接运行源码 `tsx`/`ts-node` 代替安装产物 |
| 3 | Host 单例与握手 | `host start` 返回 `outcome`、`protocolVersion`（本期为 `1`）和 `lifecycleState` | 只看到进程存在，没有握手/监听事实 |
| 4 | 协议拒绝 | 未知/更高握手版本返回 `protocol_incompatible`（退出码 3），不猜测降级 | 手工改发现文件或降级绕过 |
| 5 | 数据隔离 | SQLite、发现/凭据、制品、备份只落在 `--data-root` 内 | 写入用户全局配置或另一个数据根 |
| 6 | 原生加载 | better-sqlite3 与 Host 写入锁真实加载 | 仅 `--help` 成功就宣称数据库可用 |

真实独立目录安装、原生模块加载与打包 Host 启动是 `phase-integration` 门槛；只完成上述
冒烟仍保持 `not_run`，不折算 P08 通过。

## 3. Todo 新项目演示核对点

按 [project init Skill](../skills/project-init.md)、[planning approval Skill](../skills/planning-approval.md)、
[execution observe Skill](../skills/execution-observe.md)、[stop control Skill](../skills/stop-control.md) 执行。
所有命令使用独立 `--data-root`，示例中的 ID/摘要为占位。

```sh
TODO_REPO=$(mktemp -d)          # 新建并初始化一个 Todo CLI 小仓库
cd "$TODO_REPO" && git init && git add -A && git commit -m "init todo"

# 1) 只读预览；2) 用户单独确认后注册；3) 基线另行预览/授权
shiploop project init "$TODO_REPO" --name "todo-demo" --data-root "$DATA_ROOT" --json
shiploop project init "$TODO_REPO" --name "todo-demo" --confirm --data-root "$DATA_ROOT" --json
shiploop baseline preview --project "$PROJECT_ID" --input "$WORK_DIR/baseline.json" --data-root "$DATA_ROOT" --json
shiploop baseline run --project "$PROJECT_ID" --input "$WORK_DIR/baseline.json" --confirm --data-root "$DATA_ROOT" --json

# 规划草稿 → 候选审批 → 执行预览 → 确认启动 → 只读观察 → 取消，最后停止 Host
shiploop phase create --project "$PROJECT_ID" --title "todo" --data-root "$DATA_ROOT" --json
shiploop feature import --project "$PROJECT_ID" --phase "$PHASE_ID" --revision 1 --input "$WORK_DIR/feature.json" --data-root "$DATA_ROOT" --json
shiploop planning start "$FEATURE_ID" --project "$PROJECT_ID" --phase "$PHASE_ID" --revision 1 --input "$WORK_DIR/planning-input.json" --data-root "$DATA_ROOT" --json
shiploop planning candidate "$CANDIDATE_ID" --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop planning approve "$CANDIDATE_ID" --project "$PROJECT_ID" --digest "$CANDIDATE_DIGEST" --revision 1 --data-root "$DATA_ROOT" --json
shiploop execution preview "$FEATURE_ID" --project "$PROJECT_ID" --input "$WORK_DIR/budget.json" --data-root "$DATA_ROOT" --json
shiploop execution start "$FEATURE_ID" --project "$PROJECT_ID" --input "$WORK_DIR/budget.json" --preview-digest "$PREVIEW_DIGEST" --confirm --data-root "$DATA_ROOT" --json
shiploop project overview "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop execution cancel "$ATTEMPT_ID" --project "$PROJECT_ID" --confirm --data-root "$DATA_ROOT" --json
shiploop host stop --data-root "$DATA_ROOT" --json
```

> 命令名以安装版本 `--help` 为准；若与实际命令面不同，记录差异并按该版本的正式帮助执行，
> 不手工改数据库或回执。

核对点：

| # | 阶段 | 核对项 | 通过事实 | 不算通过 |
| --- | --- | --- | --- | --- |
| 1 | 接入预览 | 只读展示规范路径、HEAD（可为 null）、初始 commit、脏状态、已注册项目 | 预览不注册、不执行仓库脚本 | 预览即视为注册成功 |
| 2 | 注册 | 用户就这一次请求明确 `--confirm` | `registration.status=registered` 且 projectId 稳定 | 通用自动同意、无输入默认同意 |
| 3 | 基线 | 注册与基线授权是两次独立确认 | `baseline` 有实际命令、退出码与检查结果 | 注册成功当健康通过；`health=not_run` 折算通过 |
| 4 | 规划 | 候选校验后显式批准 | 计划摘要/DAG/固定输入与批准身份一致 | `accepted` 回执当 Task 完成或自动编码 |
| 5 | 执行预算 | 预览后才确认启动 | 预算、deadline、执行身份与 Task 快照一致 | 只看到 `accepted` 或进程启动 |
| 6 | 观察 | 状态来自持久查询，不从日志文字推断 | Task/Attempt/预算/用量可查询 | 模型自称完成、日志出现 success |
| 7 | 交付 | Runtime → 局部检查 → 受控 Git 提交顺序明确 | commit/tree/检查回执可核验，Task 才可 passed | Runtime completed 直接当 Task 通过 |
| 8 | 停止 | 用户显式停止并等待三证据 | 进程退出、锁释放、发现移除 | 退出 CLI/关终端当作已停止 |
| 9 | 产品报告 | 报告绑定本次 runId/commit/输入摘要 | 报告身份与 Core 查询一致，清理后仍可哈希核验 | Nezha 编码报告冒充产品报告 |

## 4. 存量仓库演示核对点

按 [P08-3 运行手册](p08-3-existing-demo-runbook.md) 准备快照、批准范围并填写
[结果报告模板](p08-3-demo-report-template.md)。仓库必须是**非 Nezha 创建/维护**的小仓库，
且不在 ShipLoop 开发仓库内演练。

```sh
LEGACY_REPO=$(mktemp -d)        # 用户自有或临时小仓库
cd "$LEGACY_REPO"
git rev-parse HEAD
git status --porcelain
git stash list                  # 只读记录，不自动 stash
shiploop project init "$LEGACY_REPO" --name "legacy-demo" --data-root "$DATA_ROOT" --json
# 基线检查 → 记录已有失败 → 限定批准路径做一次增量 → 只跑定向检查 → 核对 HEAD/status
```

核对点：

| # | 核对项 | 通过事实 | 不算通过 |
| --- | --- | --- | --- |
| 1 | 准备快照 | HEAD/tree、`git status --porcelain` 原文、脏文件分类与摘要、仓库身份、既有检查与已知失败 ID | 未记录快照就开始改代码 |
| 2 | 范围 | 需求说明、批准 code/test 路径、显式确认；越界路径即失败 | 顺手改无关文件或扩大 argv |
| 3 | 既有失败 | 保留为 `known_failure`/`unresolved`，不删除、不改期望值 | 新需求通过后自动豁免旧失败 |
| 4 | 增量 | 只改批准路径，检查通过且有证据 | 自动提交、stash、reset 或改写历史 |
| 5 | 初始化保护 | 注册/基线前后 HEAD 与脏状态未变 | 自动 commit 或清理用户改动 |
| 6 | 报告 | 实际命令、退出码、证据路径、计数与遗留问题按模板填写 | 用文档测试或成功日志代替 |

存量 live 没有已实现的真实模型入口；未获授权时保持 `not_run`，不得用 Todo live 报告或
夹具通过代替。

## 5. 例外处理（必须逐项写进报告）

### 5.1 基线脏文件

- 预览和基线快照原样记录脏文件（`modified_staged`/`modified_unstaged`/`untracked`）与内容摘要；
- 不自动 `stash`/`reset`/`commit`，不删除用户改动；初始化保护核对 HEAD 与脏状态未变；
- 脏文件不在批准范围时视为越界，停止变更并保留现场；报告写 `dirty` 与原因，不能记 `clean`。

### 5.2 已有失败

- 记录命令、真实退出码和 `known_failure` ID，状态保留 `unresolved`；
- 新需求通过不能清除、改写或豁免旧失败；报告单独列出；
- 失败原因不明时记录 `inconclusive`，不猜成通过。

### 5.3 清理

- 先停止 Host 并确认三证据（进程退出 + 锁释放 + 发现移除），再删除自有安装目录、数据根与
  临时演示仓库；
- 只清理自有临时根，不删除用户仓库、历史 run、报告或元数据；
- 复核没有遗留 CLI/Host/Runner/测试子进程；清理后报告哈希仍可离线核验；
- `cleanup_unconfirmed` 保留现场并阻止通过，不删除证据。

### 5.4 停止未确认

- `stop_not_confirmed` 时保持隔离/quarantined，不启动新 Run、不释放工作区、不派发执行；
- 不用新进程覆盖旧进程，不手工改库或回执；
- 报告记 `not_run`/`fail` 与原因，完成停止核验后才继续。

### 5.5 Live 缺失

- Todo live 与存量 live 分别核对，互不替代；缺失、未授权或预算耗尽保持 `not_run`；
- 不用 FakeRuntime、夹具、普通测试或另一类 live 报告补齐；
- 真实模型需负责人独立授权 provider/model、次数与预算，并绑定同一运行身份。

## 6. 阶段入口与证据核对

```sh
npm run accept:p08 -- --help
npm run accept:p08 -- --run-id "p08-owner-<timestamp>" \
  --expected-commit "<完整受测 SHA>" \
  --prerequisites "<owner-baselines.json>"
```

- 默认范围：P08 可信索引 + 登记的必需底层回归 + 安装检查 + 两类 live import-only +
  工程检查（typecheck/boundaries/build）；步骤串行，默认单步 15 分钟、总 2 小时。
- `--full-regression` 才执行完整可信并集；默认不执行无参数 `npm run verify` 的全仓测试。
- 证据位置：`artifacts/acceptance/p08/runs/<runId>/`（身份、范围、步骤与 source）、
  `reports/<runId>/report.json` 与 `summary.md`；重复 `runId` 保留旧运行并失败退出。
- `not_run`（live、人工、跨层集成）不折算通过；入口退出码 1 不等于“脚本错误”，而是仍有
  未完成门槛。

## 7. 负责人签署清单

| # | 核对项 | 记录 |
| --- | --- | --- |
| 1 | 受测 commit/tree、分支与干净工作树 | `<commit/tree/branch>` |
| 2 | 平台、Node/npm、锁文件摘要 | `darwin / 22.19.0 / 10.9.3 / <sha256>` |
| 3 | 干净安装与打包 CLI 启动事实 | `<证据路径>` |
| 4 | Todo 新项目演示实际命令与退出码 | `<证据路径>` |
| 5 | 存量仓库演示实际命令与退出码 | `<证据路径>` |
| 6 | Phase 入口、范围、预算与报告验证 | `<runId/报告路径>` |
| 7 | `pass/fail/not_run/deferred` 与人工 pending 计数 | `<n/n/n/n/n>` |
| 8 | 基线脏文件、已有失败、清理、停止确认、Live 缺失处理 | `<逐项事实>` |
| 9 | 未运行项与遗留问题 | `<逐项>` |
| 10 | 人工门禁记录 `P08-MANUAL-OWNER-GATE`（`shiploop.p08.manual-gate-record`） | `pending`（确认前） |

签署前必须确认：报告与证据身份一致、`phaseAccepted=false`、`ownerSignature=pending` 在
确认前没有被改写；只有负责人确认后，才把人工门禁改为 `confirmed` 并记录确认时间。
P08 是否放行、正式发布与合并 main 仍是独立决定。
