# 执行、幂等和停止

## Git 命名

Core 创建 Feature 时冻结 `branchName`，例如 `feat/p01/f02-project-storage`；
前缀来自稳定 Phase/Feature 编码，后缀来自创建时标题的 ASCII kebab-case，无英文单词时为 `feature`。
`feature get/list --json` 可查看；改标题、修订计划或移动 Phase 不改分支名。
新 Task 提交为 `T001: 任务标题`，使用持久 Task 编号，由 Core 验收后提交，模型不要自行 commit/push。
旧工作区保留原分支，历史提交和已持久化提交意图不改写。分支名不代表 DAG 依赖代码已经集成。

## Task 开发语言

规划候选或正式计划中的每个 Task 使用 `languages` 字符串数组声明实际开发语言：
单语言如 `["typescript"]`，多语言如 `["typescript", "sql"]`。不要用 React、Electron
等框架名称代替语言；非代码任务或证据不足时使用 `[]`。

省略兼容为空数组；最多 16 项，每项 1～64 字符，自动 trim、转小写、去重并排序。
非空语言属于业务执行依据，参与计划摘要、执行快照和 Prompt；修改时走正式计划修订，
不能通过标签编辑或直接改 SQLite 绕过批准。已有任务不会自动猜测补填。

## 预览和启动

```bash
shiploop execution preview --project "$PROJECT_ID" --feature "$FEATURE_ID" --input execution-budget.json --data-root "$DATA_ROOT" --json
shiploop execution start "$FEATURE_ID" \
  --project "$PROJECT_ID" \
  --input execution-budget.json \
  --preview-digest "$PREVIEW_DIGEST" \
  --confirm \
  --command-id "$COMMAND_ID" \
  --data-root "$DATA_ROOT" --json
```

## 幂等

- 相同 commandId、相同参数：返回原回执，不重复创建 Run。
- 相同 commandId、不同参数：`conflict/idempotency_key_reuse`。
- 不同 commandId、同 Feature 已运行：`conflict/execution_in_progress`。
- 网络超时先查询：`shiploop receipt get "$COMMAND_ID" ...`。

## 控制

```bash
shiploop execution pause --project "$PROJECT_ID" --run "$RUN_ID" --revision "$RUN_REVISION" --command-id "$COMMAND_ID" --data-root "$DATA_ROOT" --json
shiploop execution cancel --project "$PROJECT_ID" --run "$RUN_ID" --revision "$RUN_REVISION" --confirm --command-id "$COMMAND_ID" --data-root "$DATA_ROOT" --json
shiploop execution recovery --project "$PROJECT_ID" --run "$RUN_ID" --data-root "$DATA_ROOT" --json
```

不要使用 PID、锁文件或删除 Session 文件来停止或恢复执行。
