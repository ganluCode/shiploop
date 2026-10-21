import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { RuntimeError } from 'shiploop-core';
import type { ExecutionInputRef, RuntimeExecutionRequest, RuntimeRecoveryReference } from 'shiploop-core';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { PI_NATIVE_SESSION_FORMAT, PI_NATIVE_SESSION_FORMAT_VERSION, PI_SDK_VERSION } from './pi-sdk-contract.js';
import type { PiRecoveryWriterLease } from './pi-adapter.js';

const MAX_ARCHIVE_BYTES = 8_388_608;
function reject(reason: string): never { throw new RuntimeError('configuration', reason); }

/** Bytes come from immutable Core Artifacts, never from a still-open native file. */
export interface PiPreparedRecovery {
  readonly archive: Uint8Array;
  readonly nativeWatermark?: { readonly entryCount: number; readonly lastEntryId: string | null };
  readonly reference: Pick<RuntimeRecoveryReference, 'providerSessionId' | 'sourceDigest'>;
  readonly assertCurrent: () => Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('native_archive_corrupt');
  return value as Record<string, unknown>;
}

function validateMessage(value: unknown): void {
  const message = record(value);
  if (typeof message.role !== 'string' || typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)) {
    reject('native_archive_corrupt');
  }
  if (!['user', 'assistant', 'toolResult'].includes(message.role)) reject('native_entry_unverified');
  const content = message.content;
  if (typeof content === 'string' && message.role === 'user') return;
  if (!Array.isArray(content)) reject('native_archive_corrupt');
  for (const value of content) {
    const block = record(value);
    const valid = (block.type === 'text' && typeof block.text === 'string') ||
      (block.type === 'image' && message.role !== 'assistant' && typeof block.data === 'string' && typeof block.mimeType === 'string') ||
      (block.type === 'thinking' && message.role === 'assistant' && typeof block.thinking === 'string') ||
      (block.type === 'toolCall' && message.role === 'assistant' && typeof block.id === 'string' &&
        typeof block.name === 'string');
    if (!valid) reject('native_archive_corrupt');
    if (block.type === 'toolCall') record(block.arguments);
  }
  if (message.role === 'toolResult' && (typeof message.toolCallId !== 'string' || typeof message.toolName !== 'string' ||
      typeof message.isError !== 'boolean')) reject('native_archive_corrupt');
  if (message.role === 'assistant') {
    if (typeof message.provider !== 'string' || typeof message.model !== 'string' || typeof message.api !== 'string' ||
        !['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(message.stopReason))) reject('native_archive_corrupt');
    const usage = record(message.usage), cost = record(usage.cost);
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
      if (typeof usage[key] !== 'number' || !Number.isFinite(usage[key]) || usage[key] < 0) reject('native_archive_corrupt');
    }
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
      if (typeof cost[key] !== 'number' || !Number.isFinite(cost[key]) || cost[key] < 0) reject('native_archive_corrupt');
    }
  }
}

export function validatePiNativeArchive(recovery: PiPreparedRecovery): { entryCount: number; lastEntryId: string | null } {
  const bytes = recovery.archive;
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_BYTES) reject('native_archive_size_invalid');
  if (createHash('sha256').update(bytes).digest('hex') !== recovery.reference.sourceDigest) reject('native_archive_digest_mismatch');
  let entries: Record<string, unknown>[];
  try {
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd().split('\n');
    if (lines.length > 20_000) reject('native_archive_size_invalid');
    entries = lines.map(line => {
      const entry: unknown = JSON.parse(line);
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) reject('native_archive_corrupt');
      return entry as Record<string, unknown>;
    });
  } catch { return reject('native_archive_corrupt'); }
  const header = entries[0];
  if (header.type !== 'session' || header.id !== recovery.reference.providerSessionId || typeof header.cwd !== 'string' ||
      typeof header.timestamp !== 'string') reject('native_session_identity_mismatch');
  if (header.version !== Number(PI_NATIVE_SESSION_FORMAT_VERSION)) reject('native_format_incompatible');
  const ids = new Set<string>();
  for (const entry of entries.slice(1)) {
    if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
        (entry.parentId !== null && (typeof entry.parentId !== 'string' || !ids.has(entry.parentId))) ||
        typeof entry.timestamp !== 'string') reject('native_archive_corrupt');
    ids.add(entry.id);
    // A conservative supported subset: complex compaction/extension state needs separate evidence.
    if (entry.type === 'message') {
      validateMessage(entry.message);
    } else if (entry.type === 'model_change') {
      if (typeof entry.provider !== 'string' || typeof entry.modelId !== 'string') reject('native_archive_corrupt');
    } else if (entry.type === 'thinking_level_change') {
      if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(entry.thinkingLevel))) reject('native_archive_corrupt');
    } else reject('native_entry_unverified');
  }
  return { entryCount: entries.length - 1, lastEntryId: entries.length <= 1 ? null : entries.at(-1)!.id as string };
}

