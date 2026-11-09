import { expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openF007Fixture, F007_NOW_BASE } from '../../helpers/planning/p05-1-f007-fixture.ts';
import { withKnowledgeHost } from '../../helpers/host/knowledge-fixture.ts';
import { createPiRuntimeDescriptor } from '../../../packages/host/src/runtime/pi-adapter.ts';
import { RuntimeError } from '../../../packages/core/src/ports/runtime-execution.ts';

function retirement(f: Awaited<ReturnType<typeof openF007Fixture>>) {
  const workspace = f.session.database.prepare('SELECT revision FROM managed_workspaces WHERE feature_id=?').get(f.featureId) as { revision: number } | undefined;
  return { schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(F007_NOW_BASE).toISOString(),
    operation: 'planning.retire', scope: { kind: 'project', projectId: f.projectId }, expectedRevision: 1,
    payload: { featureId: f.featureId, contextId: String(f.query('SELECT id FROM planning_contexts WHERE run_id=?', f.planningRunId).id),
      candidateId: f.candidateId, runId: f.planningRunId, workspaceRevision: workspace?.revision ?? null } };
}

function failRun(f: Awaited<ReturnType<typeof openF007Fixture>>) {
  f.session.database.prepare("UPDATE runs SET status='failed',reason='runtime_failed',revision=revision+1 WHERE id=?").run(f.planningRunId);
  f.session.database.prepare("UPDATE execution_batches SET status='failed' WHERE id=(SELECT batch_id FROM runs WHERE id=?)").run(f.planningRunId);
}

it.each(['retained','quarantined'])('retires a pre-reservation failure with %s workspace after trusted checks',async workspaceStatus=>{
  const f=await openF007Fixture({prefix:'planning-retire-pre-reservation-',skipSeedWorkspace:true,
    workRuntimeFactory:()=>({entries:[{descriptor:createPiRuntimeDescriptor({providers:[{providerId:'provider',models:['model']}],
      permissionGrants:[],isolationModes:['trusted_project']}),adapter:{async start(){throw new Error('must not launch');}}}],
      eventIdentityPrefix(){throw new RuntimeError('configuration','invalid_event_identity_prefix');}})});
  try{
    await f.core.workExecution.scan();
    await expect.poll(()=>f.query('SELECT status FROM runs WHERE id=?',f.planningRunId).status,{timeout:15000}).toBe('failed');
    const db=f.session.database;
    expect(f.query('SELECT COUNT(*) AS n FROM runtime_start_reservations').n).toBe(0);
    expect(f.query('SELECT COUNT(*) AS n FROM sessions').n).toBe(0);
    expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases').n).toBe(0);
    /* DAG / F-002：planning 启动失败不产生 Feature 编码工作区（零 managed 行；
     * 启动前已就绪的 detached 规划快照工作区保留在受控 planning 目录）。 */
    expect(f.query('SELECT COUNT(*) AS n FROM managed_workspaces').n).toBe(0);
    expect(existsSync(f.planningWorkspacePath)).toBe(true);
    if(workspaceStatus==='quarantined') db.prepare("UPDATE managed_workspaces SET status='quarantined',revision=revision+1").run();
    const before=db.prepare('SELECT * FROM attempts WHERE run_id=?').all(f.planningRunId);
    expect((await f.core.commandService.submit(f.box.localOwner(),retirement(f))).status).toBe('completed');
    expect(db.prepare('SELECT * FROM attempts WHERE run_id=?').all(f.planningRunId)).toEqual(before);
  }finally{await f.close();}
},60000);

