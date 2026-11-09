# Workspace Safe Cleanup (F-009)

## Contract

`createWorkspaceCleanerService` removes a managed Feature worktree with the
non-force `git worktree remove` only after the F-008 gate decision reported
`cleanable`. It preserves the Feature branch and commits, workspace history,
Attempts, Artifacts and operation audit. It never force-deletes, never
recursively deletes directories, never cleans the source repository and never
touches Task/Attempt/Feature business outcomes.

The caller supplies the current Project/Run/Task/Attempt identity, operation
ID, workspace ID/revision, the full F-008 decision, the HEAD/code/ignored
digest summary the decision was based on, and existing artifact references.

## Gates

A new cleanup intent is registered only when all gates pass in the same short
transaction (`Workspace.clean.intent`):

- the decision outcome is `cleanable` with all seven gates passed, its
  `checkedAtUtcMs` is neither in the future nor older than
  `maxDecisionAgeMs` (default 120 s);
- the Attempt ended with exit code 0 (`verifying`/`succeeded`);
- a durable applied lifecycle receipt proves result persistence and confirmed
  stop (`previouslyReleased`); occupancy is fully released and no other
  execution holds any lease;
- the Feature plan approval is still valid and the Task is not manually
  blocked;
- workspace status is `ready`/`retained`, the expected revision matches, no
  other workspace operation is pending and the latest workspace writer is
  this Attempt.

The gates are re-run via `recheckAuthorization` after the pre-delete
verification checkpoint and immediately before the mutating Git command;
a refusal there finishes the operation as `failed` with the structured reason
and keeps the directory. Fencing (`assertCurrent`) re-checks owner, revisions,
writer and pending state across every await boundary.

## Deletion And Protection

The fs cleaner re-verifies the canonical path, directory identity, Git
registration and a fresh bounded inspection against the authorized
HEAD/code/ignored digests; any new tracked/untracked/ignored-protected
content, external HEAD move or path change refuses before deletion. It records
a durable `verified` checkpoint (digests, directory identity, source
HEAD/refs/index/content digests) before allowing the mutating command, whose
supervised process identity is persisted before launch and whose confirmed
stop is persisted after. Source repository HEAD, refs, index bytes and dirty
content are compared before and after; the managed branch must still resolve
to the removed HEAD.

Git refusal (non-force remove exits non-zero) finishes `failed` with
`git_removal_refused`; an unconfirmed stop finishes `blocked`, quarantines the
workspace and keeps the pending facts auditable. Directory/registration
disagreement is diagnosed as `inconsistent_removal_state` instead of guessed.

## Recovery And Replay

If the deletion happened but the receipt was never committed, the pending
intent stays; a retry with the same input reconciles the verified checkpoint
with the actual Git/file state, re-verifies branch and source, publishes
evidence and commits the result as `recovered` — without re-deleting and
without claiming success when the state disagrees. An identical finished
command replays its original operation and receipt without new events; a
changed input with the same operation ID conflicts. Git I/O and evidence
publication never run inside SQLite transactions; the short Git metadata lock
is held from re-verification through the fenced receipt commit.
