/**
 * F-008 P02-3 Core 基线预览与明确授权验收（真实临时 SQLite + 真实 Git 仓库 +
 * 真实组合根装配；环境目录/身份窄端口用显式桩件，桩件不冒充持久实现）。
 *
 * 协议依据：docs/p02-3-onboarding-contract.md §5.3（accepted 回执首次启用）、
 * §5.5（baseline.run 提交事务：授权行+操作行+回执；preview_stale；单并发占用）、
 * §6.1（检查计划）、§6.2（不可变授权摘要）、§6.3（代码身份/工作区摘要范围）、
 * §6.4（环境引用：最小默认环境 + 显式允许列表，不携带值）、§4.3
 * （baseline.run 能力 + 目标项目可见）与 §9.2（baseline.authorized 事件）。
 *
 * F-008 验收标准逐项：
 * 1. 预览列出每项实际 argv、规范 cwd、environmentRef/非敏感环境摘要、timeout、
 *    必需性、检查政策（policyRevision=planDigest）和当前代码身份；HEAD 可为
 *    null，工作区摘要覆盖 tracked/untracked 源文件与配置并记录排除范围。
 * 2. Core 核验主体项目权限、绑定身份和 cwd realpath 范围；根外 cwd、穿越、
 *    符号链接逃逸、伪项目/环境引用明确拒绝；只解析获准环境引用与必要允许变量。
 * 3. 用户确认绑定完整输入摘要（previewDigest）；计划或代码身份实质变化使旧
 *    授权失效（preview_stale）；不接受客户端自行声明 approved。
 * 4. 拒绝授权持久记录 not_run 和原因且启动次数为零；缺命令/未知脚本按明确
 *    契约处理（预览警示、不改写 argv、不自动执行/安装）；环境值/合成秘密不
 *    进入授权存档、事件或普通错误。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openCoreApplication } from '../packages/core/src/adapters/composition.ts';
import type { CoreApplication } from '../packages/core/src/adapters/composition.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';
import {
  BASELINE_MINIMAL_ENVIRONMENT_VARIABLES,
  BASELINE_WORKSPACE_EXCLUDED_DIR_NAMES,
  computeBaselinePreviewDigest,
  computeBaselineWorkingTreeDigest,
  isPublicError,
  ONBOARDING_QUERY_SCHEMA_VERSION,
} from '../packages/core/src/index.ts';
import type { BaselineCodeIdentity, BaselineWorkspaceFileEntry, CommandReceipt } from '../packages/core/src/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import type { RuntimeCapabilityCatalog } from '../packages/core/src/ports/runtime-capabilities.ts';
import { createLocalOwnerPrincipal, createRestrictedPrincipal, scopeAllowlist } from './helpers/p02-2/principals.ts';
import { createBaselineFixture } from './helpers/p02-3/index.ts';
import type { BaselineFixture } from './helpers/p02-3/index.ts';

const OWNER = createLocalOwnerPrincipal();
const NOW_MS = 1_760_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();

function createCatalog(): RuntimeCapabilityCatalog {
  return createStaticRuntimeCapabilityCatalog([
    { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }] },
  ]);
}

/** 受控环境目录桩件：唯一获准引用 'ci-env'（变量名白名单，无值）。 */
const ENV_DIRECTORY = {
  resolveEnvironmentRef(ref: string) {
    return ref === 'ci-env' ? { allowedVariables: ['CI', 'SHIPLOOP_TEST_FLAG'] } : null;
  },
} as const;

function planOf(checks: unknown): { plan: unknown } {
  return { plan: { checks } };
}

const NODE_CHECK = {
  checkKey: 'node-version',
  kind: 'command',
  argv: ['node', '--version'],
  timeoutMs: 60_000,
  required: true,
} as const;

function envelope(
  operation: string,
  projectId: string,
  payload: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: ONBOARDING_QUERY_SCHEMA_VERSION,
    commandId: randomUUID(),
    operation,
    scope: { kind: 'project', projectId },
    issuedAt: NOW_ISO,
    payload,
    ...overrides,
  };
}


/** completed 回执的内嵌 result（收窄联合；非 completed 视为测试失败）。 */
function resultOf(receipt: { status: string; result?: unknown }): Record<string, unknown> {
  if (receipt.status !== 'completed' || receipt.result === undefined) {
    throw new Error(`expected completed receipt, got ${receipt.status}`);
  }
  return receipt.result as Record<string, unknown>;
}


/** rejected 回执（收窄联合；非 rejected 视为测试失败）。 */
function rejectedOf(receipt: CommandReceipt): { code: string; details?: Record<string, unknown> } {
  if (receipt.status !== 'rejected') {
    throw new Error(`expected rejected receipt, got ${receipt.status}`);
  }
  return receipt.error;
}

