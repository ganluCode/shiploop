import type Database from 'better-sqlite3';
import { computeExecutionStrategyCopyDigest } from '../../ports/execution-input-prepare.js';
import { notificationIdentity } from './notification-identity.js';

/** Bounded metadata projection at the source event boundary; never scan transcripts. */
export function enrichTaskNotification(db: Database.Database, projectId: string | null,
  summary: Readonly<Record<string, unknown>>, occurredAt: number): Readonly<Record<string, unknown>> {
  if (projectId === null) return summary;
  const identity = notificationIdentity(db, projectId, summary);
  if (!identity) return summary;
  summary = { ...summary, ...identity, occurredAt: new Date(occurredAt).toISOString() };
  if (summary.kind !== 'task_terminal') {
    return summary;
  }
  const task = db.prepare(`SELECT t.feature_id,t.complexity,t.execution_config,t.config_source,t.config_source_key,p.display_name
    FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.project_id=? AND t.id=?`)
    .get(projectId, summary.taskId) as { feature_id: string; complexity: string | null;
      execution_config: string; config_source: string; config_source_key: string | null; display_name: string } | undefined;
  if (!task) return summary;
  const cutoff = db.prepare('SELECT number FROM attempts WHERE project_id=? AND task_id=? AND run_id=? AND id=?')
    .get(projectId, summary.taskId, summary.runId, summary.attemptId) as { number: number } | undefined;
  if (!cutoff) return summary;
  const attempts = db.prepare(`SELECT a.input_snapshot,a.host_instance_id,a.usage_summary,s.runtime,
    s.started_at,s.ended_at,s.id AS session_id FROM attempts a LEFT JOIN sessions s ON s.project_id=a.project_id AND s.id=a.session_id
    WHERE a.project_id=? AND a.task_id=? AND a.run_id=? AND a.number<=? ORDER BY a.number LIMIT 101`)
    .all(projectId, summary.taskId, summary.runId, cutoff.number) as {
      input_snapshot: string; host_instance_id: string; usage_summary: string | null; runtime: string | null;
      started_at: number | null; ended_at: number | null; session_id: string | null;
    }[];
  const models = new Set<string>();
  let input = 0, output = 0, measured = 0, duration = 0, timed = 0;
  let connections = 0, connectionMeasured = 0, connectionComplete = 0;
  for (const row of attempts.slice(0, 100)) {
    const snapshot = JSON.parse(row.input_snapshot);
    const config = JSON.parse(task.execution_config);
    const primaryMatches = snapshot.digests?.strategyCopyDigest === computeExecutionStrategyCopyDigest({
      executionConfig: config, configSource: task.config_source, configSourceKey: task.config_source_key,
    });
    const selected = snapshot.runtimeFallback?.strategy ?? (primaryMatches ? config : null);
    if (typeof selected?.provider === 'string' && typeof selected.model === 'string') models.add(`${selected.provider}/${selected.model}`.slice(0, 128));
    if (row.started_at !== null && row.ended_at !== null && row.ended_at >= row.started_at) {
      duration += row.ended_at - row.started_at; timed++;
    }
    const usage = row.usage_summary === null ? null : JSON.parse(row.usage_summary);
    const recording = row.session_id === null ? undefined : db.prepare(`SELECT diagnostics,coverage FROM recording_manifests
      WHERE project_id=? AND session_id=? AND finalized=1 ORDER BY version DESC LIMIT 1`)
      .get(projectId, row.session_id) as { diagnostics: string; coverage: string } | undefined;
    if (recording) {
      const diagnostics: unknown = JSON.parse(recording.diagnostics);
      const metric = Array.isArray(diagnostics) ? diagnostics.find(value => typeof value === 'string'
        && /^request_connection_failures:[0-9]+$/.test(value)) : undefined;
      if (typeof metric === 'string') {
        const count = Number(metric.split(':')[1]);
        if (Number.isSafeInteger(count)) {
          connections += count; connectionMeasured++;
          if (recording.coverage === 'complete') connectionComplete++;
        }
      }
    }
    // Native Pi reports ordinary input separately from cache. Other adapters
    // need explicit cache semantics before their compact totals can be used here.
    if (row.runtime === 'pi' && Number.isSafeInteger(usage?.inputTokens) && usage.inputTokens >= 0
      && Number.isSafeInteger(usage?.outputTokens) && usage.outputTokens >= 0) {
      input += usage.inputTokens; output += usage.outputTokens; measured++;
    }
  }
  return { ...summary, featureId: task.feature_id, projectName: task.display_name.slice(0, 200),
    occurredAt: new Date(occurredAt).toISOString(), executorId: attempts.at(-1)?.host_instance_id ?? null,
    complexity: task.complexity, models: [...models].slice(0, 8),
    durationMs: timed ? duration : null, durationPartial: timed !== attempts.length || attempts.length > 100,
    tokenUsage: { inputTokens: measured ? input : null, outputTokens: measured ? output : null,
      partial: measured !== attempts.length || attempts.length > 100 },
    connectionFailures: connectionMeasured ? connections : null,
    connectionFailuresPartial: connectionComplete !== attempts.length || attempts.length > 100 };
}
