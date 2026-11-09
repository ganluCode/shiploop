# F01: Technical Design

- Design status: proposed
- Owner: to assign
- Requirement: [PRD](../features/f01-example.md)

## Modules and Interfaces
Boundaries, reused capabilities, call flow, I/O, shared signatures, error types and compatibility.

## Data and Migrations
Entities, storage ownership, transactions, versions and forward/rollback strategy. Access ShipLoop business state only through public CLI/Host, never direct model SQL.

## Concurrency and Idempotency
Locks/ownership/CAS/revision, duplicate commands, unknown-result queries, merge prerequisites and conflicts. Command idempotency is distinct from external side effects; resume is not exactly-once tooling.

## Lifecycle and Recovery
Async launch, states, timeouts, cancellation, retries, resume, orphan processes and cleanup. Verify existing commits/artifacts/execution before recovery.

## Security and Permissions
Trust boundaries, allowed files/tools, credential references, approvals and budgets. No unauthorized model calls, switching, push or data deletion.

## Tests and Evidence
Link acceptance IDs to module unit tests, cross-layer integration and affected regression. Distinguish Task/Feature/Phase scope. Mark pending tests honestly; full regression requires CI/explicit authorization.

## Tradeoffs and Open Decisions
Alternatives, rationale, performance risks and owner decisions; explicitly state not applicable.
