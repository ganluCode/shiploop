import { expect,it } from 'vitest';
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { openF007Fixture,F007_NOW_BASE,seedFeatureWorkspace } from '../../helpers/planning/p05-1-f007-fixture.ts';
import { createPiRuntimeDescriptor } from '../../../packages/host/src/runtime/pi-adapter.ts';
import { RuntimeError } from '../../../packages/core/src/ports/runtime-execution.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';

async function fixture(historicalOwner=false,ownerStopped=true) {
  let root='';
  let bootstrapPath='';
  const f=await openF007Fixture({prefix:'planning-pre-release-',skipSeedWorkspace:true,
    workRuntimeFactory:context=>({entries:[{
      descriptor:createPiRuntimeDescriptor({providers:[{providerId:'provider',models:['model']}],permissionGrants:[],isolationModes:['trusted_project']}),
      adapter:{async start(request){
        const reader=context.reader(request)!;
        const bodies=[];
        for(const ref of [request.prompt,request.inputManifest]){
          const content=(await reader.read(ref.purpose)).content;
          bodies.push({ref,base64:Buffer.from(content).toString('base64')});
        }
        const docs=Buffer.from(JSON.stringify({projectId:request.projectId,invocationId:request.invocationId,identity:request.identity}));
        bodies.push({ref:{...request.prompt,artifactId:randomUUID(),purpose:'project-documents',contentHash:createHash('sha256').update(docs).digest('hex')},base64:docs.toString('base64')});
        const dir=join(root,'host','pi-work','invocation-fixture');
        mkdirSync(dir,{recursive:true,mode:0o700});
        bootstrapPath=join(dir,'bootstrap.json');
        writeFileSync(bootstrapPath,JSON.stringify({invocationId:request.invocationId,hostTimeUtcMs:F007_NOW_BASE,
          cwd:join(context.workspaceRoots[request.cwd.root]!,request.cwd.relativePath),bodies}),{mode:0o600});
        throw new RuntimeError('process','runner_start_failed');
      }} }],eventIdentityPrefix:()=> 'fixture.'})});
  root=f.box.dataRoot;
  if(historicalOwner){
    const row={...f.query('SELECT * FROM runs WHERE id=?',f.planningRunId),id:randomUUID(),status:'cancelled',dispatch_ordinal:2};
    f.session.database.prepare(`INSERT INTO runs (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`)
      .run(...Object.values(row) as (string|number|null)[]);
    await seedFeatureWorkspace(f.box,f.session,f.projectId,f.featureId,row.id,F007_NOW_BASE);
  }
  await f.core.workExecution.scan();
  await expect.poll(()=>f.query('SELECT status FROM runs WHERE id=?',f.planningRunId).status,{timeout:15000}).toBe('failed');
  f.core.workExecution.enterRecovery();
  await f.core.workExecution.recover();
  if(historicalOwner){
    const owner=f.query('SELECT a.* FROM attempts a JOIN managed_workspaces w ON w.attempt_id=a.id');
    const s={...f.query('SELECT * FROM sessions WHERE attempt_id IN (SELECT id FROM attempts WHERE run_id=?)',f.planningRunId),
      id:randomUUID(),attempt_id:owner.id,input_ref:owner.input_ref,status:ownerStopped?'stopped':'ended',stopped_at:ownerStopped?F007_NOW_BASE+10000:null};
    f.session.database.prepare(`INSERT INTO sessions (${Object.keys(s).join(',')}) VALUES (${Object.keys(s).map(()=>'?').join(',')})`)
      .run(...Object.values(s) as (string|number|null)[]);
  }
  const contextId=String(f.query('SELECT id FROM planning_contexts WHERE run_id=?',f.planningRunId).id);
  const envelope={schemaVersion:5,commandId:randomUUID(),issuedAt:new Date(F007_NOW_BASE).toISOString(),operation:'planning.retire',
    scope:{kind:'project',projectId:f.projectId},expectedRevision:1,payload:{featureId:f.featureId,contextId,candidateId:f.candidateId,
      runId:f.planningRunId,workspaceRevision:Number(f.query('SELECT revision FROM managed_workspaces WHERE feature_id=?',f.featureId).revision)}};
  return {f,envelope,bootstrapPath};
}

