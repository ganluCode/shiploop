import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DefaultResourceLoader, SettingsManager, SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { getModel } from '@earendil-works/pi-ai/compat';
import { createPiRuntimeAdapter, createPiSdkSessionFactory, PI_ADAPTER_VERSION, PI_NATIVE_SESSION_FORMAT,
  PI_NATIVE_SESSION_FORMAT_VERSION, PI_RUNTIME_RECOVERY_CAPABILITIES, PI_SDK_VERSION,
  type PiRecoveryWriterLease, type PiSessionFactoryOptions, type PiTrustedAssembly } from '../../../packages/host/src/runtime/pi-adapter.ts';
import type { ExecutionInputRef, RuntimeExecutionRequest, RuntimeRecoveryCapabilities, RuntimeRecoveryReference } from '../../../packages/core/src/index.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shiploop-pi-resume-'));
  roots.push(root);
  const agentDir = join(root, 'agent');
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: SettingsManager.inMemory(),
    noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: '', appendSystemPrompt: [] });
  await loader.reload();
  const model = getModel('anthropic', 'claude-sonnet-4-5');
  const assembly: PiTrustedAssembly = { agentDir, resourceLoader: loader, resolveModel: () => model,
    credentialRef: { kind: 'trusted-resolution', id: 'current-credential' },
    resolveWorkingDirectory: () => root, inputReader: { read: async () => 'current input' } };
  const source = SessionManager.create(root, join(root, 'source'));
  source.appendModelChange('old-provider', 'old-model');
  source.appendThinkingLevelChange('high');
  source.appendMessage({ role: 'user', content: 'existing work', timestamp: 1 });
  source.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'previous answer' }],
    provider: 'anthropic', model: 'claude-sonnet-4-5', api: 'anthropic-messages', timestamp: 2,
    stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const sourceFile = source.getSessionFile()!;
  const archive = await readFile(sourceFile);
  return { root, assembly, source, sourceFile, archive, factory: createPiSdkSessionFactory(assembly),
    options: { cwd: root, agentDir, sessionDir: join(agentDir, 'sessions', 'new-attempt'),
      provider: model.provider, model: model.id, credentialRef: assembly.credentialRef!, resourceLoader: loader } };
}

