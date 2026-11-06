import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadHeavyShards } from './test-stages.ts';

export function verifyShardGate(root: string, directory: string, commit: string, needs: unknown): void {
  const jobs = needs as Record<string, { result?: string }>;
  const expectedJobs = ['checks', 'heavy-1', 'heavy-2', 'heavy-3', 'heavy-4'];
  if (!jobs || JSON.stringify(Object.keys(jobs).sort()) !== JSON.stringify(expectedJobs.sort())
    || Object.values(jobs).some(job => !job || job.result !== 'success')) throw new Error('CI dependency failed, cancelled or skipped');
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('invalid CI commit');
  const plans = loadHeavyShards(root, 4);
  const files = readdirSync(directory).filter(file => /^heavy-\d+\.json$/.test(file)).sort();
  if (JSON.stringify(files) !== JSON.stringify(['heavy-1.json', 'heavy-2.json', 'heavy-3.json', 'heavy-4.json'])) {
    throw new Error('missing or unexpected shard reports');
  }
  const seen = new Set<string>();
  for (const [index, expected] of plans.entries()) {
    const file = join(directory, `heavy-${index + 1}.json`);
    const report = JSON.parse(readFileSync(file, 'utf8'));
    const outcome = report.outcomes?.[0];
    if (report.schemaVersion !== 1 || report.scope !== 'heavy' || report.fullSuiteRequested !== false
      || report.commit !== commit || report.shard?.index !== index + 1 || report.shard?.total !== 4
      || report.passed !== true || report.outcomes?.length !== 1 || outcome?.stage !== 'heavy'
      || outcome.status !== 'pass' || outcome.exitCode !== 0 || outcome.signal !== null || outcome.error !== null
      || JSON.stringify(outcome.files) !== JSON.stringify(expected)) throw new Error(`invalid shard evidence: ${index + 1}`);
    const vitest = JSON.parse(readFileSync(`${file}.vitest.json`, 'utf8'));
    if (vitest.success !== true || vitest.numFailedTests !== 0 || vitest.numFailedTestSuites !== 0
      || !Array.isArray(vitest.testResults) || vitest.testResults.length !== expected.length) {
      throw new Error(`incomplete Vitest results: ${index + 1}`);
    }
    for (const result of vitest.testResults) {
      const path = typeof result.name === 'string' ? expected.find(file => result.name.endsWith(`/${file}`)) : undefined;
      if (!path || result.status !== 'passed' || seen.has(path)) throw new Error('missing, duplicate or failed test file');
      seen.add(path);
    }
  }
  if (seen.size !== plans.flat().length) throw new Error('incomplete heavy suite coverage');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('unexpected gate arguments');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0) throw new Error('cannot identify CI commit');
    verifyShardGate(root, join(root, 'artifacts/ci-tests'), result.stdout.trim(), JSON.parse(process.env.CI_JOB_RESULTS ?? 'null'));
    process.stdout.write('ci-shard-gate: PASS all four shards, dependencies and exact file coverage\n');
  } catch (error) {
    process.stderr.write(`ci-shard-gate: FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
