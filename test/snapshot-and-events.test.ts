/**
 * F-010 一致读视图快照水位与授权分页事件读取（Core 应用层直接测试，不经 HTTP）：
 * - 快照内容（项目/绑定/当前配置/有效配置来源/水位）与 MAX(sequence) 取自同一
 *   SQLite 一致读视图，不多次独立读取后随手拼水位；
 * - 快照边界并发热写：变更要么已在快照内且水位覆盖，要么严格落在水位之后；
 *   从水位补读并应用后投影与最终持久状态一致（跨进程真实并发 + 确定性两侧）；
 * - 事件读取按授权范围（SQL 谓词下推）+ sequence 升序有界分页；游标绑定数据根
 *   与 scope，关闭重开不重置；坏游标/越权/缺游标一律明确拒绝，不当从零读取；
 * - 损坏事件行列 → corrupt_state（F-003 定案），不静默跳过、不伪造。
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { computeDataRootIdentity as computeHostDataRootIdentity } from '../packages/host/src/contract/identifiers.ts';
import { PublicError } from '../packages/core/src/ports/commands.ts';
import {
  createEventCursorBinding,
  decodeEventCursor,
  encodeEventCursor,
  normalizeMaxEventSequence,
} from '../packages/core/src/ports/events.ts';
import type { PublicStateEvent } from '../packages/core/src/ports/events.ts';
import { computeDataRootIdentity } from '../packages/core/src/ports/path-service.ts';
import type { SettingsPayload } from '../packages/core/src/ports/settings-schema.ts';
import type { ProjectSnapshotResult, SnapshotResult } from '../packages/core/src/application/query-service.ts';
import type { StateEventProbeRow } from './helpers/p02-2/storage-probe.ts';
import {
  createCommandsTestFixture,
  type CommandsTestFixture,
} from './helpers/p02-2/index.ts';
import {
  createIsolatedHostEnvironment,
  type IsolatedHostEnvironment,
} from './helpers/host/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();

const GLOBAL_PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
  policies: { verification: { requireChecksBeforeDone: true } },
};
const GLOBAL_PAYLOAD_V2: SettingsPayload = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } },
};
const PROJECT_PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: { modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } } },
};

let fixture: CommandsTestFixture | undefined;
let environment: IsolatedHostEnvironment | undefined;
afterEach(async () => {
  await environment?.dispose();
  environment = undefined;
  fixture?.cleanup();
  expect(fixture?.cleaned).toBe(true);
  fixture = undefined;
});

async function setup() {
  const box = createCommandsTestFixture({ prefix: 'shiploop-f010s-' });
  fixture = box;
  const app = await box.openApplication();
  const probe = box.openProbe();
  const owner = box.localOwner();
  const envelope = (operation: string, scope: unknown, changes: Record<string, unknown> = {}) => ({
    schemaVersion: 4,
    commandId: randomUUID(),
    operation,
    scope,
    issuedAt: NOW_ISO,
    ...changes,
  });
  const submit = async (operation: string, scope: unknown, changes: Record<string, unknown> = {}) => {
    const receipt = await app.commandService.submit(owner, envelope(operation, scope, changes));
    if (receipt.status === 'rejected') {
      throw new Error(`命令 ${operation} 未完成：${JSON.stringify(receipt.error)}`);
    }
    if (receipt.status !== 'completed') {
      throw new Error(`命令 ${operation} 回执异常状态：${receipt.status}`);
    }
    return receipt;
  };
  const register = async (repositoryPath: string, displayName: string, labels: string[] = []) => {
    const receipt = await submit('project.register', { kind: 'registration' }, {
      payload: { repositoryPath, displayName, labels },
    });
    return (receipt.result as { project: { id: string; revision: number } }).project;
  };
  const updateMetadata = async (projectId: string, expectedRevision: number, displayName: string) =>
    submit('project.metadata.update', { kind: 'project', projectId }, {
      expectedRevision,
      payload: { displayName },
    });
  return { box, app, probe, owner, envelope, submit, register, updateMetadata };
}

/** 项目快照窄化（scope 判别）。 */
function projectSnapshot(snapshot: SnapshotResult): ProjectSnapshotResult {
  if (snapshot.scope.kind !== 'project') {
    throw new Error('期望项目快照');
  }
  // TS 不沿嵌套 scope.kind 判别联合收窄；此分支已由运行时检查保证。
  return snapshot as ProjectSnapshotResult;
}

