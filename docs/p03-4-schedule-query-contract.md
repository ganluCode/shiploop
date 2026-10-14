# P03-4 Schedule & Attempt Audit Query Contract

## Scope

F-007 extends the Core authorized query service with the Run scheduling reason,
the derived per-Task readiness view and the Attempt/occupancy audit reads.
Implementation: `packages/core/src/ports/execution-schedule-query.ts` (public
shapes, frozen vocabulary, composite cursor keys),
`packages/core/src/adapters/sqlite/execution-schedule-query-store.ts` (read-only
narrow port over one DEFERRED consistent read transaction),
`packages/core/src/application/query-service.ts` (three authorized use cases),
wired through `packages/core/src/adapters/sqlite/query-store.ts` and
`packages/core/src/adapters/composition.ts` (`scheduleReads`). Host transport and
HostClient exposure are F-008 (see Host Exposure below); no HTTP, CLI or
scheduler behavior changes here.

## Query Surface

Three read-only operations (capability bit reuses `project.read`; ability checks
precede any read, cross-project/nonexistent targets fold to an identical
`not_found` with `details.reason = 'execution_entity_not_found'`):

| Operation | Input (strict unknown-key rejection) | Output |
|---|---|---|
| `execution.run.schedule` | `{ projectId, runId }` | `RunScheduleStatusResult` (scope `run-schedule`) |
| `execution.attempts.list` | `{ projectId, taskId, limit?, cursor? }` | `AttemptListResult` (scope `attempt-list`) |
| `execution.attempt.diagnostics` | `{ projectId, attemptId, limit?, cursor? }` | `AttemptDiagnosticsResult` (scope `attempt-diagnostic-list`) |

- `execution.run.schedule` returns the Run identity block
  (Project/Feature/Batch/Run/workKey/dispatchOrdinal), the derived schedule
  evaluation (`reason`, `diagnostic`, stable `readyTaskIds`, `handoff`), the
  per-Task derived view in stable topological order (`reason`, `dependencyIds`,
  persisted `status`/`executionVersion`/`manualBlock`, `latestAttempt` with
  `executionStage`) and the retained occupancy audit (held/quarantined leases
  with owner Attempt and owner Run correlation).
- The readiness verdict is recomputed from the same `evaluateTaskDag` pure rule
  over the same consistent SQLite view used by the claim/scheduler path. It is
  never read from logs, wake-up hints or an in-memory queue, and ready/blocked
  is never persisted as a second writable Task state. Closing and reopening the
  database yields identical results.
- A corrupt persisted DAG view degrades to `invalid_graph` with
  `diagnostic: 'corrupt_persisted_view'` (the F-002 service semantics); the Run,
  Attempt and occupancy facts remain readable. The query never fabricates ready.

## Pagination and Cursors

Both lists reuse the plan-list discipline: default limit 50 / maximum 200
(`validatePlanListFilter`), opaque `plcur_v1_` cursors bound to the data root,
project and parent entity. `PlanListScope` gains `task-attempts` (parent Task)
and `attempt-diagnostics` (parent Attempt); existing scope fingerprints are
unchanged. Cursor payloads carry a composite key
(`encodeExecutionListKey`: `<sort>_<rowId>`, Attempt number / diagnostic
occurredAt plus row identity) giving stable keyset pagination over
`(number, id)` and `(occurred_at, id)`. Cursor decoding precedes any existence
read: cross-project/cross-parent/cross-root replays and tampered payloads are
`invalid_input(invalid_cursor)`, never treated as reading from the start.

## Known/Unknown and Redaction Discipline

- Known exit codes, durations, start/end times and usage are preserved verbatim;
  unknown values stay `null` (never zero-filled). `executionStage` is shown
  as-is: `verifying` is not acceptance, `queued` is not success.
- Diagnostic rows retain only the same-project Attempt link, the request
  digest, the fixed reason (`stale_execution_identity` /
  `invalid_transition` / `notification_id_reused`) and the occurrence time —
  never the supplied identifiers, messages, output, paths or credentials.
- Outputs contain only structured facts: no `inputSnapshot`/`configSnapshot`/
  `scopeSnapshot` bodies, no credential material, no arbitrary file content and
  no absolute paths. Occupancy `resourceKey` values are normalized hash keys
  (`global:execution`, `project:<id>:work`, `workspace:<sha256>`), not paths;
  the supervised process identity is exposed only as a known/unknown boolean.

## Read-Only Guarantee

The query surface owns no write primitive: it creates no Attempt, charges no
budget, renews no lease, starts no work and appends no event. Directed tests
cover the ready view, preparation failure, late diagnostics, waiting for human
review, dependency failure, budget exhaustion and quarantined occupancy, and
assert byte-identical persisted tables (attempts, leases, reservations, events)
before and after every query.

## Host Exposure (F-008)

F-008 wires the three read-only operations through the existing Host query
dispatch, capability whitelist and HostClient — no new HTTP service, auth
scheme, claim/runtime-result entrypoint or direct SQLite access:

