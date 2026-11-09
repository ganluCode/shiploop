# P06-1 F-003：Core ProjectProfile 决策

后续补缺：首次候选现在可经 `project profile detect --project <id> --confirm` 登记。
公开默认装配、原子性和首次检测限制见 [首次检测入口](p06-profile-detection-public-entry.md)。
下文保留原 F-003 交付边界；不是描述当前所有公开命令的清单。

`openCoreApplication().projectProfileService` 提供 `confirm`、`modify`、`reject`、`getCurrent`、`matchTaskModules`。这是 Core 应用能力，不是 Runtime 工具；不新增 HTTP/CLI 命令，命令信封/回执接入属于 F-005，Attempt 快照接入属于 F-004。

## 决策与版本

- 可信装配传入 principal；读要求 `project.read`，写要求 `project.metadata.write`，两者都核验项目可见性。请求不能提供 actor/principal、批准、预算、验收或凭据字段。沿用现有 TrustedPrincipal 形状校验，不声称 JavaScript 对象是密码学认证；Host 仍负责认证与身份绑定。
- `confirm/modify(principal, {projectId, expectedRevision, profile})` 提交完整画像替代提案。画像身份取自保存的当前头版本，允许编辑其模块/目录/语言/框架/检查和文档引用。`confirmedBy` 不允许伪造；确认成功时由可信 principal 写入。删除某个候选模块表示不采用该模块，但不能遗漏其他选中模块所必需的依赖。
- `reject(principal, {projectId, expectedRevision})` 保存整份提案的拒绝版本。当前默认画像始终是最近成功确认的版本；候选和拒绝不会覆盖这一默认值。无确认版本时 `getCurrent` 返回 `null`。
- `expectedRevision` 是**最新保存的 `profile.version`**（含候选/拒绝），不是不可变行自身恒为 1 的 `revision`。成功追加 `version+1`；旧行、原始检测证据均不改写。确认画像也不会把静态证据的 `confirmed:false` 改为真。
- SQLite `BEGIN IMMEDIATE` 内重核最新版本、版本归属、完整依赖闭包、证据引用/保留及状态身份，然后插入不可变版本和脱敏审计。竞争更新最多一方使用旧 revision 成功；插入或审计失败整组回滚。不修改 Task、Attempt、配置、批准或预算。
- 未知语言通过显式修改画像的语言/目录及已登记模块版本进行手动配置；不自动安装、执行或从正文推导模块。不允许空模块画像伪装确认成功。模块登记是已有可信存储接口，不是本任务新增的未授权导入通道。

## Task 模块匹配

`matchTaskModules(principal, {projectId, directory?, scope?, languages?, frameworks?, requiredModuleIds?})`。

- `directory` 为明确的相对目录；`scope` 为明确相对路径列表，两者取去重并集。缺少范围返回 `not_ready/task_scope_required`，不会默认加载全部模块；拒绝类型错误、绝对路径、父目录穿越和 glob。
- 以画像模块 `roots` 和能力描述符 `appliesTo` 的交集匹配目录；空 `appliesTo` 不再收窄画像范围。路径按段匹配，不把 `src2` 当作 `src`；可选语言/框架进一步筛选。多个画像模块引用同一能力时保留所有根绑定，最终按 `id@version` 的确定性顺序去重。
- 只选择确认画像中的固定模块版本，返回选择理由；不读取正文，也不解释模块 `scope` 标签为应用权限。未知/拒绝模块、依赖缺失/循环拒绝；Task 范围过滤后缺少依赖或必需模块返回明确 `not_ready`，不偷偷补入范围外能力。不匹配任何模块也不报告 ready。

## 审计与验证

`project_profile.confirmed/modified/rejected` 与版本写入同事务进入 `state_events`。payload 仅含操作、前后版本、主体/画像摘要及模块/证据数量，不含正文、路径、内容引用或秘密。Core 事件投影和现有 HostClient 事件解码器同步白名单校验，未知字段继续拒绝，避免新审计事件使既有事件读取损坏。没有新增 Profile Host 命令或宣称完整协议接线已完成。

定向用例：`test/modules/onboarding/p06-1-project-profile-service.test.ts`。覆盖真实临时 SQLite、组合根重开、跨连接 CAS、审计故障回滚、权限/伪造身份、未知版本/依赖环/证据引用、手动语言、范围和依赖匹配、模块不提权及审计往返。完整选择见 `test/index/phases/P06/features/P06-1/tasks/F-003.json`；授权/HostClient 较广回归交独立 Verifier，不能由索引存在推断通过。未运行模型、全仓测试、Phase 验收或负责人签署。
