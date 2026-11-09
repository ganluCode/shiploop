# P03-3A Runtime Recovery Contract

Scope: F-001, pure ports and capability decisions only. This is a ShipLoop
contract, not a Pi SDK signature or a claim that Pi Durable supports recovery.
Design authority: `core-design/14-runtime-recovery-and-durable.md` (2026-10-13)
and `core-design/05-runtime-and-session-recording.md`.

## Verified Code Baseline

Inspected baseline: `743f11381f5e7069772a319f5ffc5a6bad15d078` (P03-3 F-014).
The recovery handoff identified the same HEAD and a clean worktree. At this
baseline:

- `ports/runtime-capabilities.ts` validates configuration compatibility only.
  `assessSettingsConfiguration` still reports `executable: false`.
- `adapters/composition.ts` assembles Core services, not a production Runtime.
- `ports/execution-store.ts` and its SQLite adapter provide Task-attempt and
  Runtime-start budget reservations. `RuntimeStartReservationRecord.startKey`
  identifies a budget reservation, not an SDK request or a running process.
- Migrations through v13 provide persistent execution budget/settlement facts;
  this task does not alter migrations, checksums, authorization or budget rules.
- RuntimeAdapter/registry, Work Runner, source-Artifact resolution, production
  SessionRecorder and managed Chat execution are not implemented by F-001.

Tests include the unchanged configuration catalog and P03-3 Runtime-start
reservation regression. Verification evidence is in the F-001 feature workspace
`tool-logs/`; the final log/exit result is recorded in `progress.md`.

## Public Names

`shiploop-core` exports the new `ports/runtime-recovery.ts` contract:

- `ExecutionIdentity`, `RuntimeRecoveryRequest`, `RuntimeRecoveryReference`,
  `RuntimeRecoverySelection`, `RuntimeRecoveryDecision`.
- `RuntimeRecoveryCapabilities`, `RuntimeRecoveryCapabilityEvidence`,
  `RuntimeRecoveryCapabilityName`, `RuntimeRecoveryCapabilityStatus`.
- `RUNTIME_RECOVERY_SCHEMA_VERSION = 1`, `RUNTIME_RECOVERY_CAPABILITY_NAMES`.
- `validateRuntimeRecoveryRequest`, `validateRuntimeRecoveryReference`,
  `validateRuntimeRecoveryCapabilities`, `decideRuntimeRecovery`.

`RuntimeRecoveryRequest` is the recovery-specific portion of a future execution
request. It does not yet contain prompts, cwd, execution limits, tools or a start
method. No complete Runner protocol is invented here. A future execution request
must compose this contract with approved execution inputs and permissions.
The existing `RuntimeCapabilityCatalog` remains unchanged and independent.

## Request Schema

All objects reject unknown fields; all required fields must be present. Invalid
input throws `StorageError(kind='validation')` with `details.field/reason` before
any adapter dispatch or I/O. Validated outputs are detached from input objects.

| Field | Requirement |
| --- | --- |
| schemaVersion | Exactly numeric 1 |
| projectId, sessionId | Core stable IDs |
| executionVersion | Positive safe integer; execution fencing generation |
| invocationId | Core stable authorized adapter-entry ID |
| identity | Work: purpose/work + runId/taskId/attemptId; Chat: purpose/chat + sessionId/turnId |
| strategy | Existing `RuntimeStrategyV1` validator, including credential/endpoint reference hygiene |
| recovery | Explicit selection below; no implicit default policy |

IDs reuse `validateStableId` (1-128 ASCII characters, leading alphanumeric,
remaining `[A-Za-z0-9._-]`). Chat identity.sessionId must equal request.sessionId.
Work does not invent a Chat Turn; Chat cannot carry Work Attempt/Task/Run fields.

`invocationId` is stable across network retries within one authorized live
execution. A new Work Attempt gets a new invocationId. SDK model request IDs,
tool IDs and process-start budget keys remain separate. Structural validation
cannot prove ID uniqueness or that an invocation was actually authorized;
trusted Core control must enforce those facts.

Selections:

- `{ mode: 'new' }`: kind/source fields forbidden.
- `{ mode: 'auto', kind: 'conversation' | 'checkpoint', source?: ... }`:
  missing source yields a recorded `new` decision with `source:missing`.
- `{ mode: 'required', kind: 'conversation' | 'checkpoint', source: ... }`:
  source mandatory; unsupported/unverified capability rejects, never degrades.

Malformed/contradictory sources fail validation even for auto. An auto selection
only authorizes a capability-based fallback; the adapter must not independently
turn failed or unsafe execution into a new request.

