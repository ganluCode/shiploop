import { constants, openSync, closeSync, fstatSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { SqliteStorageSession } from './sqlite/session.js';
import { workRecoveryFingerprint } from './sqlite/dispatch-recovery.js';
import { issuePlanningPreReleaseProof } from './sqlite/planning-retirement-evidence.js';
import { PublicError } from '../ports/commands.js';
import type { PlanningRetireInput } from '../ports/planning-retire.js';
import type { WorkspaceBaseline } from '../ports/workspace.js';
import type { WorkspaceInspection } from '../ports/workspace-inspector.js';

export async function assertNoPiWriters(): Promise<void> {
  const output = await new Promise<string>((resolve, reject) => execFile('/bin/ps', ['-axo', 'pid=,command='],
    { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 2000, maxBuffer: 2_097_152 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
  if (!output.trim() || output.split('\n').some(line => /^\s*\d+\s+\S*node(?:\s+--\S+)*\s+\S*\/(?:command-supervisor|production-pi-runner)\.(?:js|ts)(?:\s|$)/.test(line))) {
    throw new PublicError('conflict', 'planning.retire', undefined, { details: { reason: 'planning_retirement_process_unconfirmed' } });
  }
}

function bootstrapWitness(root: string, invocationId: string, cwd: string, endedAt: number, projectId: string,
  attemptId: string, expectedRefs: readonly {artifactId:string;contentHash:string}[]) {
  const parent = join(root, 'host', 'pi-work');
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== process.getuid!()
    || (parentStat.mode & 0o077) !== 0) throw new Error('unsafe_bootstrap_directory');
  const entries = readdirSync(parent, { withFileTypes: true });
  if (entries.length > 128) throw new Error('bootstrap_scan_limit');
  const matches: { digest: string; path: string }[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith('invocation-') || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = join(parent, entry.name);
    const dirStat = lstatSync(dir);
    if (dirStat.uid !== process.getuid!() || (dirStat.mode & 0o077) !== 0) throw new Error('unsafe_bootstrap_directory');
    const path = join(dir, 'bootstrap.json');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4_194_304 || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new Error('unsafe_bootstrap');
      const bytes = readFileSync(fd);
      const value = JSON.parse(bytes.toString('utf8'));
      if (value.invocationId !== invocationId) continue;
      // The trusted production adapter rewrites this before the durable commit callback;
      // CommandProcess sends no workload argv until that callback acknowledges.
      if (Object.hasOwn(value, 'supervisorGroupId') || value.cwd !== cwd || !Number.isSafeInteger(value.hostTimeUtcMs)
        || value.hostTimeUtcMs > endedAt || stat.mtimeMs > endedAt || !Array.isArray(value.bodies)
        || !expectedRefs.every(ref=>value.bodies.some((b: {base64:string;ref?: {projectId?: string;artifactId?: string;contentHash?:string}}) =>
          b.ref?.projectId===projectId && b.ref.artifactId===ref.artifactId && b.ref.contentHash===ref.contentHash
          && createHash('sha256').update(Buffer.from(b.base64,'base64')).digest('hex')===ref.contentHash))) {
        throw new Error('bootstrap_not_pre_release');
      }
      const documents = value.bodies.filter((b: { ref?: {purpose?: string} }) => b.ref?.purpose === 'project-documents');
      if (documents.length !== 1) throw new Error('bootstrap_identity_missing');
      const identity = JSON.parse(Buffer.from(documents[0].base64, 'base64').toString('utf8'));
      if (identity.invocationId !== invocationId || identity.projectId !== projectId || identity.identity?.attemptId !== attemptId) throw new Error('bootstrap_identity_mismatch');
      matches.push({ digest: createHash('sha256').update(bytes).digest('hex'), path });
    } finally { closeSync(fd); }
  }
  if (matches.length !== 1) throw new Error('bootstrap_witness_missing');
  return matches[0]!;
}

/** Trusted local evidence preparation, never a client assertion that a process stopped. */
export async function preparePlanningPreReleaseRecovery(options: {
  readonly session: SqliteStorageSession;
  readonly dataRoot: string;
  readonly input: PlanningRetireInput;
  readonly inspect: (projectId: string, baseline: WorkspaceBaseline) => Promise<WorkspaceInspection>;
  readonly publish: (projectId: string, operationId: string, evidence: Readonly<Record<string, unknown>>) => Promise<string>;
}): Promise<object | undefined> {
  const { session, input } = options;
  const db = session.database;
  const rows = db.prepare(`SELECT a.*,s.runtime,s.status AS session_status,s.input_ref AS session_input_ref,
    s.result_ref AS session_result_ref FROM attempts a LEFT JOIN sessions s ON s.attempt_id=a.id
    WHERE a.project_id=? AND a.run_id=? ORDER BY a.id LIMIT 2`).all(input.projectId,input.runId) as {
      id:string;project_id:string;feature_id:string;invocation_id:string|null;status:string;started_at:number|null;
      ended_at:number|null;session_id:string|null;runtime:string|null;session_status:string|null;session_input_ref:string|null;session_result_ref:string|null;input_snapshot:string }[];
  if (rows.length !== 1 || rows[0]!.status !== 'failed' || rows[0]!.session_status === 'stopped') return undefined;
  const attempt=rows[0]!;
  const beforeReservation=attempt.session_id===null && attempt.session_status===null
    && !db.prepare('SELECT id FROM runtime_start_reservations WHERE run_id=? LIMIT 1').get(input.runId)
    && !db.prepare('SELECT id FROM workspace_leases WHERE owner_id=? LIMIT 1').get(attempt.id);
  if(!beforeReservation && attempt.runtime!=='pi') return undefined;
  const context=db.prepare('SELECT id,feature_id,run_id FROM planning_contexts WHERE project_id=? AND candidate_id=?').get(input.projectId,input.candidateId) as {id:string;feature_id:string;run_id:string}|undefined;
  if (!context || context.id!==input.contextId || context.run_id!==input.runId || context.feature_id!==input.featureId
    || attempt.feature_id!==input.featureId || !attempt.invocation_id || attempt.started_at!==null || !attempt.ended_at
    || (!beforeReservation && !attempt.session_result_ref)) return undefined;
  const workspace=db.prepare('SELECT * FROM managed_workspaces WHERE project_id=? AND feature_id=?')
    .get(input.projectId,input.featureId) as {attempt_id:string;run_id:string;owner_id:string;host_instance_id:string;execution_version:number;
      repository_binding_id:string;repository_binding_revision:number;repo_identity:string;
      canonical_path:string;git_common_dir:string;branch:string;base_commit:string;status:string}|undefined;
  if (!workspace || workspace.status!=='quarantined') return undefined;
  if (workspace.attempt_id!==attempt.id && !db.prepare(`SELECT a.id FROM attempts a
    JOIN runs r ON r.id=a.run_id JOIN sessions s ON s.attempt_id=a.id
    WHERE a.id=? AND a.project_id=? AND a.feature_id=? AND a.run_id=?
      AND a.owner_id=? AND a.host_instance_id=? AND a.execution_version=?
      AND r.status IN ('failed','cancelled','succeeded') AND s.status='stopped'
      AND a.status IN ('failed','cancelled','succeeded','interrupted')
      AND NOT EXISTS (SELECT 1 FROM workspace_leases l WHERE l.owner_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM run_dispatch_claims c WHERE c.run_id=a.run_id AND c.state<>'released')
      AND NOT EXISTS (SELECT 1 FROM execution_slot_claims c WHERE c.run_id=a.run_id AND c.state<>'released')`)
    .get(workspace.attempt_id,input.projectId,input.featureId,workspace.run_id,
      workspace.owner_id,workspace.host_instance_id,workspace.execution_version)) return undefined;
  if (db.prepare('SELECT 1 FROM verification_processes p JOIN verification_batches b ON b.id=p.batch_id WHERE b.run_id=? LIMIT 1')
    .get(input.runId)) return undefined;
  const snapshot=JSON.parse(attempt.input_snapshot);
  if (!beforeReservation && snapshot.group?.snapshot?.artifactId!==attempt.session_input_ref) return undefined;
  const expectedRefs=[snapshot.group.prompt,snapshot.group.manifest] as {artifactId:string;contentHash:string}[];
  const fingerprint=workRecoveryFingerprint(session,attempt.id);
  const baseline={repositoryBindingId:workspace.repository_binding_id,repositoryBindingRevision:workspace.repository_binding_revision,
    repoIdentity:workspace.repo_identity,canonicalPath:workspace.canonical_path,gitCommonDir:workspace.git_common_dir,branch:workspace.branch,baseCommit:workspace.base_commit};
  try {
    const witness=()=>beforeReservation?{digest:createHash('sha256').update(attempt.input_snapshot).digest('hex')}
      :bootstrapWitness(options.dataRoot,attempt.invocation_id!,workspace.canonical_path,attempt.ended_at!,input.projectId,attempt.id,expectedRefs);
    const first=witness();
    await assertNoPiWriters();
    const inspection=await options.inspect(input.projectId,baseline);
    if (!inspection.complete || inspection.repository.headCommit!==workspace.base_commit || inspection.statusPorcelainBase64!=='') throw new Error('workspace_not_pristine');
    const second=witness();
    await assertNoPiWriters();
    if (first.digest!==second.digest || fingerprint!==workRecoveryFingerprint(session,attempt.id)) throw new Error('recovery_facts_changed');
    const evidenceRef=await options.publish(input.projectId,randomUUID(),{schemaVersion:1,kind:'planning-pre-release-recovery',
      projectId:input.projectId,runId:input.runId,attemptId:attempt.id,invocationId:attempt.invocation_id,workspaceAttemptId:workspace.attempt_id,
      basis:beforeReservation?'runtime_start_not_reserved_and_writer_census':'bootstrap_before_supervisor_commit_and_writer_census',
      ...(beforeReservation?{inputSnapshotDigest:first.digest}:{bootstrapDigest:first.digest}),
      codeDigest:inspection.codeDigest,headCommit:inspection.repository.headCommit,runtimeNeverReleased:true});
    if (fingerprint!==workRecoveryFingerprint(session,attempt.id)) throw new Error('recovery_facts_changed');
    return issuePlanningPreReleaseProof({session,input,attemptId:attempt.id,workspaceAttemptId:workspace.attempt_id,fingerprint,evidenceRef});
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError('conflict','planning.retire',undefined,{details:{reason:'planning_pre_release_evidence_unconfirmed'}});
  }
}
