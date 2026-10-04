import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const harness = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const options = { repo: harness, ref: 'HEAD', out: join(harness, 'artifacts/acceptance/p01-integration'), offline: false };
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === '--offline') { options.offline = true; continue; }
  assert(['--repo', '--ref', '--out'].includes(key) && process.argv[i + 1], `Unknown/missing argument: ${key}`);
  options[key.slice(2)] = process.argv[++i];
}
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const out = join(resolve(options.out), runId);
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'shiploop-p01-integration-'));
const snapshot = join(scratch, 'snapshot');
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const report = { schemaVersion: 1, runId, sourceRef: options.ref, commit: null, node: process.version, status: 'running', steps: [], cases: [], scratch };
const redact = (value) => value.replaceAll(scratch, '<SANDBOX>').replaceAll(resolve(options.repo), '<SOURCE-REPO>');
function persist() {
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(out, 'summary.md'), `# P01 独立脚本集成验收\n\n状态：${report.status}\n\nCommit：${report.commit ?? '未解析'}\n\n` + report.steps.map((s) => `- ${s.name}: ${s.status}`).join('\n') + '\n\n' + report.cases.map((c) => `- ${c.run}/${c.id}: ${c.status} ${c.title}`).join('\n') + '\n');
}
function run(name, command, args, cwd, timeout = 180000) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(out, `${name}.log`), redact((result.stdout || '') + '\n' + (result.stderr || '') + (result.error ? `\n${result.error.message}` : '')));
  report.steps.push({ name, exitCode: result.status, signal: result.signal, status: result.status === 0 ? 'pass' : 'fail', durationMs: Date.now() - started });
  persist();
  assert.equal(result.status, 0, `Step ${name} failed; see ${join(out, `${name}.log`)}`);
  return result.stdout.trim();
}
try {
  assert.equal(process.version, 'v22.19.0', 'Use the Node version pinned by P01: 22.19.0');
  report.commit = run('resolve-commit', 'git', ['rev-parse', '--verify', `${options.ref}^{commit}`], resolve(options.repo));
  run('clone', 'git', ['clone', '--no-hardlinks', '--no-checkout', '--local', resolve(options.repo), snapshot], scratch);
  run('checkout', 'git', ['checkout', '--detach', report.commit], snapshot);
  // Use npm from the same Node installation, not an unrelated global npm.
  const npmCli = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  assert.equal(run('npm-version', process.execPath, [npmCli, '--version'], snapshot), '10.9.3');
  run('install', process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund', ...(options.offline ? ['--offline'] : [])], snapshot, 300000);
  run('build', process.execPath, [npmCli, 'run', 'build'], snapshot);
  for (let index = 1; index <= 2; index++) {
    const sandbox = join(scratch, `business-${index}`);
    run(`integration-${index}`, process.execPath, [join(harness, 'scripts/acceptance/p01-scenarios.mjs'), snapshot, sandbox], scratch);
    const checks = JSON.parse(readFileSync(join(sandbox, 'checks.json'), 'utf8'));
    assert.equal(checks.length, 12, 'Missing required integration checks');
    assert(checks.every((c) => c.status === 'pass'));
    report.cases.push(...checks.map((c) => ({ run: index, ...c })));
    writeFileSync(join(out, `integration-${index}.json`), JSON.stringify(checks, null, 2));
  }
  report.status = 'pass';
} catch (error) {
  report.status = 'fail'; report.error = redact(error.message); process.exitCode = 1;
} finally {
  // Retain this owned sandbox for diagnosis; never delete source repositories.
  persist();
  console.log(`P01 integration: ${report.status}; report: ${out}; sandbox: ${scratch}`);
}
