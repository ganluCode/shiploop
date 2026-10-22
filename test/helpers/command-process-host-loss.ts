/** Test-only Host crash probe, using the production source adapter through the existing TS loader. */
import { createCommandProcessAdapter } from '../../packages/core/src/adapters/process/command-process.ts';

const sentinel = process.argv[2];
const cwd = process.argv[3];
// Optional F-008 protocol: the test Host sends the identity, then waits for the
// parent to persist it before acknowledging/releasing a real writer tree.
const matrixWriter = process.argv[4];
await createCommandProcessAdapter().start({
  argv: matrixWriter ? [process.execPath, matrixWriter, cwd, 'stubborn']
    : [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'ran')`],
  cwd, environment: {}, timeoutMs: 10_000, maxInputBytes: 65_536, maxOutputBytes: 65_536,
}, async (identity) => {
  process.send?.(identity);
  if (matrixWriter) {
    await new Promise<void>(resolve => process.once('message', () => resolve()));
    return { launchId: identity.launchId };
  }
  // Simulate Host termination inside the durable-commit boundary, with no acknowledgement.
  return new Promise(() => {});
});
