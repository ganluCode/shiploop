/** F-012: explicit bounded baseline orchestration. No shell, queue, retry or source cleanup. */
import { createHash } from 'node:crypto';
import type { ArtifactFileStore } from '../ports/artifact-files.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { AtomicCommandStore, CommandTransaction } from '../ports/atomic-commands.js';
import { assertTrustedPrincipal, authorizeBaselineCommand } from '../ports/authorization.js';
import type { TrustedPrincipal } from '../ports/authorization.js';
import type { BaselineCheckPlan, BaselineCheckStatus, BaselineCodeIdentity, BaselineEnvironmentDirectory, BaselineEnvironmentIdentity, BaselineReasonCode, BaselineWorkspaceReader } from '../ports/baseline.js';
import { normalizeBaselineAllowedVariables } from '../ports/baseline.js';
import { computeBaselinePlanDigest, validateBaselineCancelPayload } from '../ports/baseline.js';
import type { BaselineRepositoryGuard, BaselineRepositoryLease } from '../ports/baseline-execution.js';
import { isTerminalBaselineOperation } from '../ports/baseline-store.js';
import type { BaselineCheckResultRecord, BaselineOperationRecord, BaselineStore } from '../ports/baseline-store.js';
import { CommandProcessError } from '../ports/command-process.js';
import type { CommandProcessHandle, CommandProcessPort, CommandProcessRequest } from '../ports/command-process.js';
import { PublicError } from '../ports/commands.js';
import { stableCanonicalJson } from '../ports/command-receipts.js';
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
  readonly recoverPartialOutput?: (projectId: string, relativePath: string) => Promise<Uint8Array>;
}
export interface BaselineExecutionService {
  submit(principal: unknown, envelope: unknown): Promise<CommandReceipt>;
  cancel(principal: unknown, projectId: string, operationId: string): Promise<BaselineOperationRecord>;
  waitForIdle(): Promise<void>;
  diagnostics(): readonly { operationId: string; reasonCode: BaselineReasonCode }[];
  activeOperationIds(): readonly string[];
  /** Trusted lifecycle entry; wait is the default, cancellation must be explicit. */
  enterQuiesce(policy?: 'wait' | 'cancel'): { accepted: number };
  awaitQuiesce(budgetMs: number): Promise<{ confirmed: boolean; pending: readonly string[] }>;
  /** Call only after obtaining the data-root writer lock, before publishing Host ready. */
  recover(): Promise<{ confirmed: boolean; pending: readonly string[] }>;
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

function environmentIdentityForPlan(
  plan: BaselineCheckPlan,
  directory: BaselineEnvironmentDirectory,
): BaselineEnvironmentIdentity {
  const refs = [...new Set(plan.checks.map(check => check.environmentRef).filter((ref): ref is string => ref !== undefined && ref !== null))];
  const definitions = refs.map(environmentRef => ({ environmentRef, definition: directory.resolveEnvironmentRef(environmentRef) }));
  const allowedVariables = new Set<string>(['PATH']);
  const toolchain: Record<string, string | null> = {};
  const unknownFields: string[] = [];
  const coverage: string[] = ['PATH'];
  for (const { environmentRef, definition } of definitions) {
    if (definition === null) {
      unknownFields.push(`environment:${environmentRef}`);
      continue;
    }
    for (const variable of normalizeBaselineAllowedVariables(definition)) allowedVariables.add(variable);
    coverage.push(`environmentRef:${environmentRef}`);
    for (const [name, version] of Object.entries(definition.toolchain ?? {})) {
      if (toolchain[name] !== undefined && toolchain[name] !== version) toolchain[name] = null;
      else toolchain[name] = version;
    }
    if (definition.definitionRevision === undefined) unknownFields.push(`environmentRevision:${environmentRef}`);
    for (const field of definition.unknownFields ?? []) unknownFields.push(field);
  }
  const revisions = definitions.map(({ definition }) => definition?.definitionRevision).filter((value): value is string => value !== undefined);
  const definitionRevision = refs.length === 1 ? (revisions[0] ?? null) : null;
  if (refs.length > 1 && new Set(revisions).size > 1) unknownFields.push('environmentRevision:multiple');
  return {
    schemaVersion: 1,
    environmentRef: refs.length === 1 ? refs[0]! : null,
    definitionRevision,
    toolchain,
    platform: { os: process.platform, arch: process.arch },
    allowedVariables: [...allowedVariables].sort(),
    coverage: [...new Set(coverage)].sort(),
    unknownFields: [...new Set(unknownFields)].sort(),
  };
}

const sameEnvironment = (a: BaselineEnvironmentIdentity | null, b: BaselineEnvironmentIdentity) =>
  a !== null && stableCanonicalJson(a) === stableCanonicalJson(b);

export function createBaselineExecutionService(options: BaselineExecutionOptions): BaselineExecutionService {
  const { atomicStore: atomic, baselines, workspace } = options;
  const now = options.nowUtcMs ?? Date.now;
  const active = new Map<string, ActiveExecution>();
  const failures: { operationId: string; reasonCode: BaselineReasonCode }[] = [];
  let quiescing = false;
  let quiescePolicy: 'wait' | 'cancel' = 'wait';
  let submissions = 0;
  let recovering = false;
  let recoveryPending: readonly string[] = [];
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
    const recordedEvidence = evidence && status === 'not_run' &&
      ['missing_command', 'unknown_script', 'permission_denied', 'spawn_failed'].includes(reasonCode ?? '')
      ? { ...evidence, exitCode: null, signal: null, startedAtUtcMs: null }
      : evidence;
    // Cancellation fences a result collected against an earlier running revision.
    if (row.status === 'cancelling') {
      const uncertain = evidence?.stopConfirmed === false || (status === 'inconclusive' && reasonCode === 'stop_unconfirmed');
      status = evidence || uncertain ? 'inconclusive' : 'not_run';
      reasonCode = uncertain ? 'stop_unconfirmed' : 'cancelled';
    }
    tx.finalizeBaselineCheckResult(id, check.checkKey, { expectedRevision: check.revision, status, reasonCode,
      exitCode: recordedEvidence?.exitCode ?? null, signal: recordedEvidence?.signal ?? null, timedOut: recordedEvidence?.timedOut === true || (status !== 'not_run' && reasonCode === 'timed_out'),
      outputArtifactId: recordedEvidence?.output?.artifactId ?? null, startedAtUtcMs: recordedEvidence?.startedAtUtcMs ?? null, endedAtUtcMs: now() });
    tx.appendBaselineEvent({ projectId: row.projectId, type: 'baseline.check_completed', operationId: id,
      aggregateRevision: row.revision, checkKey: check.checkKey, status, ...(reasonCode ? { reasonCode } : {}) });
  }
  async function publicationVerified(evidence: BaselineEvidence): Promise<boolean> {
    // report 是检查证据的持久记录（§8.4）：其缺席即发布失败，必须停住并保留占用。
    // output 可合法缺席——如 output_overflow 中止采集时检查行以 null 引用收尾
    //（§8.3：输出溢出 → operation completed + check inconclusive/output_overflow），
    // 不得因此折算为发布失败而把操作永久留在非终态。
    if (evidence.report === null) return false;
    for (const ref of [evidence.output, evidence.report]) {
      if (ref === null) continue;
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
      if (!auth.environmentIdentity || !sameEnvironment(auth.environmentIdentity, environmentIdentityForPlan(auth.plan, options.environmentDirectory))) {
        reason = 'preview_stale';
        throw new PublicError('conflict', 'baseline.run');
      }
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
        if (!sameCode(authorizedCode, await currentCode(binding)) ||
            !sameEnvironment(auth.environmentIdentity, environmentIdentityForPlan(auth.plan, options.environmentDirectory))) { reason = 'source_changed'; break; }
        const cwd = await workspace.resolveContainedCwd(binding.canonicalPath, check.cwdRef);
        if (cwd.status !== 'inside') { reason = 'preview_stale'; break; }
        if (check.argv[0].startsWith('./')) {
          const target = await workspace.probeRelativeTarget(binding.canonicalPath, check.cwdRef, check.argv[0]);
          if (target !== 'exists') {
            atomic.transact('baseline.check', tx => checkResult(tx, id, run, check, 'not_run', 'unknown_script'));
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
            if (!sameCode(authorizedCode, await currentCode(binding)) ||
                !sameEnvironment(auth.environmentIdentity, environmentIdentityForPlan(auth.plan, options.environmentDirectory))) {
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
            request, handle, environmentRef: check.environmentRef, codeIdentity: authorizedCode,
            async onStaging(relativePath) {
              atomic.transact('baseline.evidence_identity', tx => {
                assertOwner(id, run);
                tx.heartbeatBaselineOccupancy(id, { ...baselines.readBaselineOccupancy().processIdentity, stagingRelativePath: relativePath });
              });
            },
            async onOutputRegistered(artifactId) {
              atomic.transact('baseline.output_identity', tx => {
                assertOwner(id, run);
                tx.heartbeatBaselineOccupancy(id, { ...baselines.readBaselineOccupancy().processIdentity, outputArtifactId: artifactId });
              });
            } });
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
          else if (result.reason === 'missing_command' || result.reason === 'permission_denied' || result.reason === 'spawn_failed') { status = 'not_run'; checkReason = result.reason; }
          else if (!sameCode(authorizedCode, await currentCode(binding))) { status = 'inconclusive'; checkReason = 'source_changed'; reason = checkReason; }
          else if (missingPackageScript(check.argv, evidence)) { status = 'not_run'; checkReason = 'unknown_script'; }
          else if (!evidence.integrity.complete || !checkPublished || (evidence.exitCode === 0 && (evidence.integrity.observedBytes.stdout + evidence.integrity.observedBytes.stderr === 0 || EMPTY_CHECK_OUTPUT.test(evidence.tail)))) {
            status = 'inconclusive'; checkReason = 'evidence_incomplete';
          } else status = evidence.eligibleForPass ? 'passed' : evidence.exitCode !== null && evidence.exitCode !== 0 ? 'failed' : 'inconclusive';
          atomic.transact('baseline.check', tx => checkResult(tx, id, run, check, status, checkReason, evidence));
          if (!checkPublished) { reason = 'evidence_incomplete'; break; }
        } catch (error) {
          if (!(error instanceof CommandProcessError)) throw error;
          stopConfirmed = error.reason !== 'stop_unconfirmed';
          reason = !stopConfirmed ? 'stop_unconfirmed' : operation(id).status === 'cancelling' ? 'cancelled' : reason ?? 'spawn_failed';
          atomic.transact('baseline.check', tx => checkResult(tx, id, run, check, reason === 'spawn_failed' ? 'not_run' : 'inconclusive', reason ?? 'evidence_incomplete'));
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
        if (stopConfirmed) tx.heartbeatBaselineOccupancy(id, { ...baselines.readBaselineOccupancy().processIdentity, recoveryStopConfirmed: true });
        const status = !stopConfirmed ? 'failed' : reason === 'cancelled' ? 'cancelled' : 'completed';
        const finished = update(tx, row, run, status, reason, true);
        const checks = baselines.listBaselineCheckResults(id);
        const summary = { total: checks.length, passed: 0, failed: 0, error: 0, inconclusive: 0, notRun: 0 };
        for (const c of checks) summary[c.status === 'not_run' ? 'notRun' : c.status]++;
        tx.appendBaselineEvent({ projectId: row.projectId, type: status === 'cancelled' ? 'baseline.cancelled' : 'baseline.completed', operationId: id,
          aggregateRevision: finished.revision, ...(status === 'cancelled' ? {} : { status, summary }), ...(reason ? { reasonCode: reason } : {}) });
        return finished;
      });
      run.revision = next.revision;
      if (stopConfirmed && published && isTerminalBaselineOperation(next.status)) {
        // Keep durable ownership until the repository claim is also gone. A crash
        // between terminal commit and claim unlink remains in the recovery inventory.
        await lease.release();
        atomic.transact('baseline.release', tx => tx.releaseBaselineOccupancy(id));
      }
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
            tx.heartbeatBaselineOccupancy(id, { ...baselines.readBaselineOccupancy().processIdentity, recoveryStopConfirmed: true });
            const failed = update(tx, row, run, 'failed', failureReason, true);
            tx.appendBaselineEvent({ projectId: row.projectId, type: 'baseline.completed', operationId: id, aggregateRevision: failed.revision,
              status: 'failed', reasonCode: failureReason, summary: { total: authCheckCount(id), passed: 0, failed: 0, error: 0, inconclusive: 0, notRun: authCheckCount(id) } });
            return failed;
          }
          return update(tx, row, run, row.status, failureReason);
        });
        run.revision = next.revision;
        if (isTerminalBaselineOperation(next.status)) {
          await lease?.release();
          atomic.transact('baseline.release', tx => tx.releaseBaselineOccupancy(id));
        }
      } catch { /* persistence still uncertain: never release */ }
    } finally { clearTimeout(timer); }
  }
  function authCheckCount(id: string) { return baselines.listBaselineCheckResults(id).length; }

  function pendingIds(): readonly string[] {
    const holder = baselines.readBaselineOccupancy().holderOperationId;
    return [...new Set([...active.keys(), ...recoveryPending, ...(holder ? [holder] : []), ...(submissions ? ['baseline-submission'] : [])])];
  }
  function cancelActive(id: string, run: ActiveExecution) {
    if (isTerminalBaselineOperation(operation(id).status)) return;
    const row = assertOwner(id, run);
    if (row.status !== 'cancelling') {
      run.revision = atomic.transact('baseline.quiesce_cancel', tx => update(tx, row, run, 'cancelling', 'cancelled')).revision;
    }
    run.abort.abort();
    void run.handle?.cancel().catch(() => {});
  }

  return {
    async submit(principal, envelope) {
      assertTrustedPrincipal(principal);
      if (quiescing || recovering) throw new PublicError('resource_busy', 'baseline.run', undefined, { details: { reason: 'quiesce_not_confirmed' } });
      if (recoveryPending.length) throw new PublicError('resource_busy', 'baseline.run', undefined, { details: { reason: 'baseline_in_progress' } });
      submissions++;
      try {
        const receipt = await options.commands.submit(principal, envelope);
        if (receipt.status === 'accepted' && !receipt.replayed && receipt.operationId && !active.has(receipt.operationId)) {
          const id = receipt.operationId;
          const run: ActiveExecution = { principal, abort: new AbortController(), revision: operation(id).revision, done: Promise.resolve() };
          active.set(id, run);
          // Async execute starts only after the authorization/receipt transaction committed.
          if (quiescing && quiescePolicy === 'cancel') cancelActive(id, run);
          run.done = execute(id, run).finally(() => { active.delete(id); });
        }
        return receipt;
      } finally { submissions--; }
    },
    enterQuiesce(policy = 'wait') {
      if (policy !== 'wait' && policy !== 'cancel') throw new TypeError('Invalid baseline quiesce policy');
      quiescing = true;
      quiescePolicy = policy;
      if (policy === 'cancel') for (const [id, run] of active) cancelActive(id, run);
      return { accepted: pendingIds().length };
    },
    async awaitQuiesce(budgetMs) {
      if (!Number.isSafeInteger(budgetMs) || budgetMs < 0 || budgetMs > 10_000) throw new TypeError('Invalid quiesce budget');
      const deadline = Date.now() + budgetMs;
      while (pendingIds().length && Date.now() < deadline) {
        await new Promise<void>(resolve => { setTimeout(resolve, Math.min(20, deadline - Date.now())); });
      }
      const pending = pendingIds();
      return { confirmed: pending.length === 0 && !recovering, pending };
    },
    async recover() {
      if (recovering || active.size || submissions) throw new PublicError('resource_busy', 'baseline.recovery');
      recovering = true;
      const pending: string[] = [];
      try {
        for (const row of baselines.listRecoverableBaselineOperations()) {
          const slot = baselines.readBaselineOccupancy();
          const snapshot = slot.holderOperationId === row.id ? slot.processIdentity : null;
          // An accepted authorization with no launch identity was never released. A
          // running/cancelling row without the exact identity is not safe to reclaim.
          let stopped = snapshot?.recoveryStopConfirmed === true || (row.status === 'accepted' && row.startedAtUtcMs === null &&
            snapshot?.launchId === undefined && snapshot?.pid === undefined && snapshot?.processGroupId === undefined);
          if (snapshot?.launchId !== undefined && snapshot.recoveryStopConfirmed !== true) {
            try { stopped = (await options.processes.recoverStop?.(snapshot))?.confirmed === true; } catch { stopped = false; }
          }
          const reasonCode = stopped ? 'restart_recovery' : 'stop_unconfirmed';
          let partialId: string | null = null;
          // Only redacted collector staging is recoverable. Missing/failed publication
          // stays an explicit gap, never proof of success. Existing artifacts are untouched.
          if (stopped && typeof snapshot?.outputArtifactId === 'string') {
            try {
              const record = await options.artifacts.getArtifact(row.projectId, snapshot.outputArtifactId);
              if (record.kind === 'baseline-output' && record.locator === `baseline/${row.id}/${snapshot.checkKey}/output` &&
                  (await verifier.verifyArtifact(row.projectId, record.id)).kind === 'verified_ready') partialId = record.id;
            } catch { /* missing/corrupt final content: try the retained staging instead */ }
          }
          if (stopped && partialId === null && typeof snapshot?.stagingRelativePath === 'string' && options.recoverPartialOutput) {
            try {
              const bytes = await options.recoverPartialOutput(row.projectId, snapshot.stagingRelativePath);
              const publisher = createArtifactPublisher({ artifacts: options.artifacts, files: options.files,
                limits: { maxSizeBytes: BASELINE_OUTPUT_MAX_BYTES, timeoutMs: 30_000 } });
              const result = await publisher.publishArtifact({ projectId: row.projectId, kind: 'baseline-output', mediaType: 'text/plain; charset=utf-8',
                expectedHash: createHash('sha256').update(bytes).digest('hex'), locator: `baseline/${row.id}/${snapshot.checkKey}/recovered-output`, content: [bytes] });
              partialId = result.artifact.id;
            } catch { /* missing partial evidence is recorded as restart_recovery, never passed */ }
          }
          try {
            if (stopped && slot.holderOperationId === row.id) atomic.transact('baseline.recovery_stopped', tx => {
              tx.heartbeatBaselineOccupancy(row.id, { ...snapshot, recoveryStopConfirmed: true });
            });
            if (!isTerminalBaselineOperation(row.status)) atomic.transact('baseline.recovery', tx => {
              const current = operation(row.id);
              if (current.revision !== row.revision) throw new PublicError('conflict', 'baseline.recovery');
              for (const check of baselines.listBaselineCheckResults(row.id)) {
                if (check.revision !== 1) continue; // immutable earlier evidence survives
                tx.finalizeBaselineCheckResult(row.id, check.checkKey, { expectedRevision: check.revision,
                  status: 'inconclusive', reasonCode, exitCode: null, signal: null, timedOut: false,
                  outputArtifactId: check.checkKey === snapshot?.checkKey ? partialId : null,
                  startedAtUtcMs: null, endedAtUtcMs: now() });
                tx.appendBaselineEvent({ projectId: row.projectId, type: 'baseline.check_completed', operationId: row.id,
                  aggregateRevision: row.revision, checkKey: check.checkKey, status: 'inconclusive', reasonCode });
              }
              const next = tx.updateBaselineOperation(row.id, { expectedRevision: row.revision, status: 'interrupted', reasonCode, endedAtUtcMs: now() });
              const checks = baselines.listBaselineCheckResults(row.id);
              const summary = { total: checks.length, passed: 0, failed: 0, error: 0, inconclusive: 0, notRun: 0 };
              for (const check of checks) summary[check.status === 'not_run' ? 'notRun' : check.status]++;
              tx.appendBaselineEvent({ projectId: row.projectId, type: 'baseline.completed', operationId: row.id,
                aggregateRevision: next.revision, status: 'interrupted', reasonCode, summary });
            });
            if (!stopped) { pending.push(row.id); continue; }
            const binding = await options.state.getRepositoryBinding(row.projectId);
            const auth = row.authorizationId ? baselines.getBaselineAuthorization(row.authorizationId) : undefined;
            const inspection = await options.inspector.inspect(binding.canonicalPath);
            if (!auth || auth.repositoryBindingId !== binding.id || !binding.gitCommonDir ||
                inspection.repoIdentity !== binding.repoIdentity || inspection.canonicalPath !== binding.canonicalPath || inspection.gitCommonDir !== binding.gitCommonDir ||
                !(await options.repositoryGuard.releaseRecovered?.({ canonicalPath: binding.canonicalPath, gitCommonDir: binding.gitCommonDir, operationId: row.id }))) {
              pending.push(row.id); continue;
            }
            if (slot.holderOperationId === row.id) atomic.transact('baseline.recovery_release', tx => tx.releaseBaselineOccupancy(row.id));
          } catch { pending.push(row.id); }
        }
        recoveryPending = pending;
        return { confirmed: pending.length === 0, pending };
      } finally { recovering = false; }
    },
    async cancel(principal, projectId, id) {
      assertTrustedPrincipal(principal);
      validateBaselineCancelPayload({ operationId: id });
      authorizeBaselineCommand(principal, projectId, 'baseline.cancel');
      const row = baselines.getBaselineOperation(id);
      // §4.3：未知操作对取消调用方统一 not_found（操作名归到本命令，不外泄读取面）。
      if (!row) throw new PublicError('not_found', 'baseline.cancel');
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
