/** P07 argv runner: cancellation, output limits and owned-tree cleanup have finite budgets. */
import { execFileSync, spawn } from 'node:child_process';
import { OwnedProcessTree } from './owned-process-tree.ts';
import type { P02BoundedRunOptions, P02BoundedRunOutcome } from './p02-accept.ts';
export type P07ProcessOptions = P02BoundedRunOptions & { signal?: AbortSignal };
export type P07ProcessRunner = (command: string, args: readonly string[], options: P07ProcessOptions) => Promise<P02BoundedRunOutcome>;
const empty = (kind: P02BoundedRunOutcome['kind']): P02BoundedRunOutcome => ({ kind, exitCode: null, signal: null,
  durationMs: 0, timedOut: false, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
  stdoutBytes: 0, stderrBytes: 0, spawnError: null, stoppedVerified: true });
export const runP07Process: P07ProcessRunner = (command, args, options) => {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) throw new Error('invalid_process_budget');
  if (options.signal?.aborted) return Promise.resolve({ ...empty('signal'), signal: 'SIGINT' });
  return new Promise(resolve => {
    const started = Date.now();
    const collect = () => {
      let bytes = 0, kept = 0; const chunks: Buffer[] = [];
      return { push(chunk: Buffer) { bytes += chunk.length; const part = chunk.subarray(0, Math.max(0, options.maxOutputBytes - kept)); if (part.length) { chunks.push(part); kept += part.length; } },
        text: () => Buffer.concat(chunks).toString('utf8'), bytes: () => bytes };
    };
    const stdout = collect(), stderr = collect();
    let timedOut = false, cancelled = false, settled = false, spawnError: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined, grace: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env ?? {}, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const tree = new OwnedProcessTree(child.pid);
    const finish = async (exitCode: number | null, signal: string | null, closed: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(grace); options.signal?.removeEventListener('abort', abort);
      const stopped = await tree.finish(true);
      let groupGone = child.pid === undefined;
      if (child.pid !== undefined) {
        try {
          const rows = execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
          groupGone = !rows.split('\n').some(line => { const m = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line); return m && Number(m[2]) === child.pid && !m[3].startsWith('Z'); });
        } catch { groupGone = false; }
      }
      resolve({ kind: timedOut ? 'timeout' : spawnError ? 'spawn_error' : cancelled || signal ? 'signal' : 'exit',
        exitCode: timedOut || cancelled ? null : exitCode, signal: cancelled ? 'SIGINT' : signal, timedOut,
        durationMs: Date.now() - started, stdout: stdout.text(), stderr: stderr.text(),
        stdoutBytes: stdout.bytes(), stderrBytes: stderr.bytes(), stdoutTruncated: stdout.bytes() > options.maxOutputBytes,
        stderrTruncated: stderr.bytes() > options.maxOutputBytes, spawnError, stoppedVerified: closed && stopped && groupGone });
    };
    const stop = () => {
      if (settled) return;
      const snapshot = tree.snapshot();
      if (snapshot.scanConfirmed && snapshot.identities.some(row => row.pid === child.pid && row.alive)) {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Individually proven descendants below. */ }
      }
      tree.kill();
      grace = setTimeout(() => { void finish(null, null, false); }, 2000);
    };
    const abort = () => { cancelled = true; stop(); };
    child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', () => { spawnError = 'process_spawn_failed'; });
    child.on('close', (code, signal) => { void finish(code, signal, true); });
    timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
};
