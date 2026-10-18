# P02-2 应用命令、查询与事件操作说明

- 适用 Feature：P02-2（应用命令、回执、项目/配置查询、一致快照与 SSE 事件）。
- 适用平台：macOS（首个正式验收平台）；Windows / WSL / Linux 未验收。
- 协议依据：[p02-2-commands-events-contract.md](p02-2-commands-events-contract.md)（唯一定义，
  本说明不另行定义协议/路由/字段），生命周期传输与锁见
  [p02-1-host-lifecycle-contract.md](p02-1-host-lifecycle-contract.md)、
  [p02-1-writer-lock.md](p02-1-writer-lock.md)。
- 本文只描述**已实现并已有真实纵向回归**的能力：`project.*`、`config.*`、`receipt get`、
  `events` 与复用 P02-1 的 `host start|status|stop`。基线健康、初始化确认、Skills、Pi/Work、
  调度与整个 P02 阶段验收**不属于**本次交付，本文不编造。
- 全部示例使用真实构建入口与受控临时数据根，不含开发机绝对路径或真实凭据。

## 1. 范围与入口

| 能力 | 入口 | 说明 |
|---|---|---|
| CLI 可执行入口 | `packages/cli/dist/bin.js`（构建后 `bin: shiploop`） | 唯一读 `argv/env`、唯一退出的文件；`npm run build` 后由 `node packages/cli/dist/bin.js …` 调用 |
| Host 后台进程入口 | `packages/host/dist/start.js` | 由 CLI 启动器以独立 argv spawn；不直接面向用户 |
| Core 组合根 | `shiploop-core/assembly`（`openCoreApplication`） | Host 经包名公共入口装配；CLI 不直接依赖 |
| Core 纯协议入口 | `shiploop-core/protocol` | HostClient 复用的校验器、摘要与协议常量；不导入装配/应用服务 |
| Host 公共面 | `shiploop-host` 包 | `connectToHost` / `ensureHostRunning` / HostClient 业务方法 |
| CLI 执行层 | `runAppCli`（`packages/cli/src/app-execute.ts`） | `dist/bin.js` 同一路径；业务命令经它连接或启动同一单例 Host |

- 业务命令经 `ensureHostRunning` 连接既有 Host；无实例时只经正式获锁入口启动**同一**单例
  （CLI 自身不打开 SQLite、不读认证文件）。`host status`/`host stop` 等只读命令**永不**启动 Host。
- CLI 公共模块 import 无副作用（不解析 argv、不联网、不 spawn）；只有运行 `dist/bin.js` 才执行。

## 2. 先决条件与构建

- Node `22.19.0`、npm `10.9.3`；macOS + Xcode Command Line Tools（`/usr/bin/clang`、macOS SDK）
  用于构建原生锁适配器。
- 构建：`npm ci && npm run build`。`build` 先编译 N-API 锁模块，再 `tsc -b` 三个包、校验
  `dist/bin.js` shebang/权限并运行 dist 冒烟（覆盖 host 生命周期、CLI project/config/receipt
  纵切、快照/游标恢复与 SIGINT 纵切）。原生产物缺失或不可加载时明确失败，不自动降级。

## 3. 命令面与参数

