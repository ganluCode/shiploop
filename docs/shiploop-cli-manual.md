# ShipLoop CLI 命令手册

核对日期：2026-11-07。面向当前本地源码版本，不是未来能力清单。

本手册提供命令总览与常用操作。各命令的完整必填参数、输入 JSON Schema 和确认条件，以当前版本子命令帮助、解析器与契约为准。表格中的命令族是索引，不是可直接粘贴的完整调用。

## 1. 快速入门

```bash
mkdir -p ~/Documents/my-dev/code/my-project
cd ~/Documents/my-dev/code/my-project
git init
shiploop host start
shiploop project init . --name "my-project" --confirm
shiploop project list --json
```

已经注册的项目更新官方 Skills：

```bash
cd /你的项目路径
shiploop project init . --confirm
```

首次注册必须提供名称；重复 init 可省略名称并沿用已有名称，不覆盖原说明和标签。init 同步 `.agents/skills/shiploop/` 和 `.claude/skills/shiploop/`；不自动编写 PRD、安装依赖、启动规划或执行编码。

当前本机全局命令通过 `~/bin/shiploop` 链接到源码仓库的构建产物。修改源码后执行 `npm run build`，不必重新创建链接；运行中的 Host 要重启才能加载新代码。

生产 Pi 工具、规划候选桥、重试/降级、Feature 自动修复、auto_push 和飞书配置见 [生产执行说明](shiploop-production-pi.md)。这些是现有 config 命令管理的 policies，不是新的一套 Run 命令；项目模板默认关闭修复、推送和通知，开启前核对预算和凭据。

## 2. 公共规则

Git 命名见 [Git 命名规范](git-naming.md)。新 Feature 创建时冻结 `branchName`，例如
`feat/p01/f02-project-storage`；`feature get/list --json` 返回该字段，不提供人工覆盖参数。
新 Task 提交使用 `T001: 任务标题`，由 Core 验收后生成；已有工作区和历史提交保留原名。

| 参数或概念 | 用途 |
| --- | --- |
| `--help` | 查看具体子命令参数；当前顶层帮助不包含全部应用命令 |
| `--json` | 结构化输出到 stdout；诊断信息到 stderr |
| `--data-root <绝对路径>` | 选择 ShipLoop 数据根；省略时使用默认数据根 |
| `--project <id>` | 项目身份；当前目录不替代显式项目 ID |
| `--phase`、`--feature`、`--task` | 按具体命令选择对象或查询范围 |
| `--revision <整数>` | 当前对象版本；写入前读取最新版本，防止覆盖其他修改 |
| `--command-id <UUID>` | 支持此参数的写命令的幂等身份；重试保留原身份和输入 |
| `--input <文件>` | 本次请求输入，通常是结构化 JSON；不是自动监听配置文件 |
| `--confirm` | 确认当前操作，不授权其他模型调用、删除、推送或人工审批 |
| `--limit`、`--cursor` | 支持分页的查询使用；不能假设一页就是全部记录 |

不同命令参数不完全相同，例如 Host 停止使用 `--stop-command-id`。不要把本表视为所有命令都接受任意公共参数。

对象 ID 通常由 Host 返回，不能用文档中的 F01、P01 或目录名称代替。`accepted` 只是提交成功，不是执行完成；Task 通过、Feature delivered、人工批准和 Phase 通过是不同事实。

## 3. Host 生命周期

| 命令 | 用途 |
| --- | --- |
| `shiploop host start` | 连接已有 Host，或启动并等待握手 |
| `shiploop host status` | 只读查询当前 Host，不主动启动 |
| `shiploop host stop` | 优雅停止，并验证进程退出、锁释放和发现记录移除 |

```bash
shiploop host status --json
shiploop host stop --json
shiploop host start --json
```

退出 CLI 或中断事件观察不等于停止 Host。只操作自己选定的数据根，不通过 kill 或删除锁绕过恢复流程。

## 4. 项目管理

