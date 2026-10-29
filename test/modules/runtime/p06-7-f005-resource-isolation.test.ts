import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { validateProjectResourceSelection, type RuntimeExecutionRequest } from '../../../packages/core/src/index.ts';
import { createPiRuntimeAdapter, createPiSdkSessionFactory, PI_RUNTIME_RECOVERY_CAPABILITIES,
  type PiTrustedAssembly } from '../../../packages/host/src/runtime/pi-adapter.ts';
import { processRows } from '../../helpers/process-matrix.ts';
import { stageResourceFixture, resourceRecoveryLease, saveResourceEvidence, hashResourceEvidence } from '../../helpers/p06-7/resource-scenario.ts';
import { mcpWorkFixture } from '../../helpers/p06-4/pi-mcp-fixture.ts';
import { createMcpStdioConnection } from '../../../packages/host/src/runtime/mcp-stdio.ts';
import { prepareMcpStartupPlan } from '../../../packages/host/src/runtime/mcp-startup-plan.ts';
import { ScriptedPiSession } from '../../helpers/p04-1/pi-adapter-fixture.ts';

it('[case:p06-f005-first-and-resume] real SDK first/resumed Work sessions keep pinned Skills/MCP while current configuration and history contain unselected resources', async () => {
  const f = await stageResourceFixture();
  const sessions: AgentSession[] = [];
  const attempts: unknown[] = [];
  const initialSnapshot = JSON.stringify(f.snapshot);
  let previous: Parameters<typeof resourceRecoveryLease>[0] | undefined;
  try {
    // Both SDK default locations contain an executable poison. Neither may be scanned.
    const poison = JSON.stringify({ mcpServers: { unselected: { command: '/bin/sh', args: ['-c',
      `touch '${join(f.box.path, 'unselected-started')}'`] } } });
    for (const file of ['mcp.json', '.pi/mcp.json']) writeFileSync(join(f.box.path, file), poison);
    await f.runtime.setRuntimeApiKey('anthropic', 'offline-synthetic-key');
    for (const index of [1, 2]) {
      const request: RuntimeExecutionRequest = { ...f.request, sessionId: `stage-session-${index}`, invocationId: `stage-invocation-${index}`,
        identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: `attempt-${index}` },
        workAccess: { ...f.snapshot, attemptId: `attempt-${index}`, invocationId: `stage-invocation-${index}` } };
      const recovery = previous ? resourceRecoveryLease(previous, request) : undefined;
      let turn = 0, mcpName = '';
      const assembly: PiTrustedAssembly = { ...f.assembly,
        recoverySourceManager: recovery ? { acquire: async () => recovery.lease } : undefined };
      f.runtime.streamSimple = model => {
        const call = ++turn === 1;
        const message: AssistantMessage = { role: 'assistant', provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
          content: call ? [
            { type: 'toolCall', id: 'approved-call', name: mcpName, arguments: {} },
            { type: 'toolCall', id: 'unselected-call', name: 'mcp_unselected', arguments: {} },
          ] : [{ type: 'text', text: 'offline complete' }], stopReason: call ? 'toolUse' : 'stop',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'start', partial: message });
          stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message }); stream.end(); });
        return stream;
      };
      const factory = createPiSdkSessionFactory(assembly);
      const adapter = createPiRuntimeAdapter({ assembly, providers: [{ providerId: 'anthropic', models: ['claude-sonnet-4-5'] }],
        permissionGrants: ['fs.read'], isolationModes: ['trusted_project'],
        recoveryCapabilities: { ...PI_RUNTIME_RECOVERY_CAPABILITIES, capabilities: { ...PI_RUNTIME_RECOVERY_CAPABILITIES.capabilities,
          conversationResume: { status: 'verified', evidenceRef: 'offline-stage-fixture', limits: ['fixture only'] },
          nativeFork: { status: 'verified', evidenceRef: 'offline-stage-fixture', limits: ['fixture only'] } } },
        sessionFactory: async options => {
          mcpName = options.customTools![0]!.name;
          const session = await factory(options) as AgentSession;
          sessions.push(session);
          expect(session.getActiveToolNames()).toEqual([mcpName]);
          expect(session.resourceLoader.getSkills().skills.map(skill => skill.name)).toEqual(['approved-stage-skill']);
          expect(session.resourceLoader.getExtensions().extensions).toEqual([]);
          expect(session.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
          if (previous) expect(session.messages.some(message => message.role === 'toolResult')).toBe(true);
          return session;
        } }).adapter;
      const handle = await adapter.start({ ...request,
        recovery: recovery ? { mode: 'required', kind: 'conversation', source: recovery.source } : { mode: 'new' } });
      expect(await handle.result).toMatchObject({ terminal: 'completed' });
      const session = sessions.at(-1)!;
      const archive = readFileSync(session.sessionFile!);
      const entries = archive.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
      const results = entries.filter(entry => entry.message?.role === 'toolResult');
      expect(results.findLast(entry => entry.message.toolCallId === 'approved-call')?.message)
        .toMatchObject({ isError: false, content: [{ type: 'text', text: 'fake result' }] });
      expect(results.findLast(entry => entry.message.toolCallId === 'unselected-call')?.message.isError).toBe(true);
      const registration = f.registrations.at(-1)!;
      expect(registration).toMatchObject({ projectId: request.projectId, sessionId: request.sessionId,
        invocationId: request.invocationId, serverId: f.resourceId });
      expect(f.registry.list(registration)).toEqual([]);
      const rows = await processRows();
      expect(rows.some(row => row.processGroupId === registration.processIdentity.processGroupId)).toBe(false);
      const actualCall = JSON.parse(readFileSync(join(f.box.path, 'call.entered'), 'utf8'));
      expect(actualCall).toMatchObject({ count: 1, params: { name: 'echo', arguments: {} } });
      expect(existsSync(join(f.box.path, 'unselected-started'))).toBe(false);
      const events = [];
      for await (const event of handle.events) events.push(event);
      expect(JSON.stringify(events)).toContain('approved-call');
      const stop = Buffer.from(JSON.stringify({ mcpGroupAbsent: true, registrationRemoved: true, nativeWriterDisposed: true }));
      session.dispose();
      previous = { request, archive, nativeId: session.sessionId, stop };
      attempts.push({ mode: index === 1 ? 'first' : 'resume', projectId: request.projectId, sessionId: request.sessionId,
        invocationId: request.invocationId, nativeId: session.sessionId, snapshot: request.workAccess,
        manifest: f.actualManifests.at(-1), activeTools: [mcpName], skillDigest: hashResourceEvidence(readFileSync(f.approved.path)),
        registration, actualCall, os: { groupAbsent: true, childPid: Number(readFileSync(join(f.box.path, 'child.pid'), 'utf8')) }, events });
      if (index === 1) {
        // User/current config drifts, while the input snapshot and its explicit loader remain pinned.
        const addedPath = join(f.box.path, '.pi/skills/added');
        mkdirSync(addedPath, { recursive: true });
        const addedSkill = '---\nname: newly-added\ndescription: Must stay unavailable\n---\nnew instructions';
        writeFileSync(join(addedPath, 'SKILL.md'), addedSkill);
        const current = validateProjectResourceSelection({ schemaVersion: 1, projectId: request.projectId, revision: 2,
          resources: [...f.selection.resources, { projectId: request.projectId, sourceProjectId: request.projectId,
            kind: 'skill', name: 'newly-added', sourceRef: '55555555-5555-4555-8555-555555555555', sourceRevision: 'r2',
            version: '1.0.0', contentDigest: hashResourceEvidence(addedSkill), transport: null,
            capabilities: ['resource_selection'], credentialRef: null, required: true, onUnavailable: 'reject' }],
          operations: ['task.read'], allowGlobalScan: false, allowProjectDirectoryScan: false, allowSdkDefaultScan: false });
        expect(current.digest).not.toBe(f.selection.digest);
        writeFileSync(join(f.box.path, 'current-resource-config.json'), JSON.stringify(current));
        await f.loader.reload();
      }
    }
    expect(JSON.stringify(f.snapshot)).toBe(initialSnapshot);
    expect(f.registrations).toHaveLength(2);
    expect(f.registrations[0]!.processIdentity.launchId).not.toBe(f.registrations[1]!.processIdentity.launchId);
    expect(sessions[0]!.sessionId).not.toBe(sessions[1]!.sessionId);
    saveResourceEvidence('first-and-resume', { resources: { selection: f.selection, manifest: f.manifest, attempts },
      interfaceAuthorization: { scope: 'separate restricted Work channel cases in Task index' },
      osIsolation: { mode: 'trusted_project', strongSandbox: false, observation: 'only owned MCP groups and descendants were checked' },
      live: 'not_run' });
  } finally { for (const session of sessions) session.dispose(); await f.cleanup(); }
}, 25_000);

