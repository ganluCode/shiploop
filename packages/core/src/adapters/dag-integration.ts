import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { stableStringify } from '../ports/feature-plan.js';
import type { SqliteStorageSession } from './sqlite/session.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { ArtifactFileStore } from '../ports/artifact-files.js';
import type { ArtifactPublisher } from '../application/artifact-publish.js';
import type { CommandProcessPort, CommandProcessIdentity } from '../ports/command-process.js';
import type { GitPublicMetadataLock } from '../ports/git-public-metadata-lock.js';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import type { IntegrationExecutionObservation } from '../ports/git-integration-journal.js';
import type { IntegrationVerificationExecutionInput } from '../ports/integration-verification.js';
import { createSqliteDagIntegrationContext, integrationFailure, integrationHash } from './sqlite/dag-integration-context.js';
import { createSqliteGitIntegrationJournal } from './sqlite/git-integration-journal.js';
import { createIntegrationPlan } from '../ports/integration-plan.js';
import { createIntegrationExecutionPlan, computeCoveredInputDigest } from '../ports/integration-execution-plan.js';
import { createDeterministicIntegrationService } from '../application/deterministic-integration.js';
import { createGitIntegrationReconciliationService } from '../application/git-integration-reconciliation.js';
import { createIntegrationVerificationService } from '../application/integration-verification.js';
import { createIntegrationGitWorkspace } from './fs/integration-git-workspace.js';
import { createIntegrationGitRecoveryReader } from './fs/recovery-git-reader.js';
import { createGitCommitDriver } from './fs/git-commit-driver.js';
import { createWorkspaceInspector } from './fs/workspace-inspector.js';
import { createNodeIntegrationVerificationExecutor } from './integration-verification.js';
import { createArtifactVerifier } from '../application/artifact-verify.js';
import { verifyStoredVerificationOutputs } from '../application/verification-output-evidence.js';
import { createSqliteVerificationStore } from './sqlite/verification-store.js';
import { normalizeFeatureResourceSet } from '../ports/feature-resources.js';
import { createBaselineWorkspaceReader } from './fs/baseline-workspace.js';
import { readRunExecutionBaseline } from './sqlite/run-execution-baseline.js';
import { createSqliteIntegrationRepairAuthorizations } from './sqlite/integration-repair-authorizations.js';
import { validateGitAgentRepairRequest } from '../ports/git-agent-repair.js';
import type { IntegrationRepairFence } from '../ports/integration-repair-authorization.js';
import type { ProductionGitAgentRuntimeFactory, ProductionGitAgentAuthority } from '../ports/git-agent-production.js';
import type { RuntimeCapabilityCatalog } from '../ports/runtime-capabilities.js';
import { createStaticRuntimeCapabilityCatalog } from '../ports/runtime-capabilities.js';
import { createIntegrationRepairContextService } from './integration-repair-context.js';
import type { IntegrationRepairContextReceipt } from '../ports/integration-repair-context.js';
import { resolveWorkflowLocale } from '../ports/locale.js';
import { createSqliteIntegrationRepairAttempts } from './sqlite/integration-repair-attempts.js';
import { createIntegrationRepairRuntimeAuthority } from './integration-repair-runtime.js';
import { createIntegrationRepairConsumer, type IntegrationRepairConsumeResult } from '../application/integration-repair-consumer.js';
import type { IntegrationRepairAttemptClaim } from '../ports/integration-repair-attempt.js';
import { createNodeIntegrationCandidateVerificationExecutor } from './integration-verification.js';
import { createSqliteIntegrationRepairCandidates } from './sqlite/integration-repair-candidates.js';
import { createSqliteIntegrationRepairVerifications } from './sqlite/integration-repair-verifications.js';
import { createSqliteGitOperationStore } from './sqlite/git-operations.js';
import { gitAgentIntegrationCommitPlan } from '../ports/git-agent-integration-commit.js';
import { createIntegrationRepairFinalizationService } from '../application/integration-repair-finalization.js';