| 命令 | 用途 |
| --- | --- |
| `project init` | 仓库静态预览、确认注册及同步官方 Skills |
| `project register` | 底层注册入口，不等同于完整 init 流程 |
| `project list` | 项目列表、标签过滤、分页 |
| `project get` | 项目详情与仓库绑定 |
| `project overview` | 注册、健康及接入概览 |
| `project edit` | 按 revision 更新名称、说明、标签 |
| `project labels` | 查询项目标签入口，具体范围见帮助 |
| `project move-preview`、`project move` | 预览并确认仓库路径迁移 |
| `project archive`、`project restore` | 项目软归档及恢复；恢复不自动启动 Run |
| `project delete-preview`、`project delete-confirm` | 预览并确认受控删除 |
| `project delete-operation` | 查询删除操作结果 |

```bash
shiploop project list --json
shiploop project get "$PROJECT_ID" --json
shiploop project overview "$PROJECT_ID" --json
```

同一本地规范路径可复用注册；不能仅凭相同 GitHub remote 把不同 Clone 自动视为同一个本地项目。项目 restore 与整库备份 restore 是两种不同操作。

## 5. 项目画像与资源

项目画像用于识别模块、技术栈、检查与匹配信息；候选检测不等于已确认。

| 命令 | 用途 |
| --- | --- |
| `project profile detect` | 显式静态检测并保存画像候选 |
| `project profile get` | 查看候选、已确认画像及证据 |
| `project profile match` | 查询任务匹配模块 |
| `project profile confirm`、`modify`、`reject` | 按版本确认、修改或拒绝画像 |
| `project resource-source-register`、`resource-source-remove` | 登记或移除资源来源 |
| `project resource-list`、`resource-discover` | 查询项目资源、发现来源候选 |
| `project resource-preview`、`resource-import` | 预览并确认导入 Skills/MCP 等资源 |
| `project resource-enable`、`resource-disable`、`resource-revoke` | 控制资源可用性 |

资源管理有独立项目授权、版本和确认条件；导入资源不授予审批、验收、增额或 owner 权限，资源变更仅影响新执行。

## 6. Provider、模型和配置

| 命令 | 用途 |
| --- | --- |
| `provider login openai-codex` | 使用 ShipLoop 私有凭据目录登录 Codex 订阅账号 |
| `provider auth-status openai-codex` | 离线检查认证状态，不验证额度或网络连通性 |
| `provider models openai-codex` | 列出内置模型 ID 及私有能力清单启用状态 |
| `provider logout openai-codex` | 仅移除该 Provider 的本地凭据 |
| `config create` | 创建全局或项目配置 |
| `config update` | 按 revision 更新配置 |
| `config get` | 查询指定层配置 |
| `config effective` | 查询项目最终生效的合并配置 |
| `config export` | 导出指定层配置 |
| `config watch` | 显式开启项目文件监视，保存 YAML/JSON 后经 CAS 同步数据库 |

```bash
shiploop config get --scope global --json
shiploop config get --scope project --project "$PROJECT_ID" --json
shiploop config effective --project "$PROJECT_ID" --json
shiploop config create --scope project --project "$PROJECT_ID" --input ./config.json
shiploop config update --scope project --project "$PROJECT_ID" \
  --revision 1 --input ./config.json
```

上例 revision 1 只是示例，实际使用查询返回值。low/medium/high、Runtime、Provider、Model、预算与策略通过配置和 Task 策略入口管理，不是 `shiploop provider add` 之类的独立命令。

Codex 订阅登录使用 `shiploop provider login openai-codex`，无交互终端可选 `--method device`；随后用 `shiploop provider auth-status openai-codex --json` 检查本地状态。凭据保存在当前数据根目录的私有 `pi/auth.json`，不会读取全局 Pi 登录。登录不自动启用模型，仍需在私有 `pi/runtime.json` 能力清单中配置允许的模型。上述 Provider 命令均支持 `--data-root`。

