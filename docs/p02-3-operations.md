# P02-3 项目接入、基线授权与故障处理操作说明

- 适用 Feature：P02-3（项目静态接入 `project init`/`overview`、获准基线检查 `baseline.*`、
  受监督命令进程与重启恢复）。
- 适用平台：macOS（首个正式验收平台）；Windows / WSL / Linux 未验收。
- 协议依据：[p02-3-onboarding-contract.md](p02-3-onboarding-contract.md)（唯一定义，
  本说明不另行定义协议/路由/字段）；受监督进程与停止见
  [p02-3-command-process.md](p02-3-command-process.md)，输出与证据见
  [p02-3-baseline-evidence.md](p02-3-baseline-evidence.md)，执行编排见
  [p02-3-baseline-execution.md](p02-3-baseline-execution.md)，停止与重启恢复见
  [p02-3-baseline-recovery.md](p02-3-baseline-recovery.md)；生命周期传输与锁仍以
  [p02-1-host-lifecycle-contract.md](p02-1-host-lifecycle-contract.md)、
  [p02-1-writer-lock.md](p02-1-writer-lock.md) 为准。
- 本文只描述**已实现并已有真实纵向回归**的能力：`project init`/`project overview`、
  `baseline preview|run|list|status|cancel|evidence`，以及复用的 `project.*`/`config.*`/
  `receipt get`/`events`/`host start|status|stop`。Work/Pi、调度、`accept:p02`
  **不属于**本次交付，本文不编造。
- 全部示例使用真实构建入口 `packages/cli/dist/bin.js` 与**显式** `--data-root` 临时数据根；
  状态只落在该数据根内，不要求人工改数据库或任何不可见的本机配置，不含开发机绝对路径或真实凭据。

## 1. 范围与入口

| 能力 | 入口 | 说明 |
|---|---|---|
| CLI 可执行入口 | `packages/cli/dist/bin.js`（构建后 `bin: shiploop`） | 唯一读 `argv/env`、唯一退出的文件 |
| Host 后台进程入口 | `packages/host/dist/start.js` | 由 CLI 启动器以独立 argv spawn；不直接面向用户 |
| Core 组合根 | `shiploop-core/assembly`（`openCoreApplication`） | Host 经包名公共入口装配；CLI 不直接依赖 |
| Core 纯协议入口 | `shiploop-core/protocol` | 校验器、摘要与协议常量；不导入装配/应用服务 |
| Host 公共面 | `shiploop-host` 包 | `connectToHost` / `ensureHostRunning` / HostClient 业务方法 |
| CLI 执行层 | `runAppCli`（`packages/cli/src/app-execute.ts`） | 与 `dist/bin.js` 同一路径 |

- 业务命令经 `ensureHostRunning` 连接既有 Host；无实例时只经正式获锁入口启动**同一**单例。
  `host status`/`host stop` 等只读命令**永不**启动 Host。CLI 自身不打开 SQLite、不读认证文件。
- `project init` 与 `baseline run` 都是「先展示、后显式确认」：CLI 非交互，唯一确认入口是
  `--confirm`（`baseline run` 另有 `--decline`）；**注册确认与基线授权严格分开**，
  确认注册不隐含确认基线。

## 2. 先决条件与构建

- Node `22.19.0`、npm `10.9.3`；macOS + Xcode Command Line Tools（`/usr/bin/clang`、macOS SDK）
  用于构建原生锁适配器。
- 构建：`npm ci && npm run build`。`build` 先编译 N-API 锁模块，再 `tsc -b` 三个包、校验
  `dist/bin.js` shebang/权限并运行 dist 冒烟。原生产物缺失或不可加载时明确失败，不自动降级。

## 3. 命令面与参数

