# P03-4 Atomic Task Claim Contract

## Scope

F-004 adds the synchronous internal `TaskClaimStore.claimTask` port and `createSqliteTaskClaimStore` adapter. It does not add a Host/CLI claim command, Scheduler, workspace preparation, Runtime invocation, result application, Verifier, automatic retry or restart recovery. These interfaces are internal source-level assembly surfaces, like the preceding DAG and Work resource adapters; default production assembly does not start work.

## Request and Committed Receipt

A request supplies a stable `claimKey`, Project/Run/Task identities, `owner`, `hostInstanceId`, expected Task revision/current `executionVersion`, a future lease deadline, a prepared immutable input group, and an opaque `VerifiedWorkWorkspace` from the same trusted workspace authority. Unknown keys, unsafe integers, malformed snapshots and forged workspace tokens are rejected at runtime. Session, invocation, SDK request and checkpoint identities are not claim keys or fences.

The authority performs repository/root/realpath verification before the write transaction. Within claim, `inspect` only validates the in-memory authority token; resource acquisition rechecks its repository binding and revision. The optional trusted permissions reader is synchronous and must perform no external I/O, matching the existing input-preparation contract.

`claimTask` owns its `BEGIN IMMEDIATE` write transaction. Calling inside any existing transaction is rejected: a released savepoint would not establish a committed receipt. The returned result contains `replayed` and an immutable receipt with:

- the frozen preparing/preflight Attempt, input snapshot and independent recovery identities;
- the parent Batch, Task revision, reservation ID and exact claimed event ID;
- global, project Work and canonical workspace lease records;
- cumulative Batch/Run/Task Attempt counts and Task code-attempt count.

The result is returned only after commit. Preparation or launch consumers must accept this committed result, never an advisory ready candidate, intermediate Attempt or transaction callback. `replayed: true` is historical evidence, not permission to prepare or launch a second invocation. Current launch eligibility still uses the existing Work resource fencing gate.

## Transaction Boundary

The transaction rereads the coherent DAG view and evaluates Project active status, Batch/Run control state and ownership, fixed coding scope, current approved plan/check policy, strategy and input identities, dependency pass evidence, manual blockers, cumulative budgets and existing global/baseline/Work occupancy. Advisory ready reads cannot authorize a claim. It additionally verifies the supplied prepared group's identities and every referenced ready Artifact's same-project identity, version, hash, size, locator and media type, plus the current trusted permissions face.

A single transaction then:

1. CAS-updates a pending, unblocked Task using expected revision and fence, sets running and increments executionVersion.
2. Inserts one preparing Attempt with incremented task-local number and null unknown execution facts.
3. Uses the existing budget reservation primitive to increment Task and parent Batch/Run cumulative Attempt counts.
4. Acquires the existing shared global slot, project Work gate and canonical workspace gate.
5. Appends `task.claimed` and persists the claim receipt.

Task status/fence, Attempt, all budgets, all leases, event and receipt commit together or all roll back. Resource and budget primitives execute in this same transaction, not separate commits. No filesystem, Git, network, process, workspace preparation or Runtime work occurs inside it. The permissions reader and workspace authority are trusted non-I/O dependencies.

`task.claimed` is a project-scoped Task aggregate event with only `{ "claimed": true }`; it does not publish paths, input bodies, credentials or budget details. The event append primitive now returns its own generated ID, rather than requiring a last-row lookup.

## Idempotency and Errors

SQLite v16 appends `task_claim_receipts`: the claim key is primary identity, the canonical normalized request has a SHA-256 digest, and the receipt has a same-project Attempt FK, unique Attempt index and JSON identity checks. Updates/deletes are forbidden. Previous v1-v15 SQL/checksums remain unchanged. Upgrade from populated v15 preserves all previous facts, leases, budgets and migration records; repeated upgrade does nothing and failed v16 DDL rolls back.

An identical request returns the original receipt even after reopen, state changes or lease expiration. It does not renew leases, recreate Attempts, debit budgets or append events. Reusing a key with different request identity returns `StorageError(kind='conflict', details.reason='claim_key_reused')`. Persisted receipts are validated again on read.

Other refusals use existing structured storage errors: validation errors, missing/corrupt views, conflict with `not_ready` and `eligibility`, `stale_task`, `resource_busy`, repository-binding conflicts or persistence-constraint conflicts. SQLite contention uses the session's finite busy timeout/retry policy; exhaustion returns `kind='busy'` with `attempts` and `busyTimeoutMs`. There is no infinite retry or claim-side automatic recovery.

## Budget and Recovery Boundary

Initial Attempt reservation is classified as code, reusing P03-3 semantics. A trusted Core infrastructure-failure classification can move it to infrastructure using the existing one-way reclassification primitive; cumulative total Attempt counts are never refunded. Claim neither reserves a Runtime start nor increments Runtime startup counters. Token/cost caps without an authoritative usage ledger remain fail-closed.

A replacement Attempt requires a legitimate pending Task, confirmed unstarted/stopped cleanup and a new claim key/current fence. It stays under the same Batch/Run cumulative budgets; exhausting either rejects further claims. Old owner/host/executionVersion identities cannot launch against the replacement's gates. Tests simulate trusted recovery facts only; F-004 does not implement a recovery service or F-005 result application.

## Verification

`test/modules/scheduling/p03-4-task-claim.test.ts` covers committed state, invalid inputs, permission/artifact identity changes, post-query eligibility drift, invalidated dependencies, busy exhaustion, reopen and expired-lease replay, receipt immutability, populated v15 preservation/checksum stability and failed v16 migration rollback. Real SQLite triggers inject faults after Task, Attempt, budget, resource, event and receipt writes. Ready/go child-process barriers cover same-Task, different-Task global-slot and identical-key idempotent races. Replacement tests preserve cumulative budgets, reject old fences and reject a third claim at the parent caps. Resource children and temporary storage are disposed in `finally`.

Feature-workspace verification records contain the actual full gate commands, exit codes, logs, scope and implementation commit. No `accept:p03` or downstream Runtime/Verifier acceptance is claimed.
