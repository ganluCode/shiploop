import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { redactSensitiveText, scanTextForCredentialShapes, scanTextForDeveloperPaths } from './p05-report.ts';

export const hashP06Bytes = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

/** Stable JSON input identity; rejects values JSON would silently omit or coerce. */
export function hashP06Input(value: unknown): string {
  function canonical(item: unknown): string {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (typeof item === 'object' && item !== null && Object.getPrototypeOf(item) === Object.prototype) {
      return `{${Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
    }
    throw new Error('invalid_json_input');
  }
  return hashP06Bytes(canonical(value));
}

/** Fail closed without echoing a scanner hit, argv, OS error or secret. */
export function safeP06Text(text: string, sensitiveValues: readonly string[] = []): string {
  const safe = redactSensitiveText(text, sensitiveValues);
  if (scanTextForCredentialShapes(safe).length || scanTextForDeveloperPaths(safe).length ||
      /\b(?:api[_-]?key|password|token|secret)\s*[=:]\s*(?!\[REDACTED:)[A-Za-z0-9._~+/=-]{8,}/i.test(safe) ||
      /\bsk-[A-Za-z0-9_-]{16,}\b/.test(safe)) throw new Error('sensitive_content');
  return safe;
}

export function safeP06Json(value: unknown, sensitiveValues: readonly string[] = []): string {
  // Redact string leaves before encoding, including Windows paths escaped by JSON.
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return safeP06Text(item, sensitiveValues);
    if (Array.isArray(item)) return item.map(visit);
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([k, v]) => [safeP06Text(k, sensitiveValues), visit(v)]));
    return item;
  };
  return safeP06Text(`${JSON.stringify(visit(value), null, 2)}\n`, sensitiveValues);
}

const inside = (root: string, path: string): boolean => path !== root && path.startsWith(root + sep);
export function ownedP06Root(root: string): string {
  const canonical = realpathSync(root);
  if (!inside(realpathSync(tmpdir()), canonical) || inside(realpathSync(homedir()), canonical) ||
      canonical === realpathSync(process.cwd()) || inside(realpathSync(process.cwd()), canonical)) throw new Error('unsafe_resource_root');
  return canonical;
}

export function ownedP06Path(root: string, path: string): string {
  const lexical = resolve(path);
  if (!inside(root, lexical)) throw new Error('resource_escape');
  const parts = relative(root, lexical).split(sep);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('resource_symlink');
  }
  const canonical = realpathSync(lexical);
  if (!inside(root, canonical)) throw new Error('resource_escape');
  return canonical;
}

export type P06ProcessFacts = {
  readonly owned: true;
  readonly spawned: number;
  readonly alive: number;
  readonly exited: number;
  readonly identities: readonly { readonly pid: number; readonly label: string; readonly alive: boolean; readonly exitCode: number | null; readonly signal: string | null }[];
  readonly trees: readonly { readonly rootPid: number | null; readonly scanConfirmed: boolean; readonly identities: readonly (P06ObservedProcess & { readonly alive: boolean })[] }[];
};
export type P06ObservedProcess = { pid: number; ppid: number; identity: string; zombie: boolean };

/** OS facts contain PID/start/argv digest, never raw argv or unrelated process data. */
export function observeP06Processes(): P06ObservedProcess[] {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat=,lstart=,args='], { encoding: 'utf8', timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
  return output.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), identity: hashP06Bytes(`${m[4]}\0${m[5]}`), zombie: m[3]!.startsWith('Z') }] : [];
  });
}

export function captureP06ProcessFacts(facts: P06ProcessFacts) {
  if (facts.owned !== true || !Array.isArray(facts.identities) || facts.spawned !== facts.identities.length ||
      facts.alive !== facts.identities.filter(p => p.alive).length || facts.exited + facts.alive !== facts.spawned ||
      new Set(facts.identities.map(p => p.pid)).size !== facts.spawned) throw new Error('invalid_process_facts');
  const rows = observeP06Processes();
  const owned = new Set(facts.identities.filter(p => p.alive).map(p => p.pid));
  for (const p of facts.identities) {
    if (!Number.isSafeInteger(p.pid) || p.pid <= 1 || p.pid === process.pid || typeof p.alive !== 'boolean') throw new Error('invalid_process_identity');
    if (p.alive && !rows.some(row => row.pid === p.pid && !row.zombie)) throw new Error('process_identity_missing');
  }
  let added = true;
  while (added) {
    added = false;
    for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); added = true; }
  }
  if (!Array.isArray(facts.trees) || facts.trees.some(tree => tree.scanConfirmed !== true || !facts.identities.some(p => p.pid === tree.rootPid))) throw new Error('descendant_scan_uncertain');
  const history = facts.trees.flatMap(tree => [...tree.identities]);
  for (const row of history) {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 1 || row.pid === process.pid || !/^[a-f0-9]{64}$/.test(row.identity)) throw new Error('invalid_process_identity');
  }
  const observed = new Map(history.map(row => [`${row.pid}/${row.identity}`, row]));
  for (const row of rows.filter(row => owned.has(row.pid))) observed.set(`${row.pid}/${row.identity}`, { ...row, alive: !row.zombie });
  return { ...facts, observed: [...observed.values()], descendantsChecked: true };
}

export function captureP06Sqlite(path: string, sensitiveValues: readonly string[]) {
  // A separate readonly connection sees committed WAL state; no migration, PRAGMA writes or business SQL writes.
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 250 });
  try {
    return db.transaction(() => {
      const integrity = db.pragma('quick_check', { simple: true });
      if (integrity !== 'ok') throw new Error('sqlite_corrupt');
      const names = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
      if (!names.length || names.length > 512) throw new Error('sqlite_table_limit');
      let totalBytes = 0;
      const tables = names.map(({ name, sql }) => {
        const safeRows: unknown[] = [];
        for (const row of db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).iterate()) {
          if (safeRows.length >= 1000) throw new Error('sqlite_row_limit');
          // Binary columns require a dedicated typed exporter. Never hide unscanned bytes in base64/number arrays.
          if (Object.values(row as Record<string, unknown>).some(v => v instanceof Uint8Array)) throw new Error('sqlite_binary_unsupported');
          const encoded = safeP06Json(row, sensitiveValues);
          totalBytes += Buffer.byteLength(encoded);
          if (totalBytes > 8 * 1024 * 1024) throw new Error('sqlite_size_limit');
          safeRows.push(JSON.parse(encoded));
        }
        safeRows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        return { name, schema: sql, count: safeRows.length, rows: safeRows, digest: hashP06Input(safeRows) };
      });
      return { integrity, journalMode: db.pragma('journal_mode', { simple: true }), tables };
    })();
  } finally { db.close(); }
}

export function captureP06Git(root: string, repositoryPath: string) {
  ownedP06Path(root, resolve(repositoryPath, '.git'));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const run = (argv: string[]) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repositoryPath, ...argv], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...inherited, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_EXTERNAL_DIFF: '', GIT_PAGER: 'cat' },
  }).trimEnd();
  ownedP06Path(root, resolve(repositoryPath, run(['rev-parse', '--git-common-dir'])));
  // Ignore external diff and textconv commands from repository config.
  return { head: run(['rev-parse', 'HEAD']), tree: run(['rev-parse', 'HEAD^{tree}']),
    status: run(['status', '--porcelain=v1', '--untracked-files=all']),
    diff: run(['diff', '--no-ext-diff', '--no-textconv', '--binary']),
    stagedDiff: run(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary']) };
}

export function captureP06Files(root: string, repositoryPath: string, paths: readonly string[], sensitiveValues: readonly string[]) {
  if (!paths.length || new Set(paths).size !== paths.length) throw new Error('invalid_file_list');
  return paths.map(path => {
    if (isAbsolute(path) || path.split(/[\\/]/).some(p => p === '..' || !p)) throw new Error('invalid_file_path');
    const file = ownedP06Path(root, resolve(repositoryPath, path));
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('file_size_or_type');
    const bytes = readFileSync(file);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const content = safeP06Text(text, sensitiveValues);
    return { path, content, sha256: hashP06Bytes(content), sizeBytes: Buffer.byteLength(content), redacted: content !== text };
  });
}
