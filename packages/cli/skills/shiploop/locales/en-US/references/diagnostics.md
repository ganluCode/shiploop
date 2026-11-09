# Diagnostics and Acceptance

Query structured state first, then specific evidence:
```bash
shiploop execution result-diagnostics --project "$PROJECT_ID" --run "$RUN_ID" --data-root "$DATA_ROOT" --json
shiploop execution sessions --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop execution session-evidence "$ATTEMPT_ID" --artifact "$ARTIFACT_ID" --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop feature report "$FEATURE_ID" --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
```

accepted = submitted, pending = awaiting dependencies/approval/resources/scheduling, running = active execution, failed = execution/check failure, not_run = unexecuted, passed = that verification layer passed, delivered = delivery recorded (not Phase owner acceptance).
Save tested SHA, commands, scope, results, evidence, duration and usage. Model prose is not evidence.
Text reports follow global locale; JSON schema/status fields and raw descriptions remain stable. Inspect bounded session evidence by ID/keyword, never scan whole histories.
