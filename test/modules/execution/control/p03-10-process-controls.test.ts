import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { withP03AcceptanceFixture, type P03Fixture } from '../../../helpers/p03-10/acceptance-fixture.ts';

const logs = '/Users/ganlu/Documents/my-dev/code/ai-coding/shiploop-harness/workspace/features/2026-10-11-17-45-49_p03-10-p03/verifications/F-014/runtime-logs';
const writer = fileURLToPath(new URL('../../../helpers/p03-10/controlled-writer.mjs', import.meta.url));
function evidence(name: string) {
  mkdirSync(logs, { recursive: true });
  return mkdtempSync(join(logs, `${name}-`));
}
async function waitFor(condition: () => boolean, label: string) {
  await expect.poll(condition, { timeout: 15_000, message: label }).toBe(true);
}
function run(f: P03Fixture) { return f.rows('runs').find(row => row.id === f.ids.runId)!; }
async function control(f: P03Fixture, operation: 'pause' | 'cancel', commandId = randomUUID()) {
  return f.cli<Record<string, unknown>>(['execution', operation, '--project', f.ids.projectId!, '--run', f.ids.runId!,
    '--revision', String(run(f).revision), '--command-id', commandId, ...(operation === 'cancel' ? ['--confirm'] : [])]);
}
async function verify(f: P03Fixture, taskId = 'chain-1') {
  const id = randomUUID();
  writeFileSync(join(f.root, 'chain-control.json'), JSON.stringify({ id, taskId }));
  const path = join(f.root, `chain-result-${id}.json`);
  await expect.poll(() => existsSync(path), { timeout: 40_000, message: 'real verification completed' }).toBe(true);
  const result = JSON.parse(readFileSync(path, 'utf8'));
  expect(result.error, JSON.stringify(result)).toBeUndefined();
  return result;
}

test('[case:runtime-pause-drains] 真实挂起 Fake 工具在 pause 后继续收尾，阻止新认领', async () => {
  const dir = evidence('runtime-pause');
  await withP03AcceptanceFixture({ evidenceDir: dir, threeTaskChain: true,
    toolCommands: { probe: { argv: [process.execPath, writer, dir, 'gated'], timeoutMs: 30_000 } },
  }, async f => {
    await f.startExecution();
    await waitFor(() => existsSync(join(dir, 'ready.json')), 'owned Runtime tree launched');
    expect(await control(f, 'pause')).toMatchObject({ outcome: 'pausing', status: 'pausing' });
    expect(f.rows('attempts')).toHaveLength(1);
    expect(f.rows('workspace_leases')).toHaveLength(3);
    writeFileSync(join(dir, 'release'), 'release');
    await waitFor(() => f.rows('attempts')[0]?.status === 'verifying', 'Runtime drained to verification');
    const checked = await verify(f);
    expect(checked.verification.status).toBe('passed');
    await waitFor(() => run(f).status === 'paused', 'Task boundary paused');
    expect(f.rows('tasks').filter(row => row.status === 'passed')).toHaveLength(1);
    expect(f.rows('attempts')).toHaveLength(1);
    expect(f.rows('sessions')).toHaveLength(1);
    expect(f.rows('workspace_leases')).toHaveLength(0);
    expect(await control(f, 'cancel')).toMatchObject({ outcome: 'cancelled', status: 'cancelled' });
    expect(await control(f, 'cancel')).toMatchObject({ outcome: 'already_terminal', status: 'cancelled' });
    f.saveEvidence('pause-boundary.json', { run: run(f), checked, tree: JSON.parse(readFileSync(join(dir, 'ready.json'), 'utf8')) });
  });
  expect(JSON.parse(readFileSync(join(dir, 'cleanup.json'), 'utf8')).status).toBe('passed');
}, 90_000);


