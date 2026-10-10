/**
 * F-009 private macOS supervisor entry, not a library import.
 * Starts in its own session/group. Receives NO project script before Core commit.
 * IPC loss fails closed before release and stops the controlled group afterwards.
 * A process deliberately creating a new session/group can escape: trusted projects only.
 */
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

const launchId = process.argv[2];
if (process.platform !== 'darwin' || !process.send || !/^[0-9a-f-]{36}$/.test(launchId ?? '')) {
  process.exit(1);
}
let released = false;
let stopping = false;
let child: ChildProcess | undefined;
let completed = false;
let finishing = false;
let probing = false;
let outcome: { exitCode: number | null; signal: string | null; reason: string | null } | undefined;
let poll: NodeJS.Timeout | undefined;
let escalation: NodeJS.Timeout | undefined;

function send(message: object): void {
  if (process.connected) process.send?.({ ...message, launchId }, (error) => { if (error) stop(); });
}
function stop(): void {
  if (stopping || finishing) return;
  stopping = true;
  clearTimeout(handshake);
  if (!released) {
    process.disconnect?.();
    process.exitCode = 1;
    return;
  }
  // SIGTERM handler below keeps the supervisor alive while command children stop.
  try { process.kill(-process.pid, 'SIGTERM'); } catch { /* Host independently verifies absence. */ }
  escalation = setTimeout(() => {
    try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exitCode = 1; }
  }, 5_000);
  if (completed) void checkGroup();
}
function checkGroup(): void {
  if (!completed || finishing || probing) return;
  clearTimeout(poll);
  probing = true;
  // ps is a trusted short-lived helper, not a workload descendant. Exclude this probe PID.
  const probe = execFile('/bin/ps', ['-axo', 'pid=,pgid='], {
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', __CF_USER_TEXT_ENCODING: '0x0:0:0' }, timeout: 1_000, maxBuffer: 1_048_576,
  }, (error, stdout) => {
    probing = false;
    if (finishing) return;
    if (error) { stop(); return; } // Never infer stopped from a failed probe.
    const others = stdout.trim().split('\n').some((line) => {
      const [pid, group] = line.trim().split(/\s+/).map(Number);
      return group === process.pid && pid !== process.pid && pid !== probe.pid;
    });
    if (others) {
      poll = setTimeout(checkGroup, 50);
      return;
    }
    clearTimeout(escalation);
    clearTimeout(poll);
    finishing = true;
    send({ type: 'result', ...outcome });
    // Do not process.exit(): allow pipe buffers and the IPC result to flush.
    if (process.connected) process.disconnect();
    process.exitCode = 0;
  });
}
const handshake = setTimeout(stop, 5_000);
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object') return stop();
  const m = message as Record<string, unknown>;
  if (m.launchId !== launchId) return stop();
  if (m.type === 'cancel') return stop();
  if (m.type !== 'release' || released || stopping) return stop();
  // This is a private IPC channel owned by the adapter, not a public JSON endpoint.
  if (!Array.isArray(m.argv) || m.argv.length === 0 || typeof m.cwd !== 'string'
      || !m.environment || typeof m.environment !== 'object') return stop();
  released = true;
  clearTimeout(handshake);
  child = spawn(m.argv[0] as string, m.argv.slice(1) as string[], {
    cwd: m.cwd, env: m.environment as Record<string, string>, shell: false,
    detached: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout!.pipe(process.stdout);
  child.stderr!.pipe(process.stderr);
  process.stdin.pipe(child.stdin!);
  child.stdin!.on('error', () => { /* EPIPE is normal when a command does not read stdin. */ });
  let spawnReason: string | null = null;
  child.on('error', (error: NodeJS.ErrnoException) => {
    spawnReason = error.code === 'ENOENT' ? 'missing_command'
      : error.code === 'EACCES' || error.code === 'EPERM' ? 'permission_denied' : 'spawn_failed';
  });
  child.on('exit', (exitCode, signal) => {
    outcome = { exitCode, signal, reason: spawnReason };
    completed = true;
    void checkGroup();
  });
  child.on('close', (exitCode, signal) => {
    if (completed) return;
    outcome = { exitCode: spawnReason ? null : exitCode, signal, reason: spawnReason };
    completed = true;
    void checkGroup();
  });
});
send({ type: 'ready', pid: process.pid, processGroupId: process.pid });