```text
node packages/cli/dist/bin.js host start|status|stop …          （P02-1，语义不变）

node packages/cli/dist/bin.js project init <repository-path> [--name <displayName>]
        [--description <text>] [--label <l> ...] [--confirm] [--command-id <uuid>]
        [--data-root <abs>] [--json]
node packages/cli/dist/bin.js project overview <projectId> [--data-root <abs>] [--json]

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

- `--data-root <abs>`：POSIX 绝对路径（省略 = P01 默认根）；相对/空/NUL/`/` 为输入错误
  （退出码 2）。示例一律显式传入临时绝对路径，数据根之外不产生状态。
- `--json`：单次命令 stdout 只输出一个 `{ok,command,result|error}` 信封；人类诊断到 stderr；
  `--follow` 的 JSON 模式输出 NDJSON 记录流。错误保留 `commandId` 以便 `receipt get` 查回执。
- `project init` **无 `--confirm`** = 只做静态预览（规范路径/HEAD/脏状态/是否已注册），
  不注册、不执行仓库脚本、不安装依赖、不运行基线，退出码 0；
  `--confirm` 只授权预览展示的这一次注册（`project.register` 幂等命令）。
  未显式确认（含非交互无输入）→ `registration.status="not_run"`，不折算成功。
- `baseline preview` 只读：展示逐项 `argv`（原样数组）、`cwd`、环境引用、`timeout`、
  检查政策与代码身份，返回 `previewDigest`；不执行任何检查。
- `baseline run`：`--confirm` 授权执行（`decision:'authorize'`）、`--decline` 显式拒绝
  （记录 `not_run`），**互斥且必居其一**（同时或缺席均退出码 2）。CLI 内部先做只读预览并以
  `previewDigest` 绑定授权；默认返回 `accepted` + `operationId` 后退出，`--wait` 等待终态，
  `--follow` 经 SSE 观察 `baseline.*` 事件。
- `baseline cancel` 是**唯一取消途径**，必须 `--confirm`；观察中断或退出 CLI 都不会取消操作。
- `--input <file>` 只是**本次请求的输入**（检查计划 JSON），CLI 不监听文件变化；文件内容不得
  指定数据库路径、结果读取路径或提权主体，也不携带凭据/环境值。检查计划形状（契约 §6.1）：

```json
{
  "checks": [
    {
      "checkKey": "unit",
      "kind": "command",
      "argv": ["node", "--test", "test/unit.test.js"],
      "cwdRef": "packages/demo",
      "timeoutMs": 600000,
      "required": true
    }
  ]
}
```

  `checks` 1..64 项、`checkKey` 匹配 `^[a-z0-9][a-z0-9_-]{0,63}$` 且项目内唯一；`argv` 为
  非空字符串数组（**无 shell**、不拼接、不解释元字符）；`cwdRef` 为仓库内相对子目录
  （省略 = 仓库根，越界/绝对路径/符号链接逃逸 → `invalid_input`）；`environmentRef`
  （可选，非空字符串）是环境允许列表引用（省略/不写 = 仅 PATH 最小环境，**不继承** Host
  环境、不携带值）；`timeoutMs` 1..3 600 000；`required` 影响健康判定。
- 监听地址不可配置：`--bind/--host/--address/--port/--listen*` 参数与 `SHIPLOOP_HOST_*`
  监听覆盖环境变量一律拒绝（退出码 2）。

## 4. 最小可运行示例（临时仓库接入 → 基线授权 → 证据 → 停止/重启）

以下步骤在真实临时目录上可复跑；`$ROOT`（数据根）与 `$REPO`（仓库）都是临时绝对路径，
不依赖任何预置状态或人工改库：

```sh
# 0) 构建入口（一次性）
npm ci
npm run build

# 1) 准备临时 Git 仓库与显式数据根（示例占位；实际取 mktemp -d 的绝对路径）
REPO=$(mktemp -d)/repo
git init -q "$REPO"
git -C "$REPO" config user.email demo@example.invalid
git -C "$REPO" config user.name Demo
printf 'demo\n' > "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -qm init
ROOT=$(mktemp -d)/data

# 2) 静态预览（不注册、零副作用；退出码 0）
node packages/cli/dist/bin.js project init "$REPO" --data-root "$ROOT" --json

# 3) 显式确认注册（只授权注册这一次请求；健康仍为 not_run/no_baseline）
node packages/cli/dist/bin.js project init "$REPO" --name "示例项目" \
  --confirm --data-root "$ROOT" --json
#   → result.registration.status="registered"、result.registration.projectId=<uuid>
#     result.health.status="not_run"（尚无基线，不得视为健康）

