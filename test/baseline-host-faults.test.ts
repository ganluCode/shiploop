import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost, acquireWriterLock } from '../packages/host/src/index.ts';
import type { RunningHost } from '../packages/host/src/index.ts';
import { createLocalOwnerPrincipal, createStaticRuntimeCapabilityCatalog } from '../packages/core/src/index.ts';
import type { CommandProcessIdentity } from '../packages/core/src/index.ts';
import { createCommandProcessAdapter } from '../packages/core/src/adapters/process/command-process.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { createBaselineFixture } from './helpers/p02-3/index.ts';

const childEntry = fileURLToPath(new URL('./helpers/p02-3/baseline-host-fault-child.ts', import.meta.url));
const owner = createLocalOwnerPrincipal();
const catalog = createStaticRuntimeCapabilityCatalog([]);
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(disposers.splice(0).reverse().map(dispose => dispose()));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
});
async function fault(mode: string) {
  const box = createBaselineFixture();
  const root = box.dataRoot();
  const script = join(box.repos.withHead, 'baseline.cjs');
  const counter = join(box.root, 'launch-count');
  const release = join(box.root, 'release');
  writeFileSync(join(box.repos.withHead, 'README.md'), 'pre-existing tracked modification');
  writeFileSync(script, [
    'const fs = require("fs")',
    'fs.appendFileSync(process.argv[2], "start\\n")',
    'fs.writeFileSync("user-change", "preserved")',
    'console.log("partial evidence retained")',
    'if (process.argv[4] !== "once") setInterval(() => { if (fs.existsSync(process.argv[3])) process.exit(0) }, 10)',
  ].join('\n'));
  const child = box.hostProcesses.spawn({ scriptPath: childEntry, cwd: box.root, env: box.childEnv(),
    config: { root, repositoryPath: box.repos.withHead, script, counter, release, mode } });
  let host: RunningHost | undefined;
  let savedIdentity: CommandProcessIdentity | undefined;
  disposers.push(async () => {
    writeFileSync(release, 'release');
    if (child.isAlive()) { child.kill('SIGKILL'); await child.exited; }
    if (savedIdentity) expect((await createCommandProcessAdapter().recoverStop!(savedIdentity)).confirmed).toBe(true);
    if (host) {
      const slot = host.core.baselineStore.readBaselineOccupancy();
      if (slot.holderOperationId && savedIdentity) {
        const session = openSqliteStorageSession({ path: host.core.pathService.databaseFilePath() });
        try { createSqliteAtomicCommandStore(session).transact('restore-identity', tx =>
          tx.heartbeatBaselineOccupancy(slot.holderOperationId!, { ...slot.processIdentity, ...savedIdentity })); }
        finally { session.close(); }
      }
      await host.core.baselineExecutionService.recover();
      await host.close();
    }
    await box.dispose();
  });
  await child.waitReady(); child.releaseGo();
  const checkpoint = await child.waitMessage('checkpoint', 15_000) as unknown as {
    projectId: string; operationId: string; request: unknown; identity?: CommandProcessIdentity;
  };
  savedIdentity = checkpoint.identity;
  return { box, root, script, counter, release, child, checkpoint,
    count: () => existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').length : 0,
    async killHost() { expect(child.kill('SIGKILL')).toBe(true); expect((await child.exited).signal).toBe('SIGKILL'); },
    async restart() {
      host = await startHost({ dataRoot: root, capabilityCatalog: catalog, env: {}, quiesceBudgetMs: 0 });
      return host;
    },
  };
}
async function fresh(host: RunningHost, f: Awaited<ReturnType<typeof fault>>) {
  const plan = { checks: [{ checkKey: 'a', kind: 'command', argv: [process.execPath, f.script, f.counter, f.release, 'once'],
    required: true, timeoutMs: 10_000 }] };
  const preview = await host.core.baselineService.previewBaseline(owner, f.checkpoint.projectId, { plan });
  return { schemaVersion: 4, commandId: randomUUID(), operation: 'baseline.run', issuedAt: new Date().toISOString(),
    scope: { kind: 'project', projectId: f.checkpoint.projectId }, payload: { decision: 'authorize', plan, previewDigest: preview.previewDigest } };
}

