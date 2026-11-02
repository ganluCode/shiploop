# ShipLoop 新用户安装与操作指南（P08-1 / F-005）

- 适用对象：第一次安装 ShipLoop 并完成「接入仓库 → 规划批准 → 执行 → 停止 → 备份恢复 → 排障 → 清理」的新用户。
- 适用平台：**macOS 是当前唯一正式支持与验收平台**；Windows / WSL / Linux 未验收、不计为通过（见 §13）。
- 工具链：Node `22.19.0`、npm `10.9.3`（与 `distribution-compatibility.json` 固定声明一致；`.npmrc` 在源码仓库启用 `engine-strict`，版本不符直接安装失败）。
- 本文示例只使用临时路径、Shell 变量、占位 UUID/摘要/凭据引用与结构化 JSON；**不含开发机绝对路径、真实 token 或任何需要手工改数据库的步骤**。命令均与当前 CLI/Host 契约一致（守护测试：`test/modules/engineering/p08-1-f005-user-guide-docs.test.ts`）。
- 本指南不把 Harness 或 Nezha 当作产品安装依赖：产品只由 `shiploop-core` / `shiploop-host` / `shiploop-cli` 三包组成；开发编排工具与安装、运行无关。
- 语义纪律贯穿全文：`accepted` 只是提交成功、`not_run` 是显式未执行、退出码 0 不代表业务验收通过；业务结论只来自结构化查询结果与持久回执，**不从日志成功文字推断**。

## 1. 支持边界与安装前提

| 事项 | 状态 |
|---|---|
| 正式支持平台 | macOS（darwin）。安装包 `os` 限定 `darwin` |
| Windows / WSL / Linux | **未支持**：不在当前验收条件内，遇到平台错误（如 `unsupported_platform`）属预期拒绝 |
| Node / npm | 固定 `22.19.0` / `10.9.3`；缺版本或版本不符在安装/启动层明确失败，不静默降级 |
| 原生模块构建 | 需要 Xcode Command Line Tools（`/usr/bin/clang` + macOS SDK）；`better-sqlite3` 等固定版本依赖按锁文件安装 |
| 公开 npm 发布 | **未定**：许可证与 npm scope/公开包名尚待负责人确认（`distribution-compatibility.json` `releaseBlockers` 全部 `pending`），当前只有**本地 pack**（`distributionMode: "local-pack-only"`，`published: false`），本指南不执行 `npm publish` |
| Electron / 桌面客户端 | **后置**：不在本期范围 |
| Runtime | 首版只有 Pi（Node SDK）Runtime 装配；其他 Runtime **未支持**，未知 runtime 在配置层即被拒绝（`unknown_runtime`） |
| 真实模型验收 | **需独立授权**：真实模型调用与 live 验收须另行配置授权与预算，本指南示例不调用真实模型 |
| 独立目录安装/兼容矩阵 | 真实独立目录安装、原生模块加载、打包 Host 启动与已有 Host 兼容矩阵登记为 Phase 集成验证（`phaseIntegration.status: "not_run"`）；本指南给出可执行步骤，但不冒充该矩阵已通过 |

安装前自检（版本号必须与上表一致）：

```sh
node --version    # 必须输出 v22.19.0（示例注释；以 §1 固定版本为准）
npm --version     # 必须输出 10.9.3
xcode-select -p   # 确认 Xcode Command Line Tools 已安装
```

## 2. 获取与安装本地 pack

当前没有公开发布的包；本地 tarball 由源码仓库生成。生成机器与安装机器都要求 §1 的工具链：

```sh
# 1) 在源码仓库副本内（一次性）：安装锁定依赖并构建
npm ci
npm run build          # 编译原生锁模块 + 三个包 + dist 冒烟

# 2) 生成本地三包 tarball 与制品清单（输出目录可显式指定）
npm run pack:local -- --output artifacts/local-pack
#    产出：shiploop-core-0.0.0.tgz / shiploop-host-0.0.0.tgz /
#          shiploop-cli-0.0.0.tgz + distribution-manifest.json（逐文件 SHA-256）

# 3) fail-closed 制品核验（11 项检查；退出码非 0 即不得安装使用）
npm run verify:artifacts
```