it.each([true,false])('reconciles an older workspace owner only with confirmed stop (%s)',async(stopped)=>{
  const {f,envelope}=await fixture(true,stopped);
  try{
    const db=f.session.database;
    const history=()=>['attempts','sessions','runs'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY id`).all());
    const before=history();
    if(stopped){
      expect((await f.core.commandService.submit(createLocalOwnerPrincipal(),envelope)).status).toBe('completed');
      expect(f.query('SELECT status FROM managed_workspaces').status).toBe('retained');
      expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases').n).toBe(0);
    }else{
      await expect(f.core.commandService.submit(createLocalOwnerPrincipal(),envelope)).rejects.toMatchObject({code:'conflict'});
      expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases').n).toBe(3);
    }
    expect(history()).toEqual(before);
  }finally{await f.close();}
},60000);

it('retires a stopped failure with an already retained workspace from a stopped historical owner',async()=>{
  const {f,envelope}=await fixture(true);
  try{
    const db=f.session.database;
    db.prepare("UPDATE sessions SET status='stopped',stopped_at=ended_at,recording_watermark=1,recording_gaps='[]' WHERE attempt_id IN (SELECT id FROM attempts WHERE run_id=?)")
      .run(f.planningRunId);
    db.prepare('DELETE FROM workspace_leases WHERE owner_id IN (SELECT id FROM attempts WHERE run_id=?)').run(f.planningRunId);
    db.prepare("UPDATE managed_workspaces SET status='retained'").run();
    expect((await f.core.commandService.submit(createLocalOwnerPrincipal(),envelope)).status).toBe('completed');
    expect(f.query('SELECT status FROM planning_contexts WHERE run_id=?',f.planningRunId).status).toBe('cancelled');
  }finally{await f.close();}
},60000);

it('retires a failed pre-release Pi invocation through the official command, preserving failure, recording gaps and budget',async()=>{
  const {f,envelope}=await fixture();
  try{
    const db=f.session.database;
    expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases').n).toBe(3);
    const history=()=>['runs','attempts','sessions','execution_batches'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const before=history();
    const receipt=await f.core.commandService.submit(createLocalOwnerPrincipal(),envelope).catch(error=>{
      throw new Error(JSON.stringify({reason:error.details?.reason,attempt:db.prepare('SELECT id,status,started_at,ended_at,invocation_id,session_id FROM attempts WHERE run_id=?').all(f.planningRunId),
        sessions:db.prepare('SELECT id,runtime,status,input_ref,result_ref FROM sessions').all(),
        workspace:db.prepare('SELECT status,attempt_id,run_id FROM managed_workspaces').all()}));
    });
    expect(receipt,JSON.stringify(receipt)).toMatchObject({status:'completed'});
    expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases').n).toBe(0);
    expect(f.query('SELECT status FROM managed_workspaces WHERE feature_id=?',f.featureId).status).toBe('retained');
    expect(f.query('SELECT status FROM planning_contexts WHERE run_id=?',f.planningRunId).status).toBe('cancelled');
    expect(history()).toEqual(before);
    expect((await f.core.commandService.submit(createLocalOwnerPrincipal(),envelope)).replayed).toBe(true);
    expect(f.query("SELECT COUNT(*) AS n FROM artifacts WHERE kind='workspace_evidence'").n).toBeGreaterThan(0);
  }finally{await f.close();}
},60000);

it.each(['supervisorGroupId','invocationId','identity','hash'] as const)('refuses an invalid pre-release witness: %s',async field=>{
  const {f,envelope,bootstrapPath}=await fixture();
  try{
    const b=JSON.parse(readFileSync(bootstrapPath,'utf8'));
    if(field==='supervisorGroupId') b.supervisorGroupId=123;
    if(field==='invocationId') b.invocationId=randomUUID();
    if(field==='identity') b.bodies.find((x:{ref:{purpose:string}})=>x.ref.purpose==='project-documents').base64=Buffer.from('{}').toString('base64');
    if(field==='hash') b.bodies[0].base64=Buffer.from('changed').toString('base64');
    writeFileSync(bootstrapPath,JSON.stringify(b));
    await expect(f.core.commandService.submit(createLocalOwnerPrincipal(),envelope)).rejects.toMatchObject({code:'conflict'});
    expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases').n).toBe(3);
    expect(f.query('SELECT status FROM planning_contexts WHERE run_id=?',f.planningRunId).status).toBe('open');
  }finally{await f.close();}
},60000);

it('allows an idle successor Host to close without releasing another Host quarantine',async()=>{
  const {f}=await fixture();
  const standby=await openCoreApplication({dataRoot:f.box.dataRoot,capabilityCatalog:createStaticRuntimeCapabilityCatalog([])});
  try{
    const before=f.session.database.prepare('SELECT * FROM workspace_leases ORDER BY id').all();
    expect(before).toHaveLength(3);
    expect(await standby.workExecution.close()).toEqual({closed:true,pendingAttemptIds:[]});
    expect(f.session.database.prepare('SELECT * FROM workspace_leases ORDER BY id').all()).toEqual(before);
  }finally{await standby.close();await f.close();}
},60000);
