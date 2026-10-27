import { assertTrustedPrincipal, authorizeProjectRead } from '../ports/authorization.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { ArtifactVerifier } from './artifact-verify.js';
import { isArtifactVerifyError } from './artifact-verify.js';
import { isStorageError } from '../ports/errors.js';
import type { MemorySearchDiagnostic, MemorySearchResult, MemorySearchResultSet, MemoryQueryRow, MemoryQueryReadStore } from '../ports/memory-query.js';
import { createMemoryQueryInfo, validateMemorySearchInput, type ValidatedMemorySearchInput } from '../ports/memory-query.js';
import type { MemoryStore } from '../ports/knowledge.js';
import { validateStableId } from '../ports/validation.js';

const OPERATION = 'memory.search';

export interface MemoryQueryServiceDeps {
  readonly memories: Pick<MemoryStore, 'getMemoryRecord'>;
  readonly memoryQuery: MemoryQueryReadStore;
  readonly verifier: Pick<ArtifactVerifier, 'readVerifiedContent'>;
  readonly artifacts: Pick<ArtifactStore, 'getArtifact'>;
}

export interface MemoryQueryService {
  readonly search: (principal: unknown, projectId: string, input: unknown) => Promise<MemorySearchResultSet>;
  readonly searchMemories: MemoryQueryService['search'];
}

function lower(value: string): string { return value.toLocaleLowerCase('en-US'); }
function positionOf(body: string, offset: number, length: number) {
  const before = body.slice(0, offset);
  const lastNewline = before.lastIndexOf('\n');
  return { start: offset, end: offset + length, line: before.split('\n').length, column: offset - lastNewline };
}
function snippet(body: string, offset: number, length: number, maxChars: number): string {
  const half = Math.max(0, Math.floor((maxChars - length) / 2));
  const start = Math.max(0, offset - half);
  const end = Math.min(body.length, start + maxChars);
  return body.slice(Math.max(0, end - maxChars), end);
}
function diagnostic(code: MemorySearchDiagnostic['code'], reason: string, row: MemoryQueryRow | undefined, bytesRead: number): MemorySearchDiagnostic {
  return { code, reason, bytesRead, ...(row === undefined ? {} : { id: row.memory.id, recordKey: row.memory.recordKey, version: row.memory.version }) };
}
function queryText(input: ValidatedMemorySearchInput): string | null { return input.keyword ?? input.recordKey ?? input.scope ?? null; }

export function createMemoryQueryService(deps: MemoryQueryServiceDeps): MemoryQueryService {
  if (deps === null || typeof deps !== 'object') throw new TypeError('createMemoryQueryService: deps 必须是对象');
  async function search(principal: unknown, projectId: string, input: unknown): Promise<MemorySearchResultSet> {
    assertTrustedPrincipal(principal);
    const parsed = validateMemorySearchInput(input, OPERATION);
    const id = validateStableId(projectId, { operation: OPERATION }, 'projectId');
    authorizeProjectRead(principal, id, OPERATION);
    const query = createMemoryQueryInfo(parsed);
    const rows = deps.memoryQuery.listAcceptedMemories(id, {
      ...(parsed.recordKey === undefined ? {} : { recordKey: parsed.recordKey }),
      ...(parsed.version === undefined ? {} : { version: parsed.version }),
      ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
      limit: parsed.limit,
      maxCandidates: parsed.maxCandidates,
    });
    const candidates = rows.slice(0, parsed.maxCandidates);
    const results: MemorySearchResult[] = [];
    const diagnostics: MemorySearchDiagnostic[] = [];
    let bytesRead = 0;
    const needle = queryText(parsed);
    for (const row of candidates) {
      if (results.length >= parsed.limit) break;
      const bodyLimit = parsed.maxReadBytes - bytesRead;
      if (row.memory.contentRef.sizeBytes > bodyLimit) {
        diagnostics.push(diagnostic('budget_exceeded', '读取预算不足，未截断读取记忆正文', row, bytesRead));
        continue;
      }
      try {
        for (const source of row.memory.sourceRefs) {
          const artifact = await deps.artifacts.getArtifact(id, source.artifactId);
          if (artifact.status !== 'ready' || artifact.projectId !== id || artifact.version !== source.version || (source.contentHash !== undefined && artifact.contentHash !== source.contentHash)) {
            throw new Error('source_identity_mismatch');
          }
        }
      } catch (error) {
        if (isStorageError(error) || error instanceof Error) {
          diagnostics.push(diagnostic('unavailable_source', '记忆来源制品不可用或身份不一致', row, bytesRead));
          continue;
        }
        throw error;
      }
      let verified;
      try { verified = await deps.verifier.readVerifiedContent(id, row.memory.contentRef.artifactId); }
      catch (error) {
        if (isArtifactVerifyError(error) || isStorageError(error)) { diagnostics.push(diagnostic('corrupt_content', '记忆正文制品完整性核验失败', row, bytesRead)); continue; }
        throw error;
      }
      bytesRead += verified.sizeBytes;
      if (verified.contentHash !== row.memory.contentRef.contentHash || verified.sizeBytes !== row.memory.contentRef.sizeBytes) {
        diagnostics.push(diagnostic('corrupt_content', '记忆正文身份与索引不一致', row, bytesRead));
        continue;
      }
      const body = new TextDecoder().decode(verified.content);
      const bodyOffset = needle === null ? -1 : lower(body).indexOf(lower(needle));
      const metadata = `${row.memory.recordKey}\n${row.memory.scope}`;
      const metadataOffset = needle === null ? 0 : lower(metadata).indexOf(lower(needle));
      if (bodyOffset < 0 && metadataOffset < 0) continue;
      const offset = bodyOffset >= 0 ? bodyOffset : 0;
      const matchLength = bodyOffset >= 0 ? needle!.length : 0;
      results.push({
        id: row.memory.id, recordKey: row.memory.recordKey, version: row.memory.version, scope: row.memory.scope,
        status: 'accepted', contentRef: row.memory.contentRef, contentHash: row.memory.contentRef.contentHash,
        sourceRefs: row.memory.sourceRefs, sourceLocators: row.sourceLocators,
        snippet: snippet(body, offset, matchLength, parsed.snippetMaxChars), position: positionOf(body, offset, matchLength),
        query, selectionReason: bodyOffset >= 0 ? '记忆正文关键词命中' : '记忆稳定键或适用范围命中',
      });
    }
    if (results.length === 0 && diagnostics.length === 0) diagnostics.push(diagnostic('no_results', '没有匹配的 accepted 记忆', undefined, bytesRead));
    return {
      schemaVersion: 1, scope: 'memory-search', projectId: id, query,
      budget: { limit: parsed.limit, snippetMaxChars: parsed.snippetMaxChars, maxReadBytes: parsed.maxReadBytes, maxCandidates: parsed.maxCandidates, candidatesInspected: candidates.length, bytesRead },
      results, diagnostics, truncated: rows.length > parsed.maxCandidates,
    };
  }
  return { search, searchMemories: search };
}
