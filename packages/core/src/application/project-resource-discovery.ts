import { createHash } from 'node:crypto';
import type { ProjectResourceCandidate } from '../ports/project-resources.js';
import {
  type ProjectResourceCandidateReason,
  type ProjectResourceCandidateDiscoveryResult,
  type ProjectResourceCandidateMetadata,
  type ProjectResourceCandidatePreview,
  type ProjectResourceCandidatePreviewEntry,
  type ProjectResourceCandidateSource,
  type ProjectResourceCandidateSourceContent,
  type ProjectResourceCandidateSourceReader,
  type ProjectResourceCandidateSourceResult,
  PROJECT_RESOURCE_CANDIDATE_MAX_SOURCES,
  PROJECT_RESOURCE_CANDIDATE_SCHEMA_VERSION,
  ProjectResourceCandidateDiscoveryError,
  sha256CandidateBytes,
} from '../ports/project-resource-candidates.js';
import {
  PROJECT_RESOURCE_SCHEMA_VERSION,
  ProjectResourceError,
  validateProjectResourceCandidate,
} from '../ports/project-resources.js';
import { stableStringify } from '../ports/feature-plan.js';

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TEXT = 4096;
const MAX_TOOLS = 128;
const SOURCE_KEYS = ['sourceId', 'path', 'expectedDigest'] as const;
const MANIFEST_KEYS = ['schemaVersion', 'resources'] as const;
const RESOURCE_KEYS = [
  'kind', 'name', 'sourceRevision', 'version', 'content', 'contentDigest', 'transport',
  'capabilities', 'credentialRef', 'required', 'onUnavailable', 'description', 'prompt', 'tools',
] as const;

interface ParsedSource {
  readonly source: ProjectResourceCandidateSource;
  readonly sourceDigest: string;
  readonly candidates: readonly DiscoveredCandidate[];
}
interface DiscoveredCandidate extends ProjectResourceCandidate {
  readonly availability: 'available' | 'unverified';
  readonly metadata: ProjectResourceCandidateMetadata;
}
interface RejectedSource {
  readonly source: ProjectResourceCandidateSource;
  readonly reason: ProjectResourceCandidateReason;
}

function reject(reason: ProjectResourceCandidateReason): never {
  throw new ProjectResourceCandidateDiscoveryError(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) reject('invalid_manifest');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) reject('invalid_manifest');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) reject('invalid_manifest');
  }
  return value;
}

function text(value: unknown, reason: ProjectResourceCandidateReason = 'invalid_manifest'): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT || /[\0-\x1f\x7f]/.test(value)) reject(reason);
  return value;
}

function redactedText(value: string | undefined): string | null {
  if (value === undefined) return null;
  return value
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9._-]{8,})\b/g, '[REDACTED]')
    .replace(/(api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s,;]+/g, '[REDACTED_ENV]')
    .replace(/(?:\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/|\/Volumes\/)[^\s"'`]+/g, '[REDACTED_PATH]')
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, '[REDACTED_PATH]');
}

function sourceInput(value: unknown): ProjectResourceCandidateSource {
  const raw = object(value, SOURCE_KEYS);
  if (typeof raw.sourceId !== 'string' || !UUID_V4.test(raw.sourceId)
    || typeof raw.path !== 'string' || raw.path.length === 0 || raw.path.length > 4096
    || raw.path.includes('\0')) reject('invalid_path');
  if (raw.expectedDigest !== undefined && (typeof raw.expectedDigest !== 'string' || !SHA256.test(raw.expectedDigest))) {
    reject('invalid_digest');
  }
  return {
    sourceId: raw.sourceId,
    path: raw.path,
    ...(raw.expectedDigest === undefined ? {} : { expectedDigest: raw.expectedDigest }),
  };
}

function projectId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) reject('invalid_input');
  return value;
}

function parseManifest(value: unknown): { readonly resources: readonly Record<string, unknown>[] } {
  const raw = object(value, MANIFEST_KEYS);
  if (raw.schemaVersion !== PROJECT_RESOURCE_CANDIDATE_SCHEMA_VERSION) reject('unsupported_schema_version');
  if (!Array.isArray(raw.resources) || raw.resources.length === 0 || raw.resources.length > 64) reject('invalid_manifest');
  return { resources: raw.resources.map((item) => object(item, RESOURCE_KEYS)) };
}

function contentDigest(content: unknown): string {
  return createHash('sha256').update(stableStringify(content), 'utf8').digest('hex');
}

