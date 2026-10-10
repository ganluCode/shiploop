/**
 * P02-3 F-011: one bounded output consumer, redaction BEFORE any disk write.
 * Generated output has no advance hash: capture into controlled staging first, then
 * register its measured hash and use the existing pending -> publish -> ready CAS.
 * Crash before registration leaves an orphan; failed staging stays in place. Existing
 * ArtifactVerifier owns recovery. No path/locator reading API, no overwrite or cleanup
 * of historical evidence. Collector instances have a finite lifetime disk budget and
 * a single active capture; the baseline scheduler still owns global occupancy.
 */
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { ArtifactFileStore, ArtifactStagingWrite } from '../ports/artifact-files.js';
import type { ArtifactInputRef, ArtifactRecord, ArtifactStore } from '../ports/artifact-store.js';
import type { CommandProcessHandle, CommandProcessOutput, CommandProcessRequest, CommandProcessResult } from '../ports/command-process.js';
import type { BaselineCodeIdentity } from '../ports/baseline.js';
import { validateBaselineCodeIdentity } from '../ports/baseline.js';
import type { BaselineCheckResultRecord } from '../ports/baseline-store.js';
import { hasCapability, isProjectVisible } from '../ports/authorization.js';
import type { TrustedPrincipal } from '../ports/authorization.js';
import { PublicError, isUuidV4 } from '../ports/commands.js';
import { validateStableId } from '../ports/validation.js';
import { createArtifactPublisher } from './artifact-publish.js';
import { createArtifactVerifier } from './artifact-verify.js';
import { createOutputRedactor, redactOutputText } from './output-redaction.js';

export const BASELINE_OUTPUT_MAX_BYTES = 8_388_608;
export const BASELINE_OUTPUT_TAIL_MAX_BYTES = 16_384;
const REPORT_MAX_BYTES = 65_536;
export const BASELINE_OUTPUT_KIND = 'baseline-output';
export const BASELINE_EVIDENCE_KIND = 'baseline-evidence';
export type BaselineEvidenceGap = 'cancelled' | 'timed_out' | 'output_overflow' | 'output_dropped'
  | 'publication_failed' | 'evidence_incomplete' | 'stop_unconfirmed' | 'disk_budget'
  | 'collector_busy' | 'process_error';
