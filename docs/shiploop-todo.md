# ShipLoop 待办清单

这份清单记录截至 2026-11-08 的实现缺口、验证缺口和明确延期项。勾选项是已实现基线，未勾选项才是待办；`待验证` 不等于尚未实现。本次仅整理文档，不启动实现、模型验证或通知。

## 高优先级

### 1. 补齐日常流程的国际化

状态：部分完成。

- [x] 全局 `locale` 配置，支持 `en-US` 和 `zh-CN`。
- [x] Task、Planner、Feature 修复和 Runtime Prompt 使用双语 Markdown 模板。
- [x] 回复语言规则、Skills、飞书卡片和 Feature 报告接入语言选择。
- [x] 新执行输入冻结 locale，历史输入保持原语言语义。
- [ ] CLI 帮助、Host 通用错误、诊断信息和退出码说明全面接入 locale。
- [ ] 历史验收报告和旧操作文档按需提供双语版本。
- [ ] 第三方工具和外部 Provider 返回的错误信息增加统一语言包装。
- [ ] 补一次中文和英文真实日常流程验收，覆盖 init、create、planning、run、验收和通知。

说明：协议字段、状态值、ID、代码、工具输出和用户原始内容不翻译；项目级 locale 覆盖当前不开放，仍使用全局配置。

### 2. 统一项目文档的备份与生命周期

状态：部分完成。

- [x] PRD、架构和 Feature 设计进入统一项目数据目录。
- [x] 文档草稿支持 CAS 写入、版本化和规划输入冻结。
- [x] 已发布文档版本和上下文制品进入现有 Artifact 体系。
- [ ] 将 `documents/working` 草稿纳入备份包，或提供独立的文档备份/恢复命令。
- [ ] 明确项目删除时草稿的保留、导出和最终清理策略。
- [ ] 增加草稿目录、文档版本和恢复后的哈希一致性验收。

当前边界：草稿目录需要单独备份，项目删除暂时保留草稿；不能把已发布制品备份等同于草稿备份。

### 3. 完成真实 Provider 和通知验收

状态：代码已接通，真实环境待验证。

- [x] Provider 配置、模型白名单、fallback 顺序和重试策略已接入。
- [x] Feishu 卡片、签名、投递队列和事件开关已接入。
- [ ] 使用实际 Codex、GLM、Kimi、Mimo、DeepSeek 等已配置 Provider 各做一次最小连通性验证。
- [ ] 真实触发连接错误、服务端限流、认证失败和 fallback，验证事件、状态和卡片内容一致。
- [ ] 真实发送一条 Task 完成、Feature 完成、错误停止和模型切换通知。
- [ ] 记录各 Provider 的实际错误形态、重置时间可用性和用量口径，避免把离线测试结论当成服务商保证。

## 中优先级

### 4. Runtime 限制统一

状态：已知缺口。

- [ ] 统一 `CommandProcess`、Session、Runtime 和配置文件的最大超时时间。
- [ ] 当前 CommandProcess 约束最多 1 小时，而 Runtime 配置允许更长时间；需要统一端口、监督器、取消和测试。
- [ ] 明确父 Batch、Run、Attempt、Host 和模型单次限制的优先级，并在诊断中展示实际生效值。
- [ ] 为超时、输出上限、请求轮次和输入字节上限补 CLI 预览与报告字段。

### 5. 跨模型恢复与 Session 复用

状态：未完成。

- [x] 同一 Task 的 Core 身份、Attempt、输入和结果具备幂等/恢复基础。
- [ ] 跨模型原生 Session resume 尚未接通。
- [ ] 明确同一 Provider 可 resume、切换模型需新 Session 的边界。
- [ ] 对限流、网络错误、认证失败和服务端错误分别定义是否保留原 Session。
- [ ] 增加 resume 成功、resume 拒绝和切换模型后的输入缓存命中验证。

说明：Core 工作流继续、对话上下文恢复和 Provider 原生 Session resume 是不同能力；不能只看到 `resume` 命令便宣称原生缓存一定可复用。

### 6. Harness 自动加载验证

状态：代码已提供 Skills 安装，Harness 自动发现待验证。

- [x] `project init` 可同步 ShipLoop 官方 Skills 到项目目录。
- [x] Skills 资源按中英文目录提供。
- [ ] 分别验证 Codex、Claude Code、Pi、Trae 等 Harness 是否自动发现 `.agents`、`.claude` 下的 Skills。
- [ ] 记录每个 Harness 的实际加载入口、优先级、冲突处理和重复 init 行为。
- [ ] 对用户已有同名 Skill 的覆盖策略做一次真实验收。

### 7. 受管文档简化流程的真实闭环

状态：离线闭环已通过，真实模型待验证。

- [x] `document write`、`feature create`、无 input 的 `planning start` 已接入。
- [x] 同一 `commandId` 重放不会重复创建 Feature、Run 或文档版本。
- [x] Planner 候选仍需人工批准后才正式生成 Task。
- [ ] 使用实际 Planner Provider 完成一次 PRD 到候选、批准、编码和 Feature 验收的完整流程。
- [ ] 验证修改草稿后新规划使用新版本，而已批准 Task 继续使用旧冻结输入。
- [ ] 验证网络断开、Host 重启和规划结果未知时的 receipt 查询与安全重放。

