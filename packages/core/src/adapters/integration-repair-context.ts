import { createHash, randomUUID } from 'node:crypto';
import { relative, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SqliteStorageSession } from './sqlite/session.js';
import { createSqliteAtomicCommandStore } from './sqlite/atomic-commands.js';
import type { CommandTransaction } from '../ports/atomic-commands.js';
import type { ArtifactStore, ArtifactInputRef } from '../ports/artifact-store.js';
import type { ArtifactFileStore } from '../ports/artifact-files.js';
import type { ArtifactPublisher } from '../application/artifact-publish.js';
import type { WorkspaceInspector, WorkspaceInspection } from '../ports/workspace-inspector.js';
import type { RuntimeCapabilityCatalog } from '../ports/runtime-capabilities.js';
import { validateRuntimeStrategyCapabilities } from '../ports/runtime-capabilities.js';
import { validateRuntimeStrategy } from '../ports/settings-schema.js';
import { validateWorkspaceBaseline, validateWorkspaceCommit } from '../ports/workspace.js';
import { resolveWorkflowLocale } from '../ports/locale.js';
import { validateGitAgentRepairRequest } from '../ports/git-agent-repair.js';
import { StorageError } from '../ports/errors.js';
import { stableStringify } from '../ports/feature-plan.js';
import { validateSha256Digest, validateStableId } from '../ports/validation.js';
import type { IntegrationRepairContextFacts, IntegrationRepairContextReceipt, PreparedIntegrationRepairContext } from '../ports/integration-repair-context.js';

const OP = 'IntegrationRepairContext';
const MAX_BYTES = 4 * 1024 * 1024;
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => sha(stableStringify(value));
function fail(reason: string): never { throw new StorageError('conflict', OP, 'Repair context unavailable', { details: { reason } }); }
type ContextRow = { project_id: string; repair_id: string; authorization_digest: string; facts_digest: string; artifact_id: string; artifact_ref: string };