it.each([['stopped',true],['ended',false]] as const)(
  'distinguishes interrupted history with a %s Session from a foreign writer',async(sessionStatus,allowed)=>{
    const f=await openF007Fixture({prefix:'planning-retire-history-',skipSeedWorkspace:true});
    try {
      await f.core.workExecution.scan();
      await expect.poll(()=>f.query('SELECT status FROM runs WHERE id=?',f.planningRunId).status,{timeout:15000}).toBe('failed');
      await expect.poll(()=>f.query('SELECT COUNT(*) AS n FROM workspace_leases').n,{timeout:15000}).toBe(0);
      const db=f.session.database;
      const runId=randomUUID(),attemptId=randomUUID(),sessionId=randomUUID();
      const copy=(table:string,row:Record<string,unknown>,overrides:Record<string,unknown>)=>{
        const value={...row,...overrides};
        db.prepare(`INSERT INTO ${table} (${Object.keys(value).join(',')}) VALUES (${Object.keys(value).map(()=>'?').join(',')})`)
          .run(...Object.values(value) as (string|number|null)[]);
      };
      copy('runs',f.query('SELECT * FROM runs WHERE id=?',f.planningRunId),
        {id:runId,status:'cancelled',dispatch_ordinal:2});
      const original=f.query('SELECT * FROM attempts WHERE run_id=?',f.planningRunId);
      copy('attempts',original,{id:attemptId,run_id:runId,status:'interrupted',number:Number(original.number)+1,
        session_id:null,invocation_id:null});
      const originalSession=f.query('SELECT * FROM sessions WHERE attempt_id=?',original.id);
      copy('sessions',originalSession,
        {id:sessionId,attempt_id:attemptId,status:sessionStatus,stopped_at:sessionStatus==='stopped'?originalSession.ended_at:null,
          recording_gaps:'["recording_failed:aborted"]'});
      const before=db.prepare('SELECT * FROM attempts WHERE id=?').get(attemptId);
      if(allowed) expect((await f.core.commandService.submit(f.box.localOwner(),retirement(f))).status).toBe('completed');
      else await expect(f.core.commandService.submit(f.box.localOwner(),retirement(f)))
        .rejects.toMatchObject({details:{reason:'planning_retirement_foreign_writer'}});
      expect(db.prepare('SELECT * FROM attempts WHERE id=?').get(attemptId)).toEqual(before);
    } finally {await f.close();}
  },60000);

it('retires a terminal planning context without changing failure history or budgets and replays the receipt', async () => {
  const f = await openF007Fixture({ prefix: 'planning-retire-', skipSeedWorkspace: true });
  try {
    const db = f.session.database;
    db.prepare("UPDATE runs SET status='failed',reason='runtime_failed',revision=revision+1 WHERE id=?").run(f.planningRunId);
    db.prepare("UPDATE execution_batches SET status='failed' WHERE id=(SELECT batch_id FROM runs WHERE id=?)").run(f.planningRunId);
    const before = db.prepare('SELECT * FROM runs WHERE id=?').get(f.planningRunId);
    const batch = db.prepare('SELECT * FROM execution_batches WHERE id=(SELECT batch_id FROM runs WHERE id=?)').get(f.planningRunId);
    const contextId = f.query('SELECT id FROM planning_contexts WHERE run_id=?', f.planningRunId).id;
    const envelope = { schemaVersion: 5, commandId: randomUUID(), issuedAt: new Date(F007_NOW_BASE).toISOString(),
      operation: 'planning.retire', scope: { kind: 'project', projectId: f.projectId }, expectedRevision: 1,
      payload: { featureId: f.featureId, contextId, candidateId: f.candidateId, runId: f.planningRunId, workspaceRevision: null } };
    const result = await f.core.commandService.submit(f.box.localOwner(), envelope);
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(f.query('SELECT status FROM planning_contexts WHERE run_id=?', f.planningRunId).status).toBe('cancelled');
    expect(db.prepare('SELECT * FROM runs WHERE id=?').get(f.planningRunId)).toEqual(before);
    expect(db.prepare('SELECT * FROM execution_batches WHERE id=(SELECT batch_id FROM runs WHERE id=?)').get(f.planningRunId)).toEqual(batch);
    const replay = await f.core.commandService.submit(f.box.localOwner(), envelope);
    expect(replay).toMatchObject({ status: 'completed', replayed: true });
    expect(f.query('SELECT COUNT(*) AS n FROM runs').n).toBe(1);
  } finally { await f.close(); }
}, 60000);

