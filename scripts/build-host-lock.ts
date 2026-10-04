/** Explicit macOS native build; no downloads, dependency updates or runtime compilation. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

export function buildHostLock(): void {
  if (process.platform !== 'darwin') throw new Error('Host lock build requires macOS (no fallback)');
  // Official Node distribution/nvm installation carries headers next to bin/.
  const headers = resolve(dirname(process.execPath), '../include/node');
  if (!existsSync(resolve(headers, 'node_api.h'))) {
    throw new Error('Host lock build requires Node installation headers (node_api.h); no auto-download');
  }
  const target = resolve(repoRoot, 'packages/host/dist/native/writer-lock.node');
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const result = spawnSync('/usr/bin/clang', [
      '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-bundle', '-undefined', 'dynamic_lookup',
      '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=writer_lock', '-I', headers,
      resolve(repoRoot, 'packages/host/native/writer-lock.c'), '-o', temporary,
    ], { timeout: 60_000, encoding: 'utf8', maxBuffer: 64 * 1024 });
    if (result.error || result.signal || result.status !== 0) {
      throw new Error('Host lock build failed: requires /usr/bin/clang and macOS SDK (Xcode Command Line Tools)');
    }
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildHostLock(); }
  catch (error) { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; }
}