export interface BaselineEvidence {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly operationId: string;
  readonly checkKey: string;
  readonly execution: {
    /** Actual argv, with protected values/headers redacted rather than duplicated. */
    readonly argv: readonly string[];
    readonly argvDigest: string;
    readonly argvRedacted: boolean;
    readonly cwd: string;
    readonly environmentRef: string | null;
    readonly timeoutMs: number;
    readonly allowedVariables: readonly string[];
    readonly codeIdentity: BaselineCodeIdentity;
    readonly processIdentity: CommandProcessHandle['identity'];
  };
  readonly startedAtUtcMs: number;
  readonly endedAtUtcMs: number;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  /** Supervised result reason, retained so orchestration never re-awaits an uncertain promise. */
  readonly processReason: CommandProcessResult['reason'];
  readonly stopConfirmed: boolean;
  readonly output: ArtifactInputRef | null;
  readonly report: ArtifactInputRef | null;
  /** Failed/pending output index, if registration succeeded but publication did not. */
  readonly interruptedArtifactId: string | null;
  readonly tail: string;
  readonly tailTruncated: boolean;
  readonly integrity: {
    readonly complete: boolean;
    readonly gaps: readonly BaselineEvidenceGap[];
    readonly observedBytes: { readonly stdout: number; readonly stderr: number };
    readonly retainedBytes: number;
    readonly droppedBytes: number;
    readonly coverage: 'per-stream-redacted-tagged-text';
  };
  /** Necessary evidence gate, not a replacement for baseline business verification. */
  readonly eligibleForPass: boolean;
}
export interface BaselineEvidenceInput {
  readonly projectId: string;
  readonly operationId: string;
  readonly checkKey: string;
  readonly request: CommandProcessRequest;
  readonly handle: CommandProcessHandle;
  readonly environmentRef: string | null;
  readonly codeIdentity: BaselineCodeIdentity;
  /** Additional explicitly known credentials; never logged or returned. */
  readonly protectedValues?: readonly string[];
}
export interface BaselineEvidenceOptions {
  readonly artifacts: ArtifactStore;
  readonly files: ArtifactFileStore;
  readonly maxOutputBytes?: number;
  readonly maxDiskBytes?: number;
  readonly nowMs?: () => number;
}
class CaptureFailure extends Error {
  readonly gap: BaselineEvidenceGap;
  constructor(gap: BaselineEvidenceGap) {
    super(`Baseline evidence: ${gap}`);
    this.gap = gap;
  }
}
function positive(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError('Baseline evidence: invalid budget');
  return value;
}
function tailOf(bytes: Buffer): string {
  let start = Math.max(0, bytes.length - BASELINE_OUTPUT_TAIL_MAX_BYTES);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

export function createBaselineEvidenceCollector(options: BaselineEvidenceOptions) {
  const { artifacts, files } = options;
  const maxOutput = positive(options.maxOutputBytes ?? BASELINE_OUTPUT_MAX_BYTES, BASELINE_OUTPUT_MAX_BYTES);
  const maxDisk = positive(options.maxDiskBytes ?? 64 * (BASELINE_OUTPUT_MAX_BYTES + REPORT_MAX_BYTES),
    64 * (BASELINE_OUTPUT_MAX_BYTES + REPORT_MAX_BYTES));
  const now = options.nowMs ?? Date.now;
  const verifier = createArtifactVerifier({ artifacts, files, limits: { maxReadBytes: BASELINE_OUTPUT_MAX_BYTES } });
  let charged = 0;
  let active = false;

  async function verify(evidence: BaselineEvidence): Promise<BaselineEvidence> {
    let complete = evidence.integrity.complete;
    for (const ref of [evidence.output, evidence.report]) {
      if (!ref) { complete = false; continue; }
      try {
        const report = await verifier.verifyArtifact(evidence.projectId, ref.artifactId);
        if (report.kind !== 'verified_ready' || report.contentHash !== ref.contentHash) complete = false;
      } catch { complete = false; }
    }
    if (complete) return evidence;
    const gaps = [...new Set([...evidence.integrity.gaps, 'evidence_incomplete' as const])];
    return { ...evidence, eligibleForPass: false, integrity: { ...evidence.integrity, complete: false, gaps } };
  }

  async function collect(input: BaselineEvidenceInput): Promise<BaselineEvidence> {
    // Trusted execution input is snapshotted before the first await. Values remain private.
    const { handle } = input;
    // Subscribe immediately: a rejected foreign result must not become unhandled while capturing.
    void handle.result.catch(() => {});
    let timeoutMs: number;
    let values: string[];
    let execution: BaselineEvidence['execution'];
    try {
      validateStableId(input.projectId, { operation: 'baseline.evidence' }, 'projectId');
      if (!isUuidV4(input.operationId) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.checkKey)) throw new TypeError();
      const request = input.request;
      if (!Array.isArray(request.argv) || !request.argv.length || request.argv.some((s) => typeof s !== 'string')
          || typeof request.cwd !== 'string' || !request.cwd.startsWith('/')
          || (input.environmentRef !== null && typeof input.environmentRef !== 'string')) throw new TypeError();
      timeoutMs = positive(request.timeoutMs, 3_600_000);
      values = [...Object.values(request.environment),
        ...(input.protectedValues ?? [])];
      if (values.some((v) => typeof v !== 'string')) throw new TypeError();
      createOutputRedactor(values); // fail closed on oversized redaction configuration
      const argv = request.argv.map((arg) => redactOutputText(arg, values));
      execution = {
        argv,
        argvDigest: createHash('sha256').update(JSON.stringify(request.argv)).digest('hex'),
        argvRedacted: argv.some((arg, index) => arg !== request.argv[index]),
        cwd: redactOutputText(request.cwd, values),
        environmentRef: input.environmentRef === null ? null : redactOutputText(input.environmentRef, values),
        timeoutMs,
        allowedVariables: Object.keys(request.environment).sort(),
        codeIdentity: validateBaselineCodeIdentity(input.codeIdentity), processIdentity: { ...handle.identity },
      };
      if (Buffer.byteLength(JSON.stringify(execution)) > 16_384) throw new TypeError();
    } catch {
      await handle.cancel().catch(() => {});
      throw new TypeError('Baseline evidence: invalid execution input');
    }
    const projectId = input.projectId;
    const operationId = input.operationId;
    const checkKey = input.checkKey;
    const started = now();
    const gaps = new Set<BaselineEvidenceGap>();
    let output: ArtifactInputRef | null = null;
    let report: ArtifactInputRef | null = null;
    let record: ArtifactRecord | undefined;
    let write: ArtifactStagingWrite | undefined;
    let tail = '';
    let retained = 0;
    const observed = { stdout: 0, stderr: 0 };
    const hash = createHash('sha256');
    if (active) gaps.add('collector_busy');
    else if (charged + maxOutput + REPORT_MAX_BYTES > maxDisk) gaps.add('disk_budget');
    else { active = true; charged += maxOutput + REPORT_MAX_BYTES; }
    const admitted = gaps.size === 0;
    // Finite capture budget even for an unresponsive output iterator/write callback.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CaptureFailure('evidence_incomplete')), timeoutMs + 30_000);
    });
    void deadline.catch(() => {});
    const bounded = <T>(work: Promise<T>) => Promise.race([work, deadline]);
    let iterator: AsyncIterator<CommandProcessOutput> | undefined;
    try {
      if (!admitted) throw new CaptureFailure([...gaps][0]);
      iterator = handle.output[Symbol.asyncIterator]();
      write = await bounded(files.openStagingWrite({ projectId, artifactId: randomUUID() }));
      const redactors = { stdout: createOutputRedactor(values), stderr: createOutputRedactor(values) };
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
      async function append(stream: 'stdout' | 'stderr', text: string) {
        if (!text) return;
        const bytes = Buffer.from(`[${stream}]${text}`);
        if (retained + bytes.length > maxOutput) throw new CaptureFailure('output_overflow');
        await bounded(new Promise<void>((resolve, reject) => {
          write!.stream.write(bytes, (error) => error ? reject(error) : resolve());
        }));
        hash.update(bytes);
        retained += bytes.length;
        tail = tailOf(Buffer.concat([Buffer.from(tail), bytes]));
      }
      for (;;) {
        const next = await bounded(iterator.next());
        if (next.done) break;
        const { stream, bytes } = next.value;
        if ((stream !== 'stdout' && stream !== 'stderr') || !(bytes instanceof Uint8Array)) throw new CaptureFailure('evidence_incomplete');
        observed[stream] += bytes.length;
        if (observed.stdout + observed.stderr > maxOutput) throw new CaptureFailure('output_overflow');
        // No copying/decoding of an arbitrarily large caller chunk; slices stay <=16KiB.
        for (let offset = 0; offset < bytes.length; offset += 16_384) {
          await append(stream, redactors[stream].feed(decoders[stream].write(Buffer.from(bytes.subarray(offset, offset + 16_384)))));
        }
      }
      for (const stream of ['stdout', 'stderr'] as const) {
        await append(stream, redactors[stream].feed(decoders[stream].end()) + redactors[stream].end());
      }
      write.stream.end();
      const staged = await bounded(files.finishStaging(write));
      write = undefined;
      if (staged.sizeBytes !== retained) throw new CaptureFailure('evidence_incomplete');
      const contentHash = hash.digest('hex');
      record = await bounded(artifacts.registerArtifact({ projectId, kind: BASELINE_OUTPUT_KIND, mediaType: 'text/plain; charset=utf-8',
        expectedHash: contentHash, locator: `baseline/${operationId}/${checkKey}/output`, version: 1 }));
      try {
        const published = await bounded(files.publishStaging(staged, { projectId, artifactId: record.id }));
        if (published.sizeBytes !== retained) throw new CaptureFailure('evidence_incomplete');
      } catch {
        await artifacts.transitionArtifact(projectId, record.id, { expectedRevision: record.revision,
          outcome: { status: 'failed', reason: 'baseline_output_publication_failed' } }).catch(() => {});
        throw new CaptureFailure('publication_failed');
      }
      // Commit failure leaves pending + final for existing ArtifactVerifier recovery.
      await bounded(artifacts.transitionArtifact(projectId, record.id, { expectedRevision: record.revision,
        outcome: { status: 'ready', actualHash: contentHash, sizeBytes: retained } }));
      output = await artifacts.getArtifactInputRef(projectId, record.id);
    } catch (error) {
      gaps.add(error instanceof CaptureFailure ? error.gap : 'publication_failed');
      await handle.cancel().catch(() => { gaps.add('stop_unconfirmed'); });
      void Promise.resolve().then(() => iterator?.return?.()).catch(() => {});
      if (write) {
        write.stream.destroy();
        await files.finishStaging(write).catch(() => {}); // close fd, KEEP redacted residual
      }
    } finally { clearTimeout(timer); }
    let result: CommandProcessResult | undefined;
    // Result is a bounded supervised-process promise; a foreign port cannot hang finalization.
    let resultTimer: NodeJS.Timeout | undefined;
    try {
      result = await Promise.race([handle.result, new Promise<never>((_, reject) => {
        resultTimer = setTimeout(() => reject(new CaptureFailure('stop_unconfirmed')), 15_000);
      })]);
      if (!result.stop.confirmed) gaps.add('stop_unconfirmed');
      if (result.reason === 'cancelled' || result.reason === 'timed_out' || result.reason === 'output_overflow') gaps.add(result.reason);
      else if (result.reason) gaps.add('process_error');
      if (result.outputBytes !== observed.stdout + observed.stderr
          || !Number.isSafeInteger(result.droppedOutputBytes) || result.droppedOutputBytes !== 0) gaps.add('output_dropped');
    } catch { gaps.add('stop_unconfirmed'); await handle.cancel().catch(() => {}); }
    finally { clearTimeout(resultTimer); }
    const ended = now();
    let evidence: BaselineEvidence = {
      schemaVersion: 1, projectId, operationId, checkKey, execution,
      startedAtUtcMs: started, endedAtUtcMs: ended, durationMs: Math.max(0, ended - started),
      exitCode: result?.exitCode ?? null, signal: result?.signal ?? null, timedOut: result?.reason === 'timed_out', processReason: result?.reason ?? null,
      stopConfirmed: result?.stop.confirmed === true,
      output, report, interruptedArtifactId: output ? null : record?.id ?? null, tail,
      tailTruncated: retained > Buffer.byteLength(tail),
      integrity: { complete: gaps.size === 0 && output !== null, gaps: [...gaps], observedBytes: observed,
        retainedBytes: retained, droppedBytes: result?.droppedOutputBytes ?? 0, coverage: 'per-stream-redacted-tagged-text' },
      eligibleForPass: gaps.size === 0 && output !== null && result?.exitCode === 0 && result.signal === null,
    };
    try {
      if (admitted) {
        const bytes = Buffer.from(JSON.stringify(evidence));
        const publisher = createArtifactPublisher({ artifacts, files, limits: { maxSizeBytes: REPORT_MAX_BYTES, timeoutMs: 30_000 } });
        const published = await publisher.publishArtifact({ projectId, kind: BASELINE_EVIDENCE_KIND, mediaType: 'application/json',
          expectedHash: createHash('sha256').update(bytes).digest('hex'), locator: `baseline/${operationId}/${checkKey}/evidence`, content: [bytes] });
        report = await artifacts.getArtifactInputRef(projectId, published.artifact.id);
        evidence = { ...evidence, report };
        // A file removed between ready commit and return must not be allowed to pass.
        evidence = await verify(evidence);
      }
    } catch {
      await handle.cancel().catch(() => {});
      evidence = { ...evidence, eligibleForPass: false, integrity: { ...evidence.integrity, complete: false,
        gaps: [...new Set([...evidence.integrity.gaps, 'publication_failed' as const])] } };
    } finally { if (admitted) active = false; }
    return evidence;
  }
  return { collect, verify };
}

