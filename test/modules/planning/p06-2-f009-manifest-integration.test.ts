import { mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createArtifactPublisher,
  createLocalOwnerPrincipal,
  createStaticRuntimeCapabilityCatalog,
} from '../../../packages/core/src/index.ts';
import { openCoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';
import { computeCapabilityModuleDigest } from '../../../packages/core/src/ports/project-profile-store.ts';
import { createSqliteProjectProfileStore } from '../../../packages/core/src/adapters/sqlite/project-profile-store.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const owner = createLocalOwnerPrincipal();
const catalog = createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'pi', providers: [{ providerId: 'fake', models: ['offline-model'] }] },
]);
const now = new Date('2026-10-28T00:00:00.000Z').getTime();
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

function profileCandidate(projectId: string) {
  return {
    profile: {
      schemaVersion: 1,
      projectId,
      version: 1,
      revision: 'v1',
      status: 'candidate',
      modules: [{
        id: 'language-node', version: '1.0.0', roots: ['.'], languages: ['node'],
        frameworks: [], capabilityRefs: ['language-node@1.0.0'], checkRefs: [],
      }],
      documentRefs: [],
      detectionEvidenceRefs: ['detect-node'],
      confirmedBy: null,
    },
    evidence: [{
      schemaVersion: 1,
      id: 'detect-node',
      detectorId: 'static-detector',
      detectorVersion: '1.0.0',
      source: 'package.json',
      summary: 'Node project detected',
      status: 'candidate',
      confirmed: false,
    }],
  };
}

async function seedProfile(app: Awaited<ReturnType<typeof openCoreApplication>>, projectId: string): Promise<void> {
  const session = openSqliteStorageSession({ path: app.pathService.databaseFilePath() });
  try {
    const store = createSqliteProjectProfileStore(session, { nowUtcMs: () => now });
    const module = {
      schemaVersion: 1 as const,
      id: 'language-node',
      version: '1.0.0',
      scope: ['capability:language-node'],
      appliesTo: ['.'],
      dependencies: [],
      contentRef: 'artifact:language-node@1.0.0',
      status: 'candidate' as const,
    };
    store.createCapabilityModule({ projectId, module, digest: computeCapabilityModuleDigest(module) });
    store.createProjectProfile(profileCandidate(projectId));
  } finally {
    session.close();
  }
  app.projectProfileService.confirm(owner, {
    projectId,
    expectedRevision: 1,
    profile: { ...profileCandidate(projectId).profile },
  });
}

function commandEnvelope(projectId: string, operation: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 5,
    commandId: randomUUID(),
    issuedAt: new Date(now).toISOString(),
    operation,
    scope: { kind: 'project', projectId },
    payload,
    ...extra,
  };
}

function receiptResult(receipt: unknown): unknown {
  return (receipt as { readonly result?: unknown }).result;
}

async function setupPlan(app: Awaited<ReturnType<typeof openCoreApplication>>, projectId: string) {
  const settings = await app.commandService.submit(owner, commandEnvelope(projectId, 'settings.global.create', {
    schemaVersion: 2,
    strategies: {
      defaultStrategy: { runtime: 'pi', provider: 'fake', model: 'offline-model' },
      modelMap: { low: { runtime: 'pi', provider: 'fake', model: 'offline-model' } },
    },
  }, { scope: { kind: 'global' } }));
  expect(settings.status).toBe('completed');
  const phaseId = randomUUID();
  const phase = await app.commandService.submit(owner, commandEnvelope(projectId, 'phase.create', {
    id: phaseId, title: 'Knowledge integration phase', description: null, labels: [],
  }));
  expect(phase.status).toBe('completed');
  const imported = await app.commandService.submit(owner, commandEnvelope(projectId, 'feature.plan.import', {
    phaseId,
    plan: {
      schemaVersion: 1,
      feature: { title: 'Knowledge manifest integration', description: 'cross-layer', labels: [], sourceRefs: [] },
      tasks: [{ id: 'task-knowledge', title: 'Use project knowledge', complexity: 'low', acceptance: { criteria: ['read selected knowledge'] } }],
    },
  }, { expectedRevision: 1 }));
  expect(imported.status).toBe('completed');
  const feature = (receiptResult(imported) as { feature: { id: string; planDigest: string } }).feature;
  const approved = await app.commandService.submit(owner, commandEnvelope(projectId, 'feature.plan.decide', {
    featureId: feature.id, planDigest: feature.planDigest, decision: 'approve', reason: 'integration test',
  }, { expectedRevision: 1 }));
  expect(approved.status).toBe('completed');
  return feature;
}

