# Execution, Idempotency and Control

## Git Naming

Core freezes Feature `branchName` at creation, e.g. `feat/p01/f02-project-storage`.
The prefix uses persistent Phase/Feature codes; the bounded ASCII title slug falls back to `feature`.
Inspect it through `feature get/list --json`. Renaming titles, revising plans or moving Phases does not rename Git refs.
New Task commits use `T001: Task title`, based on the persistent Task alias. Core commits after verification;
the model must not commit/push itself. Existing workspace branches, commits and durable commit intents remain unchanged.
A branch name does not prove DAG dependency code has been integrated.

## Task Languages
Declare languages as actual language arrays: ["typescript"] or ["typescript","sql"]. Frameworks such as React/Electron are not languages. Use [] for documentation/unknown languages. Omitted means empty; up to 16 items, each 1–64 characters, trimmed, lowercase, deduplicated and sorted.
Nonempty languages affect plan/input identity and Prompt standards. Changes require formal plan revision/approval, not label edits/SQL. Existing Tasks are not guessed automatically.

```bash
shiploop execution preview --project "$PROJECT_ID" --feature "$FEATURE_ID" --input execution-budget.json --data-root "$DATA_ROOT" --json
shiploop execution start "$FEATURE_ID" --project "$PROJECT_ID" --input execution-budget.json --preview-digest "$PREVIEW_DIGEST" --confirm --command-id "$COMMAND_ID" --data-root "$DATA_ROOT" --json
```

Same commandId/content replays; different content gives conflict/idempotency_key_reuse.
A new ID for an active Feature gives conflict/execution_in_progress. After timeout query receipt get "$COMMAND_ID".

```bash
shiploop execution pause --project "$PROJECT_ID" --run "$RUN_ID" --revision "$RUN_REVISION" --command-id "$COMMAND_ID" --data-root "$DATA_ROOT" --json
shiploop execution cancel --project "$PROJECT_ID" --run "$RUN_ID" --revision "$RUN_REVISION" --confirm --command-id "$COMMAND_ID" --data-root "$DATA_ROOT" --json
shiploop execution recovery --project "$PROJECT_ID" --run "$RUN_ID" --data-root "$DATA_ROOT" --json
```

Never stop/recover by PID, lock deletion or session deletion.
New input preparation freezes the global locale; existing execution input keeps its language. Native resume must pass input identity checks, not silently mix languages. Legacy inputs without locale retain their original Chinese runtime behavior.