describe('F-002 managed standard Pi sessions', () => {
  it('[case:managed-sdk-fork] loads immutable history into a distinct file and reapplies the approved route and reasoning', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'existing-code.ts'), 'export const progress = true;');
    const session = await f.factory({ ...f.options, recovery: {
      archive: f.archive,
      reference: { providerSessionId: f.source.getSessionId(), sourceDigest: createHash('sha256').update(f.archive).digest('hex') },
      assertCurrent: async () => {},
    } }) as AgentSession;
    try {
      expect(PI_NATIVE_SESSION_FORMAT_VERSION).toBe('3');
      expect(session.sessionId).not.toBe(f.source.getSessionId());
      expect(session.sessionFile).not.toBe(f.sourceFile);
      expect(session.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'existing work' })]));
      expect(session.model).toMatchObject({ provider: f.options.provider, id: f.options.model });
      expect(session.thinkingLevel).toBe('off');
      expect(await readFile(f.sourceFile)).toEqual(f.archive);
      expect(await readFile(join(f.root, 'existing-code.ts'), 'utf8')).toBe('export const progress = true;');
    } finally { session.dispose(); }
  });

  it('[case:managed-new-single-writer] creates new identities, retains code, and refuses two factories claiming the same directory', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'untracked.ts'), 'existing work');
    const results = await Promise.allSettled([f.factory(f.options), f.factory(f.options)]);
    const fulfilled = results.filter(result => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const first = fulfilled[0].value;
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ reason: 'native_writer_scope_unavailable' });
    const second = await f.factory({ ...f.options, sessionDir: join(f.root, 'another-attempt') });
    try {
      expect(first.sessionId).not.toBe(second.sessionId);
      expect(first.sessionId).not.toBe(f.source.getSessionId());
      expect(await readFile(join(f.root, 'untracked.ts'), 'utf8')).toBe('existing work');
    } finally { first.dispose(); second.dispose(); }
  });

  const invalidArchives: Array<[string, (entries: Record<string, unknown>[]) => string, string]> = [
    ['json', () => '{broken json}\n', 'native_archive_corrupt'],
    ['version', entries => entries.map((entry, i) => JSON.stringify(i === 0 ? { ...entry, version: 2 } : entry)).join('\n'), 'native_format_incompatible'],
    ['session-id', entries => entries.map((entry, i) => JSON.stringify(i === 0 ? { ...entry, id: 'wrong-id' } : entry)).join('\n'), 'native_session_identity_mismatch'],
    ['tree-parent', entries => entries.map((entry, i) => JSON.stringify(i === 1 ? { ...entry, parentId: 'missing-parent' } : entry)).join('\n'), 'native_archive_corrupt'],
    ['entry-shape', entries => entries.map((entry, i) => JSON.stringify(i === entries.length - 1 ? { ...entry, message: {} } : entry)).join('\n'), 'native_archive_corrupt'],
    ['content-block', entries => entries.map((entry, i) => JSON.stringify(i === entries.length - 1 ? { ...entry, message: { ...(entry.message as object), content: [null] } } : entry)).join('\n'), 'native_archive_corrupt'],
    ['extension', entries => [...entries, { type: 'custom', id: 'extra-entry', parentId: null, timestamp: 'now' }].map(entry => JSON.stringify(entry)).join('\n'), 'native_entry_unverified'],
  ];
  for (const [id, change, reason] of invalidArchives) {
    it(`[case:native-invalid-${id}] refuses corrupt or unverified source content before writing a branch`, async () => {
      const f = await fixture();
      const entries = f.archive.toString('utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
      const archive = Buffer.from(change(entries));
      await expect(f.factory({ ...f.options, recovery: { archive,
        reference: { providerSessionId: f.source.getSessionId(), sourceDigest: hash(archive) }, assertCurrent: async () => {} } }))
        .rejects.toMatchObject({ reason });
      expect(await readFile(f.sourceFile)).toEqual(f.archive);
    });
  }

  it('[case:missing-native-fork] refuses an SDK without the required fork operation', async () => {
    const f = await fixture();
    const { createPiManagedSessionManager } = await import('../../../packages/host/src/runtime/pi-native-session.ts');
    await expect(createPiManagedSessionManager({ SessionManager: {} as typeof SessionManager }, f.root, f.options.sessionDir,
      { archive: f.archive, reference: { providerSessionId: f.source.getSessionId(), sourceDigest: hash(f.archive) }, assertCurrent: async () => {} }))
      .rejects.toMatchObject({ reason: 'native_fork_unsupported' });
    expect(await readFile(f.sourceFile)).toEqual(f.archive);
  });
});

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function artifact(id: string, bytes: Uint8Array, mediaType = 'application/x-ndjson'): ExecutionInputRef {
  return { projectId: 'project-1', artifactId: id, kind: 'runtime-native-archive', purpose: 'recovery',
    version: 1, contentHash: hash(bytes), sizeBytes: bytes.byteLength, locator: `sessions/${id}`,
    mediaType, origin: { kind: 'file', root: 'data', relativePath: `sessions/${id}` } };
}
function request(source: RuntimeRecoveryReference): RuntimeExecutionRequest {
  const input = artifact('input', Buffer.from('input'), 'text/plain');
  return { schemaVersion: 1, projectId: 'project-1', featureId: 'feature-1', sessionId: 'session-new',
    invocationId: 'invocation-new', executionVersion: 2,
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-new' },
    owner: { principalId: 'principal-1', hostInstanceId: 'host-1' },
    strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-4-5' },
    prompt: input, inputManifest: input, cwd: { root: 'workspace', relativePath: '.' },
    permissions: { grants: [], isolation: 'trusted_project' },
    limits: { timeoutMs: 60_000, maxEvents: 100, maxOutputBytes: 100_000 },
    recovery: { mode: 'required', kind: 'conversation', source } };
}
// Test-environment evidence only; production defaults stay unsupported until live validation.
function controlledEvidence(): RuntimeRecoveryCapabilities {
  return { ...PI_RUNTIME_RECOVERY_CAPABILITIES, capabilities: {
    ...PI_RUNTIME_RECOVERY_CAPABILITIES.capabilities,
    conversationResume: { status: 'verified', evidenceRef: 'controlled-session-factory', limits: ['offline test double only'] },
    nativeFork: { status: 'verified', evidenceRef: 'managed-sdk-fork', limits: ['immutable Artifact JSONL v3 only'] },
  } };
}
async function adapterFixture() {
  const f = await fixture();
  const archive = artifact('archive-old', f.archive);
  const stopBytes = Buffer.from('{"confirmed":true}');
  const stop = artifact('stop-old', stopBytes, 'application/json');
  const source: RuntimeRecoveryReference = { schemaVersion: 1, purpose: 'work', kind: 'conversation',
    sourceProjectId: 'project-1', sourceSessionId: 'session-old', sourceTaskId: 'task-1', sourceAttemptId: 'attempt-old',
    runtime: 'pi', provider: f.options.provider, model: f.options.model, providerSessionId: f.source.getSessionId(),
    nativeArchiveRef: archive.artifactId, nativeFormat: PI_NATIVE_SESSION_FORMAT,
    nativeFormatVersion: PI_NATIVE_SESSION_FORMAT_VERSION, sourceDigest: archive.contentHash };
  const req = request(source);
  const release = vi.fn(async () => {});
  const assertCurrent = vi.fn(async () => {});
  const readVerifiedArtifact = vi.fn(async (ref: ExecutionInputRef) => ref.artifactId === archive.artifactId ? f.archive : stopBytes);
  const lease: PiRecoveryWriterLease = { source: { reference: source, archive, sdkVersion: PI_SDK_VERSION,
      previousWriter: { status: 'confirmed', stopEvidence: stop } }, sourceReadOnly: true,
    authority: { projectId: req.projectId, featureId: req.featureId, taskId: 'task-1', taskStatus: 'unfinished',
      previousAttemptId: 'attempt-old', previousSessionId: 'session-old' },
    writer: { purpose: 'work', attemptId: 'attempt-new', invocationId: req.invocationId,
      sessionId: req.sessionId, executionVersion: req.executionVersion, owner: req.owner, exclusive: true },
    release, assertCurrent, readVerifiedArtifact };
  const acquire = vi.fn(async () => lease);
  const factory = vi.fn(async (_options: PiSessionFactoryOptions) => {
    let listener: ((event: unknown) => void) | undefined;
    return { sessionId: 'native-new', sessionFile: join(f.root, 'new.jsonl'),
      model: { provider: req.strategy.provider, id: req.strategy.model }, thinkingLevel: 'off',
      subscribe(callback: (event: unknown) => void) { listener = callback; return () => { listener = undefined; }; },
      async prompt() { listener?.({ type: 'agent_settled' }); }, async waitForIdle() {}, async abort() {}, dispose() {} };
  });
  function registration(capabilities = controlledEvidence()) {
    return createPiRuntimeAdapter({ assembly: { ...f.assembly, recoverySourceManager: { acquire } },
      providers: [{ providerId: req.strategy.provider, models: [req.strategy.model] }],
      isolationModes: ['trusted_project'], permissionGrants: [], sessionFactory: factory,
      recoveryCapabilities: capabilities });
  }
  return { ...f, req, source, lease, release, assertCurrent, readVerifiedArtifact, acquire, factory, registration };
}

