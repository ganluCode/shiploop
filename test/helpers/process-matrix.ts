import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCommandProcessAdapter } from '../../packages/core/src/adapters/process/command-process.ts';
import type { CommandProcessAdapterOptions } from '../../packages/core/src/adapters/process/command-process.ts';
import type { CommandProcessHandle, CommandProcessIdentity, CommandProcessResult } from '../../packages/core/src/ports/command-process.ts';
import type { StopEscalationProbe } from '../../packages/core/src/adapters/process/stop-escalation.ts';
import { createTempSandbox } from './temp-sandbox.ts';

export type MatrixStatus = 'pass' | 'unconfirmed' | 'manual_required' | 'not_run';
export interface ProcessRow { pid: number; processGroupId: number; startTime: string; command: string }
export interface CleanupManifest {
  schemaVersion: 1; kind: 'p04-7-process-matrix'; name: string; status: MatrixStatus;
  root: string; manifestPath: string; confirmed: boolean; processesGone: boolean; removed: boolean;
  processes: Array<ProcessRow & { role: string; absent: boolean; exit: CommandProcessResult | null }>;
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
  resources: unknown[]; stops: unknown[]; observations: Array<{ status: MatrixStatus; evidence: unknown }>;
  unconfirmed: string[]; error: string | null;
  live: { status: 'not_run'; reason: string };
}
export const matrixWriter = fileURLToPath(new URL('./process-matrix-writer.mjs', import.meta.url));
export async function processRows(): Promise<ProcessRow[]> {
  const output = await new Promise<string>((resolve, reject) => execFile('/bin/ps', ['-axo', 'pid=,pgid=,lstart=,command='], {
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 1_000, maxBuffer: 4_194_304,
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const rows = output.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), processGroupId: Number(match[2]), startTime: match[3], command: match[4] }] : [];
  });
  if (rows.length === 0) throw new Error('Process census returned no parseable identities');
  return rows;
}

/** Real OS operations with an observable escalation boundary; no synthetic absence. */
export function matrixStopProbe(onSignal: (pgid: number, signal: string) => void): StopEscalationProbe {
  return {
    readSupervisorRow: async pid => (await processRows()).find(row => row.pid === pid) ?? null,
    listGroupMembers: async pgid => (await processRows()).filter(row => row.processGroupId === pgid).map(row => row.pid),
    signalGroup(pgid, signal) {
      onSignal(pgid, signal);
      try { process.kill(-pgid, signal); return true; } catch { return false; }
    },
    delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };
}

/** Inventory only this fixture's files. SQLite is represented by exported table snapshots. */
export function matrixFileInventory(root: string): Array<{ path: string; kind: string; sizeBytes: number; sha256: string | null }> {
  const files: ReturnType<typeof matrixFileInventory> = [];
  function walk(relative: string) {
    for (const file of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, file.name), absolute = join(root, path);
      if (file.isDirectory()) { walk(path); continue; }
      const sqlite = /\.(?:db|sqlite)(?:-wal|-shm)?$/.test(file.name);
      files.push({ path, kind: file.isSymbolicLink() ? 'symlink' : sqlite ? 'sqlite-snapshot-in-resources' : 'file',
        sizeBytes: lstatSync(absolute).size,
        sha256: file.isFile() && !sqlite ? createHash('sha256').update(readFileSync(absolute)).digest('hex') : null });
    }
  }
  walk('');
  return files;
}
export async function until(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await condition()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(`Process matrix deadline: ${label}`);
}

export interface ProcessMatrix {
  root: string;
  manifestPath: string;
  retain(reason: string): void;
  start(mode: 'graceful' | 'stubborn', options?: { timeoutMs?: number; adapter?: CommandProcessAdapterOptions;
    confirm?: (identity: CommandProcessIdentity) => Promise<void> }): Promise<CommandProcessHandle>;
  own(identity: CommandProcessIdentity, handle?: CommandProcessHandle): Promise<void>;
  watch(pid: number, role: string): Promise<void>;
  writersReady(): Promise<void>;
  members(identity: CommandProcessIdentity): Promise<number[]>;
  record(status: MatrixStatus, evidence: unknown): void;
  resource(evidence: unknown): void;
}