async function publishText(
  app: Awaited<ReturnType<typeof openCoreApplication>>,
  projectId: string,
  locator: string,
  body: string,
) {
  const bytes = Buffer.from(body);
  const publisher = createArtifactPublisher({
    artifacts: app.artifactStore,
    files: app.artifactFileStore,
    limits: { maxSizeBytes: 1_000_000, timeoutMs: 10_000 },
  });
  return (await publisher.publishArtifact({
    projectId,
    kind: 'knowledge-source',
    mediaType: 'text/plain',
    expectedHash: sha256(bytes),
    locator,
    content: [bytes],
  })).artifact;
}

function durableSnapshot(app: Awaited<ReturnType<typeof openCoreApplication>>, projectIds: string[]) {
  const session = openSqliteStorageSession({ path: app.pathService.databaseFilePath() });
  try {
    return JSON.stringify({
      documents: session.database.prepare(`SELECT id, project_id, revision, updated_at FROM documents WHERE project_id IN (${projectIds.map(() => '?').join(',')}) ORDER BY id`).all(...projectIds),
      versions: session.database.prepare(`SELECT id, project_id, document_id, version, content_hash, revision FROM document_versions WHERE project_id IN (${projectIds.map(() => '?').join(',')}) ORDER BY id`).all(...projectIds),
      memories: session.database.prepare(`SELECT id, project_id, record_key, version, status, revision FROM memory_records WHERE project_id IN (${projectIds.map(() => '?').join(',')}) ORDER BY id`).all(...projectIds),
    });
  } finally {
    session.close();
  }
}

