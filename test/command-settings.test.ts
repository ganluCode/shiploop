/**
 * F-009：P01 全局/项目当前配置创建与 CAS 更新接入幂等命令纵向切片——
 * 能力目录复检与一致性视图（全局快照读取）在写事务之外，配置写入 +
 * settings.*_created / 既有 *_updated 事件 + completed 回执在同一
 * BEGIN IMMEDIATE 内原子提交；CAS/stale_dependency/重复创建在任何业务
 * 写入之前固化稳定 rejected；P01 直接服务首建仍不写创建事件（契约 §15.3）。
 * 全部断言基于真实 SQLite/只读探针/TEMP TRIGGER，不以方法调用或日志代替业务状态。
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandService } from '../packages/core/src/application/command-service.ts';
import { createSqliteAtomicCommandStore } from '../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { mapStateEvent } from '../packages/core/src/ports/events.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import { settingsChangeSummary } from '../packages/core/src/ports/state-store.ts';
import type { CommandReceipt } from '../packages/core/src/ports/commands.ts';
import type { SettingsPayload } from '../packages/core/src/ports/settings-schema.ts';
import type { StateEventProbeRow } from './helpers/p02-2/storage-probe.ts';
import {
  createCommandsTestFixture, runWithStartBarrier, runBarrierChildren, WRITE_FAULT_POINTS,
  type CommandsTestFixture,
} from './helpers/p02-2/index.ts';
import { createIsolatedHostEnvironment, type IsolatedHostEnvironment } from './helpers/host/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();

/** 夹具能力目录允许的组合：pi/anthropic + 枚举模型 claude-sonnet / claude-sonnet-2。 */
const GLOBAL_PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
  policies: { verification: { requireChecksBeforeDone: true } },
};
const GLOBAL_PAYLOAD_V2: SettingsPayload = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } },
  policies: { executionLimits: { maxConcurrentWorks: 1 } },
};
const PROJECT_PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: {
    modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } },
  },
};
const PROJECT_PAYLOAD_V2: SettingsPayload = {
  schemaVersion: 2,
  strategies: {
    purposeStrategies: { judge: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
  },
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
  fixture = createCommandsTestFixture({ prefix: 'shiploop-f009-' });
  const box = fixture;
  const harness = await box.openTransactionalHarness({ busyTimeoutMs: 10, busyRetryAttempts: 2 });
  const project = await harness.store.createProject({ displayName: 'project A', labels: ['a'] });
  let now = NOW;
  const store = createSqliteAtomicCommandStore(harness.session, { nowUtcMs: () => now });
  const service = createCommandService({
    atomicStore: store,
    capabilityCatalog: box.capabilityCatalog,
    nowUtcMs: () => now,
  });
  const probe = box.openProbe();
  const owner = box.localOwner();
  const globalCreate = (changes: Record<string, unknown> = {}) => ({
    schemaVersion: 5, commandId: randomUUID(), operation: 'settings.global.create',
    scope: { kind: 'global' }, issuedAt: NOW_ISO, payload: GLOBAL_PAYLOAD, ...changes,
  });
  const globalUpdate = (changes: Record<string, unknown> = {}) => ({
    schemaVersion: 5, commandId: randomUUID(), operation: 'settings.global.update',
    scope: { kind: 'global' }, expectedRevision: 1, issuedAt: NOW_ISO,
    payload: GLOBAL_PAYLOAD_V2, ...changes,
  });
  const projectCreate = (changes: Record<string, unknown> = {}) => ({
    schemaVersion: 5, commandId: randomUUID(), operation: 'settings.project.create',
    scope: { kind: 'project', projectId: project.id }, issuedAt: NOW_ISO,
    payload: PROJECT_PAYLOAD, ...changes,
  });
  const projectUpdate = (changes: Record<string, unknown> = {}) => ({
    schemaVersion: 5, commandId: randomUUID(), operation: 'settings.project.update',
    scope: { kind: 'project', projectId: project.id }, expectedRevision: 1, issuedAt: NOW_ISO,
    payload: PROJECT_PAYLOAD_V2, ...changes,
  });
  return {
    box, harness, project, store, service, probe, owner,
    globalCreate, globalUpdate, projectCreate, projectUpdate,
    setNow: (value: number) => { now = value; },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function original(receipt: CommandReceipt) { return { ...receipt, replayed: false }; }

function completedResult(receipt: CommandReceipt): Record<string, unknown> {
  if (receipt.status !== 'completed') throw new Error('expected completed');
  return receipt.result as Record<string, unknown>;
}

/** 行列 → F-003 公开事件映射复核（snake_case 转换由 F-010 读取端口承担）。 */
function toPublicEvent(row: StateEventProbeRow) {
  return mapStateEvent({
    id: row.id, sequence: row.sequence, eventType: row.event_type,
    aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
    aggregateRevision: row.aggregate_revision, projectId: row.project_id,
    payload: JSON.parse(row.payload), occurredAtUtcMs: row.occurred_at,
  });
}

describe('F-009 配置幂等命令', () => {
  it('全局创建原子保存配置/创建事件/回执；结果与持久状态一致且不含执行就绪语义', async () => {
    const s = await setup();
    const input = s.globalCreate();
    const receipt = await s.service.submit(s.owner, input);
    expect(receipt).toMatchObject({
      status: 'completed', replayed: false, operation: 'settings.global.create',
      scope: { kind: 'global' }, issuedAt: NOW_ISO, completedAt: NOW_ISO,
    });
    expect(completedResult(receipt)).toEqual({
      scope: { kind: 'global' }, schemaVersion: 2, revision: 1, payload: GLOBAL_PAYLOAD,
    });
    // 创建默认只影响当前配置：不声称 Task 重放/策略可执行/模型已登录。
    expect(JSON.stringify(completedResult(receipt))).not.toMatch(/executable|ready|task|login/i);
    expect(s.probe.counts()).toMatchObject({ global_settings: 1, state_events: 1, command_receipts: 1 });
    const row = s.probe.settingsRow('global');
    expect(row).toMatchObject({ revision: 1, schema_version: 2 });
    expect(JSON.parse(row!.payload)).toEqual(GLOBAL_PAYLOAD);
    // 恰一条 settings.global_created（全局 scope：project_id NULL，aggregate 'global'）。
    const events = s.probe.stateEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      project_id: null, sequence: 1, event_type: 'settings.global_created',
      aggregate_type: 'global_settings', aggregate_id: 'global', aggregate_revision: 1,
    });
    expect(JSON.parse(events[0]!.payload)).toEqual(settingsChangeSummary(GLOBAL_PAYLOAD));
    // 事件 payload 只含脱敏键名/段名：不含模型名、策略值或引用值。
    expect(events[0]!.payload).not.toMatch(/claude|anthropic|credential|secret/i);
    expect(toPublicEvent(events[0]!)).toMatchObject({
      schemaVersion: 1, sequence: 1, type: 'settings.global_created', scope: { kind: 'global' },
      aggregate: { type: 'global_settings', id: 'global', revision: 1 }, occurredAt: NOW_ISO,
    });
    // 授权读取与 resultRef 解析得到同一稳定回执。
    const app = await s.box.openApplication();
    expect(await app.commandReceiptsService.getReceipt(s.owner, input.commandId)).toEqual(original(receipt));
    if (receipt.status !== 'completed') throw new Error('expected completed');
    expect(await app.commandReceiptsService.resolveResult(s.owner, receipt.resultRef)).toEqual(original(receipt));
  });

  it('全局 CAS 更新：revision+1 且恰一条 settings.global_updated（创建+更新各一条，不重复）', async () => {
    const s = await setup();
    await s.service.submit(s.owner, s.globalCreate());
    const receipt = await s.service.submit(s.owner, s.globalUpdate());
    expect(completedResult(receipt)).toEqual({
      scope: { kind: 'global' }, schemaVersion: 2, revision: 2, payload: GLOBAL_PAYLOAD_V2,
    });
    expect(s.probe.settingsRow('global')).toMatchObject({ revision: 2 });
    expect(JSON.parse(s.probe.settingsRow('global')!.payload)).toEqual(GLOBAL_PAYLOAD_V2);
    const events = s.probe.stateEvents();
    expect(events.map(e => e.event_type)).toEqual(['settings.global_created', 'settings.global_updated']);
    expect(events[1]).toMatchObject({
      project_id: null, aggregate_type: 'global_settings', aggregate_id: 'global', aggregate_revision: 2,
    });
    expect(JSON.parse(events[1]!.payload)).toEqual(settingsChangeSummary(GLOBAL_PAYLOAD_V2));
    expect(s.probe.counts()).toMatchObject({ global_settings: 1, state_events: 2, command_receipts: 2 });
  });

  it('项目创建/更新：事件绑定项目与配置行身份，P01 服务读取一致，不触碰全局配置', async () => {
    const s = await setup();
    const created = await s.service.submit(s.owner, s.projectCreate());
    expect(completedResult(created)).toEqual({
      scope: { kind: 'project', projectId: s.project.id },
      schemaVersion: 2, revision: 1, payload: PROJECT_PAYLOAD,
    });
    const settingsRow = s.probe.settingsRow('project', s.project.id);
    expect(settingsRow).toMatchObject({ project_id: s.project.id, revision: 1, schema_version: 2 });
    const createdEvent = s.probe.stateEvents()[0]!;
    expect(createdEvent).toMatchObject({
      project_id: s.project.id, event_type: 'settings.project_created',
      aggregate_type: 'project_settings', aggregate_id: settingsRow!.id, aggregate_revision: 1,
    });
    expect(JSON.parse(createdEvent.payload)).toEqual(settingsChangeSummary(PROJECT_PAYLOAD));
    expect(toPublicEvent(createdEvent)).toMatchObject({
      type: 'settings.project_created', scope: { kind: 'project', projectId: s.project.id },
      aggregate: { type: 'project_settings', id: settingsRow!.id, revision: 1 },
    });

    const updated = await s.service.submit(s.owner, s.projectUpdate());
    expect(completedResult(updated)).toMatchObject({
      scope: { kind: 'project', projectId: s.project.id }, revision: 2, payload: PROJECT_PAYLOAD_V2,
    });
    const events = s.probe.stateEvents();
    expect(events.map(e => e.event_type)).toEqual(['settings.project_created', 'settings.project_updated']);
    expect(events[1]).toMatchObject({
      project_id: s.project.id, aggregate_type: 'project_settings',
      aggregate_id: settingsRow!.id, aggregate_revision: 2,
    });
    expect(s.probe.counts()).toMatchObject({
      project_settings: 1, global_settings: 0, state_events: 2, command_receipts: 2,
    });
    // P01 查询服务读取到同一持久值；有效配置合并来源为 project_default。
    const current = await s.harness.configurationService.getCurrentSettings({
      kind: 'project', projectId: s.project.id,
    });
    expect(current).toMatchObject({ revision: 2, payload: PROJECT_PAYLOAD_V2 });
    const effective = await s.harness.configurationService.getEffectiveSettings(s.project.id);
    expect(effective.configured).toBe(true);
    expect(effective.strategies.purposeStrategies.judge?.source.kind).toBe('project_default');
  });

  it('项目配置创建在全局未配置时合法（consistency.globalRevision=null 推导）', async () => {
    const s = await setup();
    const receipt = await s.service.submit(s.owner, s.projectCreate());
    expect(receipt.status).toBe('completed');
    expect(s.probe.counts()).toMatchObject({ project_settings: 1, global_settings: 0, state_events: 1 });
  });

  it('同 commandId/规范摘要竞争只创建一次；键序不同等价 payload 重放原回执', async () => {
    const s = await setup();
    const input = s.globalCreate();
    const outcomes = await runWithStartBarrier([
      () => s.service.submit(s.owner, input),
      () => s.service.submit(s.owner, s.globalCreate({
        commandId: input.commandId,
        payload: {
          policies: { verification: { requireChecksBeforeDone: true } },
          schemaVersion: 2,
          strategies: { defaultStrategy: { model: 'claude-sonnet', provider: 'anthropic', runtime: 'pi' } },
        },
      })),
    ]);
    const receipts = outcomes.map(outcome => {
      if (outcome.status !== 'fulfilled') throw outcome.reason;
      return outcome.value;
    });
    expect(receipts.map(original)).toEqual([original(receipts[0]!), original(receipts[0]!)]);
    expect(receipts.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(s.probe.counts()).toMatchObject({ global_settings: 1, state_events: 1, command_receipts: 1 });
  });

  it('同 ID 不同摘要 conflict（idempotency_key_reuse），原配置/事件/回执不变', async () => {
    const s = await setup();
    const input = s.globalCreate();
    await s.service.submit(s.owner, input);
    const before = s.probe.receiptRow(s.owner.principalId, input.commandId);
    await expect(s.service.submit(s.owner, { ...input, payload: GLOBAL_PAYLOAD_V2 })).rejects.toMatchObject({
      code: 'conflict', details: { reason: 'idempotency_key_reuse' },
    });
    expect(s.probe.receiptRow(s.owner.principalId, input.commandId)).toEqual(before);
    expect(s.probe.settingsRow('global')).toMatchObject({ revision: 1 });
    expect(s.probe.counts()).toMatchObject({ global_settings: 1, state_events: 1, command_receipts: 1 });
  });

  it('重复创建（不同 commandId）固化 rejected already_exists，不覆盖既有 payload/revision', async () => {
    const s = await setup();
    await s.service.submit(s.owner, s.globalCreate());
    const duplicate = await s.service.submit(s.owner, s.globalCreate({ payload: GLOBAL_PAYLOAD_V2 }));
    expect(duplicate).toMatchObject({
      status: 'rejected', replayed: false,
      error: { code: 'conflict', details: { reason: 'already_exists', entityType: 'global_settings' } },
    });
    expect(s.probe.settingsRow('global')).toMatchObject({ revision: 1 });
    expect(JSON.parse(s.probe.settingsRow('global')!.payload)).toEqual(GLOBAL_PAYLOAD);
    expect(s.probe.counts()).toMatchObject({ global_settings: 1, state_events: 1, command_receipts: 2 });
    // 项目 scope 同样 insert-only。
    await s.service.submit(s.owner, s.projectCreate());
    const projectDuplicate = await s.service.submit(s.owner, s.projectCreate());
    expect(projectDuplicate).toMatchObject({
      status: 'rejected',
      error: { code: 'conflict', details: { reason: 'already_exists', entityType: 'project_settings' } },
    });
    expect(s.probe.counts()).toMatchObject({ project_settings: 1, state_events: 2, command_receipts: 4 });
  });

  it('过期 revision 固化 rejected CAS 冲突；对象与事件不变；rejected 回执稳定重放', async () => {
    const s = await setup();
    await s.service.submit(s.owner, s.globalCreate());
    const stale = await s.service.submit(s.owner, s.globalUpdate({ expectedRevision: 2 }));
    expect(stale).toMatchObject({
      status: 'rejected',
      error: { code: 'conflict', details: { expectedRevision: 2, actualRevision: 1, entityType: 'global_settings' } },
    });
    expect(s.probe.settingsRow('global')).toMatchObject({ revision: 1 });
    expect(s.probe.counts()).toMatchObject({ global_settings: 1, state_events: 1, command_receipts: 2 });
    expect(await s.service.submit(s.owner, s.globalUpdate({
      commandId: (stale as { commandId: string }).commandId, expectedRevision: 2,
    }))).toEqual({ ...stale, replayed: true });
    // 项目 CAS 同样拒绝且不写第二条事件。
    await s.service.submit(s.owner, s.projectCreate());
    const staleProject = await s.service.submit(s.owner, s.projectUpdate({ expectedRevision: 9 }));
    expect(staleProject).toMatchObject({
      status: 'rejected',
      error: { code: 'conflict', details: { expectedRevision: 9, actualRevision: 1, entityType: 'project_settings' } },
    });
    expect(s.probe.settingsRow('project', s.project.id)).toMatchObject({ revision: 1 });
    expect(s.probe.counts()).toMatchObject({ project_settings: 1, state_events: 2 });
  });

  it('更新不存在的配置 → not_found 且不积回执；未知项目统一 forbidden 不泄漏存在性', async () => {
    const s = await setup();
    await expect(s.service.submit(s.owner, s.globalUpdate())).rejects.toMatchObject({
      code: 'not_found', details: { entityType: 'global_settings' },
    });
    await expect(s.service.submit(s.owner, s.projectUpdate())).rejects.toMatchObject({
      code: 'not_found', details: { entityType: 'project_settings' },
    });
    await expect(s.service.submit(s.owner, s.projectCreate({
      scope: { kind: 'project', projectId: randomUUID() },
    }))).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'project_not_visible' } });
    expect(s.probe.counts()).toMatchObject({
      global_settings: 0, project_settings: 0, state_events: 0, command_receipts: 0,
    });
  });

  it('全局依赖竞争：陈旧 consistency 固化 rejected stale_dependency，不提交基于旧全局值的配置', async () => {
    const s = await setup();
    await s.service.submit(s.owner, s.globalCreate());
    // 另一真实连接把全局配置推进到 revision 2（在本命令一致性快照读取之后、写事务之前提交）。
    const rival = await s.box.openTransactionalHarness();
    let rivalWrites: Promise<unknown> | undefined;
    let triggered = false;
    const racingCatalog = {
      resolve(runtimeId: string) {
        const descriptor = s.box.capabilityCatalog.resolve(runtimeId);
        if (!triggered && descriptor !== undefined) {
          triggered = true;
          // better-sqlite3 写入同步完成；Promise 稍后 await 以核验未拒绝。
          rivalWrites = rival.store.updateGlobalSettings({
            expectedRevision: 1, payload: GLOBAL_PAYLOAD_V2,
          });
        }
        return descriptor;
      },
    };
    const racingService = createCommandService({
      atomicStore: s.store, capabilityCatalog: racingCatalog, nowUtcMs: () => NOW,
    });
    const rejected = await racingService.submit(s.owner, s.projectCreate());
    await rivalWrites;
    expect(rejected).toMatchObject({
      status: 'rejected',
      error: { code: 'conflict', details: { reason: 'stale_dependency', entityType: 'project_settings' } },
    });
    expect(s.probe.counts()).toMatchObject({ project_settings: 0, state_events: 2, command_receipts: 2 });
    expect(s.probe.settingsRow('global')).toMatchObject({ revision: 2 });
    // 同信封重放稳定取回 rejected；新 commandId 基于新全局值重核后成功。
    expect(await racingService.submit(s.owner, {
      ...s.projectCreate(), commandId: (rejected as { commandId: string }).commandId,
    })).toEqual({ ...rejected, replayed: true });
    const retried = await racingService.submit(s.owner, s.projectCreate());
    expect(retried.status).toBe('completed');
    expect(s.probe.counts()).toMatchObject({ project_settings: 1, state_events: 3, command_receipts: 3 });
  });

  it('全局在快照读取后被并发创建同样 stale_dependency（null → 已存在）', async () => {
    const s = await setup();
    const rival = await s.box.openTransactionalHarness();
    let rivalWrites: Promise<unknown> | undefined;
    let triggered = false;
    const racingCatalog = {
      resolve(runtimeId: string) {
        const descriptor = s.box.capabilityCatalog.resolve(runtimeId);
        if (!triggered && descriptor !== undefined) {
          triggered = true;
          rivalWrites = rival.store.createGlobalSettings({ payload: GLOBAL_PAYLOAD });
        }
        return descriptor;
      },
    };
    const racingService = createCommandService({
      atomicStore: s.store, capabilityCatalog: racingCatalog, nowUtcMs: () => NOW,
    });
    const rejected = await racingService.submit(s.owner, s.projectCreate());
    await rivalWrites;
    expect(rejected).toMatchObject({
      status: 'rejected',
      error: { code: 'conflict', details: { reason: 'stale_dependency' } },
    });
    expect(s.probe.counts()).toMatchObject({
      project_settings: 0, global_settings: 1, state_events: 0, command_receipts: 1,
    });
  });

  it.each([
    {
      name: '未知 runtime',
      payload: { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'unknown-rt', provider: 'anthropic', model: 'm' } } },
      reason: 'unknown_runtime', field: 'payload.strategies.defaultStrategy.runtime',
    },
    {
      name: '不兼容 provider',
      payload: { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'not-a-provider', model: 'm' } } },
      reason: 'incompatible_provider', field: 'payload.strategies.defaultStrategy.provider',
    },
    {
      name: '未枚举 model',
      payload: { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'not-enumerated' } } },
      reason: 'unsupported_model', field: 'payload.strategies.defaultStrategy.model',
    },
  ])('能力兼容先拒绝：$name → invalid_input($reason)，零副作用不写回执', async ({ payload, reason, field }) => {
    const s = await setup();
    await expect(s.service.submit(s.owner, s.globalCreate({ payload }))).rejects.toMatchObject({
      code: 'invalid_input', details: { reason, field },
    });
    await expect(s.service.submit(s.owner, s.projectCreate({ payload }))).rejects.toMatchObject({
      code: 'invalid_input', details: { reason, field },
    });
    expect(s.probe.counts()).toMatchObject({
      global_settings: 0, project_settings: 0, state_events: 0, command_receipts: 0,
    });
  });

  it('继承的全局条目随当前能力目录复检（合并后有效配置）；明文秘密字段拒绝且不回显', async () => {
    const s = await setup();
    await s.service.submit(s.owner, s.globalCreate());
    // 更严格目录：anthropic 不再枚举 claude-sonnet——继承条目按当前目录复检失败。
    const strictCatalog = createStaticRuntimeCapabilityCatalog([
      { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet-2'] }] },
    ]);
    const strictService = createCommandService({
      atomicStore: s.store, capabilityCatalog: strictCatalog, nowUtcMs: () => NOW,
    });
    await expect(strictService.submit(s.owner, s.projectCreate({
      payload: { schemaVersion: 2 },
    }))).rejects.toMatchObject({
      code: 'invalid_input',
      details: { reason: 'unsupported_model', field: 'payload.strategies.defaultStrategy.model' },
    });
    expect(s.probe.counts()).toMatchObject({ project_settings: 0, state_events: 1, command_receipts: 1 });
    // 明文秘密形态字段在信封校验即拒绝，错误不回显秘密值，零副作用。
    const secret = 'sk-live-secret-value';
    const error = await s.service.submit(s.owner, s.globalCreate({
      payload: { schemaVersion: 2, strategies: { defaultStrategy: {
        runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet', apiKey: secret,
      } } },
    })).catch(e => e);
    expect(error).toMatchObject({ code: 'invalid_input' });
    expect(JSON.stringify(error.toErrorShape())).not.toContain(secret);
    expect(s.probe.counts()).toMatchObject({ state_events: 1, command_receipts: 1 });
  });

  it('授权矩阵：全局独立能力/项目能力与可见范围逐项把关，拒绝零副作用', async () => {
    const s = await setup();
    // 项目能力不蕴含全局：仅有 settings.project.write 不能写全局。
    const projectOnly = s.box.restrictedPrincipal({
      capabilities: ['settings.project.write'], projectScope: s.box.scopeAllowlist([s.project.id]),
    });
    await expect(s.service.submit(projectOnly, s.globalCreate())).rejects.toMatchObject({
      code: 'forbidden', details: { reason: 'capability_denied' },
    });
    // 全局能力不蕴含项目：仅有 settings.global.write 不能写项目配置。
    const globalOnly = s.box.restrictedPrincipal({
      capabilities: ['settings.global.write'], projectScope: s.box.scopeAllowlist([s.project.id]),
    });
    await expect(s.service.submit(globalOnly, s.projectCreate())).rejects.toMatchObject({
      code: 'forbidden', details: { reason: 'capability_denied' },
    });
    // 可见范围外的项目：能力具备但目标不可见。
    const other = await s.harness.store.createProject({ displayName: 'project B' });
    const wrongScope = s.box.restrictedPrincipal({
      capabilities: ['settings.project.write'], projectScope: s.box.scopeAllowlist([other.id]),
    });
    await expect(s.service.submit(wrongScope, s.projectCreate())).rejects.toMatchObject({
      code: 'forbidden', details: { reason: 'project_not_visible' },
    });
    expect(s.probe.counts()).toMatchObject({
      global_settings: 0, project_settings: 0, state_events: 0, command_receipts: 0,
    });
    // 恰切能力 + 可见范围可写；写后能力撤销的重放重核拒绝（不取回旧回执）。
    const allowed = s.box.restrictedPrincipal({
      capabilities: ['settings.project.write'], projectScope: s.box.scopeAllowlist([s.project.id]),
    });
    const input = s.projectCreate();
    const completed = await s.service.submit(allowed, input);
    expect(completed.status).toBe('completed');
    const revoked = s.box.restrictedPrincipal({
      principalId: allowed.principalId, capabilities: [],
      projectScope: s.box.scopeAllowlist([s.project.id]),
    });
    await expect(s.service.submit(revoked, input)).rejects.toMatchObject({ code: 'forbidden' });
    expect(s.probe.counts()).toMatchObject({ project_settings: 1, state_events: 1, command_receipts: 1 });
  });

  it.each(['globalSettingsBeforeInsert', 'stateEventsBeforeInsert', 'commandReceiptsBeforeInsert'] as const)(
    '全局创建注入 %s 整组回滚（无配置/事件/回执残留），撤除后同信封重试成功', async point => {
      const s = await setup();
      const input = s.globalCreate();
      const fault = s.harness.installFault(WRITE_FAULT_POINTS[point]);
      const error = await s.service.submit(s.owner, input).catch(e => e);
      expect(error).toMatchObject({ code: 'internal', operation: 'settings.global.create' });
      expect(JSON.stringify(error.toErrorShape())).not.toMatch(/SQL|injected|TRIGGER|shiploop-f009/);
      expect(s.probe.counts()).toMatchObject({
        global_settings: 0, state_events: 0, command_receipts: 0,
      });
      fault.remove();
      expect(await s.service.submit(s.owner, input)).toMatchObject({ status: 'completed', replayed: false });
      expect(s.probe.counts()).toMatchObject({
        global_settings: 1, state_events: 1, command_receipts: 1,
      });
    },
  );

  it.each(['projectSettingsBeforeUpdate', 'stateEventsBeforeInsert', 'commandReceiptsBeforeInsert'] as const)(
    '项目更新注入 %s 整组回滚（payload/revision 不变），撤除后同信封重试成功', async point => {
      const s = await setup();
      await s.service.submit(s.owner, s.projectCreate());
      const before = s.probe.settingsRow('project', s.project.id);
      const input = s.projectUpdate();
      const fault = s.harness.installFault(WRITE_FAULT_POINTS[point]);
      await expect(s.service.submit(s.owner, input)).rejects.toMatchObject({ code: 'internal' });
      expect(s.probe.settingsRow('project', s.project.id)).toEqual(before);
      expect(s.probe.counts()).toMatchObject({ project_settings: 1, state_events: 1, command_receipts: 1 });
      fault.remove();
      expect(await s.service.submit(s.owner, input)).toMatchObject({ status: 'completed', replayed: false });
      expect(s.probe.settingsRow('project', s.project.id)).toMatchObject({ revision: 2 });
      expect(s.probe.counts()).toMatchObject({ project_settings: 1, state_events: 2, command_receipts: 2 });
    },
  );

  it('rejected 回执写失败也回滚（CAS 拒绝不留伪回执），重试后固化稳定 rejected', async () => {
    const s = await setup();
    await s.service.submit(s.owner, s.globalCreate());
    const input = s.globalUpdate({ expectedRevision: 7 });
    const fault = s.harness.installFault(WRITE_FAULT_POINTS.commandReceiptsBeforeInsert);
    await expect(s.service.submit(s.owner, input)).rejects.toMatchObject({ code: 'internal' });
    expect(s.probe.counts()).toMatchObject({ global_settings: 1, state_events: 1, command_receipts: 1 });
    fault.remove();
    expect(await s.service.submit(s.owner, input)).toMatchObject({
      status: 'rejected', replayed: false, error: { code: 'conflict' },
    });
    expect(s.probe.counts()).toMatchObject({ global_settings: 1, state_events: 1, command_receipts: 2 });
  });

  it('过期新命令不启动业务；历史回执过期后仍稳定重放', async () => {
    const s = await setup();
    const input = s.globalCreate();
    const completed = await s.service.submit(s.owner, input);
    s.setNow(NOW + 60_000);
    await expect(s.service.submit(s.owner, s.globalUpdate())).rejects.toMatchObject({ code: 'command_expired' });
    expect(s.probe.counts()).toMatchObject({ global_settings: 1, state_events: 1, command_receipts: 1 });
    expect(await s.service.submit(s.owner, input)).toEqual({ ...completed, replayed: true });
  });

  it('P01 直接服务首建不写创建事件，命令路径写；两边界共存且更新事件不重复', async () => {
    const s = await setup();
    // P01 边界：直接服务创建全局配置，零事件（§15.3 语义保留）。
    await s.harness.configurationService.createSettings({ kind: 'global' }, { payload: GLOBAL_PAYLOAD });
    expect(s.probe.counts()).toMatchObject({ global_settings: 1, state_events: 0, command_receipts: 0 });
    // 命令路径更新：恰一条 settings.global_updated。
    const updated = await s.service.submit(s.owner, s.globalUpdate());
    expect(completedResult(updated)).toMatchObject({ revision: 2 });
    expect(s.probe.stateEvents().map(e => e.event_type)).toEqual(['settings.global_updated']);
    // 命令路径对已存在配置重复创建 → rejected already_exists，仍不写创建事件。
    const duplicate = await s.service.submit(s.owner, s.globalCreate());
    expect(duplicate).toMatchObject({ status: 'rejected', error: { code: 'conflict', details: { reason: 'already_exists' } } });
    expect(s.probe.counts()).toMatchObject({ global_settings: 1, state_events: 1, command_receipts: 2 });
    // 反向：命令创建（恰一条 created）后 P01 直接更新（恰一条 updated）。
    const direct2 = await setup2ndProject(s);
    await s.service.submit(s.owner, s.projectCreate({ scope: { kind: 'project', projectId: direct2.id } }));
    await s.harness.configurationService.updateSettings(
      { kind: 'project', projectId: direct2.id },
      { expectedRevision: 1, payload: PROJECT_PAYLOAD_V2 },
    );
    const events = s.probe.stateEvents().filter(e => e.project_id === direct2.id);
    expect(events.map(e => e.event_type)).toEqual(['settings.project_created', 'settings.project_updated']);
  });

  it('关闭重开后回执稳定；后续更新不改变原固化结果', async () => {
    const s = await setup();
    const input = s.globalCreate();
    const completed = await s.service.submit(s.owner, input);
    await s.service.submit(s.owner, s.globalUpdate());
    s.harness.close();
    const app = await s.box.openApplication({ nowUtcMs: () => NOW + 300_000 });
    expect(await app.commandService.submit(s.owner, input)).toEqual({ ...completed, replayed: true });
    expect(await app.commandReceiptsService.getReceipt(s.owner, input.commandId)).toEqual(completed);
    expect(completedResult(completed)).toMatchObject({ revision: 1, payload: GLOBAL_PAYLOAD });
    expect(s.probe.settingsRow('global')).toMatchObject({ revision: 2 });
  });

  it('未支持的操作（Task 执行/基线等）继续 unsupported，零副作用', async () => {
    const s = await setup();
    await expect(s.service.submit(s.owner, {
      schemaVersion: 5, commandId: randomUUID(), operation: 'task.execution.update',
      scope: { kind: 'project', projectId: s.project.id }, expectedRevision: 1, issuedAt: NOW_ISO,
      payload: {},
    })).rejects.toMatchObject({ code: 'unsupported' });
    expect(s.probe.counts()).toMatchObject({
      global_settings: 0, project_settings: 0, state_events: 0, command_receipts: 0,
    });
  });

  it('跨进程竞争创建全局配置：恰一个 completed，其余 rejected already_exists；核验持久副作用与全部退出', async () => {
    const s = await setup();
    environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f009-race-' });
    const outcomes = await runBarrierChildren(environment, {
      scriptPath: fileURLToPath(new URL('./helpers/p02-2/atomic-command-child.ts', import.meta.url)),
      configs: [s.globalCreate(), s.globalCreate()].map(envelope => ({
        dbPath: s.box.dbPath, envelope, now: NOW,
      })),
      readyTimeoutMs: 10_000, resultTimeoutMs: 10_000,
    });
    const results = outcomes.map(o => o.result);
    if (results.some(r => r.error)) {
      throw new Error(`子进程意外失败: ${JSON.stringify(results.find(r => r.error)?.error)}`);
    }
    const receipts = results.map(r => r.receipt as CommandReceipt);
    expect(receipts.map(r => r.status).sort()).toEqual(['completed', 'rejected']);
    const rejected = receipts.find(r => r.status === 'rejected');
    expect(rejected).toMatchObject({ error: { code: 'conflict', details: { reason: 'already_exists' } } });
    expect(s.probe.counts()).toMatchObject({ global_settings: 1, state_events: 1, command_receipts: 2 });
    expect(s.probe.stateEvents()[0]).toMatchObject({ event_type: 'settings.global_created', sequence: 1 });
    for (const outcome of outcomes) {
      expect(outcome.exit.code).toBe(0);
      expect(() => process.kill(outcome.pid, 0)).toThrow();
    }
    expect(environment.evidence.serialize()).toContain('child.exit');
  }, 30_000);
});

/** 在当前夹具再建一个项目（用于 P01/命令双路径共存用例）。 */
async function setup2ndProject(s: Setup) {
  return s.harness.store.createProject({ displayName: 'project B' });
}