- `distribution-manifest.json` 记录生成时的 `gitCommit`、`platform`、`toolchain` 与兼容声明；仓库根的 `distribution-compatibility.json` 是**冻结的支持矩阵**：Host 协议 `wireProtocolVersions [1]`、`wireSchemaVersion 6`（接受 legacy `5`）、未知/更高版本一律 `reject` 不降级；数据库 Schema 可写目标版本 `64`（可读 1..64），更高版本拒写。
- 在**独立安装目录**安装三包（`$PACK_DIR` 指向 pack 输出的绝对路径；安装需要访问 npm registry 拉取固定版本依赖）：

```sh
INSTALL_DIR=$(mktemp -d)          # 示例占位；实际取 mktemp -d 的绝对路径
cd "$INSTALL_DIR"
npm install "$PACK_DIR/shiploop-core-0.0.0.tgz" \
            "$PACK_DIR/shiploop-host-0.0.0.tgz" \
            "$PACK_DIR/shiploop-cli-0.0.0.tgz"
export PATH="$INSTALL_DIR/node_modules/.bin:$PATH"
shiploop host --help              # 能打印帮助即 CLI 入口可用
```

- 三个 tarball 必须同批安装：`shiploop-cli` 依赖 `shiploop-host`、后者依赖 `shiploop-core`（同名同版本互相满足）；缺包或版本漂移在安装层失败。
- 卸载即删除 `$INSTALL_DIR` 与数据根之外无全局残留（CLI 不写全局配置；状态只在数据根内，见 §3）。
- 真实独立目录安装与原生模块加载属于 Phase 集成验证项；如安装失败，按 §11 排障，不手工改库。

## 3. 数据根隔离与目录布局

所有持久状态（SQLite、制品、发现/凭据、备份）只落在**一个数据根**内：

- 省略 `--data-root` 时使用默认根 `~/Library/Application Support/shiploop`（macOS）。
- 每条命令示例都显式传 `--data-root <绝对路径>`：不同数据根完全隔离（各自的库、Host 单例与凭据），适合演示、测试与多环境；相对/空/NUL/`/` 根是输入错误（退出码 2）。
- 布局（权限固定，不手工修改）：

```text
<dataRoot>/
  core.sqlite                       业务库（经命令面读写；禁止手工 sqlite3 改库）
  host/                             0700
    discovery.json                  0600  发现文件（schemaVersion/protocolVersion/…）
    auth.token                      0600  本机认证 token（只经此文件与 Authorization 头传递）
    writer.lock                     0600  单写入者锁（永不被业务清理删除）
  artifacts/<projectId>/<artifactId>/     受控制品正文
  backups/<backupId>/                       备份包（§10）
```

- Host 固定监听 `127.0.0.1` 随机端口；监听地址不可配置，任何 `--bind/--host/--address/--port/--listen*` 参数与 `SHIPLOOP_HOST_*` 监听覆盖一律退出码 2 拒绝。
- 可信本机单用户模式：token 只防未授权的本机读取，**不防同一操作系统用户下的恶意进程**；这不是强沙箱。

## 4. Host/CLI 启动与版本/协议检查

```sh
DATA_ROOT=$(mktemp -d)/data        # 示例占位；实际取 mktemp -d 的绝对路径

# 连接既有 Host；无实例时经正式获锁入口启动一个本机单例并握手
shiploop host start --data-root "$DATA_ROOT" --json

# 只读查询生命周期状态（不启动 Host；无实例时 host_not_found，退出码 3）
shiploop host status --data-root "$DATA_ROOT" --json

# 显式停止并等待三证据（进程退出 + 锁释放 + 发现移除）
shiploop host stop --data-root "$DATA_ROOT" --json
```

`start` 成功的 JSON 信封（字段为结构化事实；凭据永不出现）：

```json
{ "ok": true, "command": "host.start",
  "result": { "outcome": "started", "hostInstanceId": "11111111-2222-4333-8444-555555555555",
              "dataRootIdentity": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
              "listenAddress": "127.0.0.1",
              "port": 54321, "protocolVersion": 1, "lifecycleState": "ready",
              "startedAt": "2026-11-02T00:00:00.000Z" } }
```

- `dataRootIdentity` 实为 64 位小写 hex 的非秘密根身份（示例占位为 UUID 形状，仅示意字段位置）；`protocolVersion` 与 §2 兼容声明一致。
- 版本/协议检查语义：CLI 与 Host 握手双向核验协议与 Schema 版本；未知/更高版本 `protocol_incompatible`（退出码 3）明确拒绝，不猜测降级。重复 `host start` 连接**同一**实例（`already_running`），不会启动第二个写入者。
- 退出 CLI 客户端不会停止 Host；停止只有显式 `host stop`（`stop_not_confirmed` 时保留现场，退出码 1，见 §11）。

