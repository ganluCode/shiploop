# 排障和验收

先查结构化状态，再查定向证据：

```bash
shiploop execution result-diagnostics --project "$PROJECT_ID" --run "$RUN_ID" --data-root "$DATA_ROOT" --json
shiploop execution sessions --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop execution session-evidence "$ATTEMPT_ID" --artifact "$ARTIFACT_ID" --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop feature report "$FEATURE_ID" --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
```

状态含义必须分开：

- `accepted`：命令提交成功，异步工作可能尚未开始。
- `pending`：等待依赖、审批、资源或调度。
- `running`：当前仍有活动执行。
- `failed`：当前执行或验收失败。
- `not_run`：明确未执行，不算通过。
- `passed`：对应层级的验证通过。
- `delivered`：交付事实已记录，不等于 Phase 人工批准。

验收时保存测试范围、命令、Git SHA、证据引用、耗时和用量；不要用模型文字替代结构化证据。
