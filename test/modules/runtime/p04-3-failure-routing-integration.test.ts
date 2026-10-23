import { describe, expect, it, vi } from 'vitest';
import { openCoreApplication, type WorkRuntimeFactory } from '../../../packages/core/src/adapters/composition.ts';
import { createFakeWorkRuntimeFactory } from '../../../packages/core/src/adapters/testing.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { validateRuntimeFallbackPlan } from '../../../packages/core/src/application/runtime-fallback.ts';
import { createLocalOwnerPrincipal } from '../../helpers/p02-2/index.ts';
import { validateWorkSessionDetailWire } from '../../../packages/host/src/client/work-session-wire.ts';
import { BINDING_NOW, openBindingFixture } from '../../helpers/p03-6/input-binding-fixture.ts';

const preferred = { runtime: 'fake', provider: 'test-provider', model: 'fake-model' };
const backup = { ...preferred, model: 'backup-model', credentialRef: 'vault:backup-private', endpointRef: 'endpoint:private' };
const providers = [{ providerId: preferred.provider, models: [preferred.model, backup.model] }];
const plan = () => validateRuntimeFallbackPlan({ schemaVersion: 1,
  preferred: { strategy: preferred, source: 'task.preferred', approved: true },
  fallbacks: [{ strategy: backup, source: 'task.backup', approved: true }],
  policy: { switchOn: ['transient_server', 'transient_connection', 'quota_blocked'] } });
const evidence = { catalogDigest: 'a'.repeat(64), registryDigest: 'b'.repeat(64), authorizationDigest: 'c'.repeat(64) };

async function fixture(options: { reason?: string; unconfirmed?: boolean; denied?: boolean; allFail?: boolean;
  probe?: 'failed' | 'passed' | 'backup-failed'; revoke?: boolean; stale?: boolean; budget?: boolean; pause?: boolean; deadline?: boolean; quiesce?: boolean; unavailable?: boolean } = {}) {
  const f = await openBindingFixture();
  const switches = !(options.denied || options.unconfirmed || options.stale || options.budget || options.revoke || options.pause || options.deadline || options.quiesce || options.unavailable
    || options.probe === 'backup-failed' || options.reason && !['temporary_server_failure', 'connection_interrupted', 'quota_blocked'].includes(options.reason));
  const starts: string[] = [];
  const authorize = vi.fn(async (_input: unknown) =>  !(options.denied || options.revoke && authorize.mock.calls.length > 1));
  const probe = vi.fn(async (input: { strategy: { model: string } }) => ({
    terminal: options.probe === 'failed' || options.probe === 'backup-failed' && input.strategy.model === backup.model ? 'failed' as const : 'completed' as const,
    response: 'OK', usage: { inputTokens: 3, outputTokens: 1, costUsdMicros: 2 } }));
  const factory: WorkRuntimeFactory = context => {
    const make = (failed: boolean) => createFakeWorkRuntimeFactory({ providers,
      script: { schemaVersion: 1, steps: [{ op: 'read_input', purpose: 'requirements' }],
        lifecycle: options.unconfirmed ? { stopped: { unconfirmed: true } } : undefined,
        result: { terminal: failed ? 'failed' : 'completed', reason: failed ? options.reason ?? 'temporary_server_failure' : null,
          exitCode: failed ? 1 : 0, signal: null, durationMs: 1,
          usage: { inputTokens: 2, outputTokens: 1, costUsdMicros: null } } } })(context);
    const bad = make(true), good = make(false);
    return { eventIdentityPrefix: bad.eventIdentityPrefix,
      entries: [{ descriptor: bad.entries[0]!.descriptor, adapter: { async start(request) {
        starts.push(request.strategy.model);
        const handle = await (request.strategy.model === preferred.model || options.allFail ? bad : good).entries[0]!.adapter.start(request);
        return handle;
      } } }],
      failureRouting: { select: () => {
        const selected = plan();
        return { plan: options.unavailable ? { ...selected, fallbacks: [{ ...selected.fallbacks[0]!,
          strategy: { ...backup, model: 'unknown-model' } }] } : selected, policyVersion: 'policy-v1', capabilityEvidence: evidence };
      },
        authorize: async input => {
          if (options.stale) f.session.database.prepare('UPDATE tasks SET execution_version = execution_version + 1 WHERE id = ?').run('t-1');
          if (options.budget) f.session.database.prepare('UPDATE execution_batches SET runtime_starts = 4').run();
          if (options.pause) f.session.database.prepare("UPDATE runs SET status = 'paused', reason = 'user_pause', pause_requested_at = ?").run(BINDING_NOW);
          if (options.deadline) f.session.database.prepare('UPDATE execution_batches SET deadline_at = ?').run(BINDING_NOW);
          if (options.quiesce) core.workExecution.enterQuiesce();
          return authorize(input);
        } },
      inferencePreflight: options.probe ? { policy: { enabled: true }, adapter: { isolation: 'inference_only', probe },
        authorize: async () => true, select: ({ strategy }) => ({ strategy, authenticationRef: 'auth:selected',
          environmentDigest: 'a'.repeat(64), resourceDigest: 'b'.repeat(64) }) } : undefined,
    };
  };
  const core = await openCoreApplication({ dataRoot: f.box.dataRoot, workRuntimeFactory: factory,
    capabilityCatalog: createStaticRuntimeCapabilityCatalog([{ runtimeId: 'fake', providers }]), nowUtcMs: () => BINDING_NOW });
  return { ...f, core, starts, authorize, probe, async run() {
    await core.workExecution.scan();
    await expect.poll(() => f.query('SELECT status FROM attempts ORDER BY number DESC LIMIT 1'), { timeout: 8000 }).toBeDefined();
    try {
      await expect.poll(() => f.query('SELECT COUNT(*) AS n FROM artifacts WHERE kind = ?', 'runtime-settlement'), { timeout: 8000 })
        .toEqual({ n: switches ? 2 : 1 });
    } catch (error) {
      throw new Error(JSON.stringify({ run: f.query('SELECT status, reason FROM runs'),
        attempts: f.session.database.prepare('SELECT status, error_kind FROM attempts').all() }), { cause: error });
    }
    await expect.poll(() => f.query("SELECT COUNT(*) AS n FROM workspace_leases WHERE state = 'held'"), { timeout: 8000 })
      .toEqual({ n: switches && !options.allFail ? 3 : 0 });
  }, async cleanup() {
    const closed = await core.workExecution.close();
    if (options.unconfirmed || options.stale) {
      expect(closed.closed).toBe(false);
      expect(() => core.close()).toThrow('Work 执行须先完成关闭核验');
    } else core.close();
    f.close();
  } };
}

