import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { enrichTaskNotification } from '../../../packages/core/src/adapters/sqlite/notification-task-summary.ts';
import { computeExecutionStrategyCopyDigest } from '../../../packages/core/src/ports/execution-input-prepare.ts';
import { SQLITE_MIGRATIONS } from '../../../packages/core/src/adapters/sqlite/migrations.ts';

it('accumulates only this Run up to the terminal Attempt and keeps unknown usage partial', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,display_name TEXT);
      CREATE TABLE phases(id TEXT,project_id TEXT,title TEXT,created_at INTEGER);
      CREATE TABLE features(id TEXT,project_id TEXT,phase_id TEXT,title TEXT,created_at INTEGER);
      CREATE TABLE tasks(id TEXT,project_id TEXT,feature_id TEXT,complexity TEXT,execution_config TEXT,config_source TEXT,config_source_key TEXT,
        title TEXT DEFAULT 'Task',kind TEXT DEFAULT 'coding',created_at INTEGER DEFAULT 1);
      CREATE TABLE attempts(id TEXT,project_id TEXT,task_id TEXT,run_id TEXT,number INTEGER,input_snapshot TEXT,host_instance_id TEXT,usage_summary TEXT,session_id TEXT);
      CREATE TABLE sessions(id TEXT,project_id TEXT,runtime TEXT,started_at INTEGER,ended_at INTEGER);
      CREATE TABLE recording_manifests(project_id TEXT,session_id TEXT,diagnostics TEXT,coverage TEXT,finalized INTEGER,version INTEGER);`);
    const config = { schemaVersion: 2, runtime: 'pi', provider: 'preferred', model: 'model' };
    const snapshot = { digests: { strategyCopyDigest: computeExecutionStrategyCopyDigest({ executionConfig: config,
      configSource: 'project_default', configSourceKey: 'modelMap.medium' }) } };
    db.prepare('INSERT INTO projects VALUES (?,?)').run('project', 'Example');
    db.exec("INSERT INTO phases VALUES ('phase','project','Phase',1); INSERT INTO features VALUES ('feature','project','phase','Feature',1)");
    db.prepare('INSERT INTO tasks(id,project_id,feature_id,complexity,execution_config,config_source,config_source_key) VALUES (?,?,?,?,?,?,?)')
      .run('task', 'project', 'feature', 'medium', JSON.stringify(config), 'project_default', 'modelMap.medium');
    for (const migration of SQLITE_MIGRATIONS.filter(value => value.version === 69)) db.exec(migration.sql);
    const insert = (id: string, run: string, number: number, usage: object | null, body: object = snapshot) => {
      db.prepare('INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, 'project', 'task', run, number, JSON.stringify(body), 'host', usage === null ? null : JSON.stringify(usage), id);
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(id, 'project', 'pi', 1000, 2000);
    };
    insert('old', 'historical', 1, { inputTokens: 100000, outputTokens: 100000 });
    insert('first', 'current', 2, null);
    insert('final', 'current', 3, { inputTokens: 1000, outputTokens: 300 }, {
      ...snapshot, runtimeFallback: { strategy: { provider: 'backup', model: 'model' } },
    });
    insert('future', 'current', 4, { inputTokens: 100000, outputTokens: 100000 });
    db.prepare('INSERT INTO recording_manifests VALUES (?,?,?,?,?,?)')
      .run('project', 'final', JSON.stringify(['request_connection_failures:2']), 'complete', 1, 1);
    const result = enrichTaskNotification(db, 'project', { kind: 'task_terminal', taskId: 'task', runId: 'current', attemptId: 'final' }, 10000);
    expect(result).toMatchObject({ projectName: 'Example', complexity: 'medium', featureId: 'feature',
      featureCode: 'P01-F01', taskCode: 'P01-F01-T001', taskTitle: 'Task',
      models: ['preferred/model', 'backup/model'], durationMs: 2000, durationPartial: false,
      tokenUsage: { inputTokens: 1000, outputTokens: 300, partial: true }, connectionFailures: 2, connectionFailuresPartial: true });
    const original = { kind: 'task_terminal', taskId: 'missing', runId: 'current', attemptId: 'final' };
    expect(enrichTaskNotification(db, 'project', original, 10000)).toBe(original);
  } finally { db.close(); }
});
