# P03-3 Work accepted Receipt Contract (F-003)

## Scope

F-002 left `command_receipts.operation_id` referencing only `baseline_operations`
in the P02 v5 receipt layout. F-003 appends SQLite migration v10 without changing
v1..v9 SQL/checksums. It extends the existing receipt factory, persistence and
query path; it does not implement execution preview, start, scheduling or Runtime.

## Identity and Association

- Work accepted receipts use `schemaVersion: 6`, `operation: 'execution.start'`,
  `status: 'accepted'`, project scope and UUID `batchId`/`runId`.
- `operationId === batchId`: the Batch is the explicit authorization identity;
  `runId` identifies the initial dispatch within it. No synthetic baseline is
  created. Accepted does not mean execution has completed.
- `receipt_version` defaults to 5 for migrated and legacy SQL rows. Generated
  `baseline_operation_id` equals `operation_id` only for v5 rows, preserving the
  baseline foreign key; a composite baseline FK also enforces project ownership.
- Work uses real composite FKs from `(project_id, batch_id)` to execution batches
  and `(project_id, batch_id, run_id)` to runs. Missing parents, cross-project
  links and a Run from another Batch fail even when inserted with direct SQL.
  Parent deletion is restricted. CHECK constraints reject version/operation/scope
  mismatches, partial associations and a different public operation identity.
- The existing atomic command transaction can create Batch/Run and save the
  receipt together. Any subsequent failure rolls back all three rows. The store
  rejects invalid associations with a bounded validation error before insertion.
- `(principal_id, command_id)`, `operation_id` and result references retain their
  unique constraints. Duplicate command/operation identities map to storage
  conflicts and then the existing public `conflict` error mapping.

## Compatibility

- Baseline accepted, completed and rejected receipts stay v5 with the same
  identity, result/error, digest, opaque result reference and replay semantics.
  Migration copies every existing column; real v5/v9 databases are tested.
- V5 wire validation remains strict: `batchId`/`runId` are unknown fields, and
  `execution.start` is not a v5 command operation. Completed/rejected factories
  remain v5-only. V6 is supported only as the explicit Work accepted shape, with
  no result/resultRef/error. Stored replayed markers must remain false.
- HostClient allows the v6 Work accepted discriminator and validates its exact
  shape plus expected command ID, operation and request digest. Other non-v5
  discriminators retain `unsupported_schema_version`; malformed Work responses
  fail with `response_malformed`. Older clients reject v6 instead of silently
  interpreting it as v5.
- Envelope/wire handshake version, advertised capabilities and command operation
  whitelist stay unchanged. Submitting `execution.start` remains unsupported;
  replay reauthorization reports `unsupported` / `work_command_not_wired` until
  the later controller task explicitly wires that capability.
- Existing receipt queries use the trusted principal and project visibility
  policy. Corrupt persisted versions/associations fail with `corrupt_state`.
  No request-digest algorithm or authentication mechanism is replaced.

## Verification

`test/p03-3-work-command-receipts.test.ts` covers real SQLite persistence and
receipt queries, legacy upgrades/replay, raw FK/CHECK/uniqueness failures,
transaction and migration rollback/retry, public error mapping, factory
boundaries, persisted corruption and HostClient compatibility. The schema
cross-check uses `table_xinfo` to verify generated-column mode as well as columns,
indexes and foreign keys. Historical schema suites explicitly target v9 where
column snapshots or a v10 unsupported-version probe require that old contract.

F-003 uses full verification (`npm run verify`: all tests, typecheck and build),
plus the existing boundary scan. Acceptance migration manifests are updated to
v1..v10 without changing their protocol versions or weakening their assertions.
