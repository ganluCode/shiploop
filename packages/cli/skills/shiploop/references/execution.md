# 执行、幂等和停止

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
