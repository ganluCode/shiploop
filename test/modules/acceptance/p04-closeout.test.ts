import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { verifyP04Closeout } from '../../../scripts/acceptance/p04-closeout.ts';
import { evaluateP04TestEvidence, P04_OFFLINE_TEST_BINDINGS } from '../../../scripts/acceptance/p04-test-evidence.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'p04-closeout-test-'))); dirs.push(root);
  const commit = 'a'.repeat(40), repository = process.cwd();
  const raw = { success: true, testResults: [...new Set(Object.values(P04_OFFLINE_TEST_BINDINGS).flat())]
    .map(name => ({ name, assertionResults: [{ fullName: 'synthetic unit-test fixture', status: 'passed' }] })) };
  const write = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value));
  write('tests.json', raw);
  write('command.json', { kind: 'exit', exitCode: 0, stoppedVerified: true, timedOut: false });
  write('summary.json', { repository, commit, phaseAccepted: false, machineAssertionsPassed: true,
    checks: evaluateP04TestEvidence(repository, raw) });
  const index = { schemaVersion: 1, kind: 'p04-offline-closeout', commit, phaseAccepted: false,
    files: ['tests.json', 'command.json', 'summary.json'].map(path => {
      const bytes = readFileSync(join(root, path));
      return { path, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }) };
  write('evidence-index.json', index);
  return { root, commit, write, index };
}
it('read-only verification preserves pending Phase status and checks actual assertion bindings', () => {
  const f = fixture();
  expect(verifyP04Closeout(f.root, f.commit)).toMatchObject({ evidenceVerified: true, machineAssertionsPassed: true, checks: 15, phaseAccepted: false });
});
it('rejects changed commit, tampered evidence, duplicate and escaping paths', () => {
  const f = fixture();
  expect(() => verifyP04Closeout(f.root, 'b'.repeat(40))).toThrow();
  f.write('summary.json', { phaseAccepted: true });
  expect(() => verifyP04Closeout(f.root)).toThrow(/hash/);
  const duplicate = fixture(); duplicate.index.files.push(duplicate.index.files[0]!); duplicate.write('evidence-index.json', duplicate.index);
  expect(() => verifyP04Closeout(duplicate.root)).toThrow(/Duplicate/);
  const escaped = fixture(); escaped.index.files[0]!.path = '../outside'; escaped.write('evidence-index.json', escaped.index);
  expect(() => verifyP04Closeout(escaped.root)).toThrow(/Unsafe/);
});
