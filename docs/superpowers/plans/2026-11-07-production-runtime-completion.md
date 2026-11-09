# Production Runtime Completion Implementation Plan

> Execution: single Agent in this session. No external model calls, subagents, commits or push during validation.

**Goal:** Complete the approved production Pi loop and connect Feature repair, automatic push, configurable retries and Feishu notifications.

**Architecture:** Core owns authorization, durable identities, verification and delivery. Host supplies supervised Pi tools and network adapters. Model output cannot update official metadata or approve results.

**Spec:** ../specs/2026-11-07-production-pi-loop-design.md plus the user's six-item requirements.

## Constraints

- Preserve all existing uncommitted changes. No real model/Feishu sends during offline tests.
- Actual push requires explicit auto_push configuration and a verified Task/Feature boundary; no force push.
- Default repair strategy high, maximum three repairs; every repair must stop before re-verification.
- Retry maximum 0..10 consecutive retries, successful complete responses reset the streak; cumulative counters remain.
- Backoff base 1 second means 2,3,4 seconds up to 60 seconds. Stop/recording/budget evidence cannot be bypassed.
- Trusted project mode is not an OS sandbox. Shell credentials and Host tokens must remain separate.

## Review Focus

- Runner dies while Shell descendants remain: Host must retain ownership and clean up or quarantine.
- External command succeeds but its acknowledgement is lost: reconcile the same identity, never blindly repeat.
- Repair modifies code: only fresh verification evidence may authorize delivery.
- Push fails after local commit: retain commit, report delivery failure; never redo completed coding.
- Notification errors never change business success or cause task replay.

## Implementation Tasks

1. [x] Add validated production controls and consecutive retry mode; test exact bounds, successful reset, cumulative counters, fallback switches and legacy policy compatibility.
2. [x] Extract production file tools; add bounded rg search and exact patch with digest checks; test stale/ambiguous edits and path boundaries.
3. [x] Connect Host-owned supervised command tools with durable identity, cancellation, timeout and bounded/redacted output; test child-process failure/cleanup.
4. [x] Load project AGENTS.md and explicitly selected Skills with actual manifests and bounded content; no global discovery.
5. [x] Connect the restricted planning submission channel, identity/replay handling, revocation and end-to-end offline planning.
6. [x] Connect Feature repair Runtime with persistent budgets, evidence and stop checks; high default, three repairs, explicit provider override; verify fresh checks after changes.
7. [x] Add controlled auto_push after verified local commits; persist/reconcile push outcomes and test temporary local remotes without network.
8. [x] Connect configurable Feishu hook through existing durable notification delivery, signing, bounded HTTP and event selection; localhost-only tests.
9. [x] Enable SDK Codemode explicitly with supervised tools and batching guidance; test tool availability and nested recording.
10. [x] Update docs/Skills/templates, run relevant regressions, type/boundary checks and build smoke; restart Host only if idle.

Each task starts with focused regression coverage and ends with recorded verification. Checkboxes reflect completed behavior, not only added configuration fields.
