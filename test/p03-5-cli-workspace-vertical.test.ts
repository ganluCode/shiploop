/**
 * P03-5 / F-012 工作区状态展示与人工丢弃预览/确认 CLI 纵向（真实临时 Host +
 * 真实 SQLite + 真实 Git worktree；经 `runAppCli`，与 dist/bin.js 同一执行路径；
 * 命令只经过 Host）。
 *
 * 验收面（.dag_context.json F-012）：
 * - 沿用既有 HostClient 与 CLI 模式：状态读取（list/get/operations/operation）
 *   区分保留/已清理与操作终态，保留关联身份/原因/证据引用，不显示为 Feature 交付；
 * - 准备 → 预览 → 确认链路：discard-preview 的 completed 回执携带预览；
 *   discard --preview-file --confirm 真实删除 worktree，分支/源仓库保留；
 *   命令 completed 不等于丢弃成功，实际结果经 operation 查询核对；
 * - 本地拒绝：缺 --confirm / 篡改预览 / Feature 不一致在连接前退出 2（零副作用）；
 *   伪造摘要/过期预览经服务端拒绝（conflict，退出码 1）；非法 ID 退出 2；
 *   跨项目/不存在折叠 not_found（退出码 1）；Host 不可达退出 3；
 * - 响应丢失纪律：显式 --command-id 重放返回原回执（replayed=true），零二次副作用；
 *   重复只读查询零副作用（持久表逐字节一致）；
 * - CLI/HostClient 不打开 SQLite、不读写代码工作目录、不直接调用 Git（副作用
 *   只经 Host 命令面发生）。
 *
 * 正式构建 CLI 入口验收见 `p03-5-cli-workspace-built.test.ts`。
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  runAppCli,
  type AppCliIo,
  type AppCliRunResult,
} from '../packages/cli/src/app-execute.ts';
import type { RunningHost } from '../packages/host/src/runtime/index.ts';
import { openClaimFixture } from './helpers/p03-4/task-claim-fixture.ts';
import { createLocalOwnerPrincipal } from './helpers/p02-2/principals.ts';
import { git } from './helpers/git-repo.ts';
import { openCoreApplication } from 'shiploop-core/assembly';
import { computeWorkspaceDiscardPreviewDigest } from '../packages/core/src/ports/workspace-discard.ts';
import type { WorkspaceDiscardPreview } from '../packages/core/src/ports/workspace-discard.ts';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const OWNER = createLocalOwnerPrincipal();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER_HOOKS = fileURLToPath(
  new URL('./helpers/node-ts-loader/register.mjs', import.meta.url),
);
const CATALOG_HOST_ENTRY = fileURLToPath(
  new URL('./helpers/host/detached-host-entry-catalog.ts', import.meta.url),
);
const STUB_ENTRY = fileURLToPath(new URL('./helpers/host/stub-entry.ts', import.meta.url));

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
});

function tsEntryArgv(): string[] {
  return ['--import', REGISTER_HOOKS, CATALOG_HOST_ENTRY];
}

/* ------------------------------------------------------------------ *
 * 夹具：认领 + 准备（真实 worktree）+ 保留，随后由 CLI 启动/复用 Host
 * ------------------------------------------------------------------ */

type ClaimFixture = Awaited<ReturnType<typeof openClaimFixture>>;

interface WiredWorkspace {
  readonly fixture: ClaimFixture;
  readonly dataRoot: string;
  readonly projectId: string;
  readonly featureId: string;
  readonly worktreePath: string;
  readonly workspaceId: string;
  readonly preparationOperationId: string;
  readonly tablesBefore: Record<string, unknown[]>;
}

let activeFixture: ClaimFixture | undefined;
let activeHost: RunningHost | undefined;

afterEach(async () => {
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
});