describe('F-010 快照：一致读视图与水位', () => {
  it('空库全局快照：settings 为 null、水位 0、游标可解码且绑定数据根与 scope', async () => {
    const s = await setup();
    const snapshot = await s.app.queryService.getSnapshot(s.owner, { kind: 'global' });
    expect(snapshot.schemaVersion).toBe(4);
    expect(snapshot.scope).toEqual({ kind: 'global' });
    expect(snapshot.settings).toBeNull();
    expect(snapshot.watermark.sequence).toBe(0);
    expect(new Date(snapshot.readAt).toISOString()).toBe(snapshot.readAt);
    const binding = createEventCursorBinding({
      rootIdentity: computeDataRootIdentity(s.app.dataRoot),
      scope: { kind: 'global' },
    });
    expect(decodeEventCursor(snapshot.watermark.cursor, binding).sequence).toBe(0);
    // Core 与 Host 的数据根身份算法逐字节一致（F-012/F-013 续读对齐前提）。
    expect(computeDataRootIdentity(s.app.dataRoot)).toBe(computeHostDataRootIdentity(s.app.dataRoot));
    // 快照是只读操作。
    expect(s.probe.counts().state_events).toBe(0);
  });

  it('项目快照：项目 + 绑定 + 当前配置 + 有效配置来源 + 水位取自同一读视图', async () => {
    const s = await setup();
    const project = await s.register(s.box.repoDirA, 'project A', ['a']);
    await s.submit('settings.global.create', { kind: 'global' }, { payload: GLOBAL_PAYLOAD });
    await s.submit('settings.project.create', { kind: 'project', projectId: project.id }, {
      payload: PROJECT_PAYLOAD,
    });
    const snapshot = projectSnapshot(
      await s.app.queryService.getSnapshot(s.owner, { kind: 'project', projectId: project.id }),
    );
    expect(snapshot.project).toMatchObject({ id: project.id, displayName: 'project A', revision: 1 });
    expect(snapshot.binding).toMatchObject({ projectId: project.id });
    expect(snapshot.settings).toMatchObject({
      scope: { kind: 'project', projectId: project.id },
      revision: 1,
      payload: PROJECT_PAYLOAD,
    });
    expect(snapshot.effective.strategies.defaultStrategy?.source).toMatchObject({
      kind: 'global_default',
      scopeRevision: 1,
    });
    expect(snapshot.effective.strategies.modelMap.low?.source).toMatchObject({
      kind: 'project_default',
      scopeRevision: 1,
    });
    // 水位与数据内容同一读视图：等于此刻持久 MAX(sequence)。
    expect(snapshot.watermark.sequence).toBe(s.probe.maxSequence());
    expect(snapshot.watermark.sequence).toBe(3); // registered + global_created + project_created
    expect(
      decodeEventCursor(
        snapshot.watermark.cursor,
        createEventCursorBinding({
          rootIdentity: computeDataRootIdentity(s.app.dataRoot),
          scope: { kind: 'project', projectId: project.id },
        }),
      ).sequence,
    ).toBe(3);
  });

  it('快照授权：项目不可见/不存在统一 forbidden；全局快照要求 settings.global.read', async () => {
    const s = await setup();
    const projectA = await s.register(s.box.repoDirA, 'project A');
    const restricted = s.box.restrictedPrincipal({
      capabilities: ['project.read', 'events.read'],
      projectScope: s.box.scopeAllowlist([projectA.id]),
    });
    const hidden = await s.register(s.box.repoDirB, 'project B');
    for (const target of [hidden.id, randomUUID()]) {
      const error = await s.app.queryService
        .getSnapshot(restricted, { kind: 'project', projectId: target })
        .catch((caught) => caught);
      expect(error).toMatchObject({ code: 'forbidden' });
    }
    const noGlobal = await s.app.queryService
      .getSnapshot(restricted, { kind: 'global' })
      .catch((caught) => caught);
    expect(noGlobal).toMatchObject({ code: 'forbidden', details: { reason: 'capability_denied' } });
    const noEventsRead = s.box.restrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: s.box.scopeAllowlist([projectA.id]),
    });
    const projectOk = await s.app.queryService.getSnapshot(noEventsRead, {
      kind: 'project',
      projectId: projectA.id,
    });
    expect(projectOk.scope).toEqual({ kind: 'project', projectId: projectA.id });
  });

  it('非法 scope 参数在任何读取之前 invalid_input（含提权字段与路径形态）', async () => {
    const s = await setup();
    const before = s.probe.counts();
    for (const scope of [
      { kind: 'project' },
      { kind: 'global', projectId: randomUUID() },
      { kind: 'project', projectId: '/etc/passwd' },
      { kind: 'project', projectId: randomUUID(), principal: 'local-owner' },
      { kind: 'registration' },
      'project',
    ]) {
      const error = await s.app.queryService.getSnapshot(s.owner, scope).catch((caught) => caught);
      expect(error).toBeInstanceOf(PublicError);
      expect((error as PublicError).code).toBe('invalid_input');
    }
    expect(s.probe.counts()).toEqual(before);
  });

  it('快照边界写入（先写后读）：变更已在快照内且水位覆盖', async () => {
    const s = await setup();
    const project = await s.register(s.box.repoDirA, 'project A');
    await s.updateMetadata(project.id, 1, 'project A v2');
    const snapshot = projectSnapshot(
      await s.app.queryService.getSnapshot(s.owner, { kind: 'project', projectId: project.id }),
    );
    expect(snapshot.project.revision).toBe(2);
    expect(snapshot.project.displayName).toBe('project A v2');
    const events = s.probe.stateEvents();
    const metadataEvent = events.find((row) => row.event_type === 'project.metadata_updated');
    expect(metadataEvent).toBeDefined();
    expect(snapshot.watermark.sequence).toBeGreaterThanOrEqual(metadataEvent!.sequence);
  });

  it('快照边界写入（先读后写）：变更严格落在水位之后，补读应用后投影与最终状态一致', async () => {
    const s = await setup();
    const project = await s.register(s.box.repoDirA, 'project A');
    await s.submit('settings.project.create', { kind: 'project', projectId: project.id }, {
      payload: PROJECT_PAYLOAD,
    });
    const before = projectSnapshot(
      await s.app.queryService.getSnapshot(s.owner, { kind: 'project', projectId: project.id }),
    );
    const watermark = before.watermark.sequence;

    await s.updateMetadata(project.id, 1, 'project A v2');
    await s.submit('settings.project.update', { kind: 'project', projectId: project.id }, {
      expectedRevision: 1,
      payload: { schemaVersion: 2, strategies: { purposeStrategies: { judge: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } } } },
    });

    // 旧快照不变：两个事件严格落在水位之后。
    const afterEvents = s.probe.stateEvents().filter((row) => row.sequence > watermark);
    expect(afterEvents.map((row) => row.event_type)).toEqual([
      'project.metadata_updated',
      'settings.project_updated',
    ]);
    expect(before.project.revision).toBe(1);
    expect(before.settings?.revision).toBe(1);

    // 从水位补读并应用：投影与最终持久状态一致，无业务缺口。
    const page = await s.app.queryService.listEvents(s.owner, {
      scope: { kind: 'project', projectId: project.id },
      cursor: before.watermark.cursor,
      limit: 100,
    });
    expect(page.events.map((event) => event.sequence)).toEqual(
      afterEvents.map((row) => row.sequence),
    );
    const projected = { projectRevision: before.project.revision, settingsRevision: before.settings!.revision };
    for (const event of page.events) {
      if (event.aggregate.type === 'project') projected.projectRevision = event.aggregate.revision;
      if (event.aggregate.type === 'project_settings') projected.settingsRevision = event.aggregate.revision;
    }
    const finalProject = s.probe.projectRow(project.id);
    const finalSettings = s.probe.settingsRow('project', project.id);
    expect(projected.projectRevision).toBe(finalProject!.revision);
    expect(projected.settingsRevision).toBe(finalSettings!.revision);
  });
});

