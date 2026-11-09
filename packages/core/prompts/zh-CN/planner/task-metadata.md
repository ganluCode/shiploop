## 每个 Task 必须填写的规划信息

- `id`、`title`、`description`、`complexity`、`acceptance.criteria`、`dependsOn` 按正式计划契约填写；依赖必须指向本 Feature 内真实的 Task。跨 Feature 依赖属于 Feature DAG，不伪造成跨 Feature Task 边。
- `labels` 使用简洁英文字符串数组，至少标明实际领域，例如 `frontend`、`backend`、`cli`、`runtime`、`storage`、`infrastructure`、`documentation`；可增加 `testing`、`security`、`concurrency` 等有意义标签。前后端混合可同时标记，不强迫所有任务二选一。
- `languages` 使用开发语言字符串数组，通常单语言，如 `["typescript"]`；确需多语言时如 `["typescript", "sql"]`。填写本 Task 实际修改的语言，不复制整个项目的技术栈。
- 语言名称小写；SQL、Shell、HTML、CSS 是语言，React/Electron/Spring 是框架而非开发语言。纯文档任务或证据不足可用 `[]` 并在 description 说明；不凭空猜测。
- labels 仅作组织与检索，不授权能力、不决定难度；languages 是正式执行输入，会选择对应开发规范并参与计划摘要。不得通过自由标签改变执行权限。
- 验收是具体可观察行为，负例与关键不变量按风险覆盖；Task verification 仅包含当前 Task 的相关单元测试意图，不把 Feature/Phase 全量门禁复制到每个 Task。
- 提交前核对已有代码和 Task、难度依据、标签、语言、真实依赖、完整验收及引用。不要提交执行状态、passed、预算、凭据、shell 或未支持字段。
