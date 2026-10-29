/**
 * P06-6 / F-007：四层标签列表与计数查询接入 Host wire、HostClient 与传输面。
 *
 * 验收面（真实 startHost + 真实 HostClient + 真实 SQLite + SQL 预置标签）：
 * - phases.list/features.list/tasks.list 扩展 label/match 查询参数；新增
 *   GET /v1/runs（runs.list）与 GET /v1/label-counts（labels.counts）集合根；
 *   传输层只做形态转换，授权/可见性/标签规范化/游标绑定全部由 Core 复核；
 * - HostClient 公共方法 listRuns/getLabelCounts 与三层列表的 labels/match
 *   输入经真实 loopback 链路验证四层筛选、any/all、分页与去重计数；
 * - 查询零写入：同一项目事件水位在整组查询前后不变（只读性）；
 * - 客户端侧严格校验 labels/match/entity/limit/cursor 形态；传输层对缺
 *   projectId/entity、非法 limit、未知查询参数、跨项目游标返回受控
 *   invalid_input，错误体不泄漏 SQLite/表结构等内部信息；
 * - 跨项目父级返回与不存在父级相同的空页/空计数（不区分存在性）。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectToHost,
  isHostProtocolError,
  startHost,
  type HostClient,
  type RunningHost,
} from '../../../packages/host/src/index.ts';
import { APP_OPERATIONS } from '../../../packages/host/src/contract/errors.ts';
import { APPLICATION_QUERY_CAPABILITIES } from '../../../packages/host/src/contract/lifecycle.ts';
import { openClaimFixture, type ClaimFixture } from '../../helpers/p03-4/task-claim-fixture.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';

interface WiredLabelSetup {
  readonly fixture: ClaimFixture;
  readonly host: RunningHost;
  readonly client: HostClient;
  readonly token: string;
  readonly db: ClaimFixture['box']['session']['database'];
  readonly projectId: string;
  readonly featureId: string;
  readonly phaseId: string;
  readonly batchId: string;
  readonly runIds: readonly string[];
  readonly otherProjectId: string;
  readonly otherFeatureId: string;
}

let activeFixture: ClaimFixture | undefined;
let activeHost: RunningHost | undefined;
let activeClient: HostClient | undefined;

afterEach(async () => {
  if (activeClient !== undefined) {
    activeClient.close();
    activeClient = undefined;
  }
  const host = activeHost;
  activeHost = undefined;
  if (host !== undefined) {
    await host.close();
  }
  if (activeFixture !== undefined) {
    activeFixture.box.close();
    activeFixture = undefined;
  }
});

async function rejectionOf(action: () => unknown): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('应当以错误拒绝，实际成功返回');
}

function expectProtocolError(error: unknown, code: string): void {
  expect(error, `expected HostProtocolError, got ${String(error)}`).toBeDefined();
  expect(isHostProtocolError(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
}

async function setupWired(): Promise<WiredLabelSetup> {
  const fixture = await openClaimFixture([[], []]);
  activeFixture = fixture;
  try {
    const box = fixture.box;
    const db = box.session.database;
    const completed = async (operation: string, payload: unknown, extra: Record<string, unknown> = {}) => {
      const receipt = await box.submit(operation, payload, { scope: box.scope, ...extra });
      if (receipt.status !== 'completed') throw new Error(`fixture ${operation}: ${JSON.stringify(receipt)}`);
      return receipt.result as Record<string, any>;
    };
    // 第二项目（跨项目隔离；不区分存在性的空页/空计数）。
    const otherProjectId = (await completed('project.register', {
      repositoryPath: box.box.repoDirB, displayName: 'F-007 other', labels: [],
    }, { scope: { kind: 'registration' } })).project.id as string;
    await completed('phase.create', { id: 'phase-b', title: 'other', labels: [] },
      { scope: { kind: 'project', projectId: otherProjectId } });
    // 项目一内第二个 Phase（分页续页需要≥2 条；labels=beta）。
    await completed('phase.create', { id: 'phase-2', title: 'second', labels: ['beta'] },
      { scope: { kind: 'project', projectId: box.projectId } });
    const otherFeatureId = (await completed('feature.plan.import', {
      phaseId: 'phase-b',
      plan: { schemaVersion: 1, feature: { title: 'Other feature' }, tasks: [{ id: 'task-b', title: 'b', acceptance: { criteria: ['x'] } }] },
    }, { scope: { kind: 'project', projectId: otherProjectId }, expectedRevision: 1 })).feature.id as string;

    // 预置 Run 行（含跨项目 Run）：SQL 仅用于预置数据（与 F-006 测试同一纪律）。
    const insertCopy = (table: string, sourceId: string, changes: Record<string, unknown>) => {
      const source = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(sourceId) as Record<string, unknown>;
      const row = { ...source, ...changes };
      const columns = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...Object.values(row));
    };
    insertCopy('runs', fixture.ids.runId, { id: 'run-2', work_key: 'run-2', status: 'succeeded' });
    insertCopy('runs', fixture.ids.runId, { id: 'run-3', work_key: 'run-3', status: 'failed' });
    // 跨项目 Batch/Feature/Run（同一项目同 scope 复合外键；SQL 仅预置数据）。
    insertCopy('execution_batches', fixture.ids.batchId, {
      id: 'batch-b', project_id: otherProjectId, phase_id: 'phase-b', feature_id: otherFeatureId,
      scope_snapshot: JSON.stringify({ featureIds: [otherFeatureId], previewDigest: 'a'.repeat(64) }),
    });
    insertCopy('runs', fixture.ids.runId, {
      id: 'run-b', work_key: 'run-b', batch_id: 'batch-b',
      project_id: otherProjectId, feature_id: otherFeatureId,
    });

    // 标签分布：phase [alpha,beta]；feature [alpha]；task [beta]；
    // runs：R1 [alpha,beta]、run-2 [alpha]、run-3 [beta]；跨项目一律 private。
    const setLabels = (table: string, id: string, labels: readonly string[]) =>
      db.prepare(`UPDATE ${table} SET labels = ? WHERE id = ?`).run(JSON.stringify(labels), id);
    setLabels('phases', 'phase-1', ['alpha', 'beta']);
    setLabels('phases', 'phase-2', ['beta']);
    setLabels('phases', 'phase-b', ['private', 'alpha']);
    setLabels('features', box.featureId, ['alpha']);
    setLabels('features', otherFeatureId, ['private']);
    setLabels('tasks', 't-1', ['beta']);
    setLabels('tasks', 't-2', ['beta']);
    setLabels('runs', fixture.ids.runId, ['alpha', 'beta']);
    setLabels('runs', 'run-2', ['alpha']);
    setLabels('runs', 'run-3', ['beta']);
    setLabels('runs', 'run-b', ['private']);

    const host = await startHost({
      dataRoot: box.box.dataRoot,
      capabilityCatalog: box.box.capabilityCatalog,
      env: {},
    });
    activeHost = host;
    const client = await connectToHost({ canonicalRoot: box.box.dataRoot });
    activeClient = client;
    const token = readFileSync(join(box.box.dataRoot, 'host', 'auth.token'), 'utf8');

    return {
      fixture, host, client, token, db,
      projectId: fixture.ids.projectId,
      featureId: fixture.box.featureId,
      phaseId: 'phase-1',
      batchId: fixture.ids.batchId,
      runIds: [fixture.ids.runId, 'run-2', 'run-3'],
      otherProjectId, otherFeatureId,
    };
  } catch (error) {
    const host = activeHost;
    activeHost = undefined;
    if (host !== undefined) await host.close();
    fixture.box.close();
    throw error;
  }
}

describe('P06-6 / F-007 四层标签查询 Host 接线（真实 Host + SQLite）', () => {
  it('[case:capability-sync] 操作/能力/握手与 Core 同步宣告 runs.list 与 labels.counts', async () => {
    const s = await setupWired();
    try {
      expect(APP_OPERATIONS).toContain('runs.list');
      expect(APP_OPERATIONS).toContain('labels.counts');
      expect(APPLICATION_QUERY_CAPABILITIES).toContain('runs.list');
      expect(APPLICATION_QUERY_CAPABILITIES).toContain('labels.counts');
      expect(s.client.handshake.capabilities.application.queries).toContain('runs.list');
      expect(s.client.handshake.capabilities.application.queries).toContain('labels.counts');
    } finally {
      await cleanup(s);
    }
  });

  it('[case:four-layer-filter] 三层列表 label/match 与 listRuns 四层筛选经 loopback 返回正确记录', async () => {
    const s = await setupWired();
    try {
      // Phase 层：any/all 与不命中。
      expect((await s.client.listPhases(s.projectId, { labels: ['beta', 'alpha'], match: 'all' }))
        .records.map((r) => r.id)).toEqual(['phase-1']);
      expect((await s.client.listPhases(s.projectId, { labels: ['beta'] }))
        .records.map((r) => r.id)).toEqual(['phase-1', 'phase-2']);
      expect((await s.client.listPhases(s.projectId, { labels: ['missing'] })).records).toEqual([]);
      // Feature 层（父级 phaseId 必填）。
      expect((await s.client.listFeatures(s.projectId, s.phaseId, { labels: ['alpha'] }))
        .records.map((r) => r.id)).toEqual([s.featureId]);
      expect((await s.client.listFeatures(s.projectId, s.phaseId, { labels: ['beta'], match: 'any' }))
        .records).toEqual([]);
      // Task 层（父级 featureId 必填）。
      expect((await s.client.listTasks(s.projectId, s.featureId, { labels: ['beta'] }))
        .records.map((r) => r.id)).toEqual(['t-1', 't-2']);
      // Run 层：新集合根 + 持久标签。
      const anyRuns = await s.client.listRuns(s.projectId, { labels: ['alpha', 'beta'], match: 'any' });
      expect(anyRuns.scope).toBe('run-list');
      expect(anyRuns.records.map((r) => r.id)).toEqual([...s.runIds].sort());
      expect((await s.client.listRuns(s.projectId, { labels: ['alpha', 'beta'], match: 'all' }))
        .records.map((r) => r.id)).toEqual([s.runIds[0]]);
      // Run 记录投影：仅持久元数据，不含执行/配置快照。
      const first = anyRuns.records.find((r) => r.id === s.runIds[0]);
      expect(first).toMatchObject({
        projectId: s.projectId,
        featureId: s.featureId,
        batchId: s.batchId,
        labels: ['alpha', 'beta'],
        revision: 1,
      });
      expect(typeof first?.status).toBe('string');
      expect(typeof first?.purpose).toBe('string');
      expect(first?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // 父级过滤：featureId/batchId 可选输入。
      expect((await s.client.listRuns(s.projectId, { featureId: s.featureId }))
        .records.map((r) => r.id)).toEqual([...s.runIds].sort());
      expect((await s.client.listRuns(s.projectId, { batchId: s.batchId }))
        .records.map((r) => r.id)).toEqual([...s.runIds].sort());
    } finally {
      await cleanup(s);
    }
  });

  it('[case:pagination] 四层列表 limit/cursor 续页，游标绑定筛选语义', async () => {
    const s = await setupWired();
    try {
      const page1 = await s.client.listRuns(s.projectId, { limit: 2 });
      expect(page1.records.map((r) => r.id)).toEqual(s.runIds.slice(0, 2));
      expect(page1.limit).toBe(2);
      expect(page1.nextCursor).toBeTypeOf('string');
      const page2 = await s.client.listRuns(s.projectId, { limit: 2, cursor: page1.nextCursor as string });
      expect(page2.records.map((r) => r.id)).toEqual([s.runIds[2]]);
      expect(page2.nextCursor).toBeNull();
      // 三层列表分页保持既有兼容（无标签约束）。
      const phases = await s.client.listPhases(s.projectId, { limit: 1 });
      expect(phases.records.map((r) => r.id)).toEqual(['phase-1']);
      expect((await s.client.listPhases(s.projectId, { cursor: phases.nextCursor as string })).records
        .map((r) => r.id)).toEqual(['phase-2']);
      // 游标绑定筛选：换标签续页拒绝（invalid_cursor/invalid_input，不泄漏细节）。
      const labeled = await s.client.listRuns(s.projectId, { labels: ['alpha'], limit: 1 });
      const error = await rejectionOf(() =>
        s.client.listRuns(s.projectId, { labels: ['beta'], cursor: labeled.nextCursor as string }));
      expectProtocolError(error, 'invalid_input');
    } finally {
      await cleanup(s);
    }
  });

  it('[case:label-counts] getLabelCounts 四层计数与列表筛选语义一致（去重计数）', async () => {
    const s = await setupWired();
    try {
      expect(await s.client.getLabelCounts({ entity: 'phase', projectId: s.projectId })).toEqual({
        entity: 'phase',
        labels: [{ label: 'alpha', count: 1 }, { label: 'beta', count: 2 }],
      });
      expect(await s.client.getLabelCounts({ entity: 'feature', projectId: s.projectId, phaseId: s.phaseId }))
        .toEqual({ entity: 'feature', labels: [{ label: 'alpha', count: 1 }] });
      expect(await s.client.getLabelCounts({ entity: 'task', projectId: s.projectId, featureId: s.featureId }))
        .toEqual({ entity: 'task', labels: [{ label: 'beta', count: 2 }] });
      // Run：匹配 [alpha] 的实体携带 alpha:2、beta:1（跨实体去重计数）。
      expect(await s.client.getLabelCounts({ entity: 'run', projectId: s.projectId, labels: ['alpha'] }))
        .toEqual({ entity: 'run', labels: [{ label: 'alpha', count: 2 }, { label: 'beta', count: 1 }] });
      expect(await s.client.getLabelCounts({ entity: 'run', projectId: s.projectId, labels: ['missing'] }))
        .toEqual({ entity: 'run', labels: [] });
      // 计数不接受分页参数（客户端形态拒绝）。
      const error = await rejectionOf(() =>
        s.client.getLabelCounts({ entity: 'phase', projectId: s.projectId, limit: 10 } as never));
      expectProtocolError(error, 'invalid_input');
    } finally {
      await cleanup(s);
    }
  });

  it('[case:read-only] 整组查询零写入：事件水位不变', async () => {
    const s = await setupWired();
    try {
      const before = await s.client.getSnapshot({ kind: 'project', projectId: s.projectId });
      await s.client.listPhases(s.projectId, { labels: ['alpha'], limit: 1 });
      await s.client.listFeatures(s.projectId, s.phaseId, { labels: ['alpha'], match: 'all' });
      await s.client.listTasks(s.projectId, s.featureId, { labels: ['beta'] });
      const runs = await s.client.listRuns(s.projectId, { labels: ['alpha'], limit: 2 });
      if (runs.nextCursor !== null) {
        await s.client.listRuns(s.projectId, { labels: ['alpha'], cursor: runs.nextCursor });
      }
      await s.client.getLabelCounts({ entity: 'run', projectId: s.projectId, labels: ['alpha'] });
      await s.client.getLabelCounts({ entity: 'phase', projectId: s.projectId });
      const after = await s.client.getSnapshot({ kind: 'project', projectId: s.projectId });
      expect(after.watermark).toEqual(before.watermark);
    } finally {
      await cleanup(s);
    }
  });

  it('[case:client-validation] HostClient 输入形态严格校验（连接前拒绝）', async () => {
    const s = await setupWired();
    try {
      expectProtocolError(await rejectionOf(() =>
        s.client.listPhases(s.projectId, { match: 'ANY' } as never)), 'invalid_input');
      expectProtocolError(await rejectionOf(() =>
        s.client.listPhases(s.projectId, { labels: ['ok', 'x'.repeat(200)] })), 'invalid_input');
      expectProtocolError(await rejectionOf(() =>
        s.client.listPhases(s.projectId, { labels: ['a', 'b', ...Array.from({ length: 60 }, (_, i) => `l${i}`)] })), 'invalid_input');
      expectProtocolError(await rejectionOf(() =>
        s.client.listPhases(s.projectId, { limit: 0 })), 'invalid_input');
      expectProtocolError(await rejectionOf(() =>
        s.client.listPhases(s.projectId, { cursor: 'not-a-plan-cursor' })), 'invalid_input');
      expectProtocolError(await rejectionOf(() =>
        s.client.listPhases(s.projectId, { unknown: 1 } as never)), 'invalid_input');
      expectProtocolError(await rejectionOf(() =>
        s.client.listRuns(s.projectId, { featureId: 'not!!a!!stable!!id' })), 'invalid_input');
      expectProtocolError(await rejectionOf(() =>
        s.client.getLabelCounts({ entity: 'blob', projectId: s.projectId } as never)), 'invalid_input');
      expectProtocolError(await rejectionOf(() =>
        s.client.getLabelCounts({ entity: 'phase' } as never)), 'invalid_input');
      // 计数与列表使用同一标签匹配语义；非法 match 同样拒绝。
      expectProtocolError(await rejectionOf(() =>
        s.client.getLabelCounts({ entity: 'phase', projectId: s.projectId, match: 'some' } as never)), 'invalid_input');
    } finally {
      await cleanup(s);
    }
  });

  it('[case:transport-errors] 传输层受控拒绝且不泄漏内部数据库信息', async () => {
    const s = await setupWired();
    try {
      const expectControlledReject = async (
        path: string,
        reason?: string,
      ): Promise<void> => {
        const response = await loopbackRequest({ port: s.host.port, method: 'GET', path, token: s.token });
        expect(response.statusCode).toBe(400);
        const body = response.json() as { error: { code: string; details?: { reason?: string } } };
        expect(body.error.code).toBe('invalid_input');
        if (reason !== undefined) {
          expect(body.error.details?.reason).toBe(reason);
        }
        expect(response.bodyText).not.toMatch(/SQLITE|SELECT |INSERT |sqlite_master/i);
      };

      // runs.list：缺 projectId / 非法 limit / 空 label / 未知查询参数。
      await expectControlledReject('/v1/runs', 'missing_project_id');
      await expectControlledReject(`/v1/runs?projectId=${s.projectId}&limit=abc`, 'invalid_integer');
      await expectControlledReject(`/v1/runs?projectId=${s.projectId}&label=`);
      await expectControlledReject(`/v1/runs?projectId=${s.projectId}&bogus=1`, 'unknown_query_parameter');

      // labels.counts：缺 entity / 非法 entity / 缺 projectId。
      await expectControlledReject(`/v1/label-counts?projectId=${s.projectId}`, 'missing_entity');
      await expectControlledReject(`/v1/label-counts?entity=blob&projectId=${s.projectId}`, 'invalid_entity');
      await expectControlledReject('/v1/label-counts?entity=phase', 'missing_project_id');

      // phases.list：label/match 已进入查询白名单（未知参数仍拒绝）。
      const okLabel = await loopbackRequest({
        port: s.host.port, method: 'GET',
        path: `/v1/phases?projectId=${s.projectId}&label=alpha&label=beta&match=all`, token: s.token,
      });
      expect(okLabel.statusCode).toBe(200);
      expect((okLabel.json() as { records: { id: string }[] }).records.map((r) => r.id)).toEqual(['phase-1']);
      await expectControlledReject(`/v1/phases?projectId=${s.projectId}&bogus=1`, 'unknown_query_parameter');

      // 跨项目游标：绑定拒绝（invalid_cursor），不泄漏另一项目存在性。
      const otherPage = await loopbackRequest({
        port: s.host.port, method: 'GET',
        path: `/v1/phases?projectId=${s.otherProjectId}&limit=1`, token: s.token,
      });
      expect(otherPage.statusCode).toBe(200);
      expect((otherPage.json() as { nextCursor: string | null }).nextCursor).toBeNull();
      const mine = await s.client.listPhases(s.projectId, { limit: 1 });
      expect(mine.nextCursor).toBeTypeOf('string');
      const crossProject = await loopbackRequest({
        port: s.host.port, method: 'GET',
        path: `/v1/phases?projectId=${s.otherProjectId}&cursor=${encodeURIComponent(mine.nextCursor as string)}`,
        token: s.token,
      });
      expect(crossProject.statusCode).toBe(400);
      expect((crossProject.json() as { error: { code: string } }).error.code).toBe('invalid_input');

      // 跨项目/不存在父级：与不存在父级同样返回空页（不区分存在性）。
      expect((await s.client.listRuns(s.projectId, { featureId: s.otherFeatureId })).records).toEqual([]);
      expect((await s.client.getLabelCounts({ entity: 'feature', projectId: s.projectId, phaseId: 'phase-nope' }))
        .labels).toEqual([]);
    } finally {
      await cleanup(s);
    }
  });

  it('[case:response-wire] 线校验器拒绝畸形响应（scope/记录形状）', async () => {
    const s = await setupWired();
    try {
      const { validateAppQueryResponse } = await import('../../../packages/host/src/index.ts');
      // 未知线版本 → unsupported_schema_version；同版本 scope 错误/记录缺字段 →
      // response_malformed 协议错误。
      const unsupported = await rejectionOf(() => validateAppQueryResponse('runs.list', {
        schemaVersion: 4, scope: 'run-list', records: [], nextCursor: null, limit: 50,
      }));
      expect(isHostProtocolError(unsupported)).toBe(true);
      expect((unsupported as { code: string }).code).toBe('unsupported_schema_version');
      for (const bad of [
        { schemaVersion: 5, scope: 'phase-list', records: [], nextCursor: null, limit: 50 },
        { schemaVersion: 5, scope: 'run-list', records: [{ id: 'run-x' }], nextCursor: null, limit: 50 },
      ]) {
        const error = await rejectionOf(() => validateAppQueryResponse('runs.list', bad));
        expect(isHostProtocolError(error)).toBe(true);
        expect((error as { code: string }).code).toBe('response_malformed');
      }
      // labels.counts：实体越界 / 计数负数 → 协议错误。
      for (const bad of [
        { entity: 'blob', labels: [] },
        { entity: 'run', labels: [{ label: 'a', count: -1 }] },
        { entity: 'run', labels: [{ label: 'a', count: 1, extra: true }] },
      ]) {
        const error = await rejectionOf(() => validateAppQueryResponse('labels.counts', bad));
        expect(isHostProtocolError(error)).toBe(true);
        expect((error as { code: string }).code).toBe('response_malformed');
      }
      // 合法形状通过。
      expect(validateAppQueryResponse('labels.counts', { entity: 'run', labels: [{ label: 'a', count: 2 }] }))
        .toEqual({ entity: 'run', labels: [{ label: 'a', count: 2 }] });
    } finally {
      await cleanup(s);
    }
  });
});

async function cleanup(s: WiredLabelSetup): Promise<void> {
  if (activeClient !== undefined && activeClient === s.client) {
    activeClient.close();
    activeClient = undefined;
  }
  const host = activeHost;
  activeHost = undefined;
  if (host !== undefined) {
    await host.close();
  }
  const fixture = activeFixture;
  activeFixture = undefined;
  if (fixture !== undefined) {
    fixture.box.close();
  }
}