/** Application authorization + baseline output membership; no arbitrary path/locator. */
export async function readBaselineOutput(
  deps: { artifacts: ArtifactStore; files: ArtifactFileStore;
    checks: { listBaselineCheckResults(operationId: string): readonly Pick<BaselineCheckResultRecord, 'projectId' | 'outputArtifactId'>[] } },
  principal: TrustedPrincipal,
  input: { projectId: string; operationId: string; artifactId: string },
): Promise<Uint8Array> {
  const notFound = () => new PublicError('not_found', 'artifacts.get', '证据不存在或不可见');
  if (!input || Object.keys(input).some((key) => !['projectId', 'operationId', 'artifactId'].includes(key))) throw notFound();
  try {
    validateStableId(input.projectId, { operation: 'artifacts.get' }, 'projectId');
    validateStableId(input.artifactId, { operation: 'artifacts.get' }, 'artifactId');
  } catch { throw notFound(); }
  if (!isUuidV4(input.operationId) || !hasCapability(principal, 'baseline.read') || !isProjectVisible(principal, input.projectId)) throw notFound();
  const checks = deps.checks.listBaselineCheckResults(input.operationId);
  if (!checks.some((check) => check.projectId === input.projectId && check.outputArtifactId === input.artifactId)) throw notFound();
  let artifact: ArtifactRecord;
  try { artifact = await deps.artifacts.getArtifact(input.projectId, input.artifactId); } catch { throw notFound(); }
  if (artifact.kind !== BASELINE_OUTPUT_KIND) throw notFound();
  try {
    const verifier = createArtifactVerifier({ artifacts: deps.artifacts, files: deps.files, limits: { maxReadBytes: BASELINE_OUTPUT_MAX_BYTES } });
    return (await verifier.readVerifiedContent(input.projectId, input.artifactId)).content;
  } catch { throw new PublicError('corrupt_state', 'artifacts.get', '证据完整性核验失败', { details: { reason: 'evidence_incomplete' } }); }
}
