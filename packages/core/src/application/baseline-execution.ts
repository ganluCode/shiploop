/** F-012: explicit bounded baseline orchestration. No shell, queue, retry or source cleanup. */
import { createHash } from 'node:crypto';
import type { ArtifactFileStore } from '../ports/artifact-files.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
import { assertTrustedPrincipal, authorizeBaselineCommand } from '../ports/authorization.js';
import type { TrustedPrincipal } from '../ports/authorization.js';
import type { BaselineCheckStatus, BaselineCodeIdentity, BaselineEnvironmentDirectory, BaselineReasonCode, BaselineWorkspaceReader } from '../ports/baseline.js';
import { computeBaselinePlanDigest, validateBaselineCancelPayload } from '../ports/baseline.js';
import type { BaselineRepositoryGuard, BaselineRepositoryLease } from '../ports/baseline-execution.js';
import { isTerminalBaselineOperation } from '../ports/baseline-store.js';
import type { BaselineCheckResultRecord, BaselineOperationRecord, BaselineStore } from '../ports/baseline-store.js';
import { CommandProcessError } from '../ports/command-process.js';
import type { CommandProcessHandle, CommandProcessPort, CommandProcessRequest } from '../ports/command-process.js';
import { PublicError } from '../ports/commands.js';
import type { CommandReceipt } from '../ports/commands.js';
import type { RepositoryInspector } from '../ports/repository-inspector.js';
import type { RepositoryBindingRecord, StateStore } from '../ports/state-store.js';
import { createArtifactPublisher } from './artifact-publish.js';
import { createArtifactVerifier } from './artifact-verify.js';
import { BASELINE_OUTPUT_MAX_BYTES, createBaselineEvidenceCollector } from './baseline-evidence.js';
import type { BaselineEvidence } from './baseline-evidence.js';
import type { CommandService } from './command-service.js';

export interface BaselineExecutionOptions {
  readonly commands: CommandService;
  readonly atomicStore: AtomicCommandStore;
  readonly baselines: BaselineStore;
  readonly state: Pick<StateStore, 'getRepositoryBinding'>;
  readonly inspector: RepositoryInspector;
  readonly workspace: BaselineWorkspaceReader;
  readonly processes: CommandProcessPort;
  readonly artifacts: ArtifactStore;
  readonly files: ArtifactFileStore;
  readonly repositoryGuard: BaselineRepositoryGuard;
  readonly environmentDirectory: BaselineEnvironmentDirectory;
  /** Trusted assembly only: resolve approved names, never arbitrary Host environment. */
  readonly resolveEnvironment: (allowedVariables: readonly string[]) => Readonly<Record<string, string>>;
  readonly nowUtcMs?: () => number;
}
export interface BaselineExecutionService {
  submit(principal: unknown, envelope: unknown): Promise<CommandReceipt>;
  cancel(principal: unknown, projectId: string, operationId: string): Promise<BaselineOperationRecord>;
  waitForIdle(): Promise<void>;
  diagnostics(): readonly { operationId: string; reasonCode: BaselineReasonCode }[];
  activeOperationIds(): readonly string[];
}
interface ActiveExecution {
  readonly principal: TrustedPrincipal;
  readonly abort: AbortController;
  revision: number;
  handle?: CommandProcessHandle;
  done: Promise<void>;
}
// Conservative v1 command policy. Known empty runner summaries invalidate exit 0.
// Unknown prose is not proof of test coverage; projects still approve the command scope.
const EMPTY_CHECK_OUTPUT = /(?:\b0\s+(?:tests?|checks?)\b|\btests?\s+0\b|no\s+test(?:\s+files?)?\s+found)/i;
function missingPackageScript(argv: readonly string[], evidence: BaselineEvidence): boolean {
  const packageRunner = /(?:^|\/)(?:npm|pnpm|yarn)(?:\.cmd)?$/.test(argv[0]) || argv.some(arg => /(?:^|\/)npm-cli\.js$/.test(arg));
  return packageRunner && evidence.exitCode !== null && evidence.exitCode !== 0 &&
    /(?:missing script:|couldn.t find a script named|ERR_PNPM_NO_SCRIPT)/i.test(evidence.tail);
}
const sameCode = (a: BaselineCodeIdentity, b: BaselineCodeIdentity) => a.headCommit === b.headCommit &&
  a.workingTreeDigest === b.workingTreeDigest && a.hasUncommittedChanges === b.hasUncommittedChanges;