## 5. 认证准备

两类认证分开准备：

1. **Host 本机认证（自动）**：`host start` 首次启动时生成受保护 token（§3）；用户无需操作，也不要把 token 复制进任何文档/脚本。
2. **模型执行配置（显式）**：执行与规划需要的 runtime/provider/model/凭据引用写入**当前配置**（Schema v2）。凭据本体保存在你自己的受管位置，配置里只放**引用字符串**；明文 `apiKey`/`token`/`password` 字段会被拒绝。

```sh
WORK_DIR=$(mktemp -d)              # 用户自建输入文件的工作目录（示例占位）

cat > "$WORK_DIR/global-config.json" <<'JSON'
{
  "schemaVersion": 2,
  "strategies": {
    "defaultStrategy": {
      "runtime": "pi",
      "provider": "<provider-id>",
      "model": "<model-id>",
      "credentialRef": "<credential-ref>"
    }
  }
}
JSON

# 首次创建全局当前配置（insert-only；写命令，授权=显式提交该文件，回执可用 receipt get 查询）
shiploop config create --scope global --input "$WORK_DIR/global-config.json" --data-root "$DATA_ROOT" --json

# 读取项目有效配置需在注册项目（§6）之后：全局默认 + 项目覆盖逐项来源；
# config export 输出脱敏投影（引用字符串原样、无明文凭据）
shiploop config export --scope global --data-root "$DATA_ROOT" --json
```

- `runtime/provider/model` 由 Host 可信装配的只读能力目录核验：未知 runtime `unknown_runtime`、不兼容 provider `incompatible_provider`、未列举 model `unsupported_model`，均在提交前拒绝。
- `credentialRef` 只按引用字符串校验（拒绝带凭据的 URL `credential_in_url`）；Core 不解析、不读环境/Keychain。更新配置用 `config update --scope … --revision <int> --input …`（CAS：陈旧 revision 返回 conflict，退出码 1）。
- 真实模型调用与验收需独立授权（§1）；本指南后续步骤的命令语义与是否已配置真实模型无关。

## 6. 注册项目（project init）

```sh
REPO=$(mktemp -d)/repo             # 示例占位；已有本地 Git 仓库的绝对路径
# （示例仓库准备：git init + 至少一个提交；略）

# 1) 静态预览：不注册、零副作用，退出码 0
shiploop project init "$REPO" --data-root "$DATA_ROOT" --json

# 2) 显式确认注册：--confirm 只授权这一次注册请求（project.register 幂等命令）
shiploop project init "$REPO" --name "示例项目" --confirm --data-root "$DATA_ROOT" --json
#   → result.registration.status="registered"、projectId=<uuid>；
#     result.health.status="not_run"（尚无基线，不得视为健康）

# 3) 概览：注册状态与健康状态严格分列
shiploop project overview "$PROJECT_ID" --data-root "$DATA_ROOT" --json

# 4) （可选）查看项目有效配置来源：全局默认 + 项目覆盖逐项来源
shiploop config effective --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
```

- 无 `--confirm` = 只读预览（规范路径/HEAD/脏状态/是否已注册），`registration.status="not_run"`，不折算成功。
- 注册成功**不代表**基线健康；两条轴独立。可选基线检查（同样先预览、后显式 `--confirm`/`--decline`，详见 `docs/p02-3-operations.md`）：

```sh
shiploop baseline preview --project "$PROJECT_ID" --input "$WORK_DIR/baseline-plan.json" --data-root "$DATA_ROOT" --json
shiploop baseline run --project "$PROJECT_ID" --input "$WORK_DIR/baseline-plan.json" --confirm --wait --data-root "$DATA_ROOT" --json
```

- `--decline` 记录持久 `not_run`（`authorization_rejected`），零启动；`--wait` 退出码 0 仅当操作 `completed` 且全部 `required` 检查 `passed`。
- CLI 不自动安装依赖、不执行仓库脚本来「修好」项目；基线失败后的修复是用户动作。

## 7. 规划与批准

最小链路：建 Phase → 导入草稿 Feature → 一次性规划 → 审阅候选 → 批准。

