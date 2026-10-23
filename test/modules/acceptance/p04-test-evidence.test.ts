import { expect, it } from 'vitest';
import { evaluateP04TestEvidence, P04_OFFLINE_TEST_BINDINGS } from '../../../scripts/acceptance/p04-test-evidence.ts';

function report() {
  const files = [...new Set(Object.values(P04_OFFLINE_TEST_BINDINGS).flat())];
  return { success: true, testResults: files.map(name => ({ name, assertionResults: [{ fullName: 'actual assertion', status: 'passed' }] })) };
}
it('binds every offline check to nonempty actual test results, never live or manual checks', () => {
  const proofs = evaluateP04TestEvidence(process.cwd(), report());
  expect(proofs.length).toBe(15);
  expect(proofs.every(proof => proof.passed && proof.bindings.every(b => b.assertions.length > 0))).toBe(true);
  expect(proofs.some(proof => /T43|T44|MANUAL|LIVE/.test(proof.checkId))).toBe(false);
});
it.each(['failed', 'pending', 'skipped', 'todo'])('non-passing assertions cannot become machine acceptance: %s', status => {
  const raw = report(); raw.testResults[0]!.assertionResults[0]!.status = status;
  expect(evaluateP04TestEvidence(process.cwd(), raw).some(p => !p.passed)).toBe(true);
});
it('rejects missing files, zero assertions, duplicate reports and global suite failure', () => {
  const missing = report(); missing.testResults.shift();
  const empty = report(); empty.testResults[0]!.assertionResults = [];
  const duplicate = report(); duplicate.testResults.push(duplicate.testResults[0]!);
  const failed = report(); failed.success = false;
  for (const raw of [missing, empty, duplicate, failed, null]) {
    expect(evaluateP04TestEvidence(process.cwd(), raw).some(p => !p.passed)).toBe(true);
  }
});
