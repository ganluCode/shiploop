# P06-5 存量仓库接入与基线增量契约

状态：F-001 实施契约。本文冻结纯校验与比较边界，不宣称移动接入或增量执行已经接线。

## 1. 复用的存量入口与新增边界

| 能力 | 已存在入口 | F-001 的关系 |
|---|---|---|
| 仓库只读检查与稳定身份 | `packages/core/src/ports/repository-inspector.ts` 的 `RepositoryInspector`、`RepositoryInspection`、`deriveRepoIdentity` | 复用 `gitdir-sha256:` 派生规则；新的只读仓库事实作为移动预览输入，不另造身份算法 |
| 项目注册与绑定 | `packages/core/src/application/project-service.ts` 的 `ProjectService.registerRepository`；`packages/core/src/ports/state-store.ts` 的项目/绑定写端口 | 移动确认之后才由后续应用服务调用；本 Task 不重建注册或写事务 |
| 检查授权与可信主体 | `packages/core/src/ports/authorization.ts` 的 `TrustedPrincipal`、`authorizeCommand`；`packages/core/src/ports/baseline.ts` 的基线命令/授权摘要校验 | 请求只带目标 `projectId` 和已确认摘要；主体由可信装配传入，payload 内的主体字段是未知字段并拒绝 |
| 基线检查与进程监督 | `packages/core/src/application/baseline-service.ts`、`baseline-execution.ts`、`baseline-process-stop.ts`、`ports/command-process.ts` | 保留现有授权、有限超时、取消和停止核验；F-001 只定义状态兼容和比较输入 |
| 证据注册与读取 | `packages/core/src/ports/artifact-store.ts`、`application/baseline-evidence.ts` 的 `readBaselineEvidence` | 结果只保存受控 evidence/artifact 引用；比较返回旧、新引用，不读取路径或正文 |
| 本次新增纯能力 | `packages/core/src/ports/brownfield.ts` | 移动预览/确认摘要、存量基线状态校验、获准命令摘要和逐项比较；无 HTTP、ORM、SDK、Git 或进程副作用 |

项目切换仍以显式 `projectId` 和既有项目查询为目标选择。F-001 不引入全局可变的隐式当前项目，也不导入旧 Nezha 元数据。

## 2. 移动接入协议

`createBrownfieldMovePreview` 接受：

- 当前项目 `projectId`；
- 旧 `repositoryBindingId`、`bindingRevision`、旧 `repoIdentity`；
- 新仓库只读事实：规范绝对路径、`repoIdentity`、HEAD、是否有初始提交、脏工作区和工作区摘要。

预览返回 `previewDigest`、旧绑定和新事实的完整分离，以及始终为真的 `requiresExplicitConfirmation`。确认必须携带同一项目、同一旧绑定身份和 revision、`decision: "confirm"` 与预览摘要；提供预览时重新计算摘要并逐字段核对。摘要缺失、漂移、跨项目或未知字段在任何仓库/数据库/进程副作用之前拒绝。

`repoIdentity` 继续由 `deriveRepoIdentity(gitCommonDirRealPath)` 的已有算法产生。新路径的摘要只描述新事实，不能填充旧绑定字段；相同 remote 或相同 HEAD 不提供自动合并身份。即使身份看起来相同，移动预览仍需用户确认。预览只记录当前工作区：无 HEAD 和脏状态原样保留并要求确认，不创建 commit、隔离副本或 worktree，不 stash、reset，也不导入 Nezha 数据。

## 3. 基线状态与逐项比较

契约版本 `BROWNFIELD_CONTRACT_SCHEMA_VERSION=1` 独立于线消息、配置、SQLite 迁移和基线制品版本。未知版本和未知字段均 fail-closed。

基线状态保存项目、绑定、代码身份、获准检查和历史证据引用。每项检查的命令摘要覆盖 `checkKey`、argv、仓库内相对 cwd、获准环境身份、超时和 required；`commandDigest` 必须由这些字段重新计算。环境值和路径正文不进入普通结果。

检查状态保持 `passed`、`failed`、`error`、`inconclusive`、`not_run` 五值。工具不可用或尚未实际执行的新增项使用 `not_run` 并保存 `tool_unavailable`/`not_started` 原因。非零退出、超时、取消、停止未确认分别保留诊断；它们不能转换为 `passed`。比较函数只生成新结果，不改写旧 error、inconclusive、not_run 或历史 evidence。

比较单位是同一项目内的 `checkKey` 加获准命令摘要（命令、cwd、环境身份等）。响应同时返回旧/新代码身份、逐项旧/新状态、原因、退出码和 evidence 引用。命令摘要变化标记 `different_command`。命令内部失败有稳定 `failureCaseIds` 时才可判定 `same_failure` 或 `different_failure`；缺失稳定用例身份返回 `indeterminate`，保留两侧逐项证据，不能凭失败总数或相同退出码豁免。

## 4. 纯度和后续接线

`brownfield.ts` 只依赖 `node:crypto`、路径格式判断和已有纯校验/规范 JSON 摘要。它不读取文件、数据库、网络或制品正文，不启动或停止进程，不解析供应商 SDK。后续应用服务应先调用可信主体授权、查询既有项目/绑定和 `RepositoryInspector`，再在短写事务中应用已确认的摘要；本 Task 不实现该接线。

对应纯契约测试为 `test/modules/onboarding/p06-5-brownfield-contract.test.ts`，覆盖 FR-1、FR-2 与 T15 的移动确认、无 HEAD/脏状态、版本/字段/主体/项目拒绝、不可用检查、诊断保留和逐项比较边界。