export function assembleDagIntegration(options: {
  session: SqliteStorageSession; dataRoot: string; artifacts: ArtifactStore; files: ArtifactFileStore;
  publisher: ArtifactPublisher; processes: CommandProcessPort; lock: GitPublicMetadataLock;
  runtimeFactory?: ProductionGitAgentRuntimeFactory;
  capabilityCatalog?: RuntimeCapabilityCatalog;
  assertCanDispatch(): void; wake(): void; nowUtcMs?: () => number;
}) {
  const { session } = options, db = session.database, now = options.nowUtcMs ?? Date.now;
  if (typeof options.processes.recoverStop !== 'function') throw new TypeError('Integration requires supervised process recovery');
  const context = createSqliteDagIntegrationContext(session, { nowUtcMs: now }), atomic = context.atomic;
  const journal = createSqliteGitIntegrationJournal(session, { nowUtcMs: now });
  const artifacts = createArtifactVerifier({ artifacts: options.artifacts, files: options.files, limits: { maxReadBytes: 16_000_000 } });
  const verificationStore = createSqliteVerificationStore(session, { nowUtcMs: now });
  const repairAuthorizations = createSqliteIntegrationRepairAuthorizations(session, { nowUtcMs: now });
  const hostOwner = randomUUID();
  const pending = new Map<string,Promise<void>>();
  const pendingRepairContexts = new Map<string,Promise<IntegrationRepairContextReceipt>>();
  const pendingRepairConsumers = new Map<string,Promise<IntegrationRepairConsumeResult>>();
  let accepting = true, scanPromise: Promise<void> | undefined;
  function outside() { if (db.inTransaction) throw new TypeError('integration I/O inside SQLite write transaction'); }
  function readAuth(projectId:string, operationId:string) {
    return atomic.transact('DagIntegration.authorize', tx => { options.assertCanDispatch(); return context.authorize(tx,projectId,operationId); });
  }
  function processPort(projectId:string,operationId:string):CommandProcessPort {
    return { recoverStop: options.processes.recoverStop, async start(request,confirm,signal) {
      outside(); readAuth(projectId,operationId);
      const handle=await options.processes.start(request,async identity=>{
        atomic.transact('DagIntegration.confirmProcess',tx=>{
          context.authorize(tx,projectId,operationId);
          db.prepare(`INSERT INTO integration_processes(project_id,operation_id,launch_id,process_identity,created_at) VALUES(?,?,?,?,?)`)
            .run(projectId,operationId,identity.launchId,JSON.stringify(identity),now());
        });
        const receipt=await confirm(identity); readAuth(projectId,operationId); return receipt;
      },signal);
      void handle.stopped.then(stop=>{
        if(stop.confirmed && session.isOpen()) session.transactWrite('DagIntegration.processStopped',()=>{
          db.prepare('UPDATE integration_processes SET stopped=1 WHERE project_id=? AND operation_id=? AND launch_id=?')
            .run(projectId,operationId,handle.identity.launchId);
        });
      }).catch(()=>undefined);
      return handle;
    } };
  }
  function repairContextService(projectId: string, repairId: string) {
    const record = atomic.transact('DagIntegration.repairContextSource',tx=>repairAuthorizations.read(tx,projectId,repairId));
    const operationId = record.request.source.operationId;
    const processes = processPort(projectId,operationId);
    return createIntegrationRepairContextService({session,dataRoot:options.dataRoot,artifacts:options.artifacts,files:options.files,
      publisher:options.publisher,nowUtcMs:now,capabilityCatalog:options.capabilityCatalog ?? createStaticRuntimeCapabilityCatalog([]),
      inspector:createWorkspaceInspector({authorizedRoots:[options.dataRoot],processes,integrationRepair:true,
        confirmProcessIdentity:async identity=>({launchId:identity.launchId})}),
      facts(tx,requestedProject,requestedRepair) {
        options.assertCanDispatch();
        if (requestedProject !== projectId || requestedRepair !== repairId) integrationFailure('repair_identity_mismatch');
        const authorization = repairAuthorizations.read(tx,projectId,repairId);
        const auth = context.authorize(tx,projectId,operationId), current = auth.current;
        const request = authorization.request;
        const source = tx.getGitOperation(projectId,operationId), observation = journal.read(tx,projectId,operationId);
        if (source.intentDigest !== request.source.operationDigest || source.intent.runId !== request.runId
          || request.verification.digest !== integrationHash(current.policy)) integrationFailure('repair_context_changed');
        const selected = current.settings.strategies.modelMap.high?.strategy;
        if (!selected) integrationFailure('git_agent_strategy_missing');
        const strategy = {runtime:selected.runtime,provider:selected.provider,model:selected.model,
          ...(selected.credentialRef === undefined ? {} : {credentialRef:selected.credentialRef}),
          ...(selected.endpointRef === undefined ? {} : {endpointRef:selected.endpointRef})};
        const evidence = source.status === 'failed' ? source.receipt : observation;
        if (evidence === null) integrationFailure('repair_evidence_missing');
        const expectedHead = observation?.workspace?.currentHead;
        if (!expectedHead) integrationFailure('repair_workspace_evidence_missing');
        return {authorization,baseline:{repositoryBindingId:current.binding.id,repositoryBindingRevision:current.binding.bindingRevision,
          repoIdentity:current.binding.repoIdentity,canonicalPath:auth.intent.worktreePath,gitCommonDir:current.binding.gitCommonDir!,
          branch:'HEAD',baseCommit:request.target.baselineCommitSha},expectedHead,strategy,locale:resolveWorkflowLocale(current.settings.locale),
          maxRequests:current.settings.policies.piExecution?.value?.maxRequests ?? 10000,
          policyDigest:integrationHash({strategy,locale:current.settings.locale,checks:current.policy,
            execution:current.settings.policies.piExecution?.value ?? null,deliveryPolicyDigest:current.deliveryPolicyDigest}),
          verificationPlan: current.policy,
          evidence:stableStringify(evidence)};
      },
    });
  }
  async function stopped(projectId:string,operationId:string) {
    outside();
    const rows=db.prepare('SELECT launch_id,process_identity FROM integration_processes WHERE project_id=? AND operation_id=? AND stopped=0')
      .all(projectId,operationId) as {launch_id:string;process_identity:string}[];
    for(const row of rows) {
      if(!(await options.processes.recoverStop!(JSON.parse(row.process_identity))).confirmed) return false;
      session.transactWrite('DagIntegration.recoveredStop',()=>db.prepare('UPDATE integration_processes SET stopped=1 WHERE project_id=? AND operation_id=? AND launch_id=?')
        .run(projectId,operationId,row.launch_id));
    }
    return true;
  }
  async function verifyDeliveries(current:ReturnType<typeof context.snapshot>) {
    outside();
    const confirm=async(identity:CommandProcessIdentity)=>{
      const content=Buffer.from(JSON.stringify(identity));
      await options.publisher.publishArtifact({projectId:current.projectId,kind:'integration-fact-process',mediaType:'application/json',
        locator:`integrations/facts/${identity.launchId}.json`,expectedHash:createHash('sha256').update(content).digest('hex'),content:[content]});
      return {launchId:identity.launchId};
    };
    const git=createGitCommitDriver({confirmProcessIdentity:confirm}).open({repositoryBindingId:current.binding.id,
      repositoryBindingRevision:current.binding.bindingRevision,repoIdentity:current.binding.repoIdentity,
      canonicalPath:current.binding.canonicalPath,gitCommonDir:current.binding.gitCommonDir!,branch:'',baseCommit:current.auth.targetBaseline},()=>outside());
    const facts=await git.facts();
    if(facts.head!==current.auth.targetBaseline) integrationFailure('target_head_drift');
    for(const parent of current.predecessors) {
      if(!await git.isAncestor(parent.operation.actualCommit!,parent.operation.actualCommit!)) integrationFailure('input_missing');
      if(!await git.isAncestor(current.auth.targetBaseline,parent.operation.actualCommit!)) integrationFailure('ancestor_not_verified');
      for(const ref of parent.operation.intent.verificationRefs) if(ref.kind==='verification_batch') {
        await verifyStoredVerificationOutputs({verification:verificationStore,artifacts:options.artifacts,files:options.files},current.projectId,ref.id);
      }
      for(const ref of parent.feature.sourceRefs) if(ref.contentHash) {
        const verified=await artifacts.verifyArtifact(current.projectId,ref.artifactId);
        if(verified.kind!=='verified_ready'||verified.contentHash!==ref.contentHash) integrationFailure('input_evidence_changed');
      }
    }
  }
  function quarantine(projectId:string,operationId:string,reason:string) {
    session.transactWrite('DagIntegration.quarantine',()=>{
      const {row}=context.claim(projectId,operationId);
      context.resources.quarantineOwnerInTransaction(projectId,{ownerId:row.owner_id,ownerVersion:row.owner_version},'integration_stop_unconfirmed');
      db.prepare(`UPDATE integration_execution_claims SET admission='quarantined',reason=?,revision=revision+1 WHERE project_id=? AND operation_id=?`)
        .run(reason,projectId,operationId);
    });
  }
  function settleIntegrationSuccessInTransaction(tx: CommandTransaction, projectId: string, operationId: string, expectedRunId: string) {
    const live = context.authorize(tx,projectId,operationId);
    if (live.current.run.id !== expectedRunId) integrationFailure('run_identity_changed');
    const source = tx.getIntegrationPlan(projectId,live.row.source_plan_id);
    const result = source.integrationResult;
    if (source.status!=='integration_passed' || !result?.commitSha || result.operationId!==operationId) integrationFailure('integration_not_verified');
    const existing = db.prepare('SELECT base_commit FROM run_execution_baselines WHERE project_id=? AND run_id=?')
      .get(projectId,live.current.run.id) as {base_commit:string}|undefined;
    if (existing) {
      if (existing.base_commit!==result.commitSha) integrationFailure('baseline_conflict');
    } else {
      db.prepare(`INSERT INTO run_execution_baselines(project_id,run_id,feature_id,batch_id,repository_binding_id,binding_revision,repo_identity,base_commit,
        integration_id,plan_revision,authorization_digest,input_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(projectId,live.current.run.id,live.current.feature.id,live.current.batch.id,live.current.binding.id,live.current.binding.bindingRevision,
          live.current.binding.repoIdentity,result.commitSha,source.integrationId,source.revision,live.current.auth.authorizationDigest,source.inputDigest,now());
    }
    context.resources.releaseOwnerAfterStopInTransaction(projectId,{ownerId:live.row.owner_id,ownerVersion:live.row.owner_version});
    db.prepare(`UPDATE integration_execution_claims SET admission='settled',revision=revision+1,reason=NULL WHERE project_id=? AND operation_id=? AND admission<>'settled'`)
      .run(projectId,operationId);
  }
  async function execute(projectId:string,runId:string) {
    if(!accepting)return;
    options.assertCanDispatch();
    const current=context.snapshot(projectId,runId);
    await verifyDeliveries(current);
    const frozen=context.snapshot(projectId,runId);
    if(integrationHash(current)!==integrationHash(frozen)) integrationFailure('authorization_changed');
    if(frozen.predecessors.length===1) {
      const parent=frozen.predecessors[0]!;
      const proof={projectId,runId,authorizationDigest:frozen.auth.authorizationDigest,featureId:parent.feature.id,
        deliveryOperationId:parent.operation.intent.operationId,commitSha:parent.operation.actualCommit,
        treeSha:parent.operation.actualTree,evidenceDigest:parent.evidenceDigest};
      const content=Buffer.from(JSON.stringify(proof));
      const evidence=await options.publisher.publishArtifact({projectId,kind:'single-predecessor-baseline',mediaType:'application/json',
        locator:`integrations/reuse/${runId}/${randomUUID()}.json`,expectedHash:createHash('sha256').update(content).digest('hex'),content:[content]});
      atomic.transact('DagIntegration.reuseSingle',tx=>{
        const live=context.read(tx,projectId,runId);
        if(integrationHash(live)!==integrationHash(frozen))integrationFailure('authorization_changed');
        const source=tx.createIntegrationPlan({projectId,phaseId:live.batch.phaseId,batchId:live.batch.id,successorFeatureId:live.feature.id,
          targetBaseline:live.auth.targetBaseline,predecessors:[{projectId,phaseId:live.batch.phaseId,featureId:parent.feature.id,
            dependencyPassed:true,coveredInputIds:[parent.feature.id],ancestorVerified:true,delivery:{commitSha:parent.operation.actualCommit,
              evidenceId:parent.operation.intent.operationId,evidenceDigest:parent.evidenceDigest}}],
          approvedInputs:[{inputId:parent.feature.id,digest:integrationHash(proof)}],mergeOrder:[parent.feature.id],verificationScope:live.policy.selectedCheckKeys,
          strategySummary:{authorizationDigest:live.auth.authorizationDigest,checkPolicyDigest:live.approval.checkPolicyDigest},
          integrationResult:{commitSha:parent.operation.actualCommit,treeSha:parent.operation.actualTree,
            verificationEvidence:{evidenceId:evidence.artifact.id,evidenceDigest:evidence.artifact.contentHash},llmNoConflictText:null}});
        const plan=tx.freezeIntegrationPlan({projectId,integrationId:source.integrationId,expectedRevision:source.revision});
        if(plan.status!=='integration_passed')integrationFailure('integration_not_verified');
        db.prepare(`INSERT INTO run_execution_baselines(project_id,run_id,feature_id,batch_id,repository_binding_id,binding_revision,repo_identity,base_commit,
          integration_id,plan_revision,authorization_digest,input_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(projectId,runId,live.feature.id,
            live.batch.id,live.binding.id,live.binding.bindingRevision,live.binding.repoIdentity,parent.operation.actualCommit,plan.integrationId,plan.revision,
            live.auth.authorizationDigest,plan.inputDigest,now());
      });
      options.wake();return;
    }
    const admission=atomic.transact('DagIntegration.admit',tx=>{
      const live=context.read(tx,projectId,runId);
      if(integrationHash(live)!==integrationHash(frozen)) integrationFailure('authorization_changed');
      const previous=db.prepare('SELECT operation_id FROM integration_execution_claims WHERE project_id=? AND run_id=?').get(projectId,runId) as {operation_id:string}|undefined;
      if(previous)return { ...context.claim(projectId,previous.operation_id), fresh:false };
      const inputs=live.predecessors.map(parent=>({inputId:parent.feature.id,digest:integrationHash({planDigest:parent.feature.planDigest,commit:parent.operation.actualCommit,evidence:parent.evidenceDigest})}));
      const sourceInput={projectId,phaseId:live.batch.phaseId,batchId:live.batch.id,successorFeatureId:live.feature.id,targetBaseline:live.auth.targetBaseline,
        predecessors:live.predecessors.map(parent=>({projectId,phaseId:live.batch.phaseId,featureId:parent.feature.id,dependencyPassed:true,
          coveredInputIds:[parent.feature.id],ancestorVerified:true,delivery:{commitSha:parent.operation.actualCommit!,evidenceId:parent.operation.intent.operationId,evidenceDigest:parent.evidenceDigest}})),
        approvedInputs:inputs,mergeOrder:live.predecessors.map(parent=>parent.feature.id),verificationScope:live.policy.selectedCheckKeys,
        strategySummary:{authorizationDigest:live.auth.authorizationDigest,checkPolicyDigest:live.approval.checkPolicyDigest,deliveryPolicyDigest:live.deliveryPolicyDigest},integrationResult:null};
      const calculated=createIntegrationPlan(sourceInput);
      let source=tx.createIntegrationPlan(sourceInput);
      if(source.integrationId!==calculated.integrationId)integrationFailure('integration_identity_changed');
      source=tx.freezeIntegrationPlan({projectId,integrationId:source.integrationId,expectedRevision:source.revision});
      const plan=createIntegrationExecutionPlan({projectId,phaseId:live.batch.phaseId,batchId:live.batch.id,runId,successorFeatureId:live.feature.id,
        target:{baseCommit:live.auth.targetBaseline,repoIdentity:live.binding.repoIdentity,canonicalPath:live.binding.canonicalPath,gitCommonDir:live.binding.gitCommonDir!},
        predecessors:live.predecessors.map(parent=>({projectId,phaseId:live.batch.phaseId,batchId:live.batch.id,runId,featureId:parent.feature.id,
          dependencyPassed:true,coveredInputIds:[parent.feature.id],delivery:{commitSha:parent.operation.actualCommit!,repoIdentity:live.binding.repoIdentity,
            inputDigest:computeCoveredInputDigest(inputs.filter(input=>input.inputId===parent.feature.id)),evidenceId:parent.operation.intent.operationId,evidenceDigest:parent.evidenceDigest}})),
        approvedInputs:inputs,mergeOrder:source.mergeOrder,verificationScope:source.verificationScope,integrationResult:null});
      const ownerId=`integration-${hostOwner}`, ownerVersion=1;
      const intent={projectId,operationId:plan.integrationId,featureId:live.feature.id,runId,attemptId:null,executionVersion:1,operationType:'integration' as const,
        repositoryBindingId:live.binding.id,repoIdentity:live.binding.repoIdentity,worktreePath:join(options.dataRoot,'projects',projectId,'integrations',plan.integrationId),
        expectedHead:plan.target.baseCommit,candidateTree:plan.target.baseCommit,codeDigest:plan.inputDigest,verificationRefs:[],approvalRefs:[],message:'deterministic integration',
        gitIdentity:live.delivery.gitIdentity,deliveryPolicyDigest:live.deliveryPolicyDigest,runtimeSource:null,ownerId,hostInstanceId:hostOwner,integrationPlan:plan,
        budgetSnapshot:{ownerVersion,sourcePlanId:source.integrationId,sourcePlanRevision:source.revision,checkPolicyDigest:live.approval.checkPolicyDigest,
          authorizationDigest:live.auth.authorizationDigest,
          predecessorRuns:Object.fromEntries(live.predecessors.map(parent=>[parent.feature.id,{batchId:parent.run.batchId,runId:parent.run.id}])),
          predecessorRevisions:Object.fromEntries(live.predecessors.map(parent=>[parent.feature.id,parent.feature.revision]))},
        expectedFeatureRevision:live.feature.revision};
      const resourceSet=normalizeFeatureResourceSet({projectId,resources:[...live.resourceSet.resources.map(({accessMode:_a,leaseMode:_l,...resource})=>resource),
        {kind:'worktree_write_exclusive',key:`worktree:${plan.integrationId}`} ]});
      context.resources.acquireInTransaction({resourceSet,owner:{ownerId,ownerVersion},leaseUntilUtcMs:live.deadlineUtcMs});
      db.prepare(`INSERT INTO integration_execution_claims(project_id,operation_id,run_id,source_plan_id,owner_id,owner_version,intent,admission,created_at)
        VALUES(?,?,?,?,?,?,?,'owned',?)`).run(projectId,plan.integrationId,runId,source.integrationId,ownerId,ownerVersion,JSON.stringify(intent),now());
      return {...context.claim(projectId,plan.integrationId),fresh:true};
    });
    const operationId=admission.intent.operationId;
    const processes=processPort(projectId,operationId);
    const confirm=async(identity:CommandProcessIdentity)=>({launchId:identity.launchId});
    const driverFor=()=>createGitCommitDriver({processes,confirmProcessIdentity:confirm});
    const workspace=createIntegrationGitWorkspace({commandProcess:processes,confirmProcessIdentity:confirm,metadataLock:options.lock});
    const authorize=(tx:CommandTransaction)=>context.authorize(tx,projectId,operationId);
    let observation:IntegrationExecutionObservation|null=null;
    if(admission.fresh) {
      await mkdir(dirname(admission.intent.worktreePath),{recursive:true,mode:0o700});
      const service=createDeterministicIntegrationService({atomic,journal,workspace,nowUtcMs:now,
        readAuthorization:tx=>{const auth=authorize(tx);return {intent:auth.intent,approvalCurrent:true,budgetAllowed:true,
          ownerVersion:auth.row.owner_version,resourceSet:auth.resourceSet,leases:auth.leases,writerIdentity:{operationId}};},
        verifyWriterStopped:()=>stopped(projectId,operationId)});
      observation=await service.start({projectId,operationId,commandId:randomUUID(),expectedFeatureRevision:admission.intent.expectedFeatureRevision,inputDigest:admission.intent.integrationPlan!.inputDigest});
    } else {
      if(admission.row.admission==='settled') return;
      if(!await stopped(projectId,operationId)){quarantine(projectId,operationId,'stop_unconfirmed');return;}
      const recovery=createGitIntegrationReconciliationService({atomic,journal,reader:createIntegrationGitRecoveryReader({driverFor}),nowUtcMs:now,
        readAuthorization:()=>{const auth=readAuth(projectId,operationId);return {intent:auth.intent,approvalCurrent:true,ownerVersion:auth.row.owner_version,resourceSet:auth.resourceSet,leases:auth.leases};},
        verifyWriterStopped:()=>stopped(projectId,operationId)});
      const result=await recovery.reconcile({projectId,operationId}); observation=result.observation;
      if(observation?.outcome==='merging' && observation.workspace) {
        const auth=readAuth(projectId,operationId), original=observation.workspace;
        const resumed=await workspace.resume!({plan:admission.intent.integrationPlan!,integrationPath:admission.intent.worktreePath,
          owner:{ownerId:auth.row.owner_id,ownerVersion:auth.row.owner_version},gitIdentity:admission.intent.gitIdentity,
          beforeWrite:()=>{readAuth(projectId,operationId);},onStep:next=>atomic.transact('DagIntegration.recoveryStep',tx=>{
            authorize(tx);journal.append(tx,projectId,operationId,tx.getGitOperation(projectId,operationId).revision,{outcome:'merging',reason:null,workspace:next,steps:next.steps});})},original);
        if(resumed.status==='ready') {
          const merged=await workspace.merge(original);
          observation={outcome:merged.status==='succeeded'?'pending_verification':merged.status==='unknown'?'unknown':'blocked',reason:merged.reason,workspace:merged.workspace,steps:merged.steps};
          atomic.transact('DagIntegration.recoveryMerge',tx=>{authorize(tx);journal.append(tx,projectId,operationId,tx.getGitOperation(projectId,operationId).revision,observation!);});
        }
      }
    }
    if(observation?.outcome!=='pending_verification'||!observation.workspace)return;
    if(!await stopped(projectId,operationId)){quarantine(projectId,operationId,'stop_unconfirmed');return;}
    const verifier=createNodeIntegrationVerificationExecutor({processes,artifacts:options.artifacts,files:options.files,publisher:options.publisher,
      driverFor,inspector:createWorkspaceInspector({authorizedRoots:[options.dataRoot],processes,confirmProcessIdentity:confirm,integrationRepair:true}),
      authorize:async input=>{
        const auth=readAuth(projectId,operationId);
        if(input.sourcePlanId!==auth.row.source_plan_id||input.inputDigest!==atomic.transact('DagIntegration.source',tx=>tx.getIntegrationPlan(projectId,auth.row.source_plan_id)).inputDigest)integrationFailure('input_digest_mismatch');
        return {deadlineUtcMs:auth.current.deadlineUtcMs,bindingId:auth.current.binding.id,bindingRevision:auth.current.binding.bindingRevision};
      },confirmProcessIdentity:async(_input,identity)=>confirm(identity),assertOutsideTransaction:outside,nowUtcMs:now,
      resolveCwd:async(root,ref)=>{if(ref===null)return root;const result=await createBaselineWorkspaceReader().resolveContainedCwd(root,ref);if(result.status!=='inside')integrationFailure('verification_cwd_invalid');return result.canonicalPath;},
      resolveEnvironment:ref=>{if(ref!==null)integrationFailure('verification_environment_unavailable');return{};}});
    const executor={async start(input:IntegrationVerificationExecutionInput){
      const cached=atomic.transact('DagIntegration.verificationAdmit',tx=>{
        const auth=authorize(tx);
        if(auth.row.verification_result)return JSON.parse(auth.row.verification_result);
        if(auth.row.verification_started)integrationFailure('verification_reconciliation_required');
        db.prepare('UPDATE integration_execution_claims SET verification_started=1,revision=revision+1 WHERE project_id=? AND operation_id=?').run(projectId,operationId);return null;
      });
      if(cached)return cached;
      const result=await verifier.start(input);
      atomic.transact('DagIntegration.verificationReceipt',tx=>{authorize(tx);db.prepare('UPDATE integration_execution_claims SET verification_result=?,revision=revision+1 WHERE project_id=? AND operation_id=?')
        .run(JSON.stringify(result),projectId,operationId);});return result;
    }};
    const rawAuth=readAuth(projectId,operationId);
    const observed=atomic.transact('DagIntegration.operation',tx=>tx.getGitOperation(projectId,operationId));
    if(observed.status==='succeeded') {
      // A prior settlement may have committed before the baseline binding receipt.
      // Bind only the same verified plan/operation below; never rerun checks or Git.
      const source=atomic.transact('DagIntegration.settledPlan',tx=>tx.getIntegrationPlan(projectId,admission.row.source_plan_id));
      if(source.status!=='integration_passed')integrationFailure('integration_not_verified');
    }
    const auth=rawAuth;
    const verified=await createIntegrationVerificationService({atomic,journal,executor,nowUtcMs:now,readAuthorization:(tx)=>{authorize(tx);return true;}}).run({projectId,operationId,
      ownerId:auth.row.owner_id,ownerVersion:auth.row.owner_version,verificationPlan:auth.current.policy,targets:auth.current.policy.selectedCheckKeys});
    if(verified.outcome!=='passed'||!verified.integration)return;
    if(!await stopped(projectId,operationId)){quarantine(projectId,operationId,'stop_unconfirmed');return;}
    atomic.transact('DagIntegration.bindSuccessor',tx=>settleIntegrationSuccessInTransaction(tx,projectId,operationId,runId));
    options.wake();
  }
  async function ensure(projectId:string,runId:string) {
    const run=atomic.transact('DagIntegration.run',tx=>tx.getExecutionRun(projectId,runId));
    if(run.inputSnapshot.integrationAuthorization===undefined||readRunExecutionBaseline(db,run))return;
    const key=`${projectId}:${runId}`;
    const prior=pending.get(key);if(prior)return prior;
    if(pending.size>0) integrationFailure('resource_busy');
    const work=execute(projectId,runId);pending.set(key,work);
    try{await work;}catch(error){
      const reason=error && typeof error==='object' && 'details' in error ? (error as {details?:{reason?:unknown}}).details?.reason : undefined;
      const recorded=typeof reason==='string' && /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : 'integration_pending';
      session.transactWrite('DagIntegration.reason',()=>db.prepare(`UPDATE runs SET reason=?,revision=revision+1,updated_at=? WHERE project_id=? AND id=? AND status='queued' AND reason IS NOT ?`)
        .run(recorded,now(),projectId,runId,recorded));throw error;
    }finally{if(pending.get(key)===work)pending.delete(key);}
    const fresh=atomic.transact('DagIntegration.run',tx=>tx.getExecutionRun(projectId,runId));
    if(!readRunExecutionBaseline(db,fresh))integrationFailure('integration_pending');
  }
  return {ensure,
    async prepareRepairContext(projectId: string, repairId: string): Promise<IntegrationRepairContextReceipt> {
      if (!accepting) integrationFailure('integration_quiescing');
      const key = `repair-context:${projectId}:${repairId}`;
      const prior = pendingRepairContexts.get(key);
      if (prior) return prior;
      const work = repairContextService(projectId,repairId).prepare(projectId,repairId);
      pendingRepairContexts.set(key, work);
      void work.then(() => undefined, () => undefined).finally(() => {
        if (pendingRepairContexts.get(key) === work) pendingRepairContexts.delete(key);
      });
      return work;
    },
    async readRepairContext(projectId: string, repairId: string) {
      return repairContextService(projectId,repairId).read(projectId,repairId);
    },
    async consumeRepairRuntime(projectId: string, repairId: string, claim: IntegrationRepairAttemptClaim): Promise<IntegrationRepairConsumeResult> {
      if (!accepting) integrationFailure('integration_quiescing');
      if (claim.projectId !== projectId || claim.repairId !== repairId) integrationFailure('repair_identity_mismatch');
      const key = `repair-consumer:${projectId}:${repairId}`;
      const prior = pendingRepairConsumers.get(key);
      if (prior) return prior;
      const contexts = repairContextService(projectId,repairId);
      const attempts = createSqliteIntegrationRepairAttempts(session,{nowUtcMs:now});
      const baseline = await contexts.read(projectId,repairId);
      const sourceOperationId = atomic.transact('DagIntegration.repairSource',tx=>repairAuthorizations.read(tx,projectId,repairId).receipt.operationId);
      const inspector = createWorkspaceInspector({authorizedRoots:[options.dataRoot],processes:options.processes,
        integrationRepair:true,confirmProcessIdentity:async identity=>({launchId:identity.launchId})});
      const authority = createIntegrationRepairRuntimeAuthority({atomic,claim,contexts,attempts,publisher:options.publisher,inspector});
      if (!options.runtimeFactory) integrationFailure('git_agent_driver_unavailable');
      options.assertCanDispatch();
      const runtime = options.runtimeFactory(authority);
      const transaction = <T>(callback:(tx:CommandTransaction)=>T) => atomic.transact('DagIntegration.repairAttempt',callback);
      const work = (async():Promise<IntegrationRepairConsumeResult> => {
        const result = await createIntegrationRepairConsumer({
          runtime,
          assertCurrent:async()=>{await contexts.assertCurrent(projectId,repairId);},
          store:{
            claim:()=>transaction(tx=>{contexts.assertCurrentInTransaction(tx,projectId,repairId);return attempts.claim(tx,claim);}),
            read:()=>transaction(tx=>attempts.read(tx,claim)),
            bind:request=>transaction(tx=>attempts.bind(tx,claim,request)),
            settle:(output,stopped)=>transaction(tx=>attempts.settle(tx,claim,output,stopped)),
          },
          onCandidate:async(output,attempt)=>{
            if (attempt.operationId !== sourceOperationId || output.status === 'failed') integrationFailure('candidate_identity_mismatch');
            const current = await contexts.read(projectId,repairId);
            if (current.baseline.canonicalPath !== baseline.baseline.canonicalPath) integrationFailure('repair_workspace_changed');
            const source = atomic.transact('DagIntegration.repairVerificationSource',tx=>tx.getGitOperation(projectId,sourceOperationId));
            const plan = source.intent.integrationPlan;
            if (!plan) integrationFailure('integration_plan_missing');
            const verificationInspector = createWorkspaceInspector({authorizedRoots:[options.dataRoot],processes:options.processes,
              integrationRepair:true,confirmProcessIdentity:async identity=>({launchId:identity.launchId})});
            const candidateBefore = await verificationInspector.inspect(current.baseline);
            if (!candidateBefore.complete || candidateBefore.conflictMarkerPaths === undefined || candidateBefore.conflictMarkerPaths.length !== 0) {
              integrationFailure('candidate_not_ready');
            }
            const git = createGitCommitDriver({processes:options.processes,confirmProcessIdentity:async identity=>({launchId:identity.launchId})});
            const facts = await git.open(current.baseline,()=>outside()).facts();
            const verificationInput: IntegrationVerificationExecutionInput = {
              projectId,operationId:sourceOperationId,sourcePlanId:String(source.intent.budgetSnapshot?.sourcePlanId ?? plan.integrationId),
              targetBaseline:plan.target.baseCommit,inputDigest:plan.inputDigest,targets:current.verificationPlan.selectedCheckKeys,
              workspace:{workspaceId:plan.integrationId,ownerId:attempt.ownerId,ownerVersion:1,path:current.baseline.canonicalPath,
                gitCommonDir:current.baseline.gitCommonDir,repoIdentity:current.baseline.repoIdentity,targetBase:plan.target.baseCommit,
                plan,gitIdentity:source.intent.gitIdentity,status:'blocked',currentHead:facts.head,steps:[],
                facts:{...facts,statusPorcelain:Buffer.from(candidateBefore.statusPorcelainBase64,'base64').toString(),
                  unresolvedPaths:candidateBefore.conflictMarkerPaths}},
              plan:current.verificationPlan,
            };
            const verifier = createNodeIntegrationCandidateVerificationExecutor({processes:options.processes,
              artifacts:options.artifacts,files:options.files,publisher:options.publisher,driverFor:()=>git,
              inspector:verificationInspector,authorize:async()=>({deadlineUtcMs:attempt.deadlineUtcMs,bindingId:current.baseline.repositoryBindingId,
                bindingRevision:current.baseline.repositoryBindingRevision}),confirmProcessIdentity:async(_input,identity)=>({launchId:identity.launchId}),
              resolveCwd:async(root,ref)=>{if(ref===null)return root;const resolved=await createBaselineWorkspaceReader().resolveContainedCwd(root,ref);
                if(resolved.status!=='inside')integrationFailure('verification_cwd_invalid');return resolved.canonicalPath;},
              resolveEnvironment:ref=>{if(ref!==null)integrationFailure('verification_environment_unavailable');return{};},assertOutsideTransaction:outside,nowUtcMs:now},
              {operationId:sourceOperationId,inputDigest:plan.inputDigest,inspection:candidateBefore});
            const result = await verifier.start(verificationInput);
            const body = Buffer.from(stableStringify({schemaVersion:1,projectId,repairId,attemptId:attempt.attemptId,
              operationId:sourceOperationId,inputDigest:plan.inputDigest,status:result.status,stopped:result.stopped,
              verificationPlan:result.verificationPlan,verificationResult:result.verificationResult}));
            const published = await options.publisher.publishArtifact({projectId,kind:'integration-repair-verification-binding',mediaType:'application/json',
              locator:`integrations/repairs/${repairId}/${attempt.attemptId}/verification-binding.json`,
              expectedHash:createHash('sha256').update(body).digest('hex'),content:[body]});
            if (result.status !== 'passed' || !result.stopped) {
              createSqliteIntegrationRepairCandidates(session,{claim,nowUtcMs:now}).hold(projectId,repairId,'invalid_runtime_output');
              integrationFailure('verification_failed');
            }
            const artifact = await options.artifacts.getArtifactInputRef(projectId,published.artifact.id);
            const verifications = createSqliteIntegrationRepairVerifications(session,{nowUtcMs:now});
            atomic.transact('DagIntegration.bindRepairVerification',tx=>{
              const currentAttempt = attempts.read(tx,claim);
              if (currentAttempt.stoppedAtUtcMs === null || currentAttempt.output === null) integrationFailure('verification_attempt_not_stopped');
              verifications.bind(tx,{projectId,repairId,attemptId:attempt.attemptId,artifact,
                planRef:result.verificationPlan,resultRef:result.verificationResult,inputDigest:plan.inputDigest});
            });
            const repairCandidates = createSqliteIntegrationRepairCandidates(session,{claim,nowUtcMs:now});
            const verificationStoreForFinalization = createSqliteIntegrationRepairVerifications(session,{nowUtcMs:now});
            const operationsForFinalization = createSqliteGitOperationStore(session,{nowUtcMs:now});
            const finalizationRepair = repairCandidates.read(projectId,repairId);
            const finalizationSource = atomic.transact('DagIntegration.repairFinalizationSource',tx=>tx.getGitOperation(projectId,sourceOperationId));
            const finalizationPlan = gitAgentIntegrationCommitPlan(finalizationRepair,finalizationSource.intent.integrationPlan!);
            const finalizationInspector = createWorkspaceInspector({authorizedRoots:[options.dataRoot],processes:options.processes,
              integrationRepair:true,confirmProcessIdentity:async identity=>({launchId:identity.launchId})});
            const finalizationDriver = createGitCommitDriver({processes:options.processes,confirmProcessIdentity:async identity=>({launchId:identity.launchId})});
            const finalizationResources = {
              read: () => { throw new Error('repair integration must use IntegrationCommitResourceFence'); },
            };
            const integrationResources = {
              read(request: {projectId:string;operationId:string}, identity: {projectId:string;attemptId:string;owner:string;hostInstanceId:string;executionVersion:number}) {
                if (request.projectId!==projectId || request.operationId!==finalizationPlan.integrationId
                  || identity.owner!==finalizationRepair.attempts.at(-1)?.ownerId) integrationFailure('workspace_not_held');
                const auth = atomic.transact('DagIntegration.repairResourceRead',tx=>context.authorize(tx,projectId,sourceOperationId));
                return {integrationId:finalizationSource.intent.integrationPlan!.integrationId,ownerVersion:auth.row.owner_version,
                  resourceSet:auth.resourceSet,identity,invocationId:null,processIdentity:null,leases:auth.leases};
              },
              verifyStopped: async () => stopped(projectId,sourceOperationId),
            };
            const finalizer = createIntegrationRepairFinalizationService({
              atomic,repair:repairCandidates,operations:operationsForFinalization,inspector:finalizationInspector,driver:finalizationDriver,
              lock:options.lock,resources:finalizationResources,integrationResources,
              readSource:()=>atomic.transact('DagIntegration.repairSourceRead',tx=>tx.getGitOperation(projectId,sourceOperationId)),
              readSourcePlan:()=>atomic.transact('DagIntegration.repairSourcePlan',tx=>{
                const source=tx.getGitOperation(projectId,sourceOperationId);
                return tx.getIntegrationPlan(projectId,String(source.intent.budgetSnapshot?.sourcePlanId));
              }),
              readVerification:repair=>verificationStoreForFinalization.read(projectId,repair.request.repairId),
              readBaseline:()=>baseline.baseline,readBefore:()=>baseline.before,
              expectedFeatureRevision:()=>atomic.transact('DagIntegration.repairFeatureRevision',tx=>context.authorize(tx,projectId,sourceOperationId).current.feature.revision),
              assertCurrent:(repair,operation)=>{try {
                const current=atomic.transact('DagIntegration.repairAssertCurrent',tx=>context.authorize(tx,projectId,sourceOperationId));
                return operation===null || (operation.intent.projectId===projectId && operation.intent.operationId===finalizationPlan.integrationId
                  && current.row.owner_id===repair.attempts.at(-1)?.ownerId);
              } catch { return false; }},
              authorize:(tx,repair,operation)=>{context.authorize(tx,projectId,sourceOperationId);return operation.intent.projectId===projectId;},
              nowUtcMs:now,
            });
            const finalized=await finalizer.finalize({projectId,repairId,attemptId:attempt.attemptId});
            if (finalized.outcome!=='committed' && finalized.outcome!=='no_change') integrationFailure(finalized.reason ?? 'integration_commit_failed');
            atomic.transact('DagIntegration.settleRepairIntegration',tx=>settleIntegrationSuccessInTransaction(tx,projectId,sourceOperationId,attempt.runId));
            options.wake();
          },
          nowUtcMs:now,
        }).consume();
        return result;
      })();
      pendingRepairConsumers.set(key,work);
      void work.then(()=>undefined,()=>undefined).finally(()=>{
        if (pendingRepairConsumers.get(key)===work) pendingRepairConsumers.delete(key);
      });
      return work;
    },
    async consumeRepairForRun(projectId: string, runId: string): Promise<boolean> {
      const rows = db.prepare(`SELECT repair_id
        FROM integration_repair_authorizations WHERE project_id=? AND run_id=? ORDER BY created_at,repair_id`)
        .all(projectId,runId) as {repair_id:string}[];
      if (rows.length===0) return false;
      for (const row of rows) {
        const baseline = db.prepare('SELECT 1 FROM run_execution_baselines WHERE project_id=? AND run_id=?').get(projectId,runId);
        if (baseline) continue;
        const auth = atomic.transact('DagIntegration.repairSchedulerAuth',tx=>repairAuthorizations.read(tx,projectId,row.repair_id));
        const source = atomic.transact('DagIntegration.repairSchedulerSource',tx=>tx.getGitOperation(projectId,auth.receipt.operationId));
        const existing = db.prepare(`SELECT attempt_id,owner_id,host_instance_id,execution_version FROM integration_repair_attempts
          WHERE project_id=? AND repair_id=?`).get(projectId,row.repair_id) as {attempt_id:string;owner_id:string;host_instance_id:string;execution_version:number}|undefined;
        const claim: IntegrationRepairAttemptClaim = existing ? {
          projectId,repairId:row.repair_id,attemptId:existing.attempt_id,ownerId:existing.owner_id,
          hostInstanceId:existing.host_instance_id,executionVersion:existing.execution_version,
        } : { projectId,repairId:row.repair_id,attemptId:randomUUID(),ownerId:auth.fence.ownerId,
          hostInstanceId:source.intent.hostInstanceId,executionVersion:auth.fence.ownerVersion };
        await this.consumeRepairRuntime(projectId,row.repair_id,claim);
      }
      return true;
    },
    authorizeRepair(value: unknown, fence: IntegrationRepairFence) {
      const request = validateGitAgentRepairRequest(value, { nowUtcMs: 0 });
      return atomic.transact('DagIntegration.authorizeRepair', tx => repairAuthorizations.authorize(tx, request, fence, () => {
        options.assertCanDispatch();
        context.authorize(tx, request.projectId, request.source.operationId);
      }));
    },
    readRepair(projectId: string, repairId: string) {
      return atomic.transact('DagIntegration.readRepair', tx => repairAuthorizations.read(tx, projectId, repairId));
    },
    /** Internal adapter construction only; no model start or resource release. */
    repairRuntime(authority: ProductionGitAgentAuthority) {
      if (!accepting || !options.runtimeFactory) integrationFailure('git_agent_driver_unavailable');
      options.assertCanDispatch();
      const adapter = options.runtimeFactory!(authority);
      if (!adapter || typeof adapter.start !== 'function') integrationFailure('git_agent_driver_invalid');
      return adapter;
    },
    capabilities: () => ({deterministic:'available' as const,verification:'available' as const,recovery:'available' as const,gitAgent:'available' as const}),
    async scan(){if(scanPromise)return scanPromise;scanPromise=(async()=>{
      const rows=db.prepare(`SELECT r.project_id,r.id FROM runs r WHERE r.status='queued' AND json_type(r.input_snapshot,'$.integrationAuthorization')='object'
        AND NOT EXISTS(SELECT 1 FROM run_execution_baselines b WHERE b.project_id=r.project_id AND b.run_id=r.id) ORDER BY r.id LIMIT 32`).all() as {project_id:string;id:string}[];
      for(const row of rows){try{await ensure(row.project_id,row.id);}catch{/* durable failed/quarantined evidence remains queryable */}}
    })();try{await scanPromise;}finally{scanPromise=undefined;}},
    // F-014: recovery proves old process groups gone before any new integration admission.
    async recover() {
      const rows=db.prepare(`SELECT project_id,operation_id FROM integration_execution_claims WHERE admission<>'settled' ORDER BY created_at LIMIT 129`)
        .all() as {project_id:string;operation_id:string}[];
      if(rows.length>128)integrationFailure('integration_recovery_limit');
      for(const row of rows)if(!await stopped(row.project_id,row.operation_id)) {
        quarantine(row.project_id,row.operation_id,'stop_unconfirmed');integrationFailure('integration_stop_unconfirmed');
      }
    },
    activeCount(){return pending.size + pendingRepairContexts.size + pendingRepairConsumers.size;},
    enterQuiesce(){accepting=false;return{accepted:pending.size + pendingRepairContexts.size + pendingRepairConsumers.size};},
    async awaitQuiesce(budgetMs:number){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([Promise.allSettled([...pending.values(),...pendingRepairContexts.values(),...pendingRepairConsumers.values()]),new Promise<void>(resolve=>{timer=setTimeout(resolve,budgetMs);})]);const active=pending.size + pendingRepairContexts.size + pendingRepairConsumers.size;return{confirmed:active===0,pending:active?['integration_in_progress']:[]};}finally{if(timer)clearTimeout(timer);}},
  };
}