# 4) 概览：注册状态与健康状态严格分列
node packages/cli/dist/bin.js project overview "$PROJECT_ID" --data-root "$ROOT" --json

# 5) 基线预览（只读；展示本次实际 argv/cwd/timeout/代码身份与 previewDigest）
cat > "$ROOT/plan.json" <<'JSON'
{
  "checks": [
    { "checkKey": "echo-ok", "kind": "command", "argv": ["/bin/echo", "baseline ok"],
      "timeoutMs": 60000, "required": true }
  ]
}
JSON
node packages/cli/dist/bin.js baseline preview --project "$PROJECT_ID" \
  --input "$ROOT/plan.json" --data-root "$ROOT" --json

# 6) 显式授权并等待终态（--confirm 只覆盖上面预览的这一次请求）
node packages/cli/dist/bin.js baseline run --project "$PROJECT_ID" \
  --input "$ROOT/plan.json" --confirm --wait --data-root "$ROOT" --json
#   → result.state="passed"（操作 completed 且全部 required 检查 passed），退出码 0

# 7) 查询历史与逐项结果（结果含输出制品引用 artifactId）
node packages/cli/dist/bin.js baseline list --project "$PROJECT_ID" --data-root "$ROOT" --json
node packages/cli/dist/bin.js baseline status "$OPERATION_ID" --data-root "$ROOT" --json

# 8) 读取输出证据（已脱敏正文原样输出；artifactId 取自 status 的 checks[].output.artifactId）
node packages/cli/dist/bin.js baseline evidence "$ARTIFACT_ID" --data-root "$ROOT" --json

# 9) 显式拒绝（持久 not_run，零启动；退出码 0 但绝不折算通过）
node packages/cli/dist/bin.js baseline run --project "$PROJECT_ID" \
  --input "$ROOT/plan.json" --decline --data-root "$ROOT" --json

# 10) 显式取消在途操作（唯一取消途径）
# plan-hang.json：{"checks":[{"checkKey":"hang","kind":"command","argv":["/bin/sleep","30"],
#                  "timeoutMs":3600000,"required":true}]}
node packages/cli/dist/bin.js baseline run --project "$PROJECT_ID" \
  --input "$ROOT/plan-hang.json" --confirm --data-root "$ROOT" --json
#   → result.status="accepted"、result.operationId=<uuid>（accepted 不是通过）
node packages/cli/dist/bin.js baseline cancel "$OPERATION_ID" --confirm \
  --data-root "$ROOT" --json
#   → 回执返回前完成停止核验；停止未确认时保留 stop_unconfirmed，不伪装成功

