import { expect, it } from 'vitest';
import type { LabelEntity } from '../../../packages/core/src/ports/entity-label-query.ts';
import { createSqliteQueryStore } from '../../../packages/core/src/adapters/sqlite/query-store.ts';
import { openBudgetFixture } from '../../helpers/p03-3/budget-fixture.ts';

async function setup() {
  const f = await openBudgetFixture(undefined, ['t-1', 't-2', 't-3'].map(id => ({
    id, title: id, acceptance: { criteria: ['labels query'] }, dependsOn: [],
  })));
  try {
    const db = f.session.database;
    const complete = async (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => {
      const receipt = await f.submit(operation, payload, { scope: f.scope, ...extra });
      if (receipt.status !== 'completed') throw Error(`fixture ${operation}: ${JSON.stringify(receipt)}`);
      return receipt.result as Record<string, any>;
    };
    const otherProject = (await complete('project.register', {
      repositoryPath: f.box.repoDirB, displayName: 'Other', labels: [],
    }, { scope: { kind: 'registration' } })).project.id as string;
    for (const [id, projectId] of [['phase-2', f.projectId], ['phase-3', f.projectId], ['phase-b', otherProject]]) {
      await complete('phase.create', { id, title: id, labels: [] }, { scope: { kind: 'project', projectId } });
    }
    const importPlan = async (projectId: string, phaseId: string) => (await complete('feature.plan.import', {
      phaseId, plan: { schemaVersion: 1, feature: { title: 'Labels' },
        tasks: phaseId === 'phase-b' ? [{ id: `task-${phaseId}`, title: 'Labels', acceptance: { criteria: ['query'] } }] : [] },
    }, { scope: { kind: 'project', projectId }, expectedRevision: 1 })).feature.id as string;
    const feature2 = await importPlan(f.projectId, 'phase-1');
    const feature3 = await importPlan(f.projectId, 'phase-1');
    const otherFeature = await importPlan(otherProject, 'phase-b');
    const started = await f.start();
    function insertCopy(table: string, sourceId: string, changes: Record<string, unknown>) {
      const source = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(sourceId) as Record<string, unknown>;
      const row = { ...source, ...changes };
      const columns = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...Object.values(row));
    }
    insertCopy('runs', started.runId, { id: 'run-2', work_key: 'run-2', status: 'succeeded' });
    insertCopy('runs', started.runId, { id: 'run-3', work_key: 'run-3', status: 'failed' });
    insertCopy('execution_batches', started.batchId, {
      id: 'batch-b', project_id: otherProject, phase_id: 'phase-b', feature_id: otherFeature,
      scope_snapshot: JSON.stringify({ featureIds: [otherFeature], previewDigest: 'a'.repeat(64) }),
    });
    insertCopy('runs', started.runId, {
      id: 'run-b', batch_id: 'batch-b', project_id: otherProject, feature_id: otherFeature,
    });
    const groups = {
      phase: ['phase-1', 'phase-2', 'phase-3'], feature: [f.featureId, feature2, feature3],
      task: ['t-1', 't-2', 't-3'], run: [started.runId, 'run-2', 'run-3'],
    };
    for (const [entity, ids] of Object.entries(groups)) {
      const labels = [['alpha', 'beta'], ['alpha'], ['beta']];
      ids.forEach((id, i) => db.prepare(`UPDATE ${entity === 'phase' ? 'phases' : entity === 'feature' ? 'features' : entity === 'task' ? 'tasks' : 'runs'} SET labels = ? WHERE id = ?`)
        .run(JSON.stringify(labels[i]), id));
    }
    for (const [table, id] of [['phases', 'phase-b'], ['features', otherFeature], ['tasks', 'task-phase-b'], ['runs', 'run-b']]) {
      db.prepare(`UPDATE ${table} SET labels = ? WHERE id = ?`).run('["private","alpha"]', id);
    }
    const app = await f.box.openApplication();
    const query = app.queryService;
    const scoped = f.box.restrictedPrincipal({ capabilities: ['project.read'], projectScope: f.box.scopeAllowlist([f.projectId]) });
    const input = (entity: LabelEntity) => ({ projectId: f.projectId,
      ...(entity === 'feature' ? { phaseId: 'phase-1' } : entity === 'task' ? { featureId: f.featureId } : {}) });
    const list = (entity: LabelEntity, options: Record<string, unknown> = {}, principal: unknown = scoped) => {
      const request = { ...input(entity), ...options };
      switch (entity) {
        case 'phase': return query.listPhases(principal, request);
        case 'feature': return query.listFeatures(principal, request);
        case 'task': return query.listTasks(principal, request);
        case 'run': return query.listRuns(principal, request);
      }
    };
    return { f, db, app, query, scoped, input, list, groups, otherProject, otherFeature, started };
  } catch (error) { f.close(); throw error; }
}

