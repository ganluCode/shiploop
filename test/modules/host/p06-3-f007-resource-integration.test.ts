import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { startHost, connectToHost, createWorkToolClient } from '../../../packages/host/src/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createLocalOwnerPrincipal } from '../../../packages/core/src/ports/authorization.ts';
import {
  assembleProjectResourceLoadManifest,
  buildProjectResourceLoadPlan,
  toWorkAccessConfiguration,
} from '../../../packages/core/src/ports/project-resources.ts';
import type { WorkAccessBinding } from '../../../packages/core/src/ports/work-access.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createBaselineFixture } from '../../helpers/p02-3/index.ts';
import { resourceManifest } from '../../helpers/p06-3-resource-fixture.ts';
import { openWorkToolFixture } from '../../helpers/host/work-tool-fixture.ts';
import { withKnowledgeHost } from '../../helpers/host/knowledge-fixture.ts';

const owner = createLocalOwnerPrincipal();
const catalog = createStaticRuntimeCapabilityCatalog([]);

async function openResourceHost(prefix: string) {
  const box = createBaselineFixture({ prefix });
  const root = box.dataRoot();
  const host = await startHost({ dataRoot: root, capabilityCatalog: catalog, env: {} });
  const client = await connectToHost({ canonicalRoot: root });
  const project = await host.core.stateStore.createProject({ displayName: 'Resource integration' });
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const sourceId = randomUUID();
  const manifestPath = join(projectRoot, 'resources.json');
  writeFileSync(manifestPath, JSON.stringify(resourceManifest('1.0.0', 'approved-skill')));
  return { box, root, host, client, project, projectRoot, sourceId, manifestPath };
}

