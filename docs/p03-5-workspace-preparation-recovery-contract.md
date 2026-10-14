# Feature Worktree Preparation Recovery (F-006)

## Admission And Durable Checkpoints

`createWorkspacePreparationService` consumes the existing committed Run/claim
and live preflight resource identity. It rechecks Project/Task authorization,
owner/host/executionVersion, leases, repository binding, frozen baseCommit and
workspace/operation revisions. A previous Attempt must be terminal, ended and
have no remaining leases before a new Attempt can prepare the same workspace.
This is preparation reconciliation, not the P03-9 Run resume controller.

The original `prepare` operation is committed before filesystem/Git effects.
Immutable command receipts hold the additional recovery facts:

- `core-workspace-directory`: canonical directory device/inode/birthtime identity,
  keyed by the original preparation operation; committed before `git worktree add`.
- `core-workspace-process`: supervisor identity keyed by launchId, committed in
  the existing process-confirmation callback before release of mutating Git argv.
- `core-workspace-stop`: the same identity after confirmation that the entire
  controlled process group has stopped.

Missing stop receipts require an explicitly injected trusted
`verifyPreparationStop` proof. Lease expiry, PID absence alone, parent exit or a
successful Git exit code are not sufficient. Without proof, occupancy remains
quarantined. An existing Git metadata claim is never automatically removed;
its existing explicit, ownership-checked recovery contract still applies.

## Reconciliation And HEAD Authority

An existing directory checkpoint permits only read-only reconciliation: realpath
and directory identity, Git registration, repository identity/common dir, branch,
HEAD and bounded content inspection must agree. No repeated mkdir, branch
creation, checkout, reset, stash, copying or worktree add is performed.

The expected HEAD is the managed workspace's last recorded HEAD (or its frozen
baseCommit before the first result). Trusted completed workspace operations can
record legitimate committed progress together with code/evidence references.
Merely being a descendant of baseCommit does not authorize an unexpected HEAD.
Raw inspector observations alone do not grant this authority.

Tracked/untracked/ignored progress is observed and retained. The current code
digest is recorded without changing the original baseline or operation input.
Evidence publication is followed by another read-only inspection; HEAD,
codeDigest and ignoredDigest must still agree before the fenced result commits.
The Git metadata lease is held through this result transaction, not through
Runtime execution or user approval.

## Results And Failure Boundaries

A pending operation after an interrupted Git side effect is completed using the
same operation ID only after checkpoint and actual-state reconciliation. A
successful operation is also inspected on every repeated call, including after
SQLite reopen. Its immutable result/receipt is preserved; a separate
`core-workspace-reuse` receipt references the fresh evidence and code digest.
A new authorized Attempt uses a new preparation operation with its own
owner/host/version/Run/Attempt association. The workspace's original preparation
identity stays immutable, as required by the existing SQLite schema. Admission
checks all historical workspace-operation writers, not just that first identity.

Missing intent/checkpoint, replaced directories, symlink escapes, wrong Git
registration/branch/HEAD, unconfirmed stop or revision conflicts refuse automatic
adoption. Uncertain I/O/persistence leaves intent, bytes and occupancy retained.
Late results cannot overwrite newer revisions, and late quarantine cannot alter
resources after workspace/operation revisions have advanced. Existing F-005
safe pre-creation failures retain their lifecycle behavior.

Preparation does not clear accumulated budgets, change passed Tasks, launch
Runtime or restore a native session. Evidence explicitly records
`runtimeRecovery: 'not_evaluated'`. Native archive references stay outside the
source repository; this service neither reads them for recovery nor copies an
open native SQLite database. Worktree reuse is not native-session resumability.

## Verification

`test/p03-5-workspace-preparation.test.ts` uses real Git, temporary filesystems
and SQLite, including close/reopen, receipt-transaction rollback, interruptions
after Git/inspection/before result, legal recorded commits/new Attempt bindings,
tracked/untracked/ignored byte retention, wrong branch/detached/unexpected HEAD,
replaced/foreign/symlink directories, missing stop evidence, active launch,
concurrent recovery/late fencing and changes during evidence publication.
An open native SQLite archive and an already passed Task remain untouched.

These are trusted-project checks, not a strong OS sandbox: unmanaged external
writers must be stopped. Filesystem observations cannot make hostile concurrent
mutation atomic with SQLite persistence.
