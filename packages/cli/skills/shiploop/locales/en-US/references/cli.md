# CLI Command Index

Use --data-root <absolute-path> and prefer --json. Installed shiploop <command> --help is authoritative.

## Projects and Settings

```text
project init <repository-path>
provider login|auth-status|logout|models openai-codex [--data-root <path>]
project overview <project-id>
project list
project get <project-id>
project edit <project-id>
project labels <project-id>
config create --scope global|project --input <file>
config update --scope global|project --revision <n> --input <file>
config get --scope global|project
config effective --project <id>
config export --scope global|project
config watch --project <id> --confirm [--input shiploop.yaml]
project profile-detect|profile-get|profile-match|profile-confirm|profile-modify|profile-reject
```

## Phase, Feature, Task and Planning

```text
project documents --project <id>
document write --project <id> --path <relative.md> --input <file.md> [--expected-hash <sha256>]
feature create --project <id> --phase <id> --title <title> --prd <relative.md> [--design <relative.md>]
planning start <feature-id> --project <id> [--budget <budget.json>]
```

Documents live in the project's managed data directory. Creating a Feature makes no model request; planning freezes documents and publishes a candidate. Approval is required before Tasks are applied.

```text
phase create|update|close|reopen|archive|graph|list|get|labels
phase delivery-approve
feature import|list|get|revise|labels|approve|reject|delivery|report|final-approve|finalize
feature move|dependencies
task list|get|labels|strategy|strategy-reapply-preview|strategy-reapply
task prepare|inputs|status|block|approve|reject|unblock|continue
planning start|list|get|candidate|approve|reject
```

Plan approval is not execution authorization. Use server revisions/digests/approvals, never direct state-file edits. Config JSON/YAML supports ordered fallbacks. Watch is explicit, retains old values on invalid files, stops on external revision/connection conflicts and does not rewrite/approve existing Tasks.

## Execution and Diagnostics

```text
execution preview|start|budget|revise
execution batch-delivery|batch-observe|finalize
execution schedule|attempts|runs|diagnostics|dispatch|resources
execution sessions|session|session-evidence
execution recordings|recording-body|result-diagnostics
execution pause|cancel|resume|retry-final|control|batch-control|recovery
receipt get <command-id>
events observe
```

Execution normally requires frozen scope, budget input, previewDigest, --confirm and commandId. accepted is not completion; query receipt then Run/Attempt/diagnostics.

## Workspace, Git and Delivery

```text
workspace list|get|operations|operation|discard-preview|discard
git operations|operation|repairs|repair
integration plan
feature delivery|feature final-approve|feature finalize
phase delivery-approve
```

Use controlled Git/workspace commands and cleanup previews, not arbitrary shell/worktree deletion.

## Baseline, Resources, Knowledge and Backup

```text
baseline preview|run|list|status|compare|cancel|evidence
knowledge search|read
project resource-source-register|resource-source-remove
project resource-list|resource-discover|resource-preview|resource-import
project resource-enable|resource-disable|resource-revoke
backup create|verify|get|operation
restore verify|prepare|confirm
retention evaluation|cleanup
notifications list|get
```

Baseline, deletion, restore, resource enablement and real model verification need separate authorization. Failed queries and not_run are not passes.

## Errors and Recovery

- Input errors typically exit2; business conflicts/approval/resource issues1; Host connection/protocol3; interrupted observation4.
- Observation interruption does not cancel execution.
- Network timeout: query receipt with the original commandId.
- stale_revision: read latest state and reconfirm intent before submitting a revision.
- execution_in_progress: existing active execution; do not create a duplicate Run.
- Uncertain stop: execution recovery, not PID/lock removal.
