# P02-1 Host 单例发现与本机认证操作说明

- 适用 Feature：P02-1（Host 单例发现、本机认证与 CLI 生命周期命令）。
- 适用平台：macOS（首个正式验收平台）；Windows / WSL / Linux 返回 `unsupported_platform`，未验收。
- 协议依据：[p02-1-host-lifecycle-contract.md](p02-1-host-lifecycle-contract.md)（唯一定义，
  本说明不另行定义协议）、[p02-1-writer-lock.md](p02-1-writer-lock.md)（OS 锁实现与边界）。
- 本文只描述**已实现**的 Host 生命周期命令与端口：`shiploop host start|status|stop`。
  项目注册 / 配置 / 基线、SSE、Work/Runner、Pi SDK、执行取消等**未提供**，本文不编造。
- 运行产物与示例不含开发机绝对路径或真实凭据；示例数据根一律用受控临时目录。

## 1. 范围与入口

| 能力 | 入口 | 说明 |
|---|---|---|
| CLI 可执行入口 | `packages/cli/dist/bin.js`（构建后 `bin: shiploop`） | 唯一读 `argv/env`、唯一退出的文件；`npm run build` 后由 `node packages/cli/dist/bin.js …` 调用 |
| Host 后台进程入口 | `packages/host/dist/start.js` | 由 CLI 启动器以独立 argv spawn；不直接面向用户 |
| CLI 执行层 | `runHostCli`（`packages/cli/src/host/execute.ts`） | `start` 走启动器，`status`/`stop` 走 HostClient；测试经它驱动 |
| Host 公共面 | `shiploop-host` 包 | `connectToHost` / `ensureHostRunning` / `acquireWriterLock` / `createHostFileStore` 等 |

CLI 三个子命令：`host start` 连接既有 Host，无实例时仅经正式获锁入口启动；`host status`
只读查询（**不**启动 Host）；`host stop` 显式停止并等待 §10.6 外部证据。公共 CLI 模块
import 无副作用（不解析 argv、不联网、不 spawn）；只有运行 `dist/bin.js` 才执行。

## 2. 先决条件与构建

- Node `22.19.0`、npm `10.9.3`；macOS + Xcode Command Line Tools（`/usr/bin/clang`、macOS SDK）
  用于构建原生锁适配器。
- 构建：`npm ci && npm run build`。`build` 先编译 N-API 锁模块，再 `tsc -b` 三个包、校验
  `dist/bin.js` shebang/权限并运行 dist 冒烟（含 CLI 纵向命令）。原生产物缺失或不可加载时
  Host 返回 `unsupported_platform`，**不**自动编译或降级。

## 3. 命令面与参数

```text
node packages/cli/dist/bin.js host start  [--data-root <abs>] [--json] [--start-timeout-ms <int>]
node packages/cli/dist/bin.js host status [--data-root <abs>] [--json]
node packages/cli/dist/bin.js host stop   [--data-root <abs>] [--json] [--stop-command-id <uuid>] [--confirm-timeout-ms <int>]
node packages/cli/dist/bin.js host --help
node packages/cli/dist/bin.js --help
```

- `--data-root <abs>`：POSIX 绝对路径；省略 = P01 默认根（`<home>/Library/Application Support/shiploop`）。
  相对/空/NUL/`/` 为输入错误（退出码 2）。仅 `start` 允许创建数据根；`status`/`stop` 不创建。
- `--json`：stdout 只输出单个 JSON 信封；人类诊断到 stderr。
- `--start-timeout-ms`：仅 start，默认 `15000`，范围 `1000..60000`。
- `--stop-command-id`：仅 stop，UUID v4；省略时由 CLI 生成。
- `--confirm-timeout-ms`：仅 stop，默认 `10000`，范围 `0..30000`。
- **监听地址不可配置**：`--bind/--host/--address/--port/--listen*` 参数与
  `SHIPLOOP_HOST_BIND/HOST/PORT/ADDRESS/LISTEN*` 环境变量一律拒绝（退出码 2，覆盖值不回显）。
  Host 固定绑定 `127.0.0.1` 的随机端口。

## 4. 最小可运行示例

以下命令在临时数据根上可复跑（`$ROOT` 为受控临时目录绝对路径，例如 `mktemp -d` 下的子目录）：