async function seedRetainedWorkspace(): Promise<WiredWorkspace> {
  const fixture = await openClaimFixture([[], ['t-1']]);
  activeFixture = fixture;
  const app = await openCoreApplication({
    dataRoot: fixture.box.box.dataRoot,
    capabilityCatalog: fixture.box.box.capabilityCatalog,
  });
  try {
    const projectId = fixture.box.projectId;
    const featureId = fixture.box.featureId;
    const runId = fixture.ids.runId;
    const taskId = fixture.ids.taskId;
    const binding = await app.stateStore.getRepositoryBinding(projectId);
    const token = await app.workWorkspaceAuthority.verifyPreparation(binding, featureId);
    const claim = app.taskClaims.claimTask({ ...fixture.input(), workspace: token }).receipt;
    const identity = {
      projectId,
      attemptId: claim.attempt.id,
      owner: claim.attempt.owner,
      hostInstanceId: claim.attempt.hostInstanceId,
      executionVersion: claim.attempt.executionVersion,
    };
    const preparation = await app.workspacePreparation.prepare({
      identity,
      taskId,
      runId,
      claimKey: claim.claimKey,
      operationId: randomUUID(),
      workspaceId: randomUUID(),
    });
    expect(preparation.operation.status).toBe('succeeded');
    expect(preparation.workspace.status).toBe('ready');
    const detail = await app.queryService.getWorkspace(OWNER, { projectId, featureId });
    const retained = await app.workspaceRetention.retain({
      identity,
      runId,
      taskId,
      workspaceId: preparation.workspace.id,
      operationId: randomUUID(),
      expectedWorkspaceRevision: detail.workspace.revision,
      reason: 'interrupted',
      evidenceRefs: preparation.operation.result!.evidenceRefs,
    });
    expect(retained.operation.status).toBe('succeeded');
    expect(retained.workspace.status).toBe('retained');
    const tablesBefore = fixture.snapshot();
    return {
      fixture,
      dataRoot: fixture.box.box.dataRoot,
      projectId,
      featureId,
      worktreePath: preparation.workspace.canonicalPath,
      workspaceId: preparation.workspace.id,
      preparationOperationId: preparation.operation.id,
      tablesBefore,
    };
  } finally {
    app.close();
  }
}

/* ------------------------------------------------------------------ *
 * runAppCli 驱动（与 p03-4 纵向同一纪律）
 * ------------------------------------------------------------------ */

function collectIo(): { io: AppCliIo; stdout: () => string; stderr: () => string } {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

interface AppInvocation {
  readonly result: AppCliRunResult;
  readonly stdout: string;
  readonly stderr: string;
}

async function runApp(dataRoot: string, args: readonly string[]): Promise<AppInvocation> {
  const collected = collectIo();
  const result = await runAppCli({
    args: [...args, '--data-root', dataRoot],
    io: collected.io,
    env: {},
    launch: { entryArgv: tsEntryArgv(), pollIntervalMs: 50 },
  });
  return { result, stdout: collected.stdout(), stderr: collected.stderr() };
}

interface EnvelopeShape {
  ok: boolean;
  command: string | null;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    commandId?: string;
    details?: Record<string, unknown>;
  };
}

function parseEnvelope(invocation: AppInvocation): EnvelopeShape {
  expect(invocation.stdout.trim().split('\n'), 'stdout 只能包含一个 JSON 对象').toHaveLength(1);
  return JSON.parse(invocation.stdout) as EnvelopeShape;
}

function successResult(invocation: AppInvocation, command: string): Record<string, unknown> {
  expect(invocation.result.exitCode, `${invocation.stdout}\n${invocation.stderr}`).toBe(0);
  const envelope = parseEnvelope(invocation);
  expect(envelope.ok, invocation.stderr).toBe(true);
  expect(envelope.command).toBe(command);
  return envelope.result as Record<string, unknown>;
}

function failureOf(
  invocation: AppInvocation,
  exitCode: number,
  code: string,
): NonNullable<EnvelopeShape['error']> {
  expect(invocation.result.exitCode, `${invocation.stdout}\n${invocation.stderr}`).toBe(exitCode);
  const envelope = parseEnvelope(invocation);
  expect(envelope.ok).toBe(false);
  const error = envelope.error as NonNullable<EnvelopeShape['error']>;
  expect(error?.code).toBe(code);
  return error;
}