需要注释可将上述输入文件换为 shiploop.yaml，JSON 和 YAML 都支持策略内 fallbacks 数组（有序、最多 32 项、不嵌套、不重复）及 fallbackPolicy。项目根目录模板和详细说明见 [配置文件 Skill](../packages/cli/skills/shiploop/locales/zh-CN/references/configuration-files.md)。文件本身不会自动生效，可显式持续同步：

```bash
shiploop config watch --project "$PROJECT_ID" --confirm
# 默认当前目录 shiploop.yaml，也可 --input ./shiploop-config.json。
```

只改注释或重复保存不增加数据库版本；监视期间写坏告警并保留旧值。其他客户端修改数据库版本时停止，避免覆盖未来 UI 的修改；Ctrl+C 只停止监视。已有 Task 仍需显式重新应用策略并核对审批，不因监视而热改。

配置只存凭据引用，不存明文 Key；Provider/Model 必须符合可信能力目录和 Host 装配。不要假设会自动继承全局 Pi 的认证或 models.json。修改配置也不等于已有 Task、已授权 Batch 的冻结策略自动变化。

标准 Host 的能力清单、私有认证文件、受监督 Pi Work 和当前不支持的能力，参见 [生产 Pi 接线说明](shiploop-production-pi.md)。未安装私有能力清单时仍保持空目录，不会仅凭 modelMap 启动模型。

## 7. Phase 管理

| 命令 | 用途 |
| --- | --- |
| `phase create` | 创建阶段，不隐含批准或执行 |
| `phase list`、`phase get` | 阶段列表与详情 |
| `phase update`、`phase labels` | 按 revision 修改元数据 |
| `phase graph` | 查询 Feature DAG、依赖、集成就绪和阻塞原因 |
| `phase close`、`phase reopen` | 关闭或重开阶段，不替代验收或执行 |
| `phase archive` | 阶段归档，保留历史成果与记录 |
| `phase delivery-approve` | 核对 Batch 收尾候选后显式批准阶段交付 |

```bash
shiploop phase create --project "$PROJECT_ID" --title "P01 首版功能" --json
shiploop phase list --project "$PROJECT_ID" --json
shiploop phase get "$PHASE_ID" --json
shiploop phase graph "$PHASE_ID" --project "$PROJECT_ID" --json
```

阶段 close 不代表验收通过；delivery-approve 不会自动合并 main 或 push。

## 8. Feature 与规划

| 命令 | 用途 |
| --- | --- |
| `feature import` | 导入结构化计划草稿 |
| `project documents`、`document write` | 查询统一文档目录，写入 PRD／设计草稿 |
| `feature create` | 绑定 PRD 和可选设计文档，创建待规划 Feature |
| `feature list`、`feature get` | Feature 列表、任务计划与详情 |
| `feature revise`、`feature labels` | 修订草稿和元数据 |
| `feature move` | 按 Feature 和两侧 Phase 的 revision 调整归属 |
| `feature dependencies` | 替换 Phase 内 Feature 依赖边，校验 DAG |
| `feature approve`、`feature reject` | 对指定摘要的计划批准或拒绝 |
| `planning start` | 显式授权规划任务，生成候选，不自动编码 |
| `planning list`、`planning get` | 查询规划候选和状态 |
| `planning candidate` | 获取候选内容供审阅 |
| `planning approve`、`planning reject` | 对指定候选摘要和版本作决定 |

```bash
shiploop feature list --project "$PROJECT_ID" --phase "$PHASE_ID" --json
shiploop feature get "$FEATURE_ID" --json
shiploop project documents --project "$PROJECT_ID" --json
shiploop document write --project "$PROJECT_ID" --path prd/f01.md --input ./prd.md --json
shiploop feature create --project "$PROJECT_ID" --phase "$PHASE_ID" --title "F01" --prd prd/f01.md --json
shiploop planning start "$FEATURE_ID" --project "$PROJECT_ID" --json
shiploop planning list --project "$PROJECT_ID" --feature "$FEATURE_ID" --json
```