it.each(['allowGlobalScan', 'allowProjectDirectoryScan', 'allowSdkDefaultScan'] as const)(
  '[case:p06-f005-implicit-scan-%s] rejects an implicit loader policy before resolving or starting a server', async field => {
    const f = await stageResourceFixture();
    let resolved = 0;
    try {
      const adapter = f.adapter(async () => new ScriptedPiSession(), { ...f.assembly,
        prepareAccess: async request => {
          const access = await f.assembly.prepareAccess!(request);
          return { ...access, resourceLoadPolicy: { ...access.resourceLoadPolicy!, [field]: true } } as unknown as Awaited<ReturnType<NonNullable<PiTrustedAssembly['prepareAccess']>>>;
        }, mcp: { ...f.assembly.mcp!, resolver: { resolve: () => { resolved++; throw new Error('must not resolve'); } } } });
      await expect(adapter.start(f.request)).rejects.toMatchObject({ reason: 'work_resource_loader_policy_mismatch' });
      expect(resolved).toBe(0);
      expect(f.registrations).toEqual([]);
    } finally { await f.cleanup(); }
  });

it.each(['schema', 'project', 'principal', 'invocation'] as const)(
  '[case:p06-f005-forged-%s] refuses a changed execution binding before server resolution', async mode => {
    const f = await mcpWorkFixture();
    let resolved = 0;
    try {
      const request = structuredClone(f.request);
      if (mode === 'schema') Object.assign(request, { schemaVersion: 99 });
      if (mode === 'project') Object.assign(request, { projectId: '55555555-5555-4555-8555-555555555555' });
      if (mode === 'principal') Object.assign(request, { owner: { ...request.owner, principalId: 'forged' } });
      if (mode === 'invocation') Object.assign(request, { invocationId: 'forged' });
      await expect(prepareMcpStartupPlan(request, { resolver: { resolve: () => { resolved++; throw new Error('must not resolve'); } } }))
        .rejects.toMatchObject({ reason: mode === 'schema' ? 'unsupported_schema_version' : 'identity_mismatch' });
      expect(resolved).toBe(0);
      expect(f.registrations).toEqual([]);
    } finally { await f.cleanup(); }
  });

