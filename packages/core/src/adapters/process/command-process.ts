/** F-009 macOS adapter. No database imports; Core supplies the durable-commit callback. */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandProcessError } from '../../ports/command-process.js';
import type {
  CommandProcessPort, CommandProcessRequest, CommandProcessIdentity, CommandProcessOutput,
  CommandProcessReason, CommandProcessResult, CommandProcessStop, CommandProcessSnapshot,
} from '../../ports/command-process.js';

const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const BUFFER_LIMIT = 65_536;
const HANDSHAKE_MS = 5_000;
const STOP_MS = 10_000;

function validate(input: unknown): CommandProcessRequest {
  const bad = (): never => { throw new CommandProcessError('invalid_input'); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad();
  const r = input as CommandProcessRequest;
  const keys = ['argv', 'cwd', 'environment', 'stdin', 'timeoutMs', 'maxInputBytes', 'maxOutputBytes'];
  if (Object.keys(input).some((key) => !keys.includes(key))) return bad();
  const text = (s: unknown): s is string => typeof s === 'string' && !s.includes('\0');
  if (!Array.isArray(r.argv) || !r.argv.length || r.argv.length > 256
      || r.argv.some((s) => !text(s)) || !r.argv[0].length
      || !text(r.cwd) || !isAbsolute(r.cwd)) return bad();
  if (!r.environment || typeof r.environment !== 'object' || Array.isArray(r.environment)
      || Object.entries(r.environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !text(value))) return bad();
  for (const [value, max] of [[r.timeoutMs, 3_600_000], [r.maxInputBytes, 65_536], [r.maxOutputBytes, 8_388_608]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) return bad();
  }
  if (r.stdin !== undefined && !(r.stdin instanceof Uint8Array)) return bad();
  // macOS may add __CF_USER_TEXT_ENCODING (OS locale metadata) despite the explicit env.
  const environment = { PATH: SYSTEM_PATH, ...r.environment };
  const argv = [...r.argv];
  const bytes = Buffer.byteLength(JSON.stringify({ argv, cwd: r.cwd, environment })) + (r.stdin?.byteLength ?? 0);
  if (bytes > r.maxInputBytes) return bad();
  // Snapshot before any await: callers cannot change an authorized launch during commit.
  return { ...r, argv, environment, stdin: r.stdin ? new Uint8Array(r.stdin) : undefined };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function ps(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', args, { env: { PATH: SYSTEM_PATH, LC_ALL: 'C' },
      timeout: 1_000, maxBuffer: 1_048_576 }, (error, stdout) => {
      if (error) reject(new CommandProcessError('handshake_failed'));
      else resolve(stdout);
    });
  });
}
async function identify(pid: number, launchId: string): Promise<CommandProcessIdentity> {
  const value = await ps(['-p', String(pid), '-o', 'pid=,pgid=,lstart=,command=']);
  const match = value.trim().match(/^(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  if (!match || Number(match[1]) !== pid || Number(match[2]) !== pid || !match[4].endsWith(` ${launchId}`)) {
    throw new CommandProcessError('handshake_failed');
  }
  return Object.freeze({ launchId, pid, processGroupId: pid, startTime: match[3] });
}
async function groupAbsent(groupId: number): Promise<boolean> {
  const rows = await ps(['-axo', 'pid=,pgid=']);
  return !rows.trim().split('\n').some((row) => Number(row.trim().split(/\s+/)[1]) === groupId);
}

/** Trusted assembly option only; never request-controlled platform capability negotiation. */
export function createCommandProcessAdapter(options: { platform?: string } = {}): CommandProcessPort {
  return {
    async start(input, confirm, signal) {
      if ((options.platform ?? process.platform) !== 'darwin' || process.platform !== 'darwin') {
        throw new CommandProcessError('unsupported_platform');
      }
      const request = validate(input);
      if (typeof confirm !== 'function') throw new CommandProcessError('invalid_input');
      if (signal?.aborted) throw new CommandProcessError('start_aborted');
      const launchId = randomUUID();
      const built = new URL('./command-supervisor.js', import.meta.url);
      // Source execution for Node 22/Vitest; distribution uses the compiled .js sibling.
      const entry = existsSync(built) ? built : new URL('./command-supervisor.ts', import.meta.url);
      const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(entry), launchId], {
        cwd: request.cwd, env: { PATH: SYSTEM_PATH }, detached: true, shell: false,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
      const ready = deferred<void>();
      const startupFailure = deferred<never>();
      // All rejections are observed even if they happen before a race is installed.
      void startupFailure.promise.catch(() => {});
      void ready.promise.catch(() => {});
      const closed = deferred<void>();
      const result = deferred<CommandProcessResult>();
      const stopped = deferred<CommandProcessStop>();
      let identity: CommandProcessIdentity;
      let released = false;
      let finished = false;
      let childClosed = false;
      let reason: CommandProcessReason | null = null;
      let commandOutcome: { exitCode: number | null; signal: string | null; reason: CommandProcessReason | null } | undefined;
      let state: CommandProcessSnapshot['state'] = 'running';
      let outputBytes = 0;
      let buffered = 0;
      let waiter: (() => void) | undefined;
      const queue: CommandProcessOutput[] = [];
      let runtimeTimer: NodeJS.Timeout | undefined;
      let stopTimer: NodeJS.Timeout | undefined;
      let verification: Promise<void> | undefined;
      let consumerTaken = false;
      const wake = () => { waiter?.(); waiter = undefined; };
      const streams = [child.stdout!, child.stderr!];
      const resume = () => streams.forEach((s) => s.resume());
      const stop = (why: CommandProcessReason) => {
        if (finished || state === 'stopping') return;
        reason = why;
        state = 'stopping';
        clearTimeout(runtimeTimer);
        if (child.connected) child.send({ type: 'cancel', launchId }, () => {});
        // Draining on stop avoids a pipe backpressure deadlock. Retained data remains bounded.
        resume();
        stopTimer = setTimeout(() => { void finish(); }, STOP_MS);
      };
      const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        if (finished) return;
        const keep = Math.min(chunk.length, request.maxOutputBytes - outputBytes);
        if (keep > 0 && (state !== 'stopping' || buffered < BUFFER_LIMIT)) {
          queue.push({ stream, bytes: new Uint8Array(chunk.subarray(0, keep)) });
          buffered += keep;
          outputBytes += keep;
          wake();
        }
        if (chunk.length > keep) stop('output_overflow');
        if (state === 'running' && buffered >= BUFFER_LIMIT) streams.forEach((s) => s.pause());
      };
      child.stdout!.on('data', (chunk: Buffer) => capture('stdout', chunk));
      child.stderr!.on('data', (chunk: Buffer) => capture('stderr', chunk));
      child.stdin!.on('error', () => {}); // EPIPE is reflected by command result, not an unhandled event.
      const abort = () => {
        if (!released) startupFailure.reject(new CommandProcessError('start_aborted'));
        else stop('cancelled');
      };
      signal?.addEventListener('abort', abort, { once: true });
      const finish = (): Promise<void> => {
        if (verification) return verification;
        verification = (async () => {
          let confirmed = false;
          try { confirmed = child.pid !== undefined && await groupAbsent(child.pid); } catch { /* uncertain */ }
          finished = true;
          clearTimeout(runtimeTimer);
          clearTimeout(stopTimer);
          signal?.removeEventListener('abort', abort);
          state = confirmed ? 'stopped' : 'uncertain';
          const stopResult = { confirmed };
          stopped.resolve(stopResult);
          result.resolve({ exitCode: commandOutcome?.exitCode ?? null, signal: commandOutcome?.signal ?? null,
            reason: reason ?? commandOutcome?.reason ?? (commandOutcome ? null : 'supervisor_lost'),
            outputBytes, stop: stopResult });
          resume();
          wake();
        })();
        return verification;
      };
      child.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const m = message as Record<string, unknown>;
        if (m.launchId !== launchId) return;
        if (m.type === 'ready' && m.pid === child.pid && m.processGroupId === child.pid) ready.resolve();
        if (m.type === 'result' && released && !commandOutcome) {
          const validReason = m.reason === null || ['missing_command', 'permission_denied', 'spawn_failed'].includes(String(m.reason));
          if ((m.exitCode === null || Number.isInteger(m.exitCode)) && (m.signal === null || typeof m.signal === 'string') && validReason) {
            commandOutcome = { exitCode: m.exitCode as number | null, signal: m.signal as string | null,
              reason: m.reason as CommandProcessReason | null };
          }
        }
      });
      child.on('error', () => startupFailure.reject(new CommandProcessError('handshake_failed')));
      child.on('close', () => {
        childClosed = true;
        closed.resolve();
        if (!released) startupFailure.reject(new CommandProcessError('handshake_failed'));
        else void finish();
      });
      const handshakeTimer = setTimeout(() => startupFailure.reject(new CommandProcessError('handshake_failed')), HANDSHAKE_MS);
      try {
        await Promise.race([ready.promise, startupFailure.promise]);
        if (child.pid === undefined) throw new CommandProcessError('handshake_failed');
        identity = await Promise.race([identify(child.pid, launchId), startupFailure.promise]);
        const acknowledgement = await Promise.race([
          Promise.resolve().then(() => confirm(identity)).catch(() => { throw new CommandProcessError('confirmation_failed'); }),
          startupFailure.promise,
        ]);
        if (!acknowledgement || acknowledgement.launchId !== launchId) throw new CommandProcessError('confirmation_failed');
        if (signal?.aborted || childClosed || !child.connected) throw new CommandProcessError('start_aborted');
        // No command input crosses into the supervisor until the durable Core acknowledgement.
        released = true;
        runtimeTimer = setTimeout(() => stop('timed_out'), request.timeoutMs);
        child.send({ type: 'release', launchId, argv: request.argv, cwd: request.cwd, environment: request.environment },
          (error) => { if (error) stop('supervisor_lost'); });
        child.stdin!.end(request.stdin);
      } catch (error) {
        signal?.removeEventListener('abort', abort);
        child.stdin!.destroy();
        resume();
        if (!childClosed) child.kill('SIGTERM');
        let killTimer: NodeJS.Timeout | undefined;
        const killed = new Promise<void>((resolve) => {
          killTimer = setTimeout(() => { if (!childClosed) child.kill('SIGKILL'); resolve(); }, 1_000);
        });
        await Promise.race([closed.promise, killed]);
        clearTimeout(killTimer);
        // Wait for the tracked child to close after escalation, with a finite confirmation budget.
        let waitTimer: NodeJS.Timeout | undefined;
        await Promise.race([closed.promise, new Promise<void>((resolve) => { waitTimer = setTimeout(resolve, 1_000); })]);
        clearTimeout(waitTimer);
        let absent = false;
        try { absent = child.pid === undefined || await groupAbsent(child.pid); } catch { /* uncertain */ }
        if (!absent) throw new CommandProcessError('stop_unconfirmed');
        throw error instanceof CommandProcessError ? error : new CommandProcessError('handshake_failed');
      } finally {
        clearTimeout(handshakeTimer);
      }
      return {
        identity,
        result: result.promise,
        stopped: stopped.promise,
        query: () => ({ identity, state, bufferedOutputBytes: buffered }),
        cancel: async () => { stop('cancelled'); return { accepted: true }; },
        output: {
          async *[Symbol.asyncIterator]() {
            if (consumerTaken) throw new TypeError('CommandProcess.output requires a single consumer');
            consumerTaken = true;
            try {
              while (!finished || queue.length) {
                const chunk = queue.shift();
                if (chunk) {
                  buffered -= chunk.bytes.length;
                  if (buffered < BUFFER_LIMIT) resume();
                  yield chunk;
                } else {
                  await new Promise<void>((resolve) => { waiter = resolve; });
                }
              }
            } finally {
              if (!finished) stop('consumer_closed');
            }
          },
        },
      };
    },
  };
}