it('exposes retirement over authenticated HostClient and preserves command replay', async () => withKnowledgeHost(async host => {
  const f=await openF007Fixture({prefix:'planning-retire-http-',skipSeedWorkspace:true});
  try {
    failRun(f);
    const scoped=await host.scoped(f.box.localOwner(), {commandService:f.core.commandService,
      commandReceiptsService:f.core.commandReceiptsService});
    const e=retirement(f);
    const input={projectId:f.projectId,...e.payload,expectedRevision:1,commandId:e.commandId};
    const first=await scoped.client.retirePlanning(input,{issuedAt:e.issuedAt});
    expect(first).toMatchObject({status:'completed',operation:'planning.retire',result:{runId:f.planningRunId}});
    expect((await scoped.client.retirePlanning(input,{issuedAt:e.issuedAt})).replayed).toBe(true);
    const event=f.query("SELECT * FROM state_events WHERE event_type='work.recovery.updated' AND run_id=?",f.planningRunId);
    expect(event.payload).toContain('planning_retired');
  } finally {await f.close();}
}),60000);

it('rejects unresolved terminal contexts explicitly before hitting the SQLite unique constraint; replans only after retirement', async () => {
  const f = await openF007Fixture({ prefix: 'planning-replan-', skipSeedWorkspace: true });
  try {
    failRun(f);
    const payload = { schemaVersion: 1, projectId: f.projectId, phaseId: 'phase-1', featureId: f.featureId,
      requirementRefs: [], constraints: [], acceptance: { criteria: ['planned'] }, strategy: { approvalMode: 'manual', taskLimit: null },
      budget: { batch: { maxRuns: 1, maxTotalAttempts: 1, maxRuntimeStarts: 1, maxNoProgressRuns: 1, deadlineUtcMs: F007_NOW_BASE+3600000 },
        run: { maxAttemptsPerRun: 1, runTimeLimitMs: 3600000 } } };
    const start = () => f.core.commandService.submit(f.box.localOwner(), { schemaVersion: 5, commandId: randomUUID(),
      issuedAt: new Date(F007_NOW_BASE).toISOString(), operation: 'planning.start', scope: { kind: 'project', projectId: f.projectId }, expectedRevision: 1, payload });
    await expect(start()).rejects.toMatchObject({ code: 'conflict', details: { constraint: 'planning_contexts_feature_active_unique' } });
    await f.core.commandService.submit(f.box.localOwner(), retirement(f));
    expect((await start()).status).toBe('accepted');
    expect(f.query('SELECT COUNT(*) AS n FROM runs').n).toBe(2);
    expect(f.runtimeStarts()).toBe(0);
  } finally { await f.close(); }
}, 60000);

it.each([
  ['feature CAS', 'stale_revision', (e: ReturnType<typeof retirement>) => { e.expectedRevision=2; }],
  ['workspace CAS', 'workspace_revision_changed', (e: ReturnType<typeof retirement>) => { e.payload.workspaceRevision=99; }],
  ['context identity', 'planning_retirement_identity_mismatch', (e: ReturnType<typeof retirement>) => { e.payload.contextId=randomUUID(); }],
  ['candidate identity', 'planning_retirement_identity_mismatch', (e: ReturnType<typeof retirement>) => { e.payload.candidateId=randomUUID(); }],
  ['run identity', 'planning_retirement_identity_mismatch', (e: ReturnType<typeof retirement>) => { e.payload.runId=randomUUID(); }],
  ['feature identity', 'planning_retirement_identity_mismatch', (e: ReturnType<typeof retirement>) => { e.payload.featureId=randomUUID(); }],
])('refuses %s without changing context, history or receipts', async (_label, reason, change) => {
  const f=await openF007Fixture({ prefix: 'planning-retire-refuse-', skipSeedWorkspace:true });
  try {
    failRun(f);
    const e=retirement(f); change(e);
    await expect(f.core.commandService.submit(f.box.localOwner(), e)).rejects.toMatchObject({ code: 'conflict', details:{reason} });
    expect(f.query('SELECT status FROM planning_contexts WHERE run_id=?', f.planningRunId).status).toBe('open');
    expect(f.query('SELECT COUNT(*) AS n FROM command_receipts WHERE command_id=?', e.commandId).n).toBe(0);
  } finally { await f.close(); }
},60000);

