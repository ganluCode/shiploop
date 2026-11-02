/** Local demo journal + real, built ShipLoop CLI transport. No model SDK and no
 * direct product storage access. The enclosing demo owns the temporary root and
 * Host/Run lifecycle; these functions never delete an active session.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTodoPlanningSnapshot, initialTodoPlanningState, runTodoPlanningStep, todoDigest, TodoPlanningError,
} from './p08-todo-planning.ts';
import type { TodoPlanningAction, TodoPlanningOptions, TodoPlanningSnapshot, TodoPlanningState } from './p08-todo-planning.ts';

async function immutableJson(path: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (todoDigest(JSON.parse(await readFile(path, 'utf8'))) !== todoDigest(value)) throw new TodoPlanningError('input_file_drift');
  }
}
async function saveState(directory: string, state: TodoPlanningState): Promise<void> {
  const temporary = join(directory, `.state-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, 'state.json'));
  } finally { await rm(temporary, { force: true }); }
}
async function locked<T>(directory: string, body: () => Promise<T>): Promise<T> {
  const lock = join(directory, '.stage-lock');
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new TodoPlanningError('session_busy_or_recovery_required');
    throw error;
  }
  try { return await body(); }
  finally { await rm(lock, { recursive: true }); }
}

/** The caller supplies a fresh directory under its managed temporary demo root. */
export async function prepareTodoPlanningSession(directory: string, options: TodoPlanningOptions): Promise<TodoPlanningSnapshot> {
  const snapshot = createTodoPlanningSnapshot(options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return locked(directory, async () => {
    await immutableJson(join(directory, 'snapshot.json'), snapshot);
    await immutableJson(join(directory, 'planning-input.json'), snapshot.planningInput);
    await immutableJson(join(directory, 'execution-budget.json'), snapshot.executionBudget);
    // Existing journal is never reset, including failures, unknown outcomes and approvals.
    try { await readFile(join(directory, 'state.json'), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await saveState(directory, initialTodoPlanningState(snapshot));
    }
    return snapshot;
  });
}

function invokeCli(cliBin: string, dataRoot: string, argv: readonly string[]) {
  return new Promise<{ exitCode: number; stdout: string }>((resolveResult, reject) => {
    execFile(process.execPath, [cliBin, ...argv, '--data-root', dataRoot], {
      timeout: 30_000, maxBuffer: 1_048_576, encoding: 'utf8', shell: false,
    }, (error, stdout) => {
      // Numeric CLI exits are structured refusals. Signals/timeouts/spawn failures
      // leave outcome unknown: keep the outbox and retry the SAME command ID.
      if (error && (error.killed || typeof error.code !== 'number')) {
        reject(new TodoPlanningError('cli_transport_unknown'));
      } else resolveResult({ exitCode: error?.code as number | undefined ?? 0, stdout });
    });
  });
}

/** A separate call is required for every stage. Approval and start confirmations
 * come from the owner/controller, never candidate text or an Agent completion.
 */
export async function executeTodoPlanningCliStep(options: {
  readonly directory: string;
  readonly cliBin: string;
  readonly dataRoot: string;
  readonly action: TodoPlanningAction;
}): Promise<TodoPlanningState> {
  const directory = resolve(options.directory);
  return locked(directory, async () => {
    const snapshot = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8')) as TodoPlanningSnapshot;
    const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as TodoPlanningState;
    return runTodoPlanningStep(snapshot, state, options.action, {
      save: value => saveState(directory, value),
      input: async (name, value) => {
        const path = join(directory, name);
        await immutableJson(path, value);
        return path;
      },
      invoke: argv => invokeCli(resolve(options.cliBin), resolve(options.dataRoot), argv),
    });
  });
}

export async function todoPlanningMain(argv: readonly string[]): Promise<void> {
  const [stage, session, ...rest] = argv;
  if (stage === 'prepare' && session && rest.length === 1) {
    const options = JSON.parse(await readFile(rest[0], 'utf8')) as TodoPlanningOptions;
    const snapshot = await prepareTodoPlanningSession(session, options);
    process.stdout.write(`${JSON.stringify({ status: 'prepared', snapshotDigest: snapshot.snapshotDigest, live: 'not_run' })}\n`);
    return;
  }
  const [cliBin, dataRoot, ...confirmation] = rest;
  if (!session || !cliBin || !dataRoot) throw new TodoPlanningError('usage');
  let action: TodoPlanningAction;
  if (stage === 'plan' && confirmation.length === 1 && confirmation[0] === '--authorize-planning') action = { kind: 'plan' };
  else if (stage === 'review' && confirmation.length === 0) action = { kind: 'review' };
  else if (stage === 'preview' && confirmation.length === 0) action = { kind: 'preview' };
  else if (stage === 'approve' && confirmation.length === 2 && confirmation[1] === '--scope-confirmed') {
    action = { kind: 'approve', candidateDigest: confirmation[0], scopeConfirmed: true };
  } else if (stage === 'start' && confirmation.length === 2 && confirmation[1] === '--confirm') {
    action = { kind: 'start', previewDigest: confirmation[0] };
  } else throw new TodoPlanningError('explicit_confirmation_required');
  const state = await executeTodoPlanningCliStep({ directory: session, cliBin, dataRoot, action });
  process.stdout.write(`${JSON.stringify(state)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  todoPlanningMain(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, reason: error instanceof TodoPlanningError ? error.reason : 'local_io_failure' })}\n`);
    process.exitCode = 1;
  });
}
