/**
 * P03-5 / F-012 工作区 CLI 正式构建入口验收（`npm run build` 产物
 * `packages/cli/dist/bin.js`，与生产同一入口 + 真实临时 Host + 真实保留工作区）。
 *
 * 验收面（.dag_context.json F-012 第 5 条）：
 * - 从正式构建 CLI 与临时 Host 验证状态读取（workspace get/list/operations）；
 * - 至少一次准备/预览/拒绝确认链路：准备+保留（夹具）→ discard-preview 预览 →
 *   缺 --confirm 本地拒绝（退出码 2，零副作用）→ 伪造摘要经服务端 conflict
 *   拒绝（退出码 1，零删除）；
 * - 帮助说明可信项目非强 OS 隔离、失败默认保留与本阶段尚无完整 Runtime/提交闭环。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME（沙箱 HOME/数据根）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHost } from '../packages/host/src/index.ts';
import type { RunningHost } from '../packages/host/src/runtime/index.ts';
import { openClaimFixture } from './helpers/p03-4/task-claim-fixture.ts';
import { createLocalOwnerPrincipal } from './helpers/p02-2/principals.ts';
import { openCoreApplication } from 'shiploop-core/assembly';
import { createTempSandbox } from './helpers/temp-sandbox.ts';

const OWNER = createLocalOwnerPrincipal();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_BIN = resolve(repoRoot, 'packages/cli/dist/bin.js');

type ClaimFixture = Awaited<ReturnType<typeof openClaimFixture>>;

let fixture: ClaimFixture | undefined;
let host: RunningHost | undefined;
let workspaceId: string | undefined;
let worktreePath: string | undefined;

/** 干净树下先构建真实 dist（CLI bin + Host dist/start.js 启动入口）。 */
beforeAll(async () => {
  execFileSync('npm', ['run', 'build'], {
    cwd: repoRoot,
    timeout: 540_000,
    stdio: 'pipe',
    env: { ...process.env },
  });
  expect(existsSync(CLI_BIN)).toBe(true);

  fixture = await openClaimFixture([[], ['t-1']]);
  const app = await openCoreApplication({
    dataRoot: fixture.box.box.dataRoot,
    capabilityCatalog: fixture.box.box.capabilityCatalog,
  });
  try {
    const projectId = fixture.box.projectId;
    const featureId = fixture.box.featureId;
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
      taskId: fixture.ids.taskId,
      runId: fixture.ids.runId,
      claimKey: claim.claimKey,
      operationId: randomUUID(),
      workspaceId: randomUUID(),
    });
    expect(preparation.operation.status).toBe('succeeded');
    const detail = await app.queryService.getWorkspace(OWNER, { projectId, featureId });
    const retained = await app.workspaceRetention.retain({
      identity,
      runId: fixture.ids.runId,
      taskId: fixture.ids.taskId,
      workspaceId: preparation.workspace.id,
      operationId: randomUUID(),
      expectedWorkspaceRevision: detail.workspace.revision,
      reason: 'interrupted',
      evidenceRefs: preparation.operation.result!.evidenceRefs,
    });
    expect(retained.workspace.status).toBe('retained');
    workspaceId = preparation.workspace.id;
    worktreePath = preparation.workspace.canonicalPath;
  } finally {
    app.close();
  }
  host = await startHost({
    dataRoot: fixture.box.box.dataRoot,
    capabilityCatalog: fixture.box.box.capabilityCatalog,
    env: {},
  });
}, 570_000);

afterAll(async () => {
  const running = host;
  host = undefined;
  if (running !== undefined) {
    await running.close();
  }
  const box = fixture;
  fixture = undefined;
  workspaceId = undefined;
  worktreePath = undefined;
  if (box !== undefined) {
    box.box.close();
  }
});

interface CliOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 经正式构建入口执行 CLI（沙箱 HOME/TMPDIR；异步 spawn 不阻塞 Host 事件循环）。 */
function runBuiltCli(args: readonly string[], timeoutMs = 150_000): Promise<CliOutcome> {
  const box = fixture;
  if (box === undefined) {
    throw new Error('fixture 未就绪');
  }
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: box.box.box.homeDir,
    TMPDIR: box.box.box.root,
  };
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(
      process.execPath,
      [CLI_BIN, ...args, '--data-root', box.box.box.dataRoot],
      { cwd: box.box.box.root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error('built CLI timeout');
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      failure = error;
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (failure !== undefined) {
        rejectSpawn(failure);
        return;
      }
      resolveSpawn({ status, stdout, stderr });
    });
  });
}

interface EnvelopeShape {
  ok: boolean;
  command: string | null;
  result?: Record<string, unknown>;
  error?: { code: string; details?: Record<string, unknown> };
}