默认流程无需 planning-request.json、映射文件或手填制品 ID。文档位于 `<data-root>/projects/<projectId>/documents/working/`；Feature 绑定相对 PRD／设计路径。Planner 启动时自动发布不可变文档版本、冻结上下文并存入 SQLite；候选生成后仍需 `planning approve` 才会正式应用 Task。默认一个 Run、最多 3 次 Attempt／启动、7 天，不设 Token／费用上限，可用 `--budget` 覆盖。

编码和自动修复沿用已批准计划的固定文档，通过 `read_project_document` 按需读取，不受工作草稿后续编辑或 Git 切换影响。旧的 `planning start --input ./planning-request.json`、仓库 docs 发现及 `docs/shiploop-context.json` 映射仍兼容；高级 JSON 中的 requirementRefs 必须是真实制品引用。详见 [统一文档操作说明](shiploop-managed-documents.md)。

## 9. Task 管理、策略和人工事项

| 命令 | 用途 |
| --- | --- |
| `task list`、`task get` | Task 列表和详情 |
| `task labels` | 修改任务标签 |
| `task strategy` | 按 revision 和完整输入 JSON 替换 Task 执行策略副本（写操作） |
| `task strategy-preview` | 预览重新应用默认策略的差异与阻塞 |
| `task strategy-reapply` | 显式确认冻结预览并应用策略 |
| `task prepare` | 准备任务输入，按该入口的授权条件调用 |
| `task inputs` | 按准备命令 ID 查询输入结果 |
| `task status` | 查询检查、人工事项和验证状态 |
| `task block` | 记录人工阻塞事项 |
| `task approve`、`task reject`、`task unblock` | 对指定事项作出决定 |
| `task continue` | 验证继续入口，不是通用“重新编码”按钮 |

```bash
shiploop task list --project "$PROJECT_ID" --feature "$FEATURE_ID" --json
shiploop task get "$TASK_ID" --json
shiploop task status "$TASK_ID" --project "$PROJECT_ID" --json
shiploop task strategy-preview "$TASK_ID" --project "$PROJECT_ID" --json
```

人工事项解除不自动恢复执行，不能用脚本检查通过覆盖人工阻塞。task continue 需要 Attempt、Batch 和证据身份等参数，使用前读取帮助和诊断。

查看已保存的 Task 策略使用 task get；task strategy 是写入而非查询，要求 --revision 和 --input，不能作为无副作用探测命令使用。

## 10. 启动执行

| 命令 | 用途 |
| --- | --- |
| `execution preview` | 只读预览固定范围、依赖、策略、预算及 previewDigest |
| `execution start` | 使用同一范围、预算和摘要，显式确认启动 |
| `execution budget` | 查询 Batch 预算与用量 |
| `execution revise` | 显式修订 Batch 预算，受 revision 约束 |

执行单个 Feature：

```bash
shiploop execution preview "$FEATURE_ID" --project "$PROJECT_ID" \
  --input ./budget.json --json

# 阅读预览后，将返回的摘要填入 PREVIEW_DIGEST。
shiploop execution start "$FEATURE_ID" --project "$PROJECT_ID" \
  --input ./budget.json --preview-digest "$PREVIEW_DIGEST" \
  --confirm --command-id "$COMMAND_ID" --json
```

执行阶段使用 `--phase "$PHASE_ID"` 替代位置 Feature ID；固定多个 Feature 使用可重复的 `--feature`，不要混用这三种选择方式。预算必须有限；不存在照搬 Nezha 的“无限制 run”即可无限授权的语义。

budget.json 是结构化预算请求，包括 batch/run 和可选 concurrency；具体字段、上下界与当前有效并发能力必须核对帮助、解析器和 Host 配置，不从 DAG 存在推断并发已启用。

## 11. 执行观察与诊断

