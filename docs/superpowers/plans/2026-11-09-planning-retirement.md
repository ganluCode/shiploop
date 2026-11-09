# Failed Planner Retirement

Scope: single Agent, no candidate approval, coding, direct production SQL writes or worktree deletion. Initial investigation excluded real models; the subsequent user instruction explicitly authorized restarting only F01 Planner.

## Evidence and Design

- Retain existing timeout/baseline fixes and unrelated dirty changes.
- A failed Run can leave an open planning context. Filtering the lookup cannot bypass the partial unique index. Restore the lookup's index-consistent semantics and return an actionable retirement conflict.
- Add explicit `planning.retire` with project authorization, Feature revision, run/context identity and workspace revision in the same receipt transaction.
- This first entry consumes already reconciled durable stop facts: terminal planning Run and Attempts, stopped Session with complete recording, no retained workspace leases, retained workspace, no foreign writer or pending Git/workspace operations and matching dispatch ownership. Missing identity alone is never stop proof.
- It deliberately does not synthesize stop evidence, inspect/kill unknown processes or reconcile quarantined workspaces. Those must first pass existing trusted recovery; current history without a durable launch identity remains blocked. No external evidence collection occurs here, so no external-I/O fingerprint token is claimed.
- Preserve Run/Attempt/Session outcomes, candidate bodies and all budgets. Close only an undecided context as cancelled with a retirement reason; release exact-owned resources, dispatch slot/claim and retain the workspace in the same receipt transaction.
- A new planning start is separately authorized. Retirement must never launch it.

## Tasks

- [x] Reproduce the unique-constraint and CLI JSON failures with targeted tests.
- [x] Add a Core retirement command consuming reconciled stop facts inside its atomic CAS/receipt transaction.
- [x] Add HostClient, CLI and documentation, including structured errors and stable command replay.
- [x] Cover repeated commands, CAS and process uncertainty/active refusal, history retention and new planning authorization without Runtime execution.
- [x] Typecheck, boundary checks, targeted retirement/CLI tests (19) and build passed. Expanded regression is not green: response-loss cancellation remains cancelling; an existing runtime import contract also rejects production-command-tools. Graceful production restart was refused, so old Host remains alive.
- [x] Retire the actual historical planning context through the official command after independent pre-release evidence verification; restart only F01 Planner under the user's subsequent authorization.

## Production Checkpoint

- F01 remains blocked. Official CLI retirement command `b6299578-3a85-491a-94bb-24114a4d2195` returned HTTP 501 / unsupported from the old Host, without a business mutation.
- Graceful Host stop command `4ed57392-e6d9-408a-931e-176c79e1f4c6` returned resource_busy / quiesce_not_confirmed. Original PID 62351 remains alive and quiescing, with one pending historical Attempt. No kill or lock deletion was performed.
- The pending census includes workspace leases whose Session is not stopped. It is not evidence of a currently running model, nor proof of stopped processes.
- Missing proof: the historical Session's stop is unknown, recording incomplete, and no durable launch identity is available for process-tree verification. Do not infer pre-spawn timeout rejection from the generic runner_start_failed or absent timestamps.
- The new entry is deliberately narrower than full recovery of unknown quarantined writers. That recovery, and upgrading the still-live old Host, remain unresolved.

## Review Focus

- Never turn a failed Run into cancelled/succeeded or refund counters.
- Never use absent PID/startedAt alone, caller-provided flags, or quiescence as stop proof.
- Never release another Attempt's workspace or resources.
- Fence concurrent state changes after process/Git I/O, including a newer writer.
- Preserve the actual command ID and public reason on CLI and HTTP failures.

## Superseding Recovery Checkpoint (2026-11-09)

The earlier production checkpoint above records the initial block, not current status. Added a private pre-release proof based on protected bootstrap identity/hashes/timestamp and absence of the supervisor commit marker, two successful writer censuses, clean baseline inspection, and recovery fingerprint/CAS fencing. Separately verify the older immutable workspace owner's stopped Session and released occupancy. Preserve the failed Attempt/Session and recording gaps; no caller-controlled stop flag or budget refund.

The initial old Host was replaced only after checking all six Runs were terminal, exact kernel PID/birth/argv identity, no child/group members or Pi writers, and rechecking identity before signalling its fenced idle control-plane PID 62351. No lock, Session, worktree or production database file was manually edited/deleted. Successor Hosts stopped through the official graceful-stop interface.

Targeted verification: 27 retirement/CLI/pre-release tests passed, followed by the expanded 8-test pre-release suite after adding historical workspace-owner recovery; typecheck, 582-file boundary checks, build and built entry smoke passed. No full suite was run; the broader cancellation/import-contract failures noted above remain outside this validation.

Official retirement e49457d9-e8ac-46ab-ac3a-f0f242cf2b17 completed: old context cancelled; leases 3 to 0; workspace retained revision31; original Run failed and Batch counters unchanged. Official planning.start 36af5f2c-4146-425d-b36f-b7367f77b431 accepted new Run cdb241ed-631a-4013-8072-a1705ac33a1b. At 13:52:32 Asia/Shanghai its Attempt was executing and Pi Session started. No candidate decision or coding execution was authorized or started.

That Run failed at 13:53:56: candidate validation rejections were followed by grant_revoked because the heartbeat renewed only dispatch/slot occupancy, not Attempt/workspace leases. Added whole-resource renewal under the existing exact ownership fence; expired leases remain quarantined. Clarified JSON serialization and managed-document Artifact references in both prompt locales. Final 11 heartbeat/pre-release/older-owner tests, typecheck, boundaries and built smoke passed. Once the failed Session was confirmed stopped with complete recording and zero occupancy, ordinary retirement 18ca74fb-dda8-475a-a0d8-67a9ee14bcf1 completed. Restart 24f7b1ab-9fa3-449d-b5c0-b66add51258b accepted Run 2fb2f2ab-aab6-4df5-bb67-059e93dc16a7 at 14:10:21; subsequent completion must be checked separately.

Final observed result at 14:12:10 Asia/Shanghai: Run succeeded / planning_candidate_published; Attempt 74186dd7-1af7-40cd-9db1-4df07c42c4ea succeeded, duration108202ms. Candidate c92a0e56-1da3-495a-b4cf-707eaa3c664a is published / awaiting_approval with decision=null. Actual renewal beyond one minute was observed. No candidate approval or coding start occurred.
