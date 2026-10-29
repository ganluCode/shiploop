import { join } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { assembleProjectResourceLoadManifest, buildRuntimeWorkAccessSnapshot, PROJECT_RESOURCE_PUBLIC_OPERATIONS, validateProjectResourceSelection } from '../../../packages/core/src/index.ts';
import { createPiRuntimeAdapter, type PiTrustedAssembly, type PiSessionFactory } from '../../../packages/host/src/runtime/pi-adapter.ts';
import { createMcpStdioProcessRegistry, type McpStdioProcessRegistration } from '../../../packages/host/src/runtime/mcp-stdio.ts';
import { createTempSandbox } from '../temp-sandbox.ts';
import { piRequest } from '../p04-1/pi-adapter-fixture.ts';
import { createFakeMcpServerCommand, type FakeMcpServerOptions } from '../mcp-stdio-fake-server.ts';
import { processRows, until } from '../process-matrix.ts';

export const MCP_WORK_PROJECT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '33333333-3333-4333-8333-333333333333';
export async function mcpWorkFixture(options: {
  projectId?: string;
  required?: boolean; transport?: 'stdio' | 'streamable_http'; selected?: boolean; server?: FakeMcpServerOptions;
} = {}) {
  const box = createTempSandbox('shiploop-mcp-work-');
  const projectId = options.projectId ?? MCP_WORK_PROJECT;
  const request = piRequest({ projectId, strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5' },
    limits: { timeoutMs: 10_000, maxEvents: 100, maxOutputBytes: 100_000 } });
  const transport = options.transport ?? 'stdio', required = options.required ?? true;
  const selection = validateProjectResourceSelection({ schemaVersion: 1, projectId, revision: 1,
    resources: options.selected === false ? [] : [{ projectId, sourceProjectId: projectId, kind: 'mcp', name: 'approved local',
      sourceRef: SOURCE, sourceRevision: 'r1', version: '1.0.0', contentDigest: 'a'.repeat(64), transport,
      capabilities: [transport === 'stdio' ? 'mcp_stdio' : 'mcp_streamable_http'], credentialRef: null, required, onUnavailable: required ? 'reject' : 'omit' }],
    operations: [...PROJECT_RESOURCE_PUBLIC_OPERATIONS], allowGlobalScan: false, allowProjectDirectoryScan: false, allowSdkDefaultScan: false });
  const resourceId = selection.resources[0]?.id;
  const manifest = assembleProjectResourceLoadManifest(selection, selection.resources.map(resource => ({ ...resource,
    status: 'available', unavailableReason: null, loadedCapabilities: resource.capabilities })));
  const snapshot = buildRuntimeWorkAccessSnapshot({ selection, loadManifest: manifest, projectId,
    runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', invocationId: request.invocationId,
    executionVersion: request.executionVersion, owner: request.owner, strategy: { ...request.strategy, runtime: 'pi' }, permissions: request.permissions,
    grantId: 'grant-1', policyDigest: 'b'.repeat(64), authentication: { status: 'ready', digest: 'b'.repeat(64), sourceRef: SOURCE, kind: 'local_login' } });
  const runtime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.streamSimple = () => { throw new Error('network/model requests are forbidden in this fixture'); };
  const settings = sdk.SettingsManager.inMemory({ cacheWarming: 'off', retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({ cwd: box.path, agentDir: box.path, settingsManager: settings,
    noSkills: true, noExtensions: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, systemPrompt: '' });
  await loader.reload();
  const registry = createMcpStdioProcessRegistry({ path: join(box.path, 'registry.json') });
  const actualManifests: unknown[] = [], registrations: McpStdioProcessRegistration[] = [];
  const assembly: PiTrustedAssembly = {
    agentDir: box.path, resolveWorkingDirectory: () => box.path, inputReader: { read: async () => 'controlled input' }, resourceLoader: loader,
    modelRuntime: runtime, settingsManager: settings, resolveModel: () => runtime.getModel('anthropic', 'claude-sonnet-4-5')!,
    prepareAccess: async current => ({ snapshot: current.workAccess!, credentialRef: { kind: 'trusted-resolution', id: 'offline' }, resourceLoader: loader,
      resourceManifest: manifest, resourceLoadPolicy: { selectedResourceIds: selection.resources.map(entry => entry.id),
        allowGlobalScan: false, allowProjectDirectoryScan: false, allowSdkDefaultScan: false } }),
    mcp: { resolver: { resolve: () => ({ resourceId: resourceId!, sourceRef: SOURCE, sourceRevision: 'r1', version: '1.0.0', contentDigest: 'a'.repeat(64),
      environmentRefs: [], credentialRef: null, ...createFakeMcpServerCommand(box.path, options.server), cwd: box.path, environment: {}, allowedTools: ['echo'] }) },
      registerProcess: async value => { registrations.push(value); return { launchId: value.processIdentity.launchId }; }, processRegistry: registry,
      recordManifest: async (_request, actual) => { actualManifests.push(actual); } },
  };
  return { box, request: { ...request, workAccess: snapshot }, selection, resourceId, manifest, snapshot, runtime, settings, loader, registry,
    actualManifests, registrations, assembly,
    adapter: (sessionFactory?: PiSessionFactory, overrides: Partial<PiTrustedAssembly> = {}) => createPiRuntimeAdapter({
      providers: [{ providerId: 'anthropic', models: ['claude-sonnet-4-5'] }], permissionGrants: ['fs.read'], isolationModes: ['trusted_project'],
      assembly: { ...assembly, ...overrides }, sessionFactory }).adapter,
    async cleanup() {
      // Test failure must not leave an owned server running. Signal only a freshly matched identity.
      for (const registration of registrations.filter(value => registry.list(value).length > 0)) {
        const id = registration.processIdentity;
        const row = (await processRows()).find(item => item.pid === id.pid);
        if (row && row.processGroupId === id.processGroupId && row.startTime === id.startTime) process.kill(-id.processGroupId, 'SIGKILL');
        await until(async () => !(await processRows()).some(item => item.processGroupId === id.processGroupId), 'fixture MCP cleanup');
      }
      box.cleanup();
    },
  };
}
