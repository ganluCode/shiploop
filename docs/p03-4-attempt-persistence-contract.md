# P03-4 Attempt Persistence Contract

## Baseline and Scope

F-001 extends the delivered P03-3/P03-3A tip `d9dd2c3`, whose latest SQLite
migration is v13. Migration v14 is appended; v1-v13 SQL and checksums are frozen.
This increment supplies persistent records, strict validators and consistent
reads only. Claiming, resource coordination with baseline occupancy, renewal,
release, state CAS, scheduling, Runtime, SessionRecorder and Verifier remain
separate increments. No SDK or Durable identity is a Core primary key.

## Records

`AttemptRecord` and `WorkspaceLeaseRecord` are exported from the Core ports.
`createSqliteAttemptAccess(session)` is the internal SQLite read adapter:
`getAttempt(projectId, attemptId)`, `listTaskAttempts(projectId, taskId)` and
`listWorkspaceLeases(projectId)`. Reads use a consistent transaction, or reuse
an existing caller transaction. History sorts by number/id and occupancy by
resourceKey/id. Cross-project reads fail with `ownership`; missing identities
fail with `not_found`. Invalid persisted JSON/versions fail with sanitized
`corrupt` errors, not partial/default records.

Attempts hold Project/Feature/Run/Task identities, a positive task-local number,
owner, Host identity, executionVersion and lease deadline. Task executionVersion
starts at zero for existing rows; later claiming code must advance it atomically.
Session and invocation identities are independently nullable and unique when
bound. A bound identity cannot be rewritten. No SDK requestId is stored or used
to deduplicate attempts. Owner/Host/version and input/business identities are
immutable for an existing attempt.

`inputSnapshot` is the existing `PreparedExecutionInputGroup`: frozen identity,
approval/policy and strategy/permission digests, estimates and immutable Artifact
references. No prompt body, inline content, credentials or arbitrary extra
fields are accepted by its runtime validator. Snapshot size uses the existing
execution snapshot limit; all counts must be safe integers. SQLite validates
same-project ready Artifact identities/metadata for the prepared group and
required inputs on insert, in addition to composite Run/Task/Feature links.

Unknown start/end/duration, exit information and usage remain null. Known usage
may be partial; cost is integer micros with an uppercase three-letter currency.
Attempt status and execution stage enums are defined in `ports/attempt-store.ts`.
Only preparing/executing/verifying consume the unique active slot per Task,
regardless of lease expiry. Failed/interrupted history can remain alongside a
new attempt without reusing a number.

Resource keys are globally unique. Occupancy explicitly distinguishes held
from quarantined and retains optional versioned process identity. Expiry alone
never deletes occupancy or unlocks a Task. Resource key derivation, fencing and
proof-based release belong to F-003/F-004/F-005, not this read-only adapter.

## Evidence

`test/p03-4-attempt-schema.test.ts` exercises real temporary SQLite databases,
complete field mapping/reopening, corrupt and external JSON rejection,
independent Core identities, uniqueness and cross-project/cross-feature
constraints, upgrades from v0/v5/v13, cumulative predecessor budget preservation,
idempotent migrations and failed-v14 rollback/retry. Schema metadata and prior
budget/runtime-start/outcome/rollback suites cover integration regression.
