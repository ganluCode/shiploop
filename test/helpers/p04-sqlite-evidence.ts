/** Opt-in test evidence only. Never changes business rows or claims that a scenario passed. */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { SqliteStorageSession } from '../../packages/core/src/adapters/sqlite/session.ts';

export function captureP04SqliteEvidence(session: SqliteStorageSession, fixture: string): void {
  const root = process.env.SHIPLOOP_P04_EVIDENCE_DIR;
  if (!root) return;
  if (!isAbsolute(root) || realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('Invalid P04 evidence directory');
  const bytes = session.database.serialize();
  if (bytes.length > 32_000_000) throw new Error('P04 SQLite evidence exceeds bounded size');
  const id = randomUUID(), file = `${id}.sqlite`;
  writeFileSync(join(root, file), bytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(root, `${id}.json`), JSON.stringify({ schemaVersion: 1, source: 'sqlite-serialize',
    execution: 'offline', capturedBeforeCleanup: true, capturedAtUtc: new Date().toISOString(), fixture,
    testFile: process.env.SHIPLOOP_P04_EVIDENCE_TEST_FILE ?? null,
    testName: process.env.SHIPLOOP_P04_EVIDENCE_TEST_NAME ?? null,
    file, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    scenarioStatus: 'observed_not_a_test_verdict',
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