it('[case:phase-filter] filters Phase labels using shared normalization', async () => {
  const s = await setup();
  try {
    s.db.prepare('UPDATE phases SET labels = ? WHERE id = ?').run('["alpha","é"]', 'phase-1');
    const result = await s.list('phase', { labels: [' Alpha ', 'alpha', 'e\u0301'], match: 'all', limit: 1 });
    expect(result.records.map(row => row.id)).toEqual(['phase-1']);
    expect(result.nextCursor).toBeNull();
  } finally { s.f.close(); }
});

for (const entity of ['phase', 'feature', 'task', 'run'] as const) {
  it(`[case:${entity}-matrix] ${entity} any/all, empty labels, bounded pages and counts agree`, async () => {
    const s = await setup();
    try {
      const sorted = [...s.groups[entity]].sort();
      for (const match of ['any', 'all'] as const) {
        const expected = match === 'any' ? sorted : [s.groups[entity][0]];
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await s.list(entity, { labels: [' Beta ', 'alpha', 'alpha'], match, limit: 1, cursor });
          seen.push(...page.records.map(row => row.id));
          expect(page.limit).toBe(1);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined && seen.length <= 4);
        expect(seen).toEqual(expected);
        expect((await s.query.getLabelCounts(s.scoped, {
          entity, ...s.input(entity), labels: ['alpha', 'beta'], match,
        })).labels).toEqual([{ label: 'alpha', count: match === 'any' ? 2 : 1 }, { label: 'beta', count: match === 'any' ? 2 : 1 }]);
        const unfiltered = await s.list(entity, { labels: [], match, limit: 200 });
        expect(unfiltered.records.map(row => row.id)).toEqual(sorted);
        expect(unfiltered.nextCursor).toBeNull();
      }
      const singleLabel = await s.list(entity, { labels: ['alpha'], limit: 1 });
      const alphaIds = s.groups[entity].slice(0, 2).sort();
      expect(singleLabel.records.map(row => row.id)).toEqual(alphaIds.slice(0, 1));
      expect((await s.list(entity, { labels: ['alpha'], cursor: singleLabel.nextCursor })).records.map(row => row.id))
        .toEqual(alphaIds.slice(1));
      expect((await s.query.getLabelCounts(s.scoped, { entity, ...s.input(entity), labels: ['alpha'] })).labels)
        .toEqual([{ label: 'alpha', count: 2 }, { label: 'beta', count: 1 }]);
      expect((await s.list(entity, { labels: ['missing'] })).records).toEqual([]);
      expect((await s.query.getLabelCounts(s.scoped, { entity, ...s.input(entity), labels: ['missing'] })).labels).toEqual([]);
      // Exact page boundary does not advertise an empty extra page.
      const boundary = await s.list(entity, { limit: 3 });
      expect(boundary.records).toHaveLength(3);
      expect(boundary.nextCursor).toBeNull();
    } finally { s.f.close(); }
  });
}

