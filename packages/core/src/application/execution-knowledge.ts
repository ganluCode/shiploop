import type { ContextKnowledgeSelection } from '../ports/context-build.js';
import type { DocumentStore, MemoryStore } from '../ports/knowledge.js';
import type { KnowledgeQueryReadStore, KnowledgeDocumentQueryRow } from '../ports/knowledge-query.js';
import type { MemoryQueryReadStore, MemoryQueryRow } from '../ports/memory-query.js';
import type { ExecutionKnowledgeBudget, ExecutionKnowledgeReader } from '../ports/execution-input-prepare.js';
import type { ArtifactVerifier } from './artifact-verify.js';
import { PublicError } from '../ports/commands.js';

interface Request {
  readonly kind?: unknown;
  readonly documentId?: unknown;
  readonly memoryId?: unknown;
  readonly sourceId?: unknown;
  readonly id?: unknown;
  readonly version?: unknown;
  readonly keyword?: unknown;
  readonly title?: unknown;
  readonly path?: unknown;
  readonly recordKey?: unknown;
  readonly scope?: unknown;
  readonly range?: unknown;
  readonly position?: unknown;
  readonly purpose?: unknown;
  readonly required?: unknown;
  readonly reason?: unknown;
  readonly selectionReason?: unknown;
  readonly snippet?: unknown;
  readonly excerpt?: unknown;
  readonly projectId?: unknown;
}

export interface ExecutionKnowledgeReaderDeps {
  readonly documents: Pick<DocumentStore, 'getDocument'>;
  readonly documentQuery: KnowledgeQueryReadStore;
  readonly memoryQuery: MemoryQueryReadStore;
  readonly verifier: Pick<ArtifactVerifier, 'readVerifiedContent'>;
}

function fail(reason: string, details?: Record<string, unknown>): never {
  throw new PublicError('conflict', 'execution.input.prepare', undefined, {
    details: { reason, ...(details ?? {}) },
  });
}

function text(value: unknown, field: string, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) fail('validation', { field });
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2_000) fail('validation', { field });
  return value.trim();
}

function positive(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail('validation', { field });
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail('validation', { field });
  return value;
}

function rangeOf(value: unknown, length: number): { start: number; end: number; line?: number; column?: number } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || value === null) fail('validation', { field: 'range' });
  const raw = value as Record<string, unknown>;
  const start = raw.start;
  const end = raw.end;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > length) {
    fail('validation', { field: 'range' });
  }
  return {
    start: start as number,
    end: end as number,
    ...(raw.line === undefined ? {} : { line: raw.line as number }),
    ...(raw.column === undefined ? {} : { column: raw.column as number }),
  };
}

function boundedSnippet(body: string, start: number, end: number, maxChars: number): string {
  const length = end - start;
  const half = Math.max(0, Math.floor((maxChars - length) / 2));
  const from = Math.max(0, start - half);
  const to = Math.min(body.length, Math.max(from + maxChars, end));
  return body.slice(Math.max(0, to - maxChars), to);
}

function position(body: string, start: number, end: number): { start: number; end: number; line: number; column: number } {
  const before = body.slice(0, start);
  return { start, end, line: before.split('\n').length, column: start - before.lastIndexOf('\n') };
}