```sh
# 1) 建 Phase（创建恒为 open、revision=1；建立 Phase 不隐含审批或执行）
shiploop phase create --project "$PROJECT_ID" --title "示例阶段" --data-root "$DATA_ROOT" --json
#   → 回执 result 返回稳定 Phase ID（记为 $PHASE_ID）

# 2) 导入草稿计划（--revision 是 Phase 的 CAS；非法计划整组拒绝、零部分写入）
shiploop feature import --project "$PROJECT_ID" --phase "$PHASE_ID" --revision 1 \
  --input "$WORK_DIR/feature-plan.json" --data-root "$DATA_ROOT" --json
#   → result.feature.id / result.feature.revision（记为 $FEATURE_ID / $FEATURE_REVISION；planStatus=draft）
```

草稿计划文件（`$WORK_DIR/feature-plan.json`；schemaVersion 1，未知键拒绝）：

```json
{
  "schemaVersion": 1,
  "feature": { "title": "示例 Feature", "description": null, "labels": [], "sourceRefs": [] },
  "tasks": [
    { "id": "t-1", "title": "示例任务", "complexity": "medium",
      "acceptance": { "criteria": ["行为满足示例验收"] }, "dependsOn": [] }
  ]
}
```

```sh
# 3) 启动一次性规划（写命令：授权=显式提交 planning-input；--revision 是 Feature 的 CAS）
shiploop planning start "$FEATURE_ID" --project "$PROJECT_ID" --phase "$PHASE_ID" \
  --revision "$FEATURE_REVISION" --input "$WORK_DIR/planning-input.json" \
  --data-root "$DATA_ROOT" --json
#   → accepted + batchId/runId/planningTaskId/candidateId；accepted 只表示授权身份已持久绑定，
#     不表示候选已生成、已批准或编码已授权

# 4) 查看进度与候选正文（生成前明确显示 pending_generation）
shiploop planning list --project "$PROJECT_ID" --feature "$FEATURE_ID" --data-root "$DATA_ROOT" --json
shiploop planning candidate "$CANDIDATE_ID" --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json

# 5) 批准候选（绑定 candidateDigest + Feature revision；只原子应用业务计划，不自动开始编码）
shiploop planning approve "$CANDIDATE_ID" --project "$PROJECT_ID" \
  --digest "$CANDIDATE_DIGEST" --revision "$FEATURE_REVISION" --data-root "$DATA_ROOT" --json
#   拒绝：shiploop planning reject "$CANDIDATE_ID" … --reason "<理由>"（保存原因并结束本次规划）
```

规划输入文件（`$WORK_DIR/planning-input.json`；顶层键固定为
`requirementRefs`/`constraints`/`acceptance`/`strategy`/`budget`）：

```json
{
  "requirementRefs": [],
  "constraints": ["规划与编码授权分离"],
  "acceptance": { "criteria": ["候选可审阅并绑定 verification"] },
  "strategy": { "approvalMode": "manual", "taskLimit": null },
  "budget": {
    "batch": { "maxRuns": 1, "maxTotalAttempts": 2, "maxRuntimeStarts": 1,
               "maxNoProgressRuns": 1, "deadlineUtcMs": "2099-06-01T00:00:00.000Z" },
    "run": { "maxAttemptsPerRun": 2, "runTimeLimitMs": 3600000 }
  }
}
```

- `requirementRefs` 是需求制品引用（`artifactId`，可带 `contentHash`）；为空合法，非空引用由 Core 核验。
- `strategy.approvalMode` 必须为 `manual`：候选必须经人工 `planning approve/reject` 决定。
- 旧摘要、旧 revision、跨项目或不可见候选由 Core 拒绝（conflict，退出码 1）；同一 `--command-id` 重放返回原回执，不重复应用。
- 规划 Run 由已配置的 Runtime 执行；执行中的取消/暂停/继续用 §9 的通用控制命令。

## 8. 执行（preview → start → 预算）