```text
node packages/cli/dist/bin.js host start|status|stop …           （P02-1 既有，语义不变）

node packages/cli/dist/bin.js project register <repository-path> --name <displayName>
        [--description <text>] [--label <l> ...] [--command-id <uuid>] [--data-root <abs>] [--json]
node packages/cli/dist/bin.js project list [--label <l> ...] [--match any|all]
        [--limit <int>] [--cursor <id>] [--data-root <abs>] [--json]
node packages/cli/dist/bin.js project get <projectId> [--data-root <abs>] [--json]
node packages/cli/dist/bin.js project edit <projectId> --revision <int>
        [--name <text>] [--description <text>] [--label <l> ...] [--command-id <uuid>] [--json]
node packages/cli/dist/bin.js project labels [--data-root <abs>] [--json]

node packages/cli/dist/bin.js config create --scope global --input <file> [--command-id <uuid>]
node packages/cli/dist/bin.js config create --scope project --project <id> --input <file> [--command-id <uuid>]
node packages/cli/dist/bin.js config update --scope global --revision <int> --input <file> [--command-id <uuid>]
node packages/cli/dist/bin.js config update --scope project --project <id> --revision <int> --input <file> [--command-id <uuid>]
node packages/cli/dist/bin.js config get --scope global
node packages/cli/dist/bin.js config get --scope project --project <id>
node packages/cli/dist/bin.js config effective --project <id>
node packages/cli/dist/bin.js config export --scope global
node packages/cli/dist/bin.js config export --scope project --project <id>

node packages/cli/dist/bin.js receipt get <commandId> [--data-root <abs>] [--json]
node packages/cli/dist/bin.js events (--project <id> | --global) [--cursor <cursor>]
        [--snapshot-only] [--follow] [--data-root <abs>] [--json]
```

- `--data-root <abs>`：POSIX 绝对路径（省略 = P01 默认根）；相对/空/NUL/`/` 为输入错误
  （退出码 2）。业务写命令与 `host start` 允许创建数据根；只读命令在无实例时给出连接错误。
- `--json`：单次命令 stdout 只输出一个 `{ok,command,result|error}` 信封；事件观察为 NDJSON
  记录流；人类诊断到 stderr。
- `--command-id <uuid v4>`：写命令可显式指定；省略时由 HostClient 生成一次并冻结。重复提交
  用**同一**信封（先查回执），不重新生成 `issuedAt`/`expiresAt`/payload。
- `project list`：`--limit` 默认 `50`，范围 `1..200`；`--cursor` 为服务端签发的不透明键集游标。
- `project edit` / `config update`：`--revision <int>` 必填且 `≥ 1`，与当前持久 revision 一致，
  否则 `conflict` 且对象不变。
- `--input <file>` 只是**本次请求的输入**（配置 payload `schemaVersion=2`）：CLI 不监听文件变化、
  不做覆盖式配置，文件内容也不能指定 Core 数据库路径、结果读取路径或提权主体。
- `events`：`--follow` 为默认；`--snapshot-only` 只取快照与补读一页后退出；`--project` 与
  `--global` 互斥。`--cursor` 为显式恢复游标（不透明，客户端只保存/回传）。
- **监听地址不可配置**：`--bind/--host/--address/--port/--listen*` 参数与
  `SHIPLOOP_HOST_BIND/HOST/PORT/ADDRESS/LISTEN*` 环境变量一律拒绝（退出码 2）。

## 4. 最小可运行示例（临时仓库注册 → 配置 CAS → 查回执）

以下步骤在受控临时数据根与真实 Git 仓库上可复跑（`$ROOT` / `$REPO` 为临时绝对路径）：

```sh
# 0) 构建入口
npm ci
npm run build

# 1) 注册已有仓库（不是 P02-3 的完整 project init；注册成功不代表基线健康）
node packages/cli/dist/bin.js project register "$REPO" \
  --name "示例项目" --label demo --data-root "$ROOT" --json

# 2) 以显式 configId 创建全局当前配置（insert-only）
printf '%s' '{"schemaVersion":2,"policies":{"executionLimits":{"maxConcurrentWorks":1}}}' > "$ROOT/global.json"
node packages/cli/dist/bin.js config create --scope global \
  --input "$ROOT/global.json" --command-id "$CMD" --data-root "$ROOT" --json

# 3) CAS 更新（--revision 必须等于当前值）；命令超时/响应丢失时先查回执
node packages/cli/dist/bin.js receipt get "$CMD" --data-root "$ROOT" --json

# 4) 授权快照 + 事件恢复（先取水位，再显式游标补读或跟随）
node packages/cli/dist/bin.js events --project "$PROJECT_ID" --snapshot-only \
  --data-root "$ROOT" --json
node packages/cli/dist/bin.js events --project "$PROJECT_ID" --cursor "$CURSOR" \
  --data-root "$ROOT" --json

# 5) 停止 Host 仍只有显式命令（观察中断只结束本次观察）
node packages/cli/dist/bin.js host stop --data-root "$ROOT" --json
```

