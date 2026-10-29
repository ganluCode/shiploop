/** P06-7 F-004: real Todo/Git/SQLite/artifacts + scripted model decisions only. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeRuntime, type FakeRuntimeHandle } from '../../../packages/core/src/adapters/fake-runtime.ts';
import { createSqliteDocumentStore } from '../../../packages/core/src/adapters/sqlite/document-store.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { createSqliteStateStore } from '../../../packages/core/src/adapters/sqlite/state-store.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createDocumentService } from '../../../packages/core/src/application/document-service.ts';
import { createKnowledgeQueryService } from '../../../packages/core/src/application/knowledge-query-service.ts';
import { createExecutionKnowledgeReader } from '../../../packages/core/src/application/execution-knowledge.ts';
import { createInputSourceFileReader } from '../../../packages/core/src/adapters/fs/input-source-files.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import { validateAttemptInputSnapshot } from '../../../packages/core/src/ports/attempt-store.ts';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import type { ContextInputManifest, ContextInputSnapshot } from '../../../packages/core/src/ports/context-build.ts';
import type { RuntimeExecutionRequest, RuntimeExecutionResult } from '../../../packages/core/src/ports/runtime-execution.ts';
import { createTodoBrownfieldFixture, type TodoBrownfieldFixture } from '../../helpers/p06-7/index.ts';
import { openBindingFixture, type BindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';
import { resourceFixture } from '../../helpers/p06-3-resource-fixture.ts';
import { git } from '../../helpers/git-repo.ts';

import { owner, sha256, budget, setup, facts, artifactFacts, artifactPath, jsonArtifact, runFake, checkIncrement, assertOriginalFiles } from '../../helpers/p06-7/knowledge-scenario.ts';

// Each case owns a fresh real database and repositories. No manual product SQL writes.
describe('P06-7 F-004 knowledge and restricted increment', () => {
  it('[case:p06-f004-query-readonly] searches by identity/version/Chinese keyword with bounded, project-scoped, verified read-only results', async () => {
    const f = await setup();
    try {
      const before = facts(f.binding);
      const artifactsBefore = artifactFacts(f.binding);
      const indexBefore = git(['diff', '--cached'], f.todo.todoRepositoryPath, { home: f.todo.homeDir });
      for (const input of [{ documentId: f.documentId }, { documentId: f.documentId, version: 1 }, { keyword: '受限修改目标' }]) {
        const result = await f.query.search(owner, f.binding.projectId, { ...input, limit: 1, snippetMaxChars: 120, maxReadBytes: 8192 });
        expect(result.projectId).toBe(f.binding.projectId);
        expect(result.results).toHaveLength(1);
        expect(result.results[0]).toMatchObject({ documentId: f.documentId, version: 1, contentHash: f.versionHash,
          contentRef: { projectId: f.binding.projectId }, sourceRefs: [], selectionReason: expect.any(String),
          sourceLocators: expect.any(Array), position: { line: expect.any(Number), column: expect.any(Number) } });
        expect(result.results[0]!.snippet.length).toBeLessThanOrEqual(120);
        expect(result.budget.bytesRead).toBeLessThanOrEqual(8192);
        const body = await f.query.read(owner, f.binding.projectId, f.documentId, 1);
        expect(body.contentText).toBe(readFileSync(join(f.todo.docsDir, 'architecture.md'), 'utf8'));
        const position = result.results[0]!.position;
        if ('keyword' in input) expect(body.contentText.slice(position.start, position.end)).toBe(input.keyword);
      }
      expect(facts(f.binding)).toBe(before);
      expect(artifactFacts(f.binding)).toEqual(artifactsBefore);
      expect(git(['diff', '--cached'], f.todo.todoRepositoryPath, { home: f.todo.homeDir })).toBe(indexBefore);
      expect(f.todo.compareDirtyBaseline(f.baseline)).toEqual({ matches: true, differences: [] });
    } finally { await f.close(); }
  }, 60_000);

  it('[case:p06-f004-attempt-increment] pins knowledge on a real Attempt, survives version/config/project changes, and verifies the actual Git increment', async () => {
    const f = await setup();
    try {
      const bound = f.binding.claimAndLaunch('t-1');
      const prepared = bound.inputSnapshot;
      const manifest = await jsonArtifact<ContextInputManifest>(f.binding, prepared.group.manifest.artifactId);
      const snapshot = await jsonArtifact<ContextInputSnapshot>(f.binding, prepared.group.snapshot.artifactId);
      expect(snapshot.knowledge?.[0]).toMatchObject({ projectId: f.binding.projectId, version: 1, sourceId: f.documentId,
        contentHash: f.versionHash, purpose: 'todo-guide', reason: 'approved Todo file scope', required: true,
        range: { start: expect.any(Number), end: expect.any(Number) } });
      expect(manifest.sources.filter(source => source.kind === 'knowledge')).toEqual([expect.objectContaining({
        version: 1, hash: f.versionHash, selection: expect.stringContaining('range['), required: true, reason: 'approved Todo file scope' })]);
      expect(manifest.knowledgeBudget).toMatchObject({ selectedSources: 1, omittedSources: 0, bytesRead: expect.any(Number) });
      const rowBefore = f.binding.query('SELECT input_snapshot, input_digest FROM attempts WHERE id = ?', bound.receipt.attempt.id);
      const groupBefore = await Promise.all(Object.values(prepared.group).map(ref => f.binding.verifier.readVerifiedContent(f.binding.projectId, ref.artifactId)));
      // Publish a NEW artifact/version without changing the source repository's docs.
      const body = 'Todo architecture version 2: a different instruction';
      const artifact = (await f.binding.publisher.publishArtifact({ projectId: f.binding.projectId, kind: 'knowledge-source',
        mediaType: 'text/plain', locator: 'f004/version-2', expectedHash: sha256(body), content: [Buffer.from(body)] })).artifact;
      await f.service.registerDocumentVersion(owner, f.binding.projectId, { title: 'Todo architecture', documentType: 'markdown', documentId: f.documentId, version: 2,
        source: { kind: 'artifact', artifactId: artifact.id }, sourceRefs: [{ artifactId: artifact.id, version: artifact.version, contentHash: artifact.contentHash }] });
      const settings = await f.binding.submit('settings.project.create', { schemaVersion: 2, strategies: { defaultStrategy: {
        runtime: 'fake', provider: 'test-provider', model: 'fake-model' } }, policies: { securityPolicy: { isolation: 'trusted_project' } } });
      expect(settings.status).toBe('completed');
      const other = await createSqliteStateStore(f.binding.session).createProject({ displayName: 'Other project' });
      expect((await f.query.search(owner, other.id, { documentId: f.documentId })).results).toEqual([]);
      expect(f.binding.query('SELECT input_snapshot, input_digest FROM attempts WHERE id = ?', bound.receipt.attempt.id)).toEqual(rowBefore);
      const binding = await f.binding.bindingService.bind(f.binding.bindingInput(bound));
      const inputText = Buffer.from((await binding.reader.read('snapshot')).content).toString('utf8');
      for (const sentinel of ['F004-IMPLICIT-INSTRUCTION', 'F004-GLOBAL-DOCUMENT', 'OpenViking', 'vector', 'global-helper']) expect(inputText).not.toContain(sentinel);
      await expect(binding.reader.read('global.md')).rejects.toMatchObject({ reason: 'unbound_input_read' });
      const before = readFileSync(f.todo.todoFilePath, 'utf8');
      const after = before.replace('TODO-3 在受限范围内修改本文件的待办事项', 'TODO-3 已完成受限增量修改');
      const run = await runFake(f, binding.request, binding.reader, [
        { op: 'read_input', purpose: 'snapshot' }, { op: 'read_input', purpose: 'manifest' },
        { op: 'write_file', path: 'inbox.txt', content: after },
      ]);
      expect(run.result.terminal).toBe('completed');
      expect(run.operations.filter(op => op.op === 'write_file')).toEqual([expect.objectContaining({ target: 'inbox.txt', outcome: 'ok', digest: sha256(after) })]);
      const check = await checkIncrement(f.todo, after);
      expect(check).toMatchObject({ exitCode: 0, signal: null, stopConfirmed: true });
      const diff = git(['diff', '--', 'todo/inbox.txt'], f.todo.todoRepositoryPath, { home: f.todo.homeDir });
      expect(diff).toContain('+TODO-3 已完成受限增量修改');
      expect(diff).toContain('-TODO-3 在受限范围内修改本文件的待办事项');
      expect(readFileSync(f.todo.todoFilePath, 'utf8')).toBe(after);
      assertOriginalFiles(f);
      expect(git(['status', '--porcelain=v1'], f.todo.todoRepositoryPath, { home: f.todo.homeDir }).split('\n').filter(Boolean).sort())
        .toEqual([...f.baseline.statusPorcelain.split('\n').filter(Boolean), ' M todo/inbox.txt'].sort());
      const groupAfter = await Promise.all(Object.values(prepared.group).map(ref => f.binding.verifier.readVerifiedContent(f.binding.projectId, ref.artifactId)));
      expect(groupAfter.map(g => sha256(g.content))).toEqual(groupBefore.map(g => sha256(g.content)));
      // Runtime completion alone does not accept a Task. Real input identity stays fixed.
      expect(f.binding.query('SELECT status FROM tasks WHERE id = ? AND feature_id = ?', 't-1', f.binding.featureId)).toEqual({ status: 'running' });
      const evidence = { scenarioId: 'P06-I03-I04', attemptId: bound.receipt.attempt.id,
        inputDigest: prepared.digests.snapshotDigest, manifestDigest: prepared.digests.manifestDigest,
        files: ['todo/inbox.txt'], diff, check: { ...check, argv: ['node', ...check.argv.slice(1)], nodeVersion: process.version }, operations: run.operations };
      const text = JSON.stringify(evidence);
      expect(text).not.toContain('/Users/');
      await f.binding.publisher.publishArtifact({ projectId: f.binding.projectId, kind: 'acceptance-evidence',
        mediaType: 'application/json', locator: 'f004/increment-evidence', expectedHash: sha256(text), content: [Buffer.from(text)] });
    } finally { await f.close(); }
  }, 60_000);

  it('[case:p06-f004-rejections] rejects ownership, forged scope, traversal, missing/corrupt bodies, budgets and unconfirmed resources without workspace mutations', async () => {
    const f = await setup();
    try {
      const other = await createSqliteStateStore(f.binding.session).createProject({ displayName: 'Other' });
      const before = facts(f.binding);
      const content = await f.query.read(owner, f.binding.projectId, f.documentId, 1);
      await expect(f.query.read(owner, other.id, f.documentId, 1)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(f.query.search(owner, f.binding.projectId, { projectId: other.id, documentId: f.documentId })).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(f.query.search(owner, f.binding.projectId, { path: '../docs/architecture.md' })).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(f.query.read(owner, f.binding.projectId, f.documentId, 1, { maxReadBytes: 1 })).rejects.toMatchObject({ details: { reason: 'budget_exceeded' } });
      const resolve = (requests: Record<string, unknown>[], customBudget = budget) => f.reader.resolve({
        projectId: f.binding.projectId, featureId: f.binding.featureId, taskId: 't-1', requests, budget: customBudget });
      const selected = { kind: 'document', documentId: f.documentId, version: 1, purpose: 'todo-guide', required: true };
      await expect(resolve([{ ...selected, projectId: other.id }])).rejects.toMatchObject({ details: { reason: 'ownership_denied' } });
      await expect(resolve([{ ...selected, documentId: 'missing-doc' }])).rejects.toMatchObject({ details: { reason: 'missing_required_input' } });
      await expect(resolve([selected], { ...budget, maxReadBytes: 1 })).rejects.toMatchObject({ details: { reason: 'limit_exceeded' } });
      const path = artifactPath(f.binding, content.contentRef.artifactId);
      const body = readFileSync(path);
      try {
        writeFileSync(path, 'corrupt');
        await expect(resolve([selected])).rejects.toMatchObject({ details: { reason: 'published_body_mismatch' } });
        await expect(f.query.read(owner, f.binding.projectId, f.documentId, 1)).rejects.toMatchObject({ code: 'corrupt_state' });
      } finally { writeFileSync(path, body); }
      renameSync(path, `${path}.held`);
      try { await expect(resolve([selected])).rejects.toMatchObject({ details: { reason: 'published_body_mismatch' } }); }
      finally { renameSync(`${path}.held`, path); }
      expect(facts(f.binding)).toBe(before);
      const resources = resourceFixture(f.binding.session, f.binding.projectId, f.todo.root);
      const candidate = await resources.request();
      expect(resources.service.snapshotForAttempt(owner, f.binding.projectId).resources).toEqual([]);
      await expect(resources.service.select(owner, f.binding.projectId, 0, { ...candidate, confirmed: false })).rejects.toMatchObject({ kind: 'validation' });
      expect(facts(f.binding)).toBe(before);
      expect(f.todo.compareDirtyBaseline(f.baseline)).toEqual({ matches: true, differences: [] });
    } finally { await f.close(); }
  }, 60_000);

  it('[case:p06-f004-failure-evidence] preserves partial increments and rejects symlink escapes; a failed real check cannot become success', async () => {
    const f = await setup();
    try {
      const bound = f.binding.claimAndLaunch('t-1');
      const binding = await f.binding.bindingService.bind(f.binding.bindingInput(bound));
      const before = readFileSync(f.todo.todoFilePath, 'utf8');
      const after = `${before}TODO-4 partial progress\n`;
      const partial = await runFake(f, binding.request, binding.reader, [
        { op: 'write_file', path: 'inbox.txt', content: after }, { op: 'fail', reason: 'increment_failed' }]);
      expect(partial.result).toMatchObject({ terminal: 'failed', reason: 'increment_failed' });
      expect(readFileSync(f.todo.todoFilePath, 'utf8')).toBe(after);
      expect(await checkIncrement(f.todo, 'wrong expected output')).toMatchObject({ exitCode: 7, stopConfirmed: true });
      expect((await f.todo.runCheck('failing')).exitCode).toBe(3);
      symlinkSync(f.todo.dirtyTrackedFile, join(f.todo.todoRepositoryPath, 'todo', 'escape.ts'));
      const escaped = await runFake(f, binding.request, binding.reader, [{ op: 'write_file', path: 'escape.ts', content: 'unauthorized' }]);
      expect(escaped.result).toMatchObject({ terminal: 'failed', reason: 'symlink_escape' });
      expect(() => createFakeRuntime({ script: { schemaVersion: 1, steps: [{ op: 'write_file', path: '../src/todo.ts', content: 'no' }] },
        workspaceRoots: { todo: join(f.todo.todoRepositoryPath, 'todo') }, providers: [] })).toThrowError(expect.objectContaining({ kind: 'validation' }));
      assertOriginalFiles(f);
      const evidence = JSON.stringify({ attemptId: bound.receipt.attempt.id, inputDigest: bound.inputSnapshot.digests.snapshotDigest,
        reason: partial.result.reason, partialDigest: sha256(after), verificationExitCode: 7, operations: escaped.operations });
      const published = await f.binding.publisher.publishArtifact({ projectId: f.binding.projectId, kind: 'acceptance-evidence',
        locator: 'f004/failed-increment', mediaType: 'application/json', expectedHash: sha256(evidence), content: [Buffer.from(evidence)] });
      expect(Buffer.from((await f.binding.verifier.readVerifiedContent(f.binding.projectId, published.artifact.id)).content).toString('utf8')).toBe(evidence);
    } finally { await f.close(); }
  }, 60_000);

  it('[case:p06-f004-snapshot-validation] preserves bounded knowledge fields and refuses malformed or cross-project input snapshots', async () => {
    const f = await setup();
    try {
      const bound = f.binding.claimAndLaunch('t-1');
      const prepared = bound.inputSnapshot;
      expect(validateAttemptInputSnapshot(prepared)).toMatchObject({ knowledge: prepared.knowledge, knowledgeBudget: prepared.knowledgeBudget });
      const selected = prepared.knowledge![0]!;
      const before = facts(f.binding);
      for (const invalid of [
        { ...prepared, schemaVersion: 4 },
        { ...prepared, knowledge: { selections: prepared.knowledge } },
        { ...prepared, knowledge: [{ ...selected, projectId: 'another-project' }] },
        { ...prepared, knowledge: [{ ...selected, contentRef: { ...selected.contentRef, projectId: 'another-project' } }] },
        { ...prepared, knowledge: [{ ...selected, range: { start: -1, end: 0 } }] },
        { ...prepared, knowledge: [{ ...selected, credential: 'not-allowed' }] },
        { ...prepared, knowledgeBudget: { ...prepared.knowledgeBudget, maxReadBytes: 0 } },
        { ...prepared, knowledgeBudget: { ...prepared.knowledgeBudget, arbitrary: true } },
      ]) expect(() => validateAttemptInputSnapshot(invalid)).toThrowError(expect.objectContaining({ kind: 'validation' }));
      expect(facts(f.binding)).toBe(before);
      expect(f.todo.compareDirtyBaseline(f.baseline)).toEqual({ matches: true, differences: [] });
    } finally { await f.close(); }
  }, 60_000);

  it('[case:p06-f004-drift-and-replay] replays prepare without writes, refuses changed command content, and keeps structured corrupt-Manifest binding evidence', async () => {
    const f = await setup();
    try {
      const payload = { featureId: f.binding.featureId, taskId: 't-1', items: [{ purpose: 'requirements', source: { kind: 'artifact', artifactId: f.binding.requirementArtifactId } }],
        knowledge: [{ kind: 'document', documentId: f.documentId, version: 1, purpose: 'todo-guide', required: true }] };
      const extra = { commandId: randomUUID() };
      const first = await f.binding.submit('execution.input.prepare', payload, extra);
      expect(first.status).toBe('completed');
      const before = facts(f.binding);
      const again = await f.binding.submit('execution.input.prepare', payload, extra);
      expect(again.replayed).toBe(true);
      if (again.status !== 'completed' || first.status !== 'completed') throw new Error('prepare did not complete');
      expect(again.result).toEqual(first.result);
      expect(facts(f.binding)).toBe(before);
      await expect(f.binding.submit('execution.input.prepare', { ...payload, knowledge: [] }, extra)).rejects.toMatchObject({ code: 'conflict' });
      expect(facts(f.binding)).toBe(before);
      const bound = f.binding.claimAndLaunch('t-1');
      const rowBefore = f.binding.query('SELECT input_snapshot, input_digest FROM attempts WHERE id = ?', bound.receipt.attempt.id);
      const path = artifactPath(f.binding, bound.inputSnapshot.group.manifest.artifactId);
      const bytes = readFileSync(path);
      try {
        writeFileSync(path, Buffer.concat([bytes, Buffer.from('digest drift')]));
        let reason: unknown;
        try { await f.binding.bindingService.bind(f.binding.bindingInput(bound)); throw new Error('expected rejection'); }
        catch (error) {
          expect(error).toMatchObject({ reason: 'input_corrupt', evidenceRef: expect.any(String) });
          const failure = error as { evidenceRef: string; reason: string };
          const evidence = await jsonArtifact<{ outcome: string; reason: string }>(f.binding, failure.evidenceRef);
          expect(evidence).toMatchObject({ outcome: 'rejected', reason: failure.reason });
          reason = failure.reason;
        }
        expect(reason).toBe('input_corrupt');
        expect(f.binding.query('SELECT input_snapshot, input_digest FROM attempts WHERE id = ?', bound.receipt.attempt.id)).toEqual(rowBefore);
        expect(f.todo.compareDirtyBaseline(f.baseline)).toEqual({ matches: true, differences: [] });
      } finally { writeFileSync(path, bytes); }
      // Reopen through a separate read connection: input is persisted, not a model statement.
      const reopened = openSqliteStorageSession({ path: f.binding.session.path });
      try { expect(reopened.database.prepare('SELECT input_snapshot, input_digest FROM attempts WHERE id = ?').get(bound.receipt.attempt.id)).toEqual(rowBefore); }
      finally { reopened.close(); }
    } finally { await f.close(); }
  }, 60_000);
});