async function verifiedBytes(lease: PiRecoveryWriterLease, ref: ExecutionInputRef): Promise<Uint8Array> {
  if (ref.projectId !== lease.source.reference.sourceProjectId) reject('source_artifact_project_mismatch');
  if (ref.sizeBytes > MAX_ARCHIVE_BYTES) reject('native_archive_size_invalid');
  const bytes = new Uint8Array(await lease.readVerifiedArtifact(ref));
  if (bytes.byteLength !== ref.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== ref.contentHash) {
    reject('source_artifact_content_mismatch');
  }
  return bytes;
}

/** Recheck the trusted authority after asynchronous reads and again before SDK use. */
export async function preparePiRecovery(request: RuntimeExecutionRequest, source: RuntimeRecoveryReference,
  lease: PiRecoveryWriterLease): Promise<PiPreparedRecovery> {
  if (request.identity.purpose !== 'work' || source.purpose !== 'work' ||
      source.sourceProjectId !== request.projectId || source.sourceTaskId !== request.identity.taskId ||
      source.sourceAttemptId === request.identity.attemptId || source.sourceSessionId === request.sessionId ||
      source.runtime !== 'pi' || !isDeepStrictEqual(source, lease.source.reference)) reject('source_identity_mismatch');
  const authority = lease.authority;
  if (authority.projectId !== request.projectId || authority.featureId !== request.featureId ||
      authority.taskId !== request.identity.taskId || authority.taskStatus !== 'unfinished' ||
      authority.previousAttemptId !== source.sourceAttemptId || authority.previousSessionId !== source.sourceSessionId) {
    reject('source_not_previous_unfinished_attempt');
  }
  const writer = lease.writer;
  if (lease.sourceReadOnly !== true || writer.exclusive !== true || writer.purpose !== 'work' ||
      writer.attemptId !== request.identity.attemptId || writer.invocationId !== request.invocationId ||
      writer.sessionId !== request.sessionId || writer.executionVersion !== request.executionVersion ||
      !isDeepStrictEqual(writer.owner, request.owner)) reject('native_writer_ownership_mismatch');
  if (lease.source.previousWriter.status !== 'confirmed') reject('source_stop_unconfirmed');
  if (source.nativeFormat !== PI_NATIVE_SESSION_FORMAT || source.nativeFormatVersion !== PI_NATIVE_SESSION_FORMAT_VERSION ||
      lease.source.sdkVersion !== PI_SDK_VERSION) reject('native_format_incompatible');
  const archive = lease.source.archive;
  if (archive.artifactId !== source.nativeArchiveRef || archive.contentHash !== source.sourceDigest ||
      archive.mediaType !== 'application/x-ndjson') reject('source_archive_identity_mismatch');
  await lease.assertCurrent();
  await verifiedBytes(lease, lease.source.previousWriter.stopEvidence);
  const bytes = await verifiedBytes(lease, archive);
  const prepared = { archive: bytes, reference: source, assertCurrent: () => lease.assertCurrent() };
  const nativeWatermark = validatePiNativeArchive(prepared);
  await lease.assertCurrent();
  return { ...prepared, nativeWatermark };
}

/** Claim a never-reused native directory atomically; a second Runner cannot open its files. */
export async function createPiManagedSessionManager(sdk: { readonly SessionManager: typeof SessionManager },
  cwd: string, sessionDir: string, recovery?: PiPreparedRecovery): Promise<SessionManager> {
  if (recovery !== undefined) {
    validatePiNativeArchive(recovery);
    await recovery.assertCurrent();
    if (typeof sdk.SessionManager.forkFrom !== 'function') reject('native_fork_unsupported');
  }
  const parent = path.dirname(path.resolve(sessionDir));
  await mkdir(parent, { recursive: true });
  // Canonicalize the trusted parent before taking the exclusive leaf; never reopen an existing scope.
  const target = path.join(await realpath(parent), path.basename(sessionDir));
  try { await mkdir(target, { mode: 0o700 }); }
  catch { return reject('native_writer_scope_unavailable'); }
  if (recovery === undefined) return sdk.SessionManager.create(cwd, target);
  const sourceFile = path.join(target, 'source.jsonl');
  await writeFile(sourceFile, recovery.archive, { flag: 'wx', mode: 0o400 });
  await recovery.assertCurrent();
  const manager = sdk.SessionManager.forkFrom(sourceFile, cwd, target);
  const forkFile = manager.getSessionFile();
  if (manager.getSessionId() === recovery.reference.providerSessionId || forkFile === undefined ||
      path.dirname(forkFile) !== target || forkFile === sourceFile) {
    reject('native_fork_identity_mismatch');
  }
  return manager;
}
