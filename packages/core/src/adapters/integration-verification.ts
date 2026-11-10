import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { ArtifactFileStore } from '../ports/artifact-files.js';
import type { ArtifactPublisher } from '../application/artifact-publish.js';
import { createBaselineEvidenceCollector, BASELINE_OUTPUT_MAX_BYTES } from '../application/baseline-evidence.js';
import { observeNodeCheckProtocol } from '../application/node-task-verification.js';
import type { CommandProcessIdentity, CommandProcessPort } from '../ports/command-process.js';
import type { GitCommitDriver } from '../ports/controlled-git-commit.js';
import type { IntegrationVerificationExecutionInput, IntegrationVerificationExecutor } from '../ports/integration-verification.js';
import type { WorkspaceBaseline } from '../ports/workspace.js';
import type { WorkspaceInspector } from '../ports/workspace-inspector.js';
import { StorageError } from '../ports/errors.js';

export interface IntegrationVerificationExecutorOptions {
  readonly processes: CommandProcessPort;
  readonly artifacts: ArtifactStore;
  readonly files: ArtifactFileStore;
  readonly publisher: ArtifactPublisher;
  readonly driverFor: (projectId: string) => GitCommitDriver;
  readonly inspector: WorkspaceInspector;
  /** Current Core policy, owner/fences and original parent deadline. Never from a command payload. */
  readonly authorize: (input: IntegrationVerificationExecutionInput) => Promise<{
    readonly deadlineUtcMs: number; readonly bindingId: string; readonly bindingRevision: number;
  }>;
  readonly confirmProcessIdentity: (input: IntegrationVerificationExecutionInput, identity: CommandProcessIdentity) => Promise<{ readonly launchId: string }>;
  readonly resolveCwd: (root: string, ref: string | null) => Promise<string>;
  readonly resolveEnvironment: (ref: string | null) => Readonly<Record<string, string>>;
  readonly assertOutsideTransaction: () => void;
  readonly nowUtcMs?: () => number;
  readonly signal?: AbortSignal;
}

function fail(reason: string): never {
  throw new StorageError('conflict', 'IntegrationVerification.execute', 'Integration verification cannot continue', { details: { reason } });
}