export function createExecutionKnowledgeReader(deps: ExecutionKnowledgeReaderDeps): ExecutionKnowledgeReader {
  if (deps === null || typeof deps !== 'object') throw new TypeError('createExecutionKnowledgeReader: deps 必须是对象');

  return {
    async resolve(input) {
      if (input.requests.length > input.budget.maxSources) fail('limit_exceeded', { limit: 'maxSources' });
      const selections: ContextKnowledgeSelection[] = [];
      let candidatesInspected = 0;
      let bytesRead = 0;
      let omittedSources = 0;

      for (const [index, raw] of input.requests.entries()) {
        const request = raw as Request;
        const allowedKeys = new Set(['kind', 'documentId', 'memoryId', 'sourceId', 'id', 'version', 'keyword', 'title', 'path', 'recordKey', 'scope', 'range', 'position', 'purpose', 'required', 'reason', 'selectionReason', 'projectId']);
        if (Object.keys(request as Record<string, unknown>).some((key) => !allowedKeys.has(key))) fail('validation', { field: `knowledge[${index}]` });
        if (request.snippet !== undefined || request.excerpt !== undefined) fail('validation', { field: `knowledge[${index}].snippet` });
        const kind = request.kind;
        if (kind !== 'document' && kind !== 'memory') fail('validation', { field: `knowledge[${index}].kind` });
        if (request.projectId !== undefined && request.projectId !== input.projectId) fail('ownership_denied', { field: `knowledge[${index}].projectId` });
        const required = bool(request.required, `knowledge[${index}].required`);
        const purpose = text(request.purpose, `knowledge[${index}].purpose`, true)!;
        const reason = text(request.reason ?? request.selectionReason, `knowledge[${index}].reason`) ?? 'Core project-scoped knowledge selection';
        const version = positive(request.version, `knowledge[${index}].version`);
        const documentId = text(request.documentId ?? request.sourceId ?? request.id, `knowledge[${index}].documentId`);
        const memoryId = text(request.memoryId ?? request.sourceId ?? request.id, `knowledge[${index}].memoryId`);
        const keyword = text(request.keyword, `knowledge[${index}].keyword`);
        const title = text(request.title, `knowledge[${index}].title`);
        const path = text(request.path, `knowledge[${index}].path`);
        const recordKey = text(request.recordKey, `knowledge[${index}].recordKey`);
        const scope = text(request.scope, `knowledge[${index}].scope`);
        const candidates = kind === 'document'
          ? deps.documentQuery.listDocumentVersions(input.projectId, {
            ...(documentId === undefined ? {} : { documentId }), ...(version === undefined ? {} : { version }),
            limit: input.budget.maxCandidates, maxCandidates: input.budget.maxCandidates,
          })
          : deps.memoryQuery.listAcceptedMemories(input.projectId, {
            ...(memoryId === undefined ? {} : { recordKey: memoryId }), ...(version === undefined ? {} : { version }),
            ...(scope === undefined ? {} : { scope }), limit: input.budget.maxCandidates, maxCandidates: input.budget.maxCandidates,
          });
        candidatesInspected += candidates.length;
        let found = false;
        for (const candidate of candidates) {
          if (selections.length >= input.budget.maxSources) break;
          const documentCandidate = kind === 'document' ? candidate as KnowledgeDocumentQueryRow : undefined;
          const memoryCandidate = kind === 'memory' ? candidate as MemoryQueryRow : undefined;
          const record = kind === 'document' ? documentCandidate!.document : memoryCandidate!.memory;
          const actualId = kind === 'document' ? documentCandidate!.document.id : memoryCandidate!.memory.id;
          if ((kind === 'document' && documentId !== undefined && actualId !== documentId) ||
              (kind === 'memory' && memoryId !== undefined && actualId !== memoryId)) continue;
          if (kind === 'document' && title !== undefined && !documentCandidate!.document.title.toLocaleLowerCase().includes(title.toLocaleLowerCase())) continue;
          if (kind === 'document' && path !== undefined && !documentCandidate!.contentLocator.includes(path)) continue;
          if (kind === 'memory' && recordKey !== undefined && memoryCandidate!.memory.recordKey !== recordKey) continue;
          if (kind === 'document' && documentCandidate!.version.status !== 'published') continue;
          if (kind === 'memory' && memoryCandidate!.memory.status !== 'accepted') continue;
          const contentRef = kind === 'document' ? documentCandidate!.version.contentRef : memoryCandidate!.memory.contentRef;
          if (contentRef.sizeBytes > input.budget.maxReadBytes - bytesRead) {
            if (required) fail('limit_exceeded', { limit: 'maxReadBytes', requiredBytes: contentRef.sizeBytes });
            omittedSources += 1;
            continue;
          }
          let verified;
          try { verified = await deps.verifier.readVerifiedContent(input.projectId, contentRef.artifactId); }
          catch { if (required) fail('published_body_mismatch', { artifactId: contentRef.artifactId }); omittedSources += 1; continue; }
          bytesRead += verified.sizeBytes;
          const expectedHash = kind === 'document' ? documentCandidate!.version.contentHash : memoryCandidate!.memory.contentHash;
          if (verified.contentHash !== expectedHash || verified.sizeBytes !== contentRef.sizeBytes) {
            if (required) fail('published_body_mismatch', { artifactId: contentRef.artifactId });
            omittedSources += 1; continue;
          }
          const body = new TextDecoder().decode(verified.content);
          const requestedRange = rangeOf(request.range ?? request.position, body.length);
          const needle = keyword ?? (kind === 'document' ? title : recordKey) ?? null;
          const hit = requestedRange ?? (needle === null ? { start: 0, end: Math.min(body.length, input.budget.maxSnippetChars) } : (() => {
            const start = body.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
            return start < 0 ? undefined : { start, end: start + needle.length };
          })());
          if (hit === undefined) continue;
          const snippet = typeof request.snippet === 'string' ? request.snippet : boundedSnippet(body, hit.start, hit.end, input.budget.maxSnippetChars);
          if (Buffer.byteLength(snippet, 'utf8') > input.budget.maxTotalBytes) {
            if (required) fail('limit_exceeded', { limit: 'maxTotalBytes' });
            omittedSources += 1; continue;
          }
          selections.push({
            kind,
            sourceId: actualId,
            ...(kind === 'document' ? { documentId: actualId } : { memoryId: actualId }),
            projectId: input.projectId,
            version: kind === 'document' ? documentCandidate!.version.version : memoryCandidate!.memory.version,
            contentRef,
            contentHash: expectedHash,
            range: { ...hit, ...position(body, hit.start, hit.end) },
            purpose, required, reason, snippet, truncated: false,
          });
          found = true;
          break;
        }
        if (!found && required) fail('missing_required_input', { sourceId: documentId ?? memoryId ?? null });
        if (!found && !required) omittedSources += 1;
      }
      return {
        selections,
        budget: { ...input.budget, candidatesInspected, bytesRead, selectedSources: selections.length, omittedSources },
      };
    },
  };
}