describe('F-010 分页事件读取', () => {
  /** 建立含五类事件的真实数据根：注册 A/B + 元数据 + 全局配置 + 项目配置。 */
  async function seedEvents() {
    const s = await setup();
    const projectA = await s.register(s.box.repoDirA, 'project A');
    const projectB = await s.register(s.box.repoDirB, 'project B');
    await s.updateMetadata(projectA.id, 1, 'project A v2');
    await s.submit('settings.global.create', { kind: 'global' }, { payload: GLOBAL_PAYLOAD });
    await s.submit('settings.project.create', { kind: 'project', projectId: projectA.id }, {
      payload: PROJECT_PAYLOAD,
    });
    return { ...s, projectA, projectB };
  }

  it('项目流只含该项目事件、全局流只含全局事件；sequence 升序、eventId 唯一', async () => {
    const s = await seedEvents();
    const snapshot = projectSnapshot(
      await s.app.queryService.getSnapshot(s.owner, { kind: 'project', projectId: s.projectA.id }),
    );
    const projectPage = await s.app.queryService.listEvents(s.owner, {
      scope: { kind: 'project', projectId: s.projectA.id },
      cursor: encodeEventCursor(
        0,
        createEventCursorBinding({
          rootIdentity: computeDataRootIdentity(s.app.dataRoot),
          scope: { kind: 'project', projectId: s.projectA.id },
        }),
      ),
      limit: 100,
    });
    const persistedProjectRows = s.probe
      .stateEvents()
      .filter((row) => row.project_id === s.projectA.id);
    expect(projectPage.events.map((event) => event.eventId)).toEqual(
      persistedProjectRows.map((row) => row.id),
    );
    expect(projectPage.events.map((event) => event.sequence)).toEqual(
      persistedProjectRows.map((row) => row.sequence),
    );
    expect(new Set(projectPage.events.map((event) => event.eventId)).size).toBe(
      projectPage.events.length,
    );
    // 项目流不含全局事件，也不含其他项目事件。
    expect(projectPage.events.every((event) => event.scope.kind === 'project')).toBe(true);
    expect(
      projectPage.events.every(
        (event) => event.scope.kind === 'project' && event.scope.projectId === s.projectA.id,
      ),
    ).toBe(true);

    const globalPage = await s.app.queryService.listEvents(s.owner, {
      scope: { kind: 'global' },
      cursor: encodeEventCursor(
        0,
        createEventCursorBinding({
          rootIdentity: computeDataRootIdentity(s.app.dataRoot),
          scope: { kind: 'global' },
        }),
      ),
      limit: 100,
    });
    expect(globalPage.events).toHaveLength(1);
    expect(globalPage.events[0]).toMatchObject({
      type: 'settings.global_created',
      scope: { kind: 'global' },
    });
    expect(snapshot.watermark.sequence).toBe(s.probe.maxSequence());
  });

  it('有界分页：limit 边界页推进、跨页不重复/不遗漏、分页末尾明确', async () => {
    const s = await seedEvents();
    // 项目 A 事件 = registered + metadata_updated + project_created = 3 条。
    const rootIdentity = computeDataRootIdentity(s.app.dataRoot);
    const scope = { kind: 'project', projectId: s.projectA.id } as const;
    const binding = createEventCursorBinding({ rootIdentity, scope });
    const seen: PublicStateEvent[] = [];
    let cursor = encodeEventCursor(0, binding);
    for (let page = 0; page < 10; page += 1) {
      const result = await s.app.queryService.listEvents(s.owner, { scope, cursor, limit: 2 });
      seen.push(...result.events);
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    const persisted = s.probe.stateEvents().filter((row) => row.project_id === s.projectA.id);
    expect(seen.map((event) => event.eventId)).toEqual(persisted.map((row) => row.id));
    expect(seen).toHaveLength(3);
    // 分页末尾明确：以最后一条事件的 sequence 为下界再读 → 明确空页。
    const terminal = await s.app.queryService.listEvents(s.owner, {
      scope,
      cursor: encodeEventCursor(seen[seen.length - 1]!.sequence, binding),
      limit: 2,
    });
    expect(terminal.events).toEqual([]);
    expect(terminal.nextCursor).toBeNull();
    // 空库行为：未注册任何事件的 scope 从水位 0 读取得到明确空页。
    const empty = await s.app.queryService.listEvents(s.owner, {
      scope: { kind: 'project', projectId: s.projectB.id },
      cursor: encodeEventCursor(
        0,
        createEventCursorBinding({
          rootIdentity,
          scope: { kind: 'project', projectId: s.projectB.id },
        }),
      ),
      limit: 100,
    });
    // project B 有 registered 事件。
    expect(empty.events).toHaveLength(1);
    expect(empty.nextCursor).toBeNull();
  });

  it('非法/越界/伪造游标与非法 limit 一律明确拒绝，绝不当从零读取', async () => {
    const s = await seedEvents();
    const rootIdentity = computeDataRootIdentity(s.app.dataRoot);
    const scope = { kind: 'project', projectId: s.projectA.id } as const;
    const validCursor = encodeEventCursor(1, createEventCursorBinding({ rootIdentity, scope }));
    const foreignRootCursor = encodeEventCursor(
      0,
      createEventCursorBinding({ rootIdentity: '0'.repeat(64), scope }),
    );
    const crossScopeCursor = encodeEventCursor(
      0,
      createEventCursorBinding({ rootIdentity, scope: { kind: 'global' } }),
    );
    const cases: Array<{ input: unknown; reason?: string }> = [
      { input: { scope, limit: 10 }, reason: 'cursor_required' }, // 缺游标
      { input: { scope, cursor: validCursor, limit: 0 }, reason: undefined },
      { input: { scope, cursor: validCursor, limit: 501 }, reason: undefined },
      { input: { scope, cursor: validCursor, limit: 2.5 }, reason: undefined },
      { input: { scope, cursor: 'evcur_v1_not-base64!!' }, reason: 'invalid_cursor' },
      { input: { scope, cursor: `${validCursor}x` }, reason: 'invalid_cursor' }, // 篡改
      { input: { scope, cursor: foreignRootCursor }, reason: 'invalid_cursor' }, // 其他数据根
      { input: { scope, cursor: crossScopeCursor }, reason: 'invalid_cursor' }, // scope 不符
      { input: { scope, cursor: validCursor, actorId: 'local-owner' }, reason: undefined }, // 提权未知键
    ];
    for (const { input, reason } of cases) {
      const error = await s.app.queryService.listEvents(s.owner, input).catch((caught) => caught);
      expect(error).toBeInstanceOf(PublicError);
      expect(error).toMatchObject({ code: 'invalid_input' });
      if (reason !== undefined) {
        expect((error as PublicError).details).toMatchObject({ field: 'cursor', reason });
      }
    }
    // 未来游标合法：等待新事件，不报错。
    const future = await s.app.queryService.listEvents(s.owner, {
      scope,
      cursor: encodeEventCursor(10_000, createEventCursorBinding({ rootIdentity, scope })),
      limit: 100,
    });
    expect(future.events).toEqual([]);
    expect(future.nextCursor).toBeNull();
  });

  it('事件读取授权：events.read + 范围读能力；越权在任何读取之前 forbidden', async () => {
    const s = await seedEvents();
    const rootIdentity = computeDataRootIdentity(s.app.dataRoot);
    const scopeA = { kind: 'project', projectId: s.projectA.id } as const;
    const cursorA = encodeEventCursor(0, createEventCursorBinding({ rootIdentity, scope: scopeA }));
    const noEvents = s.box.restrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: s.box.scopeAllowlist([s.projectA.id]),
    });
    const denied = await s.app.queryService
      .listEvents(noEvents, { scope: scopeA, cursor: cursorA, limit: 10 })
      .catch((caught) => caught);
    expect(denied).toMatchObject({ code: 'forbidden', details: { reason: 'capability_denied' } });

    const eventsOnlyB = s.box.restrictedPrincipal({
      capabilities: ['events.read', 'project.read'],
      projectScope: s.box.scopeAllowlist([s.projectB.id]),
    });
    const crossProject = await s.app.queryService
      .listEvents(eventsOnlyB, { scope: scopeA, cursor: cursorA, limit: 10 })
      .catch((caught) => caught);
    expect(crossProject).toMatchObject({
      code: 'forbidden',
      details: { reason: 'project_not_visible' },
    });
    const globalDenied = await s.app.queryService
      .listEvents(eventsOnlyB, {
        scope: { kind: 'global' },
        cursor: encodeEventCursor(
          0,
          createEventCursorBinding({ rootIdentity, scope: { kind: 'global' } }),
        ),
        limit: 10,
      })
      .catch((caught) => caught);
    expect(globalDenied).toMatchObject({ code: 'forbidden' });
  });

  it('游标在关闭重开后不重置：旧游标继续补读新事件', async () => {
    const s = await seedEvents();
    const snapshot = projectSnapshot(
      await s.app.queryService.getSnapshot(s.owner, { kind: 'project', projectId: s.projectA.id }),
    );
    const cursor = snapshot.watermark.cursor;
    s.app.close();
    const reopened = await s.box.openApplication();
    await reopened.commandService.submit(
      s.owner,
      s.envelope('project.metadata.update', { kind: 'project', projectId: s.projectA.id }, {
        expectedRevision: 2,
        payload: { displayName: 'project A v3' },
      }),
    );
    const page = await reopened.queryService.listEvents(s.owner, {
      scope: { kind: 'project', projectId: s.projectA.id },
      cursor,
      limit: 100,
    });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ type: 'project.metadata_updated' });
    expect(page.events[0]!.payload).toEqual({ changedFields: ['displayName'] });
  });

  it('未知类型/白名单越界/scope 不一致的持久事件行列 → corrupt_state（不静默跳过、不伪造）', async () => {
    const s = await seedEvents();
    const rootIdentity = computeDataRootIdentity(s.app.dataRoot);
    const scope = { kind: 'global' } as const;
    const cursor = encodeEventCursor(0, createEventCursorBinding({ rootIdentity, scope }));
    const harness = await s.box.openTransactionalHarness();
    const insertRow = (sequence: number, eventType: string, payload: string) => {
      // DDL CHECK（json_valid + json_type=object）已拦截非 JSON/非对象 payload；
      // 以下为可通过 CHECK 的「合法 JSON 对象但白名单越界/未知类型」损坏形态。
      harness.session.database
        .prepare(
          'INSERT INTO state_events (id, created_at, revision, updated_at, project_id, sequence, event_type, aggregate_type, aggregate_id, aggregate_revision, payload, occurred_at) ' +
            'VALUES (?, 1, 1, 1, NULL, ?, ?, ?, ?, 1, ?, 1)',
        )
        .run(randomUUID(), sequence, eventType, 'global_settings', 'global', payload);
    };
    const removeRow = (sequence: number) => {
      harness.session.database.prepare('DELETE FROM state_events WHERE sequence = ?').run(sequence);
    };
    try {
      // payload 白名单越界（可能含值/秘密的未知键绝不透传）。
      insertRow(900, 'settings.global_updated', '{"evil":"secret-value"}');
      const violation = await s.app.queryService
        .listEvents(s.owner, { scope, cursor, limit: 100 })
        .catch((caught) => caught);
      expect(violation).toMatchObject({
        code: 'corrupt_state',
        details: { reason: 'event_payload_violation' },
      });
      expect(JSON.stringify(violation.toErrorShape())).not.toContain('secret-value');
      removeRow(900);

      // 未知事件类型（白名单外）。
      insertRow(901, 'work.started', '{}');
      const unknownType = await s.app.queryService
        .listEvents(s.owner, { scope, cursor, limit: 100 })
        .catch((caught) => caught);
      expect(unknownType).toMatchObject({
        code: 'corrupt_state',
        details: { reason: 'unknown_event_type' },
      });
      removeRow(901);

      // scope 不一致（项目事件类型携带 NULL project_id）。
      insertRow(902, 'project.metadata_updated', '{"changedFields":["labels"]}');
      const mismatch = await s.app.queryService
        .listEvents(s.owner, { scope, cursor, limit: 100 })
        .catch((caught) => caught);
      expect(mismatch).toMatchObject({
        code: 'corrupt_state',
        details: { reason: 'event_scope_mismatch' },
      });
      removeRow(902);
      // 损坏行不影响不读事件的查询面。
      expect((await s.app.queryService.countProjectLabels(s.owner)).labels).toBeDefined();
    } finally {
      harness.close();
    }
  });
});

