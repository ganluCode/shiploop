import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../../helpers/p03-6/stopping-fixture.ts';
import { DEFAULT_RECORDER_LIMITS } from '../../helpers/p03-6/evidence-fixture.ts';
import { createWorkEvidenceRecorder } from '../../../packages/core/src/application/work-evidence-recorder.ts';
import { git } from '../../helpers/git-repo.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

// The process writes its own readiness marker. Business completion and OS cleanup
// use separate finite observations; neither success assertion can consume the other.
describe.skipIf(process.platform !== 'darwin')('P07-2 F-005 真实受控写入者与停止证明', () => {
  for (const acceptOnly of [false, true]) {
    it(`[case:writer-${acceptOnly ? 'unconfirmed' : 'stopped'}] 记录超限后保留代码；取消接受不释放仍在写入的进程占用`, async () => {
      const failure = gate();
      const f = await fixture({ script: { schemaVersion: 1, steps: [
        { op: 'usage', inputTokens: 7, outputTokens: null, costUsdMicros: null },
        { op: 'tool_command', name: 'writer' },
        { op: 'write_file', path: 'must-not-run', content: 'bad' },
      ], ...(acceptOnly ? { lifecycle: { cancel: { acceptOnly: true } } } : {}) },
      toolCommands: { writer: { argv: [process.execPath, '-e',
        "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync('writer.pid',String(process.pid));fs.appendFileSync('heartbeat','x');setInterval(()=>fs.appendFileSync('heartbeat','x'),10)"], timeoutMs: 30_000 } },
      }, {}, (binding, deps) => {
        const recorder = createWorkEvidenceRecorder({ publisher: binding.publisher, verifier: binding.verifier, sessions: deps.sessions,
          limits: { ...DEFAULT_RECORDER_LIMITS, chunkMaxEvents: 1, maxTotalEvents: 1, tailWaitMs: 100 } });
        Object.assign(deps, { recorder: { async record(input: unknown) { await failure.promise; return recorder.record(input); } } });
        Object.assign(deps.supervision!, { stopWaitMs: acceptOnly ? 80 : 2000, drainWaitMs: 300, closeWaitMs: 150 });
      });
      let pid: number | undefined;
      try {
        const tracked = join(f.workspace.canonicalPath, 'README.md'), untracked = join(f.workspace.canonicalPath, 'kept.bin');
        writeFileSync(tracked, 'partial tracked code'); writeFileSync(untracked, Buffer.from([0, 255, 7]));
        const head = git(['rev-parse', 'HEAD'], f.workspace.canonicalPath);
        const { context } = await f.start();
        const marker = join(f.workspace.canonicalPath, 'writer.pid'), heartbeat = join(f.workspace.canonicalPath, 'heartbeat');
        await expect.poll(() => existsSync(marker) && existsSync(heartbeat), { timeout: 5000 }).toBe(true);
        pid = Number(readFileSync(marker, 'utf8'));
        expect(alive(pid)).toBe(true);
        failure.release();
        const businessStart = performance.now();
        const completion = await context.completion;
        expect(performance.now() - businessStart).toBeLessThan(3000);
        expect(completion).toMatchObject({ persisted: true, stopConfirmed: !acceptOnly, retained: !acceptOnly,
          error: acceptOnly ? 'cleanup_unconfirmed' : null });
        expect(f.cancel).toHaveBeenCalledOnce();
        const ref = f.query('SELECT result_ref FROM sessions') as { result_ref: string };
        const evidence = await f.readArtifact(ref.result_ref);
        expect(evidence).toMatchObject({ control: { reason: 'recording_failed', cancel: 'accepted' },
          recording: { complete: false, failure: 'total_event_limit_exceeded' } });
        expect(f.query('SELECT runtime_starts, attempts_created FROM execution_batches')).toEqual({ runtime_starts: 1, attempts_created: 1 });
        expect(f.query('SELECT count(*) AS n FROM attempt_notifications')).toEqual({ n: 1 });
        expect(f.query('SELECT status FROM attempts')).toEqual({ status: acceptOnly ? 'interrupted' : 'failed' });
        expect(readFileSync(tracked, 'utf8')).toBe('partial tracked code');
        expect(readFileSync(untracked)).toEqual(Buffer.from([0, 255, 7]));
        expect(git(['rev-parse', 'HEAD'], f.workspace.canonicalPath)).toBe(head);
        expect(existsSync(join(f.workspace.canonicalPath, 'must-not-run'))).toBe(false);
        if (acceptOnly) {
          expect(alive(pid)).toBe(true);
          const size = statSync(heartbeat).size;
          await expect.poll(() => statSync(heartbeat).size, { timeout: 1000 }).toBeGreaterThan(size);
          expect(f.resources.read(f.identity).leases.map(row => row.state)).toEqual(['quarantined', 'quarantined', 'quarantined']);
          expect((await f.service.close()).closed).toBe(false);
          // Only the fixture's trusted final cleanup uses the raw handle. Late
          // stop evidence must not retroactively release quarantined resources.
          await f.rawHandles[0]!.cancel();
          await context.stopped;
          expect(f.resources.read(f.identity).leases).toHaveLength(3);
          expect(f.retain).not.toHaveBeenCalled();
        } else {
          expect(f.resources.read(f.identity).leases).toHaveLength(0);
          expect(f.workspaces.readWorkspace(f.projectId, f.featureId)?.status).toBe('retained');
        }
        const cleanupStart = performance.now();
        await expect.poll(() => alive(pid!), { timeout: 3000 }).toBe(false);
        expect(performance.now() - cleanupStart).toBeLessThan(3500);
      } finally {
        failure.release(); await f.dispose();
        if (pid !== undefined) expect(alive(pid), 'cleanup_unconfirmed').toBe(false);
      }
    }, 15_000);
  }
});
