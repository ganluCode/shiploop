import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createFeatureBranchName, createTaskCommitMessage } from '../../../packages/core/src/ports/git-naming.ts';
import { createSqlitePlanAccess } from '../../../packages/core/src/adapters/sqlite/plan-store.ts';
import { toPublicFeatureRecord } from '../../../packages/core/src/ports/queries.ts';
import { openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';
import { GIT_NAMING_MIGRATION_SQL } from '../../../packages/core/src/adapters/sqlite/git-naming-migration.ts';
import { validateFeaturePlanImportResultWire } from '../../../packages/host/src/client/app-wire.ts';

describe('stable Git naming', () => {
  it('migrates legacy branches verbatim without changing plans or code baselines', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE features(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,plan_digest TEXT,revision INTEGER);
        CREATE TABLE managed_workspaces(project_id TEXT,feature_id TEXT,branch TEXT,base_commit TEXT);
        CREATE TABLE entity_display_codes(project_id TEXT,entity_kind TEXT,entity_id TEXT,code TEXT);
        INSERT INTO features VALUES ('f1','p','Old title','original-digest',3),('f2','p','No workspace','another-digest',1);
        INSERT INTO managed_workspaces VALUES ('p','f1','shiploop/feature/legacy-hash','original-sha');
        INSERT INTO entity_display_codes VALUES ('p','feature','f1','P01-F01'),('p','feature','f2','P01-F02');`);
      const workspaces = db.prepare('SELECT * FROM managed_workspaces').all();
      const plans = db.prepare('SELECT id,plan_digest,revision FROM features').all();
      db.exec(GIT_NAMING_MIGRATION_SQL);
      expect(db.prepare('SELECT id,branch_name FROM features ORDER BY id').all()).toEqual([
        { id: 'f1', branch_name: 'shiploop/feature/legacy-hash' },
        { id: 'f2', branch_name: 'feat/p01/f02-feature' },
      ]);
      expect(db.prepare('SELECT * FROM managed_workspaces').all()).toEqual(workspaces);
      expect(db.prepare('SELECT id,plan_digest,revision FROM features').all()).toEqual(plans);
      expect(() => db.exec("UPDATE features SET branch_name=NULL WHERE id='f1'")).toThrow('immutable');
    } finally { db.close(); }
  });
  it('uses stable hierarchy codes and bounded ASCII slugs without unsafe Git syntax', () => {
    expect(createFeatureBranchName('P01-F02', 'Project Foundation')).toBe('feat/p01/f02-project-foundation');
    expect(createFeatureBranchName('P01-F02', '项目基础')).toBe('feat/p01/f02-feature');
    expect(createFeatureBranchName('P100-F120', '../Host: API\n@{lock}.LOCK')).toBe('feat/p100/f120-host-api-lock-lock');
    expect(createFeatureBranchName('P01-F02', 'A'.repeat(1000)).length).toBeLessThan(120);
    expect(() => createFeatureBranchName('foreign-id', 'title')).toThrow();
  });

  it('creates and freezes branch metadata across title revisions and database reopen', async () => {
    const f = await openBudgetFixture();
    try {
      const plans = createSqlitePlanAccess(f.session);
      const feature = plans.readFeaturePlanView(f.featureId)!.feature;
      expect(feature.branchName).toMatch(/^feat\/p01\/f01-[a-z0-9-]+$/);
      expect(toPublicFeatureRecord(feature).branchName).toBe(feature.branchName);
      const response = { feature: toPublicFeatureRecord(feature), tasks: [],
        validation: { taskCount: 0, dependencyEdgeCount: 0, executable: false } };
      expect(validateFeaturePlanImportResultWire(response).feature.branchName).toBe(feature.branchName);
      const { branchName: _old, ...legacy } = response.feature;
      expect(validateFeaturePlanImportResultWire({ ...response, feature: legacy }).feature.branchName).toBeUndefined();
      expect(() => validateFeaturePlanImportResultWire({ ...response,
        feature: { ...response.feature, branchName: 'feat/../bad' } })).toThrow();
      f.session.database.prepare('UPDATE features SET title = ? WHERE id = ?').run('Changed title', f.featureId);
      expect(plans.readFeaturePlanView(f.featureId)!.feature.branchName).toBe(feature.branchName);
      expect(() => f.session.database.prepare('UPDATE features SET branch_name = ? WHERE id = ?')
        .run('feat/p01/f01-changed', f.featureId)).toThrow();
      f.reopen();
      expect(createSqlitePlanAccess(f.session).readFeaturePlanView(f.featureId)!.feature.branchName).toBe(feature.branchName);
    } finally { f.close(); }
  });

  it('uses the stable Task ordinal and a single-line title, never the UUID', () => {
    expect(createTaskCommitMessage('P01-F02-T001', '实现配置读取')).toBe('T001: 实现配置读取');
    expect(createTaskCommitMessage('P01-F02-T1010', 'Read\n\nconfig\t safely')).toBe('T1010: Read config safely');
    expect(() => createTaskCommitMessage('uuid-task-id', 'title')).toThrow();
    expect(() => createTaskCommitMessage('P01-F02-T001', '\u0000')).toThrow();
  });
});
