/**
 * F-010 授权项目/配置查询（Core 应用层直接测试，不经 HTTP）：
 * - 项目列表/标签计数：可见范围谓词先于分页/计数下推（交错 id 的分页边界证明
 *   「先收窄再分页」，不是全库分页后内存过滤）；标签 any/all、稳定键集分页、
 *   非法 limit/cursor/未知键在任何 SQL 之前拒绝；
 * - projects.get / binding.get / settings.get / effective / export：能力 +
 *   可见范围授权（不可见与不存在统一 forbidden，配置缺失保持 not_found）；
 * - 无配置 = configured:false / not_found，与损坏持久 JSON / 未知版本
 *   （corrupt_state）严格区分，不降级成「已配置」；
 * - 查询全部只读：不解析凭据引用、不接受任意文件路径、不写 state_events；
 *   提权字段（actorId/principal/capabilities/scope）按未知键拒绝；
 * - 断言基于真实 SQLite 行/探针，不以 mock 代替端口结果。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteQueryStore } from '../packages/core/src/adapters/sqlite/query-store.ts';
import { PublicError } from '../packages/core/src/ports/commands.ts';
import type { CommandReceipt } from '../packages/core/src/ports/commands.ts';
import type { SettingsPayload } from '../packages/core/src/ports/settings-schema.ts';
import {
  createCommandsTestFixture,
  type CommandsTestFixture,
} from './helpers/p02-2/index.ts';

const NOW = 1_900_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();

/** 夹具能力目录允许的组合：pi/anthropic + 枚举模型 claude-sonnet / claude-sonnet-2。 */
const GLOBAL_PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
  policies: { verification: { requireChecksBeforeDone: true } },
};
const PROJECT_PAYLOAD: SettingsPayload = {
  schemaVersion: 2,
  strategies: {
    modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' } },
  },
};

let fixture: CommandsTestFixture | undefined;
afterEach(() => {
  if (fixture !== undefined) {
    fixture.cleanup();
    expect(fixture.cleaned).toBe(true);
    fixture = undefined;
  }
});

async function setup() {
  const box = createCommandsTestFixture({ prefix: 'shiploop-f010q-' });
  fixture = box;
  const app = await box.openApplication();
  const probe = box.openProbe();
  const owner = box.localOwner();
  const envelope = (operation: string, scope: unknown, changes: Record<string, unknown> = {}) => ({
    schemaVersion: 3,
    commandId: randomUUID(),
    operation,
    scope,
    issuedAt: NOW_ISO,
    ...changes,
  });
  const register = async (repositoryPath: string, displayName: string, labels: string[] = []) => {
    const receipt = await app.commandService.submit(
      owner,
      envelope('project.register', { kind: 'registration' }, {
        payload: { repositoryPath, displayName, labels },
      }),
    );
    if (receipt.status !== 'completed') {
      throw new Error(`注册失败：${JSON.stringify(receipt.error)}`);
    }
    const result = receipt.result as { project: { id: string } };
    return result.project.id;
  };
  const createGlobal = async (payload: SettingsPayload = GLOBAL_PAYLOAD) => {
    const receipt = await app.commandService.submit(
      owner,
      envelope('settings.global.create', { kind: 'global' }, { payload }),
    );
    if (receipt.status !== 'completed') throw new Error('全局配置创建失败');
    return receipt;
  };
  const createProjectSettings = async (projectId: string, payload: SettingsPayload = PROJECT_PAYLOAD) => {
    const receipt = await app.commandService.submit(
      owner,
      envelope('settings.project.create', { kind: 'project', projectId }, { payload }),
    );
    if (receipt.status !== 'completed') throw new Error('项目配置创建失败');
    return receipt;
  };
  return { box, app, probe, owner, envelope, register, createGlobal, createProjectSettings };
}

/** 直接创建 N 个 P01 项目（不经命令路径，不写事件），返回按 id 升序的项目 id。 */
async function createPlainProjects(
  s: Awaited<ReturnType<typeof setup>>,
  count: number,
  labels: readonly string[][] = [],
): Promise<string[]> {
  const harness = await s.box.openTransactionalHarness();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const project = await harness.store.createProject({
      displayName: `plain ${index}`,
      labels: labels[index] ?? [],
    });
    ids.push(project.id);
  }
  harness.close();
  return ids.sort();
}

