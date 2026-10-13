# P03-3A Synthetic Recovery Fixtures

Scope: F-003. These offline fixtures exercise the existing ShipLoop recovery
contract. They do not implement or verify Pi Durable, a production Runtime,
Scheduler, SessionRecorder, managed Chat, OS process supervision or a sandbox.
No dependencies, migrations, authorization rules or budgets are changed.

## Entry Points

- `test/helpers/runtime-recovery/driver.ts`: `SyntheticRecoveryDriver` consumes
  `RuntimeRecoveryRequest` and calls the public validator/capability decision.
  `begin`, `execute`, `archive`, `history`, `events`, `usage`, `cancel` and
  `acceptResult` provide scripted, synchronous fault boundaries.
- `test/helpers/runtime-recovery/recording.ts`: `SyntheticEventRecorder` records
  native identities and delivery watermarks; `SyntheticUsageLedger` explains
  explicit counters, history baselines and disjoint usage scopes.
- `test/helpers/runtime-recovery/writer-child.ts`: a bounded, credential-free
  child process attempts the same real filesystem writer lock.
- `test/p03-3a-recovery-driver.test.ts` and
  `test/p03-3a-recovery-recording.test.ts`: executable acceptance examples.

Run focused coverage with:

```sh
npm test -- test/p03-3a-recovery-driver.test.ts test/p03-3a-recovery-recording.test.ts
```

Existing source/permission checks remain covered by
`test/p03-3a-runtime-recovery-assembly.test.ts`; request/capability semantics by
`test/p03-3a-runtime-recovery.test.ts`. These remain separate from the synthetic
executor so its files are not mistaken for trusted Core Artifact storage.

## Recovery And Effects

Each sandbox owns `native/`, immutable content-addressed `artifacts/`, a real
`effects.jsonl`, and independent event recording files. Client requests contain
Artifact IDs, never native paths. The fixture resolves IDs under its own root,
verifies archive digests, source identity and checkpoint membership, and writes
only a new invocation branch. Repeated invocations must match the entire request;
request/tool identity reuse with a different payload fails.

The known append tool writes a native session/request/tool receipt in the same
JSONL record as its effect. Its explicit reconciliation rule can distinguish an
absent effect from an existing matching effect; repeated or checkpoint-restored
calls do not append that effect again. Equal payloads with different identities
are independent effects. Missing or contradictory confirmed receipts, and
unidentifiable pending effects, produce `needs_reconciliation` and quarantine.
This rule is specific to this controlled tool, not an exactly-once guarantee for
shell, Git, arbitrary files or remote APIs.

Interruption is injected before the tool, after the effect but before native
confirmation, or during event delivery. These are deterministic control-flow
cuts, not actual SDK checkpoints, SIGKILL tests or power-loss durability tests.
Conversation and checkpoint capability choices share the common protocol while
remaining independently negotiable. History-readable descriptors cannot satisfy
required continuation/checkpoint recovery.

An exclusive `wx` lock rejects both a second fixture and a real child writer.
Cancel acceptance and stream interruption retain that lock and return no stopped
proof. Restart requires explicit synthetic `confirmed` input and refuses an
actually held source lock. `close` only cleans this fixture's resources; it does
not prove an OS tool tree stopped. Interrupted/cancelled invocation state survives
reopen. Recovery uses a new invocation/Attempt, preserves the source bytes, and
requires a fresh reply before accepting a Runtime result. Old identity/version,
late cancellation results and duplicate terminal results are diagnostic-only.
There is no Task-passed output or Core business-state mutation.

## Recording And Usage

Events deduplicate by native session/event identity, never text or delivery
sequence. Distinct native events with identical bodies remain distinct. Complete
rows are appended and fsynced before advancing the watermark. Reopen acknowledges
only a valid complete prefix; a torn tail remains intact and blocks further
append. Conflicting native identities preserve the old event and persist a
partial-coverage marker. Missing identity records are retained, not guessed away,
and mark coverage partial. Complete means only the explicitly supplied final
sequence and declared fixture range, not all SDK audit history.

Usage identities include native session and historical/current phase. Every
counter declares a scope and the disjoint leaf calls it covers. Incremental
samples add once; cumulative snapshots replace the counter after subtracting an
explicit historical baseline (including explicit 0 for a new scope). Historical
records never count as new consumption. Mixing modes, changing scope/baseline,
regressing cumulative counters, overlapping parent/child scopes, conflicting
identities and overflow are excluded and expose partial coverage. With no valid
current usage the total is null/unknown, not zero. Missing identity, scope, mode,
phase, baseline or token fields are never inferred from text or ordering.

The scripted 7-token reply cost is synthetic data, not observed provider usage.
The usage ledger is a replay-contract fixture, not persistent Core accounting;
production Recorder and budget integration remain later work. Event/native
storage are separate files without any cross-store transaction claim.
