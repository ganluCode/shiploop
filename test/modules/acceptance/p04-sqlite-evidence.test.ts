import { mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { captureP04SqliteEvidence } from '../../helpers/p04-sqlite-evidence.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function box() { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'p04-export-'))); dirs.push(dir); return dir; }
it('does not inspect or serialize the database when export is disabled', () => {
  vi.stubEnv('SHIPLOOP_P04_EVIDENCE_DIR', '');
  const database = new Proxy({}, { get() { throw new Error('unexpected database access'); } });
  expect(() => captureP04SqliteEvidence({ database } as never, 'disabled')).not.toThrow();
});
it('exports a consistent readable SQLite image before the source is closed and deleted', () => {
  const root = box(), out = join(root, 'out'); mkdirSync(out);
  vi.stubEnv('SHIPLOOP_P04_EVIDENCE_DIR', out);
  const source = openSqliteStorageSession({ path: join(root, 'source.sqlite') });
  source.database.exec('CREATE TABLE proof (id TEXT PRIMARY KEY); INSERT INTO proof VALUES (\'actual-row\')');
  try { captureP04SqliteEvidence(source, 'test-fixture'); } finally { source.close(); }
  const name = readdirSync(out).find(name => name.endsWith('.json'))!;
  const record = JSON.parse(readFileSync(join(out, name), 'utf8'));
  expect(record).toMatchObject({ source: 'sqlite-serialize', capturedBeforeCleanup: true, fixture: 'test-fixture' });
  const snapshot = openSqliteStorageSession({ path: join(out, record.file) });
  try { expect(snapshot.database.prepare('SELECT * FROM proof').all()).toEqual([{ id: 'actual-row' }]); }
  finally { snapshot.close(); }
});
it('rejects symlink export paths rather than writing outside the declared directory', () => {
  const root = box(), target = join(root, 'target'); mkdirSync(target); symlinkSync(target, join(root, 'link'));
  vi.stubEnv('SHIPLOOP_P04_EVIDENCE_DIR', join(root, 'link'));
  expect(() => captureP04SqliteEvidence({ database: {} } as never, 'invalid')).toThrow();
  expect(readdirSync(target)).toEqual([]);
});