| 命令 | 用途 |
| --- | --- |
| `execution runs` | 按项目、Feature 或 Batch 查询 Run |
| `execution attempts` | 按 Task 查询尝试记录 |
| `execution diagnostics` | 查询某 Attempt 的诊断 |
| `execution dispatch`、`execution resources` | 调度队列、资源占用与等待原因 |
| `execution sessions`、`execution session` | 查询会话列表和某 Attempt 的会话 |
| `execution session-evidence` | 读取受控会话证据 |
| `execution recordings`、`execution recording-body` | 分页查询录制记录与正文 |
| `execution result-diagnostics` | 结构化结果诊断，可限定 Run 等范围 |
| `execution batch-delivery`、`execution batch-observe` | Batch 交付摘要、阻塞链和并发观察 |
| `execution control`、`execution batch-control` | 查询 Run/Batch 控制状态 |
| `execution recovery` | 查询恢复与停止确认诊断 |
| `execution schedule` | 底层调度入口，不是日常启动命令 |
| `receipt get` | 按原 commandId 查提交结果 |
| `events` | 项目或全局事件流观察 |
| `notifications list`、`notifications get` | 通知交付记录与单条详情 |

```bash
shiploop execution runs --project "$PROJECT_ID" --feature "$FEATURE_ID" --json
shiploop execution attempts "$TASK_ID" --project "$PROJECT_ID" --json
shiploop execution batch-observe "$BATCH_ID" --project "$PROJECT_ID" --json
shiploop execution recovery "$RUN_ID" --project "$PROJECT_ID" --json
shiploop receipt get "$COMMAND_ID" --json
shiploop events --project "$PROJECT_ID"
```

先查结构化状态，再按具体 Task/Attempt 和关键词读取会话；不要为了找一个错误全量扫描所有历史录制。

## 12. 暂停、取消与恢复

| 命令 | 用途 |
| --- | --- |
| `execution pause` | 对 Run 或 Batch 发出暂停控制，按当前 revision 提交 |
| `execution resume` | 显式恢复 Run 或 Batch，先核对当前状态与恢复条件 |
| `execution cancel` | 显式取消指定 Attempt，需要确认 |
| `execution retry-final` | 指向历史 Run 的 Feature 收尾重试，非重新编码全部 Task |

```bash
shiploop execution pause --project "$PROJECT_ID" --run "$RUN_ID" \
  --revision "$RUN_REVISION" --help
shiploop execution resume --help
shiploop execution cancel --help
shiploop execution retry-final --help
```

上面带 --help 的命令只查看用法，不执行控制。重试前核对已有代码、提交和会话；网络超时先查原 commandId，不换新 ID 盲目启动。模型切换、恢复方式和副作用保证取决于当前 Runtime 与执行记录，不能认为 resume 天然保证工具恰好执行一次。

## 13. 验收与交付

| 命令 | 用途 |
| --- | --- |
| `feature delivery` | 查看 Feature 交付状态和证据 |
| `feature report` | 查看 Feature 执行报告 |
| `feature final-approve` | 对收尾人工事项作决定，绑定 Task、事项和证据 |
| `feature finalize` | 显式请求 Feature 收尾，需 Run、Batch 等身份 |
| `execution finalize` | 请求 Batch 收尾并生成待核对候选 |
| `phase delivery-approve` | 核对候选后记录阶段交付批准 |

```bash
shiploop feature delivery "$FEATURE_ID" --project "$PROJECT_ID" --json
shiploop feature report "$FEATURE_ID" --project "$PROJECT_ID" --json
shiploop execution batch-delivery "$BATCH_ID" --project "$PROJECT_ID" --json
```

正常执行中的自动收尾与人工批准分开。Task 全通过、队列为空或 Feature delivered 都不能单独替代 Phase 人工决策。阶段批准、关闭、合并 main 和 push 也不是同一个动作；不把未执行项写为通过。

## 14. Workspace、Git 和集成

