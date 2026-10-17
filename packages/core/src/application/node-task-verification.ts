/** P03-7 / F-005: execute a confirmed Node check plan through CommandProcess. */
import { randomUUID } from 'node:crypto';
import type { ArtifactFileStore } from '../ports/artifact-files.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { AtomicCommandStore } from '../ports/atomic-commands.js';
import type { BaselineCodeIdentity } from '../ports/baseline.js';
import type {
  CommandProcessHandle,
  CommandProcessIdentity,
  CommandProcessPort,
  CommandProcessReason,
  CommandProcessRequest,
  CommandProcessOutput,
} from '../ports/command-process.js';
import { CommandProcessError } from '../ports/command-process.js';
import type { VerificationStore, VerificationCheckSnapshotEntry, CheckResultStatus, VerificationBatchTerminalStatus } from '../ports/verification-store.js';
import type { VerificationPlan, VerificationPlanCheck } from './verification-plan.js';
import type { BaselineEvidence } from './baseline-evidence.js';
import { BASELINE_OUTPUT_MAX_BYTES, createBaselineEvidenceCollector } from './baseline-evidence.js';

const RESULT_LINE = 'SHIPLOOP_NODE_CHECK_RESULT=';
const RESULT_MAX_BYTES = 65_536;
const CHECK_TIMEOUT_MAX_MS = 3_600_000;