| Operation | Frozen route (GET + Bearer) | Query parameters |
|---|---|---|
| `execution.run.schedule` | `/v1/runs/:runId/schedule` | `projectId` (required) |
| `execution.attempts.list` | `/v1/attempts` | `projectId`, `taskId` (required), `limit`, `cursor` |
| `execution.attempt.diagnostics` | `/v1/attempts/:attemptId/diagnostics` | `projectId` (required), `limit`, `cursor` |

- The routes are additive within wire schema v5 (same discipline as the P03-3
  execution wiring); the handshake capability whitelist
  (`APPLICATION_QUERY_CAPABILITIES`) lists exactly the three operations, kept
  in sync with `EXECUTION_SCHEDULE_QUERY_OPERATIONS`.
- The transport layer only validates the parameter whitelist (unknown/duplicate
  → 400 `invalid_input` at `query.<field>`), required parent identities and the
  decimal `limit` shape; authorization, visibility folding, range and cursor
  binding remain with the Core query service as the single authority. Any other
  nested/multi-segment shape is unmatched → 404 `unknown_operation`.
- HostClient gains `getRunScheduleStatus` / `listExecutionAttempts` /
  `listAttemptDiagnostics` with zero-network input guards, runtime wire
  validators (`validateRunScheduleStatusResultWire`,
  `validateAttemptListResultWire`, `validateAttemptDiagnosticsResultWire` —
  exact-key sets, frozen vocabularies shared from `shiploop-core/protocol`)
  and scope-mismatch rechecks (response Run/Task/Attempt ownership must equal
  the request).
- Queries replay with zero side effects; cross-project/nonexistent targets
  fold to the same `not_found` body, and error bodies carry no other-project
  identity, artifact body or absolute path.

Evidence: `test/p03-4-schedule-host-wiring.test.ts` (real `startHost` +
`connectToHost` + temporary seeded SQLite: legal queries with cursor-chain
replay, 401 indistinguishability, 400 parameter negatives, cross-project fold,
read-only table snapshot equality, receipt/event identity association) plus
wire-validator unit cases.

## CLI Exposure (F-009)

F-009 wires the three read-only operations into the existing `execution` CLI
group and HostClient — no new top-level command, no direct SQLite/ORM/log
access, no second state source:

| CLI subcommand | Command identity | HostClient operation |
|---|---|---|
| `shiploop execution schedule <runId> --project <id>` | `execution.schedule` | `getRunScheduleStatus` |
| `shiploop execution attempts <taskId> --project <id> [--limit --cursor]` | `execution.attempts` | `listExecutionAttempts` |
| `shiploop execution diagnostics <attemptId> --project <id> [--limit --cursor]` | `execution.diagnostics` | `listAttemptDiagnostics` |

- Parsing stays in the pure layer (`app/args.ts`): `runId`/`attemptId` must be
  UUID v4 (`invalid_run_id`/`invalid_attempt_id`), `taskId` a stable plan ID,
  `--limit` 1..200 and `--cursor` a non-empty opaque token — all rejected with
  exit code 2 before any I/O; unknown options keep `unknown_argument`.
- The pure view layer (`app/schedule.ts`) projects the wire results into a
  structured readiness classification: `all_passed` + handoff surfaces as
  `awaiting_feature_final_verification` (pending Feature final verification,
  not delivery), an Attempt in `verifying` as runtime result pending
  verification, `failed`+`preflight` as preparation failure,
  `waiting_approval`/`manualBlock` as approval waiting and
  `resource_busy`/quarantined leases as resource isolation.
  `completion.featureVerified`/`delivered` are always `false`: accepted,
  no-ready or execution text success are never shown as delivery success.
- Errors reuse the existing exit-code discipline: invalid input 2, business
  fold `not_found` 1 (cross-project/nonexistent indistinguishable), Host
  unreachable/start timeout 3; the CLI only talks to the Host.
- Help text for `execution` and the three subcommands states that this
  Feature (P03-4) has no complete execution/verification loop yet.

Evidence: `test/p03-4-cli-schedule-args.test.ts` (pure parse/view/help),
`test/p03-4-cli-schedule-vertical.test.ts` (real temporary Host + seeded
SQLite via `runAppCli`: normal queries, cursor chains, invalid input/paging,
cross-project fold, unreachable exit 3, repeated queries leave persisted
tables byte-identical — no claim, no budget charge, no runtime start) and
`test/p03-4-cli-schedule-built.test.ts` (the same checks through the
officially built CLI entry `packages/cli/dist/bin.js`).

## Evidence

`test/p03-4-schedule-query.test.ts` (9 cases): stable candidate order with
read-only and reopen-consistency assertions; retained preparation failure with
stage/errorKind and null unknowns; bounded stable diagnostic pagination with a
replayed cursor chain; manual-block/dependency-failure/budget-exhaustion
reasons from the same readiness rule; held and quarantined occupancy audit
without release or renewal; default/max limits, composite cursor continuation,
invalid filters and tampered/cross-parent cursor rejection; cross-project and
invisible-project folding without existence leaks; snapshot-body/credential/
path redaction assertions; corrupt-graph degradation. Existing plan query,
budget query, claim, lifecycle, DAG, scheduler and assembly suites remain
regression coverage.