function okResult(outcome: CliOutcome, command: string): Record<string, unknown> {
  expect(outcome.status, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
  const envelope = JSON.parse(outcome.stdout) as EnvelopeShape;
  expect(envelope.ok).toBe(true);
  expect(envelope.command).toBe(command);
  return envelope.result as Record<string, unknown>;
}

function failedEnvelope(outcome: CliOutcome, exitCode: number, code: string): EnvelopeShape['error'] {
  expect(outcome.status, `${outcome.stdout}\n${outcome.stderr}`).toBe(exitCode);
  const envelope = JSON.parse(outcome.stdout) as EnvelopeShape;
  expect(envelope.ok).toBe(false);
  expect(envelope.error?.code).toBe(code);
  return envelope.error;
}

describe('F-012 工作区 CLI 正式构建入口（dist/bin.js + 临时 Host）', () => {
  it('帮助说明可信项目非强 OS 隔离、失败默认保留与本阶段闭环缺口', async () => {
    const outcome = await runBuiltCli(['workspace', '--help']);
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain('强 OS 隔离');
    expect(outcome.stdout).toContain('失败默认保留');
    expect(outcome.stdout).toContain('尚无完整 Runtime/提交闭环');
    const discard = await runBuiltCli(['workspace', 'discard', '--help']);
    expect(discard.status).toBe(0);
    expect(discard.stdout).toContain('completed 不等于丢弃成功');
  });

  it('状态读取：get/list/operations 结构化输出保留状态，不显示为交付', async () => {
    const box = fixture;
    if (box === undefined || workspaceId === undefined) {
      throw new Error('fixture 未就绪');
    }
    const get = okResult(
      await runBuiltCli(['workspace', 'get', box.box.featureId, '--project', box.box.projectId, '--json']),
      'workspace.get',
    );
    expect(get.state).toBe('retained');
    expect(get.workspace).toMatchObject({ id: workspaceId, status: 'retained' });
    expect(get.completion).toMatchObject({ featureVerified: false, delivered: false });
    expect(JSON.stringify(get)).not.toContain(worktreePath as string);

    const list = okResult(
      await runBuiltCli(['workspace', 'list', '--project', box.box.projectId, '--json']),
      'workspace.list',
    );
    expect((list.records as readonly unknown[]).length).toBe(1);

    const operations = okResult(
      await runBuiltCli([
        'workspace', 'operations', '--project', box.box.projectId,
        '--feature', box.box.featureId, '--json',
      ]),
      'workspace.operations',
    );
    const kinds = (operations.records as readonly Record<string, unknown>[])
      .map((entry) => (entry.record as Record<string, unknown>).kind)
      .sort();
    expect(kinds).toEqual(['prepare', 'retain']);
  });

  it('准备/预览/拒绝确认链路：预览可读；缺确认本地拒绝；伪造摘要服务端拒绝（零删除）', async () => {
    const box = fixture;
    if (box === undefined || worktreePath === undefined) {
      throw new Error('fixture 未就绪');
    }
    // 预览（准备+保留由夹具完成）。
    const preview = okResult(
      await runBuiltCli([
        'workspace', 'discard-preview', box.box.featureId, '--project', box.box.projectId, '--json',
      ]),
      'workspace.discard-preview',
    );
    const document = preview.preview as Record<string, unknown>;
    expect(document.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(document.workspaceId).toBe(workspaceId);

    // 缺 --confirm：本地拒绝（退出码 2），零副作用。
    const sandbox = createTempSandbox('shiploop-f012-built-', { outside: [repoRoot] });
    try {
      const previewFile = join(sandbox.path, 'preview.json');
      writeFileSync(previewFile, JSON.stringify(document), 'utf8');
      const noConfirm = await runBuiltCli([
        'workspace', 'discard', box.box.featureId, '--project', box.box.projectId,
        '--preview-file', previewFile, '--json',
      ]);
      failedEnvelope(noConfirm, 2, 'invalid_input');

      // 伪造摘要：经服务端 conflict 拒绝（退出码 1），零删除。
      const forgedFile = join(sandbox.path, 'forged.json');
      writeFileSync(
        forgedFile,
        JSON.stringify({ ...document, previewDigest: 'f'.repeat(64) }),
        'utf8',
      );
      const forged = await runBuiltCli(
        [
          'workspace', 'discard', box.box.featureId, '--project', box.box.projectId,
          '--preview-file', forgedFile, '--confirm', '--json',
        ],
        180_000,
      );
      failedEnvelope(forged, 1, 'conflict');
      expect(existsSync(worktreePath)).toBe(true);

      // 拒绝后状态仍为 retained（未冒充清理/交付）。
      const after = okResult(
        await runBuiltCli(['workspace', 'get', box.box.featureId, '--project', box.box.projectId, '--json']),
        'workspace.get',
      );
      expect(after.state).toBe('retained');
    } finally {
      sandbox.cleanup();
    }
  });

  it('非法 ID 在连接前退出 2；不存在 Feature 折叠 not_found 退出 1', async () => {
    const box = fixture;
    if (box === undefined) {
      throw new Error('fixture 未就绪');
    }
    const bad = await runBuiltCli(['workspace', 'list', '--project', 'not-a-uuid', '--json']);
    failedEnvelope(bad, 2, 'invalid_input');
    const missing = await runBuiltCli([
      'workspace', 'get', 'feature-missing', '--project', box.box.projectId, '--json',
    ]);
    failedEnvelope(missing, 1, 'not_found');
  });
});