function parseTools(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TOOLS) reject('invalid_manifest');
  const names = value.map((item) => {
    const raw = object(item, ['name']);
    if (typeof raw.name !== 'string' || !TOOL_NAME.test(raw.name)) reject('invalid_tool_name');
    return raw.name;
  });
  if (new Set(names).size !== names.length) reject('duplicate_name');
  return names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function candidateFor(
  raw: Record<string, unknown>,
  project: string,
  source: ProjectResourceCandidateSource,
): DiscoveredCandidate {
  if (raw.version === undefined || typeof raw.version !== 'string' || !VERSION.test(raw.version)) reject('unsupported_resource_version');
  if (raw.kind !== 'skill' && raw.kind !== 'mcp') reject('unknown_resource');
  if (raw.transport !== null && raw.transport !== 'stdio' && raw.transport !== 'streamable_http') reject('unknown_transport');
  if (raw.kind === 'skill' && raw.transport !== null) reject('unknown_transport');
  if (raw.kind === 'mcp' && raw.transport === null) reject('unknown_transport');
  const tools = parseTools(raw.tools);
  const declaredDigest = raw.contentDigest;
  if (declaredDigest !== undefined && declaredDigest !== null && (typeof declaredDigest !== 'string' || !SHA256.test(declaredDigest))) {
    reject('invalid_digest');
  }
  if (declaredDigest !== undefined && declaredDigest !== null && raw.content !== undefined
    && declaredDigest !== contentDigest(raw.content)) reject('digest_mismatch');
  if (raw.credentialRef !== undefined && raw.credentialRef !== null) {
    if (typeof raw.credentialRef !== 'string' || !/^credential:[A-Za-z0-9._:-]{1,120}$/.test(raw.credentialRef)) reject('plaintext_credential');
  }
  const contentHash = raw.content !== undefined ? contentDigest(raw.content) : (declaredDigest as string | null | undefined);
  const candidateInput = {
    schemaVersion: PROJECT_RESOURCE_SCHEMA_VERSION,
    state: 'candidate',
    projectId: project,
    sourceProjectId: project,
    kind: raw.kind,
    name: raw.name,
    sourceRef: source.sourceId,
    sourceRevision: raw.sourceRevision ?? `source-${PROJECT_RESOURCE_CANDIDATE_SCHEMA_VERSION}`,
    version: raw.version,
    contentDigest: contentHash ?? null,
    transport: raw.transport,
    capabilities: raw.capabilities,
    credentialRef: raw.credentialRef ?? null,
    required: raw.required,
    onUnavailable: raw.onUnavailable,
  };
  let candidate: ProjectResourceCandidate;
  try {
    candidate = validateProjectResourceCandidate(candidateInput);
  } catch (error) {
    if (error instanceof ProjectResourceError) {
      const mapping: Partial<Record<ProjectResourceError['reason'], ProjectResourceCandidateReason>> = {
        unsupported_schema_version: 'unsupported_schema_version', unknown_resource: 'unknown_resource',
        unknown_transport: 'unknown_transport', invalid_digest: 'invalid_digest', plaintext_credential: 'plaintext_credential',
      };
      reject(mapping[error.reason] ?? 'invalid_manifest');
    }
    reject('invalid_manifest');
  }
  const metadata: ProjectResourceCandidateMetadata = {
    description: redactedText(raw.description === undefined ? undefined : text(raw.description)),
    promptSummary: redactedText(raw.prompt === undefined ? undefined : text(raw.prompt)),
    toolNames: tools.map((name) => name === 'owner.assume' || name === 'task.verify' ? '[REDACTED]' : name),
  };
  return {
    ...candidate,
    availability: raw.content === undefined ? 'unverified' : 'available',
    metadata,
  };
}

function parseSource(content: ProjectResourceCandidateSourceContent, project: string, source: ProjectResourceCandidateSource): ParsedSource {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(content.bytes).toString('utf8')) as unknown;
  } catch {
    reject('invalid_manifest');
  }
  const manifest = parseManifest(parsed);
  const candidates = manifest.resources.map((item) => candidateFor(item, project, source));
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) reject('duplicate_identity');
    ids.add(candidate.id);
    const key = `${candidate.kind}:${candidate.name}`;
    if (names.has(key)) reject('duplicate_name');
    names.add(key);
  }
  return { source, sourceDigest: content.digest, candidates };
}

function errorReason(error: unknown): ProjectResourceCandidateReason {
  return error instanceof ProjectResourceCandidateDiscoveryError ? error.reason : 'source_io_failed';
}

function validateInput(input: unknown): { readonly projectId: string; readonly sources: readonly ProjectResourceCandidateSource[] } {
  if (!isRecord(input)) reject('invalid_input');
  const project = projectId(input.projectId);
  if (!Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > PROJECT_RESOURCE_CANDIDATE_MAX_SOURCES) reject('invalid_input');
  const sources = input.sources.map(sourceInput);
  if (new Set(sources.map((source) => source.sourceId)).size !== sources.length) reject('duplicate_identity');
  return { projectId: project, sources };
}

function sortCandidates(candidates: readonly DiscoveredCandidate[]): DiscoveredCandidate[] {
  return [...candidates].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function result(
  projectIdValue: string,
  parsed: readonly ParsedSource[],
  rejected: readonly RejectedSource[],
): ProjectResourceCandidateDiscoveryResult {
  const candidates = sortCandidates(parsed.flatMap((item) => item.candidates));
  const sources: ProjectResourceCandidateSourceResult[] = [
    ...parsed.map((item) => ({ sourceId: item.source.sourceId, sourceDigest: item.sourceDigest, status: 'accepted' as const, candidateIds: [...item.candidates.map((candidate) => candidate.id)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0), error: null })),
    ...rejected.map((item) => ({ sourceId: item.source.sourceId, sourceDigest: null, status: 'rejected' as const, candidateIds: [], error: { reason: item.reason } })),
  ].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
  return {
    schemaVersion: PROJECT_RESOURCE_CANDIDATE_SCHEMA_VERSION,
    projectId: projectIdValue,
    sources,
    candidates,
    rejected: rejected.map((item) => ({ sourceId: item.source.sourceId, reason: item.reason })).sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0),
    configurationChanged: false,
  };
}

