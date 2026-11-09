import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { connectToHost, resolveConnectDataRoot } from 'shiploop-host';
import type { HostClient } from 'shiploop-host';

const HELP = `shiploop project documents --project <id> [--json]
shiploop document write --project <id> --path <relative.md> --input <file.md> [--expected-hash <sha256>] [--json]
shiploop feature create --project <id> --phase <id> --title <title> --prd <relative.md> [--design <relative.md>] [--json]
shiploop planning start <featureId> --project <id> [--budget <budget.json>] [--json]
shiploop planning retire <featureId> --project <id> --context <id> --candidate <id> --run <id> --revision <n> --workspace-revision <n|none> [--command-id <id>] [--json]
All paths are relative to the project managed documents directory. No model request on create.
Planning defaults: one Run, 3 Attempts/starts, 7 days, no token/cost cap; --budget overrides.
All commands accept --data-root; create/start accept --command-id for receipt replay.
`;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
function readFile(path: string, maximum = 262144): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error('invalid_input_file');
    const bytes = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, size); if (!n) break; size += n; }
    if (size > maximum) throw new Error('invalid_input_file');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
  } finally { closeSync(fd); }
}

export function isManagedWorkflow(args: readonly string[]): boolean {
  return args[0] === 'project' && args[1] === 'documents' || args[0] === 'document'
    || args[0] === 'feature' && args[1] === 'create'
    || args[0] === 'planning' && (args[1] === 'retire' || args[1] === 'start' && !args.includes('--input'));
}

export function parseManagedWorkflow(args: readonly string[]) {
  const command = args.slice(0, 2).join('.');
  const allowed: Record<string, readonly string[]> = {
    'project.documents': ['--project', '--data-root', '--json'],
    'document.write': ['--project', '--path', '--input', '--expected-hash', '--data-root', '--json'],
    'feature.create': ['--project', '--phase', '--title', '--prd', '--design', '--command-id', '--data-root', '--json'],
    'planning.start': ['--project', '--phase', '--revision', '--budget', '--command-id', '--data-root', '--json'],
    'planning.retire': ['--project', '--context', '--candidate', '--run', '--revision', '--workspace-revision', '--command-id', '--data-root', '--json'],
  };
  if (!allowed[command]) throw new Error('managed_workflow_invalid_input');
  const flags = new Map<string, string | boolean>();
  let featureId: string | undefined;
  for (let i = 2; i < args.length; i++) {
    const key = args[i]!;
    if (command.startsWith('planning.') && i === 2 && !key.startsWith('--')) { featureId = key; continue; }
    if (!allowed[command]!.includes(key) || flags.has(key)) throw new Error('managed_workflow_invalid_input');
    if (key === '--json') { flags.set(key, true); continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('managed_workflow_invalid_input');
    flags.set(key, value);
  }
  const value = (key: string) => flags.get(key) as string | undefined;
  const required = (key: string) => { const result = value(key); if (!result) throw new Error('managed_workflow_invalid_input'); return result; };
  const projectId = required('--project');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(projectId)) throw new Error('managed_workflow_invalid_input');
  if (command.startsWith('planning.') && (!featureId || !ID.test(featureId))) throw new Error('managed_workflow_invalid_input');
  if (command === 'planning.retire') {
    for (const key of ['--context', '--candidate', '--run']) if (!ID.test(required(key))) throw new Error('managed_workflow_invalid_input');
    if (!/^[1-9][0-9]*$/.test(required('--revision')) || !Number.isSafeInteger(Number(value('--revision')))) throw new Error('managed_workflow_invalid_input');
    const revision = required('--workspace-revision');
    if (revision !== 'none' && (!/^[1-9][0-9]*$/.test(revision) || !Number.isSafeInteger(Number(revision)))) throw new Error('managed_workflow_invalid_input');
  }
  if (command === 'feature.create') { required('--phase'); required('--title'); required('--prd'); }
  if (command === 'document.write') { required('--path'); required('--input'); }
  return { command, projectId, featureId, value, json: flags.has('--json') };
}

