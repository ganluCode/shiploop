---
name: shiploop
description: Initialize ShipLoop projects, write PRDs/designs, plan Phases/Features, and operate execution, acceptance, approval, delivery and recovery.
---

# ShipLoop Project Operations

ShipLoop owns project, Phase, Feature, Task, execution, acceptance, Git, evidence and runtime state.

## Required Boundaries

- Query/change business state only through the shiploop CLI or HostClient. Never directly edit core.sqlite, Feature YAML, Task JSON, receipts, sessions or generated acceptance reports. Never bypass services with SQL.
- Use graceful control/recovery, not kill, lock removal or session deletion.
- Retain commandId for writes. On network timeouts query the original receipt before generating another ID. Read current revision and use CAS.
- accepted is submission, not completion. passed, completed, delivered, owner approval and Phase acceptance are distinct facts.
- Verify structured results/evidence; model text saying "done" is not business truth.
- Follow the global locale (default en-US; also zh-CN) for explanations/replies. Preserve commands, IDs, enum values and quoted user/source content. Honor an explicit deliverable language.

## Variables and Workflow

```bash
export DATA_ROOT="/absolute/path/to/shiploop-data"
export PROJECT_ID="<project-id>"
export PHASE_ID="<phase-id>"
export FEATURE_ID="<feature-id>"
```

Prefer --data-root "$DATA_ROOT" --json for automation.

Before writing requirements/designs or planning, read [documentation conventions](references/documentation.md). Documents live in the repository; init neither writes PRDs nor automatically scans docs to start planning.

1. Start/check Host with shiploop host start/status.
2. Preview project init, then confirm explicitly.
   Command: `shiploop project init "$REPO" --confirm --name "Project name"` (omit --name for an existing binding).
3. Configure Runtime/Provider/Model and private credential references.
4. Create Phase, import/plan Features, review and approve the plan.
5. execution preview first; authorize execution start using --confirm --preview-digest.
6. Retain Batch/Run/Attempt/Session/Receipt IDs.
7. Observe queries/events with targeted evidence, not whole-log scans.
8. Verify Task/Feature/Phase separately; owners must explicitly decide manual gates.

## Recovery

Same commandId/parameters replays the receipt; changed content conflicts (idempotency_key_reuse).
An active Run for a Feature conflicts with a new execution (execution_in_progress).
Use receipt get, then Run/Batch queries after timeouts. Inspect execution recovery before choosing resume, retry-final or new execution; they are different operations.

```bash
shiploop project overview "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop phase list --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop feature list --project "$PROJECT_ID" --phase "$PHASE_ID" --data-root "$DATA_ROOT" --json
shiploop task list --project "$PROJECT_ID" --feature "$FEATURE_ID" --data-root "$DATA_ROOT" --json
shiploop execution runs --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop execution attempts --project "$PROJECT_ID" --data-root "$DATA_ROOT" --json
shiploop execution result-diagnostics --project "$PROJECT_ID" --run "$RUN_ID" --data-root "$DATA_ROOT" --json
```

## Read on Demand

- [Feature planning](../shiploop-plan-feature/SKILL.md): use the current Harness, real DAG and shared-file ownership; do not start extra models.
- [Configuration files](references/configuration-files.md): create a YAML template and confirm routing/fallbacks before syncing/watching.
- [Documentation](references/documentation.md): conventions and PRD/design templates.
- [Initialization](references/project-init.md): registration and repeated official Skill sync.
- [Providers](references/providers.md): model tiers, private credentials and capabilities.
- [Production Runtime](references/production-runtime.md): retries, auto-fix, auto_push, Feishu and limits.
- [Execution](references/execution.md): start/control/idempotency.
- [Diagnostics](references/diagnostics.md): structured evidence and acceptance.
- [CLI index](references/cli.md): planning, approval, resources, Git, backup and command families; search relevant sections.
- [Host integration](references/host.md): trusted desktop/cross-language integration.

This Skill provides procedures, not authorization for model calls, execution, deletion, push or approvals. Reuse explicit user authorization; preview unresolved budgets/manual decisions.
