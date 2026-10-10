import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBaselineEvidenceCollector, readBaselineOutput } from '../packages/core/src/application/baseline-evidence.ts';
import { createCommandProcessAdapter } from '../packages/core/src/adapters/process/command-process.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { createArtifactVerifier } from '../packages/core/src/application/artifact-verify.ts';
import { createLocalOwnerPrincipal } from '../packages/core/src/ports/authorization.ts';
import type { CommandProcessHandle, CommandProcessOutput, CommandProcessRequest } from '../packages/core/src/ports/command-process.ts';
import type { ArtifactFileStore } from '../packages/core/src/ports/artifact-files.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const operationId = '11111111-1111-4111-8111-111111111111';
const codeIdentity = { headCommit: 'a'.repeat(40), workingTreeDigest: 'b'.repeat(64), hasUncommittedChanges: false };
const secret = 'synthetic-credential-秘密-123';
function chunk(stream: 'stdout' | 'stderr', text: string): CommandProcessOutput {
  return { stream, bytes: Buffer.from(text) };
}
function fake(parts: CommandProcessOutput[], reason: 'cancelled' | 'timed_out' | null = null, droppedOutputBytes = 0) {
  let cancelled = 0;
  const handle: CommandProcessHandle = {
    identity: { launchId: operationId, pid: 1, processGroupId: 1, startTime: 'test' },
    output: (async function* () { yield* parts; })(),
    result: Promise.resolve({ exitCode: reason ? null : 0, signal: reason ? 'SIGTERM' : null, reason,
      outputBytes: parts.reduce((n, p) => n + p.bytes.length, 0), droppedOutputBytes, stop: { confirmed: true } }),
    stopped: Promise.resolve({ confirmed: true }),
    cancel: async () => { cancelled++; return { accepted: true }; },
    query: () => ({ identity: handle.identity, state: 'stopped', bufferedOutputBytes: 0 }),
  };
  return { handle, cancels: () => cancelled };
}
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); } finally { f.session.close(); f.box.cleanup(); }
}
async function setup() {
  const box = createTempSandbox('shiploop-evidence-');
  const session = openSqliteStorageSession({ path: join(box.path, 'state.db') });
  await migrateSqliteStorage(session);
  session.database.exec("INSERT INTO projects(id,created_at,updated_at,display_name,status,labels) VALUES('p',0,0,'p','active','[]')");
  const artifacts = createSqliteArtifactStore(session);
  const files = createArtifactFileStore({ dataRoot: box.path });
  const request: CommandProcessRequest = { argv: [process.execPath, '-e', 'process.stdout.write("ok")'], cwd: box.path,
    environment: { TOKEN: secret }, timeoutMs: 10_000, maxInputBytes: 65_536, maxOutputBytes: 8_388_608 };
  return { box, session, artifacts, files, request,
    input: { projectId: 'p', operationId, checkKey: 'test', environmentRef: 'approved-env', codeIdentity, request },
    text(id: string) { return readFileSync(join(box.path, 'projects/p/artifacts', id, 'content'), 'utf8'); },
  };
}

