import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import type { CommandProcessHandle, CommandProcessIdentity } from '../../../packages/core/src/ports/command-process.ts';
import { createSqliteWorkResourceAccess } from '../../../packages/core/src/adapters/sqlite/work-resources.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { createWorkResourceStopVerifier } from '../../../packages/core/src/application/work-resource-stop.ts';
import { addMcpStdioProcesses, createMcpStdioConnection, createMcpStdioProcessRegistry, recoverMcpStdioProcess, type McpStdioProcessRegistration } from '../../../packages/host/src/runtime/mcp-stdio.ts';
import { BINDING_NOW, openBindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';
import { mcpWorkFixture } from '../../helpers/p06-4/pi-mcp-fixture.ts';
import { processRows, until } from '../../helpers/process-matrix.ts';
import { prepareMcpStartupPlan } from '../../../packages/host/src/runtime/mcp-startup-plan.ts';
import { saveResourceEvidence } from '../../helpers/p06-7/resource-scenario.ts';

interface RunnerMarker { root: string; registryPath: string; registration: McpStdioProcessRegistration; childPid: number }

it('[case:p06-f005-runner-kill-host-rebuild] rebuilt Host recovers real orphan MCP descendants and retains SQLite quarantine when census cannot confirm stop', async () => {
  const core = await openBindingFixture({ secondTask: true });
  const f = await mcpWorkFixture({ projectId: core.projectId });
  const port = createCommandProcessAdapter({ stopGraceMs: 200, stopConfirmMs: 1000 });
  let handle: CommandProcessHandle | undefined;
  let drain: Promise<void> | undefined;
  let marker: RunnerMarker | undefined;
  const output: string[] = [];
  try {
    const bound = core.claimAndLaunch('t-1');
    const attempt = bound.receipt.attempt;
    const identity = { projectId: core.projectId, attemptId: attempt.id, owner: attempt.owner,
      hostInstanceId: attempt.hostInstanceId, executionVersion: attempt.executionVersion };
    const request = { ...f.request, featureId: core.featureId, sessionId: `stage-${attempt.id}`, invocationId: bound.invocationId,
      identity: { purpose: 'work', runId: core.runId, taskId: 't-1', attemptId: attempt.id }, executionVersion: attempt.executionVersion,
      owner: { principalId: attempt.owner, hostInstanceId: attempt.hostInstanceId },
      workAccess: { ...f.snapshot, runId: core.runId, taskId: 't-1', attemptId: attempt.id,
        invocationId: bound.invocationId, executionVersion: attempt.executionVersion,
        owner: { principalId: attempt.owner, hostInstanceId: attempt.hostInstanceId } } };
    const markerPath = join(f.box.path, 'runner-ready.json');
    handle = await port.start({ argv: [process.execPath, '--experimental-transform-types', '--import',
      fileURLToPath(new URL('../../helpers/node-ts-loader/register.mjs', import.meta.url)),
      fileURLToPath(new URL('../../helpers/p06-7/resource-runner-child.ts', import.meta.url)), markerPath],
      cwd: process.cwd(), environment: {}, stdin: Buffer.from(JSON.stringify(request)),
      timeoutMs: 15_000, maxInputBytes: 65_536, maxOutputBytes: 100_000 }, async processIdentity => {
      const ack = core.session.transactWrite('F005.confirmRunner', () => core.createResources().confirmLaunchInTransaction(identity, processIdentity));
      if (!ack.authorized) throw new Error('Runner launch was fenced');
      return { launchId: processIdentity.launchId };
    });
    const current = handle;
    drain = (async () => { for await (const chunk of current.output) output.push(Buffer.from(chunk.bytes).toString('utf8')); })();
    await until(() => existsSync(markerPath), 'real Runner and MCP ready', 8000);
    marker = JSON.parse(readFileSync(markerPath, 'utf8')) as RunnerMarker;
    expect(marker.registration).toMatchObject({ projectId: core.projectId, sessionId: request.sessionId,
      invocationId: bound.invocationId, executionVersion: attempt.executionVersion });
    const before = await processRows();
    expect(before.some(row => row.pid === marker!.childPid && row.processGroupId === marker!.registration.processIdentity.processGroupId)).toBe(true);
    process.kill(-handle.identity.processGroupId, 'SIGKILL');
    const runnerResult = await handle.result;
    await drain;
    expect(runnerResult.stop.confirmed).toBe(true);
    // Runner stop alone leaves the detached MCP server and child alive.
    const orphans = (await processRows()).filter(row => row.processGroupId === marker!.registration.processIdentity.processGroupId);
    expect(orphans.map(row => row.pid)).toEqual(expect.arrayContaining([marker.registration.processIdentity.pid, marker.childPid]));

    const registry = createMcpStdioProcessRegistry({ path: marker.registryPath });
    const registration = marker.registration;
    expect(registry.list(registration)).toEqual([registration]);
    expect(registry.list({ ...registration, invocationId: 'other-invocation' })).toEqual([]);
    const restarted = openSqliteStorageSession({ path: core.box.dbPath });
    try {
      let finalized = 0;
      // Fault injection is confined to missing census evidence; SQLite/Git/OS remain real.
      const verifier = createWorkResourceStopVerifier({ process: { recoverStop: async processIdentity =>
        (processIdentity as CommandProcessIdentity)?.pid === registration.processIdentity.pid ? { confirmed: false } : port.recoverStop!(processIdentity) },
      finalize: async () => { finalized++; return true; } });
      const resources = createSqliteWorkResourceAccess(restarted, { workspaceAuthority: core.authority,
        stopVerifier: verifier, nowUtcMs: () => BINDING_NOW });
      restarted.transactWrite('F005.quarantine', () => resources.quarantineInTransaction(identity));
      const snapshot = addMcpStdioProcesses(resources.read(identity), registry, registration);
      expect(snapshot.leases.map(lease => lease.state)).toEqual(['quarantined', 'quarantined', 'quarantined']);
      expect(await verifier.verify(snapshot)).toBeNull();
      expect(finalized).toBe(0);
      expect(() => restarted.transactWrite('F005.refuseForgedStop', () => resources.releaseStoppedInTransaction(identity, { confirmed: true }))).toThrow();
      expect(await registry.recover(registration, async () => ({ confirmed: false }))).toMatchObject({ confirmed: false });
      expect(createMcpStdioProcessRegistry({ path: marker.registryPath }).list(registration)).toEqual([registration]);
      expect(() => core.claimTask('t-2')).toThrow();
      expect(core.query('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
      expect(resources.read(identity).leases).toEqual(snapshot.leases);
      const recovered = await registry.recover(registration);
      expect(recovered.confirmed).toBe(true);
      expect(createMcpStdioProcessRegistry({ path: marker.registryPath }).list(registration)).toEqual([]);
      const after = await processRows();
      expect(after.some(row => row.processGroupId === registration.processIdentity.processGroupId)).toBe(false);
      expect(after.some(row => row.pid === marker!.childPid)).toBe(false);
      // Physical cleanup does not grant business authorization or erase uncertainty.
      expect(resources.read(identity).leases.map(lease => lease.state)).toEqual(['quarantined', 'quarantined', 'quarantined']);
      expect(() => core.claimTask('t-2')).toThrow();
      saveResourceEvidence('runner-kill-host-rebuild', { runner: { identity: handle.identity, result: runnerResult }, registration,
        childPid: marker.childPid, orphanPids: orphans.map(row => row.pid), rebuiltRegistry: true,
        uncertain: { stopToken: null, finalizeCalls: finalized, leases: snapshot.leases, attempts: 1 },
        cleanup: { recovered, groupAbsent: true, childAbsent: true, registryEmpty: true, businessQuarantineRetained: true },
        osIsolation: { mode: 'trusted_project', strongSandbox: false } });
    } finally { restarted.close(); }
  } finally {
    if (handle) { await handle.cancel(); await handle.result; }
    await drain;
    if (!marker && existsSync(join(f.box.path, 'runner-ready.json'))) marker = JSON.parse(readFileSync(join(f.box.path, 'runner-ready.json'), 'utf8'));
    if (marker) {
      const stopped = await recoverMcpStdioProcess(marker.registration.processIdentity);
      if (!stopped.confirmed) throw new Error(`Owned MCP cleanup unconfirmed: ${marker.root}`);
      rmSync(marker.root, { recursive: true, force: true });
    }
    await f.cleanup();
    core.close();
  }
}, 25_000);

it.each(['identity-mismatch', 'census-failure', 'term-escalation'] as const)(
  '[case:p06-f005-recovery-%s] rechecks actual ownership and preserves registration until bounded group absence is proven', async mode => {
    const f = await mcpWorkFixture({ server: { ignoreTerminate: true, spawnChild: true } });
    const plan = await prepareMcpStartupPlan(f.request, { resolver: f.assembly.mcp!.resolver });
    const connection = createMcpStdioConnection({ ...f.assembly.mcp!, plan, handshakeTimeoutMs: 2000, closeTimeoutMs: 200 });
    try {
      await connection.start();
      const registration = f.registrations[0]!;
      const registry = createMcpStdioProcessRegistry({ path: join(f.box.path, 'registry.json') });
      const observed = mode === 'identity-mismatch' ? { ...registration.processIdentity, startTime: 'Mon Jan  1 00:00:00 2001' } : registration.processIdentity;
      const result = await recoverMcpStdioProcess(observed, { closeTimeoutMs: 100,
        ...(mode === 'census-failure' ? { processInspector: {
          identify: async () => observed, matches: async () => true,
          groupAbsent: async () => { throw new Error('census unavailable'); },
        } } : {}) });
      if (mode === 'term-escalation') {
        expect(result.confirmed).toBe(true);
        expect(existsSync(join(f.box.path, 'terminate.entered'))).toBe(true);
        expect((await processRows()).some(row => row.processGroupId === registration.processIdentity.processGroupId)).toBe(false);
        expect(await registry.markStopped(registration, result)).toBe(true);
      } else {
        expect(result).toMatchObject({ confirmed: false, status: 'unconfirmed' });
        expect(registry.list(registration)).toEqual([registration]);
        expect((await processRows()).some(row => row.pid === registration.processIdentity.pid)).toBe(true);
        expect(existsSync(join(f.box.path, 'terminate.entered'))).toBe(false);
      }
      saveResourceEvidence(`recovery-${mode}`, { registration, result, retained: registry.list(registration).length });
    } finally { await connection.close(); await f.cleanup(); }
  }, 15_000);