## Immutable Source Schema

Required common fields: schemaVersion=1, purpose, kind, sourceProjectId,
sourceSessionId, runtime, provider, model, providerSessionId, nativeArchiveRef,
nativeFormat, nativeFormatVersion, sourceDigest.

- Work requires sourceTaskId/sourceAttemptId. Same project/task/purpose/runtime,
  different Attempt. Source Session may differ from the current Work Session.
- Chat requires sourceTurnId. Same project/Session/purpose/runtime, different
  Turn. No synthetic sourceAttemptId is allowed.
- Checkpoint requires checkpointRef; conversation forbids checkpointRef.
  Reference.kind must equal selection.kind.
- nativeArchiveRef/checkpointRef are immutable Core Artifact IDs, not locators,
  native database paths, provider paths or executable module references.
- providerSessionId is an opaque nonempty provider identifier, not a Core ID.
- sourceDigest is a lowercase 64-hex SHA-256 digest of the source archive
  represented by nativeArchiveRef. It is not an input or permission digest.
- nativeFormat and all version labels are explicit 1-128 ASCII tokens matching
  `[A-Za-z0-9][A-Za-z0-9._+-]*`; no semver ordering or compatibility is inferred.

These checks do not read Artifacts, check their contents, verify source ownership
against stored rows, inspect permissions/input/code snapshots or confirm a
previous process stopped. F-002 must resolve same-project immutable Artifacts
and enforce those gates before an adapter sees any native path. File digests,
checkpoint membership in the source archive and source compatibility are not
proven by a syntactically valid reference.

## Capability Evidence

`RuntimeRecoveryCapabilities` requires schemaVersion=1, runtimeId,
adapterVersion, sdkVersion (explicit null for no SDK), nativeFormats, limits,
and all five independently declared capabilities:

| Capability | Meaning |
| --- | --- |
| nativeHistory | Read/export history; does not imply continuation |
| conversationResume | Continue native conversation |
| executionRecovery | Recover execution checkpoints, not just messages |
| modelSwitchOnResume | Apply/verify requested provider/model change |
| nativeFork | Branch or safely copy the immutable native source |

Each capability requires status `verified/unsupported/unverified` and an
explicit limits string array. Verified requires evidenceRef (Core Artifact ID);
other statuses may include evidenceRef. Empty limits explicitly means no
reported limitations, not proof of unrestricted execution. Evidence is supplied
by trusted composition for a specific adapter/environment; validation does not
fetch evidence or turn an unsupported/unverified declaration into support.

The descriptor has explicit native format/version pairs; empty nativeFormats
permits history-only/no-recovery descriptors, but cannot satisfy recovery.
Duplicate formats, duplicate versions, empty version lists and unknown fields
are rejected. Versions match exactly; no inferred SDK/schema compatibility.
Limits document constraints; later trusted checks enforce environment-specific
constraints. This capability decision alone is not a production safety gate.

## Capability Decision

`decideRuntimeRecovery` validates both inputs before deciding. It returns:

- `resume` plus the exact requested kind only if required evidence is verified.
- `rejected` with reasons for required when evidence/format is unavailable.
- `new` with reasons for auto when evidence/format is unavailable.

Both recovery kinds require nativeFork to keep sources immutable. Conversation
requires conversationResume; checkpoint requires executionRecovery (never
substituted by conversationResume). Provider or model changes additionally
require modelSwitchOnResume. nativeHistory is independent and is not required
merely to resume. Checkpoint recovery is not implicitly history continuation.
A runtimeId mismatch in a supplied descriptor is a composition error and always
rejects, including auto. Missing descriptor is `capabilities:unverified`.

Reasons: `explicit_new`, `source:missing`, `capabilities:unverified`,
`runtime:mismatch`, `nativeFormat:unsupported`, or `<capability>:<status>`.
Reasons are deterministic and do not echo source content or credentials.
A `resume` decision is not a claim that the Runtime has started, that a Task
passed, or that effects may be replayed exactly once. Core still owns budgets,
fencing, permissions, cancellation, occupancy and verification. Core SQLite and
native Runtime storage remain separate; no private SDK tables or cross-store
atomic commits are assumed.

## Task Boundaries

F-002 adds trusted composition/source checks. F-003 adds deterministic execution
and effect/recording tests. F-004/F-005 investigate the candidate SDK. F-006
integrates final acceptance and handoff. P03-4/6/9 consume this shared contract;
P04 implements the real Pi adapter only on verified evidence. Chat business
control remains a separate future service. F-001 does not install/import any
vendor SDK, add dependencies, call models or read user credentials.