/** Real CommandProcess + bounded/redacted Artifact evidence; no synthetic Task/Attempt or model. */
export function createNodeIntegrationVerificationExecutor(options: IntegrationVerificationExecutorOptions): IntegrationVerificationExecutor {
  const now = options.nowUtcMs ?? Date.now;
  for (const key of ['authorize', 'confirmProcessIdentity', 'resolveCwd', 'resolveEnvironment', 'assertOutsideTransaction', 'driverFor'] as const) {
    if (typeof options[key] !== 'function') throw new TypeError(`Integration verification requires ${key}`);
  }
  if (typeof options.processes?.start !== 'function' || typeof options.publisher?.publishArtifact !== 'function'
    || typeof options.inspector?.inspect !== 'function') {
    throw new TypeError('Integration verification requires process and Artifact adapters');
  }
  const evidence = createBaselineEvidenceCollector({ artifacts: options.artifacts, files: options.files, nowMs: now });
  return { async start(raw) {
    options.signal?.throwIfAborted();
    options.assertOutsideTransaction();
    const input = structuredClone(raw);
    const { workspace, plan } = input;
    if (plan.status !== 'ready' || plan.selectedChecks.length === 0 || plan.selectedChecks.length > 64
      || new Set(plan.selectedCheckKeys).size !== plan.selectedChecks.length
      || new Set(plan.selectedChecks.map(check => check.checkKey)).size !== plan.selectedChecks.length
      || new Set(input.targets).size !== plan.selectedChecks.length
      || input.targets.length !== plan.selectedChecks.length
      || plan.selectedChecks.some(check => !plan.selectedCheckKeys.includes(check.checkKey) || !input.targets.includes(check.checkKey))) fail('verification_plan_unavailable');
    const grant = structuredClone(await options.authorize(input));
    if (!Number.isSafeInteger(grant.deadlineUtcMs) || typeof grant.bindingId !== 'string' || !grant.bindingId
      || !Number.isSafeInteger(grant.bindingRevision) || grant.bindingRevision < 1) fail('authorization_invalid');
    const assertGrant = async () => {
      options.signal?.throwIfAborted();
      options.assertOutsideTransaction();
      if (grant.deadlineUtcMs <= now()) fail('budget_exhausted');
      if (!isDeepStrictEqual(grant, await options.authorize(input))) fail('authorization_changed');
    };
    const baseline: WorkspaceBaseline = { repositoryBindingId: grant.bindingId, repositoryBindingRevision: grant.bindingRevision,
      canonicalPath: workspace.path, gitCommonDir: workspace.gitCommonDir, repoIdentity: workspace.repoIdentity,
      branch: 'HEAD', baseCommit: workspace.targetBase };
    options.assertOutsideTransaction();
    const git = options.driverFor(input.projectId).open(baseline, () => options.assertOutsideTransaction());
    let codeDigest: string | undefined;
    let contentIdentity: unknown;
    const inspect = async () => {
      await assertGrant();
      const bytes = await options.inspector.inspect(baseline);
      if (bytes.repository.headCommit !== workspace.currentHead || bytes.repository.canonicalPath !== workspace.path
        || bytes.repository.gitCommonDir !== workspace.gitCommonDir || bytes.repository.repoIdentity !== workspace.repoIdentity
        || bytes.statusPorcelainBase64 !== '' || !/^[a-f0-9]{64}$/.test(bytes.codeDigest)) fail('source_changed');
      const currentContent = { codeDigest: bytes.codeDigest, ignoredDigest: bytes.ignoredDigest, contents: bytes.contents };
      if (codeDigest === undefined) { codeDigest = bytes.codeDigest; contentIdentity = structuredClone(currentContent); }
      else if (!isDeepStrictEqual(contentIdentity, currentContent)) fail('source_changed');
      const facts = await git.facts();
      if (facts.head !== workspace.currentHead || facts.tree !== workspace.facts.tree
        || (await git.stagedPaths()).length !== 0 || (await git.unstagedPaths()).length !== 0) fail('source_changed');
      for (const predecessor of workspace.plan.predecessors) {
        if (!predecessor.delivery || !await git.isAncestor(predecessor.delivery.commitSha, facts.head)) fail('integration_coverage_incomplete');
      }
    };
    await inspect();
    const evidenceId = randomUUID();
    const publish = async (kind: string, value: unknown) => {
      options.assertOutsideTransaction();
      const body = Buffer.from(JSON.stringify(value));
      const expectedHash = createHash('sha256').update(body).digest('hex');
      const published = await options.publisher.publishArtifact({ projectId: input.projectId, kind, mediaType: 'application/json',
        locator: `integrations/${input.operationId}/${evidenceId}/${kind}.json`, expectedHash, content: [body] });
      if (published.artifact.projectId !== input.projectId || published.artifact.status !== 'ready'
        || published.artifact.contentHash !== expectedHash) fail('verification_evidence_incomplete');
      return { id: published.artifact.id, digest: expectedHash };
    };
    const verificationPlan = await publish('integration-verification-plan', {
      schemaVersion: 1, operationId: input.operationId, sourcePlanId: input.sourcePlanId, inputDigest: input.inputDigest,
      integrationId: workspace.plan.integrationId, targetBaseline: input.targetBaseline, commitSha: workspace.currentHead,
      treeSha: workspace.facts.tree, plan, targets: input.targets,
    });
    const results: { checkKey: string; status: 'passed' | 'failed' | 'error' | 'inconclusive'; stopped: boolean;
      outputRef: unknown; reportRef: unknown; testCount: number | null; exitCode: number | null; signal: string | null; reason: string | null }[] = [];
    for (const check of plan.selectedChecks) {
      await inspect();
      if (check.kind !== 'command') fail('verification_plan_unavailable');
      if (!Number.isSafeInteger(check.timeout) || check.timeout < 1) fail('verification_plan_unavailable');
      const request = { argv: [...check.argv], cwd: await options.resolveCwd(workspace.path, check.cwdRef),
        environment: options.resolveEnvironment(check.environmentRef), timeoutMs: Math.min(check.timeout, 3600000, grant.deadlineUtcMs - now()),
        maxInputBytes: 65536, maxOutputBytes: BASELINE_OUTPUT_MAX_BYTES };
      await assertGrant();
      request.timeoutMs = Math.min(request.timeoutMs, grant.deadlineUtcMs - now());
      if (request.timeoutMs < 1) fail('budget_exhausted');
      const handle = await options.processes.start(request, async identity => {
        await assertGrant();
        const committed = await options.confirmProcessIdentity(input, identity);
        await assertGrant();
        return committed;
      }, options.signal);
      try {
        const observed = await observeNodeCheckProtocol(handle, input.targets);
        const captured = await evidence.collect({ projectId: input.projectId, operationId: evidenceId,
          checkKey: check.checkKey, request, handle: observed.handle, environmentRef: check.environmentRef,
          codeIdentity: { headCommit: workspace.currentHead, workingTreeDigest: codeDigest!, hasUncommittedChanges: false } });
        let separatelyStopped = false;
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          separatelyStopped = await Promise.race([
            handle.stopped.then(stop => stop.confirmed, () => false),
            new Promise<boolean>(resolve => { stopTimer = setTimeout(() => resolve(false), 1000); }),
          ]);
        } finally { if (stopTimer !== undefined) clearTimeout(stopTimer); }
        const stopConfirmed = captured.stopConfirmed && separatelyStopped;
        const protocol = observed.report;
        const reason = !stopConfirmed ? 'stop_unconfirmed' : !captured.integrity.complete || !captured.output || !captured.report
          ? 'verification_evidence_incomplete' : protocol === null ? 'invalid_result_protocol' : captured.processReason ?? null;
        const status = !stopConfirmed || !captured.integrity.complete || !captured.output || !captured.report || protocol === null
          ? 'inconclusive' : captured.processReason !== null && captured.processReason !== undefined ? 'error'
            : captured.exitCode === 0 && captured.signal === null ? 'passed' : captured.exitCode !== null ? 'failed' : 'inconclusive';
        results.push({ checkKey: check.checkKey, status, stopped: stopConfirmed, reason,
          outputRef: captured.output ?? null, reportRef: captured.report ?? null, testCount: protocol?.testCount ?? null,
          exitCode: captured.exitCode, signal: captured.signal });
        if (!stopConfirmed) break;
      } catch (error) {
        await handle.cancel().catch(() => undefined);
        throw error;
      }
    }
    const stopped = results.length === plan.selectedChecks.length && results.every(result => result.stopped);
    if (stopped) await inspect();
    const status = results.length !== plan.selectedChecks.length || results.some(result => result.status === 'inconclusive') ? 'inconclusive'
      : results.some(result => result.status === 'error') ? 'error' : results.some(result => result.status === 'failed') ? 'failed' : 'passed';
    const verificationResult = await publish('integration-verification-result', {
      schemaVersion: 1, operationId: input.operationId, inputDigest: input.inputDigest, verificationPlan, status, stopped, results,
      commitSha: workspace.currentHead, treeSha: workspace.facts.tree, targetBaseline: input.targetBaseline,
    });
    return { status, stopped, integrationId: workspace.plan.integrationId, commitSha: workspace.currentHead,
      treeSha: workspace.facts.tree, targetBase: input.targetBaseline, targetBaseline: input.targetBaseline,
      inputDigest: input.inputDigest, verificationPlan, verificationResult };
  } };
}
