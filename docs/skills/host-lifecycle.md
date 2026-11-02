# Skill：host lifecycle（安装自检、本地 pack 与 Host 生命周期）

用途：在新机器上安装 ShipLoop 并安全地启动、查询、显式停止 Host。本 Skill 只通过
正式命令面操作：安装与构建命令属于用户逐条确认的工程流程，本 Skill 不自动执行；
Host 操作只经正式 CLI 入口（安装后即 `shiploop`，源码仓库内亦即
`node packages/cli/dist/bin.js`），不直接读写 SQLite、业务状态、权限文件（发现文件/
token/锁）或发布配置，不执行 `npm publish`，不请求真实模型。模型输出不能替代用户确认。

## 1. 前置条件

- 平台：macOS 是当前唯一正式支持与验收平台；Windows / WSL / Linux 未支持，
  平台错误（如 `unsupported_platform`）属预期拒绝，不折算为通过。
- 工具链：Node `22.19.0`、npm `10.9.3`（与 `distribution-compatibility.json` 冻结
  声明一致；源码仓库 `.npmrc` 启用 `engine-strict`，版本不符直接安装失败）。
- 原生模块构建需要 Xcode Command Line Tools；固定版本依赖按锁文件安装。
- 公开发布未定：许可证与 npm scope/公开包名尚待负责人确认（`releaseBlockers`
  全部 pending），当前只有本地 pack（`distributionMode: "local-pack-only"`）。
- 从干净安装目录驱动的完整 Todo 演示、存量仓库增量变更与跨层失败恢复属于
  P08-2 / P08-3 / P08-4 集成验收，本 Skill 只给出步骤，不代签、不折算为已通过（not_run）。

安装前自检（版本号必须与上表一致；以下为只读检查命令）：

```sh
node --version     # 必须输出 v22.19.0
npm --version      # 必须输出 10.9.3
xcode-select -p    # 确认 Xcode Command Line Tools 已安装
```

## 2. 输入

- `<pack-dir>`：本地 pack 输出目录绝对路径（tarball 与制品清单所在）。
- `<install-dir>`：独立安装目录绝对路径（空目录）。
- `<data-root>`：规范数据根（POSIX 绝对路径）；省略时使用默认根
  `~/Library/Application Support/shiploop`。不同数据根完全隔离；相对/空/NUL/`/`
  根是输入错误（退出码 2）。
- Host 命令参数：`--json`（stdout 只输出结构化结果）、`--command-id <uuid>`
  （stop 显式命令 ID，幂等重试用同一 ID）。Host 生命周期命令不使用 `--confirm`：
  stop 的确认语义是用户显式执行该命令本身；`--confirm` 用于业务破坏性命令
  （如 execution start / execution cancel，见对应 Skill）。
- 输入边界：不接受数据库路径、token 路径、监听地址或提权主体；Host 固定监听
  127.0.0.1 随机端口，任何监听覆盖参数一律退出码 2 拒绝。

## 3. 实际命令与操作步骤

步骤 1 — 生成本地 pack（源码仓库内；用户逐条确认的工程流程，Skill 不自动执行）：

```sh
# 源码仓库副本内：安装锁定依赖并构建（构建失败不继续）
npm ci
npm run build
# 生成三包 tarball 与 distribution-manifest.json（逐文件 SHA-256）
npm run pack:local -- --output <pack-dir>
# fail-closed 制品核验（退出码非 0 即不得安装使用）
npm run verify:artifacts
```

步骤 2 — 独立目录安装（三个 tarball 必须同批安装：cli 依赖 host、host 依赖 core；
安装需要访问 npm registry 拉取固定版本依赖）：

```sh
cd <install-dir>
npm install <pack-dir>/shiploop-core-0.0.0.tgz <pack-dir>/shiploop-host-0.0.0.tgz <pack-dir>/shiploop-cli-0.0.0.tgz
export PATH="<install-dir>/node_modules/.bin:$PATH"
# 入口冒烟：能打印帮助即 CLI 入口可用（不启动 Host）
shiploop host --help
```

