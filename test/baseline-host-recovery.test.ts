import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost, acquireWriterLock, computeStopRequestDigest } from '../packages/host/src/index.ts';
import { loopbackRequest } from './helpers/host/http-probe.ts';
import { createLocalOwnerPrincipal, createStaticRuntimeCapabilityCatalog } from '../packages/core/src/index.ts';
import { createBaselineFixture } from './helpers/p02-3/index.ts';
import type { RunningHost } from '../packages/host/src/index.ts';

const catalog = createStaticRuntimeCapabilityCatalog([]);
const owner = createLocalOwnerPrincipal();
function accepted(r: import('../packages/core/src/index.ts').CommandReceipt) {
  if (r.status !== 'accepted') throw new Error(`Expected accepted, got ${r.status}`);
  return r;
}
async function submit(host: RunningHost, req: unknown) { return accepted(await host.core.baselineExecutionService.submit(owner, req)); }
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });
async function fixture(policy: 'wait' | 'cancel' = 'wait') {
  const box = createBaselineFixture();
  disposers.push(() => box.dispose());
  const root = box.dataRoot();
  let host = await startHost({ dataRoot: root, capabilityCatalog: catalog, env: {}, quiesceBudgetMs: 0, baselineStopPolicy: policy,
    activityGate: { enterQuiesce: () => ({ accepted: 0 }), awaitQuiesce: async () => ({ confirmed: true, pending: [] }) } });
  disposers.push(async () => { await host.core.baselineExecutionService.waitForIdle(); await host.close(); });
  const projectId = (await host.core.projectService.registerRepository({ repositoryPath: box.repos.withHead, displayName: 'recovery' })).project.id;
  return { box, root, projectId, get host() { return host; }, async restart() {
    await host.close(); host = await startHost({ dataRoot: root, capabilityCatalog: catalog, env: {} }); return host;
  } };
}
async function request(host: RunningHost, projectId: string, argv = [process.execPath, '--version']) {
  const plan = { checks: [{ checkKey: 'a', kind: 'command', argv, required: true, timeoutMs: 10_000 }] };
  const preview = await host.core.baselineService.previewBaseline(owner, projectId, { plan });
  return { schemaVersion: 4, commandId: randomUUID(), operation: 'baseline.run', scope: { kind: 'project', projectId }, issuedAt: new Date().toISOString(), payload: { decision: 'authorize', plan, previewDigest: preview.previewDigest } };
}

