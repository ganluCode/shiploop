/** F-009/F-010 macOS adapter. No database imports; Core supplies the durable-commit callback. */
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
import { confirmGroupAbsence, forceStopControlledGroup, matchesSupervisorIdentity } from './stop-escalation.js';
import type { StopEscalationBudgets, StopEscalationProbe, SupervisedProcessRow } from './stop-escalation.js';

const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const BUFFER_LIMIT = 65_536;
const HANDSHAKE_MS = 5_000;
/** F-010 取消/超时共用的有界停止路径预算（§13；supervisor 5s SIGTERM 升级之上的 Host 兜底宽限）。 */
const DEFAULT_STOP_GRACE_MS = 10_000;
const DEFAULT_STOP_CONFIRM_MS = 5_000;
const GROUP_POLL_MS = 50;
const STOP_GRACE_BOUNDS: readonly [number, number] = [100, DEFAULT_STOP_GRACE_MS];
const STOP_CONFIRM_BOUNDS: readonly [number, number] = [100, DEFAULT_STOP_CONFIRM_MS];

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
function parseSupervisorRow(stdout: string, pid: number): SupervisedProcessRow | null {
  const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  if (!match || Number(match[1]) !== pid) return null;
  return Object.freeze({ pid: Number(match[1]), processGroupId: Number(match[2]), startTime: match[3], command: match[4] });
}
async function identify(pid: number, launchId: string): Promise<CommandProcessIdentity> {
  const row = parseSupervisorRow(await ps(['-p', String(pid), '-o', 'pid=,pgid=,lstart=,command=']), pid);
  if (!row || row.processGroupId !== pid) throw new CommandProcessError('handshake_failed');
  const identity: CommandProcessIdentity = Object.freeze({ launchId, pid, processGroupId: row.processGroupId, startTime: row.startTime });
  if (!matchesSupervisorIdentity(row, identity)) throw new CommandProcessError('handshake_failed');
  return identity;
}
async function groupAbsent(groupId: number): Promise<boolean> {
  const rows = await ps(['-axo', 'pid=,pgid=']);
  return !rows.trim().split('\n').some((row) => Number(row.trim().split(/\s+/)[1]) === groupId);
}
/** F-010 生产停止探测：真实 /bin/ps 身份行、成员清点、受控组信号与延时。 */
const realStopProbe: StopEscalationProbe = {
  async readSupervisorRow(pid) {
    try {
      // ps -p exits nonzero for an absent PID; a successful full census distinguishes
      // absence from a failed probe without treating either failure as an empty group.
      const rows = await ps(['-axo', 'pid=,pgid=,lstart=,command=']);
      const line = rows.split('\n').find(line => Number(line.trim().split(/\s+/)[0]) === pid);
      return line === undefined ? null : parseSupervisorRow(line, pid) ?? undefined;
    } catch {
      return undefined;
    }
  },
  async listGroupMembers(processGroupId) {
    try {
      const rows = await ps(['-axo', 'pid=,pgid=']);
      const members: number[] = [];
      for (const row of rows.trim().split('\n')) {
        const columns = row.trim().split(/\s+/);
        if (columns.length >= 2 && Number(columns[1]) === processGroupId) members.push(Number(columns[0]));
      }
      return members;
    } catch {
      return undefined;
    }
  },
  signalGroup(processGroupId, signal) {
    try {
      process.kill(-processGroupId, signal);
      return true;
    } catch {
      return false;
    }
  },
  delay: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
};

/** 可信装配选项：平台核对与有界停止预算/探测注入（不得放宽冻结上限）。 */
export interface CommandProcessAdapterOptions {
  readonly platform?: string;
  /** 停止宽限（先请求正常停止后的 Host 兜底窗口；默认 10s，上限即冻结默认）。 */
  readonly stopGraceMs?: number;
  /** 升级/收尾后的确认停止预算（默认 5s，§13）。 */
  readonly stopConfirmMs?: number;
  /** 注入停止探测（可信装配/确定性测试；默认真实 /bin/ps 与 kill）。 */
  readonly stopProbe?: StopEscalationProbe;
}

/**
 * Trusted assembly option only; never request-controlled platform capability negotiation.
 * F-010: cancel/timeout/output-overflow/consumer-close all funnel into ONE bounded stop
 * path: request graceful stop (supervisor SIGTERMs the controlled group), then after the
 * grace budget re-verify the committed identity and force-kill the whole controlled group,
 * then confirm group absence within a bounded budget; probe failures never count as
 * stopped (confirmed=false keeps Core occupancy retained, §8.3).
 */