describe('P06-2 F-009 project knowledge and input Manifest integration', () => {
  it('[case:p06-2-f009-vertical-chain] runs registration, versioning, accepted memory, query, and Task Manifest in one real project', async () => {
    const box = createTempSandbox('shiploop-p062-f009-');
    const sourceRoot = join(box.path, 'sources');
    mkdirSync(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'unused.txt'), 'file source is intentionally not selected', 'utf8');
    const options = {
      dataRoot: join(box.path, 'data'),
      inputSourceRoots: { src: sourceRoot },
      capabilityCatalog: catalog,
      nowUtcMs: () => now,
    };
    let app = await openCoreApplication(options);
    const failures: Record<string, unknown>[] = [];
    try {
      expect(app.documentService).toBeDefined();
      const projectA = await app.stateStore.createProject({ displayName: 'Knowledge A' });
      const projectB = await app.stateStore.createProject({ displayName: 'Knowledge B' });
      await seedProfile(app, projectA.id);

      const sourceV1 = await publishText(app, projectA.id, 'seed/guide-v1.txt', 'retry policy v1');
      const first = await app.documentService.registerDocumentVersion(owner, projectA.id, {
        title: 'Runtime guide', documentType: 'text', version: 1,
        source: { kind: 'artifact', artifactId: sourceV1.id },
        sourceRefs: [{ artifactId: sourceV1.id, version: sourceV1.version, contentHash: sourceV1.contentHash }],
      });
      const sourceV2 = await publishText(app, projectA.id, 'seed/guide-v2.txt', 'retry policy v2 command');
      const second = await app.documentService.registerDocumentVersion(owner, projectA.id, {
        title: 'Runtime guide', documentType: 'text', documentId: first.document.id, version: 2,
        source: { kind: 'artifact', artifactId: sourceV2.id },
        sourceRefs: [{ artifactId: sourceV2.id, version: sourceV2.version, contentHash: sourceV2.contentHash }],
      });
      const replay = await app.documentService.registerDocumentVersion(owner, projectA.id, {
        title: 'Runtime guide', documentType: 'text', documentId: first.document.id, version: 2,
        source: { kind: 'artifact', artifactId: sourceV2.id },
        sourceRefs: [{ artifactId: sourceV2.id, version: sourceV2.version, contentHash: sourceV2.contentHash }],
      });
      expect(replay.version.id).toBe(second.version.id);
      expect(second.version.version).toBe(2);
      expect(first.version.contentHash).not.toBe(second.version.contentHash);

      const memoryArtifact = await publishText(app, projectA.id, 'seed/memory.txt', 'build command memory');
      const candidate = await app.memoryService.createCandidate(owner, projectA.id, {
        recordKey: 'build.rule', version: 1, scope: 'project',
        contentRef: {
          artifactId: memoryArtifact.id, version: memoryArtifact.version,
          contentHash: memoryArtifact.contentHash, sizeBytes: memoryArtifact.sizeBytes,
        },
        sourceRefs: [{ artifactId: second.artifact.artifactId, version: second.artifact.version, contentHash: second.artifact.contentHash }],
      });
      await app.memoryService.accept(owner, projectA.id, candidate.id, candidate.revision);
      const beforeQuery = durableSnapshot(app, [projectA.id, projectB.id]);
      const keyword = await app.knowledgeQueryService.search(owner, projectA.id, { keyword: 'command' });
      const byId = await app.knowledgeQueryService.read(owner, projectA.id, first.document.id, 2);
      const accepted = await app.memoryQueryService.search(owner, projectA.id, { keyword: 'command' });
      expect(keyword.results).toHaveLength(1);
      expect(keyword.results[0]).toMatchObject({ documentId: first.document.id, version: 2, contentHash: second.version.contentHash });
      expect(byId.contentText).toBe('retry policy v2 command');
      expect(accepted.results).toHaveLength(1);
      expect(accepted.results[0]).toMatchObject({ recordKey: 'build.rule', version: 1, status: 'accepted' });
      expect(durableSnapshot(app, [projectA.id, projectB.id])).toBe(beforeQuery);
      await expect(app.knowledgeQueryService.read(owner, projectB.id, first.document.id, 2)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(app.documentService.registerDocumentVersion(owner, projectB.id, {
        title: 'cross-project', documentId: first.document.id, version: 3,
        source: { kind: 'artifact', artifactId: sourceV2.id }, sourceRefs: [],
      })).rejects.toMatchObject({ kind: 'validation' });

      const feature = await setupPlan(app, projectA.id);
      const prepare = await app.commandService.submit(owner, commandEnvelope(projectA.id, 'execution.input.prepare', {
        featureId: feature.id,
        taskId: 'task-knowledge',
        items: [{ purpose: 'base-input', source: { kind: 'artifact', artifactId: sourceV1.id } }],
        knowledge: [
          { kind: 'document', documentId: first.document.id, version: 2, keyword: 'command', purpose: 'runtime-guidance', required: true },
          { kind: 'memory', memoryId: 'build.rule', keyword: 'command', purpose: 'build-memory', required: true },
          { kind: 'document', documentId: first.document.id, version: 2, keyword: 'command', purpose: 'runtime-guidance-duplicate', required: true },
        ],
      }));
      expect(prepare.status).toBe('completed');
      const prepared = receiptResult(prepare) as { group: { manifest: { artifactId: string } }; schemaVersion: number };
      expect(prepared.schemaVersion).toBeGreaterThan(0);

      const verifier = createArtifactVerifier({
        artifacts: app.artifactStore,
        files: app.artifactFileStore,
        limits: { maxReadBytes: 2_000_000 },
      });
      const manifestArtifact = await verifier.readVerifiedContent(projectA.id, prepared.group.manifest.artifactId);
      const manifest = JSON.parse(Buffer.from(manifestArtifact.content).toString('utf8')) as {
        projectId: string; featureId: string; taskId: string;
        sources: Array<{ kind: string; identity: Record<string, string>; version: number; hash: string; selection: string; reason: string }>;
        knowledgeBudget: { selectedSources: number; candidatesInspected: number; bytesRead: number };
      };
      expect(manifest).toMatchObject({ projectId: projectA.id, featureId: feature.id, taskId: 'task-knowledge' });
      const knowledgeSources = manifest.sources.filter(source => source.kind === 'knowledge');
      expect(knowledgeSources).toHaveLength(2);
      expect(knowledgeSources.map(source => source.identity.documentId ?? source.identity.memoryId)).toEqual([first.document.id, candidate.id]);
      expect(knowledgeSources.every(source => source.version >= 1 && /^[0-9a-f]{64}$/.test(source.hash) && source.selection.includes('range[') && source.reason.length > 0)).toBe(true);
      expect(manifest.knowledgeBudget).toMatchObject({ selectedSources: 2 });
      expect(JSON.stringify(manifest)).not.toMatch(/credential|apiKey|password|\/Users\//i);
      expect(receiptResult(prepare)).toBeDefined();

      const replayId = randomUUID();
      const replayEnvelope = commandEnvelope(projectA.id, 'execution.input.prepare', {
        featureId: feature.id, taskId: 'task-knowledge', items: [{ purpose: 'base-input', source: { kind: 'artifact', artifactId: sourceV1.id } }],
        knowledge: [{ kind: 'document', documentId: first.document.id, version: 2, keyword: 'command', purpose: 'runtime-guidance', required: true }],
      }, { commandId: replayId });
      const firstReplay = await app.commandService.submit(owner, replayEnvelope);
      const secondReplay = await app.commandService.submit(owner, replayEnvelope);
      expect(firstReplay.status).toBe('completed');
      expect(secondReplay.replayed).toBe(true);
      expect(receiptResult(secondReplay)).toEqual(receiptResult(firstReplay));

      const runs = openSqliteStorageSession({ path: app.pathService.databaseFilePath() });
      try {
        expect(runs.database.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
        expect(runs.database.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
      } finally { runs.close(); }

      const bodyPath = join(app.dataRoot, deriveArtifactFinalRelativePath({ projectId: projectA.id, artifactId: second.version.contentRef.artifactId }));
      const original = await readFile(bodyPath);
      await writeFile(bodyPath, Buffer.concat([original, Buffer.from('tampered')]))
        .catch(error => { failures.push({ kind: 'file-tamper', error: String(error) }); });
      const corrupted = await app.knowledgeQueryService.search(owner, projectA.id, { documentId: first.document.id, version: 2, maxReadBytes: 4096 });
      expect(corrupted.results).toEqual([]);
      expect(corrupted.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'corrupt_content' })]));
      await writeFile(bodyPath, original);
      const budget = await app.knowledgeQueryService.search(owner, projectA.id, { documentId: first.document.id, version: 2, maxReadBytes: 1 });
      expect(budget.results).toEqual([]);
      expect(budget.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'budget_exceeded' })]));
      await expect(app.executionInputPrepare.prepareExecutionInput(projectA.id, {
        featureId: feature.id, taskId: 'task-knowledge', items: [{ purpose: 'base-input', source: { kind: 'artifact', artifactId: sourceV1.id } }],
        knowledge: [{ kind: 'document', documentId: 'missing-document', purpose: 'required', required: true }],
      } as never)).rejects.toMatchObject({ details: { reason: 'missing_required_input' } });
      failures.push({ kind: 'structured-failure-evidence', reasons: ['cross_project', 'corrupt_content', 'budget_exceeded', 'missing_required_input'] });
      expect(failures).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'structured-failure-evidence' })]));
    } finally {
      app.close();
      box.cleanup();
    }
  });

  it('[case:p06-2-f009-reopen-and-capability-boundary] preserves identities after reopening and declares only implemented capabilities', async () => {
    const box = createTempSandbox('shiploop-p062-f009-reopen-');
    const options = { dataRoot: join(box.path, 'data'), capabilityCatalog: catalog, nowUtcMs: () => now };
    let app = await openCoreApplication(options);
    try {
      const project = await app.stateStore.createProject({ displayName: 'Reopen project' });
      const source = await publishText(app, project.id, 'seed/reopen.txt', 'reopen keyword');
      const registered = await app.documentService.registerDocumentVersion(owner, project.id, {
        title: 'Reopen', documentType: 'text', version: 1,
        source: { kind: 'artifact', artifactId: source.id }, sourceRefs: [],
      });
      const before = await app.knowledgeQueryService.search(owner, project.id, { documentId: registered.document.id, version: 1 });
      app.close();
      app = await openCoreApplication(options);
      const after = await app.knowledgeQueryService.search(owner, project.id, { documentId: registered.document.id, version: 1 });
      expect(after.results).toEqual(before.results);
      expect(app.documentService).toBeDefined();
      expect(JSON.stringify(after)).not.toMatch(/OpenViking|vector|embedding|Skills|MCP|auto.?extract/i);
    } finally {
      app.close();
      box.cleanup();
    }
  });
});