`project register` 成功的 `--json` 是命令回执，不是普通查询结果，形如：

```json
{ "ok": true, "command": "project.register",
  "result": { "schemaVersion": 2, "commandId": "<uuid-v4>", "operation": "project.register",
              "status": "completed", "replayed": false, "resultRef": "v1.<43 chars>",
              "result": { "status": "registered",
                          "project": { "id": "<uuid-v4>", "revision": 1, "displayName": "示例项目" },
                          "binding": { "canonicalPath": "<abs>" } } } }
```

`config update` 成功后 `result.revision` 递增；相同 `--command-id` + 相同参数的再次提交返回
同一回执（`replayed: true`，`resultRef` 不变），不同参数复用同一 `--command-id` 得到
`conflict`（`details.reason='idempotency_key_reuse'`，零副作用）。该纵切由
[test/modules/cli/app-cli-execute.test.ts](../test/modules/cli/app-cli-execute.test.ts)、
[test/modules/cli/app-cli-config-execute.test.ts](../test/modules/cli/app-cli-config-execute.test.ts) 与文档守护
[test/modules/commands/docs-p02-2-operations.test.ts](../test/modules/commands/docs-p02-2-operations.test.ts) 在真实 Host 子进程上运行。

## 5. 命令回执、幂等与超时语义

- P02-2 支持的命令都是**同步短事务命令，提交即完成**：成功回执一律 `status='completed'`。
  枚举值 `accepted` 仅为前向兼容保留，本版任何代码路径都不会产生它，也不为不存在的异步操作
  伪造 `operationId`。
- **只有 `completed` 是成功**：`accepted` 不表示完成，`rejected` 是业务拒绝。查询回执时
  据此判断（`receipt get` 对 `rejected` 回执也以退出码 1 返回并保留 `error.code`）。
- **幂等键 = `(principalId, commandId)` + 请求摘要**（`requestDigest` 由服务端按规范化 JSON
  重算，`commandId` 不进摘要）：
  - 同 `commandId` + 同摘要 → 命中原持久回执（`replayed: true`），零副作用、revision 不增长、
    不重复写事件；
  - 同 `commandId` + **不同摘要** → `conflict`（`details.reason='idempotency_key_reuse'`），
    既有回执与业务对象不变；
  - 过期新命令 → `command_expired`（不写回执、不改业务）；过期信封重放仍可取回原回执。
- **超时/响应丢失先查回执**：客户端在有限预算内先 `GET /v1/receipts/:commandId`，命中即取回原
  结果，不重发副作用；回执仍未知才用**完全相同的信封**重发。连接失败不解释成业务拒绝或已完成；
  预算耗尽明确为结果不确定（`outcome_unknown`），不无限重试、不另起争写 Host。
- `resultRef`（`v1.` + 43 字符 base64url）是**不透明结果引用**，不是数据库定位符/文件路径；
  经授权 `GET /v1/results/:resultRef` 解析为原命令固化结果，项目后续编辑不改变该次结果，
  伪造/不可见引用一律 `not_found`。

## 6. 查询、快照与分页

- 授权过滤**先于**分页/计数：可见范围谓词下推到 SQL，禁止「全库分页后内存过滤」；标签计数只
  统计可见项目。非法 `limit`/`cursor` 拒绝（`invalid_input`）。
- `config get`：未配置返回 `configured:false`（明确区别于损坏 `corrupt_state`）；`config effective`
  返回全局默认 + 项目覆盖的逐项来源（`global_default`/`project_default`）；`config export` 返回
  脱敏投影（引用字符串原样、不解析、不含明文凭据与 `executable`/`ready` 结论）。
