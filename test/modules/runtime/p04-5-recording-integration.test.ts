import { afterEach, expect, it } from 'vitest';
import { startHost, connectToHost, type RunningHost, type HostClient } from '../../../packages/host/src/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { createFakeWorkRuntimeFactory } from '../../../packages/core/src/adapters/testing.ts';
import { openBindingFixture, BINDING_NOW, type BindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';

let fixture: BindingFixture | undefined;
let host: RunningHost | undefined;
let client: HostClient | undefined;
afterEach(async () => {
  client?.close(); client = undefined;
  if (host) { await host.close(); host = undefined; }
  fixture?.close(); fixture = undefined;
});

it('[case:production-recording] publishes queryable bodies and indexes through the production Work composition', async () => {
  fixture = await openBindingFixture({ secondTask: true, secondTaskDependsOnFirst: true });
  host = await startHost({ dataRoot: fixture.box.dataRoot, capabilityCatalog: createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers: [{ providerId: 'test-provider', models: ['fake-model'] }] }]),
    env: {}, workRuntimeFactory: createFakeWorkRuntimeFactory({
      providers: [{ providerId: 'test-provider', models: ['fake-model'] }],
      script: { schemaVersion: 1, steps: [{ op: 'message', role: 'assistant', text: '公开正文' }] },
    }) });
  client = await connectToHost({ canonicalRoot: fixture.box.dataRoot });
  await host.core.workExecution.scan();
  await expect.poll(() => fixture!.query('SELECT count(*) AS n FROM attempts'), { timeout: 10_000 }).toEqual({ n: 1 });
  await expect.poll(() => host!.core.workExecution.activeAttemptIds(), { timeout: 10_000 }).toEqual([]);
  const page = await client.listWorkRecordings(fixture.projectId, { runId: fixture.runId, recordType: 'messages' });
  expect(page.records.length).toBeGreaterThan(0);
  expect(page.records).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'message', role: 'assistant', coverage: 'complete' })]));
});