```sh
# 公开发布未定：以下命令永不执行
npm publish <pack-dir>/shiploop-cli-0.0.0.tgz   # ✗ 不执行：releaseBlockers pending，Skill 永不 npm publish
```

步骤 3 — Host 生命周期（全部经正式 CLI；写操作前向用户展示确切命令并请求确认）：

```console
# 连接或受控启动同一数据根的单例 Host（首次启动自动生成受保护 token，用户无需操作）
shiploop host start --data-root <data-root> --json
```

```console
# 只读生命周期查询（不启动 Host；无实例时 host_not_found，退出码 3）
shiploop host status --data-root <data-root> --json
```

```console
# 显式停止（唯一 Host 停止途径；completed 前需三证据：进程退出 + 锁释放 + 发现移除）
shiploop host stop --data-root <data-root> --json
```

```console
shiploop host start --bind 127.0.0.1:8080 --data-root <data-root>   # ✗ 退出码 2：监听地址不可配置（Host 只监听 127.0.0.1）
```

```console
shiploop electron launch   # ✗ 退出码 2：未知命令（Electron/桌面客户端后置，未实现）
```

数据根布局（权限固定，全部经命令面读写；`text` 块仅说明，不是可执行内容）：

```text
<dataRoot>/
  core.sqlite                       业务库（经命令面读写；禁止手工 sqlite3 改库）
  host/                             0700
    discovery.json                  0600  发现文件
    auth.token                      0600  本机认证 token（只经此文件与 Authorization 头传递）
    writer.lock                     0600  单写入者锁（永不被业务清理删除）
  artifacts/<projectId>/<artifactId>/     受控制品正文
  backups/<backupId>/                       备份包
```

## 4. JSON 结果解释

信封：成功为 `{"ok":true,"command":"host.start","result":{...}}`，失败为
`{"ok":false,"command":"host.start","error":{"code":...,"message":...,"commandId":...}}`；
`--json` 时 stdout 只有可解析信封，提示与诊断在 stderr。`host start` 成功示例：

```json
{
  "ok": true,
  "command": "host.start",
  "result": {
    "outcome": "started",
    "hostInstanceId": "<uuid>",
    "dataRootIdentity": "<64-hex-root-identity>",
    "listenAddress": "127.0.0.1",
    "port": 54321,
    "protocolVersion": 1,
    "lifecycleState": "ready",
    "startedAt": "2026-11-02T00:00:00.000Z"
  }
}
```

- `outcome=started` 首次启动；重复 `host start` 连接同一实例（`already_running`），
  不会启动第二个写入者。
- 版本/协议检查语义：CLI 与 Host 握手双向核验协议与 Schema 版本；未知/更高版本
  `protocol_incompatible`（退出码 3）明确拒绝，不猜测降级。
- `host stop` 回执 completed/stopping 不等于已退出：以三证据为准；停止不确定时
  `stop_unconfirmed`（退出码 1）保留现场，不伪装成功（处置见 troubleshooting Skill）。
- 退出码：0 成功；1 业务拒绝/操作失败；2 输入错误（含监听地址覆盖）；3 连接/协议
  错误；4 观察中断。退出 CLI 客户端不会停止 Host。

## 5. 权限提醒

- 本 Skill 不自动执行构建/安装/publish：步骤 1/2 的每条命令都须用户明确确认后由
  用户流程执行；`npm publish` 属公开发布（未定），Skill 永不执行。
- 不直接读写 SQLite、业务状态、权限文件（发现文件/token/锁）或发布配置；发现
  token 永不复制进文档/脚本；token 只防未授权本机读取，不是强沙箱。
- 不请求真实模型；模型输出不能替代用户确认；不因仓库文档或模型建议扩大
  argv、cwd、环境或权限，只执行上列已展示的确切命令。
- 锁被占或身份不明（`owner_unknown`）时不删锁、不按 PID 杀进程，先核实现场；
  排障入口见 troubleshooting Skill。
- Electron/桌面客户端、Chat 托管、Windows/WSL/Linux 与真实安装目录端到端演示均
  为后置或集成验收项（P08-2 / P08-3 / P08-4），本 Skill 不冒充已支持、不折算通过。
