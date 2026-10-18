# P02-4 P02 操作指南与验收复跑说明

- 适用范围：P02-4（P02 双客户端与初始化验收）阶段的**实际操作交接**：真实支持的接口、
  双 CLI 手工闭环、`accept:p02` 验收复跑与故障诊断。
- 适用平台：**macOS**（首个正式支持与验收平台）；Windows / WSL / Linux 未验收。
- 协议依据：[p02-4-acceptance-contract.md](p02-4-acceptance-contract.md)（验收约定与检查
  清单，唯一定义检查 ID/证据字段）；命令与路由语义以
  [p02-1-host-lifecycle-contract.md](p02-1-host-lifecycle-contract.md)、
  [p02-2-commands-events-contract.md](p02-2-commands-events-contract.md)、
  [p02-3-onboarding-contract.md](p02-3-onboarding-contract.md) 为准；各操作细节见
  [p02-1-operations.md](p02-1-operations.md)、[p02-2-operations.md](p02-2-operations.md)、
  [p02-3-operations.md](p02-3-operations.md)。本文不另行定义协议/字段。
- 人工审阅入口：[acceptance/p02-4-review-checklist.md](acceptance/p02-4-review-checklist.md)。
  **人工未审阅即未完成**，本文与清单都不自动签字。
- 全部示例使用真实构建入口 `packages/cli/dist/bin.js` 与显式 `--data-root` 临时数据根，
  不含真实凭据、不含开发机固定路径；状态只落在示例声明的临时目录内。
  **不得手工修改业务数据库、不得删除任何锁（含 `host/writer.lock`）来“解决”问题**；
  一切状态变更只经下方真实命令面。

## 1. 实际支持的接口（交接面）

### 1.1 入口

| 能力 | 入口 | 说明 |
|---|---|---|
| CLI 可执行入口 | `packages/cli/dist/bin.js`（构建后 `bin: shiploop`） | 唯一读 `argv/env`、唯一退出的文件 |
| Host 后台进程入口 | `packages/host/dist/start.js` | 由 CLI 启动器以独立 argv spawn；不直接面向用户 |
| Core 组合根 | `shiploop-core/assembly`（`openCoreApplication`） | Host 经包名公共入口装配；CLI 不直接依赖 |
| Core 纯协议入口 | `shiploop-core/protocol` | 校验器、摘要与协议常量；不导入装配/应用服务 |
| Host 公共面 | `shiploop-host` 包 | `connectToHost` / `ensureHostRunning` / HostClient 业务方法 |
| 阶段验收控制器 | `npm run accept:p02`（`scripts/acceptance/p02-accept.ts`） | 单次阶段验收（见 §4） |

### 1.2 CLI 命令面（真实参数）

```text
node packages/cli/dist/bin.js host start|status|stop [--data-root <abs>] [--json]
node packages/cli/dist/bin.js project init <repository-path> [--name <displayName>]
        [--description <text>] [--label <l> ...] [--confirm] [--command-id <uuid>]
        [--data-root <abs>] [--json]
node packages/cli/dist/bin.js project overview <projectId> [--data-root <abs>] [--json]
node packages/cli/dist/bin.js project list [--limit <int>] [--cursor <id>] [--match <s>]
        [--data-root <abs>] [--json]
node packages/cli/dist/bin.js config create --scope global --input <file> [--command-id <uuid>]
node packages/cli/dist/bin.js config create --scope project --project <id> --input <file>
        [--command-id <uuid>]
node packages/cli/dist/bin.js config get --scope global|project [--project <id>]
        [--data-root <abs>] [--json]
node packages/cli/dist/bin.js config effective --project <id> [--data-root <abs>] [--json]
node packages/cli/dist/bin.js receipt get <commandId> [--data-root <abs>] [--json]
node packages/cli/dist/bin.js events (--project <id> | --global) [--cursor <cursor>]
        [--snapshot-only] [--follow] [--data-root <abs>] [--json]
node packages/cli/dist/bin.js baseline preview --project <id> --input <file>
        [--data-root <abs>] [--json]
node packages/cli/dist/bin.js baseline run --project <id> --input <file>
        (--confirm | --decline) [--wait] [--follow] [--command-id <uuid>]
        [--data-root <abs>] [--json]
node packages/cli/dist/bin.js baseline list --project <id> [--limit <int>] [--cursor <id>]
        [--data-root <abs>] [--json]
node packages/cli/dist/bin.js baseline status <operationId> [--data-root <abs>] [--json]
node packages/cli/dist/bin.js baseline cancel <operationId> --confirm
        [--command-id <uuid>] [--data-root <abs>] [--json]
node packages/cli/dist/bin.js baseline evidence <artifactId> [--data-root <abs>] [--json]
```