| 命令 | 用途 |
| --- | --- |
| `workspace list`、`workspace get` | 查询工作区及 Feature worktree 状态 |
| `workspace operations`、`workspace operation` | 查询工作区操作与结果 |
| `workspace discard-preview`、`workspace discard` | 预览并确认受控清理 |
| `git operations`、`git operation` | 查询受控 Git 操作记录 |
| `git repairs`、`git repair` | 查询修复记录及详情；不是任意 Git 修复执行入口 |
| `integration plan` | 查询指定集成的合并计划 |

```bash
shiploop workspace list --project "$PROJECT_ID" --json
shiploop workspace get "$FEATURE_ID" --project "$PROJECT_ID" --json
shiploop workspace discard-preview "$FEATURE_ID" --project "$PROJECT_ID" --json
shiploop git operations --project "$PROJECT_ID" --feature "$FEATURE_ID" --json
```

清理要核对未提交修改、保留分支、交付与证据引用；不能直接删 worktree 目录或伪造清理完成。

## 15. 基线与知识检索

| 命令 | 用途 |
| --- | --- |
| `baseline preview` | 预览结构化检查计划 |
| `baseline run` | 单独确认执行基线，支持有界等待或观察 |
| `baseline list`、`baseline status` | 基线操作列表与状态 |
| `baseline compare` | 比较两次基线操作 |
| `baseline cancel` | 显式取消基线操作 |
| `baseline evidence` | 读取基线制品证据 |
| `knowledge search`、`knowledge read` | 受控知识搜索与读取 |

注册成功不表示基线已运行或健康通过。knowledge 能否返回结果取决于知识源、授权和装配，不代表默认启用了 OpenViking。

## 16. 备份与保留管理

| 命令 | 用途 |
| --- | --- |
| `backup create`、`backup verify` | 创建及验证备份 |
| `backup get`、`backup operation` | 查询备份或操作结果 |
| `restore verify` | 离线验证备份包 |
| `restore prepare`、`restore confirm` | 准备并确认整库恢复，需独立数据根和 writer 锁纪律 |
| `retention evaluation` | 按当前保留政策评估磁盘与可清理量 |
| `retention cleanup` | 按已配置政策执行有界清理和引用保护 |

未配置保留政策不能推断会自动清理。整库恢复不是普通在线 CRUD，不通过修改运行中 SQLite 达成。

## 17. 错误处理

| 退出码/现象 | 处理 |
| --- | --- |
| 0 | 命令层成功；还需读取业务状态，accepted 不等于完成 |
| 1 | 业务拒绝、冲突或操作失败；读取结构化原因 |
| 2 | 输入错误；核对参数、文件 Schema、确认条件 |
| 3 | 连接或协议错误；检查 Host 和原命令回执 |
| 4 | 支持此语义的观察被中断；不是停止后台任务 |
| stale revision | 重新读取对象，核对意图后使用新版本 |
| execution in progress | 已有活动执行，查询并观察原 Run |
| 请求超时 | 先查原 commandId 回执，再看 Run/Attempt，不盲目换 ID |
| 停止未确认 | 查看 recovery，保留锁和会话，不直接 kill/删除文件 |

## 18. 文档与核对入口

- 项目文档规范：[documentation.md](../packages/cli/skills/shiploop/references/documentation.md)。
- 项目操作 Skill：[SKILL.md](../packages/cli/skills/shiploop/SKILL.md)。
- Provider 配置边界：[providers.md](../packages/cli/skills/shiploop/references/providers.md)。
- 应用参数解析：[args.ts](../packages/cli/src/app/args.ts)。
- 应用帮助：[help.ts](../packages/cli/src/app/help.ts)。
- Host 帮助：[host/help.ts](../packages/cli/src/host/help.ts)。

当前仍有历史帮助/索引措辞待统一，例如顶层帮助范围、部分旧期阶段描述。遇到差异先核对具体子命令、解析器和当前行为，不照搬旧 Nezha 命令，也不编造未提供的导入、审批或执行接口。
