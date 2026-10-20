import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';
import { createLocalOwnerPrincipal, buildWorkAccessManifest, createWorkAuthenticationPreflight } from '../../../packages/core/src/index.ts';
import { assembleWorkResourceManifest } from '../../../packages/core/src/ports/work-resource-selection.ts';
import { createPiLocalLoginAuthenticationSource, createPiAuthenticationCatalog } from '../../../packages/host/src/runtime/pi-authentication.ts';
import { createPiRuntimeAdapter } from '../../../packages/host/src/runtime/pi-adapter.ts';
import { createPiRunnerAdapter } from '../../../packages/host/src/runtime/pi-runner-adapter.ts';
import type { RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { WorkAccessConfiguration } from '../../../packages/core/src/ports/work-access.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const binding = {
  principal: createLocalOwnerPrincipal(), projectId: '11111111-1111-4111-8111-111111111111', hostInstanceId: 'host-1',
  identity: { purpose: 'work' as const, runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1' },
  invocationId: 'invocation-1', executionVersion: 1, nowUtcMs: 2000,
  strategy: { runtime: 'pi' as const, provider: 'anthropic', model: 'claude-sonnet-4-5' },
};
const sourceRef = '22222222-2222-4222-8222-222222222222';
const skillId = '33333333-3333-4333-8333-333333333333';
const grantId = '44444444-4444-4444-8444-444444444444';
function access(): WorkAccessConfiguration {
  return {
    schemaVersion: 1, ...binding.strategy,
    authentication: { kind: 'local_login', sourceRef, pluginId: null, environmentRefs: [] }, resources: [], context: {
    grantId, principalId: binding.principal.principalId, projectId: binding.projectId, hostInstanceId: binding.hostInstanceId,
    identity: binding.identity, invocationId: binding.invocationId, executionVersion: 1,
    issuedAtUtcMs: 1000, expiresAtUtcMs: 3000, operations: ['task.read'],
  } };
}
function saveEvidence(name: string, value: unknown, secret: string) {
  const text = JSON.stringify(value, null, 2);
  // Boolean assertions ensure the synthetic value cannot appear in failure diffs/reports.
  expect(text.includes(secret)).toBe(false);
  const directory = process.env.SHIPLOOP_F007_EVIDENCE_DIR;
  if (directory) { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, name), text + '\n'); }
}

it('[case:sdk-explicit-resources] 真实 SDK 只加载显式批准 skill，实际内容摘要进入 manifest；未核实能力按必需/可选拒绝或降级', async () => {
  const sandbox = createTempSandbox('shiploop-f007-resources-');
  try {
    const agentDir = join(sandbox.path, 'agent'), cwd = join(sandbox.path, 'project');
    const skill = (path: string, name: string) => {
      mkdirSync(path, { recursive: true });
      const file = join(path, 'SKILL.md');
      writeFileSync(file, `---\nname: ${name}\ndescription: Controlled ${name} fixture\n---\n${name} instructions\n`);
      return file;
    };
    const approved = skill(join(sandbox.path, 'approved'), 'approved');
    skill(join(agentDir, 'skills/global'), 'global');
    skill(join(cwd, '.pi/skills/unselected'), 'unselected');
    const input = { ...access(), resources: [{ id: skillId, kind: 'skill', sourceRef, version: '1.0.0', contentDigest: hash(readFileSync(approved, 'utf8')),
      required: true, onUnavailable: 'reject', capabilities: ['resource_selection'], transport: null, environmentRefs: [] }] };
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory(),
      noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalSkillPaths: [approved], systemPrompt: '', appendSystemPrompt: [],
    });
    await loader.reload();
    expect(loader.getSkills().diagnostics).toEqual([]);
    expect(loader.getSkills().skills.map(s => s.name)).toEqual(['approved']);
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    const observations = loader.getSkills().skills.map(s => ({ id: skillId, kind: 'skill', sourceRef, version: '1.0.0',
      contentDigest: hash(readFileSync(s.filePath, 'utf8')), capabilities: ['resource_selection'], transport: null,
      status: 'available', unavailableReason: null }));
    const manifest = assembleWorkResourceManifest(input, binding, observations);
    expect(manifest.resources).toHaveLength(1);
    expect(manifest.resources[0]).toMatchObject({ id: skillId, status: 'available', loadedCapabilities: ['resource_selection'] });
    const unavailable = [{ ...observations[0], capabilities: [], status: 'unavailable', unavailableReason: 'unverified' }];
    expect(() => assembleWorkResourceManifest(input, binding, unavailable)).toThrow(expect.objectContaining({ reason: 'required_unavailable' }));
    const optional = { ...input, resources: input.resources.map(r => ({ ...r, required: false, onUnavailable: 'omit' as const })) };
    const degraded = assembleWorkResourceManifest(optional, binding, unavailable);
    expect(degraded.resources[0].status).toBe('omitted');
    expect(degraded.gaps).toEqual([{ resourceId: skillId, capability: 'resource_selection', reason: 'unverified' }]);
    expect(() => assembleWorkResourceManifest(input, binding, [{ ...observations[0], capabilities: ['invented_capability'] }]))
      .toThrow(expect.objectContaining({ reason: 'unknown_resource' }));
    saveEvidence('resources.json', { actualManifest: manifest, optionalManifest: degraded,
      loadedSkillNames: loader.getSkills().skills.map(s => s.name), globalLoaded: false, projectUnselectedLoaded: false,
      requiredUnverified: 'required_unavailable', unknownCapability: 'unknown_resource', live: 'not_run' }, 'unused-sentinel');
  } finally { sandbox.cleanup(); }
});