it('[case:invalid-input] rejects invalid labels/match/limit/cursor and binds cursors to filters and scope', async () => {
  const s = await setup();
  try {
    for (const entity of ['phase', 'feature', 'task', 'run'] as const) {
      for (const invalid of [{ labels: null }, { labels: [' '] }, { labels: [4] }, { labels: ['a'.repeat(65)] },
        { match: 'ALL' }, { limit: 0 }, { limit: 201 }, { cursor: 'broken' }, { actorId: 'owner' }]) {
        await expect(s.list(entity, invalid)).rejects.toMatchObject({ code: 'invalid_input' });
      }
      const first = await s.list(entity, { labels: ['alpha', 'beta'], match: 'any', limit: 1 });
      expect(first.nextCursor).toBeTypeOf('string');
      for (const changed of [{ labels: ['alpha'] }, { match: 'all' }, { projectId: s.otherProject }]) {
        await expect(s.list(entity, { labels: ['alpha', 'beta'], match: 'any', cursor: first.nextCursor, ...changed }, s.f.owner))
          .rejects.toMatchObject({ code: 'invalid_input' });
      }
      const same = await s.list(entity, { labels: [' Beta ', 'alpha', 'beta'], cursor: first.nextCursor, limit: 2 });
      expect(same.records.map(row => row.id)).toEqual([...s.groups[entity]].sort().slice(1));
      await expect(s.query.getLabelCounts(s.scoped, { entity, ...s.input(entity), match: 'bad' })).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(s.query.getLabelCounts(s.scoped, { entity, ...s.input(entity), cursor: first.nextCursor })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(s.query.getLabelCounts(s.scoped, { projectId: s.f.projectId, entity: 'project' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(s.query.getLabelCounts(s.scoped, { projectId: s.f.projectId, entity: 'phase', featureId: s.f.featureId })).rejects.toMatchObject({ code: 'invalid_input' });
    const phasePage = await s.list('phase', { limit: 1 });
    await expect(s.list('run', { cursor: phasePage.nextCursor })).rejects.toMatchObject({ code: 'invalid_input' });
    const tasks = await s.list('task', { limit: 1 });
    await expect(s.list('task', { featureId: s.otherFeature, cursor: tasks.nextCursor })).rejects.toMatchObject({ code: 'invalid_input' });
    const runs = await s.list('run', { limit: 1 });
    await expect(s.list('run', { batchId: s.started.batchId, cursor: runs.nextCursor })).rejects.toMatchObject({ code: 'invalid_input' });
  } finally { s.f.close(); }
});

it('[case:visibility] project predicates and wrong parents hide existence for lists and counts', async () => {
  const s = await setup();
  try {
    for (const entity of ['phase', 'feature', 'task', 'run'] as const) {
      for (const projectId of [s.otherProject, 'nonexistent']) {
        await expect(s.list(entity, { projectId, limit: 0 })).rejects.toMatchObject({ code: 'forbidden' });
        await expect(s.query.getLabelCounts(s.scoped, { entity, projectId })).rejects.toMatchObject({ code: 'forbidden' });
      }
      expect((await s.query.getLabelCounts(s.f.owner, { entity, projectId: s.otherProject })).labels)
        .toEqual([{ label: 'alpha', count: 1 }, { label: 'private', count: 1 }]);
      for (const parent of entity === 'feature' ? [{ phaseId: 'phase-b' }, { phaseId: 'absent' }]
        : entity === 'task' || entity === 'run' ? [{ featureId: s.otherFeature }, { featureId: 'absent' }] : []) {
        expect((await s.list(entity, parent)).records).toEqual([]);
        expect((await s.query.getLabelCounts(s.scoped, { entity, ...s.input(entity), ...parent })).labels).toEqual([]);
      }
    }
    expect((await s.list('run', { featureId: s.f.featureId, batchId: s.started.batchId })).records).toHaveLength(3);
    expect((await s.list('run', { batchId: 'batch-b' })).records).toEqual([]);
    expect((await s.query.getLabelCounts(s.scoped, { entity: 'run', projectId: s.f.projectId, batchId: 'batch-b' })).labels).toEqual([]);
    const noRead = s.f.box.restrictedPrincipal({ capabilities: [], projectScope: s.f.box.scopeAllowlist([s.f.projectId]) });
    await expect(s.query.listRuns(noRead, { projectId: s.f.projectId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(s.query.getLabelCounts(noRead, { entity: 'run', projectId: s.f.projectId })).rejects.toMatchObject({ code: 'forbidden' });
    const store = createSqliteQueryStore(s.f.session);
    // Direct adapter calls also push the allowlist into SQL before aggregation/LIMIT.
    expect(store.countEntityLabels(s.f.box.scopeAllowlist([s.f.projectId]), { entity: 'run', projectId: s.otherProject }, { labels: [], match: 'any' })).toEqual([]);
    expect(store.listLabelRunRecords(s.f.box.scopeAllowlist([s.f.projectId]), { entity: 'run', projectId: s.otherProject },
      { labels: [], match: 'any', afterId: null, limit: 1 }).records).toEqual([]);
  } finally { s.f.close(); }
});

it('[case:counts-dedup] counts distinct identities per layer and excludes planning Tasks', async () => {
  const s = await setup();
  try {
    // Legacy duplicate arrays must not multiply an entity's contribution.
    for (const [table, id] of [['phases', 'phase-1'], ['features', s.f.featureId], ['tasks', 't-1'], ['runs', s.started.runId]]) {
      s.db.prepare(`UPDATE ${table} SET labels = ? WHERE id = ?`).run('["alpha","alpha","beta"]', id);
    }
    for (const entity of ['phase', 'feature', 'task', 'run'] as const) {
      expect((await s.query.getLabelCounts(s.scoped, { entity, ...s.input(entity), labels: ['alpha', 'beta'], match: 'all' })).labels)
        .toEqual([{ label: 'alpha', count: 1 }, { label: 'beta', count: 1 }]);
    }
    s.db.prepare("UPDATE tasks SET kind = 'planning' WHERE id = 't-2'").run();
    expect((await s.list('task')).records.map(row => row.id)).toEqual(['t-1', 't-3']);
    expect((await s.query.getLabelCounts(s.scoped, { entity: 'task', ...s.input('task') })).labels)
      .toEqual([{ label: 'alpha', count: 1 }, { label: 'beta', count: 2 }]);
  } finally { s.f.close(); }
});

it('[case:readonly-persistence] queries preserve all database facts and read persistent Run labels after reopening', async () => {
  const s = await setup();
  try {
    const snapshot = () => {
      const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
      return tables.map(({ name }) => [name, s.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
    };
    const before = snapshot();
    const changes = s.db.prepare('SELECT total_changes() AS n').get();
    for (const entity of ['phase', 'feature', 'task', 'run'] as const) {
      await s.list(entity, { labels: ['alpha'] });
      await s.query.getLabelCounts(s.scoped, { entity, ...s.input(entity) });
    }
    expect(snapshot()).toEqual(before);
    expect(s.db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect((await s.list('run', { labels: ['alpha'] })).records.every(row => !('inputSnapshot' in row) && !('configSnapshot' in row))).toBe(true);
    s.db.prepare('UPDATE features SET labels = ? WHERE id = ?').run('["changed-parent"]', s.f.featureId);
    const result = await s.list('run', { labels: ['alpha'] });
    expect(result.records).toHaveLength(2);
    expect((await s.list('run', { labels: ['changed-parent'] })).records).toEqual([]);
    s.app.close();
    const reopened = await s.f.box.openApplication();
    expect(await reopened.queryService.listRuns(s.scoped, { projectId: s.f.projectId, labels: ['alpha'] })).toEqual(result);
  } finally { s.f.close(); }
});
