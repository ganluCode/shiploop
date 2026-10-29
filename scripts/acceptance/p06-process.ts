/** P06-owned subprocesses. Every stop revalidates ancestry and start/argv identity. */
import { execFileSync, spawn } from 'node:child_process';
import { OwnedProcessTree } from './owned-process-tree.ts';
import type { P02BoundedRunOptions, P02BoundedRunOutcome } from './p02-accept.ts';

function collector(limit: number) {
  let bytes = 0, kept = 0;
  const chunks: Buffer[] = [];
  return {
    push(chunk: Buffer) { bytes += chunk.length; const slice = chunk.subarray(0, Math.max(0, limit - kept)); if (slice.length) { chunks.push(slice); kept += slice.length; } },
    get text() { return Buffer.concat(chunks).toString('utf8'); },
    get bytes() { return bytes; }, get truncated() { return bytes > limit; },
  };
}
export function runP06Process(command: string, args: readonly string[], options: P02BoundedRunOptions): Promise<P02BoundedRunOutcome> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) throw new Error('invalid_process_budget');
  return new Promise(resolve => {
    const started = Date.now(), stdout = collector(options.maxOutputBytes), stderr = collector(options.maxOutputBytes);
    let timedOut = false, settled = false, spawnError: string | null = null;
    let tree: OwnedProcessTree | undefined, timer: ReturnType<typeof setTimeout> | undefined, grace: ReturnType<typeof setTimeout> | undefined;
    const finish = async (kind: P02BoundedRunOutcome['kind'], exitCode: number | null, signal: string | null, closed: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(grace);
      // Success also requires descendants to stop. A detached writer must not survive a zero exit.
      const stopped = await (tree?.finish(true) ?? Promise.resolve(true));
      let groupGone = child.pid === undefined;
      if (child.pid !== undefined) {
        try {
          const rows = execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
          groupGone = !rows.split('\n').some(line => { const m = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line); return m && Number(m[2]) === child.pid && !m[3].startsWith('Z'); });
        } catch { groupGone = false; }
      }
      resolve({ kind, exitCode, signal, timedOut, durationMs: Date.now() - started, stdout: stdout.text, stderr: stderr.text,
        stdoutBytes: stdout.bytes, stderrBytes: stderr.bytes, stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated,
        spawnError, stoppedVerified: closed && stopped && groupGone });
    };
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env ?? {}, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    tree = new OwnedProcessTree(child.pid);
    child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', () => { spawnError = 'process_spawn_failed'; });
    child.on('close', (code, signal) => { void finish(timedOut ? 'timeout' : spawnError ? 'spawn_error' : signal ? 'signal' : 'exit', timedOut ? null : code, signal, true); });
    timer = setTimeout(() => {
      timedOut = true;
      const snapshot = tree!.snapshot();
      // Never reacquire an exited root or kill a process group based only on a stale PID.
      if (snapshot.scanConfirmed && snapshot.identities.some(row => row.pid === child.pid && row.alive)) {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Identity-tracked descendants are stopped individually below. */ }
      }
      tree!.kill();
      grace = setTimeout(() => { void finish('timeout', null, null, false); }, 2000);
    }, options.timeoutMs);
  });
}
