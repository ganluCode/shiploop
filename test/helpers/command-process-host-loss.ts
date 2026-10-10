/** Test-only Host crash probe, using the production source adapter through the existing TS loader. */
import { createCommandProcessAdapter } from '../../packages/core/src/adapters/process/command-process.ts';

const sentinel = process.argv[2];
const cwd = process.argv[3];
await createCommandProcessAdapter().start({
  argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'ran')`],
  cwd, environment: {}, timeoutMs: 10_000, maxInputBytes: 65_536, maxOutputBytes: 65_536,
}, async (identity) => {
  process.send?.(identity);
  // Simulate Host termination inside the durable-commit boundary, with no acknowledgement.
  return new Promise(() => {});
});