describe('baseline Host quiesce and restart', () => {
  it('stop cannot use an injected idle gate to bypass a running baseline or release the writer lock', async () => {
    const f = await fixture();
    const r = await submit(f.host, await request(f.host, f.projectId, [process.execPath, '-e', 'console.log("active");setInterval(()=>{},1000)']));
    expect(await f.host.requestSignalShutdown()).toBe('unconfirmed');
    expect(f.host.lifecycleState).toBe('quiescing');
    expect(f.host.core.baselineStore.readBaselineOccupancy().holderOperationId).toBe(r.operationId);
    await expect(f.host.core.baselineExecutionService.submit(owner, await request(f.host, f.projectId))).rejects.toMatchObject({ code: 'resource_busy' });
    await expect(acquireWriterLock({ canonicalRoot: f.root, timeoutMs: 0 })).rejects.toBeDefined();
    await f.host.core.baselineExecutionService.cancel(owner, f.projectId, r.operationId!);
    expect(await f.host.requestSignalShutdown()).toBe('completed');
  });
  it('HTTP stop retains lock during an actual baseline and only the same stop command can finish after confirmed cancellation', async () => {
    const f = await fixture();
    const r = await submit(f.host, await request(f.host, f.projectId, [process.execPath, '-e', 'console.log("active");setInterval(()=>{},1000)']));
    const next = await request(f.host, f.projectId);
    const token = readFileSync(join(f.root, 'host', 'auth.token'), 'utf8');
    const commandId = randomUUID();
    const body = { schemaVersion: 4, commandId, hostInstanceId: f.host.hostInstanceId,
      requestDigest: computeStopRequestDigest(commandId, f.host.hostInstanceId, { mode: 'graceful' }) };
    const stop = () => loopbackRequest({ port: f.host.port, method: 'POST', path: '/v1/host/stop', token, body });
    const first = await stop();
    expect(first.statusCode).toBe(409);
    expect(first.json()).toMatchObject({ error: { code: 'resource_busy', details: { reasonCode: 'quiesce_not_confirmed' } } });
    expect(f.host.lifecycleState).toBe('quiescing');
    expect(f.host.core.baselineStore.readBaselineOccupancy().holderOperationId).toBe(r.operationId);
    await expect(f.host.close()).rejects.toMatchObject({ code: 'resource_busy' });
    await expect(acquireWriterLock({ canonicalRoot: f.root, timeoutMs: 0 })).rejects.toBeDefined();
    expect((await loopbackRequest({ port: f.host.port, method: 'POST', path: '/v1/commands', token, body: next })).statusCode).toBe(503);
    await f.host.core.baselineExecutionService.cancel(owner, f.projectId, r.operationId);
    expect(f.host.core.baselineStore.readBaselineOccupancy().holderOperationId).toBeNull();
    const finished = await stop();
    expect(finished.statusCode).toBe(200);
    expect(finished.json()).toEqual({ commandId, status: 'completed', stopState: 'stopping', replayed: true });
  });
  it('explicit cancel policy stops an actual script before Host teardown', async () => {
    const f = await fixture('cancel');
    const r = await submit(f.host, await request(f.host, f.projectId, [process.execPath, '-e', 'console.log("active");setInterval(()=>{},1000)']));
    // Zero wait budget may reject, but must still fence and request cancellation.
    expect(await f.host.requestSignalShutdown()).toBe('unconfirmed');
    await f.host.core.baselineExecutionService.waitForIdle();
    expect(f.host.core.baselineStore.getBaselineOperation(r.operationId)?.status).toBe('cancelled');
    expect(f.host.core.baselineStore.readBaselineOccupancy().holderOperationId).toBeNull();
    expect(await f.host.requestSignalShutdown()).toBe('completed');
  });
  it('wait policy lets an accepted real command finish without implicitly cancelling it', async () => {
    const f = await fixture();
    const r = await submit(f.host, await request(f.host, f.projectId));
    expect(await f.host.requestSignalShutdown()).toBe('unconfirmed');
    await f.host.core.baselineExecutionService.waitForIdle();
    expect(f.host.core.baselineStore.getBaselineOperation(r.operationId)?.status).toBe('completed');
    expect(f.host.core.baselineStore.listBaselineCheckResults(r.operationId)).toMatchObject([{ status: 'passed' }]);
    expect(await f.host.requestSignalShutdown()).toBe('completed');
  });
  it('saved authorization with no release is interrupted, replay never starts, fresh authorization can execute', async () => {
    const f = await fixture();
    const req = await request(f.host, f.projectId);
    const r = accepted(await f.host.core.commandService.submit(owner, req)); // durable intent only
    await f.host.core.baselineExecutionService.recover();
    await f.restart();
    expect(f.host.core.baselineStore.getBaselineOperation(r.operationId)?.status).toBe('interrupted');
    expect(f.host.core.baselineStore.listBaselineCheckResults(r.operationId)).toMatchObject([{ status: 'inconclusive', reasonCode: 'restart_recovery' }]);
    expect((await f.host.core.baselineExecutionService.submit(owner, req)).replayed).toBe(true);
    expect(f.host.core.baselineExecutionService.activeOperationIds()).toEqual([]);
    expect(f.host.core.baselineStore.readBaselineOccupancy().holderOperationId).toBeNull();
    const fresh = await submit(f.host, await request(f.host, f.projectId));
    await f.host.core.baselineExecutionService.waitForIdle();
    expect(f.host.core.baselineStore.getBaselineOperation(fresh.operationId)?.status).toBe('completed');
  });
  it('completed, declined, failed checks and their immutable artifacts remain queryable after restart', async () => {
    const f = await fixture();
    const success = await submit(f.host, await request(f.host, f.projectId));
    await f.host.core.baselineExecutionService.waitForIdle();
    const failure = await submit(f.host, await request(f.host, f.projectId, [process.execPath, '-e', 'console.log("failed");process.exit(7)']));
    await f.host.core.baselineExecutionService.waitForIdle();
    const declinedReq = await request(f.host, f.projectId);
    const declined = await f.host.core.commandService.submit(owner, { ...declinedReq, payload: { ...declinedReq.payload, decision: 'decline' } });
    if (declined.status !== 'completed') throw new Error('Expected decline completed');
    const before = await f.host.core.artifactStore.listArtifacts(f.projectId);
    writeFileSync(join(f.box.repos.withHead, 'user-change'), 'keep');
    await f.restart();
    expect(f.host.core.baselineStore.listBaselineCheckResults(success.operationId)).toMatchObject([{ status: 'passed' }]);
    expect(f.host.core.baselineStore.listBaselineCheckResults(failure.operationId)).toMatchObject([{ status: 'failed', exitCode: 7 }]);
    expect(f.host.core.baselineStore.getBaselineOperation((declined.result as { operationId: string }).operationId)?.status).toBe('not_run');
    expect(await f.host.core.artifactStore.listArtifacts(f.projectId)).toEqual(before);
    expect(readFileSync(join(f.box.repos.withHead, 'user-change'), 'utf8')).toBe('keep');
    expect(existsSync(join(f.box.repos.withHead, '.git', 'shiploop-baseline.claim'))).toBe(false);
  });
});
