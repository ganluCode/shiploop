import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { gitCommitFixture } from '../../helpers/controlled-git-commit.ts';
import { git } from '../../helpers/git-repo.ts';
import { createWorkspaceInspector } from '../../../packages/core/src/adapters/fs/workspace-inspector.ts';
import { createControlledGitCommitService } from '../../../packages/core/src/application/controlled-git-commit.ts';
import { createGitCommitReconciliationService } from '../../../packages/core/src/application/git-commit-reconciliation.ts';
import { createIntegrationExecutionPlan, computeCoveredInputDigest } from '../../../packages/core/src/ports/integration-execution-plan.ts';
import { verificationCodeIdentity } from '../../../packages/core/src/ports/verification-aggregate.ts';
import type { GitCommitAuthorization, IntegrationCommitResourceSnapshot } from '../../../packages/core/src/ports/controlled-git-commit.ts';
import { createNodeIntegrationCandidateVerificationExecutor } from '../../../packages/core/src/adapters/integration-verification.ts';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createSqliteArtifactStore } from '../../../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createArtifactFileStore } from '../../../packages/core/src/adapters/fs/artifact-files.ts';
import { createArtifactPublisher } from '../../../packages/core/src/application/artifact-publish.ts';
import type { IntegrationVerificationExecutionInput } from '../../../packages/core/src/ports/integration-verification.ts';
import { createSqliteFeatureResourceAccess } from '../../../packages/core/src/adapters/sqlite/feature-resources.ts';
import { normalizeFeatureResourceSet } from '../../../packages/core/src/ports/feature-resources.ts';
import { NOW } from '../../helpers/p03-3/budget-fixture.ts';
import { createIntegrationRepairCommitAuthorization } from '../../../packages/core/src/application/integration-repair-commit-authorization.ts';
import { createGitAgentRepairRequest, computeGitAgentRepairBaselineDigest } from '../../../packages/core/src/ports/git-agent-repair.ts';
import type { GitAgentRepairView } from '../../../packages/core/src/ports/git-agent-repair-store.ts';
import type { IntegrationRepairVerificationRecord } from '../../../packages/core/src/ports/integration-repair-verification.ts';
import type { CommandTransaction } from '../../../packages/core/src/ports/atomic-commands.ts';
import { createIntegrationRepairFinalizationService } from '../../../packages/core/src/application/integration-repair-finalization.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function conflictFixture(sameRunRepair = false) {
  const f = await gitCommitFixture();
  const identity = ['-c', 'user.name=Confirmed User', '-c', 'user.email=confirmed@example.com'];
  const commit = (message: string) => git([...identity, 'commit', '-am', message], f.root);
  git(['add', 'source.ts'], f.root); commit('base source');
  const base = git(['rev-parse', 'HEAD'], f.root).trim();
  const branch = f.baseline.branch;
  git(['checkout', '-b', 'repair-input'], f.root);
  writeFileSync(join(f.root, 'source.ts'), 'theirs\n'); commit('input source');
  const input = git(['rev-parse', 'HEAD'], f.root).trim();
  git(['checkout', branch], f.root);
  writeFileSync(join(f.root, 'source.ts'), 'ours\n'); commit('target source');
  const parent = git(['rev-parse', 'HEAD'], f.root).trim();
  git(['checkout', '--detach', parent], f.root);
  // A real merge failure is the fixture's intended starting state.
  expect(() => git(['merge', '--no-ff', '--no-commit', 'repair-input'], f.root)).toThrow();
  const baseline = { ...f.baseline, branch: 'HEAD', baseCommit: base };
  await expect(createWorkspaceInspector({ authorizedRoots: [f.root],
    confirmProcessIdentity: async value => ({ launchId: value.launchId }) }).inspect(baseline)).rejects.toMatchObject({ reason: 'invalid_input' });
  const inspector = createWorkspaceInspector({ authorizedRoots: [f.root], integrationRepair: true,
    confirmProcessIdentity: async value => ({ launchId: value.launchId }) });
  const before = await inspector.inspect(baseline);
  expect(before.conflictMarkerPaths).toEqual(['source.ts']);
  expect(Buffer.from(before.statusPorcelainBase64, 'base64').toString()).toContain('UU source.ts');
  writeFileSync(join(f.root, 'source.ts'), 'resolved with both intentions\n');
  const verified = await inspector.inspect(baseline);
  expect(verified.conflictMarkerPaths).toEqual([]);
  const approvedInputs = [{ inputId: 'input-1', digest: digest('input') }];
  const sourcePlan = createIntegrationExecutionPlan({ projectId: f.box.projectId, phaseId: 'phase-1', batchId: 'batch-1',
    runId: f.authorization.intent.runId, successorFeatureId: f.box.featureId,
    target: { baseCommit: base, repoIdentity: baseline.repoIdentity, canonicalPath: f.root, gitCommonDir: baseline.gitCommonDir },
    predecessors: [{ projectId: f.box.projectId, phaseId: 'phase-1', batchId: 'batch-1', runId: f.authorization.intent.runId,
      featureId: 'input-feature', dependencyPassed: true, coveredInputIds: ['input-1'], delivery: { commitSha: input,
        repoIdentity: baseline.repoIdentity, inputDigest: computeCoveredInputDigest(approvedInputs), evidenceId: 'delivery-1', evidenceDigest: digest('delivery') } }],
    approvedInputs, mergeOrder: ['input-feature'], verificationScope: ['combined-check'], integrationResult: null });
  const { schemaVersion: _schema, integrationId: _id, inputDigest: _digest, status: _status, ...inputPlan } = sourcePlan;
  const plan = sameRunRepair ? createIntegrationExecutionPlan({ ...inputPlan, repairAuthorization: {
    repairId:'repair-1',authorizationDigest:digest('auth'),sourceOperationId:digest('source-operation'),
  } }) : sourcePlan;
  const refs = { planRef: { id: 'verification-plan', digest: digest('plan') }, resultRef: { id: 'verification-result', digest: digest('result') } };
  f.authorization = { ...f.authorization, baseline, intent: { ...f.authorization.intent, operationId: plan.integrationId,
    operationType: 'integration_commit', integrationPlan: plan, expectedHead: parent,
    codeDigest: verificationCodeIdentity(verified).codeDigest, verificationRefs: [{ kind: 'verification_result', ...refs.resultRef }, { kind: 'artifact', ...refs.planRef }],
    budgetSnapshot: { sourcePlanId: 'source-plan', gitAgentRepair: { repairId: 'repair-1', authorizationDigest: digest('auth'),
      sourceOperationId: digest('source-operation'), sourceInputDigest: digest('source-input'), parents: [parent, input], verification: refs } } } } satisfies GitCommitAuthorization;
  const access = createSqliteFeatureResourceAccess(f.box.session,{nowUtcMs:()=>NOW});
  const integrationId = digest('source-operation');
  const resourceSet = normalizeFeatureResourceSet({projectId:f.box.projectId,resources:[
    {kind:'feature_code_shared',key:'feature-code'},{kind:'worktree_write_exclusive',key:`worktree:${integrationId}`},
    {kind:'contract',key:'contract:repair-contract'}]});
  f.box.session.transactWrite('test.integration-leases',()=>access.acquireInTransaction({resourceSet,
    owner:{ownerId:f.authorization.intent.ownerId,ownerVersion:1},leaseUntilUtcMs:NOW+60000}));
  let stopConfirmed = true;
  const integrationResources = {read:vi.fn(():IntegrationCommitResourceSnapshot=>({identity:f.authorization.resourceIdentity,invocationId:null,processIdentity:null,
    integrationId,ownerVersion:1,resourceSet,leases:f.box.session.database.inTransaction ? access.listProjectInTransaction(f.box.projectId)
      : f.box.session.transactWrite('test.read-integration-leases',()=>access.listProjectInTransaction(f.box.projectId))})),
    verifyStopped:vi.fn(async()=>stopConfirmed)};
  const deps = { ...f.deps, inspector, integrationResources };
  return { f, baseline, parent, input, plan, sourcePlan, before, verified, inspector, deps, integrationResources,
    setStopConfirmed(value:boolean){stopConfirmed=value;},service: createControlledGitCommitService(deps),
    reconciliation: createGitCommitReconciliationService({ ...deps, readVerificationInspection: () => verified }) };
}