describe('F-002 recovery source admission', () => {
  it('[case:recovery-recording-boundary] exports archive/version/model facts and excludes historical final snapshots and duplicate usage', async () => {
    const f = await adapterFixture();
    const create = f.factory.getMockImplementation()!;
    f.factory.mockImplementation(async options => {
      const base = await create(options);
      let listener: ((event: unknown) => void) | undefined;
      return { ...base,
        subscribe(callback: (event: unknown) => void) { listener = callback; return () => {}; },
        async prompt() {
          const fresh = { id: 'fresh-message', role: 'assistant', content: [{ type: 'text', text: 'new answer' }],
            usage: { input: 7, output: 3, cost: { total: 0.01 } } };
          listener?.({ type: 'message_start', message: fresh });
          listener?.({ type: 'message_end', message: fresh });
          listener?.({ type: 'message_end', message: fresh });
          listener?.({ type: 'agent_end', messages: [
            { ...fresh, id: 'old-message', content: [{ type: 'text', text: 'previous answer' }], usage: { input: 1000, output: 999 } }, fresh,
          ] });
          listener?.({ type: 'agent_settled' });
        } };
    });
    const handle = await f.registration().adapter.start(f.req);
    const events = [];
    for await (const event of handle.events) events.push(event);
    await handle.result;
    const recording = await handle.recoveryRecording;
    const entries = f.archive.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(recording).toMatchObject({ source: f.source, requestedMode: 'required', decision: { mode: 'resume' },
      actualProvider: f.req.strategy.provider, actualModel: f.req.strategy.model, providerSessionId: 'native-new',
      sourceSdkVersion: PI_SDK_VERSION, sdkVersion: PI_SDK_VERSION, nativeFormatVersion: '3',
      nativeSourceWatermark: { entryCount: entries.length - 1, lastEntryId: entries.at(-1).id },
      historicalUsage: 'excluded_unknown_scope', newEvents: { firstSequence: 1, scope: 'current_invocation' }, coverage: 'partial' });
    expect(events.filter(event => (event as { kind: string }).kind === 'message')).toHaveLength(1);
    expect(events.filter(event => (event as { kind: string }).kind === 'usage')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('previous answer');
    expect(JSON.stringify(recording)).not.toContain(f.sourceFile);
    expect(JSON.stringify(recording)).not.toContain('current-credential');
    expect(events).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ code: 'pi.recovery.snapshot_scope_unknown' }) }));
  });

  it('[case:recovery-missing-message-id] marks invocation-local SDK identities as unknown while retaining new partial output', async () => {
    const f = await adapterFixture();
    const create = f.factory.getMockImplementation()!;
    f.factory.mockImplementation(async options => {
      const base = await create(options);
      let listener: ((event: unknown) => void) | undefined;
      return { ...base, subscribe(callback: (event: unknown) => void) { listener = callback; return () => {}; },
        async prompt() {
          listener?.({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'partial response' }] } });
          listener?.({ type: 'agent_settled' });
        } };
    });
    const handle = await f.registration().adapter.start(f.req);
    const events = [];
    for await (const event of handle.events) events.push(event);
    await handle.result;
    expect(events).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ code: 'pi.recovery.event_identity_unknown' }) }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'message', payload: expect.objectContaining({ preview: 'partial response' }) }));
    await expect(handle.stopped).resolves.toMatchObject({ confirmed: false });
  });

  it('[case:approved-source] verifies previous Attempt authority and immutable Artifacts, and returns native facts', async () => {
    const f = await adapterFixture();
    const handle = await f.registration().adapter.start(f.req);
    await handle.result;
    expect(f.readVerifiedArtifact.mock.calls.map(([ref]) => ref.artifactId)).toEqual(['stop-old', 'archive-old']);
    expect(f.factory.mock.calls[0][0]).toMatchObject({ provider: f.req.strategy.provider, model: f.req.strategy.model,
      credentialRef: { id: 'current-credential' }, thinkingLevel: 'off' });
    expect(Buffer.from(f.factory.mock.calls[0][0].recovery!.archive)).toEqual(f.archive);
    expect(handle.nativeSession).toMatchObject({ providerSessionId: 'native-new', nativeFormatVersion: '3',
      sdkVersion: PI_SDK_VERSION, adapterVersion: PI_ADAPTER_VERSION,
      recovery: { decision: { mode: 'resume' }, source: f.source, provider: f.req.strategy.provider, model: f.req.strategy.model,
        thinkingLevel: 'off', evidenceRef: 'controlled-session-factory', nativeForkEvidenceRef: 'managed-sdk-fork' } });
    expect(f.assertCurrent).toHaveBeenCalledTimes(4);
    expect(f.release).toHaveBeenCalledOnce();
    await expect(handle.stopped).resolves.toMatchObject({ confirmed: false });
    expect(await readFile(f.sourceFile)).toEqual(f.archive);
  });

  it('[case:explicit-new-ignores-source] new never acquires the old source', async () => {
    const f = await adapterFixture();
    const handle = await f.registration().adapter.start({ ...f.req, recovery: { mode: 'new' } });
    await handle.result;
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.factory.mock.calls[0][0].recovery).toBeUndefined();
    expect(handle.nativeSession?.recovery?.decision).toEqual({ mode: 'new', reasons: ['explicit_new'] });
  });

  it('[case:auto-safe-downgrade] auto records capability reasons after source validation; required refuses unsupported recovery', async () => {
    const f = await adapterFixture();
    const auto = { ...f.req, recovery: { mode: 'auto' as const, kind: 'conversation' as const, source: f.source } };
    const registration = f.registration(PI_RUNTIME_RECOVERY_CAPABILITIES);
    const handle = await registration.adapter.start(auto);
    await handle.result;
    expect(f.acquire).toHaveBeenCalledOnce();
    expect(f.factory.mock.calls[0][0].recovery).toBeUndefined();
    expect(handle.nativeSession?.recovery?.decision).toEqual({ mode: 'new', reasons: ['conversationResume:unsupported', 'nativeFork:unsupported'] });
    await expect(registration.adapter.start(f.req)).rejects.toMatchObject({ reason: 'execution_recovery_unsupported' });
    expect(f.factory).toHaveBeenCalledOnce();
  });

  for (const mode of ['auto', 'required'] as const) {
    it(`[case:${mode}-corrupt-source] rejects corrupt archives without silently creating a new session`, async () => {
      const f = await adapterFixture();
      f.readVerifiedArtifact.mockImplementation(async ref => ref.artifactId === 'archive-old' ? Buffer.from('broken') : Buffer.from('{"confirmed":true}'));
      await expect(f.registration().adapter.start({ ...f.req, recovery: { mode, kind: 'conversation', source: f.source } }))
        .rejects.toMatchObject({ reason: 'source_artifact_content_mismatch' });
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
    });
  }

  it('[case:authority-changed] rechecks ownership after Artifact reads and refuses a late old owner before native load', async () => {
    const f = await adapterFixture();
    f.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('owner replaced'));
    await expect(f.registration().adapter.start(f.req)).rejects.toThrow();
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  const invalidLeases: Array<[string, (lease: PiRecoveryWriterLease) => PiRecoveryWriterLease, string]> = [
    ['older-attempt', lease => ({ ...lease, authority: { ...lease.authority, previousAttemptId: 'attempt-other' } }), 'source_not_previous_unfinished_attempt'],
    ['wrong-feature', lease => ({ ...lease, authority: { ...lease.authority, featureId: 'feature-other' } }), 'source_not_previous_unfinished_attempt'],
    ['passed-task', lease => ({ ...lease, authority: { ...lease.authority, taskStatus: 'passed' as 'unfinished' } }), 'source_not_previous_unfinished_attempt'],
    ['wrong-session', lease => ({ ...lease, authority: { ...lease.authority, previousSessionId: 'session-other' } }), 'source_not_previous_unfinished_attempt'],
    ['unknown-stop', lease => ({ ...lease, source: { ...lease.source, previousWriter: { ...lease.source.previousWriter, status: 'unknown' as 'confirmed' } } }), 'source_stop_unconfirmed'],
    ['sdk-version', lease => ({ ...lease, source: { ...lease.source, sdkVersion: '0.0.0' } }), 'native_format_incompatible'],
    ['writer-owner', lease => ({ ...lease, writer: { ...lease.writer, owner: { ...lease.writer.owner, hostInstanceId: 'old-host' } } }), 'native_writer_ownership_mismatch'],
    ['writer-version', lease => ({ ...lease, writer: { ...lease.writer, executionVersion: 1 } }), 'native_writer_ownership_mismatch'],
    ['writer-session', lease => ({ ...lease, writer: { ...lease.writer, sessionId: 'old-session' } }), 'native_writer_ownership_mismatch'],
    ['writer-invocation', lease => ({ ...lease, writer: { ...lease.writer, invocationId: 'old-invocation' } }), 'native_writer_ownership_mismatch'],
    ['source-writable', lease => ({ ...lease, sourceReadOnly: false as true }), 'native_writer_ownership_mismatch'],
    ['not-exclusive', lease => ({ ...lease, writer: { ...lease.writer, exclusive: false as true } }), 'native_writer_ownership_mismatch'],
    ['artifact-project', lease => ({ ...lease, source: { ...lease.source, archive: { ...lease.source.archive, projectId: 'other-project' } } }), 'source_artifact_project_mismatch'],
    ['artifact-identity', lease => ({ ...lease, source: { ...lease.source, archive: { ...lease.source.archive, artifactId: 'other-artifact' } } }), 'source_archive_identity_mismatch'],
    ['stop-artifact', lease => ({ ...lease, source: { ...lease.source, previousWriter: { ...lease.source.previousWriter,
      stopEvidence: { ...lease.source.previousWriter.stopEvidence, contentHash: '0'.repeat(64) } } } }), 'source_artifact_content_mismatch'],
  ];
  for (const [id, change, reason] of invalidLeases) {
    it(`[case:invalid-${id}] refuses unsafe source or writer authority before constructing the SDK`, async () => {
      const f = await adapterFixture();
      f.acquire.mockResolvedValue(change(f.lease));
      await expect(f.registration().adapter.start(f.req)).rejects.toMatchObject({ reason });
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
    });
  }

  for (const [id, patch] of [
    ['project', { sourceProjectId: 'other-project' }], ['task', { sourceTaskId: 'other-task' }],
    ['purpose', { purpose: 'chat', sourceTurnId: 'turn-1' }], ['path', { nativeArchiveRef: '/tmp/native.jsonl' }],
  ] as const) {
    it(`[case:cross-${id}] refuses references outside the assigned Work scope`, async () => {
      const f = await adapterFixture();
      const source = { ...f.source, ...patch } as RuntimeRecoveryReference;
      await expect(f.registration().adapter.start({ ...f.req, recovery: { mode: 'required', kind: 'conversation', source } })).rejects.toThrow();
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.acquire).not.toHaveBeenCalled();
    });
  }

  it('[case:unknown-writer-stop] retains adapter ownership when SDK idle cannot be established', async () => {
    const f = await adapterFixture();
    const create = f.factory.getMockImplementation()!;
    f.factory.mockImplementation(async options => ({ ...await create(options), async waitForIdle() { throw new Error('idle unknown'); } }));
    const handle = await f.registration().adapter.start(f.req);
    await expect(handle.result).resolves.toMatchObject({ terminal: 'failed' });
    await expect(handle.stopped).resolves.toMatchObject({ confirmed: false });
    expect(f.release).not.toHaveBeenCalled();
  });

  it('[case:actual-route-mismatch] refuses a loaded session that retained its old model', async () => {
    const f = await adapterFixture();
    const create = f.factory.getMockImplementation()!;
    f.factory.mockImplementation(async options => ({ ...await create(options), model: { provider: 'old-provider', id: 'old-model' } }));
    await expect(f.registration().adapter.start(f.req)).rejects.toMatchObject({ reason: 'actual_model_configuration_mismatch' });
    expect(f.release).toHaveBeenCalledOnce();
  });
});