describe('F-010 授权项目列表与标签计数', () => {
  it('owner 分页列表：schemaVersion=2 / scope=project-list / 稳定 id 升序 / ISO 时间 / 分页边界明确', async () => {
    const s = await setup();
    const ids = await createPlainProjects(s, 3, [['dev'], ['ops'], ['dev', 'ops']]);
    const page1 = await s.app.queryService.listProjects(s.owner, { limit: 2 });
    expect(page1.schemaVersion).toBe(3);
    expect(page1.scope).toBe('project-list');
    expect(page1.limit).toBe(2);
    expect(page1.records.map((record) => record.id)).toEqual([ids[0], ids[1]]);
    expect(page1.nextCursor).toBe(ids[1]);
    // 公开记录使用 ISO UTC 时间字段，不泄漏 *UtcMs 内部字段。
    expect(page1.records[0]).not.toHaveProperty('createdAtUtcMs');
    expect(page1.records[0]).toMatchObject({ status: 'active', repositoryBindingId: null });
    expect(typeof page1.records[0]!.createdAt).toBe('string');
    expect(new Date(page1.records[0]!.createdAt).toISOString()).toBe(page1.records[0]!.createdAt);

    const page2 = await s.app.queryService.listProjects(s.owner, {
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.records.map((record) => record.id)).toEqual([ids[2]]);
    expect(page2.nextCursor).toBeNull();
    // 分页末尾后的空页：明确空结果。
    const page3 = await s.app.queryService.listProjects(s.owner, { limit: 2, cursor: ids[2] });
    expect(page3.records).toEqual([]);
    expect(page3.nextCursor).toBeNull();
  });

  it('可见范围先于分页下推：交错不可见项目时受限主体分页不缺失/不重复', async () => {
    const s = await setup();
    const ids = await createPlainProjects(s, 5);
    // 可见位置 1/2/4，不可见位置 0/3（id 升序交错）：若实现为「全库分页后内存过滤」，
    // limit=2 的第一页只能看到位置 1（位置 0 被过滤），本用例据此识别下推顺序。
    const visible = [ids[1]!, ids[2]!, ids[4]!];
    const restricted = s.box.restrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: s.box.scopeAllowlist(visible),
    });
    const page1 = await s.app.queryService.listProjects(restricted, { limit: 2 });
    expect(page1.records.map((record) => record.id)).toEqual([visible[0], visible[1]]);
    expect(page1.nextCursor).toBe(visible[1]);
    const page2 = await s.app.queryService.listProjects(restricted, {
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.records.map((record) => record.id)).toEqual([visible[2]]);
    expect(page2.nextCursor).toBeNull();
    // 受限主体永远看不到不可见项目 id。
    const all = await s.app.queryService.listProjects(restricted, { limit: 200 });
    expect(all.records).toHaveLength(3);
    expect(all.records.map((record) => record.id)).not.toContain(ids[0]);
    expect(all.records.map((record) => record.id)).not.toContain(ids[3]);
  });

  it('标签 any/all 与可见范围叠加；标签计数只统计可见项目（去重）', async () => {
    const s = await setup();
    const harness = await s.box.openTransactionalHarness();
    const created: { id: string; labels: string[] }[] = [];
    for (const labels of [['dev'], ['dev', 'ops'], ['ops'], ['dev', 'ops']]) {
      const project = await harness.store.createProject({
        displayName: `labeled ${created.length}`,
        labels,
      });
      created.push({ id: project.id, labels });
    }
    harness.close();
    const visibleIds = [created[0]!.id, created[1]!.id, created[2]!.id];
    const restricted = s.box.restrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: s.box.scopeAllowlist(visibleIds),
    });
    const any = await s.app.queryService.listProjects(restricted, {
      labels: ['DEV', 'ops'],
      match: 'any',
    });
    expect(any.records.map((record) => record.id).sort()).toEqual([...visibleIds].sort());
    const all = await s.app.queryService.listProjects(restricted, {
      labels: ['dev', 'ops'],
      match: 'all',
    });
    expect(all.records.map((record) => record.id)).toEqual([created[1]!.id]);
    // 不可见项目 created[3]（dev+ops）不进入计数。
    const counts = await s.app.queryService.countProjectLabels(restricted);
    expect(counts).toEqual({
      labels: [
        { label: 'dev', projectCount: 2 },
        { label: 'ops', projectCount: 2 },
      ],
    });
    const ownerCounts = await s.app.queryService.countProjectLabels(s.owner);
    expect(ownerCounts).toEqual({
      labels: [
        { label: 'dev', projectCount: 3 },
        { label: 'ops', projectCount: 3 },
      ],
    });
  });

  it('非法分页/筛选参数在任何 SQL 之前拒绝（表驱动）', async () => {
    const s = await setup();
    await createPlainProjects(s, 1);
    const before = s.probe.counts();
    const badFilters: unknown[] = [
      { limit: 0 },
      { limit: 201 },
      { limit: 1.5 },
      { limit: '2' },
      { cursor: '..' }, // 非法稳定 ID 形态
      { cursor: '/etc/passwd' }, // 路径形态不是游标
      { match: 'some' },
      { labels: ['ok'], actorId: 'local-owner' }, // 提权字段按未知键拒绝
      { labels: ['ok'], principal: 'local-owner' },
      { unknown: true },
      'not-an-object',
    ];
    for (const filter of badFilters) {
      const error = await s.app.queryService.listProjects(s.owner, filter).catch((caught) => caught);
      expect(error).toBeInstanceOf(PublicError);
      expect((error as PublicError).code).toBe('invalid_input');
      expect((error as PublicError).operation).toBe('projects.list');
    }
    expect(s.probe.counts()).toEqual(before);
  });

  it('缺 project.read 能力的受限主体：forbidden 且不触碰任何业务状态', async () => {
    const s = await setup();
    const ids = await createPlainProjects(s, 1);
    const noRead = s.box.restrictedPrincipal({
      capabilities: ['events.read'],
      projectScope: s.box.scopeAllowlist([ids[0]!]),
    });
    const before = s.probe.counts();
    const error = await s.app.queryService.listProjects(noRead, {}).catch((caught) => caught);
    expect(error).toBeInstanceOf(PublicError);
    expect(error).toMatchObject({ code: 'forbidden', details: { reason: 'capability_denied' } });
    const countError = await s.app.queryService.countProjectLabels(noRead).catch((caught) => caught);
    expect(countError).toMatchObject({ code: 'forbidden' });
    expect(s.probe.counts()).toEqual(before);
  });
});

