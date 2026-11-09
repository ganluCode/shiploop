# P03-6 Work Session Persistence Contract

## Baseline and Scope

F-006 extends the delivered P03-5 tip, whose latest SQLite migration is v19.
Migration v20 is appended; v1-v19 SQL and checksums are frozen. This increment
supplies the minimal work-session persistence association between a Runtime
execution and its Attempt, plus execution diagnostics metadata. Runtime launch,
lifecycle notification wiring, recovery, SessionRecorder, chat turns,
session_messages and verifier flows remain separate increments. Runtime/Fake
adapters gain no database maintenance capability. Task passed, Feature
completed and every existing budget semantic are unchanged. No configuration
or plan version table is introduced.

## Records

`WorkSessionRecord` and its validators are exported from
`ports/work-session.ts`. `createSqliteWorkSessionStore(session, { nowUtcMs })`
is the SQLite adapter in `adapters/sqlite/work-session-store.ts`. It exposes
`getWorkSession(projectId, sessionId)`, `getAttemptWorkSession(projectId,
attemptId)`, `createWorkSession(input)` and `applyWorkSessionProgress(input)`,
plus `*InTransaction` variants that compose inside an existing
`createSqliteAtomicCommandStore` transaction so a Session, the Attempt
executionStage/binding, the sanitized state event and any applicable command
receipt commit or roll back atomically.

A top-level work Session uniquely binds one same-project active Attempt
(`sessions_attempt_unique` partial unique index; the Attempt side
`attempts.session_id` is set-once and already unique). The readable record
carries the actual runtime, adapterVersion, providerSessionId, inputRef copied
from the Attempt input snapshot, executionStage, resultRef, lastActivityAt and
the lifecycle timestamps. `kind` vocabulary (`work`, `chat`) and
parent/attempt shape are frozen by `sessions_lifecycle_shape_check`; this
increment only creates top-level `work` rows. Status distinguishes
reserved (launch reservation), started (actually started), ended (execution
ended; started_at may stay null after a start failure) and stopped (stop
confirmed). `sessions_status_shape_check` enforces the timestamp/result shape
per status and monotonic time ordering.

Recording visibility uses minimal metadata only: `recording_watermark`
(monotonic, set-once direction enforced by trigger and by the store) and
`recording_gaps` (a bounded JSON array of gap summaries). `native_ref` is a
self-describing pointer (`schemaVersion` frozen at 1, `storageKind`,
`formatVersion`) into the runtime's independently single-writer native store;
path-like values are rejected by the port validator. Result and diagnostic
bodies always flow through ready same-project Artifacts; pending/missing
artifact references are rejected at both the port and DDL trigger levels.
Unknown or missing metrics stay null; nothing fabricates completion.

## Transactions and Rejection Semantics

Creation validates Attempt existence, project ownership, owner/host/
executionVersion identity, active Attempt status and the absence of a prior
binding, then inserts the reserved Session, CAS-binds `attempts.session_id`
and appends one `work.session.updated` state event (aggregate `session`,
carrying attempt/run/executionStage, sanitized payload) in one short
transaction. Progress applies only the lawful transitions
reserved→started, reserved→ended, started→ended and ended→stopped, plus
`activity` updates that refresh lastActivity/watermark/gaps without an event.
Stale expectedRevision, stale owner/host/version, wrong Attempt association,
invalid transitions, watermark regression and stopped-session writes fail
with typed `conflict`; cross-project access fails with `ownership`; missing
rows fail with `not_found`. Corrupt persisted JSON/versions fail closed with
sanitized `corrupt` errors that never echo stored content. Direct SQL writes
meet the same invariants through CHECK constraints, composite same-project
RESTRICT foreign keys and insert/update triggers (attempt input identity,
ready result artifact, immutable identity columns, set-once bound facts,
monotonic watermark/activity).

## Evidence

`test/modules/runtime/p03-6-work-session.test.ts` exercises real temporary SQLite databases:
v20 appended with frozen v1-v19 checksums; the sessions table without any
ChatTurn/session_messages/recording_manifests table group; port validators;
creation/progress happy paths with attempt linkage, stage advance, events and
null unknown metrics; cross-project, stale identity, duplicate, terminal,
invalid transition, revision, watermark and unready-reference rejections;
DDL-level integrity for direct SQL; atomic rollback and commit with an
applicable receipt; unchanged task/budget semantics; close/reopen
consistency; fail-closed corrupt reads; upgrades from empty, v5 and v19
databases with idempotent rerun and failed-v20 rollback/retry; and a
source-structure assertion that Runtime adapters/ports carry no database
maintenance capability.
