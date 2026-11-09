# P03-4 Task DAG Readiness Contract (F-002)

## Entry Points and Boundaries

- `createTaskDagService({ store, nowMs }).evaluate(projectId, runId)` reads and evaluates one view. `evaluateTaskDag(view, nowMs)` is the pure rule implementation. Both are exported from `shiploop-core`.
- `createSqliteTaskDagStore(session)` is an internal SQLite factory. An independent call uses one bounded DEFERRED read transaction. Inside a caller transaction it reuses that transaction, allowing F-004 to recheck qualification before claiming.
- No mutation, receipt, event, claim, process start, lease release, new Run, or Runtime/Verifier integration occurs here. Missing Run and ownership errors remain structured storage errors. Corrupt persisted views return `invalid_graph` through the service without exposing stored payloads.

## Frozen Scope and Identity

The delivered P03-3 schema is authoritative: Run carries `scopeDigest`, `workKey`, `inputSnapshot` and frozen Run limits; parent Batch carries `scopeSnapshot`, approval identity, Task strategy digests and permission digests. There is no new parallel Run scope format.

- Batch must authorize exactly this Feature. Its Task digest and permission lists must be nonempty, unique and equal the current coding Task membership.
- Run scope/preview identity must equal the Batch's fixed preview digest. Input plan identity, initial pending Task membership, current resolved immutable inputs and recomputed work key must agree.
- Plan business digest is recomputed from the coding Tasks and dependencies using the existing plan validator. Missing nodes, self edges, duplicate edges, cycles, external dependencies, changed membership or changed business/strategy/input identity fail closed as `invalid_graph`. No graph expansion occurs.
- Planning-only work is excluded. An edge between coding and planning is not a valid coding dependency. An initially nonpending Task cannot become a candidate just by reverting its status.
- Current approval validity uses the existing plan/check-policy rule. Absent approval, rejected/superseded decision, policy drift or changed decision identity produces `waiting_approval` with a diagnostic.

## Valid Passed Evidence

Task status alone is insufficient. A predecessor must be unblocked and `passed`, with a trusted persisted Attempt that:

- is `succeeded`, at verification/commit/cleanup stage, with zero exit code, an end timestamp and ready same-project code evidence;
- matches the Task's current fencing `executionVersion`, Project, Feature and Task;
- binds the current approved plan/check policy/decision, frozen strategy and permission digests;
- has required immutable inputs equal to the current Feature-plus-Task input identities;
- passes F-001's strict snapshot/identity validator, and has all prepared input-group and required-input Artifact indices ready and matching version/hash/size/locator/media type.

This is a trusted Core-state contract for future Verifier/result application. Model messages, normal Runtime exit and Task status replay cannot create these facts. Dedicated test state fixtures exercise valid evidence; no user-facing direct-pass command is added.

## Ordering and Reasons

Stable Kahn traversal chooses the smallest Task ID by JavaScript code-unit comparison at every available frontier. All task results follow this full topological order; ready IDs are its eligible subsequence. Invalid graphs use sorted known frozen IDs, never partial traversal results.

Precedence:

1. Graph/snapshot integrity errors.
2. Run/Batch lifecycle and Project/Phase execution eligibility.
3. Current approval validity.
4. Per Task: manual block, valid passed evidence, invalid terminal/nonpending Task, blocked predecessor, failed predecessor, unfinished predecessor, resource occupancy, budget, ready.
5. Run summary: any ready candidate; otherwise all valid passed with no occupancy; otherwise `dependency_failed`, `waiting_approval`, `resource_busy`, `budget_exhausted`, `dependency_pending` in that order.

Other lifecycle results are `run_not_active`, `run_control_blocked`, `batch_not_active`, `batch_control_blocked`, `project_not_active` and `phase_not_executable`. Only queued/running Run and Batch are claimable. The existing queued `scheduler_not_assembled` reason is not a lifecycle control state.

Global single concurrency includes baseline occupancy, every held/quarantined workspace lease, active Attempt, and running Task. Expired leases remain occupied. Resource identity acquisition/validation and stop-proof release belong to F-003.

Budgets use persistent Batch Attempt/runtime/no-progress counts and absolute deadline, existing Run reservation rules and current Task total/code Attempt caps. The current schema has no token/cost usage ledger: configured optional resource caps therefore block qualification rather than being treated as zero usage. Batch `maxRuns` governs new Run creation, not the already-created Run's Task eligibility. An `all_passed` result needs no further code Attempt allowance.

## Final Handoff

`all_passed` returns `handoff: 'feature_final_verification'`. It never marks Feature completed or Run succeeded and never creates another Run. Occupancy must be clear before this handoff.

## Migration v15

Append-only v15 adds Task `kind` (`coding`/`planning`, default `coding`) and `manual_block` (integer 0/1, default 0). Existing v1-v14 SQL and checksums remain frozen. Existing plans, approvals, Run snapshots and budget ledgers are preserved. These columns are internal facts; this task adds no edit/pass/block command surface.