```sh
# 0) 构建入口
npm ci
npm run build

# 1) 连接或启动 Host（同实例重复 start 不会启动第二个写入者）
node packages/cli/dist/bin.js host start  --data-root "$ROOT" --json

# 2) 只读查询生命周期状态（不启动 Host）
node packages/cli/dist/bin.js host status --data-root "$ROOT" --json

# 3) 显式停止，并等待进程退出/释锁/发现移除三项证据
node packages/cli/dist/bin.js host stop   --data-root "$ROOT" --json

# 4) 停止后 status 应失败为 host_not_found（退出码 3），不会自行拉起新 Host
node packages/cli/dist/bin.js host status --data-root "$ROOT" --json; echo "exit=$?"
```

成功后 `start` 的 JSON 形如（字段为真实事实，凭据永不出现）：

```json
{ "ok": true, "command": "host.start",
  "result": { "outcome": "started", "hostInstanceId": "<uuid-v4>",
              "dataRootIdentity": "<64-hex>", "listenAddress": "127.0.0.1",
              "port": 54321, "protocolVersion": 1, "lifecycleState": "ready",
              "startedAt": "2026-10-05T00:20:00.000Z" } }
```

`outcome` 为 `already_running`（已连接既有实例）或 `started`（本次启动并握手成功）。
该纵向闭环由 [test/modules/host/docs-p02-1-operations.test.ts](../test/modules/host/docs-p02-1-operations.test.ts)
在真实临时数据根与真实 Host 子进程上运行守护；构建冒烟
(`scripts/smoke-built-entries.ts`) 另从 `dist`、非源码 cwd 跑通同样命令。

## 5. 发现 / 凭据 / 锁布局

```text
<canonicalRoot>/
  core.sqlite
  host/                    0700（当前用户所有）
    discovery.json         0600
    auth.token             0600
    writer.lock            0600（永不被业务清理删除）
```

- `canonicalRoot` 为 realpath 固定的规范根；`dataRootIdentity = lower_hex(sha256(utf8Bytes(canonicalRoot)))`，
  是 64 位小写 hex 的**非秘密**标识符，不是认证凭据。同一真实根的路径别名得到同一身份与同一把锁。
- 发现文件字段固定（`schemaVersion`、`protocolVersion`、`hostInstanceId`、`dataRootIdentity`、
  `listenAddress="127.0.0.1"`、`port`、`pid`、`startedAt`），未知字段拒绝。
- 权限过宽、根外符号链接、非普通文件、JSON 损坏或身份不符一律 fail-closed：拒绝连接、
  不尝试 chmod「修复」、不覆盖可疑位置、不另起写入者。
- `auth.token` 为密码学随机本机凭据，仅经受保护文件与 HTTP `Authorization: Bearer` 头传递；
  客户端只从规范根 `host/auth.token` 读取，发现文件没有「凭据路径」字段。

## 6. 停止语义与完成判据

- `host stop` 是版本化操作：同 `commandId` + 同请求摘要重放返回同一结果（`replayed: true`）；
  同 ID 不同摘要返回 `conflict`。仅支持 graceful 停止，未实现停止选项返回 `unsupported`。
- 只在同时取得全部三项外部证据后才报告 `stopped`：进程已退出、OS 锁可被新候选获取、
  发现已按实例删除或被新实例替换。HTTP `completed/stopping` 回执、连接断开、CLI 自身退出
  **都不算**已停止。
- 预算内无法确认时返回 `stop_not_confirmed`（退出码 1）并**保留现场**（锁与进程仍在），
  不报告 stopped、不启动替代写入者。
- 退出客户端、断开连接、取消观察**不会**停止 Host；Host 继续存活，另一客户端可经认证
  `status` 证明。安全停止只能显式 `host stop`，或对 Host 进程发 `SIGTERM`（走同一安全收尾）。

## 7. 错误与退出码

四档退出码（细分原因只看 `error.code`）：

| 退出码 | 类别 | 情形（`error.code` 示例） |
|---|---|---|
| 退出码 0 | 成功 | start `already_running`/`started`；status 取到真实状态；stop 取得全部证据 |
| 退出码 1 | 业务拒绝 / 操作失败 | `unauthorized`、`instance_mismatch`、`data_root_mismatch`、`resource_busy`、`stop_not_confirmed`、`owner_unknown`、`unsupported`、`unsupported_platform`、`not_ready` |
| 退出码 2 | 输入错误（尚未联网） | 参数解析失败、非法数据根、监听覆盖、`unsafe_discovery`、`invalid_discovery` |
| 退出码 3 | 连接 / 协议错误 | `host_not_found`、不可达、超时、`protocol_incompatible`、`response_malformed`、`redirect_rejected`、`start_timeout` |