/** 经 CLI 取得真实预览文档（preview 段逐字节即合法 --preview-file）。 */
async function fetchPreviewDocument(s: WiredWorkspace): Promise<WorkspaceDiscardPreview> {
  const invocation = await runApp(s.dataRoot, [
    'workspace', 'discard-preview', s.featureId, '--project', s.projectId, '--json',
  ]);
  const result = successResult(invocation, 'workspace.discard-preview');
  const preview = result.preview as Record<string, unknown>;
  expect(preview.previewDigest).toMatch(/^[0-9a-f]{64}$/);
  return preview as unknown as WorkspaceDiscardPreview;
}

/* ------------------------------------------------------------------ *
 * A. 状态读取：保留现场结构化展示
 * ------------------------------------------------------------------ */

describe('F-012 工作区状态读取（真实 Host + 保留现场）', () => {
  it('workspace get/list/operations/operation：保留状态、关联身份与证据引用如实展示', async () => {
    const s = await seedRetainedWorkspace();
    const get = await runApp(s.dataRoot, [
      'workspace', 'get', s.featureId, '--project', s.projectId, '--json',
    ]);
    const detail = successResult(get, 'workspace.get');
    expect(detail.operation).toBe('workspaces.get');
    expect(detail.state).toBe('retained');
    const workspace = detail.workspace as Record<string, unknown>;
    expect(workspace).toMatchObject({
      id: s.workspaceId,
      featureId: s.featureId,
      status: 'retained',
    });
    // 公开投影不含绝对路径与内部身份哈希。
    expect(JSON.stringify(detail)).not.toContain(s.worktreePath);
    expect(JSON.stringify(detail)).not.toContain('canonicalPath');
    expect(JSON.stringify(detail)).not.toContain('repoIdentity');
    const completion = detail.completion as Record<string, unknown>;
    expect(completion).toMatchObject({ featureVerified: false, delivered: false });
    const preparation = detail.preparationOperation as Record<string, unknown>;
    expect(preparation).toMatchObject({
      id: s.preparationOperationId,
      kind: 'prepare',
      status: 'succeeded',
    });

    const list = await runApp(s.dataRoot, [
      'workspace', 'list', '--project', s.projectId, '--feature', s.featureId, '--json',
    ]);
    const listed = successResult(list, 'workspace.list');
    const records = listed.records as readonly Record<string, unknown>[];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      state: 'retained',
      record: { id: s.workspaceId, status: 'retained' },
    });

    const operations = await runApp(s.dataRoot, [
      'workspace', 'operations', '--project', s.projectId, '--feature', s.featureId, '--json',
    ]);
    const ops = successResult(operations, 'workspace.operations');
    const opRecords = ops.records as readonly Record<string, unknown>[];
    expect(
      opRecords.map((entry) => (entry.record as Record<string, unknown>).kind).sort(),
    ).toEqual(['prepare', 'retain']);
    const retain = opRecords.find(
      (entry) => (entry.record as Record<string, unknown>).kind === 'retain',
    ) as Record<string, unknown>;
    const retainRecord = retain.record as Record<string, unknown>;
    const receipt = retainRecord.receipt as Record<string, unknown>;
    expect(receipt.status).toBe('completed');
    const opResult = retainRecord.result as Record<string, unknown>;
    expect((opResult.evidenceRefs as readonly string[]).length).toBeGreaterThan(0);

    const single = await runApp(s.dataRoot, [
      'workspace', 'operation', s.preparationOperationId, '--project', s.projectId, '--json',
    ]);
    const one = successResult(single, 'workspace.operation');
    expect((one.record as Record<string, unknown>).id).toBe(s.preparationOperationId);
    expect(one.completion).toMatchObject({ featureVerified: false, delivered: false });
  }, 120_000);

  it('重复只读查询零副作用（持久表逐字节一致）', async () => {
    const s = await seedRetainedWorkspace();
    await runApp(s.dataRoot, ['workspace', 'get', s.featureId, '--project', s.projectId, '--json']);
    await runApp(s.dataRoot, ['workspace', 'list', '--project', s.projectId, '--json']);
    await runApp(s.dataRoot, ['workspace', 'operations', '--project', s.projectId, '--json']);
    expect(s.fixture.snapshot()).toEqual(s.tablesBefore);
  }, 120_000);

  it('人类输出区分保留状态并声明不交付', async () => {
    const s = await seedRetainedWorkspace();
    const invocation = await runApp(s.dataRoot, [
      'workspace', 'get', s.featureId, '--project', s.projectId,
    ]);
    expect(invocation.result.exitCode).toBe(0);
    expect(invocation.stdout).toContain('state=retained');
    expect(invocation.stdout).toContain('不代表 Feature 交付');
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * B. 准备 → 预览 → 确认链路（真实删除）
 * ------------------------------------------------------------------ */

describe('F-012 人工丢弃预览/确认链路', () => {
  it('discard-preview 携带预览；discard --preview-file --confirm 真实删除，分支/审计保留', async () => {
    const s = await seedRetainedWorkspace();
    const sourceRefs = git(['show-ref'], s.fixture.box.box.repoDirA);

    const previewInvocation = await runApp(s.dataRoot, [
      'workspace', 'discard-preview', s.featureId, '--project', s.projectId, '--json',
    ]);
    const previewResult = successResult(previewInvocation, 'workspace.discard-preview');
    const preview = previewResult.preview as Record<string, unknown>;
    expect(preview).toMatchObject({
      featureId: s.featureId,
      workspaceId: s.workspaceId,
      scope: 'worktree_only',
      status: 'retained',
    });
    expect(preview.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.evidenceRef).toBeTypeOf('string');
    expect(previewResult.state).toBe('retained');
    expect(String(previewResult.notice)).toContain('预览不是删除');
    expect(existsSync(s.worktreePath)).toBe(true);

    const sandbox = createTempSandbox('shiploop-f012-vertical-', { outside: [repoRoot] });
    try {
      const previewFile = join(sandbox.path, 'preview.json');
      writeFileSync(previewFile, JSON.stringify(preview), 'utf8');
      const confirmInvocation = await runApp(s.dataRoot, [
        'workspace', 'discard', s.featureId, '--project', s.projectId,
        '--preview-file', previewFile, '--confirm', '--json',
      ]);
      const confirmed = successResult(confirmInvocation, 'workspace.discard');
      const submitResult = confirmed.result as Record<string, unknown>;
      expect(submitResult.workspaceId).toBe(s.workspaceId);
      expect(String(confirmed.notice)).toContain('completed 不等于丢弃成功');
      const operationId = submitResult.workspaceOperationId as string;

      // 实际结果经 operation 查询核对：删除确证、目录消失、分支/源仓库保留。
      expect(existsSync(s.worktreePath)).toBe(false);
      expect(git(['show-ref'], s.fixture.box.box.repoDirA)).toBe(sourceRefs);
      const operation = await runApp(s.dataRoot, [
        'workspace', 'operation', operationId, '--project', s.projectId, '--json',
      ]);
      const operationResult = successResult(operation, 'workspace.operation');
      expect(operationResult.record).toMatchObject({
        id: operationId,
        kind: 'discard',
        status: 'succeeded',
      });
      const after = await runApp(s.dataRoot, [
        'workspace', 'get', s.featureId, '--project', s.projectId, '--json',
      ]);
      expect(successResult(after, 'workspace.get').state).toBe('cleaned');
    } finally {
      sandbox.cleanup();
    }
  }, 180_000);

  it('显式 --command-id 重放返回原回执（replayed=true），零二次副作用', async () => {
    const s = await seedRetainedWorkspace();
    const commandId = randomUUID();
    const first = await runApp(s.dataRoot, [
      'workspace', 'discard-preview', s.featureId, '--project', s.projectId,
      '--command-id', commandId, '--json',
    ]);
    const firstResult = successResult(first, 'workspace.discard-preview');
    expect(firstResult.replayed).toBe(false);
    const second = await runApp(s.dataRoot, [
      'workspace', 'discard-preview', s.featureId, '--project', s.projectId,
      '--command-id', commandId, '--json',
    ]);
    const secondResult = successResult(second, 'workspace.discard-preview');
    expect(secondResult.replayed).toBe(true);
    expect(secondResult.commandId).toBe(commandId);
    expect(secondResult.preview).toEqual(firstResult.preview);
  }, 180_000);
});

/* ------------------------------------------------------------------ *
 * C. 本地拒绝与服务端拒绝
 * ------------------------------------------------------------------ */

describe('F-012 拒绝路径', () => {
  it('缺 --confirm / 缺 --preview-file 在连接前退出 2（零副作用）', async () => {
    const s = await seedRetainedWorkspace();
    const noConfirm = await runApp(s.dataRoot, [
      'workspace', 'discard', s.featureId, '--project', s.projectId,
      '--preview-file', '/tmp/x.json', '--json',
    ]);
    failureOf(noConfirm, 2, 'invalid_input');
    const noFile = await runApp(s.dataRoot, [
      'workspace', 'discard', s.featureId, '--project', s.projectId, '--confirm', '--json',
    ]);
    failureOf(noFile, 2, 'invalid_input');
    expect(s.fixture.snapshot()).toEqual(s.tablesBefore);
    expect(existsSync(s.worktreePath)).toBe(true);
  }, 120_000);

  it('篡改预览形状与 Feature 不一致在本地退出 2（零副作用）', async () => {
    const s = await seedRetainedWorkspace();
    const document = await fetchPreviewDocument(s);
    const sandbox = createTempSandbox('shiploop-f012-reject-', { outside: [repoRoot] });
    try {
      const tampered = join(sandbox.path, 'tampered.json');
      writeFileSync(
        tampered,
        JSON.stringify({ ...document, previewDigest: 'not-hex' }),
        'utf8',
      );
      const bad = await runApp(s.dataRoot, [
        'workspace', 'discard', s.featureId, '--project', s.projectId,
        '--preview-file', tampered, '--confirm', '--json',
      ]);
      const error = failureOf(bad, 2, 'invalid_input');
      expect(error.details?.reason).toBe('invalid_preview_file');

      const mismatch = join(sandbox.path, 'mismatch.json');
      writeFileSync(
        mismatch,
        JSON.stringify({ ...document, featureId: 'feature-b' }),
        'utf8',
      );
      const mismatchInvocation = await runApp(s.dataRoot, [
        'workspace', 'discard', s.featureId, '--project', s.projectId,
        '--preview-file', mismatch, '--confirm', '--json',
      ]);
      const mismatchError = failureOf(mismatchInvocation, 2, 'invalid_input');
      expect(mismatchError.details?.reason).toBe('preview_feature_mismatch');
      expect(s.fixture.snapshot()).toEqual(s.tablesBefore);
      expect(existsSync(s.worktreePath)).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  }, 180_000);

  it('伪造摘要与过期预览经服务端 conflict 拒绝（退出码 1，零删除）', async () => {
    const s = await seedRetainedWorkspace();
    const document = await fetchPreviewDocument(s);
    const sandbox = createTempSandbox('shiploop-f012-forge-', { outside: [repoRoot] });
    try {
      // 伪造摘要：合法形态但与服务端重算不符。
      const forged = join(sandbox.path, 'forged.json');
      writeFileSync(
        forged,
        JSON.stringify({ ...document, previewDigest: 'f'.repeat(64) }),
        'utf8',
      );
      const forgedInvocation = await runApp(s.dataRoot, [
        'workspace', 'discard', s.featureId, '--project', s.projectId,
        '--preview-file', forged, '--confirm', '--json',
      ]);
      failureOf(forgedInvocation, 1, 'conflict');

      // 过期预览：expiresAtUtcMs 改为过去并以同一权威重算 previewDigest。
      const expiredAt = 1_000_000;
      const expiredDocument = {
        ...document,
        expiresAtUtcMs: expiredAt,
        previewDigest: computeWorkspaceDiscardPreviewDigest({
          projectId: s.projectId,
          featureId: s.featureId,
          workspaceId: document.workspaceId,
          branch: document.branch,
          workspaceRevision: document.workspaceRevision,
          headCommit: document.headCommit,
          codeDigest: document.codeDigest,
          ignoredDigest: document.ignoredDigest,
          expiresAtUtcMs: expiredAt,
        }),
      };
      const expired = join(sandbox.path, 'expired.json');
      writeFileSync(expired, JSON.stringify(expiredDocument), 'utf8');
      const expiredInvocation = await runApp(s.dataRoot, [
        'workspace', 'discard', s.featureId, '--project', s.projectId,
        '--preview-file', expired, '--confirm', '--json',
      ]);
      failureOf(expiredInvocation, 1, 'conflict');

      expect(existsSync(s.worktreePath)).toBe(true);
      const after = await runApp(s.dataRoot, [
        'workspace', 'get', s.featureId, '--project', s.projectId, '--json',
      ]);
      expect(successResult(after, 'workspace.get').state).toBe('retained');
    } finally {
      sandbox.cleanup();
    }
  }, 180_000);

  it('非法 ID 退出 2；不存在 Feature/operation 折叠 not_found 退出 1；非法/跨域游标拒绝', async () => {
    const s = await seedRetainedWorkspace();
    const badProject = await runApp(s.dataRoot, [
      'workspace', 'list', '--project', 'not-a-uuid', '--json',
    ]);
    failureOf(badProject, 2, 'invalid_input');
    const badOperation = await runApp(s.dataRoot, [
      'workspace', 'operation', 'not-a-uuid', '--project', s.projectId, '--json',
    ]);
    failureOf(badOperation, 2, 'invalid_input');
    const missing = await runApp(s.dataRoot, [
      'workspace', 'get', 'feature-missing', '--project', s.projectId, '--json',
    ]);
    failureOf(missing, 1, 'not_found');
    const missingOperation = await runApp(s.dataRoot, [
      'workspace', 'operation', randomUUID(), '--project', s.projectId, '--json',
    ]);
    failureOf(missingOperation, 1, 'not_found');
    const badCursor = await runApp(s.dataRoot, [
      'workspace', 'list', '--project', s.projectId, '--cursor', 'bogus-cursor', '--json',
    ]);
    failureOf(badCursor, 2, 'invalid_input');
    // 服务端解码失败：invalid_input（400）→ 退出码 2（输入错误）。
    const foreignCursor = await runApp(s.dataRoot, [
      'workspace', 'operations', '--project', s.projectId, '--cursor', 'wscur_v1_bogus', '--json',
    ]);
    failureOf(foreignCursor, 2, 'invalid_input');
  }, 180_000);

  it('Host 不可达（启动候选驻留不就绪 → start_timeout）为退出码 3', async () => {
    const sandbox = createTempSandbox('shiploop-f012-unreachable-', { outside: [repoRoot] });
    try {
      const dataRoot = join(sandbox.path, 'data-root');
      mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
      const collected = collectIo();
      const result = await runAppCli({
        args: [
          'workspace', 'list', '--project', randomUUID(),
          '--data-root', dataRoot, '--start-timeout-ms', '1000', '--json',
        ],
        io: collected.io,
        env: {},
        launch: {
          entryArgv: ['--import', REGISTER_HOOKS, STUB_ENTRY, 'linger'],
          pollIntervalMs: 50,
        },
      });
      expect(result.exitCode, collected.stderr()).toBe(3);
      const envelope = JSON.parse(collected.stdout()) as EnvelopeShape;
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe('start_timeout');
    } finally {
      sandbox.cleanup();
    }
  }, 60_000);
});