/** Evidence lives outside the sandbox. Failure/unknown retains the sandbox; only proved owned objects are removed. */
export async function withProcessMatrix(name: string, run: (matrix: ProcessMatrix) => Promise<void>): Promise<CleanupManifest> {
  const box = createTempSandbox('shiploop-p047-matrix-');
  const root = realpathSync(box.path);
  const evidenceRoot = process.env.SHIPLOOP_PROCESS_MATRIX_EVIDENCE_DIR ?? join(tmpdir(), 'shiploop-process-matrix-evidence');
  mkdirSync(evidenceRoot, { recursive: true });
  const evidenceDir = mkdtempSync(join(evidenceRoot, `${name}-`));
  const manifest: CleanupManifest = {
    schemaVersion: 1, kind: 'p04-7-process-matrix', name, status: 'not_run', root,
    manifestPath: join(evidenceDir, 'cleanup-manifest.json'), confirmed: false, processesGone: false, removed: false,
    processes: [], files: [], resources: [], stops: [], observations: [], unconfirmed: [], error: null,
    live: { status: 'not_run', reason: 'No real model or external notification is used by this matrix.' },
  };
  const owned: Array<{ identity: CommandProcessIdentity; handle?: CommandProcessHandle }> = [];
  const save = () => {
    writeFileSync(manifest.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    // Companion shape used by the existing acceptance cleanup evidence consumers.
    writeFileSync(join(evidenceDir, 'cleanup.json'), JSON.stringify({
      status: manifest.status === 'pass' && manifest.removed ? 'passed' : 'failed', matrixStatus: manifest.status,
      resourcesRemoved: manifest.removed, processTreeStopped: manifest.processesGone,
      processGroupsStopped: manifest.processesGone, retainedRoot: manifest.removed ? null : root,
      failures: [...manifest.unconfirmed, ...(manifest.error ? [manifest.error] : [])], manifestPath: manifest.manifestPath,
    }, null, 2) + '\n');
  };
  const watch = async (pid: number, role: string) => {
    if (manifest.processes.some(entry => entry.pid === pid)) return;
    const row = (await processRows()).find(entry => entry.pid === pid);
    if (!row) throw new Error(`Owned ${role} exited before identity capture`);
    manifest.processes.push({ ...row, role, absent: false, exit: null });
    save();
  };
  const matrix: ProcessMatrix = {
    root, manifestPath: manifest.manifestPath,
    retain(reason) { manifest.unconfirmed.push(reason); save(); },
    async start(mode, options = {}) {
      const port = createCommandProcessAdapter({ stopGraceMs: 200, stopConfirmMs: 2_000, ...options.adapter });
      const handle = await port.start({ argv: [process.execPath, matrixWriter, root, mode], cwd: root, environment: {},
        timeoutMs: options.timeoutMs ?? 15_000, maxInputBytes: 65_536, maxOutputBytes: 65_536 }, async identity => {
        await matrix.own(identity);
        await options.confirm?.(identity);
        return { launchId: identity.launchId };
      });
      owned.find(entry => entry.identity.launchId === handle.identity.launchId)!.handle = handle;
      return handle;
    },
    async own(identity, handle) {
      const existing = owned.find(entry => entry.identity.launchId === identity.launchId);
      if (existing) existing.handle ??= handle;
      else owned.push({ identity, handle });
      await watch(identity.pid, 'supervisor');
    },
    watch,
    async writersReady() {
      for (const role of ['parent', 'child', 'grandchild']) {
        await until(() => existsSync(join(root, `${role}.writes`)), `${role} writing`);
        const { pid } = JSON.parse(readFileSync(join(root, `${role}.json`), 'utf8')) as { pid: number };
        await watch(pid, role);
        const before = readFileSync(join(root, `${role}.writes`), 'utf8').length;
        await until(() => readFileSync(join(root, `${role}.writes`), 'utf8').length > before, `${role} continues writing`);
      }
    },
    async members(identity) { return (await processRows()).filter(row => row.processGroupId === identity.processGroupId).map(row => row.pid); },
    record(status, evidence) { manifest.observations.push({ status, evidence }); save(); },
    resource(evidence) { manifest.resources.push(evidence); save(); },
  };
  let failure: unknown;
  try { await run(matrix); manifest.status = 'pass'; }
  catch (error) { failure = error; manifest.status = 'unconfirmed'; manifest.error = String(error); }
  // Always use a fresh real adapter, never the fault-injected probe, for final owned cleanup.
  try {
    for (const { identity, handle } of owned) {
      await handle?.cancel();
      const stop = await createCommandProcessAdapter({ stopConfirmMs: 2_000 }).recoverStop!(identity);
      manifest.stops.push({ identity, ...stop, source: 'final-owned-cleanup' });
      if (!stop.confirmed) manifest.unconfirmed.push(`group:${identity.processGroupId}`);
      if (stop.confirmed && handle) {
        const entry = manifest.processes.find(row => row.pid === identity.pid)!;
        entry.exit = await handle.result;
      }
    }
    const rows = await processRows();
    for (const entry of manifest.processes) {
      entry.absent = !rows.some(row => row.pid === entry.pid && row.startTime === entry.startTime);
      if (!entry.absent) manifest.unconfirmed.push(`process:${entry.pid}`);
    }
    manifest.processesGone = owned.every(({ identity }) => !rows.some(row => row.processGroupId === identity.processGroupId))
      && manifest.processes.every(entry => entry.absent);
    // Preserve every writer/control file before attempting deletion. Never copy a live native DB.
    const contents: Record<string, string> = {};
    for (const file of readdirSync(root, { withFileTypes: true })) {
      if (!file.isFile()) { manifest.unconfirmed.push(`unexpected-object:${file.name}`); continue; }
      const content = readFileSync(join(root, file.name));
      manifest.files.push({ path: file.name, sizeBytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
      contents[file.name] = content.toString('utf8');
    }
    writeFileSync(join(evidenceDir, 'files.json'), JSON.stringify(contents, null, 2) + '\n');
    manifest.confirmed = manifest.processesGone && manifest.unconfirmed.length === 0;
    save(); // Pre-delete evidence, followed by the actual cleanup outcome.
    if (manifest.confirmed && failure === undefined) { box.cleanup(); manifest.removed = !existsSync(root); }
    if (!manifest.confirmed) manifest.status = 'manual_required';
  } catch (error) {
    manifest.status = 'manual_required'; manifest.unconfirmed.push(String(error)); failure ??= error;
  }
  save();
  process.stdout.write(`P04-7 cleanup manifest: ${manifest.manifestPath}\n`);
  if (failure !== undefined) throw failure;
  if (!manifest.confirmed || !manifest.removed) throw new Error(`Cleanup unconfirmed; preserve ${manifest.manifestPath}`);
  return manifest;
}