export function createProjectResourceCandidateDiscovery(options: {
  readonly sourceReader: ProjectResourceCandidateSourceReader;
}): ProjectResourceCandidateDiscovery {
  if (!isRecord(options) || !options.sourceReader || typeof options.sourceReader.read !== 'function') reject('invalid_input');
  const sourceReader = options.sourceReader;

  async function discover(input: unknown): Promise<ProjectResourceCandidateDiscoveryResult> {
    const valid = validateInput(input);
    const parsed: ParsedSource[] = [];
    const rejected: RejectedSource[] = [];
    for (const source of valid.sources) {
      try {
        if (!source.path.startsWith('/')) {
          throw new ProjectResourceCandidateDiscoveryError('invalid_path');
        }
        const content = await sourceReader.read(source);
        if (!content || !(content.bytes instanceof Uint8Array) || typeof content.digest !== 'string' || !SHA256.test(content.digest)
          || content.digest !== sha256CandidateBytes(content.bytes)) reject('source_io_failed');
        if (source.expectedDigest !== undefined && source.expectedDigest !== content.digest) reject('digest_mismatch');
        parsed.push(parseSource(content, valid.projectId, source));
      } catch (error) {
        rejected.push({ source, reason: errorReason(error) });
      }
    }
    const accepted: ParsedSource[] = [];
    const usedNames = new Set<string>();
    const usedIds = new Set<string>();
    for (const item of [...parsed].sort((a, b) => a.source.sourceId < b.source.sourceId ? -1 : a.source.sourceId > b.source.sourceId ? 1 : 0)) {
      const duplicate = item.candidates.some((candidate) => usedIds.has(candidate.id) || usedNames.has(`${candidate.kind}:${candidate.name}`));
      if (duplicate) {
        rejected.push({ source: item.source, reason: usedIds.has(item.candidates[0]?.id ?? '') ? 'duplicate_identity' : 'duplicate_name' });
        continue;
      }
      accepted.push(item);
      for (const candidate of item.candidates) {
        usedIds.add(candidate.id);
        usedNames.add(`${candidate.kind}:${candidate.name}`);
      }
    }
    return result(valid.projectId, accepted, rejected);
  }

  async function preview(input: unknown): Promise<ProjectResourceCandidatePreview> {
    const valid = validateInput(input);
    const discovered = await discover(valid);
    const selected = new Set(input && isRecord(input) && Array.isArray(input.selectedResourceIds) ? input.selectedResourceIds.filter((id): id is string => typeof id === 'string') : []);
    const existing = input && isRecord(input) && Array.isArray(input.existingResources) ? input.existingResources : [];
    const entries: ProjectResourceCandidatePreviewEntry[] = discovered.candidates.map((candidate) => {
      if (selected.has(candidate.id)) return { sourceId: candidate.sourceRef, candidateId: candidate.id, name: candidate.name, status: 'selected', reason: 'already_selected' };
      const configured = existing.some((item) => isRecord(item) && item.id === candidate.id);
      if (configured) return { sourceId: candidate.sourceRef, candidateId: candidate.id, name: candidate.name, status: 'conflict', reason: 'already_configured' };
      const nameConflict = existing.some((item) => isRecord(item) && item.kind === candidate.kind && item.name === candidate.name);
      if (nameConflict) return { sourceId: candidate.sourceRef, candidateId: candidate.id, name: candidate.name, status: 'conflict', reason: 'duplicate_name' };
      return { sourceId: candidate.sourceRef, candidateId: candidate.id, name: candidate.name, status: 'pending', reason: null };
    });
    for (const item of discovered.rejected) {
      entries.push({
        sourceId: item.sourceId,
        candidateId: null,
        name: null,
        status: item.reason === 'duplicate_name' || item.reason === 'duplicate_identity' ? 'conflict' : 'rejected',
        reason: item.reason,
      });
    }
    entries.sort((a, b) => {
      const left = `${a.sourceId}:${a.candidateId ?? ''}`;
      const right = `${b.sourceId}:${b.candidateId ?? ''}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    return { schemaVersion: PROJECT_RESOURCE_CANDIDATE_SCHEMA_VERSION, projectId: discovered.projectId, entries, candidates: discovered.candidates, rejected: discovered.rejected, configurationChanged: false };
  }

  return { discover, preview };
}

export interface ProjectResourceCandidateDiscovery {
  discover(input: unknown): Promise<ProjectResourceCandidateDiscoveryResult>;
  preview(input: unknown): Promise<ProjectResourceCandidatePreview>;
}