- `--data-root <abs>`：POSIX 绝对路径（省略 = P01 默认根）；相对/空/NUL/`/` → 退出码 2。
  业务命令经 `ensureHostRunning` 连接或启动**同一个**单例 Host；`host status`/`host stop`
  只读不启动 Host。监听地址不可配置（`--bind/--host/--address/--port/--listen*` 与
  `SHIPLOOP_HOST_*` 监听覆盖一律拒绝，退出码 2）。
- `--json`：stdout 单信封 `{ok,command,result|error}`；`--follow` 为 NDJSON；诊断走 stderr。
  `--command-id <uuid v4>` 省略时由 HostClient 生成一次并冻结；重放用**同一信封**。
- `project init` 无 `--confirm` = 只读预览零副作用；`baseline run` 的 `--confirm`/`--decline`
  互斥且必居其一。**注册确认与基线授权严格分开**，确认注册不隐含确认基线。
- 退出码（五档，冻结值）：`0` 成功；`1` 业务拒绝/操作失败（`forbidden`/`conflict`/
  `preview_stale`/`stop_unconfirmed`、`--wait` 终态非全 passed 等）；`2` 输入错误；
  `3` 连接/协议错误（`host_not_found`/超时/`protocol_incompatible`）；`4` 观察中断
  （`observation_interrupted`：操作未取消、Host 未停止）。

### 1.3 Host 路由与线协议（简表，契约为准）

- 生命周期：`POST /v1/host/handshake`、`GET /v1/host/status`、`POST /v1/host/stop`；
  Bearer-only（`host/auth.token` 0600）、Host/Origin 校验、16 KiB 体上限、脱敏错误。
- 应用面：命令唯一入口 `POST /v1/commands`（信封内 `operation` 判别）；回执
  `GET /v1/receipts/:commandId`、结果 `GET /v1/results/:resultRef`；查询
  `GET /v1/projects*`、`GET /v1/settings*`、`GET /v1/snapshot`；事件 `GET /v1/events`
  （SSE，`Last-Event-ID`/`?cursor=` 恢复）。
- 基线面：`GET /v1/projects/inspect?path=<abs>`、`GET /v1/projects/:projectId/overview`、
  `GET /v1/projects/:projectId/baselines`、`GET /v1/baselines/:operationId`、
  `GET /v1/artifacts/:artifactId/content`。
- 版本：配置 `schemaVersion=2`、导出格式 1、SQLite 迁移 v1..v5、发现/握手
  `schemaVersion=1`/`protocolVersion=1`、线消息 `schemaVersion=3`、事件封套 1、
  游标 `evcur_v1_<base64url>`、结果引用 `v1.<43 base64url>`。未知版本/能力 →
  `unsupported_schema_version`/`unsupported`，不猜测降级。

## 2. 先决条件与构建

- Node `22.19.0`、npm `10.9.3`；macOS + Xcode Command Line Tools（构建 N-API 锁适配器）。
- `npm ci && npm run build`：编译锁模块 → `tsc -b` 三包 → 校验 `dist/bin.js` shebang/0755
  → dist 冒烟。原生产物缺失明确失败，不自动降级。
- 正式验收在无 `node_modules`/`dist` 残留的干净源码快照中执行（见 §4.4）。

## 3. 双 CLI 手工闭环（临时 Git 仓库 → 配置 → 注册 → 授权基线 → 查询 → 观察 → stop/重启 → 证据）

初次人工验收优先按 [完整操作步骤](acceptance/p02-manual-acceptance.md) 执行：该文档
包含从实际输出提取各 ID、两终端变量共享说明与最后停止动作。以下为接口示意，
`PROJECT_ID` / `OPERATION_ID` / `ARTIFACT_ID` 须取自前一步实际输出，不能照抄占位值。

