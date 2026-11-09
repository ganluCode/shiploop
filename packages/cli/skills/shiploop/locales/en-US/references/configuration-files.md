# YAML Configuration and Fallbacks

JSON/YAML config create/update/watch supports shorthand in default/modelMap/purposeStrategies/agentOverrides, fallbacks and featureAutoFix.strategy:

```yaml
schemaVersion: 2
strategies:
  modelMap:
    medium:
      runtime: pi
      model: ark-agentplan/ark-code-latest
```

Only an omitted provider enables splitting at the first slash; subsequent slashes belong to the model ID. With an explicit provider, model remains an opaque ID (including org/model); do not mix formats. runtime is still required. Explicit credentialRef is preserved/validated; non-Pi credentials are not inferred. Database and direct HostClient requests retain the expanded formal format. Actual capabilities/private keys remain mandatory; shorthand never bypasses authorization or budgets.

When asked to create configuration:
1. Inspect existing shiploop.yaml/shiploop.yml/JSON. Make local edits preserving comments/unrelated fields.
2. Query current settings/capabilities; confirm low/medium/high/planner and fallback order. Leave undecided tiers absent/commented.
3. Use [the template](../templates/shiploop.yaml) in the actual repository root. Example models require catalog verification. Creating a file does not save settings or authorize calls.
4. Fill runtime. You may omit provider and use model: provider/model. Pi credentialRef defaults to credential://pi/<provider> when reading configuration files; this creates only a reference, never a key. Keep keys private. Fallbacks cannot nest or duplicate primary/fallback identities.
5. Report path/order/open decisions. Sync/watch only when explicitly authorized.

```bash
shiploop config create --scope project --project "$PROJECT_ID" --input ./shiploop.yaml --json
# For existing configuration: config get first, then config update --revision <n>.
shiploop config watch --project "$PROJECT_ID" --confirm
```

--input accepts strict JSON or YAML/YML with comments. Watch defaults to cwd/shiploop.yaml and is a foreground continuous CLI process, not a persistent Host subscription. Background use needs authorization/PID/logs.
Same contents/comments do not increment revision. Invalid files/schema keep the old database value and warn; repair the file to continue. Concurrent database revisions warn/exit without overwriting other clients. Unknown write results require the same commandId receipt, not blind new writes. Ctrl+C/SIGTERM stops watching only.

Fallbacks are ordered, approved Task strategies. No list preserves prior behavior. Quota, exhausted transient connection/server retries and auth can switch unless fallbackPolicy says stop. Core first verifies old execution stopped, recording completeness, reusable workspace, authorization and remaining budget. Tool/test/protocol/config errors are not hidden by model switching. Stop if no fallback works or stopping is uncertain. Do not promise cross-model native resume.
Each new Task starts its frozen primary; previous fallback does not change defaults. No persistent provider reset-time integration or "hi" probes.

Default settings updates do not rewrite planned Tasks or existing Attempt/Batch snapshots. Use strategy-preview/reapply with CAS/confirmation and possible reapproval.
Project YAML is not private pi/runtime.json or auth.json. Capabilities need Host restart; ordinary saved policies do not.
locale is global only: en-US (default) or zh-CN. Add it to a global configuration submitted with --scope global, never the project template. Settings replacement is whole-payload: preserve existing fields.
See [production policies](production-runtime.md); template auto-fix/push/notifications remain disabled until authorized.
