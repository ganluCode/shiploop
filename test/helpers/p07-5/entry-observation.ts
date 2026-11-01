/** Optional capture bridge for the formal P07 entry. No state is written to product databases. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { P07_SCENE_CHECKS } from '../../../scripts/acceptance/p07-plan.ts';
import Database from 'better-sqlite3';
import { hashP07Bytes, hashP07Input, safeP07Json, redactP07EvidenceText, type P07DrillEvidenceLike, type P07OverrideFacts } from '../../../scripts/acceptance/p07-evidence.ts';

export type P07Observation = { root: string | null; facts: P07OverrideFacts; drill?: P07DrillEvidenceLike };
export type P07ActiveCapture = { file: string; title: string; observations: P07Observation[]; products: unknown[] };
const key = Symbol.for('shiploop.p07.entry.capture');
const state = globalThis as typeof globalThis & { [key]?: P07ActiveCapture };
export const setP07ActiveCapture = (value: P07ActiveCapture | undefined) => { state[key] = value; };
export const p07CaptureActive = () => !!state[key] && !!process.env.SHIPLOOP_P07_ENTRY_SOURCE;
export function publishP07EntryCapture(source: string, identity: unknown, capture: P07ActiveCapture, result: { passed: boolean; assertions: number }): string {
  const slot = hashP07Input({ file: capture.file, title: capture.title }).slice(0, 24);
  const directory = join(source, 'captures'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${slot}.json`);
  writeFileSync(file, safeP07Json({ schemaVersion: 1, identity, file: capture.file, title: capture.title, checkId: P07_SCENE_CHECKS[capture.file],
    ...result, observations: capture.observations.map(({ root, ...observation }) => ({ ...observation, removed: root === null || !existsSync(root) })), products: capture.products }),
    { flag: 'wx', mode: 0o600 });
  return file;
}
/** Only for pure in-memory fixtures: no process, database or filesystem ownership is claimed. */
export function observeP07Memory(facts: P07OverrideFacts): void {
  if (p07CaptureActive()) state[key]!.observations.push({ root: null, facts });
}
export function observeP07Native(root: string): void {
  if (!p07CaptureActive()) return;
  const artifacts: NonNullable<P07OverrideFacts['artifact']>['artifacts'][number][] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('entry_native_symlink');
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && lstatSync(file).size > 0 && /\.jsonl?$/.test(file)) {
        const bytes = readFileSync(file);
        artifacts.push({ projectId: 'native-fixture', artifactId: relative(root, file), kind: 'native-file', contentHash: hashP07Bytes(bytes), sizeBytes: bytes.length });
      }
    }
  };
  visit(root);
  state[key]!.observations.push({ root, facts: { ...(artifacts.length ? { artifact: { artifacts } } : {}) } });
}
export function observeP07Product(value: unknown): void { if (p07CaptureActive()) state[key]!.products.push(value); }
export function observeP07Entry(root: string, dbPath: string, options: { drill?: P07DrillEvidenceLike; repo?: string; archive?: P07OverrideFacts['archive'] } = {}): void {
  if (!p07CaptureActive()) return;
  if (!options.drill) {
    const census = execFileSync('/bin/ps', ['-axo', 'pid=,stat=,args='], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    if (census.split('\n').some(line => line.includes(root) && !/^\s*\d+\s+Z/.test(line))) throw new Error('entry_scene_processes_still_alive');
  }
  const database = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const definitions: Record<string, string> = {
      projects: 'id, status, revision', tasks: 'id, project_id, status, execution_version',
      runs: 'id, project_id, status, batch_id', attempts: 'id, task_id, run_id, status, number',
      execution_batches: 'id, attempts_created, runtime_starts, deadline_at',
      artifacts: 'id, project_id, kind, content_hash, size_bytes',
      git_operations: 'id, operation_type, status, actual_commit',
      notification_deliveries: 'id, event_id, channel_id, status, attempt_count',
      notification_delivery_results: 'delivery_id, attempt, outcome',
    };
    const tables = Object.entries(definitions).filter(([name]) => database.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', name))
      .map(([name, columns]) => {
        const rows = database.prepare(`SELECT ${columns} FROM ${name} ORDER BY 1`).all() as Record<string, any>[];
        return { name, rows, count: rows.length, digest: hashP07Input(rows) };
      });
    const rows = (name: string) => tables.find(table => table.name === name)?.rows ?? [];
    const artifacts = rows('artifacts').filter(row => row.content_hash && row.size_bytes > 0).map(row => ({
      projectId: row.project_id, artifactId: row.id, kind: row.kind, contentHash: row.content_hash, sizeBytes: row.size_bytes,
    }));
    for (const row of rows('git_operations')) {
      const bytes = Buffer.from(JSON.stringify(row));
      artifacts.push({ projectId: 'git-operation-observation', artifactId: row.id, kind: 'observed-git-operation-snapshot',
        contentHash: hashP07Bytes(bytes), sizeBytes: bytes.length });
    }
    const deliveries = rows('notification_deliveries');
    const facts: { -readonly [K in keyof P07OverrideFacts]: P07OverrideFacts[K] } = {
      sqlite: { source: 'readonly-scene-database-before-cleanup', tables },
      ...(!options.drill ? { process: { owned: true as const, descendantsChecked: true as const, processes: [] } } : {}),
      ...(artifacts.length ? { artifact: { artifacts } } : {}),
      ...(options.archive ? { archive: options.archive } : {}),
      ...(deliveries.length ? { notification: {
        channelIds: [...new Set(deliveries.map(row => row.channel_id))],
        deliveries: deliveries.map(row => ({ id: row.id, eventId: row.event_id, channelId: row.channel_id, status: row.status, attemptCount: row.attempt_count })),
        results: rows('notification_delivery_results').map(row => ({ deliveryId: row.delivery_id, attempt: row.attempt, outcome: row.outcome })),
        // The scene's persisted before/after and Runtime-start assertions establish this field.
        taskRerunObserved: false,
      } } : {}),
    };
    if (options.repo && existsSync(join(options.repo, '.git'))) {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: options.repo, encoding: 'utf8', timeout: 5000 }).trim();
      const head = git('rev-parse', 'HEAD');
      facts.git = { repositories: [{ repository: 'scene', head, tree: git('rev-parse', 'HEAD^{tree}'),
        branch: git('branch', '--show-current') || 'detached', baseCommit: head, headBeyondBase: false,
        statusEntries: git('status', '--porcelain').split('\n').filter(Boolean), worktreePath: null, workspaceGone: false }] };
    }
    const observation = { root, facts, ...(options.drill ? { drill: options.drill } : {}) };
    const safe = redactP07EvidenceText(JSON.stringify(observation), [process.cwd(), process.execPath, homedir()], root);
    // Root is kept only in memory to check deletion; it never enters persisted evidence.
    state[key]!.observations.push({ ...JSON.parse(safe), root });
  } finally { database.close(); }
}