describe('DAG F-011 real conflict controlled commit', () => {
  it.each(['commit','finalize','approval-drift'] as const)('[case:repair-builder-real-commit-%s] commits the actual frozen merge parents without a coding Attempt foreign key', async mode => {
    const x = await conflictFixture(true), { f, baseline, verified } = x;
    const db=f.box.session.database;
    const run=f.box.atomic.transact('test.repair-run',(tx:CommandTransaction)=>tx.getExecutionRun(f.box.projectId,x.sourcePlan.runId));
    const {schemaVersion:_s,integrationId:_id,inputDigest:_digest,status:_status,...planInput}=x.sourcePlan;
    const sourcePlan=createIntegrationExecutionPlan({...planInput,batchId:run.batchId,
      predecessors:planInput.predecessors.map(p=>({...p,batchId:run.batchId}))});
    db.prepare(`INSERT INTO features(id,created_at,project_id,updated_at,phase_id,title,status,plan_status,labels,source_refs,delivery_status)
      VALUES(?,?,?, ?,?,?,'completed','approved','[]','[]','succeeded')`)
      .run('input-feature',NOW,f.box.projectId,NOW,sourcePlan.phaseId,'input');
    const business=f.box.atomic.transact('test.repair-source-plan',(tx:CommandTransaction)=>{
      const p=tx.createIntegrationPlan({projectId:sourcePlan.projectId,phaseId:sourcePlan.phaseId,batchId:sourcePlan.batchId,
        successorFeatureId:sourcePlan.successorFeatureId,targetBaseline:sourcePlan.target.baseCommit,
        approvedInputs:sourcePlan.approvedInputs,mergeOrder:sourcePlan.mergeOrder,verificationScope:sourcePlan.verificationScope,
        strategySummary:{},integrationResult:null,predecessors:sourcePlan.predecessors.map(p=>({projectId:p.projectId,phaseId:p.phaseId,
          featureId:p.featureId,dependencyPassed:true,coveredInputIds:p.coveredInputIds,ancestorVerified:true,
          delivery:{commitSha:p.delivery!.commitSha,evidenceId:p.delivery!.evidenceId,evidenceDigest:p.delivery!.evidenceDigest}}))});
      return tx.freezeIntegrationPlan({projectId:p.projectId,integrationId:p.integrationId,expectedRevision:p.revision});
    });
    const registered = f.store.registerGitOperation({...f.authorization.intent,operationId:sourcePlan.integrationId,
      operationType:'integration',attemptId:null,integrationPlan:sourcePlan,expectedHead:baseline.baseCommit,
      candidateTree:baseline.baseCommit,codeDigest:sourcePlan.inputDigest,budgetSnapshot:{ownerVersion:1,sourcePlanId:business.integrationId,
        sourcePlanRevision:business.revision,sourcePlanInputDigest:business.inputDigest}}).operation;
    const source=f.store.finalizeGitOperation({projectId:sourcePlan.projectId,operationId:registered.intent.operationId,expectedRevision:registered.revision,
      status:'failed',actualCommit:null,actualTree:null,exitCode:1,durationMs:1,reasonCode:'merge_conflict',deliveryStatus:'not_requested',
      workspacePreserved:true,recoveryState:'preserved',settledAtUtcMs:NOW+1}).operation;
    const sourceBusiness=f.box.atomic.transact('test.repair-failed-result',(tx:CommandTransaction)=>tx.updateIntegrationPlanResult({projectId:business.projectId,
      integrationId:business.integrationId,expectedRevision:business.revision,operationId:source.intent.operationId,ownerId:source.intent.ownerId,
      ownerVersion:1,integrationResult:{commitSha:null,treeSha:null,verificationEvidence:null,llmNoConflictText:null,operationStatus:'failed'}}));
    const repairId=randomUUID(), commandId=randomUUID(), attemptId=randomUUID();
    const request = createGitAgentRepairRequest({projectId:f.box.projectId,phaseId:sourcePlan.phaseId,
      parentBatchId:sourcePlan.batchId,featureId:f.box.featureId,runId:sourcePlan.runId,repairId,commandId,
      source:{projectId:f.box.projectId,phaseId:sourcePlan.phaseId,parentBatchId:sourcePlan.batchId,featureId:f.box.featureId,
        runId:sourcePlan.runId,integrationId:sourcePlan.integrationId,operationId:sourcePlan.integrationId,operationType:'integration',
        operationDigest:source.intentDigest,inputDigest:sourcePlan.inputDigest,failureKind:'conflict',evidenceId:sourcePlan.integrationId,evidenceDigest:digest('failure')},
      target:{repoIdentity:baseline.repoIdentity,baselineCommitSha:baseline.baseCommit,
        baselineDigest:computeGitAgentRepairBaselineDigest({repoIdentity:baseline.repoIdentity,baselineCommitSha:baseline.baseCommit})},
      workspace:{workspaceId:sourcePlan.integrationId,workspaceDigest:digest('workspace')},conflictFiles:['source.ts'],writablePaths:['source.ts'],
      intent:{intentId:'intent-1',digest:digest('intent')},verification:{strategyId:'checks',digest:digest('checks')},
      budget:{remainingAttempts:1,remainingTokens:100,remainingRuntimeMs:60000,deadlineUtcMs:NOW+60000}},{nowUtcMs:NOW});
    const attempt = {id:attemptId,repairId:request.repairId,projectId:request.projectId,runId:sourcePlan.runId,
      ownerId:source.intent.ownerId,hostInstanceId:source.intent.hostInstanceId,authorizationVersion:1,
      dispatch:{claimId:'claim-1',claimVersion:1,slotId:'slot-1'},startedAtUtcMs:NOW,deadlineUtcMs:NOW+60000,maxTokens:100,maxRuntimeMs:60000,
      output:{schemaVersion:1 as const,repairId:request.repairId,status:'modified' as const,changedPaths:['source.ts'],usage:{consumedTokens:1,runtimeMs:1},failureCode:null},stoppedAtUtcMs:NOW+1};
    const repair: GitAgentRepairView = {request,receipt:{repairId:request.repairId,parentBatchId:sourcePlan.batchId,runId:sourcePlan.runId,
      authorizationDigest:request.authorizationDigest,blockedReason:null},authorizationVersion:1,blockedReason:null,attempts:[attempt]};
    const verification: IntegrationRepairVerificationRecord = {projectId:request.projectId,repairId:request.repairId,attemptId:attempt.id,
      artifact:{artifactId:'binding-1',projectId:request.projectId,contentHash:digest('binding'),sizeBytes:1,locator:'binding.json',version:1},
      planRef:{id:'plan-1',digest:digest('plan')},resultRef:{id:'result-1',digest:digest('result')},inputDigest:sourcePlan.inputDigest,status:'passed'};
    const session = f.deps.driver.open(baseline,()=>{});
    const input = {repair,source,verification,baseline,inspection:verified,facts:await session.facts(),changedPaths:['source.ts'],
      attemptId:attempt.id,ownerId:attempt.ownerId,hostInstanceId:attempt.hostInstanceId,executionVersion:1,
      expectedFeatureRevision:f.authorization.intent.expectedFeatureRevision,mergeParents:await session.mergeHeads!(),sourcePlan:sourceBusiness};
    const authorization = createIntegrationRepairCommitAuthorization(input);
    const repairBinding=authorization.intent.budgetSnapshot?.gitAgentRepair as {parents:string[];repairAttemptId:string}|undefined;
    expect(repairBinding?.parents).toEqual([x.parent,x.input]);
    expect(authorization.intent.codeDigest).toBe(verificationCodeIdentity(verified).codeDigest);
    expect(authorization.intent.attemptId).toBeNull();
    expect(repairBinding?.repairAttemptId).toBe(attempt.id);
    f.authorization=authorization;
    const snapshot=x.integrationResources.read();
    const resourceSet=normalizeFeatureResourceSet({projectId:request.projectId,resources:[
      {kind:'feature_code_shared',key:'feature-code'},{kind:'worktree_write_exclusive',key:`worktree:${sourcePlan.integrationId}`} ]});
    const access=createSqliteFeatureResourceAccess(f.box.session,{nowUtcMs:()=>NOW});
    f.box.session.transactWrite('test.builder-leases',()=>access.acquireInTransaction({resourceSet,owner:{ownerId:attempt.ownerId,ownerVersion:1},leaseUntilUtcMs:NOW+60000}));
    x.integrationResources.read.mockImplementation(()=>({...snapshot,identity:authorization.resourceIdentity,integrationId:sourcePlan.integrationId,resourceSet,
      leases:resourceSet.resources.flatMap(resource=>access.read(resource))}));
    const readBusiness=()=>f.box.atomic.transact('test.repair-read-source-plan',(tx:CommandTransaction)=>tx.getIntegrationPlan(request.projectId,business.integrationId));
    let current=true;
    const holds:string[]=[];
    const finalizer=createIntegrationRepairFinalizationService({atomic:f.box.atomic,
      repair:{read:()=>repair,hold:(_p,_r,reason)=>{holds.push(reason);return repair;}},
      operations:f.store,inspector:x.inspector,driver:f.deps.driver,lock:f.deps.lock,resources:{read(){throw new Error('coding lease');}},
      integrationResources:x.integrationResources,readSource:()=>f.store.getGitOperation(request.projectId,source.intent.operationId),
      readVerification:()=>verification,readBaseline:()=>baseline,readBefore:()=>x.before,
      readSourcePlan:readBusiness,expectedFeatureRevision:()=>input.expectedFeatureRevision,
      assertCurrent:()=>current,authorize:()=>current,nowUtcMs:()=>NOW+2});
    if(mode==='approval-drift')f.beforeCommit(()=>{current=false;});
    if(mode!=='commit') {
      const result=await finalizer.finalize({projectId:request.projectId,repairId,attemptId});
      if(mode==='approval-drift') {
        expect(result).toMatchObject({successorUnlocked:false});
        expect(git(['rev-parse','HEAD'],f.root).trim()).toBe(x.parent);
        expect(readBusiness().status).not.toBe('integration_passed');
        expect(holds).toContain('identity_or_lock');
        return;
      }
      expect(result).toMatchObject({outcome:'committed',reason:null,successorUnlocked:true});
      expect(readBusiness()).toMatchObject({status:'integration_passed',integrationResult:{operationId:source.intent.operationId}});
      expect(f.store.getGitOperation(request.projectId,source.intent.operationId)).toEqual(source);
      expect(await finalizer.finalize({projectId:request.projectId,repairId,attemptId})).toEqual(result);
      return;
    }
    const result=await x.service.commit({projectId:request.projectId,operationId:authorization.intent.operationId});
    expect(result.status).toBe('succeeded');
    expect(git(['show','-s','--format=%P','HEAD'],f.root).trim().split(' ')).toEqual([x.parent,x.input]);
    expect(await x.service.commit({projectId:request.projectId,operationId:authorization.intent.operationId})).toEqual(result);
    expect(f.box.session.database.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({n:0});
  });
  it('[case:repair-real-integration-lease-delegation] uses actual Feature resource leases, never fabricated coding Attempt leases', async () => {
    const x = await conflictFixture(true);
    x.f.deps.resources.read = () => {throw new Error('coding leases must not be read');};
    const result = await x.service.commit({projectId:x.f.box.projectId,operationId:x.plan.integrationId});
    expect(result.status).toBe('succeeded');
    expect(x.integrationResources.read).toHaveBeenCalled();
    expect(x.integrationResources.verifyStopped).toHaveBeenCalled();
  });

  it('[case:repair-real-integration-stop-refusal] does not stage or register a commit without stopped integration writer evidence', async () => {
    const x = await conflictFixture(true);
    x.setStopConfirmed(false);
    const before = git(['ls-files','-u'],x.f.root);
    await expect(x.service.commit({projectId:x.f.box.projectId,operationId:x.plan.integrationId})).rejects.toMatchObject({details:{reason:'previous_writer_stop_unconfirmed'}});
    expect(git(['ls-files','-u'],x.f.root)).toBe(before);
    expect(git(['rev-parse','HEAD'],x.f.root).trim()).toBe(x.parent);
  });

  it('[case:repair-real-integration-no-fence] rejects an integration commit without its real resource fence', async () => {
    const x = await conflictFixture(true);
    await expect(createControlledGitCommitService({...x.deps,integrationResources:undefined})
      .commit({projectId:x.f.box.projectId,operationId:x.plan.integrationId})).rejects.toMatchObject({details:{reason:'integration_resource_fence_required'}});
    const snapshot = x.integrationResources.read();
    for (const changed of [
      {...snapshot,identity:{...snapshot.identity,owner:'wrong-owner'}},
      {...snapshot,ownerVersion:2},
      {...snapshot,integrationId:'wrong-source-operation'},
      {...snapshot,leases:snapshot.leases.filter(lease=>lease.resource.kind!=='contract')},
      {...snapshot,leases:snapshot.leases.map(lease=>({...lease,leaseUntilUtcMs:NOW}))},
    ]) {
      x.integrationResources.read.mockReturnValue(changed);
      await expect(x.service.commit({projectId:x.f.box.projectId,operationId:x.plan.integrationId})).rejects.toThrow();
      expect(git(['rev-parse','HEAD'],x.f.root).trim()).toBe(x.parent);
      expect(git(['ls-files','-u'],x.f.root).trim()).not.toBe('');
    }
  });
  it('[case:repair-real-verified-candidate-commit] runs a real bounded check on dirty conflict bytes before the controlled merge commit', async () => {
    const x = await conflictFixture(true), {f,plan,baseline,verified} = x;
    const artifacts = createSqliteArtifactStore(f.box.session);
    const files = createArtifactFileStore({dataRoot:f.box.box.dataRoot});
    const publisher = createArtifactPublisher({artifacts,files,limits:{maxSizeBytes:4000000,timeoutMs:30000}});
    const confirm = async (identity:{launchId:string}) => ({launchId:identity.launchId});
    const check = {checkKey:'combined-check',scope:'module' as const,kind:'command' as const,
      argv:[process.execPath,'-e',`const fs=require('node:fs');if(fs.readFileSync('source.ts','utf8')!=='resolved with both intentions\\n')process.exit(1);console.log('SHIPLOOP_NODE_CHECK_RESULT='+JSON.stringify({schemaVersion:1,protocol:'shiploop.node-check',collected:true,testCount:1,targets:['combined-check']}));`],
      cwdRef:null,environmentRef:null,timeout:10000,required:true,requirementRefs:[]};
    const facts = await f.deps.driver.open(baseline,()=>{}).facts();
    const input: IntegrationVerificationExecutionInput = {projectId:f.box.projectId,operationId:plan.integrationId,
      sourcePlanId:'source-plan',targetBaseline:baseline.baseCommit,inputDigest:plan.inputDigest,targets:['combined-check'],
      workspace:{workspaceId:plan.integrationId,ownerId:f.authorization.intent.ownerId,ownerVersion:1,path:f.root,
        gitCommonDir:baseline.gitCommonDir,repoIdentity:baseline.repoIdentity,targetBase:baseline.baseCommit,plan,
        gitIdentity:f.authorization.intent.gitIdentity,status:'blocked',currentHead:facts.head,steps:[],
        facts:{...facts,statusPorcelain:Buffer.from(verified.statusPorcelainBase64,'base64').toString(),unresolvedPaths:['source.ts']}},
      plan:{status:'ready',mode:'candidates',affectedModules:['source'],coveredModules:['source'],selectedCheckKeys:['combined-check'],
        selectedChecks:[check],unselectedCheckKeys:[],reasonCode:'candidate_covered',reason:'fixture candidate',candidateDigest:null,candidateRejection:null}};
    const deadlineUtcMs = Date.now()+30000;
    const executor = createNodeIntegrationCandidateVerificationExecutor({processes:createCommandProcessAdapter(),artifacts,files,publisher,
      driverFor:()=>f.deps.driver,inspector:x.inspector,
      authorize:async()=>({deadlineUtcMs,bindingId:baseline.repositoryBindingId,bindingRevision:baseline.repositoryBindingRevision}),
      confirmProcessIdentity:async(_input,identity)=>confirm(identity),resolveCwd:async root=>root,resolveEnvironment:()=>({}),
      assertOutsideTransaction(){expect(f.box.session.database.inTransaction).toBe(false);}},
      {operationId:plan.integrationId,inputDigest:plan.inputDigest,inspection:verified});
    const result = await executor.start(input);
    expect(result).toMatchObject({status:'passed',stopped:true});
    expect(git(['rev-parse','HEAD'],f.root).trim()).toBe(x.parent);
    expect(git(['ls-files','-u'],f.root).trim()).not.toBe('');
    const refs = {planRef:result.verificationPlan,resultRef:result.verificationResult};
    f.authorization = {...f.authorization,intent:{...f.authorization.intent,
      verificationRefs:[{kind:'verification_result',...refs.resultRef},{kind:'artifact',...refs.planRef}],
      budgetSnapshot:{...f.authorization.intent.budgetSnapshot,
        gitAgentRepair:{...f.authorization.intent.budgetSnapshot.gitAgentRepair,verification:refs}}}};
    const operation = await x.service.commit({projectId:f.box.projectId,operationId:plan.integrationId});
    expect(operation).toMatchObject({status:'succeeded',integrationResult:{verificationEvidence:refs}});
    expect(git(['show','-s','--format=%P','HEAD'],f.root).trim().split(' ')).toEqual([x.parent,x.input]);
    expect(git(['status','--porcelain'],f.root).trim()).toBe('');
  });
  it.each([false,true])('[case:repair-real-conflict-commit-%s] Core stages resolved bytes and commits the exact two parents without changing Feature delivery', async sameRunRepair => {
    const { f, parent, input, plan, sourcePlan, service } = await conflictFixture(sameRunRepair);
    if (sameRunRepair) {
      expect(plan.runId).toBe(sourcePlan.runId);
      expect(plan.integrationId).not.toBe(sourcePlan.integrationId);
    }
    const before = f.box.session.database.prepare('SELECT delivery_status, revision FROM features WHERE id = ?').get(f.box.featureId);
    const operation = await service.commit({ projectId: f.box.projectId, operationId: plan.integrationId });
    expect(operation).toMatchObject({ status: 'succeeded', deliveryStatus: 'not_requested', integrationResult: { integrationId: plan.integrationId, inputDigest: plan.inputDigest } });
    expect(git(['show', '-s', '--format=%P', 'HEAD'], f.root).trim().split(' ')).toEqual([parent, input]);
    expect(f.box.session.database.prepare('SELECT delivery_status, revision FROM features WHERE id = ?').get(f.box.featureId)).toEqual(before);
    expect(await service.commit({ projectId: f.box.projectId, operationId: plan.integrationId })).toEqual(operation);
  });
  it('[case:repair-real-lost-receipt] reconciliation observes the existing merge repair and never commits again', async () => {
    const { f, plan, service, reconciliation } = await conflictFixture();
    f.afterCommit(() => { throw new Error('receipt_interrupted'); });
    await expect(service.commit({ projectId: f.box.projectId, operationId: plan.integrationId })).rejects.toThrow('receipt_interrupted');
    f.deps.resources.read = () => {throw new Error('recovery must use integration leases');};
    const head = git(['rev-parse', 'HEAD'], f.root).trim();
    expect(f.store.getGitOperation(f.box.projectId, plan.integrationId).status).toBe('pending');
    const restored = await reconciliation.reconcile({ projectId: f.box.projectId, operationId: plan.integrationId });
    expect(restored).toMatchObject({ outcome: 'matched', operation: { status: 'succeeded', actualCommit: head, deliveryStatus: 'not_requested' } });
    expect(await service.commit({ projectId: f.box.projectId, operationId: plan.integrationId })).toEqual(restored.operation);
    expect(git(['rev-parse', 'HEAD'], f.root).trim()).toBe(head);
  });
});
