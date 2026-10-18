# P03-4 Work Resource Gates

## Scope

F-003 coordinates the existing v14 `workspace_leases` and P02
`baseline_occupancy`; no migration or historical checksum changes are needed.
It supplies resource primitives, not claimTask, scheduling, Runtime execution,
Task passing, or a new process manager. F-004 must acquire resources in the
same short `session.transactWrite` transaction as its claim and budget changes.
All resource writes require an existing transaction; they do not commit their
own transaction or perform filesystem/process I/O.

## Workspace Authority

`createWorkWorkspaceAuthority({ authorizedRoots })` is trusted assembly policy.
Explicit non-root authorization directories are canonicalized once. `verify`
runs outside the write transaction: it rejects relative/traversal/control-byte
paths, checks the real path against the authorized roots, and inspects the
repository identity and Git common directory. A workspace must be the root of
a Git working tree belonging to the bound repository, not a nested arbitrary
directory or another repository. Main worktrees and controlled linked
worktrees share repository identity but have distinct canonical workspace paths.

The immutable verification token is admitted by its issuing authority only;
JSON copies, caller resource keys and cross-project bindings are rejected.
Symlink aliases resolve to the same key. The workspace key hashes repository
identity and canonical path, after authorization-root validation. Overlapping
trusted roots therefore cannot create separate keys for the same workspace.
The transaction compares the current complete repository binding, including
its revision, with the verified binding. Consumers must use the token's
canonical path, not the original caller path, for subsequent workspace effects.
Filesystem checks are not an OS sandbox; future execution must retain the
existing controlled workspace and process boundary.

## Resource Transactions

`createSqliteWorkResourceAccess(session, { workspaceAuthority, nowUtcMs,
stopVerifier })` implements the public `WorkResourceAccess` port. Acquisition
requires a persisted preparing/preflight Attempt and the current Task execution
version. A single transaction reserves exactly three gates:

- `global:execution`, shared by every Task, Feature and Project;
- `project:<projectId>:work`;
- the verified canonical workspace key.

The lease owner is the Core Attempt ID; the caller's `owner` is separately
matched against the immutable Attempt owner. Host instance, Attempt version,
Task version, complete resource group, state, deadline and process identity
are checked before mutation. Partial/corrupt groups fail closed. Acquisition
and renewal synchronize the Attempt lease deadline with all three gates.
Only an exact still-held acquisition replay is idempotent; changing the
workspace or using an existing quarantined group is not a new acquisition.

Work acquisition checks the global baseline holder; baseline acquisition checks
all held or quarantined Work leases before its existing CAS. Both operations
use SQLite write transactions, including independent connections/processes,
so neither acquisition order permits double occupancy. Terminal or
stop-unconfirmed baseline metadata does not bypass a retained baseline holder.

`renewInTransaction` never revives quarantined/expired leases.
`expireInTransaction` quarantines every gate of an expired owner group, even
when that Task's fencing version has advanced. It does not delete any row or
start another execution. Expiry detected during renewal or launch admission
also persists quarantine. A restarted caller reads the retained SQLite gates
and must not interpret elapsed TTL as an available resource.

## Launch And Release

`beginLaunchInTransaction` durably binds an invocation ID before calling the
existing supervisor outside the transaction. Only held/live preflight attempts
receive authorization; a duplicate authorization is rejected. The supervisor
confirmation callback calls `confirmLaunchInTransaction` to persist its exact
`launchId`, PID, process group and start marker. It must acknowledge workload
release only after commit and only when the returned `authorized` is true.
Late registration records the identity for cleanup but returns false and
retains quarantine. Different process identities cannot overwrite a bound
identity. Legacy schema-v1 process records remain readable; new supervised
records use schema-v2 and cannot be downgraded to PID-only stop evidence.

`releaseUnstartedInTransaction` accepts only the persisted no-launch facts:
preflight stage, no invocation, no process identity and no start timestamp.
A durable launch authorization without a process registration is uncertain,
not proof that no process started, and retains occupancy.

`createWorkResourceStopVerifier({ process, finalize })` uses the existing
`CommandProcessPort.recoverStop` and a trusted cleanup finalizer outside the
write transaction. Only confirmed supervision plus completed finalization
issues an opaque in-memory token. Missing stop support, uncertain stop, failed
cleanup, plain booleans, Runtime returns and caller PID-absence assertions
cannot authorize release. `releaseStoppedInTransaction` compares the token's
entire detached occupancy snapshot against the current fenced state/revisions.
Renewal, quarantine, owner/version changes or token replay cannot delete new or
changed resources. No code marks Task/Feature/Run passed or resets/stashes the
repository as part of release.

## Verification

`test/modules/scheduling/p03-4-work-resources.test.ts` covers transactional rollback, canonical
aliases and identity attacks, binding revision drift, baseline competition in
both orders, true cross-process races between Tasks/Features/Projects and
baseline/Work, every fencing field, expiry/reopen, corrupt groups, launch
uncertainty and proof-based release. On macOS it also starts a real supervised
writer: the file continues growing after expiry, replacement acquisition is
rejected, and occupancy releases only after supervised stop and cleanup.
The test's finally block confirms process cleanup.