export interface NodeCheckReport {
  readonly schemaVersion: 1;
  readonly protocol: 'shiploop.node-check';
  readonly collected: true;
  readonly testCount: number;
  readonly targets: readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reportError(message: string): Error {
  // Never include report text or command output in a validation error.
  return new Error(`Node check report invalid: ${message}`);
}

/** The result protocol is deliberately independent of process exit text. */
export function validateNodeCheckReport(value: unknown, expectedTargets: readonly string[]): NodeCheckReport {
  if (!isObject(value)) throw reportError('object_required');
  const keys = Object.keys(value);
  if (keys.some(key => !['schemaVersion', 'protocol', 'collected', 'testCount', 'targets'].includes(key))) {
    throw reportError('unknown_field');
  }
  if (value.schemaVersion !== 1 || value.protocol !== 'shiploop.node-check' || value.collected !== true) {
    throw reportError(value.collected === false ? 'collected' : 'protocol_or_collection');
  }
  if (!Number.isSafeInteger(value.testCount) || Number(value.testCount) < 1) throw reportError('testCount');
  if (!Array.isArray(value.targets) || value.targets.length === 0 || value.targets.length > 4096 ||
      value.targets.some(target => typeof target !== 'string' || target.length === 0 || target.length > 4096 || /[\0\x00-\x1f\x7f]/.test(target))) {
    throw reportError('targets');
  }
  const targets = [...new Set(value.targets as string[])];
  const actual = new Set(targets);
  for (const target of expectedTargets) {
    if (typeof target !== 'string' || target.length === 0 || !actual.has(target)) throw reportError('target_coverage');
  }
  return { schemaVersion: 1, protocol: 'shiploop.node-check', collected: true, testCount: Number(value.testCount), targets };
}

export interface NodeTaskVerificationInput {
  readonly projectId: string;
  readonly featureId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly executionVersion: number;
  readonly batchId: string;
  readonly operation: string;
  readonly codeDigest: string;
  /** Actual pre-runtime identity when the caller captured it; digest is only a compatibility fallback. */
  readonly codeIdentity?: BaselineCodeIdentity;
  readonly policyDigest: string;
  readonly environmentSummary: Readonly<Record<string, unknown>>;
  readonly plan: Pick<VerificationPlan, 'status' | 'selectedChecks'>;
  readonly targets: readonly string[];
  readonly startedAtUtcMs?: number;
  readonly signal?: AbortSignal;
}

export interface NodeTaskVerificationResult {
  readonly batchId: string;
  readonly status: 'passed' | 'failed' | 'error' | 'inconclusive';
  readonly results: readonly {
    readonly checkKey: string;
    readonly status: CheckResultStatus;
    readonly reason: string | null;
    readonly resultId: string;
    readonly testCount: number | null;
    readonly evidence: BaselineEvidence | null;
  }[];
}

type NodeEvidenceCollector = ReturnType<typeof createBaselineEvidenceCollector>;

export interface NodeTaskVerificationOptions {
  readonly processes: CommandProcessPort;
  readonly verification: VerificationStore;
  readonly atomic: AtomicCommandStore;
  readonly artifacts: ArtifactStore;
  readonly files: ArtifactFileStore;
  readonly resolveCwd: (cwdRef: string | null) => Promise<string>;
  /** Returns only variables explicitly allowed by the confirmed environment reference. */
  readonly resolveEnvironment: (environmentRef: string | null) => Readonly<Record<string, string>>;
  readonly nowUtcMs?: () => number;
  readonly maxOutputBytes?: number;
  /** Optional shared Work resource gate. Its confirmation is part of the launch commit. */
  readonly workResources?: {
    readonly identity: unknown;
    readonly beginLaunchInTransaction?: (identity: unknown) => { readonly authorized: boolean; readonly invocationId: string | null };
    readonly confirmLaunchInTransaction: (identity: unknown, processIdentity: unknown) => { readonly authorized: boolean };
    readonly releaseUnstartedInTransaction?: (identity: unknown) => void;
    readonly releaseStoppedInTransaction?: (identity: unknown, evidence: unknown) => void;
  };
  /** Optional trusted durable identity hook for adapters which own Work fencing. */
  readonly confirmProcessIdentity?: (identity: CommandProcessIdentity) => Promise<void>;
}

function snapshot(check: VerificationPlanCheck): VerificationCheckSnapshotEntry {
  return {
    checkKey: check.checkKey, scope: check.scope, kind: 'command', argv: [...check.argv], cwdRef: check.cwdRef,
    environmentRef: check.environmentRef, timeout: check.timeout, required: check.required,
    requirementRefs: [...check.requirementRefs],
  };
}
function codeIdentity(digest: string): BaselineCodeIdentity {
  return { headCommit: null, workingTreeDigest: digest, hasUncommittedChanges: false };
}
function protocolFrom(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  const line = value.trim();
  const json = line.startsWith(RESULT_LINE) ? line.slice(RESULT_LINE.length) : null;
  if (json === null) return undefined;
  try { return JSON.parse(json); } catch { return undefined; }
}

async function observeProtocol(handle: CommandProcessHandle, expectedTargets: readonly string[]): Promise<{
  readonly handle: CommandProcessHandle;
  readonly report: NodeCheckReport | null;
}> {
  let bytes = 0;
  let line = '';
  let found: unknown;
  const output: AsyncIterable<CommandProcessOutput> = {
    async *[Symbol.asyncIterator]() {
      for await (const item of handle.output) {
        if (item.stream === 'stdout' && bytes < RESULT_MAX_BYTES) {
          const chunk = item.bytes.subarray(0, Math.max(0, RESULT_MAX_BYTES - bytes));
          const text = Buffer.from(chunk).toString('utf8');
          bytes += chunk.byteLength;
          line = (line + text).slice(-RESULT_MAX_BYTES);
          for (const candidate of line.split(/\r?\n/).slice(0, -1)) {
            const parsed = protocolFrom(candidate);
            if (parsed !== undefined) found = parsed;
          }
          line = line.includes('\n') ? line.slice(line.lastIndexOf('\n') + 1) : line;
          const parsed = protocolFrom(line);
          if (parsed !== undefined) found = parsed;
        }
        yield item;
      }
    },
  };
  const wrapped = { ...handle, output } as CommandProcessHandle;
  // Parsing is complete only after the bounded collector drains the process stream.
  return { handle: wrapped, get report() { try { return found === undefined ? null : validateNodeCheckReport(found, expectedTargets); } catch { return null; } } };
}

export function createNodeTaskVerificationExecutor(options: NodeTaskVerificationOptions) {
  const now = options.nowUtcMs ?? Date.now;
  const maxOutput = options.maxOutputBytes ?? BASELINE_OUTPUT_MAX_BYTES;
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > BASELINE_OUTPUT_MAX_BYTES) throw new TypeError('invalid output budget');
  const evidence: NodeEvidenceCollector = createBaselineEvidenceCollector({ artifacts: options.artifacts, files: options.files, maxOutputBytes: maxOutput, nowMs: now });