export function createBaselineExecutionService(options: BaselineExecutionOptions): BaselineExecutionService {
  const { atomicStore: atomic, baselines, workspace } = options;
  const now = options.nowUtcMs ?? Date.now;
  const active = new Map<string, ActiveExecution>();
  const failures: { operationId: string; reasonCode: BaselineReasonCode }[] = [];
  const verifier = createArtifactVerifier({ artifacts: options.artifacts, files: options.files, limits: { maxReadBytes: BASELINE_OUTPUT_MAX_BYTES } });

  function operation(id: string): BaselineOperationRecord {
    const row = baselines.getBaselineOperation(id);
    if (!row) throw new PublicError('not_found', 'baselines.get');
    return row;
  }
  function assertOwner(id: string, run: ActiveExecution): BaselineOperationRecord {
    const row = operation(id);
    const occupancy = baselines.readBaselineOccupancy();
    if (row.revision !== run.revision || isTerminalBaselineOperation(row.status) || occupancy.holderOperationId !== id ||
        (run.handle && occupancy.processIdentity?.launchId !== run.handle.identity.launchId)) {
      throw new PublicError('conflict', 'baseline.run');
    }
    return row;
  }
  function update(tx: CommandTransaction, row: BaselineOperationRecord, run: ActiveExecution, status: BaselineOperationRecord['status'], reasonCode?: BaselineReasonCode, end = false) {
    const next = tx.updateBaselineOperation(row.id, { expectedRevision: row.revision, status,
      ...(reasonCode ? { reasonCode } : {}), ...(end ? { endedAtUtcMs: now() } : {}) });
    // Set the in-memory revision only AFTER transact returns (callers own this step).
    return next;
  }
  async function currentCode(binding: RepositoryBindingRecord): Promise<BaselineCodeIdentity> {
    const inspection = await options.inspector.inspect(binding.canonicalPath);
    if (inspection.repoIdentity !== binding.repoIdentity || inspection.canonicalPath !== binding.canonicalPath || inspection.gitCommonDir !== binding.gitCommonDir) {
      throw new PublicError('conflict', 'baseline.run', undefined, { details: { reason: 'preview_stale' } });
    }
    const summary = await workspace.readWorkspaceSummary(binding.canonicalPath);
    return { headCommit: inspection.headCommit, workingTreeDigest: summary.digest, hasUncommittedChanges: inspection.hasUncommittedChanges };
  }
  function checkResult(tx: CommandTransaction, id: string, run: ActiveExecution, check: BaselineCheckResultRecord,
    status: BaselineCheckStatus, reasonCode: BaselineReasonCode | null, evidence?: BaselineEvidence) {
    const row = assertOwner(id, run);
    // Cancellation fences a result that was collected against an earlier running revision.
    if (row.status === 'cancelling') {
      const uncertain = evidence?.stopConfirmed === false || (status === 'inconclusive' && reasonCode === 'stop_unconfirmed');
      status = evidence || uncertain ? 'inconclusive' : 'not_run';
      reasonCode = uncertain ? 'stop_unconfirmed' : 'cancelled';
    }
    tx.finalizeBaselineCheckResult(id, check.checkKey, { expectedRevision: check.revision, status, reasonCode,
      exitCode: evidence?.exitCode ?? null, signal: evidence?.signal ?? null, timedOut: evidence?.timedOut === true || (status !== 'not_run' && reasonCode === 'timed_out'),
      outputArtifactId: evidence?.output?.artifactId ?? null, startedAtUtcMs: evidence?.startedAtUtcMs ?? null, endedAtUtcMs: now() });
    tx.appendBaselineEvent({ projectId: row.projectId, type: 'baseline.check_completed', operationId: id,
      aggregateRevision: row.revision, checkKey: check.checkKey, status, ...(reasonCode ? { reasonCode } : {}) });
  }
  async function publicationVerified(evidence: BaselineEvidence): Promise<boolean> {
    for (const ref of [evidence.output, evidence.report]) {
      if (!ref) return false;
      try {
        const verified = await verifier.verifyArtifact(evidence.projectId, ref.artifactId);
        if (verified.kind !== 'verified_ready' || verified.contentHash !== ref.contentHash) return false;
      } catch { return false; }
    }
    return true;
  }

  async function execute(id: string, run: ActiveExecution) {
    let lease: BaselineRepositoryLease | undefined;
    let stopConfirmed = true;
    let startAttempted = false;
    let published = true;
    let reason: BaselineReasonCode | undefined;
    let timer: NodeJS.Timeout | undefined;
    const collector = createBaselineEvidenceCollector({ artifacts: options.artifacts, files: options.files, nowMs: now });
    const evidenceList: BaselineEvidence[] = [];
    try {
      const initial = operation(id);
      const auth = initial.authorizationId ? baselines.getBaselineAuthorization(initial.authorizationId) : undefined;
      if (!auth || computeBaselinePlanDigest(auth.plan) !== auth.planDigest || auth.planDigest !== auth.policyRevision) throw new PublicError('corrupt_state', 'baseline.run');
      const binding = await options.state.getRepositoryBinding(initial.projectId);
      const snapshot = baselines.readBaselineOccupancy().processIdentity;
      if (binding.id !== auth.repositoryBindingId || !binding.gitCommonDir ||
          snapshot?.bindingRevision !== binding.bindingRevision || snapshot.bindingRecordRevision !== binding.revision ||
          typeof snapshot.deadlineUtcMs !== 'number') {
        reason = 'preview_stale';
        throw new PublicError('conflict', 'baseline.run');
      }
      // Persistent common-dir claim excludes aliases, linked worktrees and other data roots.
      lease = await options.repositoryGuard.acquire({ canonicalPath: binding.canonicalPath, gitCommonDir: binding.gitCommonDir, operationId: id });
      const authorizedCode: BaselineCodeIdentity = { headCommit: auth.headCommit, workingTreeDigest: auth.workingTreeDigest, hasUncommittedChanges: auth.hasUncommittedChanges };
      const deadline = snapshot.deadlineUtcMs;
      timer = setTimeout(() => { reason = 'timed_out'; run.abort.abort(); void run.handle?.cancel().catch(() => {}); }, Math.max(1, deadline - now()));
      // Stored checkKey ordering, not caller order, is authoritative and deterministic.
      for (const check of baselines.listBaselineCheckResults(id)) {
        if (operation(id).status === 'cancelling' || reason) break;
        if (now() >= deadline) { reason = 'timed_out'; break; }
        authorizeBaselineCommand(run.principal, initial.projectId, 'baseline.run');
        if (!sameCode(authorizedCode, await currentCode(binding))) { reason = 'source_changed'; break; }
        const cwd = await workspace.resolveContainedCwd(binding.canonicalPath, check.cwdRef);
        if (cwd.status !== 'inside') { reason = 'preview_stale'; break; }
        if (check.argv[0].startsWith('./')) {
          const target = await workspace.probeRelativeTarget(binding.canonicalPath, check.cwdRef, check.argv[0]);
          if (target !== 'exists') {
            atomic.transact('baseline.check', tx => checkResult(tx, id, run, check, 'error', 'unknown_script'));
            continue;
          }
        }
        const allowed = check.environmentRef === null ? ['PATH'] : ['PATH', ...(options.environmentDirectory.resolveEnvironmentRef(check.environmentRef)?.allowedVariables ?? [])];
        if (check.environmentRef !== null && options.environmentDirectory.resolveEnvironmentRef(check.environmentRef) === null) { reason = 'preview_stale'; break; }
        const resolved = options.resolveEnvironment(allowed);
        const environment = Object.fromEntries(Object.entries(resolved).filter(([name]) => allowed.includes(name)));
        const request: CommandProcessRequest = { argv: check.argv, cwd: cwd.canonicalPath, environment,
          timeoutMs: Math.min(check.timeoutMs, Math.max(1, deadline - now())), maxInputBytes: 65_536, maxOutputBytes: BASELINE_OUTPUT_MAX_BYTES };
        try {
          run.handle = undefined;
          startAttempted = true;
          const handle = await options.processes.start(request, async identity => {
            // Final filesystem/Git/cwd check BEFORE the short identity commit and command release.
            if (!sameCode(authorizedCode, await currentCode(binding))) {
              reason = 'source_changed';
              throw new PublicError('conflict', 'baseline.run');
            }
            const currentCwd = await workspace.resolveContainedCwd(binding.canonicalPath, check.cwdRef);
            if (currentCwd.status !== 'inside' || currentCwd.canonicalPath !== request.cwd) throw new PublicError('conflict', 'baseline.run');
            const next = atomic.transact('baseline.started', tx => {
              const row = assertOwner(id, run);
              authorizeBaselineCommand(run.principal, row.projectId, 'baseline.run');
              if (row.status === 'cancelling') throw new PublicError('conflict', 'baseline.run');
              const currentBinding = tx.getRepositoryBinding(row.projectId);
              if (currentBinding.id !== binding.id || currentBinding.revision !== binding.revision || currentBinding.bindingRevision !== binding.bindingRevision) throw new PublicError('conflict', 'baseline.run');
              const updated = tx.updateBaselineOperation(id, { expectedRevision: row.revision, status: 'running', startedAtUtcMs: row.startedAtUtcMs ?? now() });
              tx.heartbeatBaselineOccupancy(id, { ...identity, checkKey: check.checkKey,
                bindingRevision: binding.bindingRevision, bindingRecordRevision: binding.revision, deadlineUtcMs: deadline });
              if (row.startedAtUtcMs === null) tx.appendBaselineEvent({ projectId: row.projectId, type: 'baseline.started', operationId: id, aggregateRevision: updated.revision });
              return updated;
            });
            run.revision = next.revision;
            return { launchId: identity.launchId };
          }, run.abort.signal);
          run.handle = handle;
          const evidence = await collector.collect({ projectId: initial.projectId, operationId: id, checkKey: check.checkKey,
            request, handle, environmentRef: check.environmentRef, codeIdentity: authorizedCode });
          const result = { reason: evidence.processReason };
          stopConfirmed = evidence.stopConfirmed;
          const checkPublished = await publicationVerified(evidence);
          published = checkPublished && published;
          evidenceList.push(evidence);
          let status: BaselineCheckStatus;
          let checkReason: BaselineReasonCode | null = null;
          if (!stopConfirmed) { status = 'inconclusive'; checkReason = 'stop_unconfirmed'; reason = checkReason; }
          else if (operation(id).status === 'cancelling') { status = 'inconclusive'; checkReason = 'cancelled'; reason = checkReason; }
          else if (reason === 'timed_out') { status = 'inconclusive'; checkReason = 'timed_out'; }
          else if (result.reason === 'cancelled') { status = 'inconclusive'; checkReason = 'cancelled'; reason = checkReason; }
          else if (result.reason === 'timed_out' || result.reason === 'output_overflow') { status = 'inconclusive'; checkReason = result.reason; reason = checkReason; }
          else if (result.reason === 'missing_command' || result.reason === 'permission_denied' || result.reason === 'spawn_failed') { status = 'error'; checkReason = result.reason; }
          else if (!sameCode(authorizedCode, await currentCode(binding))) { status = 'inconclusive'; checkReason = 'source_changed'; reason = checkReason; }
          else if (missingPackageScript(check.argv, evidence)) { status = 'error'; checkReason = 'unknown_script'; }
          else if (!evidence.integrity.complete || !checkPublished || (evidence.exitCode === 0 && (evidence.integrity.observedBytes.stdout + evidence.integrity.observedBytes.stderr === 0 || EMPTY_CHECK_OUTPUT.test(evidence.tail)))) {
            status = 'inconclusive'; checkReason = 'evidence_incomplete';
          } else status = evidence.eligibleForPass ? 'passed' : evidence.exitCode !== null && evidence.exitCode !== 0 ? 'failed' : 'inconclusive';
          atomic.transact('baseline.check', tx => checkResult(tx, id, run, check, status, checkReason, evidence));
          if (!checkPublished) { reason = 'evidence_incomplete'; break; }
        } catch (error) {
          if (!(error instanceof CommandProcessError)) throw error;
          stopConfirmed = error.reason !== 'stop_unconfirmed';
          reason = !stopConfirmed ? 'stop_unconfirmed' : operation(id).status === 'cancelling' ? 'cancelled' : reason ?? 'spawn_failed';
          atomic.transact('baseline.check', tx => checkResult(tx, id, run, check, reason === 'spawn_failed' ? 'error' : 'inconclusive', reason ?? 'evidence_incomplete'));
          break;
        }
      }
      // Keep earlier evidence from being silently removed between checks and release.
      for (const evidence of evidenceList) published = (await publicationVerified(evidence)) && published;
      const after = await currentCode(binding);
      if (!sameCode(authorizedCode, after)) reason = reason === 'stop_unconfirmed' ? reason : 'source_changed';
      if (operation(id).status === 'cancelling' && reason !== 'stop_unconfirmed') reason = 'cancelled';
      // Persist both identities, including approved command-induced modifications. Never reset.
      try {
        const content = Buffer.from(JSON.stringify({ schemaVersion: 1, operationId: id, projectId: initial.projectId,
          capturedAtUtcMs: now(), phase: 'pre-finalization',
          policyRevision: auth.policyRevision, checkPolicy: 'command-evidence-v1', before: authorizedCode, after,
          reasonCode: reason ?? null, checks: baselines.listBaselineCheckResults(id).map(c => ({ checkKey: c.checkKey,
            status: c.status, reasonCode: c.revision === 1 ? reason ?? null : c.reasonCode,
            pendingFinalization: c.revision === 1, outputArtifactId: c.outputArtifactId })),
          evidence: evidenceList.map(e => ({ checkKey: e.checkKey, output: e.output, report: e.report })) }));
        const publisher = createArtifactPublisher({ artifacts: options.artifacts, files: options.files, limits: { maxSizeBytes: 65_536, timeoutMs: 30_000 } });
        const summary = await publisher.publishArtifact({ projectId: initial.projectId, kind: 'baseline-summary', mediaType: 'application/json',
          expectedHash: createHash('sha256').update(content).digest('hex'), locator: `baseline/${id}/summary`, content: [content] });
        if ((await verifier.verifyArtifact(initial.projectId, summary.artifact.id)).kind !== 'verified_ready') published = false;
      } catch { published = false; }
      if (!sameCode(after, await currentCode(binding))) reason = reason === 'stop_unconfirmed' ? reason : 'source_changed';
      const next = atomic.transact('baseline.finish', tx => {
        const row = assertOwner(id, run);
        if (row.status === 'cancelling' && reason !== 'stop_unconfirmed') reason = 'cancelled';
        for (const check of baselines.listBaselineCheckResults(id)) {
          if (check.revision === 1) checkResult(tx, id, run, check, 'not_run', reason ?? null);
        }
        if (!published && stopConfirmed) {
          // Publication failure is retryable only by explicit recovery, never re-run commands.
          return update(tx, row, run, row.status, 'evidence_incomplete');
        }
        const status = !stopConfirmed ? 'failed' : reason === 'cancelled' ? 'cancelled' : 'completed';
        const finished = update(tx, row, run, status, reason, true);
        const checks = baselines.listBaselineCheckResults(id);
        const summary = { total: checks.length, passed: 0, failed: 0, error: 0, inconclusive: 0, notRun: 0 };
        for (const c of checks) summary[c.status === 'not_run' ? 'notRun' : c.status]++;
        tx.appendBaselineEvent({ projectId: row.projectId, type: status === 'cancelled' ? 'baseline.cancelled' : 'baseline.completed', operationId: id,
          aggregateRevision: finished.revision, ...(status === 'cancelled' ? {} : { status, summary }), ...(reason ? { reasonCode: reason } : {}) });
        if (stopConfirmed) tx.releaseBaselineOccupancy(id);
        return finished;
      });
      run.revision = next.revision;
      if (stopConfirmed && published && isTerminalBaselineOperation(next.status)) await lease.release();
    } catch (error) {
      // Uncertain persistence or callback failure MUST retain DB + repository exclusion.
      // Never swallow an async failure into passed; expose only a bounded controlled diagnostic.
      if (run.handle) await run.handle.cancel().catch(() => {});
      const failureReason = reason ?? (error instanceof PublicError && error.code === 'resource_busy' ? 'baseline_in_progress' : 'evidence_incomplete');
      failures.push({ operationId: id, reasonCode: failureReason });
      if (failures.length > 64) failures.shift();
      // A busy foreign repository claim started nothing locally; release only our DB slot.
      // All other uncertain failures stay nonterminal and retain both exclusions.
      try {
        const next = atomic.transact('baseline.failure', tx => {
          const row = assertOwner(id, run);
          if (!startAttempted && (failureReason === 'baseline_in_progress' || failureReason === 'preview_stale')) {
            for (const c of baselines.listBaselineCheckResults(id)) if (c.revision === 1) checkResult(tx, id, run, c, 'not_run', failureReason);
            const failed = update(tx, row, run, 'failed', failureReason, true);
            tx.appendBaselineEvent({ projectId: row.projectId, type: 'baseline.completed', operationId: id, aggregateRevision: failed.revision,
              status: 'failed', reasonCode: failureReason, summary: { total: authCheckCount(id), passed: 0, failed: 0, error: 0, inconclusive: 0, notRun: authCheckCount(id) } });
            tx.releaseBaselineOccupancy(id);
            return failed;
          }
          return update(tx, row, run, row.status, failureReason);
        });
        run.revision = next.revision;
        if (isTerminalBaselineOperation(next.status)) await lease?.release();
      } catch { /* persistence still uncertain: never release */ }
    } finally { clearTimeout(timer); }
  }
  function authCheckCount(id: string) { return baselines.listBaselineCheckResults(id).length; }

  return {
    async submit(principal, envelope) {
      assertTrustedPrincipal(principal);
      const receipt = await options.commands.submit(principal, envelope);
      if (receipt.status === 'accepted' && !receipt.replayed && receipt.operationId && !active.has(receipt.operationId)) {
        const id = receipt.operationId;
        const run: ActiveExecution = { principal, abort: new AbortController(), revision: operation(id).revision, done: Promise.resolve() };
        active.set(id, run);
        // Async execute starts only after the authorization/receipt transaction committed.
        run.done = execute(id, run).finally(() => { active.delete(id); });
      }
      return receipt;
    },
    async cancel(principal, projectId, id) {
      assertTrustedPrincipal(principal);
      validateBaselineCancelPayload({ operationId: id });
      authorizeBaselineCommand(principal, projectId, 'baseline.cancel');
      const row = operation(id);
      if (row.projectId !== projectId) throw new PublicError('not_found', 'baseline.cancel');
      if (isTerminalBaselineOperation(row.status)) return row;
      const run = active.get(id);
      if (!run) throw new PublicError('resource_busy', 'baseline.cancel', undefined, { details: { reason: 'quiesce_not_confirmed' } });
      if (row.status !== 'cancelling') {
        const next = atomic.transact('baseline.cancel', tx => update(tx, assertOwner(id, run), run, 'cancelling', 'cancelled'));
        run.revision = next.revision;
      }
      run.abort.abort();
      await run.handle?.cancel();
      await run.done;
      const result = operation(id);
      if (!isTerminalBaselineOperation(result.status)) throw new PublicError('resource_busy', 'baseline.cancel', undefined, { details: { reason: 'quiesce_not_confirmed' } });
      return result;
    },
    async waitForIdle() { await Promise.all([...active.values()].map(run => run.done)); },
    diagnostics: () => failures.map(f => ({ ...f })),
    activeOperationIds: () => [...active.keys()],
  };
}