it('[case:authentication-runtime-secret-boundary] 真实文件认证 ready 仍可推理失败；秘密不进入 prompt、argv、输入、日志、诊断或报告', async () => {
  const sandbox = createTempSandbox('shiploop-f007-secret-');
  const secret = ['synthetic', randomUUID(), randomUUID()].join('-');
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
  try {
    const authPath = join(sandbox.path, 'auth.json');
    writeFileSync(authPath, JSON.stringify({ anthropic: { type: 'api_key', key: secret } }), { mode: 0o600 });
    const input = access(), policy = buildWorkAccessManifest(input, binding);
    const preflight = createWorkAuthenticationPreflight({
      sources: new Map([[sourceRef, createPiLocalLoginAuthenticationSource({ authPath, provider: input.provider })]]),
      catalog: createPiAuthenticationCatalog(), monotonicNow: () => 0,
      authorize: async () => ({ state: 'active', sourceRead: true, modelRequest: true, policyDigest: policy.digest }),
    });
    const ready = await preflight.check(input, binding, policy.digest);
    expect(ready).toMatchObject({ status: 'ready', authentication: 'ready', inference: 'unknown' });
    const resourceManifest = assembleWorkResourceManifest(input, binding, []);
    const snapshot = { schemaVersion: 1 as const, projectId: binding.projectId,
      runId: binding.identity.runId, taskId: binding.identity.taskId, attemptId: binding.identity.attemptId,
      invocationId: binding.invocationId, executionVersion: 1,
      owner: { principalId: binding.principal.principalId, hostInstanceId: binding.hostInstanceId },
      strategy: binding.strategy, permissions: { grants: [], isolation: 'trusted_project' }, grantId,
      policyDigest: policy.digest, authentication: { status: 'ready' as const, digest: ready.digest, sourceRef, kind: 'local_login' as const },
      resources: { digest: resourceManifest.digest, entries: [] } };
    const ref = (purpose: string) => ({ projectId: binding.projectId, artifactId: `artifact-${purpose}`, kind: 'execution-input', purpose,
      version: 1, contentHash: hash(purpose), sizeBytes: 10, locator: `inputs/${purpose}`, mediaType: 'text/plain', origin: { kind: 'artifact' as const } });
    const request: RuntimeExecutionRequest = { schemaVersion: 1, projectId: binding.projectId, featureId: 'feature-1', sessionId: 'session-1',
      identity: binding.identity, invocationId: binding.invocationId, executionVersion: 1, owner: snapshot.owner, strategy: binding.strategy,
      prompt: ref('prompt'), inputManifest: ref('manifest'), cwd: { root: 'workspace', relativePath: '.' },
      permissions: snapshot.permissions, limits: { timeoutMs: 1000, maxEvents: 20, maxOutputBytes: 10000 }, recovery: { mode: 'new' }, workAccess: snapshot };
    writeFileSync(join(sandbox.path, 'prompt.txt'), 'controlled prompt');
    writeFileSync(join(sandbox.path, 'input-manifest.json'), JSON.stringify(snapshot));
    const prompts: string[] = [];
    const loader = new DefaultResourceLoader({ cwd: sandbox.path, agentDir: sandbox.path, settingsManager: SettingsManager.inMemory(),
      noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: '' });
    await loader.reload();
    const adapter = createPiRuntimeAdapter({ providers: [{ providerId: input.provider, models: [input.model] }],
      permissionGrants: [], isolationModes: ['trusted_project'], assembly: { agentDir: sandbox.path,
        resolveWorkingDirectory: () => sandbox.path, inputReader: { read: async ref => readFileSync(
          join(sandbox.path, ref.purpose === 'prompt' ? 'prompt.txt' : 'input-manifest.json'), 'utf8') },
        resourceLoader: loader, prepareAccess: async () => ({ snapshot, credentialRef: { kind: 'trusted-resolution', id: 'approved-credential' }, resourceLoader: loader }) },
      sessionFactory: async () => ({ subscribe: () => () => {}, abort: async () => {}, dispose: () => {},
        prompt: async text => { prompts.push(text); throw new Error(`provider unavailable ${secret}`); } }),
    });
    const handle = await adapter.adapter.start(request);
    const result = await handle.result;
    expect(result).toMatchObject({ terminal: 'failed', reason: 'provider_error' });
    const events: unknown[] = [];
    for await (const event of handle.events) events.push(event);
    const launchInputs: unknown[] = [];
    const runner = createPiRunnerAdapter({ argv: ['controlled-runner'], cwd: sandbox.path, environment: {},
      confirm: async identity => ({ launchId: identity.launchId }), process: { start: async launch => {
        launchInputs.push({ argv: launch.argv, stdin: Buffer.from(launch.stdin!).toString('utf8'), environment: launch.environment });
        throw new Error(`authentication ${secret}`);
      } } });
    let launchError: unknown;
    try { await runner.start(request); } catch (error) { launchError = error; }
    expect(launchError).toMatchObject({ reason: 'runner_start_failed' });
    expect(prompts).toEqual(['controlled prompt']);
    expect(launchInputs).toHaveLength(1);
    const report = { policy, ready, resourceManifest, request, snapshot, prompts, launchInputs, result, events,
      launchError: String(launchError), logs: logs.map(log => log.mock.calls), modelRequest: 'scripted failure', live: 'not_run' };
    expect(JSON.stringify(report).includes(secret)).toBe(false);
    expect(JSON.stringify(report).includes(authPath)).toBe(false);
    expect(logs.every(log => log.mock.calls.length === 0)).toBe(true);
    saveEvidence('authentication.json', report, secret);
    writeFileSync(authPath, '{}');
    expect(await preflight.check(input, binding, policy.digest)).toMatchObject({ status: 'rejected', reason: 'authentication_missing', inference: 'unknown' });
  } finally { logs.forEach(log => log.mockRestore()); sandbox.cleanup(); }
});