两个终端（**CLI-A** 与 **CLI-B**）共享同一 `$ROOT`；并发或交错执行都只启动一个 Host，
两条 CLI 握手核验同一个 `hostInstanceId`/`dataRootIdentity`。`$ROOT`/`$REPO` 均为
`mktemp -d` 产生的临时绝对路径：

```sh
# 0) 构建入口（一次性）
npm ci
npm run build

# 1) 临时 Git 仓库与共享数据根
REPO=$(mktemp -d)/repo
git init -q "$REPO"
git -C "$REPO" config user.email demo@example.invalid
git -C "$REPO" config user.name Demo
printf 'demo\n' > "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -qm init
ROOT=$(mktemp -d)/data
CMD=$(uuidgen | tr '[:upper:]' '[:lower:]')

# 2) 双 CLI 连接同一数据根：只有一个 Host（重复 start 接同一个 Host）
# --- CLI-A ---
node packages/cli/dist/bin.js host start --data-root "$ROOT" --json
# --- CLI-B ---
node packages/cli/dist/bin.js host status --data-root "$ROOT" --json

# 3) 确认配置（CLI-A 写全局配置；CLI-B 复核同一 revision/来源）
printf '%s' '{"schemaVersion":2,"policies":{"executionLimits":{"maxConcurrentWorks":1}}}' > "$ROOT/global.json"
# --- CLI-A ---
node packages/cli/dist/bin.js config create --scope global \
  --input "$ROOT/global.json" --data-root "$ROOT" --json
# --- CLI-B ---
node packages/cli/dist/bin.js config get --scope global --data-root "$ROOT" --json

# 4) 注册（先只读预览，再显式 --confirm；CLI-B 复核同一 projectId）
# --- CLI-A ---
node packages/cli/dist/bin.js project init "$REPO" --data-root "$ROOT" --json
node packages/cli/dist/bin.js project init "$REPO" --name "示例项目" \
  --confirm --data-root "$ROOT" --json
# --- CLI-B ---
node packages/cli/dist/bin.js project list --data-root "$ROOT" --json
node packages/cli/dist/bin.js project overview "$PROJECT_ID" --data-root "$ROOT" --json
node packages/cli/dist/bin.js config effective --project "$PROJECT_ID" --data-root "$ROOT" --json

# 5) 授权基线（preview 展示实际 argv/cwd/timeout/代码身份 → run --confirm --wait）
cat > "$ROOT/plan.json" <<'JSON'
{
  "checks": [
    { "checkKey": "echo-ok", "kind": "command", "argv": ["/bin/echo", "baseline ok"],
      "timeoutMs": 60000, "required": true }
  ]
}
JSON
# --- CLI-A ---
node packages/cli/dist/bin.js baseline preview --project "$PROJECT_ID" \
  --input "$ROOT/plan.json" --data-root "$ROOT" --json
node packages/cli/dist/bin.js baseline run --project "$PROJECT_ID" \
  --input "$ROOT/plan.json" --confirm --wait --data-root "$ROOT" --json

# 6) 查询与读取证据（CLI-B 查同一持久状态；artifactId 取自 status 的 checks[].output）
# --- CLI-B ---
node packages/cli/dist/bin.js baseline list --project "$PROJECT_ID" --data-root "$ROOT" --json
node packages/cli/dist/bin.js baseline status "$OPERATION_ID" --data-root "$ROOT" --json
node packages/cli/dist/bin.js baseline evidence "$ARTIFACT_ID" --data-root "$ROOT" --json

# 7) 超时/响应丢失先查回执（同一 --command-id 重放得原回执；异参数复用得 conflict）
# 此处 CMD 须为已提交命令的 commandId；第 5 步未指定 ID 时从回执取值。
node packages/cli/dist/bin.js receipt get "$CMD" --data-root "$ROOT" --json

# 8) 退出观察：Ctrl+C 只结束本次观察（退出码 4，observation_interrupted）
#    操作不被取消、Host 不停止；取消必须显式 baseline cancel
node packages/cli/dist/bin.js baseline run --project "$PROJECT_ID" \
  --input "$ROOT/plan.json" --confirm --command-id "$CMD" --data-root "$ROOT" --json
node packages/cli/dist/bin.js events --project "$PROJECT_ID" --snapshot-only --data-root "$ROOT" --json
node packages/cli/dist/bin.js baseline cancel "$OPERATION_ID" --confirm --data-root "$ROOT" --json

# 9) 显式停止与重启后查询（重启取新 hostInstanceId；项目/配置/结果/证据仍可查）
node packages/cli/dist/bin.js host stop --data-root "$ROOT" --json
node packages/cli/dist/bin.js host start --data-root "$ROOT" --json
node packages/cli/dist/bin.js project overview "$PROJECT_ID" --data-root "$ROOT" --json
node packages/cli/dist/bin.js baseline status "$OPERATION_ID" --data-root "$ROOT" --json
node packages/cli/dist/bin.js baseline evidence "$ARTIFACT_ID" --data-root "$ROOT" --json
node packages/cli/dist/bin.js host stop --data-root "$ROOT" --json
```

