---
name: shiploop-plan-feature
description: 使用当前 Harness 的模型，按项目需求规划或调整 ShipLoop Phase 的 Feature、PRD 与真实依赖 DAG，尽量减少并发 Feature 的共享修改和耦合。用于拆分功能、规划阶段、设计并行边界；不自动启动 Task Planner 或编码执行。
---

# ShipLoop Feature 规划

使用中文规划与回复，保留英文 labels、语言名称、ID 和协议字段；用户明确指定交付物语言时遵从。

由当前对话模型完成规划，不另开模型请求或子 Agent。Feature 是可独立交付和验收的结果，
Task 才是 Feature 内部实现步骤。先用当前仓库和正式状态核对事实，再写规划，避免重复工作。

## 读取与范围

1. 读取项目 AGENTS.md；用 `shiploop project documents --project <id> --json` 查询独立于 Git 分支的受管文档目录，
   读取其中现有产品/架构/Phase 文档和索引；沿用 [ShipLoop 文档规范](../shiploop/references/documentation.md)。定向搜索，不扫全部历史 Session。
2. 经 CLI 查询项目、Phase、已有 Feature 与计划/状态。已完成、已批准或执行中的内容单独列出，
   不因为重新规划而删除、重建、复制任务或修改状态。将文档里的别名与 Host ID 分开记录。
3. 明确本 Phase 的目标、非目标、现有能力、验收结果及未决边界。缺少影响所有权或协议的关键
   信息时向用户核对，其余实现细节沿用项目模式。不为凑数量固定拆成若干 Feature。

## 按并发边界拆分

- 优先按业务能力、稳定接口和模块所有权拆，而非为每个文件、每层技术或每个测试建 Feature。
  每个 Feature 应有可独立评审的输出、明确输入契约和可观察验收，不把全部 Phase 塞进一个 Feature。
- 减少交叉关联，但不要为了图形好看隐瞒真实依赖。A/B 可并行、C 需要 A/B 产物时写 A → C、
  B → C；不要按编号把 A → B → C 强行串行，也不能只靠执行顺序隐含依赖。
- 共享 Schema、公共协议、数据库迁移约定、基础框架初始化等会被多人同时修改时，优先提取成
  一个小的前置 Feature 或先冻结接口，再让消费者并行。只有实际需要产物的节点才加依赖。
- 检查“逻辑无依赖但文件冲突”：入口注册、统一 exports、包清单、锁文件、同一测试 helper、
  迁移序号、配置文件和文档总索引都可能形成合并冲突。为共享修改指定单一所有者，或明确顺序/合并前提。
- 同一模块的强耦合改动若无法形成稳定契约，保留在一个 Feature 通常比拆分后反复整合更好。
  不因想并发而制造空接口、无业务意义的中间节点或过早抽象。
- 数据库、进程、端口、外部服务等运行资源也要评估；文件不同不代表互不影响。记录资源约束，
  不用 Prompt 声称强隔离，不让模型自行创建 worktree、切分支或合并正式交付。
- 并发数是运行上限，不是规划必须填满的数量。DAG、资源锁、批准和集成状态共同决定实际并发。

## 输出

按 [规划表模板](feature-map.md) 写 Phase 范围与 Feature 表，每项包含：
目标和非目标、交付物、输入/输出契约、主要修改目录、共享文件所有者、真实前置依赖、
可并行节点、资源/集成风险、独立验收、受影响测试及人工确认项。

每个 Feature 编写 PRD；需要接口/存储/并发/恢复设计时引用单一技术设计，避免在多份 PRD
复制并维护同一协议。用关系表或 Mermaid 表达 DAG，并逐边解释需要的具体产物。
Task 只做相关单元测试，Feature 汇总其范围内检查；Phase 设计受影响回归和必要集成场景，
全仓回归交 CI 或用户显式安排，不复制到每个 Feature。

若需要预览 Task 粒度，在描述中指出难点，但不要在 Feature Skill 中伪造官方 Task 列表。
后续 Planner 必须按现有正式计划 schema 输出 low/medium/high、英文 labels、实际 languages 数组，
不能用 Feature 难度统一覆盖所有 Task。

## 正式创建与变更

Core 创建 Feature 时冻结 `feat/p01/f01-<slug>` 分支名；纯中文标题后缀为 `feature`。
不要在计划里伪造 `branchName`，不要自行建分支。Task 提交由 Core 使用稳定编号生成 `T001: 标题`。
分支命名不代替依赖交付 SHA 的核验；不要用分支名称推断 DAG 已经完成集成。

- 只要求规划时先交付文档和差异；只有用户授权创建/更新后才执行正式命令。这个 Skill 不自动
  批准计划、启动 Planner/Run、推送代码或发送消息。
- 使用 [操作 Skill](../shiploop/SKILL.md) 和当前 `shiploop ... --help` 确认 CLI；项目、Phase、
  Feature、Task 状态只经 CLI/Host 写入，禁止直接 SQL 或生成官方 YAML/Task JSON。
- PRD/设计写入 project documents 返回的 workingDirectory。用 `feature create --project <id> --phase <id> --title <title> --prd <相对路径> [--design <相对路径>]` 创建正式空草稿并关联文档。
- 保存真实 Feature ID；用户授权规划时直接 `planning start <featureId> --project <id>`。系统自动固定正文和版本、保存候选，不要求手写制品引用或维护映射 JSON。候选仍需审阅和批准，不自动开始编码。
- 每次命令前读最新 revision、保留 commandId；结果未知先查回执。依赖用正式
  `feature dependencies`，其 edges 是整个 Phase 的整体替换，必须合并并保留其他已有依赖，
  不只提交本轮新增子图，更不能清空已执行图。由 Core 核验 DAG 与活动 Batch 约束。
- 建图后重新查询 `phase graph`，核对节点、真实 ID、方向、环、遗漏边和并发层；文档确认
  不等于业务批准或阶段验收。输出本轮实际创建/修改、未执行及阻塞项。