- `GET /v1/snapshot`：项目/全局状态、当前配置、有效配置来源与 `watermark` 在**同一 SQLite 一致读
  视图**内取得。`watermark.sequence = MAX(state_events.sequence)`（空库为 `0`），
  `watermark.cursor` 为不透明续读游标；快照边界与后续写入之间无业务缺口。

## 7. 事件与恢复语义

- 事件封套 `schemaVersion=1`，`eventId = state_events.id`（去重键），`sequence` 为持久全局游标，
  事件按 `sequence` 升序、至少一次投递。P02-2 事件类型白名单：

  | type | 何时写 |
  |---|---|
  | `project.registered` | 命令路径注册成功 |
  | `project.metadata_updated` | P01 直接服务与命令路径共用（不重复） |
  | `settings.global_created` / `settings.project_created` | 命令路径配置首建成功 |
  | `settings.global_updated` / `settings.project_updated` | P01 直接服务与命令路径共用（不重复） |

- 游标形态 `evcur_v1_<base64url>`，绑定数据根身份与 scope；客户端只保存/回传，不依赖解码内容。
  非法/未知版本/负数/超出安全整数/数据根或 scope 不符 → `invalid_input`，**不得当作从零读取**。
- **snapshot_required**：游标低于可续读下界时，建连前返回 `409`（`details.snapshotRoute='/v1/snapshot'`），
  建连后以 `event: error` + `data:{"code":"snapshot_required"}` 帧结束该流。客户端必须**明确重取
  快照**后从新水位续读，不默默丢历史事件。其他项目造成的 sequence 空隙不是丢失，客户端不得以
  连续性假设判缺口。
- **慢客户端重载**：单连接待发送缓冲上限 `1 048 576` 字节，超限发送一帧
  `data:{"code":"stream_overflow","snapshotRoute":"/v1/snapshot"}` 后结束该流：要求重取快照/续读，
  **不丢持久审计**，也不阻塞快客户端。完整 `state_events` 仍可从 SQLite 读取。
- **观察中断**：`events` 跟随中被 Ctrl+C/Abort/观察超时中断（或收到 `stream_overflow`）只表示
  **本次观察**结束，退出码 4，终态 NDJSON 记录的 `error.code='observation_interrupted'`/
  `stream_overflow` 含最后游标与 `lastEventId`；命令未被取消、已提交业务未回滚、Host 未停止。
- 连接关闭只清理该连接的轮询/订阅/心跳；客户端断开不停止 Host。Host 重启后仍可用原持久游标续读。

## 8. 错误与退出码

五档退出码（细分原因只看 `error.code`）：

| 退出码 | 类别 | 情形（`error.code` 示例） |
|---|---|---|
| 退出码 0 | 成功 | 命令 `completed`；查询/快照成功；`--snapshot-only` 正常结束 |
| 退出码 1 | 业务拒绝/操作失败 | `forbidden`、`conflict`、`not_found`、`not_ready`、`resource_busy`、`unsupported`、`unsupported_platform`、`corrupt_state`、`internal`、`stop_not_confirmed` |
| 退出码 2 | 输入错误（尚未联网） | 参数/输入 JSON/非法 ID 与分页/scope 冲突/监听覆盖、`unsafe_discovery`、`invalid_discovery` |
| 退出码 3 | 连接/协议错误 | `host_not_found`、不可达、超时、重定向、`protocol_incompatible`、`unsupported_schema_version`、`response_malformed`、`start_timeout` |
| 退出码 4 | 观察中断（P02-2 新增） | `events` 跟随被 Ctrl+C/Abort/超时中断，或 `stream_overflow` 结束：只结束本次观察 |

- `--json` 失败信封：`{ "ok": false, "command": "config.update",
  "error": { "code": "conflict", "message": "…", "commandId": "<uuid-v4>",
  "details": { "reason": "idempotency_key_reuse" } } }`；stdout 只含单个 JSON，人类诊断走 stderr，
  错误保留 `commandId` 便于查回执。
- 服务端错误码 `unsupported`（未实现 Work/Chat/基线等版本化操作，501）与传输层拒绝（400/401/413/501）
  是 P02-1 错误体形状，不是回执；`accepted` 与观察中断**不得**显示为 `completed`。
