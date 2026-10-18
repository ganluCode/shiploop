import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../../helpers/p03-6/stopping-fixture.ts';
import { BINDING_NOW } from '../../helpers/p03-6/input-binding-fixture.ts';

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`waitFor: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function childScript(orphan: boolean) {
  const writer = "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.appendFileSync('heartbeat','x');setInterval(()=>fs.appendFileSync('heartbeat','x'),15)";
  return `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['--no-warnings','-e',${JSON.stringify(writer)}],{stdio:'ignore'});fs.writeFileSync('pids.json',JSON.stringify([process.pid,c.pid]));${orphan ? 'c.unref()' : "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"}`;
}

describe.skipIf(process.platform !== 'darwin')('F-010 real supervised process tree', () => {
  it.each(['cancel', 'runtime_timeout', 'tool_timeout', 'parent_deadline', 'orphan', 'unconfirmed'] as const)(
    '%s stops descendants before finalization, preserves evidence and known usage', async mode => {
      const f = await fixture({
        script: { schemaVersion: 1, steps: [
          { op: 'usage', inputTokens: 17, outputTokens: null, costUsdMicros: null },
          { op: 'tool_command', name: 'tree' },
          { op: 'write_file', path: 'must-not-exist', content: 'bad' },
        ], ...(mode === 'unconfirmed' ? { lifecycle: { stopped: { unconfirmed: true } } } : {}) },
        toolCommands: { tree: { argv: [process.execPath, '--no-warnings', '-e', childScript(mode === 'orphan')],
          timeoutMs: mode === 'tool_timeout' ? 1_000 : 30_000 } },
      }, {}, (f) => {
        if (mode === 'parent_deadline') f.session.database.prepare('UPDATE execution_batches SET deadline_at = ?').run(BINDING_NOW + 1_000);
      });
      let pids: number[] = [];
      try {
        const { context } = await f.start({ limits: { timeoutMs: mode === 'runtime_timeout' ? 1_000 : 30_000, maxEvents: 100, maxOutputBytes: 1_048_576 } });
        const pidFile = join(f.workspace.canonicalPath, 'pids.json'), heartbeat = join(f.workspace.canonicalPath, 'heartbeat');
        let earlyResult: unknown;
        void context.result.then(value => { earlyResult = value; });
        await waitFor(() => (existsSync(pidFile) && existsSync(heartbeat)) || earlyResult !== undefined, 'parent/child launched');
        if (earlyResult) throw new Error(`Execution ended before launch: ${JSON.stringify(earlyResult)}`);
        expect(earlyResult).toBeUndefined();
        pids = JSON.parse(readFileSync(pidFile, 'utf8'));
        expect(alive(pids[1]!)).toBe(true);
        if (mode === 'orphan') {
          await waitFor(() => !alive(pids[0]!), 'parent exited');
          const before = statSync(heartbeat).size;
          await waitFor(() => statSync(heartbeat).size > before, 'orphan still writes');
          let completed = false; void context.result.then(() => { completed = true; });
          await new Promise(resolve => setTimeout(resolve, 30));
          expect(completed).toBe(false);
        }
        if (['cancel', 'orphan', 'unconfirmed'].includes(mode)) await f.service.cancel(f.identity);
        const completion = await context.completion;
        const unconfirmed = mode === 'unconfirmed';
        expect(completion).toMatchObject({ persisted: true, stopConfirmed: !unconfirmed, retained: !unconfirmed });
        await waitFor(() => pids.every(pid => !alive(pid)), 'all controlled processes absent');
        const size = statSync(heartbeat).size;
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(statSync(heartbeat).size).toBe(size);
        expect(existsSync(join(f.workspace.canonicalPath, 'must-not-exist'))).toBe(false);
        expect(f.resources.read(f.identity).leases).toHaveLength(unconfirmed ? 3 : 0);
        expect(f.query('SELECT status FROM attempts')).toEqual({ status: unconfirmed ? 'interrupted'
          : ['cancel', 'orphan'].includes(mode) ? 'cancelled' : 'failed' });
        const row = f.query('SELECT result_ref FROM sessions') as { result_ref: string };
        const evidence = await f.readArtifact(row.result_ref);
        expect(evidence.control.reason).toBe(['cancel', 'orphan', 'unconfirmed'].includes(mode) ? 'user_cancelled' : mode);
        expect(evidence.execution.result.usage).toEqual({ basis: 'synthetic', inputTokens: 17, outputTokens: null, costUsdMicros: null });
        expect(evidence.execution.result.durationMs).toBeNull();
        if (evidence.recording.manifestRef) expect(await f.readArtifact(evidence.recording.manifestRef)).toBeTruthy();
        else expect(evidence.recording.gaps.length).toBeGreaterThan(0);
        expect((await f.verifier.verifyArtifact(f.projectId, f.requirementArtifactId)).kind).toBe('verified_ready');
        if (unconfirmed) expect((await f.service.close()).closed).toBe(false);
      } finally {
        await f.dispose();
        expect(pids.every(pid => !alive(pid))).toBe(true);
      }
    }, 15_000,
  );

  it('real command completion racing cancellation saves exactly one settlement', async () => {
    const f = await fixture({ script: { schemaVersion: 1, steps: [{ op: 'tool_command', name: 'finish' }] },
      toolCommands: { finish: { argv: [process.execPath, '-e', 'setTimeout(()=>process.exit(0),80)'], timeoutMs: 5_000 } } });
    try {
      const { context } = await f.start();
      await context.result;
      const [completion] = await Promise.all([context.completion, f.service.cancel(f.identity), f.service.cancel(f.identity)]);
      expect(completion).toMatchObject({ stopConfirmed: true, persisted: true });
      expect(f.query('SELECT count(*) AS n FROM attempt_notifications')).toEqual({ n: 1 });
      expect(['cancelled', 'verifying']).toContain((f.query('SELECT status FROM attempts') as { status: string }).status);
      expect(f.query("SELECT count(*) AS n FROM tasks WHERE status = 'passed'")).toEqual({ n: 0 });
      expect(f.retain.mock.calls.length).toBeLessThanOrEqual(1);
      expect((await f.service.close()).closed).toBe(true);
    } finally { await f.dispose(); }
  });

  it('different Tasks have independent cancellation signals', async () => {
    const a = await fixture(), b = await fixture({}, {}, undefined, 't-2');
    try {
      const [{ context: first }, { context: second }] = await Promise.all([a.start(), b.start()]);
      await a.service.cancel(a.identity);
      expect(first.controller.signal.aborted).toBe(true);
      expect(second.controller.signal.aborted).toBe(false);
      expect(b.cancel).not.toHaveBeenCalled();
      expect(b.query('SELECT status FROM attempts')).toEqual({ status: 'preparing' });
      await b.service.cancel(b.identity);
      expect(second.controller.signal.aborted).toBe(true);
    } finally { await Promise.all([a.dispose(), b.dispose()]); }
  });
});
