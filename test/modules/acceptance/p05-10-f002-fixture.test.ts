import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  P0510EvidenceError,
  createP05AcceptanceFixture,
  hashP0510Input,
  validateP0510ScenarioEvidence,
} from '../../../test/helpers/p05-10/index.ts';

it('[case:p05-f002-isolated-real-resources] 每个场景拥有独立真实资源和自有进程', async () => {
  const fixture = createP05AcceptanceFixture({ prefix: 'shiploop-p05-f002-isolation-' });
  try {
    const first = fixture.createScenario('i01');
    const second = fixture.createScenario('i02');

    expect(first.projectDirectory).not.toBe(second.projectDirectory);
    expect(first.dataRoot).not.toBe(second.dataRoot);
    expect(first.gitRepositoryPath).not.toBe(second.gitRepositoryPath);
    expect(first.sqlitePath).not.toBe(second.sqlitePath);
    expect(first.sqlite.pragmaSnapshot()).toMatchObject({ foreignKeysEnabled: true, journalMode: 'wal' });
    expect(first.sqlite.database.prepare('SELECT scenario_id FROM p05_fixture_records').get()).toEqual({ scenario_id: 'i01' });
    expect(second.sqlite.database.prepare('SELECT scenario_id FROM p05_fixture_records').get()).toEqual({ scenario_id: 'i02' });

    const childProcess = first.spawnProcess({ argv: [globalThis.process.execPath, '-e', 'process.stdout.write("owned\\n")'] });
    await expect(childProcess.waitExit(2_000)).resolves.toMatchObject({ code: 0, signal: null });
    expect(first.processFacts().identities).toEqual(expect.arrayContaining([expect.objectContaining({ pid: childProcess.pid, owned: true, exitCode: 0 })]));
  } finally {
    await fixture.dispose();
  }
  expect(existsSync(fixture.root)).toBe(false);
});

it('[case:p05-f002-fake-runtime-real-side-effect] FakeRuntime 只替代模型输出，文件副作用仍落到临时工作区', async () => {
  const fixture = createP05AcceptanceFixture({ prefix: 'shiploop-p05-f002-runtime-' });
  try {
    const scenario = fixture.createScenario('runtime');
    const run = await scenario.runFakeRuntime({
      script: { schemaVersion: 1, steps: [{ op: 'write_file', path: 'runtime-output.txt', content: 'real file effect\\n' }] },
    });
    expect(run.result.terminal).toBe('completed');
    expect(readFileSync(join(scenario.projectDirectory, 'runtime-output.txt'), 'utf8')).toBe('real file effect\\n');
    expect(run.usageSource).toBe('runtime-usage');
    expect(run.network).toBe('denied');
  } finally {
    await fixture.dispose();
  }
});

it('[case:p05-f002-evidence-contract] 证据记录完整身份、事实、用量和 not_run 原因', async () => {
  const fixture = createP05AcceptanceFixture({ prefix: 'shiploop-p05-f002-evidence-' });
  try {
    const scenario = fixture.createScenario('i09');
    const input = { feature: 'i09', budget: 3 };
    await scenario.cleanup();
    const evidence = scenario.recordEvidence({ input, command: ['node', 'offline-check'], exitCode: 0, status: 'pass' });
    expect(evidence).toMatchObject({ scenarioId: 'i09', inputDigest: hashP0510Input(input), testedCommit: fixture.testedCommit,
      command: ['node', 'offline-check'], exitCode: 0, status: 'pass', usageSource: 'command-output' });
    expect(evidence.sqlite.path).toBe(scenario.sqlitePath);
    expect(evidence.git.head).toMatch(/^[0-9a-f]{40}$/);
    expect(evidence.process.owned).toBe(true);
    expect(evidence.cleanup.status).toBe('passed');

    const notRun = scenario.recordEvidence({ input: { reason: 'live disabled' }, command: [], exitCode: null, status: 'not_run',
      usageSource: 'not_run', notRunReason: 'live authorization absent' });
    expect(notRun.status).toBe('not_run');
    expect(notRun.notRunReason).toBe('live authorization absent');
    expect(() => validateP0510ScenarioEvidence({ ...notRun, notRunReason: undefined })).toThrow(P0510EvidenceError);
  } finally {
    await fixture.dispose();
  }
});

it('[case:p05-f002-evidence-fail-closed] 身份/哈希/重复写入失败且不覆盖既有成功证据', async () => {
  const fixture = createP05AcceptanceFixture({ prefix: 'shiploop-p05-f002-fail-closed-' });
  try {
    const scenario = fixture.createScenario('negative');
    const input = { stable: true };
    await scenario.cleanup();
    const evidence = scenario.recordEvidence({ input, command: ['true'], exitCode: 0, status: 'pass' });
    const path = scenario.writeEvidence(evidence);
    const original = readFileSync(path, 'utf8');
    expect(() => scenario.writeEvidence({ ...evidence, inputDigest: '0'.repeat(64) })).toThrow(P0510EvidenceError);
    expect(() => scenario.writeEvidence(evidence)).toThrow(P0510EvidenceError);
    expect(readFileSync(path, 'utf8')).toBe(original);
  } finally {
    await fixture.dispose();
  }
});

it('[case:p05-f002-cleanup-uncertain-retains-scene] 清理不确定时返回失败并保留现场', async () => {
  const fixture = createP05AcceptanceFixture({ prefix: 'shiploop-p05-f002-retain-' });
  const scenario = fixture.createScenario('retained');
  const childProcess = scenario.spawnProcess({ argv: [globalThis.process.execPath, '-e', 'setInterval(()=>{}, 1000)'] });
  const cleanup = await scenario.cleanup({ confirmStopped: () => false });
  expect(cleanup.status).toBe('failed');
  expect(cleanup.resourcesRemoved).toBe(false);
  expect(existsSync(scenario.root)).toBe(true);
  await childProcess.verifyStopped({ stepMs: 5 });
  await fixture.dispose();
});