- 错误体永不回显 token、`Authorization` 头、payload 原文、绝对路径或堆栈；授权不可见与不存在
  统一表现为 `forbidden`/`not_found`，不泄漏项目/路径/配置存在性。

## 9. HTTP 路由（供直接集成参考）

全部路由需 Bearer 认证，前缀 `/v1`：`POST /v1/commands`（唯一命令入口，信封内 `operation` 判别）、
`GET /v1/receipts/:commandId`、`GET /v1/results/:resultRef`、`GET /v1/projects`、
`GET /v1/projects/:projectId`、`GET /v1/projects/:projectId/repository-binding`、
`GET /v1/projects/label-counts`、`GET /v1/settings/global`、`GET /v1/settings/global/export`、
`GET /v1/projects/:projectId/settings`、`GET /v1/projects/:projectId/settings/effective`、
`GET /v1/projects/:projectId/settings/export`、`GET /v1/snapshot`、`GET /v1/events`（`text/event-stream`）。
纪律：命令一律 POST、查询一律 GET、事件仅 SSE；表外路径（含任何 `/v1/files`、path/locator 形态）
一律 `404`，**永不**返回文件内容；绝对路径、`..` 穿越、符号链接、伪造 `resultRef` 均不能读到目标
文件。请求/响应体积上限为有限实施值（`/v1/commands` 与查询响应 65 536 B、查询串 8 192 B 等），
不可开放为可配置项。

## 10. 安全边界

- 首版仅面向**用户明确授权的可信本机单用户**场景，且**仅正式验收 macOS**；Windows/WSL/Linux、
  共享 NAS、强 OS 沙箱与通用/签名分发另行验收。
- Host 固定监听 `127.0.0.1` 随机端口，无 CORS、无 3xx、`cache-control: no-store`；本机单令牌
  （`Authorization: Bearer`）只防未授权的本机读取，**不防**所有同用户攻击；`local-owner` 生产主体
  持全部能力，受限主体只在可信测试装配出现，绝不来自请求数据（`actorId`/`principal` 等提权字段
  作为未知键拒绝）。
- 授权检查在 Core 应用层：直接调用应用服务（不经 HTTP）同样被拒绝；历史回执重放重新核验当前
  身份与权限，已有 `commandId` 不绕过授权。

## 11. 未实现 / not_run（不得冒充）

- `project register` 不是 P02-3 的完整 `project init`：无用户确认流程、无基线/健康检查、无 Profile/
  技术栈推断、无 Skills 参数；注册成功不代表基线健康或执行就绪。
- Work/Batch/Run/Attempt 调度、Scheduler、Runner、Pi SDK 与真实模型执行、执行取消（含进程树
  强制终止）、审批流、通知投递：未提供。
- 托管 Chat、Web/Electron 客户端、NAS/云端、强 OS 沙箱：未提供。
- `npm run accept:p02` 属 P02 阶段末项，本 Feature 不提供整阶段通过脚本，不声称整个 P02 已验收。
- 非 macOS 平台验收、真实 Pi runtime session（本 Feature 全程未调用 LLM）：`not_run`。

## 12. 验证

仓库级验证：`npm test`（开发内循环）；`npm run typecheck`；`npm run check:boundaries`；
`npm run build`（含 dist 冒烟）；`npm run verify`（锁文件预检 + `npm test` / `typecheck` / `build`
串联，fail-closed）。文档示例与实现的一致性由
[test/modules/commands/docs-p02-2-operations.test.ts](../test/modules/commands/docs-p02-2-operations.test.ts) 守护（真实临时仓库/
数据根与真实 Host 子进程纵向闭环 + 解析面/常量交叉核对 + 无开发机路径/凭据断言）；FR 分支与
脱敏证据见 [acceptance/evidence-p02-2/f018-regression-evidence.md](acceptance/evidence-p02-2/f018-regression-evidence.md)。