describe('F-010 项目详情与绑定查询', () => {
  it('projects.get：项目 + 绑定一次授权组装；公开形状为 ISO 时间；绑定只读事实', async () => {
    const s = await setup();
    const projectId = await s.register(s.box.repoDirA, 'project A', ['a']);
    const detail = await s.app.queryService.getProject(s.owner, projectId);
    expect(detail.project).toMatchObject({ id: projectId, displayName: 'project A', labels: ['a'] });
    expect(detail.binding).not.toBeNull();
    expect(detail.binding).toMatchObject({ projectId });
    expect(typeof detail.binding!.canonicalPath).toBe('string');
    expect(typeof detail.binding!.repoIdentity).toBe('string');
    expect(detail.binding!.repoIdentity).toMatch(/^gitdir-sha256:[0-9a-f]{64}$/);
    const bindingOnly = await s.app.queryService.getRepositoryBinding(s.owner, projectId);
    expect(bindingOnly.binding).toEqual(detail.binding);
  });

  it('无绑定项目 binding 为 null；binding.get 对无绑定项目返回 not_found', async () => {
    const s = await setup();
    const [projectId] = await createPlainProjects(s, 1);
    const detail = await s.app.queryService.getProject(s.owner, projectId!);
    expect(detail.binding).toBeNull();
    const error = await s.app.queryService
      .getRepositoryBinding(s.owner, projectId!)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(PublicError);
    expect(error).toMatchObject({
      code: 'not_found',
      details: { entityType: 'repository_binding' },
    });
  });

  it('不可见项目与不存在项目统一 forbidden（不区分存在性，不回显 projectId）', async () => {
    const s = await setup();
    const visibleId = await s.register(s.box.repoDirA, 'project A');
    const hiddenId = await s.register(s.box.repoDirB, 'project B');
    const restricted = s.box.restrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: s.box.scopeAllowlist([visibleId]),
    });
    const before = s.probe.counts();
    for (const target of [hiddenId, randomUUID()]) {
      const error = await s.app.queryService.getProject(restricted, target).catch((caught) => caught);
      expect(error).toBeInstanceOf(PublicError);
      expect(error).toMatchObject({
        code: 'forbidden',
        details: { reason: 'project_not_visible', entityType: 'project' },
      });
      expect(JSON.stringify(error.toErrorShape())).not.toContain(target);
      const bindingError = await s.app.queryService
        .getRepositoryBinding(restricted, target)
        .catch((caught) => caught);
      expect(bindingError).toMatchObject({ code: 'forbidden' });
    }
    expect(s.probe.counts()).toEqual(before);
  });

  it('非法 projectId（含任意文件路径形态）在任何读取之前 invalid_input；合法形态未知 id 为 forbidden', async () => {
    const s = await setup();
    const before = s.probe.counts();
    for (const bad of ['../etc/passwd', '/etc/passwd', ' spaces ', 42, null]) {
      const error = await s.app.queryService.getProject(s.owner, bad).catch((caught) => caught);
      expect(error).toBeInstanceOf(PublicError);
      expect((error as PublicError).code).toBe('invalid_input');
    }
    // 合法稳定 ID 形态但不存在：与不可见统一 forbidden（不区分存在性探测）。
    const unknown = await s.app.queryService
      .getProject(s.owner, 'not-a-uuid-but-stable')
      .catch((caught) => caught);
    expect(unknown).toMatchObject({ code: 'forbidden', details: { reason: 'project_not_visible' } });
    expect(s.probe.counts()).toEqual(before);
  });
});