it('rejects an active Run and reused command identity with a different target', async () => {
  const f=await openF007Fixture({ prefix:'planning-retire-active-',skipSeedWorkspace:true });
  try {
    const e=retirement(f);
    await expect(f.core.commandService.submit(f.box.localOwner(),e)).rejects.toMatchObject({details:{reason:'planning_run_not_terminal'}});
    failRun(f);
    await f.core.commandService.submit(f.box.localOwner(),e);
    await expect(f.core.commandService.submit(f.box.localOwner(),{...e,payload:{...e.payload,runId:randomUUID()}}))
      .rejects.toMatchObject({code:'conflict'});
    expect(f.query('SELECT COUNT(*) AS n FROM command_receipts WHERE command_id=?',e.commandId).n).toBe(1);
  } finally { await f.close(); }
},60000);

it('refuses a failed startup with absent process identity and incomplete recording, preserving quarantined resources', async () => {
  const f=await openF007Fixture({prefix:'planning-retire-unknown-',skipSeedWorkspace:true,
    startFailure:{kind:'process',reason:'runner_start_failed'}});
  try {
    await f.core.workExecution.scan();
    await expect.poll(()=>f.query('SELECT status FROM runs WHERE id=?',f.planningRunId).status,{timeout:15000}).toBe('failed');
    const db=f.session.database;
    const before=db.prepare('SELECT * FROM workspace_leases ORDER BY id').all();
    const attempts=db.prepare('SELECT * FROM attempts ORDER BY id').all();
    const sessions=db.prepare('SELECT * FROM sessions ORDER BY id').all();
    await expect(f.core.commandService.submit(f.box.localOwner(),retirement(f)))
      .rejects.toMatchObject({details:{reason:'planning_retirement_stop_unconfirmed'}});
    expect(db.prepare('SELECT * FROM workspace_leases ORDER BY id').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM attempts ORDER BY id').all()).toEqual(attempts);
    expect(db.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(sessions);
  } finally {await f.close();}
},60000);

it('retires a stopped failed execution while preserving Attempt, Session, candidate and budget history', async () => {
  const f=await openF007Fixture({prefix:'planning-retire-stopped-',skipSeedWorkspace:true});
  try {
    await f.core.workExecution.scan();
    await expect.poll(()=>f.query('SELECT status FROM runs WHERE id=?',f.planningRunId).status,{timeout:15000}).toBe('failed');
    await expect.poll(()=>f.query('SELECT COUNT(*) AS n FROM workspace_leases').n,{timeout:15000}).toBe(0);
    const db=f.session.database;
    const snapshot=()=>['runs','execution_batches','attempts','sessions','batch_budget_revisions'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const before=snapshot();
    const candidate=db.prepare('SELECT candidate_id,candidate_artifact_id,input_digest FROM planning_contexts').get();
    const e=retirement(f);
    expect((await f.core.commandService.submit(f.box.localOwner(),e)).status).toBe('completed');
    expect(snapshot()).toEqual(before);
    expect(db.prepare('SELECT candidate_id,candidate_artifact_id,input_digest FROM planning_contexts').get()).toEqual(candidate);
    expect((await f.core.commandService.submit(f.box.localOwner(),e)).replayed).toBe(true);
    expect(f.runtimeStarts()).toBe(1);
  } finally {await f.close();}
},60000);

it.each([
  ['active Attempt',"UPDATE attempts SET status='executing' WHERE task_id=?",'planning_retirement_active_attempt'],
  ['recording gap',"UPDATE sessions SET recording_gaps='[\"stop_unconfirmed\"]' WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id=?)",'planning_retirement_stop_unconfirmed'],
])('refuses %s even when the Run is failed',async (_label,sql,reason)=>{
  const f=await openF007Fixture({prefix:'planning-retire-evidence-',skipSeedWorkspace:true});
  try {
    await f.core.workExecution.scan();
    await expect.poll(()=>f.query('SELECT status FROM runs WHERE id=?',f.planningRunId).status,{timeout:15000}).toBe('failed');
    await expect.poll(()=>f.query('SELECT COUNT(*) AS n FROM workspace_leases').n,{timeout:15000}).toBe(0);
    f.session.database.prepare(sql).run(f.planningTaskId);
    await expect(f.core.commandService.submit(f.box.localOwner(),retirement(f))).rejects.toMatchObject({details:{reason}});
    expect(f.query('SELECT status FROM planning_contexts WHERE run_id=?',f.planningRunId).status).toBe('open');
  } finally {await f.close();}
},60000);
