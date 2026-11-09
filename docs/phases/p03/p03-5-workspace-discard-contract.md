# Manual Workspace Discard Preview And Confirm (F-010)

## Contract

`createWorkspaceDiscardService` implements an independent, human-driven
discard of a managed Feature worktree as two explicit operations:

1. `preview` — a read-only, bounded, capability-gated description of exactly
   what would be destroyed and what would be preserved. It never deletes
   anything, never takes the Git lock, and is never triggered automatically
   by cleanup/retention/failure flows.
2. `confirm` — a separately authorized destructive operation that is bound
   to one preview (digest + expiry), the current workspace revision, the
   worktree HEAD and the tracked/untracked/ignored content digests, and an
   explicit scope (`worktree_only`). It only ever runs
   `git worktree remove --force <registered path>` against the registered
   managed worktree directory. It never deletes the source repository, never
   deletes the Feature branch or any commit, never deletes audit records,
   and its authorization is not reusable by the F-008/F-009 automatic
   cleanup path (and vice versa): the operation kind `discard` is distinct
   from `cleanup` in the schema, the receipts and the audit events.

## Preview

Preview requires the `workspace.discard` capability plus project visibility.
It loads the managed workspace and repository binding, runs the F-005
inspector (HEAD commit, tracked/untracked/ignored digests), and returns a
preview object containing:

- workspace id, branch, base commit, status, revision and the binding
  revision it was observed at;
- `headCommit`, `codeDigest`, `ignoredDigest` and a bounded content listing
  (`maxPreviewEntries`, default 256) with per-kind counts and a `truncated`
  flag — entries are workspace-relative paths only; absolute managed/source
  paths never appear in the preview;
- an `impact` section: `irreversible: true`, counts of uncommitted tracked
  changes / untracked / ignored files that would be discarded, and
  `preserves: [source_repository, feature_branch, committed_work, audit_records]`;
- `blockers` — current structural blockers (status not discardable, held
  occupancy, missing stop evidence, unfinished workspace operation) are
  surfaced honestly instead of being hidden;
- `observedAtUtcMs` / `expiresAtUtcMs` (default TTL 300 s) and
  `previewDigest = sha256(stableStringify({projectId, featureId, workspaceId,
  branch, workspaceRevision, headCommit, codeDigest, ignoredDigest,
  expiresAtUtcMs}))`.

The preview is persisted as a `workspace_evidence` artifact before it is
returned (`evidenceRef`); the confirmation must carry that reference.

## Confirm Gates

`confirm` requires the same capability and visibility, and validates the
payload deeply (workspace id, operation id, expected revision, preview
binding, evidence refs). A new discard intent is registered only when all
gates pass inside one short transaction (`Workspace.discard.intent`):

- the workspace exists in this Feature with the expected id and its status
  is `ready` or `retained` (quarantined/preparing/cleaned refuse);
- the expected workspace revision matches the current revision and the
  preview's `workspaceRevision`;
- the preview has not expired and the recomputed `previewDigest` (over the
  current branch + claimed binding) equals the claimed digest — a forged or
  mismatched digest refuses before any write;
- occupancy is fully released (no leases for the target Attempt and no
  other execution holds any lease);
- durable stop evidence exists: an applied lifecycle receipt with
  `resultSaved && stopConfirmed`, a succeeded `retain` operation (which
  itself required a verified stop), or a never-started Attempt whose
  preparation processes all have stop receipts;
- no other workspace operation is pending for this workspace.

The user receipt (real `principalId` + `commandId`) is the idempotency
anchor of the `discard` operation: identical replays return the stored
terminal outcome, and a different subject or digest reusing the operation
identity refuses without any deletion.

## Deletion Protocol

After registration the service acquires the Git public-metadata lock and
re-verifies everything inside it before deleting:

1. fencing (`assertCurrent`) — owner identity, revisions, pending state —
   is re-checked across every await boundary;
2. the source repository state (branch ref still points at the recorded
   base/branch, index/HEAD unchanged) and the worktree directory identity
   (registered path, correct `gitdir` back-pointer, inside the authorized
   roots) are verified;
3. the current HEAD/code/ignored digests are recomputed and compared with
   the preview binding — any content change (`head_or_digest_changed` /
   `workspace_contents_changed`) refuses with zero deletion;
4. `recheckAuthorization` re-runs the full gate set (including preview
   expiry and occupancy) immediately before the mutating Git command;
5. only then `git worktree remove --force <registered path>` runs — a
   single `--force`, never `-f -f`, never `rm -rf`, never any unbounded
   recursive delete; a locked worktree is refused by Git itself.

Process checkpoints (`core-workspace-discard-process/-stop`) bracket the
Git operation exactly like F-009 so a crash between "Git mutation started"
and "outcome persisted" is reconciled on the next entry: the removal state
is re-inspected (`removed` / `present` / `inconsistent_removal_state`), the
durable stop is re-verified via the injected verifier, and a completed
removal is finalized as `recovered: true` without replaying unknown
deletions. An inconsistent removal state blocks the operation and
quarantines the workspace.

## Outcomes And Audit

- success → operation `succeeded`, workspace status `cleaned` (directory
  provably gone, audit retained) with the removed HEAD/digests recorded;
- refused (gate/content/stop) → operation `failed`, workspace restored to
  its prior status, zero deletion, structured `reason` in the result;
- uncertain stop or inconsistent state → operation `blocked`, workspace
  `quarantined`, occupancy quarantined for operator intervention;
- every outcome persists an independent impact receipt: the user-facing
  result artifact (`workspace_evidence`) records the preview binding, the
  verified state, the outcome, and the removed HEAD/digests; internal
  checkpoint/result receipts use `core-workspace-discard-*` principals and
  never impersonate the user command.

Neither the preview nor the confirmation performs arbitrary directory
deletion, branch rollback or project deletion; there is no API for them.