# 11) 显式停止 Host 与重启后查询（停止仍只有显式命令）
node packages/cli/dist/bin.js host stop --data-root "$ROOT" --json
node packages/cli/dist/bin.js project overview "$PROJECT_ID" --data-root "$ROOT" --json
#   → 下一条业务命令经正式入口连接或重启同一单例 Host；注册、历史操作与证据均可继续查询
node packages/cli/dist/bin.js baseline status "$OPERATION_ID" --data-root "$ROOT" --json
```

## 5. 结果语义与故障处理

### 5.1 注册与健康严格独立

- 注册状态（`registration.status`：`not_run`/`registered`/`already_registered`）与健康状态
  （`health.status`：`healthy`/`unhealthy`/`not_run`）是**两条独立的轴**；注册成功不代表基线健康。
- 健康由**最近一次终态基线操作**派生：`healthy` 当且仅当操作 `completed` 且全部 `required`
  检查 `passed` 且无 `source_changed`/`evidence_incomplete`/`output_overflow` 原因；
  无终态操作 → `not_run`（`reasonCode=no_baseline`），**不得视为健康**。
- **基线失败/未知脚本/任何非 passed 判定都不撤销项目注册**；已知基线失败是持久记录的检查
  事实，**不是后续验收的豁免依据**——后续验收必须重新取得自己的检查证据，不能引用旧失败或
  旧通过代替。

### 5.2 拒绝、未启动与未知脚本

- `baseline run --decline`：持久 `not_run`（`reasonCode=authorization_rejected`），零启动、
  仓库脚本哨兵为零；退出码 0 表示「拒绝已记录」，**不折算为通过**。
- `project init` 未显式 `--confirm`：`registration.status="not_run"`（`reason` 为
  `non_interactive`/`no_input`/`confirm_flag_required`/`declined`），未注册。
- 缺命令（`argv[0]` 不可解析，spawn ENOENT）→ 该检查 `error/missing_command`；
  未知脚本（相对 `./script` 不在项目内，或 `npm run` 引用缺失的 package script）→
  该检查 `error/unknown_script`；其他启动失败 → `error/spawn_failed` 或
  `error/permission_denied`。这些检查**从未放行执行用户脚本**，但状态是 `error` 而非通过；
  因中断/取消而未启动的检查保持 `not_run`。三者都不得折算为 `passed`。

### 5.3 失败、超时、取消与停止未确认

| 情形 | 操作状态 | 检查状态 / reasonCode | CLI 观察 |
|---|---|---|---|
| 非零退出码 | `completed` | `failed`（记录 `exitCode`） | `baseline run --wait` 退出码 1 |
| 达 `timeoutMs` | `completed` | `inconclusive/timed_out` | 展示状态 `timeout` |
| 启动后显式取消（进程已确认停止） | `cancelled` | `inconclusive/cancelled` | 展示状态 `cancelled` |
| **停止未确认**（无法核验进程树已停止） | `failed` | `inconclusive/stop_unconfirmed` | 展示状态 `stop_unconfirmed`；占用保留，不重跑 |
| 运行期间源码变化 | `completed` | `inconclusive/source_changed` | 不倒写为通过 |
| 证据缺口（制品未就绪/哈希不符/空输出） | `completed` | `inconclusive/evidence_incomplete` | 输出缺口见 5.4 |
| 输出超 8 MiB 有界上限 | `completed` | `inconclusive/output_overflow` | 预算内已收数据保留 |
| Host 重启后发现未收尾 | `interrupted` | `inconclusive/restart_recovery` | 历史可查；不自动重跑 |

- `failed`/`error`/`inconclusive`/`not_run` **永不伪装 `passed`**；`baseline run --wait` 仅当
  终态为「操作 `completed` 且全部 `required` 检查 `passed`」才退出码 0，其余终态退出码 1。
- 取消回执不提前声称进程已停：`baseline cancel` 在返回前完成停止核验；核验不了就保留
  `stop_unconfirmed` 并保持占用隔离，**旧进程未确认停止时不能重跑**（重启恢复同样保守）。
- 单并发占用：同一时刻只允许一个基线操作，第二个在途请求提交前拒绝（`resource_busy` /
  `baseline_in_progress`），不排队、不自动重试。

### 5.4 输出与证据缺口

- 每项检查的输出（stdout/stderr 标记的**脱敏**文本）与 JSON 报告各自发布为独立制品；
  `baseline status` 的 `checks[].output` 给出 `{artifactId, byteSize, truncated}`，
  `tail` 为 ≤16 KiB 截断尾部。`baseline evidence <artifactId>` 读取脱敏正文（有界 ≤8 MiB）。
- 覆盖缺口（输出溢出、丢失、写入/发布失败、结果拒绝、停止未确认、制品缺失/损坏）都会在
  报告中记录并使该检查 `inconclusive`（`evidence_incomplete`/`output_overflow`/
  `stop_unconfirmed`），**未收齐/缺失的输出永不证明通过**。证据正文已脱敏（屏蔽 Authorization/
  Cookie 等行与已登记秘密），但不是通用秘密检测；未知秘密、跨流拼接的秘密不在保证范围内。
- 退出 0 仍要求完整、核验过的输出/报告与非空输出；冻结的保守规则会拒绝已识别的
  `0 tests`/`No tests found` 等「空跑通过」尾部摘要。

### 5.5 过期授权

- 授权与 `previewDigest`（绑定检查计划 + 代码身份的完整输入摘要）绑定：预览后源码/绑定变化
  再提交 → `rejected preview_stale`（退出码 1），必须重新 `baseline preview` 取得新的
  `previewDigest`；授权摘要行（`baseline_authorizations`）insert-only，不被改写。
- 命令时效：信封 `issuedAt` 时钟偏差 ±60 s、默认 TTL 60 s、`expiresAt` 最大寿命 300 s；
  过期命令被拒绝，不静默延期。运行中代码变化 → `source_changed`（见 5.3）。

### 5.6 观察退出语义

- `baseline run --wait/--follow` 与 `events` 的观察被 Ctrl+C/Abort/观察预算耗尽中断时，
  只结束**本次观察**（退出码 4，JSON 错误 `observation_interrupted`，携带最后游标或
  `operationId`）：**操作未被取消、Host 未停止**。取消操作必须显式 `baseline cancel`；
  停止 Host 必须显式 `host stop`。退出 CLI 客户端同样不停止 Host（Host 是独立后台进程）。
- `accepted` 与观察中断都不得显示为 completed；查询 `baseline status`/`baseline list` 可随时
  取得持久终态，不依赖日志文字或模型结论推断 `passed`。

### 5.7 不自动安装、不自动修复

- CLI 与 Host **不执行仓库脚本来「修好」项目**：不自动安装依赖、不追加安装命令、不运行
  `npm install`/`git stash`/`git reset`/`git commit`、不从配置或仓库文本提取凭据。
  检查命令完全来自用户显式确认的检查计划；`project init` 只读 Git 事实（HEAD/脏状态），
  恶意仓库中的初始化脚本绝不会被执行。
- 基线失败后的修复是**用户动作**：修改仓库 → 重新 `baseline preview` → 显式 `--confirm`
  → 以新 `operationId` 重新检查。已注册项目在失败后仍可 `project overview`/`baseline list`
  查询历史（这本身是预期行为，不是修复）。

## 6. 安全边界（首版）

- 正式支持与验收**仅 macOS**；Windows / WSL / Linux 未验收。
- **可信项目 ≠ 强沙箱**：首版是用户明确授权的可信本机单用户模式，Pi/检查命令以用户权限在
  真实工作区运行，**不提供强文件/进程沙箱**。Host 固定监听 `127.0.0.1` 随机端口，发现文件中的
  本机 token 不防御同一操作系统用户的恶意进程。要求强隔离的场景不得复用本假设。
- 凭据只经受保护文件与认证头传递，不进 URL/响应/日志/证据；`--input` 文件与命令输出中的已登记
  秘密会被脱敏，但通用秘密检测不在保证范围内。本文与示例不含真实凭据、不含开发机固定路径。

## 7. 未实现（`not_run`，不得冒充）

- Work/Batch/Run/Attempt、DAG 调度、Scheduler/Runner、Pi SDK 与真实模型执行、执行域取消
  （含进程树强制终止的产品级 Work 语义）、审批流、通知投递。
- `project init` 的 Profile/技术栈推断、移动 rebind、多 clone 归档（T15 未覆盖子集）。
- 托管 Chat、Web/Electron、NAS/云端、强 OS 沙箱、其他平台验收。
- `npm run accept:p02`（P02 阶段验收）由阶段末项定义，本操作说明**不提供**该命令。

## 8. 测试与文档守护入口

- 纵向回归：`test/p02-3-init-overview-vertical.test.ts`（接入纵向）、
  `test/p02-3-baseline-cli-vertical.test.ts`（基线 CLI 纵向：预览/授权/查询/取消/重启后查询）、
  `test/p02-3-integration-regression.test.ts`（真实 Git/SQLite/进程/Host/CLI 端到端回归）。
- 语义与故障分支：`test/p02-3-baseline-preview-authorize.test.ts`（预览/授权）、
  `test/p02-3-baseline-host-routes.test.ts`（路由）、`test/p02-3-baseline-host-faults.test.ts`/
  `test/p02-3-baseline-host-recovery.test.ts`（故障与恢复）、`test/baseline-evidence.test.ts`
  （证据缺口）、`test/supervised-process-stopping.test.ts`（停止核验）。
- 文档守护：`test/docs-p02-3-operations.test.ts`（本说明示例与命令契约一致）、
  `test/docs-p02-3-onboarding-contract.test.ts`（契约冻结事实）。
- 示例运行证据留在临时数据根的制品存储（`baseline evidence` 可读）与测试断言中；
  证据不收集真实凭据/用户文件正文。