  async function confirm(identity: CommandProcessIdentity): Promise<{ readonly launchId: string }> {
    if (options.workResources) {
      const result = options.atomic.transact('verification.confirm-process', tx => {
        const confirmed = options.workResources!.confirmLaunchInTransaction(options.workResources!.identity, identity);
        if (!confirmed.authorized) throw new CommandProcessError('confirmation_failed');
        return confirmed;
      });
      if (!result.authorized) throw new CommandProcessError('confirmation_failed');
    } else if (options.confirmProcessIdentity) {
      await options.confirmProcessIdentity(identity);
    } else {
      throw new CommandProcessError('confirmation_failed');
    }
    return { launchId: identity.launchId };
  }

  async function start(input: NodeTaskVerificationInput): Promise<NodeTaskVerificationResult> {
    const checks = input.plan.selectedChecks;
    const batchInput = {
      batchId: input.batchId, projectId: input.projectId, featureId: input.featureId, runId: input.runId,
      taskId: input.taskId, attemptId: input.attemptId, executionVersion: input.executionVersion, operation: input.operation,
      codeDigest: input.codeDigest, policyDigest: input.policyDigest, environmentSummary: input.environmentSummary,
      checkSnapshot: checks.map(snapshot), selection: { schemaVersion: 1 as const, mode: 'candidates' as const,
        reason: input.plan.status === 'ready' ? 'confirmed verification plan' : 'plan rejected', selectedCheckKeys: checks.map(check => check.checkKey) },
      startedAtUtcMs: input.startedAtUtcMs ?? now(),
    };
    const mutation = options.atomic.transact('verification.create-batch', tx => options.verification.createVerificationBatchInTransaction(tx, batchInput));
    const records: NodeTaskVerificationResult['results'][number][] = [];
    let batch = options.verification.getVerificationBatch(input.projectId, input.batchId);
    if (!mutation.created && batch.status !== 'running') {
      const historical = options.verification.listCheckResults(input.projectId, input.batchId);
      return { batchId: input.batchId, status: batch.status as NodeTaskVerificationResult['status'], results: historical.map(result => ({
        checkKey: result.checkKey, status: result.status, reason: 'replayed', resultId: result.id, testCount: null, evidence: null,
      })) };
    }
    if (!mutation.created && options.verification.listCheckResults(input.projectId, input.batchId).length > 0) {
      throw new Error('Verification batch already has an in-flight result');
    }
    if (input.plan.status !== 'ready' || checks.length === 0) {
      for (const check of checks) records.push(await saveNotRun(input, check, 'plan_not_ready'));
      const final = finalize(input, batch.revision, 'inconclusive');
      return { batchId: input.batchId, status: final.status as NodeTaskVerificationResult['status'], results: records };
    }
    for (const check of checks) {
      const result = await runCheck(input, check);
      records.push(result);
      batch = options.verification.getVerificationBatch(input.projectId, input.batchId);
      if (result.evidence === null || result.evidence.stopConfirmed !== true) break;
    }
    const status: NodeTaskVerificationResult['status'] = records.some(item => item.status === 'error') ? 'error'
      : records.some(item => item.status === 'failed') ? 'failed'
      : records.some(item => item.status !== 'passed') ? 'inconclusive' : 'passed';
    const final = finalize(input, batch.revision, status as VerificationBatchTerminalStatus);
    return { batchId: input.batchId, status: final.status as NodeTaskVerificationResult['status'], results: records };
  }