```sh
# 1) 只读预览（不创建执行实体、不扣预算；返回 previewDigest=完整输入身份）
shiploop execution preview "$FEATURE_ID" --project "$PROJECT_ID" \
  --input "$WORK_DIR/budget.json" --data-root "$DATA_ROOT" --json
#   → result.status=ready|no_work|blocked、result.previewDigest=<hex64>（记为 $PREVIEW_DIGEST）

# 2) 显式授权启动（--confirm 必填；--preview-digest 由服务端重算比对）
shiploop execution start "$FEATURE_ID" --project "$PROJECT_ID" \
  --input "$WORK_DIR/budget.json" --preview-digest "$PREVIEW_DIGEST" --confirm \
  --data-root "$DATA_ROOT" --json
#   → accepted + batchId/runId（记为 $BATCH_ID / $RUN_ID）；Run 保持 queued；
#     accepted 只是提交成功（退出码 0），尚未执行、未验收

# 3) 预算状态与四态语义（accepted / not_executed / budget_exhausted / business_completed）
shiploop execution budget "$BATCH_ID" --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json

# 4) 预算显式修订（唯一预算写通道：仅增额/延期；CAS revision；修订不启动执行）
shiploop execution revise "$BATCH_ID" --project "$PROJECT_ID" --revision 1 \
  --reason "扩大执行预算" --input "$WORK_DIR/budget-revised.json" --data-root "$DATA_ROOT" --json
```

预算文件（`$WORK_DIR/budget.json`；**完整有限**：缺字段/非法日期/越界/未知键在连接 Host 前以退出码 2 拒绝；有效并发大于一以 `concurrency_not_supported` 拒绝——当前只支持单并发）：

```json
{
  "batch": { "maxRuns": 2, "maxTotalAttempts": 4, "maxRuntimeStarts": 3,
             "maxNoProgressRuns": 2, "deadlineUtcMs": "2099-06-01T00:00:00.000Z",
             "maxTokenTotal": 1000000, "maxCostTotal": 12.5 },
  "run": { "maxAttemptsPerRun": 2, "runTimeLimitMs": 3600000 },
  "concurrency": { "maxConcurrentWorks": 1 }
}
```

- 过期预览（摘要不匹配/前置漂移）→ `preview_stale`（退出码 1）：重新 `execution preview` 取得新 `previewDigest`。
- 预算耗尽 → `budget_exhausted`（退出码 1）；唯一补救是显式 `execution revise`，不自动续跑。
- `business_completed` 只表示 Task 受信通过；`accepted`/`queued` 不显示为验收成功。
- 同父 Batch 显式重试形态：`shiploop execution start "$FEATURE_ID" --project "$PROJECT_ID" --retry-batch "$BATCH_ID" --confirm …`（与 `--input`/`--preview-digest` 互斥）。

**负例（输入错误，退出码 2）**——缺 `--confirm` 在连接 Host 之前本地拒绝，不发启动请求：

```sh
shiploop execution start "$FEATURE_ID" --project "$PROJECT_ID" \
  --input "$WORK_DIR/budget.json" --preview-digest "$PREVIEW_DIGEST" \
  --data-root "$DATA_ROOT" --json     # ✗ 缺 --confirm → 退出码 2（confirmation_required）

shiploop host start --bind 127.0.0.1:8080 --data-root "$DATA_ROOT"   # ✗ 监听地址不可配置 → 退出码 2
```

## 9. 状态查询

全部只读、零副作用（不认领、不扣预算、不启动 Runtime）：

```sh
shiploop execution runs --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json            # Run 列表
shiploop execution attempts "$TASK_ID" --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json  # Task 尝试历史
shiploop execution control "$RUN_ID" --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json    # Run 控制诊断/下一步
shiploop execution recovery "$RUN_ID" --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json   # 恢复诊断
shiploop execution diagnostics "$ATTEMPT_ID" --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json  # 迟到/越权通知审计

shiploop task list --project "$PROJECT_ID" --feature "$FEATURE_ID" --data-root "$DATA_ROOT" --json
shiploop task status "$TASK_ID" --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json    # 机器结论/人审/有效状态三分区
shiploop feature get "$FEATURE_ID" --data-root "$DATA_ROOT" --json
shiploop feature report "$FEATURE_ID" --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop feature delivery "$FEATURE_ID" --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json  # 分轴交付（completed 恒等于 outcome=completed）

shiploop events --project "$PROJECT_ID" --snapshot-only --data-root "$DATA_ROOT" --json   # 事件快照（--follow 持续跟随）
shiploop receipt get "$COMMAND_ID" --data-root "$DATA_ROOT" --json                        # 回执 status=completed 才是成功
```

- `verifying` 是 Runtime 结果待验证，不是验收通过；`task status` 的 `display=passed` 仅在机器通过且有效 Task 通过时成立。
- 观察中断（Ctrl+C/观察预算耗尽）退出码 4：只结束本次观察，**不取消命令、不停止 Host**。

