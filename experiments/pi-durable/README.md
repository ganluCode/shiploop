# Pi Durable Offline Spike (F-004)

This package is isolated from ShipLoop production dependencies and workspaces.
It runs the actual `@earendil-works/pi-durable@1.2.0` Harness and SQLite backend
with the official credential-free faux provider. It is not the Core synthetic
recovery driver, a standard Coding SDK session, or Python RPC.

Use Node 22.19.0 and npm 10.9.3 from the repository root:

```sh
npm ci --prefix experiments/pi-durable --ignore-scripts --no-audit --no-fund
npm test --prefix experiments/pi-durable
node experiments/pi-durable/probe.mjs > experiments/pi-durable/evidence.json
SHIPLOOP_PI_DURABLE_SPIKE=1 node scripts/run-tests.ts test/p03-3a-pi-durable-spike.test.ts
```

The installation needs registry access; probes need no network or credentials.
The suite has 14 SDK assertions, including SIGTERM/SIGKILL subprocesses,
real temporary-file effects, a bounded non-cooperative tool, and an explicitly
cleaned-up detached worker. `probe.mjs` records native checkpoint/result shapes,
events, backup/layout observations and negative guarantees. An assertion passing
for a missing guarantee does not make that capability supported.

Ordinary project tests do not load this experimental dependency. The opt-in
variable is required for the project wrapper's actual SDK test; without it,
only static version isolation checks run. There are no install-on-test hooks.

- [Chinese capability matrix and P04 decision](../../docs/p03-3a-pi-durable-capability-matrix.md)
- [Locked source references and command outcomes](sources.json)
- [Generated local SDK observations](evidence.json)

Do not point these probes at real native archives, providers or credentials.
Live main-file copies, concurrent schedulers, paid/subscription model calls,
actual OAuth, standard plugin execution and Skills/MCP connections are not part
of this offline experiment. See the matrix for `unsupported` and `not_run`.
