import { stableStringify } from '../../ports/feature-plan.js';
import { validateRuntimeStopEvidence } from '../../ports/runtime-execution.js';
import { validateWorkProcessIdentity, type WorkResourceSnapshot, type WorkResourceStopVerifier } from '../../ports/work-resources.js';
import type { CommandProcessPort } from '../../ports/command-process.js';
import type { FeatureCloseoutKey } from '../../ports/feature-closeout.js';
import type { ArtifactVerifier } from '../../application/artifact-verify.js';
import type { SqliteStorageSession } from './session.js';
import type { FeatureCloseoutLease } from './feature-closeout-lease.js';
import { transactSqliteConsistentRead } from './state-store.js';

type StopRow = { task_id: string; status: string; manual_block: number; execution_version: number;
  attempt_id: string | null; run_id: string; session_id: string; invocation_id: string;
  owner_id: string; host_instance_id: string; result_ref: string | null; session_status: string };

/** A settled Task has no Work leases. Its immutable Runtime stop artifact and
 * the CURRENT Run lease, not revived Task leases, authorize this read-only gate. */
export function createSqliteFeatureCloseoutStopVerifier(options: {
  session: SqliteStorageSession; key: FeatureCloseoutKey; token: FeatureCloseoutLease;
  assertLease(token: FeatureCloseoutLease): void;
  artifacts: Pick<ArtifactVerifier, 'readVerifiedContent'>;
  processes: Pick<CommandProcessPort, 'recoverStop'>;
}): WorkResourceStopVerifier {
  const evidence = new WeakMap<object, WorkResourceSnapshot>();
  const { session, key } = options;
  const rows = (): StopRow[] => transactSqliteConsistentRead(session, 'FeatureCloseout.stop.read', () =>
    session.database.prepare(`SELECT t.id AS task_id,t.status,t.manual_block,t.execution_version,
      a.id AS attempt_id,a.run_id,a.session_id,a.invocation_id,a.owner_id,a.host_instance_id,
      s.result_ref,s.status AS session_status FROM tasks t
      LEFT JOIN attempts a ON a.project_id=t.project_id AND a.task_id=t.id
        AND a.execution_version=t.execution_version AND a.status='succeeded'
      LEFT JOIN sessions s ON s.project_id=a.project_id AND s.id=a.session_id AND s.attempt_id=a.id
      WHERE t.project_id=? AND t.feature_id=? ORDER BY t.id LIMIT 101`).all(key.projectId, key.featureId) as StopRow[]);
  return {
    async verify(snapshot) {
      try {
        const repairs = session.database.prepare('SELECT process_identity,status,stop_confirmed FROM feature_repair_attempts WHERE project_id=? AND run_id=?')
          .all(key.projectId, key.runId) as { process_identity: string | null; status: string; stop_confirmed: number }[];
        for (const repair of repairs) {
          if (!repair.stop_confirmed || !['completed', 'failed', 'interrupted'].includes(repair.status)) return null;
          if (repair.process_identity && !(await options.processes.recoverStop?.(JSON.parse(repair.process_identity)))?.confirmed) return null;
        }
        options.assertLease(options.token);
        if (options.token.signal.aborted || snapshot.identity.projectId !== key.projectId || snapshot.leases.length !== 0
          || snapshot.processIdentity !== null) return null;
        const before = rows();
        if (before.length < 1 || before.length > 100 || before.some(row => row.status !== 'passed' || row.manual_block !== 0
          || !row.attempt_id || !row.result_ref || row.session_status !== 'stopped')) return null;
        const anchor = before.find(row => row.attempt_id === snapshot.identity.attemptId && row.run_id === key.runId);
        if (!anchor || anchor.execution_version !== snapshot.identity.executionVersion || anchor.owner_id !== snapshot.identity.owner
          || anchor.host_instance_id !== snapshot.identity.hostInstanceId || anchor.invocation_id !== snapshot.invocationId) return null;
        for (const row of before) {
          const artifact = await options.artifacts.readVerifiedContent(key.projectId, row.result_ref!);
          if (artifact.projectId !== key.projectId || artifact.artifactId !== row.result_ref) return null;
          const body = JSON.parse(Buffer.from(artifact.content).toString('utf8'));
          const id = body.identity;
          if (body.schemaVersion !== 1 || body.kind !== 'runtime-settlement' || !id
            || id.projectId !== key.projectId || id.runId !== row.run_id || id.taskId !== row.task_id
            || id.attemptId !== row.attempt_id || id.sessionId !== row.session_id || id.invocationId !== row.invocation_id
            || id.executionVersion !== row.execution_version || id.owner !== row.owner_id || id.hostInstanceId !== row.host_instance_id
            || body.stop?.failure !== null || !validateRuntimeStopEvidence(body.stop?.evidence).confirmed) return null;
        }
        // Retained Verifier identities may have descendants even after an old
        // CheckResult was saved. Probe exact persisted identities, never PID alone.
        const processes = session.database.prepare(`SELECT p.process_identity FROM verification_processes p
          JOIN verification_batches b ON b.id=p.batch_id WHERE b.project_id=? AND b.feature_id=?
          ORDER BY p.batch_id,p.check_key LIMIT 257`).all(key.projectId, key.featureId) as { process_identity: string }[];
        if (processes.length > 256 || !options.processes.recoverStop) return null;
        const seen = new Set<string>();
        for (const row of processes) {
          options.assertLease(options.token);
          const identity = validateWorkProcessIdentity(JSON.parse(row.process_identity));
          const id = stableStringify(identity);
          if (seen.has(id)) continue;
          seen.add(id);
          const stopped = await options.processes.recoverStop(identity);
          if (!stopped.confirmed) return null;
        }
        options.assertLease(options.token);
        if (stableStringify(rows()) !== stableStringify(before)) return null;
        const token = Object.freeze({}); evidence.set(token, structuredClone(snapshot)); return token;
      } catch { return null; }
    },
    inspect(token) {
      const snapshot = token !== null && typeof token === 'object' ? evidence.get(token) : undefined;
      if (!snapshot) throw new Error('unverified_feature_closeout_stop');
      return structuredClone(snapshot);
    },
  };
}
