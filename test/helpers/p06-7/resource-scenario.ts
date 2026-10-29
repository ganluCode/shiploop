import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { assembleProjectResourceLoadManifest, buildRuntimeWorkAccessSnapshot, validateProjectResourceSelection,
  type ExecutionInputRef, type RuntimeExecutionRequest, type RuntimeRecoveryReference } from '../../../packages/core/src/index.ts';
import { PI_NATIVE_SESSION_FORMAT, PI_NATIVE_SESSION_FORMAT_VERSION, PI_SDK_VERSION,
  type PiRecoveryWriterLease, type PiTrustedAssembly } from '../../../packages/host/src/runtime/pi-adapter.ts';
import type { RuntimeWorkAccessSnapshot, ProjectResourceSelection, ProjectResourceLoadManifest } from '../../../packages/core/src/index.ts';
import { mcpWorkFixture } from '../p06-4/pi-mcp-fixture.ts';

type StageResourceFixture = Omit<Awaited<ReturnType<typeof mcpWorkFixture>>, 'selection' | 'manifest' | 'snapshot' | 'request'> & {
  selection: ProjectResourceSelection; manifest: ProjectResourceLoadManifest; snapshot: RuntimeWorkAccessSnapshot;
  request: RuntimeExecutionRequest; approved: { path: string; text: string; digest: string };
};

export const hashResourceEvidence = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function saveResourceEvidence(name: string, value: unknown) {
  const directory = process.env.SHIPLOOP_P06_F005_EVIDENCE_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  }
}

/** Real SDK loader, explicit resources and a real stdio server; never a model transport. */
export async function stageResourceFixture(): Promise<StageResourceFixture> {
  const f = await mcpWorkFixture({ server: { spawnChild: true, discoveryFile: 'tools.json' } });
  try {
    writeFileSync(join(f.box.path, 'tools.json'), JSON.stringify(['echo', 'unselected'].map(name => ({
      name, inputSchema: { type: 'object', properties: {} },
    }))));
    const skill = (directory: string, name: string) => {
      mkdirSync(directory, { recursive: true });
      const path = join(directory, 'SKILL.md');
      const text = `---\nname: ${name}\ndescription: Offline stage ${name}\n---\nUse the restricted Work tool channel for task.read.\n`;
      writeFileSync(path, text);
      return { path, text, digest: hashResourceEvidence(text) };
    };
    const approved = skill(join(f.box.path, 'approved'), 'approved-stage-skill');
    skill(join(f.box.path, 'skills/global'), 'unselected-global');
    skill(join(f.box.path, '.pi/skills/project'), 'unselected-project');
    const selection = validateProjectResourceSelection({ schemaVersion: 1, projectId: f.request.projectId, revision: 1,
      resources: [...f.selection.resources, { projectId: f.request.projectId, sourceProjectId: f.request.projectId,
        kind: 'skill', name: 'approved-stage-skill', sourceRef: '44444444-4444-4444-8444-444444444444', sourceRevision: 'skill-r1',
        version: '1.0.0', contentDigest: approved.digest, transport: null, capabilities: ['resource_selection'],
        credentialRef: null, required: true, onUnavailable: 'reject' }],
      operations: ['task.read'], allowGlobalScan: false, allowProjectDirectoryScan: false, allowSdkDefaultScan: false });
    const manifest = assembleProjectResourceLoadManifest(selection, selection.resources.map(resource => ({ ...resource,
      status: 'available', unavailableReason: null, loadedCapabilities: resource.capabilities })));
    const snapshot = buildRuntimeWorkAccessSnapshot({ selection, loadManifest: manifest, projectId: f.request.projectId,
      runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', invocationId: f.request.invocationId,
      executionVersion: f.request.executionVersion, owner: f.request.owner, strategy: { ...f.request.strategy, runtime: 'pi' },
      permissions: f.request.permissions, grantId: 'grant-1', policyDigest: 'b'.repeat(64), authentication: f.snapshot.authentication });
    const loader = new DefaultResourceLoader({ cwd: f.box.path, agentDir: f.box.path, settingsManager: f.settings,
      noSkills: true, noExtensions: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
      additionalSkillPaths: [approved.path], systemPrompt: '' });
    await loader.reload();
    const assembly: PiTrustedAssembly = { ...f.assembly, resourceLoader: loader,
      prepareAccess: async request => ({ snapshot: request.workAccess!, credentialRef: { kind: 'trusted-resolution', id: 'offline' },
        resourceLoader: loader, resourceManifest: manifest, resourceLoadPolicy: {
          selectedResourceIds: selection.resources.map(resource => resource.id),
          allowGlobalScan: false, allowProjectDirectoryScan: false, allowSdkDefaultScan: false } }) };
    return { ...f, selection, manifest, snapshot, loader, assembly, approved,
      request: { ...f.request, workAccess: snapshot } };
  } catch (error) { await f.cleanup(); throw error; }
}

/** The trusted fixture supplies verified artifacts and a single-writer lease, never historical tool authority. */
export function resourceRecoveryLease(old: { request: RuntimeExecutionRequest; archive: Buffer; nativeId: string; stop: Buffer },
  request: RuntimeExecutionRequest): { source: RuntimeRecoveryReference; lease: PiRecoveryWriterLease } {
  const artifact = (id: string, bytes: Buffer, mediaType: string): ExecutionInputRef => ({ projectId: request.projectId,
    artifactId: id, kind: 'execution-input', purpose: 'recovery', version: 1, contentHash: hashResourceEvidence(bytes),
    sizeBytes: bytes.length, locator: `sessions/${id}`, mediaType, origin: { kind: 'artifact' } });
  const archive = artifact('stage-native', old.archive, 'application/x-ndjson');
  const stop = artifact('stage-stop', old.stop, 'application/json');
  const source: RuntimeRecoveryReference = { schemaVersion: 1, purpose: 'work', kind: 'conversation',
    sourceProjectId: old.request.projectId, sourceSessionId: old.request.sessionId, sourceTaskId: 'task-1',
    sourceAttemptId: old.request.identity.purpose === 'work' ? old.request.identity.attemptId : '',
    runtime: 'pi', provider: old.request.strategy.provider, model: old.request.strategy.model, providerSessionId: old.nativeId,
    nativeArchiveRef: archive.artifactId, sourceDigest: archive.contentHash,
    nativeFormat: PI_NATIVE_SESSION_FORMAT, nativeFormatVersion: PI_NATIVE_SESSION_FORMAT_VERSION };
  const lease: PiRecoveryWriterLease = {
    source: { reference: source, archive, sdkVersion: PI_SDK_VERSION, previousWriter: { status: 'confirmed', stopEvidence: stop } },
    sourceReadOnly: true, authority: { projectId: request.projectId, featureId: request.featureId, taskId: 'task-1', taskStatus: 'unfinished',
      previousAttemptId: source.sourceAttemptId!, previousSessionId: old.request.sessionId },
    writer: { purpose: 'work', attemptId: request.workAccess!.attemptId, invocationId: request.invocationId,
      sessionId: request.sessionId, executionVersion: request.executionVersion, owner: request.owner, exclusive: true },
    assertCurrent: async () => {}, release: async () => {},
    readVerifiedArtifact: async ref => ref.artifactId === archive.artifactId ? old.archive : old.stop,
  };
  return { source, lease };
}
