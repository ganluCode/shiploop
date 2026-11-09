import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { SQLITE_MIGRATIONS } from '../../../packages/core/src/adapters/sqlite/migrations.ts';
import { enrichTaskNotification } from '../../../packages/core/src/adapters/sqlite/notification-task-summary.ts';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,display_name TEXT);
    CREATE TABLE phases(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,created_at INTEGER);
    CREATE TABLE features(id TEXT PRIMARY KEY,project_id TEXT,phase_id TEXT,title TEXT,created_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,feature_id TEXT,title TEXT,kind TEXT,created_at INTEGER);
    INSERT INTO projects VALUES ('p','desktop-platform'),('other','Other');
    INSERT INTO phases VALUES ('phase','p','Foundation',1);
    INSERT INTO features VALUES ('f1','p','phase','Window',1),('f2','p','phase','Storage',1);
    INSERT INTO tasks VALUES ('t1','p','f2','Storage contract','coding',1),('plan','p','f2','Generate plan','planning',1);`);
  // Start at the previous release schema, then exercise the real incremental migration.
  for (const migration of SQLITE_MIGRATIONS.filter(value => value.version === 69)) db.exec(migration.sql);
  return db;
}

it('backfills persistent hierarchical codes and adds names without changing event identity', () => {
  const db = fixture();
  try {
    const summary = { kind: 'model_fallback', taskId: 't1', runId: 'run', featureId: 'f2' };
    expect(enrichTaskNotification(db, 'p', summary, 1000)).toMatchObject({ ...summary,
      projectName: 'desktop-platform', phaseCode: 'P01', phaseTitle: 'Foundation',
      featureCode: 'P01-F02', featureTitle: 'Storage', taskCode: 'P01-F02-T001', taskTitle: 'Storage contract', taskKind: 'coding' });
    expect(enrichTaskNotification(db, 'p', { kind: 'model_fallback', taskId: 'plan' }, 1000))
      .toMatchObject({ taskCode: 'P01-F02-PLAN', taskKind: 'planning', featureTitle: 'Storage' });
    expect(enrichTaskNotification(db, 'other', summary, 1000)).toEqual(summary);
  } finally { db.close(); }
});

it('never renumbers after rename/deletion/replan and allocates independently by parent', () => {
  const db = fixture();
  try {
    db.exec(`UPDATE features SET title='Renamed' WHERE id='f2';
      DELETE FROM tasks WHERE id='t1';
      INSERT INTO tasks VALUES ('t2','p','f2','New task','coding',2),('t3','p','f1','Window task','coding',2);
      INSERT INTO tasks VALUES ('t1','p','f2','Restored task','coding',3);
      INSERT INTO features VALUES ('f3','p','phase','Third',2);
      INSERT INTO phases VALUES ('phase2','p','Second',2),('other-phase','other','Other phase',2);`);
    const project = (taskId: string) => enrichTaskNotification(db, 'p', { kind: 'model_fallback', taskId }, 1000);
    expect(project('t1')).toMatchObject({ taskCode: 'P01-F02-T001', featureTitle: 'Renamed' });
    expect(project('t2')).toMatchObject({ taskCode: 'P01-F02-T002' });
    expect(project('t3')).toMatchObject({ taskCode: 'P01-F01-T001' });
    expect(db.prepare("SELECT code FROM entity_display_codes WHERE entity_id='f3'").get()).toEqual({ code: 'P01-F03' });
    expect(db.prepare("SELECT code FROM entity_display_codes WHERE entity_id='phase2'").get()).toEqual({ code: 'P02' });
    expect(db.prepare("SELECT code FROM entity_display_codes WHERE entity_id='other-phase'").get()).toEqual({ code: 'P01' });
  } finally { db.close(); }
});
