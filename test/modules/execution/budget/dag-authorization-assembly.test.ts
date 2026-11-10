import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openBudgetFixture, NOW } from '../../../helpers/p03-3/budget-fixture.ts';
import { createExecutionPreviewService } from '../../../../packages/core/src/application/execution-preview.ts';
import { createExecutionStartService } from '../../../../packages/core/src/application/execution-start.ts';
import { createSqlitePlanAccess } from '../../../../packages/core/src/adapters/sqlite/plan-store.ts';
import { createRepositoryInspector } from '../../../../packages/core/src/adapters/fs/repository-inspector.ts';
import { createBaselineWorkspaceReader } from '../../../../packages/core/src/adapters/fs/baseline-workspace.ts';
import { TRUSTED_PROJECT_PERMISSIONS_READER } from '../../../../packages/core/src/ports/execution-input-prepare.ts';
import { readRunExecutionBaseline } from '../../../../packages/core/src/adapters/sqlite/run-execution-baseline.ts';

it('[case:dag-authorize-one-visible-batch] pending members are visible Runs in one approved Batch with no coding baseline, Attempt or worktree', async () => {
  const f = await openBudgetFixture();
  try {
    const db=f.session.database;
    const phase=db.prepare('SELECT revision FROM phases WHERE id=?').get('phase-1') as {revision:number};
    const imported=await f.submit('feature.plan.import',{phaseId:'phase-1',plan:{schemaVersion:1,
      feature:{title:'successor',description:null,labels:[],sourceRefs:[]},tasks:[{id:'successor-task',title:'successor',acceptance:{criteria:['ok']},dependsOn:[]}]}},
      {scope:f.scope,expectedRevision:phase.revision});
    expect(imported.status).toBe('completed');
    const successor=(imported as {result:{feature:{id:string}}}).result.feature.id;
    const feature=db.prepare('SELECT revision,plan_digest FROM features WHERE id=?').get(successor) as {revision:number;plan_digest:string};
    expect((await f.submit('feature.plan.decide',{featureId:successor,planDigest:feature.plan_digest,decision:'approve',reason:'fixed scope'},
      {scope:f.scope,expectedRevision:feature.revision})).status).toBe('completed');
    f.session.transactWrite('fixture.edge',()=>db.prepare(`INSERT INTO feature_dependencies(id,created_at,project_id,revision,updated_at,phase_id,feature_id,depends_on_id)
      VALUES(?,?,?,1,?,'phase-1',?,?)`).run(randomUUID(),NOW,f.projectId,NOW,successor,f.featureId));
    const preview=createExecutionPreviewService({views:createSqlitePlanAccess(f.session),inspector:createRepositoryInspector(),
      workspace:createBaselineWorkspaceReader(),permissions:TRUSTED_PROJECT_PERMISSIONS_READER,nowMs:()=>NOW});
    const service=createExecutionStartService({preview,permissions:TRUSTED_PROJECT_PERMISSIONS_READER,nowMs:()=>NOW});
    const preparedPreview=await preview.previewExecution(f.projectId,{featureIds:[f.featureId,successor],budget:{...f.budget}});
    expect(preparedPreview.status).toBe('authorization_ready');
    const payload = {featureIds:[f.featureId,successor],budget:{...f.budget} as Record<string,unknown>,previewDigest:preparedPreview.previewDigest!,retryBatchId:null as null,labels:[]};
    const prepared=await service.prepareExecutionStart(f.projectId,payload);
    const commandId=randomUUID(),issuedAt=new Date(NOW).toISOString();
    const receipt=f.atomic.transact('fixture.authorize',tx=>service.submitExecutionStart({principalId:f.owner.principalId,commandId,
      scope:f.scope as {kind:'project';projectId:string},requestDigest:'a'.repeat(64),issuedAt},{payload,scope:f.scope as {kind:'project';projectId:string}},tx,prepared,{schedulerAssembled:true}));
    expect(receipt.status).toBe('accepted');
    if(receipt.status!=='accepted'||!('runIds' in receipt))throw new Error('expected work accepted');
    const runs=db.prepare('SELECT id,feature_id,input_snapshot FROM runs WHERE batch_id=?').all(receipt.batchId) as {id:string;feature_id:string;input_snapshot:string}[];
    expect(runs).toHaveLength(2);
    const target=runs.find(run=>run.feature_id===successor)!;
    const input=JSON.parse(target.input_snapshot);
    expect(input.workspaceBaseline).toBeUndefined();
    expect(input.integrationAuthorization).toMatchObject({scopeFeatureIds:expect.arrayContaining([f.featureId,successor]),
      dependencies:[{featureId:successor,dependsOnId:f.featureId,revision:1}]});
    expect(f.atomic.transact('read',tx=>readRunExecutionBaseline(db,tx.getExecutionRun(f.projectId,target.id)))).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({n:0});
    expect(db.prepare('SELECT COUNT(*) AS n FROM managed_workspaces').get()).toEqual({n:0});
    expect(db.prepare('SELECT COUNT(*) AS n FROM run_execution_baselines').get()).toEqual({n:0});
    expect(()=>db.prepare('UPDATE runs SET input_snapshot=? WHERE id=?').run('{}',target.id)).toThrow(/immutable/);
  }finally{f.close();}
});