- 客户端退出（Ctrl+C/会话结束）**不停止 Host**：Host 是独立后台进程，只有显式
  `host stop` 才收尾（停止确认三证据）。CLI-B 随时可用 `host status` 复核 Host 存活。
- `baseline run` 默认返回 `accepted` + `operationId` 后退出；**`accepted` 不是通过**，
  终态以 `baseline status` 的持久检查状态为准。

## 4. 验收复跑说明（accept:p02 与干净快照复跑）

### 4.1 命令、参数与环境变量

```sh
# 单次阶段验收（一次调用完成前提检查、npm run verify、固定必需场景、报告/证据核验）
npm run accept:p02
npm run accept:p02 -- --run-id 20260101T120000Z-0a1b2c3d --report-dir out/p02
npm run accept:p02 -- --help
```

- 仅提供报告位置与有限预算覆盖：`--run-id <id>`、`--report-dir <dir>`、
  `--step-timeout-ms <ms>`、`--verify-timeout-ms <ms>`（`--help` 单独使用）。环境变量
  对应 `SHIPLOOP_ACCEPT_P02_RUN_ID`、`SHIPLOOP_ACCEPT_P02_REPORT_DIR`、
  `SHIPLOOP_ACCEPT_P02_STEP_TIMEOUT_MS`，verify 步骤预算复用
  `SHIPLOOP_VERIFY_STEP_TIMEOUT_MS`。未记录的 `SHIPLOOP_ACCEPT_P02_*` 一律拒绝。
- **不得跳过**必需检查：没有跳过认证/负例/verify 的开关；`--skip*`/`--only` 等一律
  `invalid_usage` 拒绝（退出码 1）。

### 4.2 配置入口（`acceptance/p02.config.json`）

- 版本化配置 `configVersion: 1`：`reportRoot: "artifacts/acceptance/p02"`、有序
  `requiredChecks`（15 个稳定检查 ID，与契约 §2.1 一致）、`scenarios`（命令/测试入口）、
  `timeouts`（`verifyMs`/`scenarioMs`/`overallMs` 有限毫秒）、`maxCommandOutputBytes`、
  `plan`/`priorBaselines`/`schemaVersions`。
- 运行时校验拒绝未知 `configVersion`、未知/缺失/重复检查 ID、移除或关闭必需项、非正/
  无限超时与报告路径逃逸。CLI/env 只能覆盖报告位置与预算，**不能放宽必需检查集合**。

### 4.3 报告位置与非零处理

- 报告默认位置 `artifacts/acceptance/p02/<run-id>/`（每次运行独立目录，互不覆盖）：
  `report.json`（版本化机器可读）、`summary.md`（同源摘要）、`evidence/`（清理临时资源
  前导出的脱敏证据，带 `hash`/`size`）。