describe('P06-3 F-007 project resource vertical integration', () => {
  it('[case:host-discover-preview-import-load-revoke] 从真实 Host/SQLite 导入到新 Attempt 资源快照，未选资源不进入 SDK', async () => {
    const f = await openResourceHost('shiploop-p063-f007-vertical-');
    try {
      const registered = await f.client.configureProjectResourceSource({
        projectId: f.project.id, sourceId: f.sourceId, manifestPath: f.manifestPath,
        expectedRevision: 0, action: 'register',
      });
      expect(registered).toMatchObject({ registered: true, revision: 1, sourceId: f.sourceId });

      const discovered = await f.client.discoverProjectResourceCandidates(f.project.id, [f.sourceId]);
      const candidate = discovered.candidates[0];
      const source = discovered.sources.find(item => item.sourceId === f.sourceId);
      expect(candidate).toBeDefined();
      expect(source?.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
      const preview = await f.client.previewProjectResourceCandidates(f.project.id, [f.sourceId]);
      expect(preview.entries).toEqual([expect.objectContaining({ candidateId: candidate!.id, status: 'pending' })]);
      expect((await f.client.previewProjectResourceCandidates(f.project.id, [f.sourceId], [candidate!.id])).entries)
        .toEqual([expect.objectContaining({ candidateId: candidate!.id, status: 'selected', reason: 'already_selected' })]);

      const imported = await f.client.importProjectResource({
        projectId: f.project.id, sourceId: f.sourceId, sourceDigest: source!.sourceDigest!,
        candidateId: candidate!.id, candidateDigest: candidate!.digest, expectedRevision: 0,
      });
      expect(imported).toMatchObject({ status: 'completed', result: { configuration: { revision: 1 } } });
      const duplicate = await f.client.importProjectResource({
        projectId: f.project.id, sourceId: f.sourceId, sourceDigest: source!.sourceDigest!,
        candidateId: candidate!.id, candidateDigest: candidate!.digest, expectedRevision: 1,
      });
      expect(duplicate).toMatchObject({ status: 'completed', result: { configuration: { revision: 1 } } });
      expect((await f.client.listProjectResources(f.project.id)).resources).toHaveLength(1);

      const selection = f.host.core.projectResourceService.snapshotForAttempt(owner, f.project.id);
      expect(selection).toMatchObject({ projectId: f.project.id, revision: 1, resources: [{ id: candidate!.id, name: 'approved-skill' }] });
      expect(selection.allowGlobalScan).toBe(false);
      expect(selection.allowProjectDirectoryScan).toBe(false);
      expect(selection.allowSdkDefaultScan).toBe(false);
      expect(buildProjectResourceLoadPlan(selection)).toMatchObject({ selectedResourceIds: [candidate!.id], resources: [{ id: candidate!.id }] });

      const approvedSkillPath = join(f.projectRoot, 'approved', 'SKILL.md');
      const globalSkillPath = join(f.root, 'global', 'SKILL.md');
      mkdirSync(join(f.projectRoot, 'approved'), { recursive: true });
      mkdirSync(join(f.root, 'global'), { recursive: true });
      writeFileSync(approvedSkillPath, '---\nname: approved-skill\ndescription: approved fixture\n---\nApproved only.\n');
      writeFileSync(globalSkillPath, '---\nname: global-skill\ndescription: must not load\n---\nGlobal must not load.\n');
      const loader = new DefaultResourceLoader({ cwd: f.projectRoot, agentDir: f.root, settingsManager: SettingsManager.inMemory(),
        noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalSkillPaths: [approvedSkillPath], systemPrompt: '', appendSystemPrompt: [], });
      await loader.reload();
      expect(loader.getSkills().skills.map(skill => skill.name)).toEqual(['approved-skill']);
      expect(loader.getSkills().skills.some(skill => skill.name === 'global-skill')).toBe(false);

      const loadManifest = assembleProjectResourceLoadManifest(selection, selection.resources.map(resource => ({
        ...resource, status: 'available' as const, unavailableReason: null, loadedCapabilities: [...resource.capabilities],
      })));
      expect(loadManifest).toMatchObject({ state: 'loaded', projectId: f.project.id, selectionRevision: 1,
        resources: [{ id: candidate!.id, version: '1.0.0', contentDigest: candidate!.contentDigest, status: 'available', transport: null }], gaps: [] });
      const binding: WorkAccessBinding = {
        principal: owner, projectId: f.project.id, hostInstanceId: f.host.hostInstanceId,
        identity: { purpose: 'work', runId: 'run-f007', taskId: 'task-f007', attemptId: 'attempt-f007' },
        invocationId: 'invocation-f007', executionVersion: 1, nowUtcMs: 2_000,
        strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
      };
      const access = toWorkAccessConfiguration(selection, { binding, grantId: randomUUID(), issuedAtUtcMs: 1_000, expiresAtUtcMs: 3_000 });
      expect(access.resources).toEqual([expect.objectContaining({ id: candidate!.id, version: '1.0.0', capabilities: ['resource_selection'], transport: null })]);

      const oldSnapshotDigest = selection.digest;
      const revoked = await f.client.revokeProjectResource({ projectId: f.project.id, resourceId: candidate!.id, expectedRevision: 1 });
      expect(revoked).toMatchObject({ status: 'completed', result: { configuration: { revision: 2, resources: [{ status: 'revoked', enabled: false }] } } });
      expect(selection.digest).toBe(oldSnapshotDigest);
      expect(f.host.core.projectResourceService.snapshotForAttempt(owner, f.project.id).resources).toHaveLength(0);
      expect(buildProjectResourceLoadPlan(f.host.core.projectResourceService.snapshotForAttempt(owner, f.project.id)).selectedResourceIds).toEqual([]);
    } finally {
      f.client.close();
      await f.host.close();
      await f.box.dispose();
    }
  });

  it('[case:sqlite-cas-and-rollback] 真实 SQLite 的导入失败回滚和同 revision 竞争不产生第二条授权事实', async () => {
    const f = await openResourceHost('shiploop-p063-f007-cas-');
    const probe = openSqliteStorageSession({ path: f.host.core.pathService.databaseFilePath() });
    try {
      await f.client.configureProjectResourceSource({ projectId: f.project.id, sourceId: f.sourceId, manifestPath: f.manifestPath,
        expectedRevision: 0, action: 'register' });
      const discovered = await f.client.discoverProjectResourceCandidates(f.project.id, [f.sourceId]);
      const candidate = discovered.candidates[0]!;
      const source = discovered.sources[0]!;
      probe.database.exec("CREATE TRIGGER f007_resource_rollback BEFORE INSERT ON state_events BEGIN SELECT RAISE(ABORT, 'f007 audit fault'); END");
      await expect(f.client.importProjectResource({ projectId: f.project.id, sourceId: f.sourceId, sourceDigest: source.sourceDigest!,
        candidateId: candidate.id, candidateDigest: candidate.digest, expectedRevision: 0 })).rejects.toBeDefined();
      expect((await f.client.listProjectResources(f.project.id)).revision).toBe(0);
      expect((await f.client.listProjectResources(f.project.id)).resources).toEqual([]);
      probe.database.exec('DROP TRIGGER f007_resource_rollback');

      const attempts = await Promise.all([0, 1].map(() => f.client.importProjectResource({
        projectId: f.project.id, sourceId: f.sourceId, sourceDigest: source.sourceDigest!,
        candidateId: candidate.id, candidateDigest: candidate.digest, expectedRevision: 0,
      })));
      expect(attempts.filter(result => result.status === 'completed')).toHaveLength(1);
      expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(attempts.find(result => result.status === 'rejected')).toMatchObject({ error: { code: 'conflict' } });
      expect((await f.client.listProjectResources(f.project.id)).resources).toHaveLength(1);
      expect((await f.client.listProjectResources(f.project.id)).revision).toBe(1);
      const rows = probe.database.prepare('SELECT project_id, revision, payload FROM project_settings WHERE project_id=?').all(f.project.id) as { project_id: string; revision: number; payload: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ project_id: f.project.id, revision: 1 });
      expect(JSON.parse(rows[0]!.payload).projectResources.resources).toHaveLength(1);
    } finally {
      probe.close();
      f.client.close();
      await f.host.close();
      await f.box.dispose();
    }
  });

  it('[case:restricted-channel-and-owner-fallback] 受限 Work 仅能执行公开操作，恶意数据/越权和 owner 回退均保持 SQLite 不变', async () => {
    const f = await openWorkToolFixture({ restrictedPrincipal: true });
    try {
      const task = await f.bridge.invoke(f.request('task.read'));
      expect(task).toMatchObject({ operation: 'task.read', task: { id: f.binding.identity.taskId } });
      const evidence = await f.publish({ evidence: 'controlled evidence' });
      expect(await f.bridge.invoke(f.request('evidence.submit', { artifactId: evidence }))).toMatchObject({ status: 'completed', result: { verificationPassed: false } });
      const before = f.snapshot();
      for (const request of [
        f.request('task.pass'),
        f.request('task.read', { path: '/private/secret', sql: 'UPDATE tasks SET status=\'passed\'' }),
        { ...f.request('task.read'), scope: { kind: 'project', projectId: randomUUID() } },
      ]) await expect(f.bridge.invoke(request)).rejects.toBeDefined();
      f.setCurrent({ ...f.binding, principal: createLocalOwnerPrincipal() });
      await expect(f.bridge.invoke(f.request('task.read'))).rejects.toBeDefined();
      expect(f.snapshot()).toEqual(before);
    } finally { f.close(); }

    await withKnowledgeHost(async knowledge => {
      const restricted = { principalId: 'knowledge-agent', capabilities: new Set(['project.read' as const]),
        projectScope: { kind: 'allowlist' as const, projectIds: [knowledge.projectId] } };
      const scoped = await knowledge.scoped(restricted);
      try {
        const result = await scoped.client.searchKnowledge(knowledge.projectId, { keyword: 'needle', limit: 5 });
        expect(result).toMatchObject({ projectId: knowledge.projectId, results: [expect.objectContaining({ title: 'Guide' })] });
        await expect(scoped.client.searchKnowledge(knowledge.otherProjectId, { keyword: 'needle', limit: 5 })).rejects.toBeDefined();
      } finally { /* withKnowledgeHost closes the scoped transport with its server fixture. */ }
    });
  });
});
