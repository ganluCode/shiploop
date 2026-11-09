# ShipLoop 提示词与规划 Skill

## 文件入口

内置提示词统一在 `packages/core/prompts/`，随 Core 包发布：

资源位于 `en-US/`、`zh-CN/` 子目录。全局 `locale` 默认 `en-US`；选中语言缺少单个模块时回退英文，并在 provenance 标明实际来源。下表是各语言目录内的结构。

| 目录 | 用途 |
| --- | --- |
| task | 当前任务、验收与策略、必读引用、返工、恢复和有界历史 |
| planner | 固定规划边界、low/medium/high 详细标准、Task 标签/语言要求、动态输入 |
| languages | 通用规则及按 Task.languages 选择的语言规范 |
| repair | Feature 自动修复与失败证据模板 |
| runtime | 系统提示、Codemode、项目指令/选定 Skill 包装、工具说明及连通性探针 |

Prompt 文案不再写在 TypeScript。代码负责授权、变量校验、模块选择、数据格式化和预算；
权限、状态与验收不能只靠提示词实现。外部 MCP 工具描述和项目 AGENTS/选定 Skill 保留各自来源。

## 变量与组合

Markdown 用 `{{variable}}` 或 `{{task.title}}` 声明必需变量；调用方显式传入字符串。
可选段落由代码选择或传空字符串，不在 Markdown 执行脚本、条件表达式或递归模板。
变量内容中的模板标记原样保留；变量缺失、文件缺失、非法语法或资源超限直接报错，
不会回退到隐藏的内联文案。凭据不传入变量，大段日志和历史优先传受管文件/制品引用。

Task 固定指导及语言规范在动态任务数据前；返工/恢复按场景追加。语言名称仅用于有限内置
模块映射，多语言稳定组合、去重；没有专属规范的语言仍使用通用规范。labels 不用于选择
规则或扩大权限。项目自身规范通过已有授权上下文加载，不自动加载用户全局资源。

manifest 的 `promptTemplates` 记录版本 1 和选中资源的 SHA-256。
模板摘要按实际加载正文计算（统一 LF，去文件末尾空白），不是包含原始行尾的文件字节摘要。
最终 Prompt 摘要、不可变制品以及快照继续保留。修改包内 Markdown 后，新打开的装配/Runner 使用新资源，
已准备好的历史输入不改写。代码变更需要 build，常驻 Host 需要空闲后重启才能切换装配，
不支持项目任意覆盖或运行中热替换模板。

## Feature 与 Task 规划

`packages/cli/skills/shiploop-plan-feature/locales/<locale>/SKILL.md` 由当前 Harness 模型规划 Phase 的
Feature 与 PRD，不自动调用 ShipLoop Planner 或额外模型。它要求独立结果、明确所有权、
真实依赖 DAG、共享文件冲突及必要集成前提，尽量支持 Feature 并发，但不伪称完全隔离。

Task Planner 读取 `planner/complexity.md`，按确定性、既有模式、不变量、跨层影响和验证
难点分 low/medium/high，不凑比例，不以文件数或耗时定难度。每个 Task 要填写英文 labels
和实际 languages 数组；兼容旧计划的默认规则保留，不自动补写历史任务。

`project init --confirm` 同步两个官方 Skill 到 `.agents/skills/` 与 `.claude/skills/`，
重复执行覆盖这两个官方目录，保留其他 Skill 和项目文档。安装 Skill 不代表任意 Harness
已经自动加载它；需查看 Harness 的发现结果或显式调用 `shiploop-plan-feature`。

全局配置、语言生效和兼容边界详见 [工作流国际化](shiploop-localization.md)。