`--json` 失败信封：`{ "ok": false, "command": "host.stop", "error": { "code": "…", "message": "…" } }`；
stdout 只含该单个 JSON，人类诊断走 stderr，错误不含 token、`Authorization` 头、绝对路径或堆栈。

## 8. 失效发现 / owner_unknown 诊断与恢复

- 发现缺失/损坏或不安全：`status`/`start` 返回 `invalid_discovery` / `unsafe_discovery`（退出码 2）
  或 `host_not_found`（退出码 3）；**不**自动删除文件或绕过锁。
- 锁被占但实例无法核验（发现缺失/损坏、握手身份或认证失败、协议不兼容）：`start` 返回
  `owner_unknown`（退出码 1），`host start` 在预算内重新发现/等待，但绝不删锁、绝不按 PID 杀进程、
  绝不启动第二个写入者。锁可核验且有实例时给出 `owner_active`。
- 崩溃或被 `SIGKILL` 后由 OS 释放锁；残留的陈旧发现由「获锁且确认旧实例不再持有写入权」的
  新 Host 按原子发布替换，新实例换新身份与凭据，旧发现/旧凭据对新实例一律无效。
- 陈旧 PID 指向无关活进程时不得终止该无关进程；启动器只对自己 spawn 的候选进程做有界回收。

## 9. 证据获取与脱敏

- 停止的判定证据可由 CLI 的 `--json` 结果读取：`evidence.processExit`、`evidence.lock`
  （`acquirable`/`superseded`）、`evidence.discovery`（`removed`/`replaced`）。
- 回归/夹具证据的非秘密类别包括：`hostInstanceId`、`dataRootIdentity`、回环监听地址与端口、
  文件权限（`host/` 0700 与发现/凭据/锁 0600）、进程 PID/退出码/信号、锁可获性与命令退出码。
  Authorization 头与 `auth.token` 正文**不进任何证据**。
- 详细的分支映射与 not_run 记录见
  [docs/acceptance/evidence-p02-1/f013-regression-evidence.md](acceptance/evidence-p02-1/f013-regression-evidence.md)。

## 10. 安全边界

- 首版仅面向**用户明确授权的可信本机单用户**场景，且**仅正式验收 macOS**；Windows/WSL/Linux、
  共享 NAS、通用/签名二进制分发另行验收。
- 锁是**协作式 advisory** 边界（`flock` / N-API）：不防同一操作系统用户的恶意进程主动替换锁
  inode、绕过 API 直接写 SQLite、关闭任意 fd 或加载恶意原生代码。
- 发现文件中的本机 `token` 只防未授权的本机读取，**不防**所有同用户攻击；错误文案不回显秘密。
- 首版不提供强 OS 沙箱；要求强隔离的任务不应复用本模式。

## 11. 未实现 / not_run（不得冒充）

- 项目注册 / 配置 / 基线（onboarding）、`project`/`run`/`feature` 等后续命令：未提供。
- SSE / 事件游标、Work/Batch/Run/Attempt 调度、Scheduler、Runner、Pi SDK 与模型执行、
  执行取消（含进程树强制终止）、Chat、Web/Electron 配对、通知：未提供。
- 通用命令回执体系与 `command_receipts` 持久化：本 Feature 的「幂等」仅指同一 Host 实例的
  停止请求在进程生命期内的版本化去重，不跨重启保留回执。
- `npm run accept:p02` 属 P02 阶段末项；本 Feature 不提供整阶段通过脚本，不声称整个 P02 已验收。
- Windows / WSL / Linux、强 OS 沙箱、模型 Live：`not_run` / 未支持。

## 12. 验证

仓库级验证：`npm test`（开发内循环）；`npm run typecheck`；`npm run check:boundaries`；
`npm run build`（含 dist 冒烟）；`npm run verify`（锁文件预检 + `npm test` / `typecheck` / `build`
串联，fail-closed）。文档示例与实现的一致性由
[test/modules/host/docs-p02-1-operations.test.ts](../test/modules/host/docs-p02-1-operations.test.ts) 守护（真实 Host
子进程纵向闭环 + 解析面/常量交叉核对 + 无开发机路径/凭据断言）。