## 10. 显式停止、备份与恢复

### 10.1 停止在途执行与 Host

```sh
# 取消单个 Attempt（--confirm 必填；accepted 只是取消请求被受理，
# 停止核验以 execution session 的 stop 证据 stoppedConfirmed 为准）
shiploop execution cancel "$ATTEMPT_ID" --project "$PROJECT_ID" --confirm --data-root "$DATA_ROOT" --json

# 登记暂停意图（停止新认领；当前 Attempt 验证与必要收尾完成后才转 paused）/ 显式继续
shiploop execution pause --project "$PROJECT_ID" --run "$RUN_ID" --revision 1 --data-root "$DATA_ROOT" --json
shiploop execution resume --project "$PROJECT_ID" --run "$RUN_ID" --revision 2 --data-root "$DATA_ROOT" --json

# 显式停止 Host（三证据：进程退出 + 锁释放 + 发现移除；回执 completed/stopping 不等于已退出）
shiploop host stop --data-root "$DATA_ROOT" --json
```

- 停止不确定（无法核验进程树已停止）→ `stop_unconfirmed`：保留占用与隔离，不重跑、不伪装成功。
- `paused` 是工作流状态：不等于验收通过，也不代表 Feature 完成；`resume` 只登记继续意图，预算不重置。

### 10.2 备份（经 Host/CLI）

```sh
# 创建受管备份包（accepted + operationId；导出由 Host 异步执行）
shiploop backup create --backup-id demo-backup-0001 --data-root "$DATA_ROOT" --json
#   → result.operationId=<uuid>（记为 $OPERATION_ID）

# 完成状态只读持久操作日志（不凭日志文字判断完成）
shiploop backup operation "$OPERATION_ID" --data-root "$DATA_ROOT" --json
shiploop backup get "demo-backup-0001" --data-root "$DATA_ROOT" --json   # → manifestDigest（记为 $MANIFEST_DIGEST）

# 只读核验（数据库完整性/正文哈希/引用核对；摘要必须与请求一致）
shiploop backup verify --backup-id "demo-backup-0001" --manifest-digest "$MANIFEST_DIGEST" \
  --data-root "$DATA_ROOT" --json
```

备份包缺正文/内容漂移/记录不完整（`recording_incomplete`）/原生存储不可导出（`native_archive_unavailable`）时 fail-closed：**不发布包**，操作日志如实 `failed`。

### 10.3 恢复（owner 离线维护入口，不经 HTTP）

```sh
RESTORE_ROOT=$(mktemp -d)          # 必须是空根（只允许 host/锁/staging）

# 1) 离线只读核验包
shiploop restore verify --data-root "$RESTORE_ROOT" --package "$DATA_ROOT/backups/demo-backup-0001" --json

# 2) 准备隔离恢复（输出确认文档；写入 $WORK_DIR/restore-confirmation.json）
shiploop restore prepare --data-root "$RESTORE_ROOT" \
  --package "$DATA_ROOT/backups/demo-backup-0001" --operation-id "$RESTORE_OPERATION_ID" --json

# 3) 负责人审阅确认文档后显式发布
shiploop restore confirm --data-root "$RESTORE_ROOT" --operation-id "$RESTORE_OPERATION_ID" \
  --confirmation-file "$WORK_DIR/restore-confirmation.json" --json
```

- 恢复目标是**隔离恢复根**：发布后执行恢复被阻断（`restored_data_requires_current_facts`），需重新核验外部事实；「管理数据可查询」不等于「已恢复执行」。
- 目标非空（`target_not_empty`）、包未核验（`backup_not_verified`）、缺正文/篡改/高版本（`unsupported_version`）都明确拒绝；不手工拷贝 `core.sqlite` 当备份。

## 11. 失败诊断速查