- run-id 形如 `YYYYMMDDThhmmssZ` 加 `-<8 hex>`（匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$`）；
  非法 run-id 属用法错误。
- 非零处理（fail-closed，与 `computeP02PhaseExitCode` 一致）：
  - 配置/参数校验失败 → 退出码 1、**零副作用**（**不产生报告**、不启动 Host/场景）；
  - 任一必需检查 `fail` 或 `not_run`、证据缺失/损坏、报告写入失败 → 阶段结论非通过，
    `accept:p02` **非零**退出；
  - 只有**全部必需检查**实际 `pass` 且报告写出后整目录重验成功才退出 0；
    空结果集、未启动步骤（`not_run`）不得聚合为通过。
- 成功或失败都保留已取得证据；失败路径同样写出报告供排障。报告不含认证文件、token、
  完整环境变量或用户文件正文。

### 4.4 干净快照连续复跑（P02-ENG-CLEAN-REPLAY）

- 承接入口 `test/modules/acceptance/p02-4-clean-replay.test.ts`（完整复跑形态由显式入口启动：
  `node scripts/run-tests.ts test/modules/acceptance/p02-4-clean-replay.test.ts`；默认 `npm test` 只收集
  契约断言，不递归复跑，与 P01 先例一致）。
- 复跑工具 `scripts/acceptance/p02-clean-replay.ts` 支持分阶段续跑：
  `--phase prepare | accept-1 | accept-2 | finalize | all`（阶段状态持久化在证据目录
  `state.json`；finalize 导出证据后删除状态文件）。流程：干净源码快照 `npm ci`/build →
  公共入口导入冒烟 → 非源码 cwd 的 dist 冒烟 → **连续两次** `npm run accept:p02`
  （均须退出 0）。
- 证据固定输出到 `docs/acceptance/evidence-p02-4-clean-replay/`（run-id/报告目录/临时
  资源两次独立、互不覆盖；证据 hash/size 重验；结束核验无自有 Host/基线进程、锁/发现
  文件/哨兵继续写入残留）。
- 深度护栏：`SHIPLOOP_CLEAN_REPLAY_DEPTH` ≥ 1 表示嵌套在 `accept:p02` 内的同名场景步骤，
  禁止递归复跑；不要手工清除该变量绕过护栏。

## 5. 诊断与故障处理（先查证据，不改库、不删锁）

| 症状 | 事实与诊断 | 正确处置 |
|---|---|---|
| 注册成功但显示“不健康” | 注册与健康严格分轴：`registration.status`（`not_run`/`registered`/`already_registered`）与 `health.status`（`healthy`/`unhealthy`/`not_run`）独立；无终态基线 → `not_run`（`reasonCode=no_baseline`）**不得视为健康**；基线失败**不撤销注册** | 查 `project overview` 与 `baseline list` 的持久事实；失败是记录，不是后续验收豁免 |
| 重复 init | 同规范路径及其真实路径别名重复 `project init --confirm` 得同一 `projectId`，返回 `already_registered`，原名称/描述/标签/配置不被覆盖 | 视为幂等成功；差异即缺陷，保留两次回执核对 |
| 命令重放 / 冲突 | 同 `(principalId, commandId)` + 同摘要 → 原持久回执（`replayed: true`，零重复副作用）；同 ID 异摘要 → `conflict`（`idempotency_key_reuse`），原回执仍可查 | 核对 `requestDigest` 与 `receipt get`；不要生成新 commandId 冒充重放 |
| 请求超时/响应丢失 | 先查回执，不盲目重发 | `receipt get <commandId>` 命中即原结果；未知回执才以完全相同信封有限重发 |
| 认证/协议拒绝 | 缺失/错误 token → `unauthorized`；旧实例/旧 token（重启后）→ 拒绝；未知协议/Schema → `protocol_incompatible`/`unsupported_schema_version` | 走正式入口重新握手（`host start`/业务命令自动连接）；不要手工读改 `host/auth.token` |
| 基线 `failed` | 检查非零退出（记录 `exitCode`）；`baseline run --wait` 退出码 1 | 修仓库 → 重新 `baseline preview` → 新 `--confirm` → 新 `operationId` |
| `not_run` | 显式 `--decline`（`authorization_rejected`）、未确认注册、因中断/取消未启动的检查 | 按事实记录，**不折算通过**；需要结果就重新显式授权执行 |
| `cancelled` / `timed_out` | 显式 `baseline cancel`（`inconclusive/cancelled`）；达 `timeoutMs`（`inconclusive/timed_out`） | 查 `baseline status` 终态；重跑用新操作，不改历史记录 |
| `stop_unconfirmed` | 无法核验进程树已停止 → 操作 `failed`、检查 `inconclusive/stop_unconfirmed`，占用保留 | **不能重跑**、不能释放占用；保留现场与诊断，等待人工核对（见清单“已知限制”） |
| 观察中断（退出码 4） | `observation_interrupted`：只结束本次观察，操作未取消、Host 未停止 | 继续 `baseline status`/`events` 观察；取消必须显式 `baseline cancel` |

**禁止的“修复”手段**：不得手工修改业务数据库（含插入/UPDATE/DELETE 任何业务表或
`state_events`/`command_receipts`）、**不得删除** `host/writer.lock`、发现文件或任何
**锁**文件来绕过状态；这些操作破坏单写者与幂等不变量，且不产生任何有效证据。诊断
优先读：`baseline status`/`baseline list`、`receipt get`、`events`、`host status`、
`accept:p02` 报告的 `report.json`/`evidence/`。

## 6. 平台、安全边界与已知限制

- 正式支持与验收**仅 macOS**；Windows / WSL / Linux 未验收，不把 macOS 结果外推。
- **可信项目 ≠ 强沙箱**：首版是用户明确授权的可信本机单用户模式，检查命令以用户权限在
  真实工作区运行，**不提供强 OS 文件/进程沙箱**；Host 固定监听 `127.0.0.1` 随机端口，
  发现文件中的本机 token 不防御同一操作系统用户的恶意进程。要求强隔离的场景明确拒绝，
  不静默降级。
- 凭据只经受保护文件与认证头传递，不进 URL/响应/日志/证据；示例与本文不含真实凭据、
  不含开发机固定路径。证据正文脱敏不是通用秘密检测，未知秘密不在保证范围内。
- 已知限制（与清单 §4 一致）：`stop_unconfirmed` 保留占用需人工核对；P02-2 帮助文案仍有
  顶层漂移记录（契约 §8-6，待核对）；T26 编号不一致按行为映射、待负责人统一编号。

## 7. Harness 验证策略交接（记录，不修改配置）

- 仓库级验证入口：`npm test`（默认收集）、`npm run verify`（锁文件预检 + test/typecheck/
  build，fail-closed）、`npm run check:boundaries`；阶段验收入口 `npm run accept:p02`。
- **建议 Harness 将本仓库验收命令对齐**为 `npm run verify`（Feature 级）与
  `npm run accept:p02`（阶段级），以退出码为通过依据；Nezha 的 `completed` 不等于验收
  通过。**本轮不修改任何 Harness/executor/agent/YAML 配置**，对齐由操作者执行前核对。
- 人工放行以 [acceptance/p02-4-review-checklist.md](acceptance/p02-4-review-checklist.md)
  签字为准；脚本 pass 不是自动放行。

## 8. 未实现（`not_run`，不得冒充）

- **Pi/Work**：Work/Batch/Run/Attempt、DAG 调度、Scheduler/Runner、Pi SDK 与真实模型
  执行、FakeRuntime 仅可替代模型。
- **Web**：托管 Chat、Web/Electron、配对界面。
- **rebind**：移动 rebind、多 clone 归档；`project init` 的 Profile/技术栈推断。
- 强 OS 沙箱、审批流、通知投递、NAS/云端、非 macOS 平台、配置历史版本表。
- 以上均为 `not_run`/未支持，不计入 P02 必需项通过数，不得折算。

## 9. 测试与文档守护入口

- 阶段场景（人工清单逐项引用）：`test/modules/acceptance/p02-4-dual-cli-acceptance.test.ts`、
  `test/modules/acceptance/p02-4-idempotency-acceptance.test.ts`、`test/modules/acceptance/p02-4-repo-preservation-acceptance.test.ts`、
  `test/modules/acceptance/p02-4-negative-acceptance.test.ts`、`test/modules/acceptance/p02-4-restart-acceptance.test.ts`、
  `test/modules/acceptance/p02-4-baseline-failure-acceptance.test.ts`；阶段控制
  `test/modules/acceptance/p02-4-acceptance-controller.test.ts`、`test/modules/acceptance/p02-4-report-aggregation.test.ts`、
  `test/modules/acceptance/p02-4-acceptance-report.test.ts`；干净复跑 `test/modules/acceptance/p02-4-clean-replay.test.ts`。
- 文档守护：`test/modules/acceptance/docs-p02-4-operations.test.ts`（本文示例命令契约、复跑说明与真实
  `accept:p02`/配置一致，人工清单引用的测试/证据真实存在）、
  `test/modules/acceptance/docs-p02-4-acceptance-contract.test.ts`（契约冻结事实）。
- 示例运行产物留在临时数据根（`baseline evidence` 可读）与各测试断言中；不收集真实
  凭据或用户文件正文。