describe('F-010 配置查询（当前值/有效配置/脱敏导出）', () => {
  it('全局/项目当前值：缺失 not_found；创建后返回 scope/schemaVersion/revision/payload', async () => {
    const s = await setup();
    const projectId = await s.register(s.box.repoDirA, 'project A');
    const missingGlobal = await s.app.queryService
      .getGlobalSettings(s.owner)
      .catch((caught) => caught);
    expect(missingGlobal).toMatchObject({
      code: 'not_found',
      details: { entityType: 'global_settings' },
    });
    const missingProject = await s.app.queryService
      .getProjectSettings(s.owner, projectId)
      .catch((caught) => caught);
    expect(missingProject).toMatchObject({
      code: 'not_found',
      details: { entityType: 'project_settings' },
    });

    await s.createGlobal();
    await s.createProjectSettings(projectId);
    const global = await s.app.queryService.getGlobalSettings(s.owner);
    expect(global).toMatchObject({
      scope: { kind: 'global' },
      schemaVersion: 2,
      revision: 1,
      payload: GLOBAL_PAYLOAD,
    });
    const project = await s.app.queryService.getProjectSettings(s.owner, projectId);
    expect(project).toMatchObject({
      scope: { kind: 'project', projectId },
      schemaVersion: 2,
      revision: 1,
      payload: PROJECT_PAYLOAD,
    });
  });

  it('全局读独立授权：项目能力不蕴含全局；写能力不蕴含读', async () => {
    const s = await setup();
    const projectId = await s.register(s.box.repoDirA, 'project A');
    await s.createGlobal();
    const projectOnly = s.box.restrictedPrincipal({
      capabilities: ['project.read'],
      projectScope: s.box.scopeAllowlist([projectId]),
    });
    const error = await s.app.queryService.getGlobalSettings(projectOnly).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'forbidden', details: { reason: 'capability_denied' } });
    const writeOnly = s.box.restrictedPrincipal({
      capabilities: ['settings.global.write'],
      projectScope: { kind: 'all' },
    });
    const writeOnlyError = await s.app.queryService
      .getGlobalSettings(writeOnly)
      .catch((caught) => caught);
    expect(writeOnlyError).toMatchObject({ code: 'forbidden' });
    // settings.project.read 与 project.read 任一可读项目配置。
    const settingsReader = s.box.restrictedPrincipal({
      capabilities: ['settings.project.read'],
      projectScope: s.box.scopeAllowlist([projectId]),
    });
    const missing = await s.app.queryService
      .getProjectSettings(settingsReader, projectId)
      .catch((caught) => caught);
    expect(missing).toMatchObject({ code: 'not_found' });
  });

  it('项目配置跨项目拒绝：受限 A 主体读 B 配置 forbidden，失败零副作用', async () => {
    const s = await setup();
    const projectA = await s.register(s.box.repoDirA, 'project A');
    const projectB = await s.register(s.box.repoDirB, 'project B');
    await s.createProjectSettings(projectB);
    const restrictedA = s.box.restrictedPrincipal({
      capabilities: ['project.read', 'settings.project.read'],
      projectScope: s.box.scopeAllowlist([projectA]),
    });
    const before = s.probe.counts();
    for (const method of ['getProjectSettings', 'getEffectiveSettings', 'exportProjectSettings'] as const) {
      const error = await s.app.queryService[method](restrictedA, projectB).catch((caught) => caught);
      expect(error).toBeInstanceOf(PublicError);
      expect(error).toMatchObject({ code: 'forbidden' });
    }
    expect(s.probe.counts()).toEqual(before);
  });

  it('有效配置：双方均无策略 = configured:false；合并来源 scopeRevision 与持久记录一致', async () => {
    const s = await setup();
    const projectId = await s.register(s.box.repoDirA, 'project A');
    const empty = await s.app.queryService.getEffectiveSettings(s.owner, projectId);
    expect(empty).toMatchObject({ configured: false, schemaVersion: 2 });

    await s.createGlobal();
    await s.createProjectSettings(projectId);
    const effective = await s.app.queryService.getEffectiveSettings(s.owner, projectId);
    expect(effective.configured).toBe(true);
    expect(effective.strategies.defaultStrategy?.source).toEqual({
      kind: 'global_default',
      scopeRevision: 1,
      sourceKey: 'defaultStrategy',
    });
    expect(effective.strategies.modelMap.low?.source).toEqual({
      kind: 'project_default',
      scopeRevision: 1,
      sourceKey: 'modelMap.low',
    });
    const unknown = await s.app.queryService
      .getEffectiveSettings(s.owner, randomUUID())
      .catch((caught) => caught);
    expect(unknown).toMatchObject({ code: 'forbidden' }); // 不存在折算为与不可见相同
  });

  it('脱敏导出：引用字符串原样保留不解析，不读取认证文件，不含可执行标记', async () => {
    const s = await setup();
    const projectId = await s.register(s.box.repoDirA, 'project A');
    const withRefs: SettingsPayload = {
      schemaVersion: 2,
      strategies: {
        defaultStrategy: {
          runtime: 'pi',
          provider: 'anthropic',
          model: 'claude-sonnet',
          credentialRef: 'keychain:shiploop/anthropic',
          endpointRef: 'https://gateway.example.internal/v1',
        },
      },
    };
    await s.createGlobal(withRefs);
    await s.createProjectSettings(projectId);
    const globalExport = await s.app.queryService.exportGlobalSettings(s.owner);
    expect(globalExport.exportFormatVersion).toBe(1);
    expect(globalExport.scope).toBe('global');
    expect(globalExport.current.strategies?.defaultStrategy).toMatchObject({
      credentialRef: 'keychain:shiploop/anthropic',
      endpointRef: 'https://gateway.example.internal/v1',
    });
    const projectExport = await s.app.queryService.exportProjectSettings(s.owner, projectId);
    expect(projectExport.scope).toBe('project');
    expect(projectExport.projectId).toBe(projectId);
    // 导出不含可执行/就绪标记，不含开发机/数据根路径。
    const serialized = JSON.stringify(projectExport);
    expect(serialized).not.toContain('executable');
    expect(serialized).not.toContain('ready');
    expect(serialized).not.toContain(s.box.root);
    expect(serialized).not.toContain(s.box.repoDirA);
    const missing = await s.app.queryService.exportGlobalSettings(
      s.box.restrictedPrincipal({
        capabilities: ['settings.global.read'],
        projectScope: { kind: 'all' },
      }),
    );
    expect(missing.exportFormatVersion).toBe(1);
  });

  it('损坏持久 JSON 形状 / 未知 schemaVersion → corrupt_state，绝不降级成「已配置」', async () => {
    const s = await setup();
    await s.createGlobal();
    const harness = await s.box.openTransactionalHarness();
    try {
      // DDL CHECK（json_valid）已拦截非 JSON 文本；以下为可通过 CHECK 的
      // 「合法 JSON 但非配置对象」损坏形态，读取路径仍须 corrupt_state。
      harness.session.database
        .prepare('UPDATE global_settings SET payload = ? WHERE id = ?')
        .run('[1,2]', 'global');
      const corrupt = await s.app.queryService.getGlobalSettings(s.owner).catch((caught) => caught);
      expect(corrupt).toBeInstanceOf(PublicError);
      expect(corrupt).toMatchObject({ code: 'corrupt_state' });

      // 未知 schemaVersion（持久数据高版本）：同样 corrupt_state，不静默误读。
      harness.session.database
        .prepare('UPDATE global_settings SET payload = ?, schema_version = ? WHERE id = ?')
        .run(JSON.stringify({ schemaVersion: 99, strategies: {} }), 99, 'global');
      const unknownVersion = await s.app.queryService
        .getGlobalSettings(s.owner)
        .catch((caught) => caught);
      expect(unknownVersion).toMatchObject({ code: 'corrupt_state' });
      const exportError = await s.app.queryService
        .exportGlobalSettings(s.owner)
        .catch((caught) => caught);
      expect(exportError).toMatchObject({ code: 'corrupt_state' });
    } finally {
      harness.close();
    }
  });
});