describe('owned Host real baseline crash boundaries', () => {
  for (const mode of ['running', 'intent', 'pre-release', 'result-uncommitted']) {
    it(`SIGKILL Host at ${mode}: verify old group, preserve evidence and never replay commandId`, async () => {
      const f = await fault(mode);
      const initialCount = mode === 'intent' || mode === 'pre-release' ? 0 : 1;
      expect(f.count()).toBe(initialCount);
      await f.killHost();
      const host = await f.restart();
      expect(host.core.baselineStore.getBaselineOperation(f.checkpoint.operationId)).toMatchObject({ status: 'interrupted', reasonCode: 'restart_recovery' });
      expect(host.core.baselineStore.listBaselineCheckResults(f.checkpoint.operationId)).toMatchObject([{ status: 'inconclusive', reasonCode: 'restart_recovery' }]);
      expect(host.core.baselineStore.readBaselineOccupancy().holderOperationId).toBeNull();
      expect(existsSync(join(f.box.repos.withHead, '.git', 'shiploop-baseline.claim'))).toBe(false);
      if (f.checkpoint.identity) expect((await createCommandProcessAdapter().recoverStop!(f.checkpoint.identity)).confirmed).toBe(true);
      expect(readFileSync(join(f.box.repos.withHead, 'README.md'), 'utf8')).toBe('pre-existing tracked modification');
      if (initialCount) expect(readFileSync(join(f.box.repos.withHead, 'user-change'), 'utf8')).toBe('preserved');
      if (mode === 'running') {
        const check = host.core.baselineStore.listBaselineCheckResults(f.checkpoint.operationId)[0];
        expect(check.outputArtifactId).not.toBeNull();
        const content = await host.core.artifactFileStore.openFinalRead({ projectId: f.checkpoint.projectId, artifactId: check.outputArtifactId });
        let text = '';
        for await (const chunk of content.stream) text += String(chunk);
        expect(text).toContain('partial evidence retained');
      }
      if (mode === 'result-uncommitted') {
        expect(host.core.baselineStore.listBaselineCheckResults(f.checkpoint.operationId)[0].outputArtifactId).not.toBeNull();
        expect((await host.core.artifactStore.listArtifacts(f.checkpoint.projectId)).records.some(a => a.kind === 'baseline-evidence' && a.status === 'ready')).toBe(true);
      }
      expect((await host.core.baselineExecutionService.submit(owner, f.checkpoint.request)).replayed).toBe(true);
      expect(f.count()).toBe(initialCount);
      expect(host.core.baselineExecutionService.activeOperationIds()).toEqual([]);
      const receipt = await host.core.baselineExecutionService.submit(owner, await fresh(host, f));
      expect(receipt.status).toBe('accepted');
      await host.core.baselineExecutionService.waitForIdle();
      expect(f.count()).toBe(initialCount + 1);
    }, 30_000);
  }
  it('unverifiable durable identity retains actual frozen supervisor, claims and Host lock; no new launch', async () => {
    const f = await fault('running');
    f.child.send({ kind: 'freeze' }); await f.child.waitMessage('frozen');
    await f.killHost();
    const app = await import('../packages/core/src/adapters/composition.ts').then(m =>
      m.openCoreApplication({ dataRoot: f.root, capabilityCatalog: catalog }));
    const db = openSqliteStorageSession({ path: app.pathService.databaseFilePath() });
    try {
      const slot = app.baselineStore.readBaselineOccupancy();
      createSqliteAtomicCommandStore(db).transact('tamper-identity', tx =>
        tx.heartbeatBaselineOccupancy(f.checkpoint.operationId, { ...slot.processIdentity, startTime: 'unverifiable' }));
    } finally { db.close(); app.close(); }
    const host = await f.restart();
    expect(host.core.baselineStore.getBaselineOperation(f.checkpoint.operationId)).toMatchObject({ status: 'interrupted', reasonCode: 'stop_unconfirmed' });
    expect(host.core.baselineStore.readBaselineOccupancy().holderOperationId).toBe(f.checkpoint.operationId);
    expect(existsSync(join(f.box.repos.withHead, '.git', 'shiploop-baseline.claim'))).toBe(true);
    expect(() => process.kill(f.checkpoint.identity!.pid, 0)).not.toThrow();
    await expect(host.core.baselineExecutionService.submit(owner, await fresh(host, f))).rejects.toMatchObject({ code: 'resource_busy' });
    expect(f.count()).toBe(1);
    expect(await host.requestSignalShutdown()).toBe('unconfirmed');
    await expect(host.close()).rejects.toMatchObject({ code: 'resource_busy' });
    await expect(acquireWriterLock({ canonicalRoot: f.root, timeoutMs: 0 })).rejects.toBeDefined();
    expect(readFileSync(join(f.box.repos.withHead, 'user-change'), 'utf8')).toBe('preserved');
  }, 30_000);
  it('supervisor exits while child is alive: no PID-only kill or idle bypass; release only after group absence', async () => {
    const f = await fault('running');
    f.child.send({ kind: 'lose-supervisor' }); await f.child.waitMessage('supervisor-lost', 12_000);
    await f.killHost();
    const host = await f.restart();
    expect(host.core.baselineStore.readBaselineOccupancy().holderOperationId).toBe(f.checkpoint.operationId);
    await expect(host.core.baselineExecutionService.submit(owner, await fresh(host, f))).rejects.toMatchObject({ code: 'resource_busy' });
    expect(f.count()).toBe(1);
    writeFileSync(f.release, 'release');
    expect((await createCommandProcessAdapter().recoverStop!(f.checkpoint.identity)).confirmed).toBe(true);
    expect((await host.core.baselineExecutionService.recover()).confirmed).toBe(true);
    expect(host.core.baselineStore.readBaselineOccupancy().holderOperationId).toBeNull();
    expect(readFileSync(join(f.box.repos.withHead, 'user-change'), 'utf8')).toBe('preserved');
  }, 30_000);
});