describe('F-007 composed Work failure routing', () => {
  it('[case:root-switch] persists the old failure before a fenced backup start and debits each start once', async () => {
    const f = await fixture();
    try {
      const defaults = f.query('SELECT execution_config FROM tasks WHERE id = ?', 't-1');
      await f.run();
      expect(f.starts).toEqual([preferred.model, backup.model]);
      expect(f.query('SELECT attempts_created, runtime_starts FROM execution_batches')).toEqual({ attempts_created: 2, runtime_starts: 2 });
      // Artifact creation and lease acquisition precede the asynchronous settlement transaction.
      await expect.poll(() => f.session.database.prepare('SELECT status FROM attempts ORDER BY number').all(),
        { timeout: 8_000 }).toEqual([{ status: 'failed' }, { status: 'verifying' }]);
      const rows = f.session.database.prepare('SELECT id, status, execution_version, input_snapshot FROM attempts ORDER BY number').all() as
        { id: string; status: string; execution_version: number; input_snapshot: string }[];
      expect(rows.map(row => row.status)).toEqual(['failed', 'verifying']);
      expect(rows[1]!.execution_version).toBe(rows[0]!.execution_version + 1);
      expect(JSON.parse(rows[1]!.input_snapshot).runtimeFallback).toMatchObject({ strategy: backup,
        previousFailures: [{ category: 'transient_server' }] });
      expect(f.query('SELECT execution_config FROM tasks WHERE id = ?', 't-1')).toEqual(defaults);
      const principal = createLocalOwnerPrincipal();
      for (const row of rows) {
        const detail = await f.core.queryService.getWorkSession(principal, { projectId: f.projectId, attemptId: row.id });
        expect(validateWorkSessionDetailWire(detail)).toEqual(detail);
        expect(detail.resultEvidence).toMatchObject({ recording: { complete: true }, stop: { evidence: { confirmed: true } },
          routing: row.status === 'failed' ? { category: 'transient_server', selected: null }
            : { category: null, previousFailures: [{ category: 'transient_server' }], selected: { model: backup.model, source: 'task.backup' } } });
        expect(JSON.stringify(detail.resultEvidence)).not.toContain('vault:backup-private');
        expect(JSON.stringify(detail.resultEvidence)).not.toContain('endpoint:private');
      }
      expect(f.probe).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  }, 25_000);

  it.each([
    { id: 'unauthorized', denied: true }, { id: 'stop-unconfirmed', unconfirmed: true },
    { id: 'revoked', revoke: true }, { id: 'stale-fence', stale: true }, { id: 'budget', budget: true },
    { id: 'user-pause', pause: true }, { id: 'deadline', deadline: true },
    { id: 'quiesce', quiesce: true }, { id: 'unavailable', unavailable: true },
    { id: 'protocol', reason: 'protocol' }, { id: 'unknown', reason: 'unrecognized' },
    { id: 'authentication', reason: 'authentication' },
  ])('[case:root-$id] never starts a replacement across a rejected boundary', async options => {
    const f = await fixture(options);
    try {
      await f.run();
      expect(f.starts).toEqual([preferred.model]);
      expect(f.query('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
      expect(f.query('SELECT COUNT(*) AS n FROM sessions')).toEqual({ n: 1 });
      if (options.pause) expect(f.query('SELECT status, reason FROM runs')).toEqual({ status: 'paused', reason: 'user_pause' });
      if (options.unconfirmed || options.stale) {
        expect(f.query("SELECT COUNT(*) AS n FROM workspace_leases WHERE state = 'quarantined'")).toEqual({ n: 3 });
      }
    } finally { await f.cleanup(); }
  }, 25_000);

  it.each(['connection_interrupted', 'quota_blocked'])('[case:root-%s] routes the classified terminal without retrying a completed Runner', async reason => {
    const f = await fixture({ reason });
    try {
      await f.run();
      expect(f.starts).toEqual([preferred.model, backup.model]);
    } finally { await f.cleanup(); }
  }, 25_000);

  it('[case:root-preflight-passed] keeps isolated probe usage outside Work counters and probes the selected backup', async () => {
    const f = await fixture({ probe: 'passed' });
    try {
      await f.run();
      expect(f.starts).toEqual([preferred.model, backup.model]);
      expect(f.probe.mock.calls.map(([input]) => input.strategy.model)).toEqual([preferred.model, backup.model]);
      expect(f.query("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'inference_preflight'")).toEqual({ n: 4 });
      const records = f.session.database.prepare("SELECT id FROM artifacts WHERE kind = 'inference_preflight'").all() as { id: string }[];
      const audit = await Promise.all(records.map(async row => JSON.parse(Buffer.from(
        (await f.verifier.readVerifiedContent(f.projectId, row.id)).content).toString('utf8'))));
      expect(audit.filter(record => record.phase === 'finished')).toEqual(Array(2).fill(expect.objectContaining({
        accounting: 'inference_preflight', usage: { inputTokens: 3, outputTokens: 1, costUsdMicros: 2 } })));
      expect(f.probe).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Reply with OK.', maxRetries: 0, maxOutputTokens: 32 }));
      expect(f.query('SELECT runtime_starts, attempts_created FROM execution_batches')).toEqual({ runtime_starts: 2, attempts_created: 2 });
    } finally { await f.cleanup(); }
  }, 25_000);

  it.each(['failed', 'backup-failed'] as const)('[case:root-preflight-%s] denies dispatch before acquiring the next Attempt', async probe => {
    const f = await fixture({ probe });
    try {
      if (probe === 'failed') {
        await f.core.workExecution.scan();
        expect(f.query('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 0 });
        expect(f.starts).toEqual([]);
        expect(f.query('SELECT runtime_starts FROM execution_batches')).toEqual({ runtime_starts: 0 });
      } else {
        await f.run();
        expect(f.starts).toEqual([preferred.model]);
        expect(f.query('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
      }
    } finally { await f.cleanup(); }
  }, 25_000);

  it('[case:root-all-fail] consumes a frozen chain once and pauses without cycling to the preferred model', async () => {
    const f = await fixture({ allFail: true });
    try {
      await f.run();
      await expect.poll(() => f.query('SELECT status FROM runs')).toEqual({ status: 'paused' });
      await f.core.workExecution.scan();
      expect(f.starts).toEqual([preferred.model, backup.model]);
      expect(f.query('SELECT attempts_created, runtime_starts FROM execution_batches')).toEqual({ attempts_created: 2, runtime_starts: 2 });
    } finally { await f.cleanup(); }
  }, 25_000);
});