describe('F-010 查询面纯度与边界', () => {
  it('非法 principal 形状是编程错误（TypeError），不折算客户端错误', async () => {
    const s = await setup();
    const badPrincipal = {
      principalId: 'local-owner',
      capabilities: ['project.read'], // 数组不是 ReadonlySet
      projectScope: { kind: 'all' },
    };
    await expect(s.app.queryService.listProjects(badPrincipal, {})).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('queryService 全操作只读：多轮查询后持久行/事件/回执计数不变', async () => {
    const s = await setup();
    const projectId = await s.register(s.box.repoDirA, 'project A', ['a']);
    await s.createGlobal();
    await s.createProjectSettings(projectId);
    const before = s.probe.counts();
    const eventsBefore = s.probe.stateEvents().length;
    await s.app.queryService.listProjects(s.owner, {});
    await s.app.queryService.countProjectLabels(s.owner);
    await s.app.queryService.getProject(s.owner, projectId);
    await s.app.queryService.getRepositoryBinding(s.owner, projectId);
    await s.app.queryService.getGlobalSettings(s.owner);
    await s.app.queryService.getProjectSettings(s.owner, projectId);
    await s.app.queryService.getEffectiveSettings(s.owner, projectId);
    await s.app.queryService.exportGlobalSettings(s.owner);
    await s.app.queryService.exportProjectSettings(s.owner, projectId);
    await s.app.queryService.getSnapshot(s.owner, { kind: 'global' });
    await s.app.queryService.getSnapshot(s.owner, { kind: 'project', projectId });
    expect(s.probe.counts()).toEqual(before);
    expect(s.probe.stateEvents()).toHaveLength(eventsBefore);
  });

  it('查询模块源码纯度：ports/application 不绑定驱动/网络/文件系统', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const read = (path: string) =>
      readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf-8');
    for (const path of [
      '../packages/core/src/ports/queries.ts',
      '../packages/core/src/application/query-service.ts',
    ]) {
      const source = read(path);
      expect(source).not.toContain('better-sqlite3');
      expect(source).not.toContain('node:http');
      expect(source).not.toContain('node:fs');
      expect(source).not.toContain('node:child_process');
      expect(source).not.toContain('test-restricted');
    }
  });

  it('快照读取不得嵌套在写事务内（编程错误 TypeError）', async () => {
    const s = await setup();
    const harness = await s.box.openTransactionalHarness();
    try {
      const queryStore = createSqliteQueryStore(harness.session);
      harness.session.transactWrite('test.nested', () => {
        expect(() => queryStore.readGlobalSnapshotView()).toThrow(TypeError);
        expect(() => queryStore.listPersistedEvents({
          scope: { kind: 'global' },
          afterSequence: 0,
          limit: 10,
        })).toThrow(TypeError);
      });
    } finally {
      harness.close();
    }
  });
});