export function createCommandProcessAdapter(options: CommandProcessAdapterOptions = {}): CommandProcessPort {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createCommandProcessAdapter: options 必须是对象');
  }
  for (const [name, value, bounds] of [
    ['stopGraceMs', options.stopGraceMs, STOP_GRACE_BOUNDS],
    ['stopConfirmMs', options.stopConfirmMs, STOP_CONFIRM_BOUNDS],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < bounds[0] || value > bounds[1])) {
      throw new TypeError(`createCommandProcessAdapter: ${name} 必须是 ${bounds[0]}..${bounds[1]} 的整数（冻结停止预算上限）`);
    }
  }
  const stopProbe = options.stopProbe;
  if (stopProbe !== undefined && (stopProbe === null || typeof stopProbe !== 'object'
      || typeof stopProbe.readSupervisorRow !== 'function'
      || typeof stopProbe.listGroupMembers !== 'function'
      || typeof stopProbe.signalGroup !== 'function'
      || typeof stopProbe.delay !== 'function')) {
    throw new TypeError('createCommandProcessAdapter: stopProbe 必须实现受监督停止探测接口');
  }
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const stopBudgets: StopEscalationBudgets = { confirmMs: options.stopConfirmMs ?? DEFAULT_STOP_CONFIRM_MS, pollMs: GROUP_POLL_MS };
  const probe: StopEscalationProbe = stopProbe ?? realStopProbe;
  return {
    async recoverStop(input) {
      if (process.platform !== 'darwin' || !input || typeof input !== 'object') return { confirmed: false };
      const id = input as CommandProcessIdentity;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id.launchId) ||
          !Number.isSafeInteger(id.pid) || id.pid <= 1 || id.processGroupId !== id.pid ||
          typeof id.startTime !== 'string' || !id.startTime.length) return { confirmed: false };
      const deadline = Date.now() + stopBudgets.confirmMs;
      for (;;) {
        const outcome = await forceStopControlledGroup(id, probe, {
          ...stopBudgets, confirmMs: Math.max(0, deadline - Date.now()),
        });
        if (outcome.confirmed) return { confirmed: true };
        // IPC loss may race ps with the supervisor's final exit (command becomes
        // '(node)'). Never signal that mismatched row; wait for a successful absence
        // census instead. A reused/live unrelated PID remains unconfirmed.
        if (Date.now() >= deadline) return { confirmed: false };
        await probe.delay(GROUP_POLL_MS);
      }
    },
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
      let droppedOutputBytes = 0;
      let buffered = 0;
      let waiter: (() => void) | undefined;
      const queue: CommandProcessOutput[] = [];
      let runtimeTimer: NodeJS.Timeout | undefined;
      let stopTimer: NodeJS.Timeout | undefined;
      let conclusion: Promise<void> | undefined;
      let consumerTaken = false;
      const wake = () => { waiter?.(); waiter = undefined; };
      const streams = [child.stdout!, child.stderr!];
      const resume = () => streams.forEach((s) => s.resume());
      const stop = (why: CommandProcessReason) => {
        // First stop reason wins: user cancel vs timed_out stay distinct through the
        // shared path; late/old handle requests are idempotent no-ops.
        if (finished || state === 'stopping' || conclusion) return;
        reason = why;
        state = 'stopping';
        clearTimeout(runtimeTimer);
        if (child.connected) child.send({ type: 'cancel', launchId }, () => {});
        // Draining on stop avoids a pipe backpressure deadlock. Retained data remains bounded.
        resume();
        stopTimer = setTimeout(() => { void conclude(true); }, stopGraceMs);
      };
      const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        if (finished) return;
        const remaining = Math.min(chunk.length, request.maxOutputBytes - outputBytes);
        const keep = state === 'stopping' && buffered >= BUFFER_LIMIT ? 0 : remaining;
        droppedOutputBytes += chunk.length - keep;
        if (keep > 0) {
          queue.push({ stream, bytes: new Uint8Array(chunk.subarray(0, keep)) });
          buffered += keep;
          outputBytes += keep;
          wake();
        }
        if (chunk.length > remaining) stop('output_overflow');
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
      const conclude = (escalate: boolean): Promise<void> => {
        if (conclusion) return conclusion;
        clearTimeout(runtimeTimer);
        clearTimeout(stopTimer);
        conclusion = (async () => {
          // F-010 shared bounded stop tail: graceful request already went out with stop().
          // escalate=true（宽限期满）：核对持久提交的身份，一致才 SIGKILL 整个
          // 受控组，再在确认预算内核验缺席；身份探测失败/PID 复用 → 不发信号且
          // confirmed=false。escalate=false（监督者已退出）：仅核验组成员缺席。
          const outcome = escalate
            ? await forceStopControlledGroup(identity, probe, stopBudgets)
            : await confirmGroupAbsence(identity, probe, stopBudgets).then((confirmed) => (
                { confirmed, escalated: false, identity: 'absent' as const }));
          finished = true;
          signal?.removeEventListener('abort', abort);
          state = outcome.confirmed ? 'stopped' : 'uncertain';
          const stopResult = Object.freeze({ confirmed: outcome.confirmed });
          stopped.resolve(stopResult);
          result.resolve({ exitCode: commandOutcome?.exitCode ?? null, signal: commandOutcome?.signal ?? null,
            reason: reason ?? commandOutcome?.reason ?? (commandOutcome ? null : 'supervisor_lost'),
            outputBytes, droppedOutputBytes, stop: stopResult });
          resume();
          wake();
        })();
        return conclusion;
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
        else void conclude(false);
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