## 低优先级

### 8. MCP、浏览器和扩展能力

状态：MCP 已有基础能力；当前生产编码入口的完整接线与浏览器扩展按需处理。

- [x] P06 已有受控 stdio MCP、工具过滤、审计、停止与 Pi Session 装配实现。
- [ ] 核对当前 `production-pi` 入口如何复用这些装配，再按项目需求接通；不另建重复 MCP 框架。
- [ ] UI 联调阶段增加浏览器自动化能力、截图和交互验收。
- [ ] 明确扩展的授权、版本冻结、超时、取消和产物记录。
- [ ] 暂不开放任意插件、全局 MCP、任意子 Agent 和无边界扩展。

### 9. 并发 Feature 的生产配置与实战核对

状态：已有 Core 并发基础和阶段实现，不应列为从零开发。

- [x] 已有持久派发认领、执行槽位、Feature DAG 准入、并发策略及资源互斥实现。
- [x] P05 已有 Feature 并发派发、依赖集成和有界 GitAgent 修复相关实现。
- [ ] 针对当前生产 Host 核对并发设置、队列消费和依赖集成的实际装配及阻塞原因。
- [ ] 在临时项目验证 A/B 并行、C 等待依赖并集成，覆盖重启、冲突、互斥资源和通知。
- [ ] 根据实测补缺口，更新配置示例；不得因 Nezha 不支持并发就认定 ShipLoop 也未实现。

### 10. GitAgent 扩展

状态：已有 Git 与有界修复能力；生产接线需专项核对，扩展能力待规划。

- [x] 本地 commit、受控 push、回执和结果未知恢复已有基础。
- [x] 已有 integration plan、GitAgent 修复授权/claim/settle、持久记录与恢复相关模块。
- [ ] 核对当前默认 Host 的集成事实适配器、真实 GitAgent Runtime 与冲突修复是否完整装配。
- [ ] 依据已有受控 Git 能力规划远端 PR 与分支管理扩展。
- [ ] 增加 AI Review、PR 状态查询和审查意见回写。
- [ ] 明确 GitAgent 与 Core 的边界：模型提出操作，Core 负责授权、执行、核验和元数据写入。

### 11. 其他已明确的后续优化

- [ ] 厂商限流恢复时间：接入可信重置时间与持久冷却；没有可信时间时每个新 Task 仍从首选模型尝试，不猜测重置时间。
- [ ] 按用户前面的约定，最后再整理 `packages/core/src/ports` 等文件较多的目录，适度按模块归类，更新导出与引用，不改变业务行为。
- [ ] 清理设计/计划中的旧状态说明，例如早期文档仍写 OAuth 不在范围，但当前已支持 `openai-codex` OAuth；标注历史基线或链接现行说明。
- [ ] 当前改动仅做相关离线验证；后续提交前审阅最小 diff，提交后由 CI 做全量回归，不将以前全量通过结果冒充本轮回归结果。

## 暂不纳入当前版本

- 跨模型原生 Session 的完全兼容恢复。
- 任意 MCP、插件和子 Agent 自动加载。
- 浏览器自动化作为普通编码 Runtime 的默认能力。
- 项目级 locale 覆盖和运行中的语言热切换。
- 直接修改 SQLite、Feature YAML、Task JSON 或其他官方元数据文件。

## 验收规则

后续关闭条目时，需要记录：源码或文档位置、命令、测试范围、实际 Provider、时间、结果、证据制品和 `not_run` 项。离线 Fake Runtime、Host `ready` 或配置解析通过，只能证明接线正确，不能替代真实 Provider、Harness 或远端通知验收。

## 对应文档与源码

- [国际化实现范围](shiploop-localization.md)及[本轮实施记录](superpowers/plans/2026-11-08-workflow-i18n.md)。
- [统一文档与 Planner 操作说明](shiploop-managed-documents.md)。
- [生产 Pi 的重试、降级、通知与当前限制](shiploop-production-pi.md)。
- [Prompt 模块与规划 Skill](shiploop-prompts.md)。
- [生产编码闭环实施记录](superpowers/plans/2026-11-07-production-runtime-completion.md)。
- [Feature 并发准入规则](../packages/core/src/ports/feature-dispatch.ts)及[运行装配](../packages/core/src/adapters/work-execution.ts)。
- [GitAgent 修复服务](../packages/core/src/application/git-agent-repair.ts)及[Core 组合根](../packages/core/src/adapters/composition.ts)。
- [受控 Pi MCP 接线说明](phases/p06/p06-4-f008-pi-mcp-session.md)。

建议顺序：先补运行限制和草稿备份这类稳定性缺口，再完善 CLI 国际化；真实模型、飞书和并发验收单独申请明确范围。浏览器和 PR/Review 扩展按实际项目需要安排。
