import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CommandTransaction, AtomicCommandStore } from '../ports/atomic-commands.js';
import type { IntegrationRepairAttemptClaim } from '../ports/integration-repair-attempt.js';
import type { ProductionGitAgentAuthority } from '../ports/git-agent-production.js';
import type { GitAgentRuntimeRequest } from '../ports/git-agent-runtime.js';
import { validateGitAgentRuntimeRequest, validateGitAgentRuntimeResult } from '../ports/git-agent-runtime.js';
import type { WorkspaceInspection, WorkspaceInspector } from '../ports/workspace-inspector.js';
import type { ArtifactPublisher } from '../application/artifact-publish.js';
import type { createSqliteIntegrationRepairAttempts } from './sqlite/integration-repair-attempts.js';
import type { createIntegrationRepairContextService } from './integration-repair-context.js';
import { StorageError } from '../ports/errors.js';

function fail(reason: string): never { throw new StorageError('conflict','IntegrationRepairRuntime','Repair runtime rejected',{details:{reason}}); }

/** Compare actual protected content, not Runtime-reported paths or human-readable Git status. */
export function integrationRepairCandidatePaths(before: WorkspaceInspection, after: WorkspaceInspection, writablePaths: readonly string[]): readonly string[] {
  if (!before.complete || !after.complete || before.refsDigest !== after.refsDigest || !isDeepStrictEqual(before.repository,after.repository)
    || !isDeepStrictEqual(before.registration,after.registration) || !isDeepStrictEqual(before.contents.directories,after.contents.directories)) fail('repair_workspace_changed');
  const entries = (value: WorkspaceInspection) => new Map([
    ...value.contents.tracked.map(entry=>['tracked',entry] as const),
    ...value.contents.untracked.map(entry=>['untracked',entry] as const),
    ...value.contents.ignored.map(entry=>['ignored',entry] as const),
  ].map(([kind,entry])=>[entry.path,{kind,...entry}]));
  const old = entries(before), current = entries(after);
  const changed = [...new Set([...old.keys(),...current.keys()])].filter(path=>!isDeepStrictEqual(old.get(path),current.get(path))).sort();
  for (const path of changed) {
    const original = old.get(path), value = current.get(path);
    if (!writablePaths.includes(path) || !original || !value || value.state !== 'present' || value.kind !== original.kind
      || value.mode !== original.mode || value.indexMode !== original.indexMode || value.indexObject !== original.indexObject) fail('candidate_scope_mismatch');
  }
  return changed;
}

/** Concrete trusted authority for the existing Host driver. No LLM-facing metadata API. */
export function createIntegrationRepairRuntimeAuthority(options: {
  atomic: AtomicCommandStore; claim: IntegrationRepairAttemptClaim;
  contexts: ReturnType<typeof createIntegrationRepairContextService>;
  attempts: ReturnType<typeof createSqliteIntegrationRepairAttempts>;
  inspector: WorkspaceInspector; publisher: ArtifactPublisher;
}): ProductionGitAgentAuthority {
  const {claim} = options;
  function checked(tx: CommandTransaction, raw: GitAgentRuntimeRequest) {
    const request = validateGitAgentRuntimeRequest(raw);
    options.contexts.assertCurrentInTransaction(tx,claim.projectId,claim.repairId);
    const attempt = options.attempts.read(tx,claim);
    if (!isDeepStrictEqual(attempt.runtimeRequest,request) || request.execution.attemptId !== claim.attemptId
      || request.execution.ownerId !== claim.ownerId || request.execution.hostInstanceId !== claim.hostInstanceId
      || request.execution.executionVersion !== claim.executionVersion) fail('runtime_request_identity_mismatch');
    return attempt;
  }
  function startable(tx: CommandTransaction, request: GitAgentRuntimeRequest) {
    const attempt = checked(tx,request);
    if (attempt.processIdentity !== null || attempt.output !== null || attempt.stoppedAtUtcMs !== null) fail('runtime_start_not_current');
  }
  return {
    async assertCurrent(request) {
      options.atomic.transact('IntegrationRepairRuntime.current',tx=>checked(tx,request));
      await options.contexts.assertCurrent(claim.projectId,claim.repairId);
    },
    async resolve(request) {
      options.atomic.transact('IntegrationRepairRuntime.resolve',tx=>startable(tx,request));
      const context = await options.contexts.assertCurrent(claim.projectId,claim.repairId);
      const current = await options.inspector.inspect(context.baseline);
      if (integrationRepairCandidatePaths(context.before,current,[]).length !== 0
        || current.statusPorcelainBase64 !== context.before.statusPorcelainBase64
        || current.codeDigest !== context.before.codeDigest) fail('repair_workspace_changed');
      options.atomic.transact('IntegrationRepairRuntime.beforeLaunch',tx=>startable(tx,request));
      return {...context.binding,requestDigest:request.requestDigest};
    },
    async confirmProcess(identity,request) {
      return options.atomic.transact('IntegrationRepairRuntime.confirmProcess',tx=>{
        checked(tx,request);
        return options.attempts.confirmProcess(tx,claim,identity);
      });
    },
    async inspectCandidate(request) {
      options.atomic.transact('IntegrationRepairRuntime.inspectCandidate',tx=>checked(tx,request));
      const context = await options.contexts.assertCurrent(claim.projectId,claim.repairId);
      const current = await options.inspector.inspect(context.baseline);
      const paths = integrationRepairCandidatePaths(context.before,current,request.authorization.writablePaths);
      options.atomic.transact('IntegrationRepairRuntime.candidateFence',tx=>checked(tx,request));
      return paths;
    },
    async record(record) {
      const attempt = options.atomic.transact('IntegrationRepairRuntime.record',tx=>options.attempts.read(tx,claim));
      const request = attempt.runtimeRequest;
      if (!request || request.requestDigest !== record.requestDigest || !isDeepStrictEqual(record.execution,request.execution)) fail('runtime_record_identity_mismatch');
      const result = validateGitAgentRuntimeResult(record.result,request);
      if (!Array.isArray(record.events) || record.events.length > 10000
        || record.events.some(event=>!Number.isSafeInteger(event.sequence) || event.sequence < 1
          || typeof event.kind !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(event.kind))) fail('runtime_record_invalid');
      const content = Buffer.from(JSON.stringify({schemaVersion:1,projectId:claim.projectId,repairId:claim.repairId,
        attemptId:claim.attemptId,requestDigest:record.requestDigest,result,
        events:record.events.map(event=>({sequence:event.sequence,kind:event.kind})),hold:record.hold}));
      if (content.length > 1048576) fail('runtime_record_limit');
      await options.publisher.publishArtifact({projectId:claim.projectId,kind:'integration-repair-runtime-result',mediaType:'application/json',
        locator:`integrations/repairs/${claim.repairId}/${claim.attemptId}/${randomUUID()}/runtime-result.json`,
        expectedHash:createHash('sha256').update(content).digest('hex'),content:[content]});
    },
  };
}
