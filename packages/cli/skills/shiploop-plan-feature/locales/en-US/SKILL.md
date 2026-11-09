---
name: shiploop-plan-feature
description: Use the current Harness to plan ShipLoop Phase Features, PRDs and real dependency DAGs with minimal coupling and clear parallel ownership. Does not start Task Planner or coding.
---

# ShipLoop Feature Planning

Plan with the current conversation model, no additional model calls/subagents. Features are independently deliverable/acceptable outcomes; Tasks implement them. Verify repository/formal state before proposing new work. Use English by default under en-US, preserving user/source language and honoring explicit deliverable language.

## Inspect and Bound Scope

1. Read AGENTS.md. Query `shiploop project documents --project <id> --json` for the managed document directory independent of code branches, then read its product/architecture/Phase docs and index, following [documentation](../shiploop/references/documentation.md). Search selectively, not entire session histories.
2. Query project/Phase/Features/plans through CLI. Separate completed, approved and active work; retain real Host IDs and do not recreate/reset it. Document aliases are not IDs.
3. State goals/non-goals, reusable capabilities, acceptance and unresolved ownership/protocol decisions. Ask about consequential missing information; use established patterns for routine details. Do not force Feature counts.

## Decompose for Parallelism

- Split by business capability, stable interface and module ownership, not one Feature per file/layer/test. Each has explicit inputs and independently reviewable outputs/acceptance.
- Preserve real dependencies: if A/B are independent and C consumes both, use A→C and B→C. Do not invent serial chains or hide edges in execution order.
- Freeze shared schemas/protocols/migration conventions/framework setup in a small prerequisite when necessary, then parallelize consumers that actually need it.
- Check logical independence against shared registrations/exports/package files/lockfiles/test helpers/migration numbers/config/docs index. Assign one owner or specify ordering/integration.
- Keep inseparable tightly coupled module changes together; do not manufacture empty interfaces/nodes solely for concurrency.
- Assess database/process/port/external resources as well as files. Prompt guidance is not isolation. Core owns worktrees/branches/official merges.
- Concurrency is a ceiling, not a target. DAG, resource locks, approval and integration determine actual readiness.

## Deliver

Use [the map](feature-map.md): scope, deliverables, contracts, changed directories, shared ownership, real predecessors, parallel candidates, resource/integration risks, independent acceptance, affected tests and owner decisions.
Write each PRD, link one authoritative technical design for storage/protocol/concurrency/recovery. Show DAG with an edge rationale. Tasks run related unit tests, Features scoped union, Phase affected regression/necessary integration; full regression belongs to CI/explicit authorization.
Do not fabricate official Task lists. Planner must classify low/medium/high per Task and include English labels and actual languages arrays, not one Feature-wide difficulty.

## Formal Changes

Core freezes `feat/p01/f01-<slug>` as Feature branch metadata at creation; titles without ASCII words use `feature`.
Do not supply branchName in plans or create Git branches manually. Core uses persistent Task ordinals for `T001: Title` commits.
Names do not replace verification of predecessor delivery SHAs or prove DAG code integration is complete.

- Planning-only requests produce documents/diffs. Create/update only with authorization; no automatic approvals/Planner/Run/push/messages.
- Use [operations](../shiploop/SKILL.md) and installed CLI help. No direct SQL or official YAML/Task JSON writes.
- Write PRD/design into the workingDirectory returned by project documents. Use `feature create --project <id> --phase <id> --title <title> --prd <relative-path> [--design <relative-path>]` to create the formal empty draft and bind its files.
- Retain the actual Feature ID. When authorized, use `planning start <featureId> --project <id>`; Core automatically freezes documents/versions and saves a candidate. No manual Artifact references or mapping JSON. Candidate review/approval remains explicit and never starts coding automatically.
- Read revision before each write, retain commandId and query unknown receipts first.
- feature dependencies replaces the whole Phase edge set. Merge/preserve existing edges and active graph; do not submit only the new subgraph or clear prior dependencies. Core validates DAG/active Batch constraints.
- Requery phase graph to verify real node IDs, directions, cycles, omissions and concurrency layers. Document agreement is not business approval/acceptance. Report actual mutations, unrun steps and blockers.
