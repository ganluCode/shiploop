# P03-6 Work Session & Evidence Query Contract

F-011 extends the Core authorized query service with the Work Session, Runtime
result, stop evidence and minimal diagnostic artifact reads. Implementation:
`packages/core/src/ports/work-session-query.ts` (public shapes, frozen
vocabularies, settlement-evidence validation),
`packages/core/src/adapters/sqlite/work-session-query-store.ts` (read-only
narrow port over one DEFERRED consistent read transaction),
`packages/core/src/application/query-service.ts` (three authorized use cases),
wired through `packages/core/src/adapters/sqlite/query-store.ts` and
`packages/core/src/adapters/composition.ts`. Host transport and CLI exposure
are F-012/F-013; no HTTP, wire or scheduler behavior changes here.

## Query Surface

Three read-only operations (capability bit reuses `project.read`; ability
checks precede any read; cross-project/nonexistent targets fold to an
identical `not_found` with `details.reason = 'execution_entity_not_found'`):

| Operation | Input (strict unknown-key rejection) | Output |
|---|---|---|
| `execution.sessions.list` | `{ projectId, runId }` xor `{ projectId, taskId }`, `limit?`, `cursor?` | `WorkSessionListResult` (scope `work-session-list`) |
| `execution.session.get` | `{ projectId, attemptId }` | `WorkSessionDetailResult` (scope `work-session`) |
| `execution.session.evidence.get` | `{ projectId, attemptId, artifactId }` | `WorkSessionEvidenceContent` (scope `work-session-evidence`) |

- `execution.sessions.list` returns top-level Work Sessions of one Run or one
  Task in stable `(attempt number, session id)` keyset order. Only
  `kind = 'work'` sessions are listed — Chat sessions never mix in.
- `execution.session.get` returns the Attempt facts (status, executionStage,
  input identity `inputRef`/`inputDigest`, known exit/duration/usage — unknown
  stays `null`), the Session record (actual runtime/adapterVersion,
  executionStage, last activity, start/end/stop times, recording watermark and
  gaps), the retained occupancy audit, the bounded diagnostic evidence index
  and bounded stale-notification diagnostics, plus the parsed result evidence
  projection. A launch rejection before session creation yields
  `session: null` — never a fabricated session.
- `execution.session.evidence.get` returns the verified body of one ready
  diagnostic artifact. Membership is restricted to the controlled locator
  prefixes `sessions/<sessionId>/` and `attempts/<attemptId>/` of the same
  project and Attempt; unknown/cross-project/non-member/non-ready artifacts
  fold to the same `not_found` (no enumeration). Arbitrary file paths are
  never accepted — the input carries only stable identities.

## Persisted State Is the Only Authority

All content comes from the same consistent SQLite read view
(`WorkSessionQueryReadStore`) plus integrity-verified ready Artifact bodies
(the existing `ArtifactVerifier.readVerifiedContent`, hash/size rechecked,
bounded buffers: 1 MiB for settlement JSON, 8 MiB for diagnostic artifacts).
Closing and reopening the database yields identical results. Logger output,
in-memory handles and runtime process state are never consulted.

The result evidence is the Core-published `runtime-settlement` /
`runtime-not-started` JSON (schemaVersion 1), re-validated fail-closed by
`validateWorkSessionResultEvidence` at read time; any integrity/parse/shape
failure is `corrupt_state(evidence_incomplete)`, never degraded to "no
evidence".

## Known/Unknown, Synthetic Usage and Display Classification

- Unknown exit codes, durations, usage, watermarks and stop times stay `null`
  (never zero-filled). `executionStage` is shown as-is: `verifying` is not
  acceptance.
- `usage.basis` is preserved verbatim: synthetic usage is explicitly marked
  `synthetic` (in the result evidence and the evidence manifest) and is never
  booked into the Attempt usage summary (which stays `null` for synthetic-only
  runs).
- `deriveWorkSessionQueryState` maps persisted facts to a frozen display
  classification: `preparing` / `running` / `settling` /
  `awaiting_verification` / `execution_uncertain` / `failed` / `cancelled` /
  `succeeded`. Completed execution waiting for verification
  (`awaiting_verification`) and uncertain execution (`execution_uncertain`,
  Attempt `interrupted` / stop unconfirmed) are shown distinctly; a cancel
  acceptance is never shown as a confirmed stop or a success.

## Pagination and Cursors

The list reuses the plan-list discipline: default limit 50 / maximum 200,
opaque `plcur_v1_` cursors bound to the data root, project and parent entity.
`PlanListScope` gains `run-work-sessions` (parent Run) and
`task-work-sessions` (parent Task); existing scope fingerprints are unchanged.
Cursor payloads carry the composite key (`encodeExecutionListKey`:
`<attemptNumber>_<sessionId>`). Cursor decoding precedes any existence read:
cross-project/cross-parent/cross-root replays and tampered payloads are
`invalid_input(invalid_cursor)`, never treated as reading from the start.

## Redaction Discipline

Outputs contain only structured facts: no `inputSnapshot` bodies, no
credentials, no arbitrary file content and no absolute paths.
`providerSessionId` and `storage_locator` never enter the public shapes
(native identities and logical locators are internal diagnostic details).
Occupancy `resourceKey` values are normalized hash keys, not paths; the
supervised process identity is exposed only as a known/unknown boolean.
Diagnostic rows retain only the same-project Attempt link, the notification
digest, the fixed reason and the occurrence time.

## Read-Only Guarantee

The query surface owns no write primitive: it creates no Attempt, charges no
budget, renews no lease, triggers no cancel or execution and appends no event.
Directed tests cover the normal completed+stopped flow, launch rejection,
ended-pending-verification, cancellation, runtime timeout, recording gaps,
stale-result diagnostics and quarantined occupancy, and assert byte-identical
persisted tables (attempts, sessions, leases, batches, runs, events,
artifacts, diagnostics) before and after every query.

## Evidence

`test/modules/runtime/p03-6-work-session-query.test.ts` (14 cases): completed+stopped
list/detail/evidence reads with reopen-consistency and read-only snapshot
equality; launch rejection without a session; ended pending verification with
unconfirmed stop and quarantined occupancy; recording gaps from dropped
events; stale diagnostics; cancellation with accepted control facts; runtime
timeout; execution uncertain with quarantined occupancy; Chat exclusion;
cross-project/invisible/incapable folding with identical error faces; invalid
selectors/limits/cursors and cross-parent cursor replay; corrupt artifact
fail-closed; non-member/path-shaped evidence rejection; pure contract mapping
cases. Existing schedule/workspace/budget query, session, settlement,
supervision and assembly suites remain regression coverage.