export async function runManagedWorkflow(options: { args: readonly string[]; userHomeDir?: string;
  io: { stdout(text: string): void; stderr(text: string): void }; connect?: (canonicalRoot: string) => Promise<HostClient> }) {
  if (options.args.includes('--help')) { options.io.stdout(HELP); return { exitCode: 0 }; }
  let client: HostClient | undefined;
  let parsed: ReturnType<typeof parseManagedWorkflow>;
  try { parsed = parseManagedWorkflow(options.args); }
  catch {
    if (options.args.includes('--json')) options.io.stdout(JSON.stringify({ ok: false,
      command: options.args.slice(0,2).join('.'), error: { code:'invalid_input', details:{reason:'managed_workflow_invalid_input'} } })+'\n');
    else options.io.stderr(HELP);
    return { exitCode: 2 };
  }
  const { command, projectId, value } = parsed;
  const commandId: string | undefined = command === 'feature.create' || command.startsWith('planning.') ? value('--command-id') ?? randomUUID() : undefined;
  try {
    // Validate local input before connecting; no model request can precede these checks.
    const text = command === 'document.write' ? readFile(value('--input')!) : undefined;
    const budget = value('--budget') ? JSON.parse(readFile(value('--budget')!, 65536)) : undefined;
    const { canonicalRoot } = resolveConnectDataRoot(value('--data-root') ? { dataRoot: value('--data-root')! }
      : options.userHomeDir ? { userHomeDir: options.userHomeDir } : {});
    client = await (options.connect ? options.connect(canonicalRoot) : connectToHost({ canonicalRoot }));
    let result: unknown;
    if (command === 'project.documents') result = await client.getProjectDocuments(projectId);
    else if (command === 'document.write') result = await client.writeProjectDocument(projectId,
      { path: value('--path')!, content: text!, ...(value('--expected-hash') ? { expectedHash: value('--expected-hash')! } : {}) });
    else if (command === 'planning.retire') {
      const payload = { featureId: parsed.featureId!, contextId: value('--context')!, candidateId: value('--candidate')!,
        runId: value('--run')!, workspaceRevision: value('--workspace-revision') === 'none' ? null : Number(value('--workspace-revision')) };
      // Rebuild the original envelope on explicit replay; changed payload/revision still reaches Core's digest check.
      let issuedAt: string | undefined;
      if (value('--command-id')) {
        try { issuedAt = (await client.getReceipt(commandId!)).issuedAt; }
        catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'not_found')) throw error; }
      }
      result = await client.retirePlanning({ projectId, ...payload, expectedRevision: Number(value('--revision')), commandId: commandId! },
        issuedAt === undefined ? undefined : { issuedAt });
    } else {
      if (value('--command-id')) {
        try {
          const existing = await client.getReceipt(commandId!);
          if (existing.operation !== (command === 'feature.create' ? 'feature.plan.import' : 'planning.start')
            || existing.scope.kind !== 'project' || existing.scope.projectId !== projectId) throw new Error('managed_workflow_receipt_conflict');
          if (existing.status === 'rejected') throw new Error('managed_workflow_receipt_rejected');
          if (command === 'feature.create') {
            const feature = (existing as { result?: { feature?: { id: string; title: string; phaseId: string } } }).result?.feature;
            if (!feature || feature.title !== value('--title') || feature.phaseId !== value('--phase')) throw new Error('managed_workflow_receipt_conflict');
            const saved = await client.getProjectDocuments(projectId, feature.id);
            const expected = [{ path: value('--prd')!, role: 'prd' }, ...(value('--design') ? [{ path: value('--design')!, role: 'design' }] : [])];
            const identity = (entries: readonly { path: string; role: string }[]) => JSON.stringify([...entries].sort((a, b) => a.path.localeCompare(b.path)));
            if (identity(saved.documents ?? []) !== identity(expected)) throw new Error('managed_workflow_receipt_conflict');
          } else {
            if (existing.status !== 'accepted' || existing.schemaVersion !== 7) throw new Error('managed_workflow_receipt_conflict');
            const saved = await client.getPlanningContext(projectId, existing.candidateId);
            if (saved.context.featureId !== parsed.featureId || value('--phase') && value('--phase') !== saved.context.phaseId
              || value('--revision') && Number(value('--revision')) !== saved.context.targetRevision) throw new Error('managed_workflow_receipt_conflict');
            const actual = { batch: saved.budget.batch.budget.batch, run: saved.budget.batch.budget.run };
            if (budget ? !isDeepStrictEqual(actual, budget)
              : actual.run.runTimeLimitMs !== 604800000 || actual.batch.maxRuns !== 1 || actual.batch.maxTotalAttempts !== 3
                || actual.batch.maxRuntimeStarts !== 3 || actual.batch.maxNoProgressRuns !== 1
                || actual.batch.maxTokenTotal !== undefined || actual.batch.maxCostTotal !== undefined) throw new Error('managed_workflow_receipt_conflict');
          }
          options.io.stdout(JSON.stringify({ ok: true, command, result: existing, replayed: true }) + '\n');
          return { exitCode: 0 };
        } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'not_found')) throw error; }
      }
      if (command === 'feature.create') {
        const phase = await client.getPhase(value('--phase')!);
        if (phase.phase.projectId !== projectId) throw new Error('managed_workflow_project_mismatch');
        result = await client.importFeaturePlan({ projectId, phaseId: phase.phase.id, expectedRevision: phase.phase.revision,
          commandId, plan: { schemaVersion: 1, feature: { title: value('--title')! }, tasks: [] },
          documents: [{ path: value('--prd')!, role: 'prd' }, ...(value('--design') ? [{ path: value('--design')!, role: 'design' as const }] : [])] });
      } else {
        const detail = await client.getFeature(parsed.featureId!);
        const feature = detail.feature;
        if (feature.projectId !== projectId || value('--phase') && value('--phase') !== feature.phaseId
          || value('--revision') && Number(value('--revision')) !== feature.revision) throw new Error('managed_workflow_target_changed');
        const time = 604800000;
        result = await client.startPlanning({ projectId, featureId: feature.id, phaseId: feature.phaseId, expectedRevision: feature.revision,
          commandId, managedDocuments: true, requirementRefs: [], constraints: [],
          acceptance: { criteria: ['Implement the requirements and observable acceptance criteria in the associated PRD and design documents.'] },
          strategy: { approvalMode: 'manual', taskLimit: null },
          budget: budget ?? { batch: { maxRuns: 1, maxTotalAttempts: 3, maxRuntimeStarts: 3, maxNoProgressRuns: 1, deadlineUtcMs: Date.now() + time },
            run: { maxAttemptsPerRun: 3, runTimeLimitMs: time } } });
      }
    }
    const rejected = result && typeof result === 'object' && 'status' in result && result.status === 'rejected';
    const receiptError = rejected && typeof result === 'object' && result !== null && 'error' in result
      ? (result as { error?: unknown }).error : undefined;
    options.io.stdout(parsed.json ? JSON.stringify({ ok: !rejected, command, commandId, result,
      ...(rejected ? {error:receiptError} : {}) }) + '\n' : `${command}: ${JSON.stringify(result)}\n`);
    return { exitCode: rejected ? 1 : 0 };
  } catch (error) {
    const reason = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code
      : error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'managed_workflow_failed';
    const raw = error && typeof error === 'object' && 'details' in error && error.details && typeof error.details === 'object'
      ? error.details as Record<string, unknown> : {};
    const details = Object.fromEntries(Object.entries(raw).filter(([key, entry]) =>
      ['reason', 'field', 'commandId', 'projectId', 'featureId', 'contextId', 'candidateId', 'runId', 'constraint', 'status', 'httpStatus', 'expectedRevision', 'actualRevision'].includes(key)
      && (typeof entry === 'number' || typeof entry === 'boolean' || typeof entry === 'string' && /^[A-Za-z0-9._:/-]{1,256}$/.test(entry))));
    if (parsed.json) options.io.stdout(JSON.stringify({ ok: false, command, commandId, error: { code: reason, details } }) + '\n');
    else options.io.stderr(`shiploop: ${reason}${typeof details.reason === 'string' ? `: ${details.reason}` : ''}${commandId ? ` (commandId=${commandId})` : ''}\n`);
    return { exitCode: 1 };
  } finally { client?.close(); }
}
