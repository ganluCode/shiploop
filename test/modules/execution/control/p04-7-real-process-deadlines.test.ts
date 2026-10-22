import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCommandProcessAdapter } from '../../../../packages/core/src/adapters/process/command-process.ts';
import { BINDING_NOW } from '../../../helpers/p03-6/input-binding-fixture.ts';
import { fixture } from '../../../helpers/p03-6/stopping-fixture.ts';
import { matrixFileInventory, matrixWriter, withProcessMatrix } from '../../../helpers/process-matrix.ts';

describe.skipIf(process.platform !== 'darwin')('P04-7 real process layered deadlines', () => {
  for (const layer of ['tool', 'session', 'run', 'batch'] as const) {
    it(`[case:deadline-${layer}] records ${layer} timeout only after the writing tree stops`, async () => {
      await withProcessMatrix(`deadline-${layer}`, async matrix => {
        const processPort = createCommandProcessAdapter({ stopGraceMs: 200, stopConfirmMs: 2_000 });
        const f = await fixture({
          commandProcess: { ...processPort, async start(request, confirm) {
            const handle = await processPort.start(request, async identity => {
              await matrix.own(identity);
              return confirm(identity);
            });
            await matrix.own(handle.identity, handle);
            return handle;
          } },
          script: { schemaVersion: 1, steps: [
            { op: 'tool_command', name: 'writers' },
            { op: 'write_file', path: 'forbidden-after-timeout', content: 'bad' },
          ] },
          toolCommands: { writers: { argv: [process.execPath, matrixWriter, matrix.root, 'graceful'], timeoutMs: 30_000 } },
        });
        let complete = false;
        try {
          if (layer === 'run') f.session.database.prepare('UPDATE runs SET started_at = ?').run(BINDING_NOW - 3_600_000 + 2_000);
          if (layer === 'batch') f.session.database.prepare('UPDATE execution_batches SET deadline_at = ?').run(BINDING_NOW + 2_000);
          const { context } = await f.start({ limits: {
            timeoutMs: layer === 'session' ? 2_000 : 20_000,
            ...(layer === 'tool' ? { toolTimeoutMs: 2_000 } : {}), maxEvents: 100, maxOutputBytes: 1_048_576,
          } });
          await matrix.writersReady();
          const before = f.query('SELECT COUNT(*) AS n FROM workspace_leases');
          expect(before).toEqual({ n: 3 });
          const completion = await context.completion;
          expect(completion).toMatchObject({ stopConfirmed: true, persisted: true, retained: true, recordingFlushed: true });
          const { result_ref: ref } = f.query('SELECT result_ref FROM sessions') as { result_ref: string };
          const evidence = await f.readArtifact(ref);
          expect(evidence.control).toMatchObject({
            reason: layer === 'tool' ? 'tool_timeout' : layer === 'session' ? 'runtime_timeout' : 'parent_deadline',
            timeout: { layer, stage: 'runtime', limitMs: 2_000 },
          });
          expect(evidence.control.timeout.elapsedMs).toBeGreaterThanOrEqual(2_000);
          expect(f.query('SELECT status, error_kind FROM attempts')).toEqual({ status: 'failed', error_kind: 'timeout' });
          expect(f.query('SELECT COUNT(*) AS n FROM workspace_leases')).toEqual({ n: 0 });
          expect(f.query('SELECT COUNT(*) AS n FROM attempts')).toEqual({ n: 1 });
          expect(existsSync(join(f.workspace.canonicalPath, 'forbidden-after-timeout'))).toBe(false);
          // Late cancellation cannot replace the original timeout layer or create another Attempt.
          await f.service.cancel(f.identity);
          expect((await f.readArtifact(ref)).control).toEqual(evidence.control);
          matrix.record('pass', { layer, evidence, completion });
          matrix.resource({ root: f.box.root, files: matrixFileInventory(f.box.root), before, attempts: f.session.database.prepare('SELECT * FROM attempts').all(),
            sessions: f.session.database.prepare('SELECT * FROM sessions').all(),
            workspaces: f.session.database.prepare('SELECT * FROM managed_workspaces').all() });
          complete = true;
        } finally {
          if (complete) { await f.dispose(); matrix.resource({ root: f.box.root, removed: !existsSync(f.box.root) }); }
          else {
            await f.service.close();
            matrix.resource({ root: f.box.root, retained: true, leases: f.session.database.prepare('SELECT * FROM workspace_leases').all() });
            f.session.close();
          }
        }
      });
    }, 20_000);
  }
});
