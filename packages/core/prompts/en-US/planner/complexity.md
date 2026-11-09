## Task Complexity: low / medium / high

Complexity measures reasoning, design and risk-control requirements for a correct implementation and determines routing. Inspect existing code and complete patterns first. File counts, line counts, test duration, task names and desired model quotas do not determine complexity.

| Dimension | low | medium | high |
| --- | --- | --- | --- |
| Requirement certainty | Inputs, outputs and failures defined; almost no semantic decisions | Validation/state/error decisions within existing contracts | Invariants, ownership or protocol need design; mistakes affect modules |
| Existing patterns | Complete verified precedent supports local reuse | Partial patterns; upstream/downstream wiring needs understanding | No reliable precedent; compare designs and establish durable boundaries |
| State/side effects | Stateless or mechanical use of mature helpers | Correct application of defined transaction/idempotency/permission/retry semantics | Cross-transaction atomicity, CAS/fencing, lock order, recovery/compensation or distributed consistency design |
| Impact | Local implementation and one stable interface | Multi-module wiring with clear public contracts | Cross-layer protocol/storage/runtime lifecycle changes with complex migration/compatibility |
| Verification | Known-input/output unit tests | Error classification, boundaries and affected modules | Derive race/crash windows, security boundaries or performance invariants and validation |

### low examples
Configuration/DTO/copy changes with complete precedent, clear component styling, mechanical query projections or local tests for defined behavior. Repeated cross-file wiring may be low only when permission, error, cancellation and compatibility semantics and helpers are settled.

### medium examples
Business-state validation, API wiring, input validation, ordinary bug fixes, file tools under a clear protocol, module migration application and targeted tests within stable architecture. Reassess at least medium for uncovered auth/cancellation/error boundaries; new read-only Core/Host/client protocols are usually medium.

### high examples
Atomic state/event/receipt consistency, concurrent scheduling/fencing, crash recovery/idempotent compensation, cross-runtime session recovery, permission isolation, destructive migration compatibility, critical algorithms or evidence-based performance design. Applying an already frozen design may be medium; database involvement alone does not imply high.

### Classification and decomposition
1. Identify observable outcome, invariants, reusable precedent and remaining design decisions.
2. Classify the hardest inseparable responsibility. Separate design/contracts from mechanical implementation only when independently acceptable; make implementation depend on the frozen result.
3. Split work beyond one responsibility by module/state boundary, not mechanical coding/testing/commit steps. Keep tests with implementation; Core owns formal commits.
4. Do not impose low/medium/high quotas, downgrade to save quota or default everything to medium without inspecting code. Search for evidence; describe unresolved blockers rather than hiding them in a label.
5. Briefly explain real decisions/reused patterns in description. Do not invent unsupported difficultyReason fields.