it('[case:p06-f005-cross-project-handle] cannot dispatch a real tool handle from another project or route rejection to another server', async () => {
  const left = await mcpWorkFixture();
  const right = await mcpWorkFixture({ projectId: '66666666-6666-4666-8666-666666666666' });
  const connections: ReturnType<typeof createMcpStdioConnection>[] = [];
  try {
    const catalogs = [];
    for (const f of [left, right]) {
      const plan = await prepareMcpStartupPlan(f.request, { resolver: f.assembly.mcp!.resolver });
      const connection = createMcpStdioConnection({ ...f.assembly.mcp!, plan, handshakeTimeoutMs: 2000, closeTimeoutMs: 200 });
      connections.push(connection);
      await connection.start();
      catalogs.push(await connection.createToolCatalog());
    }
    const foreign = catalogs[0]!.resolve(catalogs[0]!.tools[0]!.name)!;
    await expect(catalogs[1]!.dispatch(foreign, {}, undefined, 'cross-project-call')).rejects.toMatchObject({ reason: 'invalid_mapping' });
    expect(existsSync(join(left.box.path, 'call.entered'))).toBe(false);
    expect(existsSync(join(right.box.path, 'call.entered'))).toBe(false);
    expect(await catalogs[1]!.tools[0]!.execute('own-project-call', {})).toMatchObject({
      isError: false, content: [{ type: 'text', text: 'fake result' }] });
    expect(JSON.parse(readFileSync(join(right.box.path, 'call.entered'), 'utf8')).count).toBe(1);
    expect(existsSync(join(left.box.path, 'call.entered'))).toBe(false);
    saveResourceEvidence('cross-project-handle', { left: left.request.projectId, right: right.request.projectId,
      rejected: 'invalid_mapping', leftCalls: 0, rightCalls: 1, ownerFallback: false, otherServerFallback: false });
  } finally {
    try { for (const connection of connections) expect((await connection.close()).confirmed).toBe(true); }
    finally { await right.cleanup(); await left.cleanup(); }
  }
}, 15_000);