| 现象 | 首查命令/事实 | 语义与处置 |
|---|---|---|
| 命令响应丢失/超时 | `shiploop receipt get "$COMMAND_ID" …` | 回执 `status=completed` 才是成功；`accepted` 不是。同 `--command-id` 重放返回原回执，不重发副作用 |
| 预览后提交被拒 | error `preview_stale`（退出码 1） | 预览后计划/代码漂移：重新 preview 取新摘要，不重放旧摘要 |
| 预算耗尽 | `execution budget` → `budget_exhausted` | 显式 `execution revise` 增额/延期；不自动续跑、不清计数 |
| Run 卡住/不明 | `execution control` / `execution recovery` | 看 nextActions（resume/await_stop_settlement/…）；停止不确定先核对停止证据 |
| 通知被拒收 | `execution diagnostics` | 迟到/越权通知审计（stale_execution_identity 等固定原因）；是拒绝证据，不改状态 |
| Host 无实例 | `host status` → `host_not_found`（退出码 3） | status 永不自行拉起 Host；`host start` 连接或启动单例 |
| 锁被占、身份不明 | `host start` → `owner_unknown`（退出码 1） | 不删锁、不按 PID 杀进程；先核实现场（发现文件/另一实例） |
| 停止未确认 | `host stop`/取消 → `stop_unconfirmed`（退出码 1） | 保留现场；核对进程/锁/发现三证据后重试，不伪装已停止 |
| 协议不兼容 | `protocol_incompatible`（退出码 3） | 客户端与 Host 的 wire protocol/Schema 版本不匹配：按 §2 兼容声明核对安装批次，未知/高版本不降级 |
| 备份失败 | `backup operation` → `failed` + reasons | 按 reasons 修复后用**新** backupId 重做，不覆盖旧包 |
| 清理被拒 | `retention cleanup` → `retention_policy_not_configured` | 政策唯一来源是全局配置 `policies.retentionPolicy`；未配置即拒绝，不伪造执行 |
| 输入错误 | 退出码 2（不发请求） | 参数/预算/计划文件在连接 Host 前本地校验失败：按错误 details 修命令，不改库绕过 |

退出码总表：`0` 成功；`1` 业务拒绝/操作失败；`2` 输入错误（含监听地址覆盖）；`3` 连接/协议错误；`4` 观察中断（events 与 `--follow/--wait` 观察）。

## 12. 安全清理

清理都是显式命令，各有预览/确认与回执；`accepted`/`completed` 回执不等于目标已删除，最终状态以对应查询为准：

```sh
# 1) 受管工作区：先只读预览（绑定 previewDigest/HEAD/有效期），再显式确认丢弃
shiploop workspace list --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop workspace discard-preview "$FEATURE_ID" --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
#   → 预览 JSON 保存为 $WORK_DIR/discard-preview.json
shiploop workspace discard "$FEATURE_ID" --project "$PROJECT_ID" \
  --preview-file "$WORK_DIR/discard-preview.json" --confirm --data-root "$DATA_ROOT" --json
#   丢弃范围固定为受管工作区目录与 Git 登记；源仓库、Feature 分支、已提交成果与审计记录永不在范围

# 2) 保留政策清理（先只读评估；cleanup 需全局已配置 retentionPolicy）
shiploop retention evaluation --data-root "$DATA_ROOT" --json
shiploop retention cleanup --data-root "$DATA_ROOT" --json

# 3) 项目删除（必须先归档；预览 → 显式确认 → 操作查询）
shiploop project archive "$PROJECT_ID" --revision "$PROJECT_REVISION" --data-root "$DATA_ROOT" --json
shiploop project delete-preview "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop project delete-confirm "$PROJECT_ID" --revision "$PROJECT_REVISION" \
  --preview-digest "$DELETE_DIGEST" --expires-at-ms "$EXPIRES_AT_MS" --confirm \
  --data-root "$DATA_ROOT" --json
shiploop project delete-operation "$DELETE_OPERATION_ID" --data-root "$DATA_ROOT" --json
#   源代码仓库默认保留：删除只作用于受管制品/登记/受管 worktree 与管理数据

# 4) 停止 Host（最后收尾；三证据确认）
shiploop host stop --data-root "$DATA_ROOT" --json
```

## 13. 未支持与不冒充（`not_run` 边界）

- 公开 npm 发布、公开包名/scope、许可证决定：**未定**（负责人 pending）；本指南只覆盖本地 pack。
- Windows / WSL / Linux、Electron/桌面客户端、托管 Chat、NAS/云端、强 OS 沙箱：**未支持或后置**。
- 其他 Runtime（非 Pi）：未支持；Durable 候选不在默认装配。
- 真实模型验收、live 验证：**需独立授权**，本指南示例未调用真实模型。
- 从干净安装目录走完整 Todo 需求到交付、再接入存量仓库增量变更的端到端演示：属 P08 Phase 集成验收，本指南不代签、不折算为已通过。
