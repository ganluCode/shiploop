# P03-4 Attempt Lifecycle Contract

## Scope

F-005 continues F-004's committed claim receipt. It adds a trusted synchronous
Core/Runner ingress, `AttemptLifecycleStore.apply`, backed by
`createSqliteAttemptLifecycleStore`. It owns one short SQLite write transaction;
no Runtime, Git, filesystem, process or network work occurs inside it. The
Scheduler, Runtime assembly, Verifier, commit and unblock/resume loops remain
separate increments. A lifecycle notification is not an acceptance command.

## Identity and Transitions

Every notification carries `projectId`, `runId`, `taskId`, `attemptId`, `owner`,
`hostInstanceId`, `executionVersion` and a stable `notificationId`. Runtime
validation rejects unknown fields and unsupported kinds. Before any business
write, the transaction compares the persisted Attempt identity, current Task
executionVersion, running Task and allowed source status. The final Attempt
UPDATE also fences owner/Host/version/revision and current Task executionVersion.

Supported transitions are:

- `executing`: preparing/runtime to executing/runtime, with an admitted invocation,
  confirmed supervised process identity and three live held resource gates.
- `preparation_failed`: preparing to failed, retaining the current executionStage,
  a bounded errorKind (`configuration`, `workspace`, `input`) and a same-project
  ready evidence Artifact reference in `diagnosticRef`.
- `runtime_completed`: executing to verifying/verification for exitCode 0, or
  failed/runtime for a nonzero exit. Exit code, known duration, evidence reference
  and execution end time are persisted. In verifying, `endedAtUtcMs` denotes the
  ended Runtime execution, not successful verification or Task acceptance.

Successful completion leaves Task running and returns
`waitingFor: verification_not_assembled`, or `approval` when current approval,
policy, input business identity or manual blocking no longer permits acceptance.
Failure leaves Task failed. No transition writes Task passed, Feature completed,
Run succeeded, codeRef, Session identity or fabricated usage. No automatic retry
or new Attempt is created.

## Result and Resource Semantics

The immutable receipt separately reports `runtimeCompleted`, `resultSaved` and
`stopConfirmed`; these are not synonyms. An exitCode 0 without trusted stop and
finalization proof saves the result and quarantines occupancy. An opaque token
from the existing WorkResourceStopVerifier can release the same fenced resource
snapshot atomically with result persistence. A forged/stale token rejects the
whole transaction. Stop verification and finalization happen outside SQLite.

Preparation failure safely releases only persisted preflight/no-invocation/
no-start/no-process facts. Any uncertain launch remains quarantined. The existing
trusted infrastructure reclassification refunds only the code-attempt charge;
Task/Run/Batch cumulative Attempt counts and Runtime start charges are never
refunded. Uncertainty and waiting do not consume an additional code attempt.

## Replay and Diagnostics

Migration v17 appends immutable `attempt_notifications` receipts and bounded,
append-only `attempt_notification_diagnostics`; v1-v16 SQL/checksums are unchanged.
Receipts deduplicate `(attemptId, notificationId)` with a canonical SHA-256
request digest. An exact applied replay returns its historical receipt without
reapplying state, events, counts, release or renewal. A historical receipt is
not new authority to start work and is not a replacement for current state reads.
A reused notification ID with different content is diagnosed, not overwritten.

Stale owner/Host/version/Task/Run, crossed results and new notifications against
terminal or disallowed states produce no business writes. A diagnostic retains
only the known same-project Attempt link, timestamp, fixed reason and digest;
it does not retain supplied identifiers, messages, output, paths or credentials.
Unknown or foreign-project Attempts are ignored without creating a foreign link.
SQLite caps diagnostics at 32 per Attempt, deduplicates equal hashes and forbids
updates/deletes. Receipt JSON is bounded, strictly validated on replay, and each
legal transition contributes at most one receipt and one redacted Task event.
Events, Task/Attempt writes, receipt, reclassification and resource mutations
commit or roll back together.

## Manual Approval Protection

`task.approval.block` is the minimal add-only approval write command. It reuses
the existing `feature.plan.decide` capability, project authorization, current
planDigest identity rules, Task expectedRevision CAS, command replay and atomic
receipt/event machinery. Its payload is exactly `{ taskId, planDigest }`; callers
cannot submit an actor or arbitrary state. No new capability set or wire schema
is introduced. The command only sets manual_block, never clears it or changes
execution budgets. It works before or after a completion commit and never grants
acceptance or initiates resume.

Result application rereads approval decisions, current check-policy digest,
manual_block and the authoritative DAG/business snapshot in its write transaction.
It never clears manual_block. The existing DAG evaluator keeps blocked tasks and
their successors non-ready regardless of the two SQLite commit orders. Lifecycle
`executing` records an already confirmed start, not permission to release workload.

## Evidence

`test/modules/scheduling/p03-4-attempt-lifecycle.test.ts` covers identity fencing, crossed and terminal
notifications, bounded sanitized diagnostics, persisted replay, preparation
failure, uncertain launch, independent stopped/result/runtime facts, forged stop
proof, result/evidence validation, rollback and both manual-block/result commit
orders using independent SQLite connections. It also exercises the authorized
block command, stale digest/revision, denied capability, receipt rollback/replay
and current check-policy changes. `test/modules/scheduling/p03-4-attempt-lifecycle-schema.test.ts`
covers v16 upgrade, checksum preservation, failed-v17 rollback/retry, reopen and
idempotent migration. Existing claim/resource/DAG/budget/protocol suites remain
regression coverage.