  function finalize(input: NodeTaskVerificationInput, revision: number, status: VerificationBatchTerminalStatus) {
    return options.atomic.transact('verification.finalize-batch', tx => options.verification.finalizeVerificationBatchInTransaction(tx, {
      projectId: input.projectId, batchId: input.batchId, expectedRevision: revision, status, endedAtUtcMs: now(),
    }));
  }
  async function saveNotRun(input: NodeTaskVerificationInput, check: VerificationPlanCheck, reason: string) {
    const resultId = randomUUID();
    const saved = options.atomic.transact('verification.save-result', tx => options.verification.saveCheckResultInTransaction(tx, {
      resultId, projectId: input.projectId, batchId: input.batchId, checkKey: check.checkKey, status: 'not_run',
      exitCode: null, signal: null, timedOut: false, outputArtifactId: null, outputTail: null, startedAtUtcMs: null, endedAtUtcMs: now(),
    }));
    return { checkKey: check.checkKey, status: saved.result.status, reason, resultId: saved.result.id, testCount: null, evidence: null };
  }
  async function runCheck(input: NodeTaskVerificationInput, check: VerificationPlanCheck) {
    const started = now();
    let request: CommandProcessRequest | undefined;
    let captured: BaselineEvidence | null = null;
    let reason: string | null = null;
    let status: CheckResultStatus = 'inconclusive';
    let handle: CommandProcessHandle | undefined;
    let identityConfirmed = false;
    let testCount: number | null = null;
    try {
      request = {
        argv: [...check.argv], cwd: await options.resolveCwd(check.cwdRef),
        environment: { ...options.resolveEnvironment(check.environmentRef) }, timeoutMs: Math.min(check.timeout, CHECK_TIMEOUT_MAX_MS),
        maxInputBytes: 65_536, maxOutputBytes: maxOutput,
      };
      if (options.workResources?.beginLaunchInTransaction) {
        const launch = options.atomic.transact('verification.begin-launch', () =>
          options.workResources!.beginLaunchInTransaction!(options.workResources!.identity));
        if (!launch.authorized || launch.invocationId === null) throw new CommandProcessError('confirmation_failed');
      }
      handle = await options.processes.start(request, async identity => {
        const confirmed = await confirm(identity);
        identityConfirmed = true;
        return confirmed;
      }, input.signal);
      const observed = await observeProtocol(handle, input.targets);
      captured = await evidence.collect({ projectId: input.projectId, operationId: input.operation, checkKey: check.checkKey,
        request, handle: observed.handle, environmentRef: check.environmentRef,
        codeIdentity: input.codeIdentity ?? codeIdentity(input.codeDigest) });
      // 报告解析在输出流排空后完成（observeProtocol 的 report 是惰性 getter）：
      // 覆盖计数必须在采集后读取，否则收集到的 testCount 永远丢失。
      testCount = observed.report?.testCount ?? null;
      const resultReason: CommandProcessReason | null = captured.processReason;
      if (!captured.stopConfirmed) reason = 'stop_unconfirmed';
      else if (resultReason === 'missing_command' || resultReason === 'permission_denied' || resultReason === 'spawn_failed') { status = 'error'; reason = resultReason; }
      else if (resultReason === 'timed_out' || resultReason === 'cancelled' || resultReason === 'output_overflow') reason = resultReason;
      else if (!captured.integrity.complete || !captured.output || captured.report === null) reason = 'evidence_incomplete';
      else if (observed.report === null) reason = 'invalid_result_protocol';
      else if (captured.exitCode === 0 && captured.signal === null) status = 'passed';
      else if (captured.exitCode !== 0) { status = 'failed'; reason = 'check_failed'; }
      else reason = 'inconclusive_process_result';
      if (captured?.stopConfirmed === true && options.workResources?.releaseStoppedInTransaction) {
        options.atomic.transact('verification.release-stopped', () => {
          options.workResources!.releaseStoppedInTransaction!(options.workResources!.identity, captured);
        });
      }
    } catch (error) {
      if (!identityConfirmed && options.workResources?.releaseUnstartedInTransaction) {
        options.atomic.transact('verification.release-unstarted', () => {
          options.workResources!.releaseUnstartedInTransaction!(options.workResources!.identity);
        });
      }
      if (error instanceof CommandProcessError) { reason = error.reason; status = 'inconclusive'; }
      else { reason = 'spawn_failed'; status = 'error'; }
      if (handle) await handle.cancel().catch(() => undefined);
    }
    const saved = options.atomic.transact('verification.save-result', tx => options.verification.saveCheckResultInTransaction(tx, {
      resultId: randomUUID(), projectId: input.projectId, batchId: input.batchId, checkKey: check.checkKey, status,
      exitCode: captured?.exitCode ?? null, signal: captured?.signal ?? null, timedOut: captured?.timedOut === true,
      outputArtifactId: captured?.output?.artifactId ?? null, outputTail: captured?.tail || null,
      startedAtUtcMs: captured?.startedAtUtcMs ?? started, endedAtUtcMs: captured?.endedAtUtcMs ?? now(),
    }));
    return {
      checkKey: check.checkKey, status: saved.result.status, reason, resultId: saved.result.id,
      testCount, evidence: captured,
    };
  }
  return { start };
}