describe('F-010 快照边界真实并发（跨进程写入 × 持续快照）', () => {
  it('并发写入期间的每个快照都内部一致；水位后补读 + 应用 = 最终持久状态', async () => {
    const s = await setup();
    const project = await s.register(s.box.repoDirA, 'project A');
    await s.submit('settings.global.create', { kind: 'global' }, { payload: GLOBAL_PAYLOAD });
    await s.submit('settings.project.create', { kind: 'project', projectId: project.id }, {
      payload: PROJECT_PAYLOAD,
    });
    const baseline = projectSnapshot(
      await s.app.queryService.getSnapshot(s.owner, { kind: 'project', projectId: project.id }),
    );
    const baselineWatermark = baseline.watermark.sequence;

    environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f010-race-' });
    const child = environment.processes.spawn({
      scriptPath: fileURLToPath(new URL('./helpers/p02-2/snapshot-writer-child.ts', import.meta.url)),
      config: { dbPath: s.box.dbPath, projectId: project.id, updates: 40, now: NOW },
      cwd: environment.sandboxRoot,
      env: environment.childEnv(),
      label: 'snapshot-writer',
      readyTimeoutMs: 10_000,
      requireInside: environment.sandboxRoot,
      evidence: environment.evidence,
    });
    await child.waitReady(10_000);
    child.releaseGo();
    const childResult = child.waitMessage('race-result', 30_000);

    const rootIdentity = computeDataRootIdentity(s.app.dataRoot);
    const scope = { kind: 'project', projectId: project.id } as const;
    const binding = createEventCursorBinding({ rootIdentity, scope });

    // 子进程写入期间持续快照：每个快照必须与「水位覆盖的事件集合」精确一致。
    let snapshotCount = 0;
    const expectedRevisionAt = (
      events: readonly StateEventProbeRow[],
      watermark: number,
      aggregateType: string,
      projectId: string | null,
      fallback: number,
    ): number => {
      const relevant = events.filter(
        (row) =>
          row.sequence <= watermark &&
          row.aggregate_type === aggregateType &&
          row.project_id === projectId,
      );
      if (relevant.length === 0) return fallback;
      return Math.max(...relevant.map((row) => row.aggregate_revision));
    };
    for (let round = 0; round < 40; round += 1) {
      const snapshot = projectSnapshot(
        await s.app.queryService.getSnapshot(s.owner, { kind: 'project', projectId: project.id }),
      );
      snapshotCount += 1;
      const watermark = snapshot.watermark.sequence;
      expect(decodeEventCursor(snapshot.watermark.cursor, binding).sequence).toBe(watermark);
      const events = s.probe.stateEvents();
      // 水位 ≤ 当前持久最大序列；水位之后的事件绝不反映在快照内，
      // 水位之内的事件必然已反映（同一读视图）。
      expect(watermark).toBeLessThanOrEqual(Math.max(0, ...events.map((row) => row.sequence)));
      expect(snapshot.project.revision).toBe(
        expectedRevisionAt(events, watermark, 'project', project.id, 1),
      );
      expect(snapshot.settings!.revision).toBe(
        expectedRevisionAt(events, watermark, 'project_settings', project.id, 1),
      );
      const globalRevision = expectedRevisionAt(events, watermark, 'global_settings', null, 1);
      expect(snapshot.effective.strategies.defaultStrategy?.source).toMatchObject({
        kind: 'global_default',
        scopeRevision: globalRevision,
      });
    }
    expect(snapshotCount).toBeGreaterThan(0);

    const result = await childResult;
    expect(result).toMatchObject({ kind: 'race-result', written: 40 });
    const exit = await child.verifyStopped();
    expect(exit.code).toBe(0);
    expect(() => process.kill(child.pid, 0)).toThrow();

    // 最终一致性：从基线水位补读全部项目事件（小页强制分页），应用后与探针一致。
    const finalEvents: PublicStateEvent[] = [];
    let cursor = encodeEventCursor(baselineWatermark, binding);
    for (let page = 0; page < 50; page += 1) {
      const result2 = await s.app.queryService.listEvents(s.owner, { scope, cursor, limit: 3 });
      finalEvents.push(...result2.events);
      if (result2.nextCursor === null) break;
      cursor = result2.nextCursor;
    }
    const persistedAfter = s.probe
      .stateEvents()
      .filter((row) => row.sequence > baselineWatermark && row.project_id === project.id);
    expect(finalEvents.map((event) => event.eventId)).toEqual(
      persistedAfter.map((row) => row.id),
    );
    expect(finalEvents.map((event) => event.sequence)).toEqual(
      [...finalEvents.map((event) => event.sequence)].sort((a, b) => a - b),
    );
    // 全局事件不属于项目流；全局流从同一水位补读恰好覆盖全局事件。
    const globalBinding = createEventCursorBinding({ rootIdentity, scope: { kind: 'global' } });
    const globalPage = await s.app.queryService.listEvents(s.owner, {
      scope: { kind: 'global' },
      cursor: encodeEventCursor(baselineWatermark, globalBinding),
      limit: 500,
    });
    const persistedGlobalAfter = s.probe
      .stateEvents()
      .filter((row) => row.sequence > baselineWatermark && row.project_id === null);
    expect(globalPage.events.map((event) => event.eventId)).toEqual(
      persistedGlobalAfter.map((row) => row.id),
    );

    const finalSnapshot = projectSnapshot(
      await s.app.queryService.getSnapshot(s.owner, { kind: 'project', projectId: project.id }),
    );
    const finalProject = s.probe.projectRow(project.id)!;
    expect(finalSnapshot.project.revision).toBe(finalProject.revision);
    expect(finalSnapshot.watermark.sequence).toBe(s.probe.maxSequence());
    expect(finalSnapshot.effective.strategies.defaultStrategy?.source).toMatchObject({
      kind: 'global_default',
      scopeRevision: s.probe.settingsRow('global')!.revision,
    });
    // 子进程写入次数 = 元数据更新 20 + 全局更新 20；快照/读取零写入。
    expect(finalProject.revision).toBe(1 + 20);
    expect(s.probe.settingsRow('global')!.revision).toBe(1 + 20);
  }, 60_000);
});