describe('baseline bounded redacted evidence', () => {
  it('publishes large real output with bounded tail, actual execution identity and no credentials in any file', async () => fixture(async (f) => {
    const request = { ...f.request, argv: [process.execPath, '-e', `process.stdout.write('x'.repeat(300000));process.stdout.write(process.env.TOKEN);process.stderr.write('Authorization: Bearer unknown-synthetic-secret\\n错误\\n')`] };
    const handle = await createCommandProcessAdapter().start(request, async (i) => ({ launchId: i.launchId }));
    const collector = createBaselineEvidenceCollector({ artifacts: f.artifacts, files: f.files });
    const evidence = await collector.collect({ ...f.input, request, handle });
    expect(evidence.eligibleForPass).toBe(true);
    expect(evidence.integrity.complete).toBe(true);
    expect(evidence.output!.sizeBytes).toBeGreaterThan(300_000);
    expect(Buffer.byteLength(evidence.tail)).toBeLessThanOrEqual(16_384);
    expect(evidence.tailTruncated).toBe(true);
    const output = f.text(evidence.output!.artifactId);
    expect(output).toContain('错误');
    expect(output).toContain('[stdout]');
    expect(output).toContain('[stderr]');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('unknown-synthetic-secret');
    expect(createHash('sha256').update(output).digest('hex')).toBe(evidence.output!.contentHash);
    const report = JSON.parse(f.text(evidence.report!.artifactId));
    expect(report.execution).toMatchObject({ argv: [request.argv[0], '-e', expect.stringContaining('[REDACTED]')],
      argvRedacted: true, argvDigest: createHash('sha256').update(JSON.stringify(request.argv)).digest('hex'),
      cwd: request.cwd, environmentRef: 'approved-env', codeIdentity });
    expect(JSON.stringify(report)).not.toContain('unknown-synthetic-secret');
    expect(report.execution).not.toHaveProperty('environment');
    expect(report).toMatchObject({ exitCode: 0, signal: null, timedOut: false });
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect((await f.files.scanStagingArea('p')).entries).toHaveLength(0);
  }));

  it('preserves complete argv/cwd suffixes resembling a secret prefix, while redacting actual credentials', async () => fixture(async (f) => {
    const request = { ...f.request, cwd: `${f.request.cwd}/s`, argv: ['node', 's', secret] };
    const evidence = await createBaselineEvidenceCollector({ artifacts: f.artifacts, files: f.files }).collect({ ...f.input,
      request, handle: fake([chunk('stdout', 'ok')]).handle });
    expect(evidence.execution.cwd).toBe(request.cwd);
    expect(evidence.execution.argv).toEqual(['node', 's', '[REDACTED]']);
    expect(f.text(evidence.report!.artifactId)).not.toContain(secret);
  }));

  it('handles byte-split UTF-8, mixed streams, overlapping secret prefixes and split authentication headers', async () => fixture(async (f) => {
    const parts: CommandProcessOutput[] = [];
    for (const byte of Buffer.from(`前${secret}后\nAuthorization: Bearer unknown-token\n`)) {
      parts.push({ stream: 'stdout', bytes: Uint8Array.of(byte) });
      parts.push(chunk('stderr', 'e'));
    }
    const collector = createBaselineEvidenceCollector({ artifacts: f.artifacts, files: f.files });
    const evidence = await collector.collect({ ...f.input, protectedValues: [secret.slice(0, 12), secret], handle: fake(parts).handle });
    const text = f.text(evidence.output!.artifactId);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(secret.slice(12));
    expect(text).not.toContain('unknown-token');
    expect(text).not.toContain('�');
    expect(text).toContain('前');
    expect(text).toContain('后');
    expect(evidence.integrity.complete).toBe(true);
  }));

  it.each(['cancelled', 'timed_out'] as const)('publishes partial %s output but cannot pass', async (reason) => fixture(async (f) => {
    const evidence = await createBaselineEvidenceCollector({ artifacts: f.artifacts, files: f.files }).collect({ ...f.input,
      handle: fake([chunk('stdout', `partial ${secret.slice(0, 12)}`)], reason).handle });
    expect(evidence.eligibleForPass).toBe(false);
    expect(evidence.integrity.complete).toBe(false);
    expect(evidence.integrity.gaps).toContain(reason);
    expect(f.text(evidence.output!.artifactId)).toContain('partial');
    expect(f.text(evidence.output!.artifactId)).not.toContain(secret.slice(0, 12));
    expect(evidence.timedOut).toBe(reason === 'timed_out');
  }));

  it('requests safe stop on size/disk limits and never calls dropped output complete', async () => fixture(async (f) => {
    const collector = createBaselineEvidenceCollector({ artifacts: f.artifacts, files: f.files, maxOutputBytes: 100, maxDiskBytes: 65_636 });
    const process = fake([chunk('stdout', 'x'.repeat(101))]);
    const evidence = await collector.collect({ ...f.input, handle: process.handle });
    expect(process.cancels()).toBeGreaterThan(0);
    expect(evidence.integrity.gaps).toContain('output_overflow');
    expect(evidence.eligibleForPass).toBe(false);
    const next = fake([chunk('stdout', 'ok')]);
    const exhausted = await collector.collect({ ...f.input, handle: next.handle });
    expect(exhausted.integrity.gaps).toContain('disk_budget');
    expect(next.cancels()).toBeGreaterThan(0);
    const dropped = await createBaselineEvidenceCollector({ artifacts: f.artifacts, files: f.files }).collect({ ...f.input,
      handle: fake([chunk('stdout', 'ok')], null, 10).handle });
    expect(dropped.integrity.gaps).toContain('output_dropped');
    expect(dropped.eligibleForPass).toBe(false);
  }));

  it.each(['write', 'publish', 'commit'] as const)('keeps real redacted residues on %s failure; recovery never overwrites history', async (fault) => fixture(async (f) => {
    let fired = false;
    const files: ArtifactFileStore = { ...f.files,
      async finishStaging(write) {
        const staged = await f.files.finishStaging(write);
        if (fault === 'write' && !fired) { fired = true; throw new Error(`ENOSPC ${secret}`); }
        return staged;
      },
      async publishStaging(staged, key) {
        if (fault === 'publish' && !fired) { fired = true; throw new Error(`publish ${secret}`); }
        return f.files.publishStaging(staged, key);
      },
    };
    const artifacts = { ...f.artifacts, async transitionArtifact(...args: Parameters<typeof f.artifacts.transitionArtifact>) {
      if (fault === 'commit' && !fired) { fired = true; throw new Error(`commit ${secret}`); }
      return f.artifacts.transitionArtifact(...args);
    } };
    const process = fake([chunk('stdout', `hello ${secret}`)]);
    const evidence = await createBaselineEvidenceCollector({ artifacts, files }).collect({ ...f.input, handle: process.handle });
    expect(evidence.eligibleForPass).toBe(false);
    expect(evidence.integrity.gaps).toContain('publication_failed');
    expect(process.cancels()).toBeGreaterThan(0);
    expect(JSON.stringify(evidence)).not.toContain(secret);
    // A fresh SQLite session, not stale in-memory state, establishes recoverability.
    f.session.close();
    f.session = openSqliteStorageSession({ path: join(f.box.path, 'state.db') });
    f.artifacts = createSqliteArtifactStore(f.session);
    const verifier = createArtifactVerifier({ artifacts: f.artifacts, files: f.files, limits: { maxReadBytes: 8_388_608 } });
    const recovery = await verifier.verifyProject('p');
    const historical = fault === 'commit' ? f.text(evidence.interruptedArtifactId!) : null;
    expect(recovery.orphanPolicy).toBe('kept_in_place');
    if (fault === 'commit') expect(recovery.artifactReports.some((r) => r.kind === 'recovered_ready')).toBe(true);
    else expect((await f.files.scanStagingArea('p')).entries.length).toBeGreaterThan(0);
    for (const entry of (await f.files.scanStagingArea('p')).entries) {
      expect(readFileSync(join(f.box.path, entry.relativePath), 'utf8')).not.toContain(secret);
    }
    const retry = await createBaselineEvidenceCollector({ artifacts: f.artifacts, files: f.files }).collect({ ...f.input,
      handle: fake([chunk('stdout', 'new attempt')]).handle });
    expect(retry.eligibleForPass).toBe(true);
    expect(f.text(retry.output!.artifactId)).toContain('new attempt');
    if (historical !== null) {
      expect(retry.output!.artifactId).not.toBe(evidence.interruptedArtifactId);
      expect(f.text(evidence.interruptedArtifactId!)).toBe(historical);
    }
  }));

  it('rejects oversized secret configuration with a sanitized error even if cancellation rejects', async () => fixture(async (f) => {
    const handle = fake([]).handle;
    await expect(createBaselineEvidenceCollector({ artifacts: f.artifacts, files: f.files }).collect({ ...f.input,
      protectedValues: ['s'.repeat(4097)], handle: { ...handle, cancel: async () => { throw new Error(`Authorization: ${secret}`); } },
    })).rejects.toThrow('Baseline evidence: invalid execution input');
    expect((await f.files.scanStagingArea('p')).entries).toHaveLength(0);
  }));

  it('rejects a competing collector without buffering it or disturbing the active capture', async () => fixture(async (f) => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const arrival = new Promise<void>((resolve) => { entered = resolve; });
    const first = fake([chunk('stdout', 'ok')]);
    const output = { async *[Symbol.asyncIterator]() { entered(); await gate; yield chunk('stdout', 'ok'); } };
    const collector = createBaselineEvidenceCollector({ artifacts: f.artifacts, files: f.files });
    const pending = collector.collect({ ...f.input, handle: { ...first.handle, output } });
    await arrival;
    try {
      const second = fake([chunk('stdout', 'second')]);
      const evidence = await collector.collect({ ...f.input, handle: second.handle });
      expect(evidence.integrity.gaps).toContain('collector_busy');
      expect(evidence.eligibleForPass).toBe(false);
      expect(second.cancels()).toBeGreaterThan(0);
    } finally { release(); }
    expect((await pending).eligibleForPass).toBe(true);
  }));

  it('fails closed on rejected results and unconfirmed stop, without echoing private errors', async () => fixture(async (f) => {
    const normal = await fake([]).handle.result;
    for (const mode of ['rejected', 'uncertain']) {
      const result = mode === 'rejected' ? Promise.reject(new Error(`Authorization: ${secret}`))
        : Promise.resolve({ ...normal, stop: { confirmed: false } });
      const handle = fake([]);
      const evidence = await createBaselineEvidenceCollector({ artifacts: f.artifacts, files: f.files }).collect({ ...f.input,
        handle: { ...handle.handle, result } });
      expect(evidence.eligibleForPass).toBe(false);
      expect(evidence.integrity.gaps).toContain('stop_unconfirmed');
      expect(JSON.stringify(evidence)).not.toContain(secret);
    }
  }));

  it('publishes actual cancelled process output, stops the group, and preserves redacted files', async () => fixture(async (f) => {
    const request = { ...f.request, argv: [process.execPath, '-e', "process.stdout.write('partial '+process.env.TOKEN);setInterval(()=>{},1000)"] };
    const handle = await createCommandProcessAdapter().start(request, async (i) => ({ launchId: i.launchId }));
    const output = { async *[Symbol.asyncIterator]() {
      for await (const part of handle.output) { yield part; await handle.cancel(); }
    } };
    try {
      const evidence = await createBaselineEvidenceCollector({ artifacts: f.artifacts, files: f.files }).collect({ ...f.input, request,
        handle: { ...handle, output } });
      expect((await handle.stopped).confirmed).toBe(true);
      expect(evidence.eligibleForPass).toBe(false);
      expect(evidence.integrity.gaps).toContain('cancelled');
      expect(f.text(evidence.output!.artifactId)).toContain('partial');
      expect(f.text(evidence.output!.artifactId)).not.toContain(secret);
      expect(f.text(evidence.report!.artifactId)).not.toContain(secret);
    } finally { await handle.cancel(); await handle.stopped; }
  }));

  it('handles an actual Writable rejection without exposing its diagnostic or passing', async () => fixture(async (f) => {
    let failOnce = true;
    const files: ArtifactFileStore = { ...f.files, async openStagingWrite(key) {
      const staged = await f.files.openStagingWrite(key);
      if (failOnce) {
        failOnce = false;
        // Real staging fd, failed write callback; finishStaging must close and retain it.
        staged.stream._write = (_bytes, _encoding, callback) => callback(new Error(`ENOSPC Authorization: ${secret}`));
      }
      return staged;
    } };
    const handle = fake([chunk('stdout', `hello ${secret}`)]);
    const evidence = await createBaselineEvidenceCollector({ artifacts: f.artifacts, files }).collect({ ...f.input, handle: handle.handle });
    expect(evidence.eligibleForPass).toBe(false);
    expect(handle.cancels()).toBeGreaterThan(0);
    expect(JSON.stringify(evidence)).not.toContain(secret);
  }));

  it('authorizes ID-only reads, checks baseline ownership, detects missing registered content and invalidates evidence', async () => fixture(async (f) => {
    const collector = createBaselineEvidenceCollector({ artifacts: f.artifacts, files: f.files });
    const evidence = await collector.collect({ ...f.input, handle: fake([chunk('stdout', 'ok')]).handle });
    const checks = { listBaselineCheckResults: () => [{ projectId: 'p', outputArtifactId: evidence.output!.artifactId }] };
    const reader = { artifacts: f.artifacts, files: f.files, checks };
    const owner = createLocalOwnerPrincipal();
    const input = { projectId: 'p', operationId, artifactId: evidence.output!.artifactId };
    expect(Buffer.from(await readBaselineOutput(reader, owner, input)).toString()).toContain('ok');
    await expect(readBaselineOutput(reader, { ...owner, capabilities: new Set() }, input)).rejects.toMatchObject({ code: 'not_found' });
    await expect(readBaselineOutput(reader, owner, { ...input, artifactId: '../secret' })).rejects.toMatchObject({ code: 'not_found' });
    const arbitraryLocator = { ...input, locator: 'secret' };
    await expect(readBaselineOutput(reader, owner, arbitraryLocator)).rejects.toMatchObject({ code: 'not_found' });
    await expect(readBaselineOutput({ ...reader, checks: { listBaselineCheckResults: () => [] } }, owner, input)).rejects.toMatchObject({ code: 'not_found' });
    rmSync(join(f.box.path, 'projects/p/artifacts', evidence.output!.artifactId, 'content'));
    const checked = await collector.verify(evidence);
    expect(checked.eligibleForPass).toBe(false);
    expect(checked.integrity.gaps).toContain('evidence_incomplete');
    await expect(readBaselineOutput(reader, owner, input)).rejects.toMatchObject({ code: 'corrupt_state', details: { reason: 'evidence_incomplete' } });
  }));
});