async function catchPublicError(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    if (isPublicError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error('expected PublicError to be thrown');
}

describe('F-008 P02-3 基线预览与明确授权', () => {
  let fixture: BaselineFixture;
  const openApps: CoreApplication[] = [];

  beforeAll(() => {
    fixture = createBaselineFixture({ prefix: 'shiploop-p02-3-f008-' });
  });

  afterEach(() => {
    while (openApps.length > 0) {
      openApps.pop()?.close();
    }
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  async function openApp(name: string, options: Record<string, unknown> = {}): Promise<CoreApplication> {
    const app = await openCoreApplication({
      dataRoot: fixture.dataRoot(name),
      capabilityCatalog: createCatalog(),
      nowUtcMs: () => NOW_MS,
      baselineEnvironmentDirectory: ENV_DIRECTORY,
      ...options,
    });
    openApps.push(app);
    return app;
  }

  /** 注册 fixture 仓库并返回 projectId（经唯一注册路径）。 */
  async function registerProject(app: CoreApplication, repoPath: string): Promise<string> {
    const registration = await app.projectService.registerRepository({
      repositoryPath: repoPath,
      displayName: 'F-008 项目',
    });
    return registration.project.id;
  }

  /** 只读第二连接核对持久行（不干扰主会话事务）。 */
  function readRows(app: CoreApplication, sql: string, ...args: unknown[]): unknown[] {
    const session = openSqliteStorageSession({ path: app.pathService.databaseFilePath() });
    try {
      return session.database.prepare(sql).all(...args) as unknown[];
    } finally {
      session.close();
    }
  }

  /* ---------------------------------------------------------------- *
   * 纯契约：工作区摘要与预览摘要（F-002 冻结算法的落地实现）
   * ---------------------------------------------------------------- */

  it('工作区摘要纯函数：确定性、按路径排序、内容敏感；覆盖 tracked/untracked 语义由条目集合承载', () => {
    const entries: BaselineWorkspaceFileEntry[] = [
      { path: 'b.ts', sha256: 'b'.repeat(64) },
      { path: 'a.ts', sha256: 'a'.repeat(64) },
    ];
    const reversed: BaselineWorkspaceFileEntry[] = [...entries].reverse();
    const first = computeBaselineWorkingTreeDigest(entries);
    expect(computeBaselineWorkingTreeDigest(reversed)).toEqual(first);
    expect(first.fileCount).toBe(2);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    const changed = computeBaselineWorkingTreeDigest([
      { path: 'a.ts', sha256: 'a'.repeat(64) },
      { path: 'b.ts', sha256: 'c'.repeat(64) },
    ]);
    expect(changed.digest).not.toBe(first.digest);
    const untrackedAdded = computeBaselineWorkingTreeDigest([
      ...entries,
      { path: 'untracked.txt', sha256: 'e'.repeat(64) },
    ]);
    expect(untrackedAdded.fileCount).toBe(3);
    expect(untrackedAdded.digest).not.toBe(first.digest);
  });

  it('预览摘要绑定完整输入：计划或代码身份任一实质变化都使旧摘要失效', () => {
    const identity: BaselineCodeIdentity = {
      headCommit: 'a'.repeat(40),
      workingTreeDigest: 'b'.repeat(64),
      hasUncommittedChanges: false,
    };
    const planA = { checks: [{ ...NODE_CHECK }] };
    const digestA = computeBaselinePreviewDigest(planA, identity);
    expect(computeBaselinePreviewDigest({ checks: [{ ...NODE_CHECK }] }, { ...identity })).toBe(digestA);
    // argv 变化（政策/输入实质变化）。
    expect(
      computeBaselinePreviewDigest(
        { checks: [{ ...NODE_CHECK, argv: ['node', '-v'] }] },
        identity,
      ),
    ).not.toBe(digestA);
    // 代码身份变化（工作区摘要 / HEAD / 脏标记）。
    expect(
      computeBaselinePreviewDigest(planA, { ...identity, workingTreeDigest: 'c'.repeat(64) }),
    ).not.toBe(digestA);
    expect(
      computeBaselinePreviewDigest(planA, { ...identity, hasUncommittedChanges: true }),
    ).not.toBe(digestA);
    expect(
      computeBaselinePreviewDigest(planA, { ...identity, headCommit: null }),
    ).not.toBe(digestA);
  });

  /* ---------------------------------------------------------------- *
   * 验收 1：预览内容（argv/cwd/环境摘要/timeout/必需性/政策/代码身份）
   * ---------------------------------------------------------------- */

  it('预览列出每项 argv、规范 cwd、环境摘要（仅变量名）、timeout、必需性与检查政策；不含环境值', async () => {
    const app = await openApp('preview-content');
    const projectId = await registerProject(app, fixture.repos.withHead);
    const receipt = await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', projectId, planOf([
        { ...NODE_CHECK, cwdRef: 'src', environmentRef: 'ci-env' },
        { ...NODE_CHECK, checkKey: 'optional-check', required: false },
      ])),
    );
    expect(receipt.status).toBe('completed');
    const result = resultOf(receipt);
    expect(result.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.policyRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(result.policyRevision).not.toBe(result.previewDigest);
    const checks = result.checks as Record<string, unknown>[];
    expect(checks).toHaveLength(2);
    const [withCwd, rootCheck] = checks;
    expect(withCwd.argv).toEqual(['node', '--version']);
    expect(withCwd.cwdRef).toBe('src');
    expect(withCwd.cwd).toBe(join(fixture.repos.withHead, 'src'));
    expect(withCwd.environmentRef).toBe('ci-env');
    expect(withCwd.allowedVariables).toEqual(['PATH', 'CI', 'SHIPLOOP_TEST_FLAG']);
    expect(withCwd.timeoutMs).toBe(60_000);
    expect(withCwd.required).toBe(true);
    expect(rootCheck.cwdRef).toBeNull();
    expect(rootCheck.cwd).toBe(fixture.repos.withHead);
    expect(rootCheck.environmentRef).toBeNull();
    expect(rootCheck.allowedVariables).toEqual([...BASELINE_MINIMAL_ENVIRONMENT_VARIABLES]);
    // 代码身份：真实 HEAD、工作区摘要、排除范围。
    const identity = result.codeIdentity as Record<string, unknown>;
    expect(identity.headCommit).toBe(fixture.repos.headOf('withHead'));
    expect(identity.workingTreeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.hasUncommittedChanges).toBe(false);
    const workspace = result.workspace as Record<string, unknown>;
    expect(workspace.excludedDirNames).toEqual([...BASELINE_WORKSPACE_EXCLUDED_DIR_NAMES]);
    expect(typeof workspace.fileCount).toBe('number');
    // 预览摘要自洽：可用返回的 plan 语义重算（经同一纯函数）。
    const recomputed = computeBaselinePreviewDigest(
      { checks: [{ ...NODE_CHECK, cwdRef: 'src', environmentRef: 'ci-env' }, { ...NODE_CHECK, checkKey: 'optional-check', required: false }] },
      identity as unknown as BaselineCodeIdentity,
    );
    expect(result.previewDigest).toBe(recomputed);
    // 非敏感：结果不携带任何环境值或合成秘密。
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('token');
  });

  it('工作区摘要覆盖 tracked/untracked 源文件与配置，排除约定目录并记录排除范围；不假装只检查 commit', async () => {
    const app = await openApp('workspace-digest');
    const repoRoot = fixture.repos.withHead;
    const projectId = await registerProject(app, repoRoot);
    const preview1 = resultOf(await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', projectId, planOf([NODE_CHECK])),
    ));
    // 未跟踪新文件参与摘要（覆盖 untracked）。
    writeFileSync(join(repoRoot, 'untracked-new.ts'), 'export const u = 1;\n', 'utf-8');
    const preview2 = resultOf(await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', projectId, planOf([NODE_CHECK])),
    ));
    expect(preview2.codeIdentity).not.toEqual(preview1.codeIdentity);
    // 排除目录内新增文件不改变摘要（排除范围生效且被记录）。
    for (const dir of ['node_modules/pkg', 'dist', 'build', '.cache/x']) {
      const target = join(repoRoot, ...dir.split('/'));
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'generated.txt'), 'generated\n', 'utf-8');
    }
    const preview3 = resultOf(await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', projectId, planOf([NODE_CHECK])),
    ));
    expect(preview3.codeIdentity).toEqual(preview2.codeIdentity);
    expect((preview3.workspace as Record<string, unknown>).excludedDirNames).toEqual([
      ...BASELINE_WORKSPACE_EXCLUDED_DIR_NAMES,
    ]);
    rmSync(join(repoRoot, 'untracked-new.ts'));
    for (const dir of ['node_modules', 'dist', 'build', '.cache']) {
      rmSync(join(repoRoot, dir), { recursive: true, force: true });
    }
  });

  it('无 HEAD 仓库：headCommit=null 不猜分支；脏工作区：hasUncommittedChanges=true 并提示', async () => {
    const app = await openApp('head-dirty');
    const noHeadProject = await registerProject(app, fixture.repos.noInitialCommit);
    const noHead = resultOf(await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', noHeadProject, planOf([NODE_CHECK])),
    ));
    expect((noHead.codeIdentity as Record<string, unknown>).headCommit).toBeNull();
    const warnings = noHead.warnings as { code: string }[];
    expect(warnings.map((w) => w.code)).toContain('no_initial_commit');

    const dirtyProject = await registerProject(app, fixture.repos.dirty);
    const dirty = resultOf(await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', dirtyProject, planOf([NODE_CHECK])),
    ));
    expect((dirty.codeIdentity as Record<string, unknown>).hasUncommittedChanges).toBe(true);
    expect((dirty.warnings as { code: string }[]).map((w) => w.code)).toContain('working_tree_dirty');
  });

  /* ---------------------------------------------------------------- *
   * 验收 2：Core 核验（权限/绑定身份/cwd realpath 范围/环境引用）
   * ---------------------------------------------------------------- */

  it('缺 baseline.run 能力或目标项目不可见/未知 → forbidden；能力核验先于任何 I/O', async () => {
    const app = await openApp('authz');
    const projectId = await registerProject(app, fixture.repos.withHead);
    const noRun = createRestrictedPrincipal({
      capabilities: ['project.read', 'baseline.read'],
      projectScope: scopeAllowlist([projectId]),
    });
    const errorNoRun = await catchPublicError(() =>
      app.commandService.submit(OWNER === noRun ? OWNER : noRun, envelope('baseline.preview', projectId, planOf([NODE_CHECK]))),
    );
    expect(errorNoRun.code).toBe('forbidden');

    const outsider = createRestrictedPrincipal({
      capabilities: ['baseline.read', 'baseline.run'],
      projectScope: scopeAllowlist([randomUUID()]),
    });
    const errorInvisible = await catchPublicError(() =>
      app.commandService.submit(outsider, envelope('baseline.run', projectId, {
        decision: 'authorize',
        plan: { checks: [{ ...NODE_CHECK }] },
        previewDigest: '0'.repeat(64),
      })),
    );
    expect(errorInvisible.code).toBe('forbidden');
    const errorUnknown = await catchPublicError(() =>
      app.commandService.submit(OWNER, envelope('baseline.preview', randomUUID(), planOf([NODE_CHECK]))),
    );
    expect(errorUnknown.code).toBe('forbidden');
    // 拒绝后零副作用：无授权/操作/回执行。
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_authorizations')).toMatchObject([{ c: 0 }]);
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_operations')).toMatchObject([{ c: 0 }]);
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM command_receipts')).toMatchObject([{ c: 0 }]);
  });

  it('绑定身份核验：绑定路径仓库丢失/非 Git → 结构化拒绝，不猜绑定；零副作用', async () => {
    const app = await openApp('binding-identity');
    // 本用例使用其他用例不涉及的 cloneA 变体，避免破坏共享夹具。
    const projectId = await registerProject(app, fixture.repos.cloneA);
    const before = await app.onboardingService.inspectRepository(OWNER, fixture.repos.cloneA);
    expect(before.canonicalPath).toBe(realpathSync(fixture.repos.cloneA));
    // 仓库被删除后：仓库检查结构化拒绝（不猜绑定/不自动重建）。
    rmSync(fixture.repos.cloneA, { recursive: true, force: true });
    try {
      const error = await catchPublicError(() =>
        app.commandService.submit(OWNER, envelope('baseline.preview', projectId, planOf([NODE_CHECK]))),
      );
      expect(error.code).toBe('invalid_input');
      expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_authorizations')).toMatchObject([{ c: 0 }]);
      expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_operations')).toMatchObject([{ c: 0 }]);
    } finally {
      // 恢复为空目录仅供后续清理；该变体不再被其他用例使用。
      mkdirSync(fixture.repos.cloneA, { recursive: true });
    }
  });

  it('cwd 核验：穿越/绝对路径在校验层拒绝；符号链接逃逸与非-existent 子目录明确拒绝', async () => {
    const app = await openApp('cwd-checks');
    const projectId = await registerProject(app, fixture.repos.withHead);
    const traversal = await catchPublicError(() =>
      app.commandService.submit(OWNER, envelope('baseline.preview', projectId, planOf([
        { ...NODE_CHECK, cwdRef: '../outside' },
      ]))),
    );
    expect(traversal.code).toBe('invalid_input');
    expect(traversal.details?.reason).toBe('path_outside_repository');

    const absolute = await catchPublicError(() =>
      app.commandService.submit(OWNER, envelope('baseline.preview', projectId, planOf([
        { ...NODE_CHECK, cwdRef: '/etc' },
      ]))),
    );
    expect(absolute.code).toBe('invalid_input');

    // 符号链接逃逸：仓库内 symlink 指向根外目录。
    const outsideDir = join(fixture.root, 'outside-escape');
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(fixture.repos.withHead, 'escape-link'));
    try {
      const escape = await catchPublicError(() =>
        app.commandService.submit(OWNER, envelope('baseline.preview', projectId, planOf([
          { ...NODE_CHECK, cwdRef: 'escape-link' },
        ]))),
      );
      expect(escape.code).toBe('invalid_input');
      expect(escape.details?.reason).toBe('path_outside_repository');

      const missing = await catchPublicError(() =>
        app.commandService.submit(OWNER, envelope('baseline.preview', projectId, planOf([
          { ...NODE_CHECK, cwdRef: 'no-such-dir' },
        ]))),
      );
      expect(missing.code).toBe('invalid_input');
      expect(missing.details?.reason).toBe('invalid_check_plan');
    } finally {
      rmSync(join(fixture.repos.withHead, 'escape-link'));
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('环境引用核验：伪引用拒绝；获准引用解析为 PATH+允许变量名；环境值永不出现', async () => {
    const app = await openApp('env-refs');
    const projectId = await registerProject(app, fixture.repos.withHead);
    const unknownRef = await catchPublicError(() =>
      app.commandService.submit(OWNER, envelope('baseline.preview', projectId, planOf([
        { ...NODE_CHECK, environmentRef: 'not-approved' },
      ]))),
    );
    expect(unknownRef.code).toBe('invalid_input');
    // 计划携带环境值/秘密字段 → 校验层拒绝（不进入任何摘要或存档）。
    const envValue = await catchPublicError(() =>
      app.commandService.submit(OWNER, envelope('baseline.preview', projectId, {
        plan: { checks: [{ ...NODE_CHECK, env: { TOKEN: 'super-secret-value' } }] },
      })),
    );
    expect(envValue.code).toBe('invalid_input');
    const approved = await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', projectId, planOf([{ ...NODE_CHECK, environmentRef: 'ci-env' }])),
    );
    const checks = (resultOf(approved).checks as Record<string, unknown>[])[0];
    expect(checks.allowedVariables).toEqual(['PATH', 'CI', 'SHIPLOOP_TEST_FLAG']);
    expect(JSON.stringify(resultOf(approved))).not.toContain('super-secret-value');
  });

  it('客户端提权字段（actorId/principal/approved 声明）一律拒绝；不接受仓库文本授权', async () => {
    const app = await openApp('escalation');
    const projectId = await registerProject(app, fixture.repos.withHead);
    const actorId = await catchPublicError(() =>
      app.commandService.submit(OWNER, envelope('baseline.preview', projectId, {
        plan: { checks: [{ ...NODE_CHECK }] },
        actorId: 'root',
      })),
    );
    expect(actorId.code).toBe('invalid_input');
    expect(String(actorId.details?.field)).toContain('actorId');
    const selfApproved = await catchPublicError(() =>
      app.commandService.submit(OWNER, envelope('baseline.run', projectId, {
        decision: 'authorize',
        plan: { checks: [{ ...NODE_CHECK }] },
        previewDigest: '0'.repeat(64),
        approved: true,
      })),
    );
    expect(selfApproved.code).toBe('invalid_input');
  });

  it('预览零副作用：不执行脚本、不写事件/授权/操作/占用（恶意哨兵不存在）', async () => {
    const app = await openApp('preview-no-side-effects');
    const projectId = await registerProject(app, fixture.repos.malicious);
    await app.commandService.submit(OWNER, envelope('baseline.preview', projectId, planOf([NODE_CHECK])));
    expect(existsSync(fixture.repos.maliciousSentinelPath)).toBe(false);
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_authorizations')).toMatchObject([{ c: 0 }]);
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_operations')).toMatchObject([{ c: 0 }]);
    expect(readRows(app, "SELECT COUNT(*) AS c FROM state_events WHERE event_type LIKE 'baseline.%'")).toMatchObject([{ c: 0 }]);
    expect(readRows(app, "SELECT COUNT(*) AS c FROM baseline_occupancy WHERE holder_operation_id IS NOT NULL")).toMatchObject([{ c: 0 }]);
  });

  /* ---------------------------------------------------------------- *
   * 验收 3：明确授权（accepted 事务）与 preview_stale
   * ---------------------------------------------------------------- */

  it('authorize 提交事务：accepted 回执 + 不可变授权行 + accepted 操作 + 获准输入种子 + 占用 + authorized 事件', async () => {
    const app = await openApp('authorize-happy');
    const projectId = await registerProject(app, fixture.repos.withHead);
    const preview = resultOf(await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', projectId, planOf([NODE_CHECK, { ...NODE_CHECK, checkKey: 'second', required: false }])),
    ));
    const previewDigest = preview.previewDigest as string;

    const receipt = await app.commandService.submit(OWNER, envelope('baseline.run', projectId, {
      decision: 'authorize',
      plan: { checks: [NODE_CHECK, { ...NODE_CHECK, checkKey: 'second', required: false }] },
      previewDigest,
    }));
    expect(receipt.status).toBe('accepted');
    const operationId = (receipt as { operationId?: string }).operationId;
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);

    // 授权行：不可变获准输入（单一代码身份绑定全部检查）。
    const authRows = readRows(
      app,
      'SELECT id, project_id, repository_binding_id, head_commit, working_tree_digest, has_uncommitted_changes, policy_revision, plan_digest, plan_json, authorized_by FROM baseline_authorizations',
    ) as Record<string, unknown>[];
    expect(authRows).toHaveLength(1);
    expect(authRows[0].project_id).toBe(projectId);
    expect(authRows[0].head_commit).toBe(preview.headCommit ?? (preview.codeIdentity as Record<string, unknown>).headCommit);
    expect(authRows[0].working_tree_digest).toBe((preview.codeIdentity as Record<string, unknown>).workingTreeDigest);
    expect(authRows[0].policy_revision).toBe(authRows[0].plan_digest);
    expect(authRows[0].authorized_by).toBe(OWNER.principalId);
    // 操作行 accepted + 回执同事务持久化。
    const opRows = readRows(app, 'SELECT id, status, authorization_id, started_at FROM baseline_operations') as Record<string, unknown>[];
    expect(opRows).toHaveLength(1);
    expect(opRows[0].id).toBe(operationId);
    expect(opRows[0].status).toBe('accepted');
    expect(opRows[0].started_at).toBeNull();
    // 检查种子：获准输入快照、not_run、退出码 null、单一 authorization 归属。
    const seedRows = readRows(
      app,
      'SELECT check_key, argv_json, status, exit_code, started_at, ended_at FROM baseline_check_results WHERE operation_id = ?',
      operationId,
    ) as Record<string, unknown>[];
    expect(seedRows).toHaveLength(2);
    expect(seedRows.map((r) => r.check_key)).toEqual(['node-version', 'second']);
    for (const row of seedRows) {
      expect(JSON.parse(String(row.argv_json))).toEqual(['node', '--version']);
      expect(row.status).toBe('not_run');
      expect(row.exit_code).toBeNull();
      expect(row.started_at).toBeNull();
    }
    // 全局占用由该操作持有（启动次数为零：started_at 为 null）。
    expect(readRows(app, 'SELECT holder_operation_id FROM baseline_occupancy')).toMatchObject([
      { holder_operation_id: operationId },
    ]);
    // baseline.authorized 事件：受控脱敏键（无 argv/环境值）。
    const events = readRows(
      app,
      "SELECT event_type, payload FROM state_events WHERE event_type = 'baseline.authorized'",
    ) as Record<string, unknown>[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(String(events[0].payload)) as Record<string, unknown>;
    expect(payload.operationId).toBe(operationId);
    expect(payload.planDigest).toBe(authRows[0].plan_digest);
    expect(payload.checkCount).toBe(2);
    expect(JSON.stringify(payload)).not.toContain('node');
    // accepted 回执已持久化并可重放。
    const receiptRows = readRows(
      app,
      "SELECT status, operation_id, result_json FROM command_receipts WHERE status = 'accepted'",
    ) as Record<string, unknown>[];
    expect(receiptRows).toHaveLength(1);
    expect(receiptRows[0].operation_id).toBe(operationId);
    expect(receiptRows[0].result_json).toBeNull();
  });

  it('preview_stale：授权前代码身份变化（未跟踪文件/计划变化）→ conflict 持久 rejected 回执，不建授权/操作行', async () => {
    const app = await openApp('preview-stale');
    const projectId = await registerProject(app, fixture.repos.withHead);
    const preview = resultOf(await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', projectId, planOf([NODE_CHECK])),
    ));
    const commandId = randomUUID();
    const runEnvelope = envelope('baseline.run', projectId, {
      decision: 'authorize',
      plan: { checks: [{ ...NODE_CHECK }] },
      previewDigest: preview.previewDigest,
    }, { commandId });
    // 工作区在授权前变化 → 旧 previewDigest 失效。
    writeFileSync(join(fixture.repos.withHead, 'late-change.txt'), 'late\n', 'utf-8');
    const stale = await app.commandService.submit(OWNER, runEnvelope);
    expect(stale.status).toBe('rejected');
    expect(rejectedOf(stale).code).toBe('conflict');
    expect(rejectedOf(stale).details?.reason).toBe('preview_stale');
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_authorizations')).toMatchObject([{ c: 0 }]);
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_operations')).toMatchObject([{ c: 0 }]);
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_occupancy WHERE holder_operation_id IS NOT NULL')).toMatchObject([{ c: 0 }]);
    // 持久 rejected 回执可按 commandId 重放（同摘要）。
    const replayed = await app.commandService.submit(OWNER, { ...runEnvelope, issuedAt: NOW_ISO });
    expect(replayed.status).toBe('rejected');
    expect(replayed.replayed).toBe(true);
    // 计划变化（argv 改动）同样使旧摘要失效。
    writeFileSync(join(fixture.repos.withHead, 'fresh.txt'), 'fresh\n', 'utf-8');
    const freshPreview = resultOf(await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', projectId, planOf([NODE_CHECK])),
    ));
    const planChanged = await app.commandService.submit(OWNER, envelope('baseline.run', projectId, {
      decision: 'authorize',
      plan: { checks: [{ ...NODE_CHECK, argv: ['node', '-v'] }] },
      previewDigest: freshPreview.previewDigest,
    }));
    expect(planChanged.status).toBe('rejected');
    expect(rejectedOf(planChanged).details?.reason).toBe('preview_stale');
    rmSync(join(fixture.repos.withHead, 'late-change.txt'));
    rmSync(join(fixture.repos.withHead, 'fresh.txt'));
  });

  it('幂等：同 commandId 同摘要重放返回原 accepted 回执（不重复建行/不重复占用）；不同摘要 conflict', async () => {
    const app = await openApp('idempotency');
    const projectId = await registerProject(app, fixture.repos.withHead);
    const preview = resultOf(await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', projectId, planOf([NODE_CHECK])),
    ));
    const commandId = randomUUID();
    const runEnvelope = envelope('baseline.run', projectId, {
      decision: 'authorize',
      plan: { checks: [{ ...NODE_CHECK }] },
      previewDigest: preview.previewDigest,
    }, { commandId });
    const first = await app.commandService.submit(OWNER, runEnvelope);
    expect(first.status).toBe('accepted');
    const replay = await app.commandService.submit(OWNER, { ...runEnvelope, issuedAt: NOW_ISO });
    expect(replay.status).toBe('accepted');
    expect(replay.replayed).toBe(true);
    expect((replay as { operationId?: string }).operationId).toBe((first as { operationId: string }).operationId);
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_operations')).toMatchObject([{ c: 1 }]);
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_authorizations')).toMatchObject([{ c: 1 }]);

    const digestMismatch = await catchPublicError(() =>
      app.commandService.submit(OWNER, envelope('baseline.run', projectId, {
        decision: 'authorize',
        plan: { checks: [{ ...NODE_CHECK, argv: ['node', '-v'] }] },
        previewDigest: preview.previewDigest,
      }, { commandId })),
    );
    expect(digestMismatch.code).toBe('conflict');
    expect(digestMismatch.details?.reason).toBe('idempotency_key_reuse');
  });

  it('单并发占用：另一在途操作 → resource_busy baseline_in_progress，零持久副作用', async () => {
    const app = await openApp('occupancy');
    const projectId = await registerProject(app, fixture.repos.withHead);
    const preview = resultOf(await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', projectId, planOf([NODE_CHECK])),
    ));
    const first = await app.commandService.submit(OWNER, envelope('baseline.run', projectId, {
      decision: 'authorize',
      plan: { checks: [{ ...NODE_CHECK }] },
      previewDigest: preview.previewDigest,
    }));
    expect(first.status).toBe('accepted');
    const busy = await catchPublicError(() =>
      app.commandService.submit(OWNER, envelope('baseline.run', projectId, {
        decision: 'authorize',
        plan: { checks: [{ ...NODE_CHECK }] },
        previewDigest: preview.previewDigest,
      })),
    );
    expect(busy.code).toBe('resource_busy');
    expect(busy.details?.reason).toBe('baseline_in_progress');
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_operations')).toMatchObject([{ c: 1 }]);
  });

  /* ---------------------------------------------------------------- *
   * 验收 4：拒绝授权（decline）与明确契约（不自动执行/安装/不改写）
   * ---------------------------------------------------------------- */

  it('decline：持久 not_run 操作 + authorization_rejected 原因 + 启动次数为零；不占用、不种子、不发事件', async () => {
    const app = await openApp('decline');
    const projectId = await registerProject(app, fixture.repos.withHead);
    const preview = resultOf(await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', projectId, planOf([NODE_CHECK])),
    ));
    const receipt = await app.commandService.submit(OWNER, envelope('baseline.run', projectId, {
      decision: 'decline',
      plan: { checks: [{ ...NODE_CHECK }] },
      previewDigest: preview.previewDigest,
    }));
    expect(receipt.status).toBe('completed');
    const result = resultOf(receipt);
    expect(result.status).toBe('not_run');
    expect(result.reasonCode).toBe('authorization_rejected');
    const operationId = result.operationId as string;
    const opRows = readRows(app, 'SELECT status, reason_code, authorization_id, started_at, ended_at FROM baseline_operations WHERE id = ?', operationId) as Record<string, unknown>[];
    expect(opRows).toHaveLength(1);
    expect(opRows[0].status).toBe('not_run');
    expect(opRows[0].reason_code).toBe('authorization_rejected');
    expect(opRows[0].authorization_id).toBeNull();
    expect(opRows[0].started_at).toBeNull();
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_authorizations')).toMatchObject([{ c: 0 }]);
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_check_results')).toMatchObject([{ c: 0 }]);
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_occupancy WHERE holder_operation_id IS NOT NULL')).toMatchObject([{ c: 0 }]);
    expect(readRows(app, "SELECT COUNT(*) AS c FROM state_events WHERE event_type LIKE 'baseline.%'")).toMatchObject([{ c: 0 }]);
    // decline 同样受 stale 约束（绑定完整输入摘要）。
    writeFileSync(join(fixture.repos.withHead, 'decline-late.txt'), 'x\n', 'utf-8');
    const staleDecline = await app.commandService.submit(OWNER, envelope('baseline.run', projectId, {
      decision: 'decline',
      plan: { checks: [{ ...NODE_CHECK }] },
      previewDigest: preview.previewDigest,
    }));
    expect(staleDecline.status).toBe('rejected');
    expect(rejectedOf(staleDecline).details?.reason).toBe('preview_stale');
    rmSync(join(fixture.repos.withHead, 'decline-late.txt'));
  });

  it('decline 不受单并发占用影响（未启动任何检查），可重复明确拒绝', async () => {
    const app = await openApp('decline-occupancy');
    const projectId = await registerProject(app, fixture.repos.withHead);
    const preview = resultOf(await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', projectId, planOf([NODE_CHECK])),
    ));
    const runPayload = {
      decision: 'decline',
      plan: { checks: [{ ...NODE_CHECK }] },
      previewDigest: preview.previewDigest,
    };
    const first = await app.commandService.submit(OWNER, envelope('baseline.run', projectId, runPayload));
    expect(first.status).toBe('completed');
    const second = await app.commandService.submit(OWNER, envelope('baseline.run', projectId, runPayload));
    expect(second.status).toBe('completed');
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM baseline_operations')).toMatchObject([{ c: 2 }]);
  });

  it('未知脚本/缺命令：预览按明确契约警示（不改写 argv、不自动执行/安装）；baseline.cancel 未接线 unsupported', async () => {
    const app = await openApp('unknown-script');
    const projectId = await registerProject(app, fixture.repos.withHead);
    const result = resultOf(await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', projectId, planOf([
        { ...NODE_CHECK, argv: ['./scripts/no-such-tool.js'], cwdRef: undefined },
        { ...NODE_CHECK, checkKey: 'shell-ish', argv: ['echo', 'a && b'] },
      ])),
    ));
    const warnings = result.warnings as { code: string; checkKey?: string }[];
    expect(warnings.map((w) => w.code)).toContain('argv0_relative_script_missing');
    expect(warnings.map((w) => w.code)).toContain('shell_metacharacters_in_argument');
    const checks = result.checks as Record<string, unknown>[];
    // argv 原样保留（不偷偷改为另一条命令）。
    expect(checks[0].argv).toEqual(['./scripts/no-such-tool.js']);
    expect(checks[1].argv).toEqual(['echo', 'a && b']);
    expect(existsSync(fixture.repos.maliciousSentinelPath)).toBe(false);

    const cancel = await catchPublicError(() =>
      app.commandService.submit(OWNER, envelope('baseline.cancel', projectId, { operationId: randomUUID() })),
    );
    expect(cancel.code).toBe('unsupported');
  });

  it('预览结果超出回执有界上限 → invalid_input（不崩溃、不截断冒充）', async () => {
    const app = await openApp('oversized');
    const projectId = await registerProject(app, fixture.repos.withHead);
    const bigArgv = ['node', '-e', 'x'.repeat(40_000)];
    const error = await catchPublicError(() =>
      app.commandService.submit(OWNER, envelope('baseline.preview', projectId, planOf([
        { ...NODE_CHECK, argv: bigArgv },
        ...Array.from({ length: 20 }, (_, i) => ({
          ...NODE_CHECK,
          checkKey: `filler-${i}`,
          argv: ['node', '-e', 'y'.repeat(3_000)],
        })),
      ]))),
    );
    expect(error.code).toBe('invalid_input');
    expect(error.details?.reason).toBe('invalid_check_plan');
  });

  it('预览经命令服务返回 completed 回执并持久化（可按 commandId 重放）', async () => {
    const app = await openApp('preview-receipt');
    const projectId = await registerProject(app, fixture.repos.withHead);
    const commandId = randomUUID();
    const first = await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', projectId, planOf([NODE_CHECK]), { commandId }),
    );
    expect(first.status).toBe('completed');
    const replay = await app.commandService.submit(
      OWNER,
      envelope('baseline.preview', projectId, planOf([NODE_CHECK]), { commandId }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe('completed');
    expect(readRows(app, 'SELECT COUNT(*) AS c FROM command_receipts')).toMatchObject([{ c: 1 }]);
  });
});
