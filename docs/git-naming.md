# Git 命名规范

ShipLoop Core 为新 Feature 持久保存 `branchName`，例如 `feat/p01/f02-project-storage`。
`p01/f02` 来自数据库稳定显示编码，名称后缀是创建时标题的 ASCII kebab-case，最长 64 字符；
无 ASCII 单词时使用 `feature`，例如 `feat/p01/f02-feature`。不会自动翻译标题或调用模型。
标题、计划、DAG 或所属阶段变更后不自动重命名。`feature get` / `feature list` 的 JSON 返回该字段，
它是 Core 管理的元数据，不是计划输入，也不提供任意覆盖或改名开关。

Task 提交标题为 `T001: 实现配置读取`。编号来自当前 Feature 的持久 Task 编码，
不是执行顺序、UUID 或模型自己编号。标题归一为单行且最多 200 字符；
Core 验收通过后生成提交意图，Runtime 不应自行 commit/push。
Git 操作的审计 trailer 和现有提交身份规则保持有效。

升级保留已经存在的受管工作区分支及历史提交。历史 Feature 没有工作区时，
冻结 `feat/p01/f02-feature`。已持久化提交意图的恢复沿用原消息，避免破坏幂等身份。
缺失分支或 Task 显示编码时拒绝新操作，不猜测编号或静默生成其他分支。

命名和起点是独立规则：分支名不证明已包含依赖代码，编码启动还需要核验 DAG 对应的
验收交付 SHA。此次命名调整不自动迁移已有 worktree，也不补齐依赖集成流程。
人工阶段验收分支沿用 `acceptance/p01`；它不由 Feature 工作区准备器创建。
