# Workspace Failure Retention (F-007)

## Contract

`createWorkspaceRetentionService` preserves an already managed workspace for
`authentication_failed`, `rate_limited`, `protocol_error`, `execution_error`,
`verification_failed`, `timed_out`, `cancelled`, `partial`, `approval_waiting`
and `interrupted`. It has no filesystem deletion or worktree removal dependency.
Its SQLite adapter reuses the existing workspace operations, Attempt CAS,
command receipts, artifacts and three-resource occupancy group.

The caller supplies the current Project/Run/Task/Attempt identity, operation ID,
workspace ID/revision, reason and existing artifact references. Identity includes
owner, hostInstanceId and executionVersion. The current Task execution version,
latest workspace writer and all outstanding workspace operations are checked
before admission. A new writer or owner cannot be finalized by a late caller.

A short transaction saves the retention intent. Process stopping and evidence
publication run outside SQLite transactions. The result transaction checks the
workspace/operation/Attempt revisions and exact resource snapshot again, records
the evidence on the Attempt, and atomically saves the retention result and either
releases or quarantines occupancy. It does not change Task acceptance, rework
counters, Feature completion or the existing Attempt outcome.

## Stop And Reuse Conclusions

- `not_started`: no Runtime launch authorization, start time or process identity,
  preflight stage, and stopped checkpoints for every recorded preparation process.
  Only the existing safe-unstarted resource release primitive is used.
- `confirmed`: the trusted stop verifier confirms the entire controlled process
  group and its finalization callback succeeds; its opaque token must still match
  the exact resource snapshot. Alternatively, a durable applied lifecycle receipt
  proves that result persistence and release already happened. Missing leases alone
  are never stop evidence.
- `unknown`: missing process/checkpoint evidence or an unconfirmed stop keeps the
  workspace and occupancy quarantined. Expiry, Runtime completion, cancellation
  intent, parent exit and failed PID probes cannot independently authorize release.

A safe stop leaves the directory and branch retained. `reusable` additionally
requires an ended, terminal Attempt; a stopped verifying/preparing Attempt is not
reusable. This is not sufficient authorization to prepare again: the existing
preparation service must still verify prior writers, current Git/HEAD/path identity,
content, authorization and resource gates. Retention does not implement a Run
resume controller, Runtime/Verifier, cleanup eligibility or destructive operations.

## Recovery And Queries

Operation results reference the input evidence and published retention artifact.
The artifact records the reason, identity, stop classification, preparation stop
facts and occupied resources. The result command receipt records reason, stop,
retained/isolated conclusion, evidence reference and reusable flag. Existing
workspace/operation/receipt and Artifact readers remain the query authority.

An identical operation replay returns its original terminal result receipt without
new events, artifacts or release. Changed input using that ID conflicts. A blocked
unknown-stop operation is immutable; a new operation with the current revision can
reconcile newly available trusted stop evidence. A pending intent after publication,
process or result-storage failure can be retried after SQLite reopen. Failures
retain files and occupancy, attempting quarantine only while the original CAS is
still current; a late failure cannot quarantine another execution's resources.
Unrecoverable storage unavailability is surfaced, never interpreted as release.

## Verification

`test/p03-5-workspace-retention.test.ts` covers all reasons with byte-for-byte
tracked/untracked/ignored preservation and unchanged Git refs; SQLite reopen,
missing preparation checkpoints, lifecycle release evidence, opaque stop tokens,
publication/result-transaction/supervisor faults, stale owner/host/version,
Attempt revision races, immutable replays and a subsequent workspace writer.
On macOS a real supervised parent exits while its child continues writing;
retention isolates the group, denies preparation/deletion and releases occupancy
only after trusted whole-group stopping. Test teardown stops its own process
resources; product retention never removes the user's directory.