/** Prepare I/O evidence outside SQLite, then bind once after a full current-facts recheck. */
export function createIntegrationRepairContextService(options: {
  session: SqliteStorageSession; dataRoot: string; artifacts: ArtifactStore; files: ArtifactFileStore; publisher: ArtifactPublisher;
  inspector: WorkspaceInspector; capabilityCatalog: RuntimeCapabilityCatalog;
  facts(tx: CommandTransaction, projectId: string, repairId: string): IntegrationRepairContextFacts;
  nowUtcMs?: () => number;
}) {
  const { session } = options, db = session.database, now = options.nowUtcMs ?? Date.now;
  const atomic = createSqliteAtomicCommandStore(session, { nowUtcMs: now });
  function outside() { if (db.inTransaction) throw new TypeError(`${OP}: I/O in write transaction`); }
  function find(projectId: string, repairId: string) {
    validateStableId(projectId,{operation:OP},'projectId'); validateStableId(repairId,{operation:OP},'repairId');
    return db.prepare('SELECT * FROM integration_repair_contexts WHERE project_id=? AND repair_id=?').get(projectId,repairId) as ContextRow | undefined;
  }
  function facts(tx: CommandTransaction, projectId: string, repairId: string) {
    const value = structuredClone(options.facts(tx,projectId,repairId));
    const request = validateGitAgentRepairRequest(value.authorization.request,{nowUtcMs:0});
    if (request.projectId !== projectId || request.repairId !== repairId || value.authorization.receipt.authorizationDigest !== request.authorizationDigest) fail('repair_identity_mismatch');
    const baseline = validateWorkspaceBaseline(value.baseline);
    validateWorkspaceCommit(value.expectedHead);
    if (baseline.repoIdentity !== request.target.repoIdentity || baseline.baseCommit !== request.target.baselineCommitSha || baseline.branch !== 'HEAD') fail('repair_workspace_mismatch');
    const strategy = validateRuntimeStrategy(value.strategy,{operation:OP},'strategy');
    validateRuntimeStrategyCapabilities(strategy,options.capabilityCatalog,{operation:OP},'strategy');
    if (strategy.runtime !== 'pi' || strategy.credentialRef !== `credential://pi/${strategy.provider}`) fail('production_pi_credential_reference_required');
    if (!Number.isSafeInteger(value.maxRequests) || value.maxRequests < 1 || value.maxRequests > 10000) fail('repair_request_limit_invalid');
    validateSha256Digest(value.policyDigest,{operation:OP},'policyDigest');
    if (typeof value.evidence !== 'string' || Buffer.byteLength(value.evidence) > 262144 || sha(value.evidence) !== request.source.evidenceDigest) fail('repair_evidence_mismatch');
    const cwd = relative(options.dataRoot,baseline.canonicalPath);
    if (!cwd || isAbsolute(cwd) || cwd === '..' || cwd.startsWith('../')) fail('repair_workspace_outside_root');
    return { ...value, baseline, strategy, locale:resolveWorkflowLocale(value.locale), request,
      cwd:{root:'managed-work',relativePath:cwd.split('\\').join('/')} };
  }
  function factsDigest(value: ReturnType<typeof facts>) {
    return digest({authorization:value.authorization,baseline:value.baseline,strategy:value.strategy,locale:value.locale,
      maxRequests:value.maxRequests,policyDigest:value.policyDigest,verificationPlan:value.verificationPlan,
      evidenceDigest:sha(value.evidence),expectedHead:value.expectedHead,cwd:value.cwd,dataRoot:options.dataRoot});
  }
  function receipt(row: ContextRow): IntegrationRepairContextReceipt {
    const ref = JSON.parse(row.artifact_ref) as ArtifactInputRef;
    if (ref.projectId !== row.project_id || ref.artifactId !== row.artifact_id) fail('repair_context_corrupt');
    return {projectId:row.project_id,repairId:row.repair_id,authorizationDigest:row.authorization_digest,factsDigest:row.facts_digest,artifact:ref};
  }
  async function bytes(ref: ArtifactInputRef, maximum = MAX_BYTES) {
    outside();
    const indexed = await options.artifacts.getArtifactInputRef(ref.projectId,ref.artifactId);
    if (!isDeepStrictEqual(indexed,ref) || ref.sizeBytes > maximum) fail('repair_artifact_changed');
    const file = await options.files.openFinalRead({projectId:ref.projectId,artifactId:ref.artifactId});
    const chunks: Buffer[] = []; let length = 0;
    try {
      for await (const chunk of file.stream) {
        const buffer = Buffer.from(chunk); length += buffer.length;
        if (length > maximum) fail('repair_context_limit');
        chunks.push(buffer);
      }
    } finally { file.stream.destroy(); }
    const content = Buffer.concat(chunks);
    if (length !== ref.sizeBytes || sha(content) !== ref.contentHash) fail('repair_artifact_changed');
    return content;
  }
  function inspection(before: WorkspaceInspection, value: ReturnType<typeof facts>) {
    if (!before || before.complete !== true || before.schemaVersion !== 1 || before.boundary !== 'trusted_project_not_os_sandbox'
      || before.repository.headCommit !== value.expectedHead
      || !isDeepStrictEqual({repositoryBindingId:before.repository.repositoryBindingId,repositoryBindingRevision:before.repository.repositoryBindingRevision,
        repoIdentity:before.repository.repoIdentity,canonicalPath:before.repository.canonicalPath,gitCommonDir:before.repository.gitCommonDir,
        branch:before.repository.branch,baseCommit:before.repository.baseCommit},value.baseline)
      || !before.contents || !Array.isArray(before.contents.tracked) || !Array.isArray(before.contents.untracked)
      || !Array.isArray(before.contents.ignored) || !Array.isArray(before.contents.directories)) fail('repair_inspection_invalid');
    validateSha256Digest(before.codeDigest,{operation:OP},'inspection.codeDigest');
    const records = Buffer.from(before.statusPorcelainBase64,'base64').toString('utf8').split('\0').filter(Boolean);
    const conflicts: string[] = [];
    for (const record of records) {
      if (record.length < 4 || record[2] !== ' ' || record[0] === 'R' || record[1] === 'R' || record[0] === 'C' || record[1] === 'C') fail('repair_inspection_invalid');
      const state = record.slice(0,2);
      if (state.includes('U') || state === 'AA' || state === 'DD') conflicts.push(record.slice(3));
    }
    if (!isDeepStrictEqual(conflicts.sort(),[...value.request.conflictFiles].sort())
      || !isDeepStrictEqual([...value.request.writablePaths].sort(),[...value.request.conflictFiles].sort())) fail('repair_conflict_scope_changed');
  }
  return {
    assertCurrentInTransaction(tx: CommandTransaction, projectId: string, repairId: string) {
      if (!db.inTransaction) throw new TypeError('Repair context recheck requires CommandTransaction');
      const current = facts(tx,projectId,repairId), row = find(projectId,repairId);
      if (!row || row.facts_digest !== factsDigest(current)) fail('repair_context_changed');
    },
    async read(projectId: string, repairId: string): Promise<PreparedIntegrationRepairContext> {
      outside(); const row = find(projectId,repairId); if (!row) return fail('repair_context_missing');
      const context = JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(await bytes(receipt(row).artifact))) as PreparedIntegrationRepairContext;
      if (context.schemaVersion !== 1 || context.projectId !== projectId || context.repairId !== repairId
        || context.authorizationDigest !== row.authorization_digest || context.factsDigest !== row.facts_digest) fail('repair_context_corrupt');
      return context;
    },
    async prepare(projectId: string, repairId: string): Promise<IntegrationRepairContextReceipt> {
      outside();
      const value = atomic.transact('IntegrationRepairContext.facts',tx=>facts(tx,projectId,repairId));
      const frozenDigest = factsDigest(value), prior = find(projectId,repairId);
      if (prior) {
        if (prior.facts_digest !== frozenDigest) fail('repair_context_changed');
        await this.read(projectId,repairId);
        return receipt(prior);
      }
      if (db.prepare('SELECT attempt_id FROM integration_repair_attempts WHERE project_id=? AND repair_id=?').get(projectId,repairId)) fail('repair_inspection_too_late');
      const intentRef = await options.artifacts.getArtifactInputRef(projectId,value.request.intent.intentId);
      if (intentRef.contentHash !== value.request.intent.digest) fail('repair_intent_mismatch');
      const intent = new TextDecoder('utf8',{fatal:true}).decode(await bytes(intentRef,262144));
      const before = structuredClone(await options.inspector.inspect(value.baseline));
      inspection(before,value);
      const context: PreparedIntegrationRepairContext = {schemaVersion:1,projectId,repairId,authorizationDigest:value.request.authorizationDigest,
        factsDigest:frozenDigest,baseline:value.baseline,before,binding:{strategy:value.strategy,locale:value.locale,
          maxRequests:value.maxRequests,cwd:value.cwd,workspaceRoots:{'managed-work':options.dataRoot},intent,evidence:value.evidence},
        verificationPlan:value.verificationPlan};
      const content = Buffer.from(stableStringify(context));
      if (content.length > MAX_BYTES) fail('repair_context_limit');
      const published = await options.publisher.publishArtifact({projectId,kind:'integration-repair-context',mediaType:'application/json',
        locator:`integrations/repairs/${repairId}/${randomUUID()}/context.json`,expectedHash:sha(content),content:[content]});
      const ref = await options.artifacts.getArtifactInputRef(projectId,published.artifact.id);
      if (ref.contentHash !== sha(content) || ref.sizeBytes !== content.length) fail('repair_artifact_changed');
      return atomic.transact('IntegrationRepairContext.bind',tx=>{
        if (factsDigest(facts(tx,projectId,repairId)) !== frozenDigest) fail('repair_context_changed');
        const existing = find(projectId,repairId);
        if (existing) {
          if (existing.facts_digest !== frozenDigest) fail('repair_context_changed');
          return receipt(existing);
        }
        db.prepare(`INSERT INTO integration_repair_contexts(project_id,repair_id,authorization_digest,facts_digest,artifact_id,artifact_ref,created_at)
          VALUES(?,?,?,?,?,?,?)`).run(projectId,repairId,value.request.authorizationDigest,frozenDigest,ref.artifactId,JSON.stringify(ref),now());
        return receipt(find(projectId,repairId)!);
      });
    },
    async assertCurrent(projectId: string, repairId: string) {
      const current = atomic.transact('IntegrationRepairContext.current',tx=>facts(tx,projectId,repairId));
      const row = find(projectId,repairId);
      if (!row || row.facts_digest !== factsDigest(current)) fail('repair_context_changed');
      return this.read(projectId,repairId);
    },
  };
}
