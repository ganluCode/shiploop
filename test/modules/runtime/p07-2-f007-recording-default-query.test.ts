import { expect, it, vi } from 'vitest';
import { unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { connectToHost, startHost, type RunningHost } from '../../../packages/host/src/index.ts';
import { createFakeWorkRuntimeFactory, createFakeRuntimeGate } from '../../../packages/core/src/adapters/testing.ts';
import { ArtifactFileError, deriveArtifactFinalRelativePath } from '../../../packages/core/src/ports/artifact-files.ts';
import { DEFAULT_WORK_RECORDING_BOUND_POLICY } from '../../../packages/core/src/ports/work-recording-policy.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { buildWorkRecordingListView, formatWorkRecordingListView } from '../../../packages/cli/src/app/work-recording.ts';
import { openBindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';
import { createLocalOwnerPrincipal } from '../../helpers/p02-2/principals.ts';

for (const scenario of ['normal', 'required-gap', 'best-effort-gap', 'disk'] as const) {
  it(`[case:default-${scenario}] 默认 Host/Core 执行并公开可信前缀、记录模式与停止事实，查询零副作用`, async () => {
    const f = await openBindingFixture({ confirmProjectProfile: true, secondTask: true, secondTaskDependsOnFirst: true });
    let host: RunningHost | undefined;
    const gate = createFakeRuntimeGate();
    let disk: ReturnType<typeof vi.spyOn> | undefined;
    let starts = 0;
    try {
      const base = createFakeWorkRuntimeFactory({ providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
        gates: { begin: gate }, script: { schemaVersion: 1, steps: [
          { op: 'await_gate', name: 'begin' }, { op: 'message', role: 'assistant', text: 'retained public output' },
          { op: 'message', role: 'assistant', text: 'second public output' },
        ], ...(scenario.endsWith('gap') ? { lifecycle: { events: { drop: [1] } } } : {}) } });
      host = await startHost({ dataRoot: f.box.dataRoot,
        capabilityCatalog: createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] }]), env: {},
        ...(scenario === 'best-effort-gap' ? { workRecordingMode: 'best_effort' as const } : {}),
        workRuntimeFactory: context => {
          const runtime = base(context);
          return { ...runtime, entries: runtime.entries.map(entry => ({ ...entry, adapter: { ...entry.adapter,
            async start(request) { starts++; return entry.adapter.start(request); } } })) };
        } });
      if (scenario === 'disk') {
        const original = host.core.artifactFileStore.openStagingWrite.bind(host.core.artifactFileStore);
        disk = vi.spyOn(host.core.artifactFileStore, 'openStagingWrite').mockImplementation(async (key, options) => {
          // Only the file boundary fails. Recorder, publisher, quotas and settlement
          // are the default production implementations; no business rows are seeded.
          const locator = String((key as { locator?: string }).locator);
          if (locator.startsWith('sessions/') && !locator.endsWith('/runtime-settlement.json')) {
            throw new ArtifactFileError('io', 'openStagingWrite', '/private/credential SQL secret', { details: { code: 'ENOSPC' } });
          }
          return original(key, options);
        });
      }
      await host.core.workExecution.scan();
      await expect.poll(() => starts, { timeout: 15_000 }).toBe(1);
      gate.release();
      await expect.poll(() => host!.core.workExecution.activeAttemptIds(), { timeout: 15_000 }).toEqual([]);
      const client = await connectToHost({ canonicalRoot: f.box.dataRoot });
      try {
        const sessionId = (f.query('SELECT id FROM sessions WHERE kind = \'work\'') as { id: string }).id;
        const parent = { sessionId };
        const manifests = await client.listWorkRecordings(f.projectId, { ...parent, recordType: 'manifests' });
        const last = manifests.records.at(-1)!;
        if (!last || !('version' in last)) throw new Error('expected final recording metadata');
        expect(last.finalized).toBe(true);
        expect(last.diagnostics).toContain(scenario === 'best-effort-gap' ? 'recording_mode_best_effort' : 'recording_mode_required');
        expect(last.diagnostics).toContain('stop_observed_confirmed');
        const expectedCoverage = scenario === 'normal' ? 'complete' : scenario === 'best-effort-gap' ? 'partial' : 'failed';
        expect(last.coverage).toBe(expectedCoverage);
        if (scenario.endsWith('gap')) expect(last.missingReasons).toContain('sequence_gap');
        if (scenario === 'required-gap') expect(last.missingReasons).toContain('recording_failed:recording_scope_incomplete');
        if (scenario === 'disk') {
          expect(last.manifestRef).toBeNull();
          expect(last.missingReasons).toEqual(expect.arrayContaining(['publication_file_error', 'evidence_unrecoverable']));
          expect(last.watermark).toBeNull();
        } else {
          expect(last.watermark).toBeGreaterThan(0);
          expect(last.manifestRef).not.toBeNull();
          const body = await client.readWorkRecordingBody(f.projectId, { ...parent, artifactId: last.manifestRef!.artifactId });
          const evidence = JSON.parse(Buffer.from(body.content).toString('utf8'));
          expect(evidence.effectiveLimits).toMatchObject({ version: 1, recorder: DEFAULT_WORK_RECORDING_BOUND_POLICY.recorder,
            publish: DEFAULT_WORK_RECORDING_BOUND_POLICY.publish });
          expect(evidence.identity).toMatchObject({ projectId: f.projectId, sessionId, runId: f.runId });
        }
        const core = await host.core.queryService.listWorkRecording(createLocalOwnerPrincipal(),
          { projectId: f.projectId, ...parent, recordType: 'manifests' });
        expect(core).toEqual(manifests);
        const text = formatWorkRecordingListView(buildWorkRecordingListView(manifests, parent));
        expect(text).toContain(`coverage=${expectedCoverage}`);
        expect(text).toContain('stop_observed_confirmed');
        for (const secret of ['/private', f.box.dataRoot, 'credential', 'SQL secret', 'locator']) expect(text).not.toContain(secret);

        const snapshot = () => (f.session.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
          .map(({ name }) => [name, f.session.database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
        const before = snapshot();
        const messages = await client.listWorkRecordings(f.projectId, { ...parent, recordType: 'messages', limit: 1 });
        if (scenario !== 'disk') {
          expect(messages.records).toHaveLength(1);
          if (scenario === 'normal') {
            expect(messages.nextCursor).not.toBeNull();
            const next = await client.listWorkRecordings(f.projectId,
              { ...parent, recordType: 'messages', limit: 1, cursor: messages.nextCursor! });
            expect(next.records[0]!.id).not.toBe(messages.records[0]!.id);
            expect(next.nextCursor).toBeNull();
            await expect(client.listWorkRecordings(f.projectId,
              { runId: f.runId, recordType: 'messages', cursor: messages.nextCursor! })).rejects.toMatchObject({ code: 'invalid_input' });
          } else expect(messages.nextCursor).toBeNull();
          const message = messages.records[0]!;
          if (!('sequence' in message)) throw new Error('expected message');
          const artifactId = message.contentRef.artifactId;
          await client.readWorkRecordingBody(f.projectId, { ...parent, artifactId });
          const path = join(f.box.dataRoot, deriveArtifactFinalRelativePath({ projectId: f.projectId, artifactId }));
          writeFileSync(path, 'corrupt');
          await expect(client.readWorkRecordingBody(f.projectId, { ...parent, artifactId }))
            .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'recording_body_corrupt' } });
          unlinkSync(path);
          await expect(client.readWorkRecordingBody(f.projectId, { ...parent, artifactId }))
            .rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'recording_body_missing' } });
          await expect(client.readWorkRecordingBody(f.projectId, { sessionId: 'wrong-parent', artifactId }))
            .rejects.toMatchObject({ code: 'not_found' });
        }
        await expect(client.listWorkRecordings(randomUUID(), { ...parent, recordType: 'manifests' }))
          .rejects.toMatchObject({ code: 'not_found' });
        await expect(client.readWorkRecordingBody(f.projectId, { ...parent, artifactId: 'unassociated-artifact' }))
          .rejects.toMatchObject({ code: 'not_found' });
        expect(snapshot()).toEqual(before);
        expect(starts).toBe(1);
        expect(f.query('SELECT runtime_starts, attempts_created FROM execution_batches')).toEqual({ runtime_starts: 1, attempts_created: 1 });
        expect(f.query("SELECT status FROM tasks WHERE id = 't-2'")).toEqual({ status: 'pending' });
        expect(f.query('SELECT count(*) AS n FROM verification_batches')).toEqual({ n: 0 });
      } finally { client.close(); }
    } finally {
      gate.release(); disk?.mockRestore();
      if (host) await host.close();
      f.close();
    }
  }, 60_000);
}