test('[case:verifier-pause-drains] 真实 Verifier 父子进程挂起后 pause 只在检查完成边界生效', async () => {
  const dir = evidence('verifier-pause');
  const verifierDir = join(dir, 'verifier');
  mkdirSync(verifierDir, { recursive: true });
  await withP03AcceptanceFixture({ evidenceDir: dir, threeTaskChain: true,
    verificationCommand: { argv: [process.execPath, writer, verifierDir, 'gated'], timeout: 30_000 },
  }, async f => {
    await f.startExecution();
    await waitFor(() => f.rows('attempts')[0]?.status === 'verifying', 'Verifier phase entered');
    const id = randomUUID();
    f.input('chain-control.json', { id, taskId: 'chain-1' });
    await waitFor(() => existsSync(join(verifierDir, 'ready.json')), 'owned Verifier tree launched');
    const paused = await control(f, 'pause');
    expect(['pausing', 'paused']).toContain(paused.outcome);
    expect(f.rows('attempts')).toHaveLength(1);
    writeFileSync(join(verifierDir, 'release'), 'release');
    const resultPath = join(f.root, `chain-result-${id}.json`);
    await expect.poll(() => existsSync(resultPath), { timeout: 40_000, message: 'Verifier completed' }).toBe(true);
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(result.verification.status).toBe('passed');
    await waitFor(() => run(f).status === 'paused', 'Verifier boundary paused');
    expect(f.rows('attempts')).toHaveLength(1);
    expect(f.rows('workspace_leases')).toHaveLength(0);
    f.saveEvidence('verifier-pause-boundary.json', { paused, result,
      tree: JSON.parse(readFileSync(join(verifierDir, 'ready.json'), 'utf8')), run: run(f) });
  });
  expect(JSON.parse(readFileSync(join(dir, 'cleanup.json'), 'utf8'))).toMatchObject({
    status: 'passed', processTreeStopped: true, processGroupsStopped: true,
  });
}, 100_000);

test('[case:real-cancel-cas] 真实进程取消等待进程组停止，重复取消在停止不确定时保持隔离', async () => {
  const dir = evidence('real-cancel');
  await withP03AcceptanceFixture({ evidenceDir: dir, threeTaskChain: true,
    toolCommands: { probe: { argv: [process.execPath, writer, dir, 'gated'], timeoutMs: 30_000 } },
  }, async f => {
    await f.startExecution();
    await waitFor(() => existsSync(join(dir, 'ready.json')), 'owned Runtime tree launched');
    const beforeEvents = f.rows('state_events').length;
    const first = await control(f, 'cancel');
    expect(['cancelling', 'cancelled']).toContain(first.outcome);
    expect(first.stopOperationId).not.toBeNull();
    await waitFor(() => run(f).status === 'cancelling' && f.rows('attempts')[0]?.status === 'interrupted', 'cancel uncertainty persisted');
    const attempts = f.rows('attempts');
    expect(f.rows('workspace_leases')).toHaveLength(3);
    expect(f.rows('workspace_leases').every(lease => lease.state === 'quarantined')).toBe(true);
    const repeated = await control(f, 'cancel');
    expect(repeated).toMatchObject({ outcome: 'stop_uncertain', status: 'cancelling' });
    expect(f.rows('attempts')).toHaveLength(1);
    expect(f.rows('state_events').length).toBeGreaterThanOrEqual(beforeEvents + 1);
    f.saveEvidence('cancel-cas.json', { first, repeated, run: run(f), attempts,
      tree: JSON.parse(readFileSync(join(dir, 'ready.json'), 'utf8')), events: f.rows('state_events') });
  });
  expect(JSON.parse(readFileSync(join(dir, 'cleanup.json'), 'utf8'))).toMatchObject({
    status: 'passed', processTreeStopped: true, processGroupsStopped: true,
  });
}, 100_000);

test('[case:stop-uncertain-isolates] 真实阶段停止确认缺失时保留 interrupted/quarantined 与占用', async () => {
  const dir = evidence('stop-uncertain');
  await withP03AcceptanceFixture({ evidenceDir: dir,
    script: { schemaVersion: 1, steps: [{ op: 'tool_command', name: 'probe' }],
      lifecycle: { stopped: { unconfirmed: true } } },
    toolCommands: { probe: { argv: [process.execPath, writer, dir, 'gated'], timeoutMs: 30_000 } },
  }, async f => {
    await f.startExecution();
    await waitFor(() => existsSync(join(dir, 'ready.json')), 'owned Runtime tree launched');
    writeFileSync(join(dir, 'release'), 'release');
    await waitFor(() => f.rows('attempts')[0]?.status === 'interrupted', 'uncertain stop persisted');
    expect(f.rows('workspace_leases').every(lease => lease.state === 'quarantined')).toBe(true);
    expect(f.rows('workspace_leases')).toHaveLength(3);
    expect(f.rows('sessions')).toHaveLength(1);
    const beforeReplay = { runs: f.rows('runs'), attempts: f.rows('attempts'), leases: f.rows('workspace_leases') };
    await f.replayExecutionStart();
    expect({ runs: f.rows('runs'), attempts: f.rows('attempts'), leases: f.rows('workspace_leases') }).toEqual(beforeReplay);
    f.saveEvidence('stop-uncertain.json', { beforeReplay, tree: JSON.parse(readFileSync(join(dir, 'ready.json'), 'utf8')) });
  });
  expect(JSON.parse(readFileSync(join(dir, 'cleanup.json'), 'utf8'))).toMatchObject({
    status: 'passed', processTreeStopped: true, processGroupsStopped: true,
  });
}, 100_000);
