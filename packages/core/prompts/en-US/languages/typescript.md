## TypeScript Standards

- Follow project tsconfig, module format and public API conventions. Model public boundaries explicitly, validate unknown external data before narrowing, and do not hide errors with any, double assertions or ts-ignore.
- Own every Promise: await it or manage its background lifecycle explicitly. Propagate errors and AbortSignal; clean up timers, streams and child processes on cancellation.
- Use the existing package manager and lockfile. Avoid incidental dependency upgrades. Keep browser and Node permissions, environments and build boundaries clear.
- Run affected unit test files and necessary local type checks only; full test/build/verify is not a default Task closeout.
