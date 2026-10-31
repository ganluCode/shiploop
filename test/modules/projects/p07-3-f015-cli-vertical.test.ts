/**
 * P07-3 / F-015：真实 CLI → loopback Host → Core → SQLite/Git/文件 垂直回归。
 *
 * 覆盖（PRD §3.1 / core-design/08 §2/§4/§5.1）：
 * - 项目软归档（CLI JSON 退出码 0）、归档列表过滤（默认隐藏 archived、
 *   status 筛选可见）、显式恢复不启动 Run；
 * - 删除只读预览（confirmable/previewDigest/保留项）与显式确认（accepted +
 *   operationId）；重复删除命令（同 commandId）返回同一删除事实；accepted
 *   不显示成已删除；delete-operation 查询最小结果（intent 状态可见）；
 * - 引用证据拒绝：归档状态保护 + 摘要漂移在公开流程一致拒绝（退出码非 0）；
 * - 保留评估（真实受控数据根磁盘观测）与未配置政策的清理拒绝；
 * - CLI 结构错误（未知子命令）退出码 2；帮助文本可获取。
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAppCli, type AppCliIo } from '../../../packages/cli/src/app-execute.ts';
import { runHostCli, type HostCliIo } from '../../../packages/cli/src/host/execute.ts';
import { createBaselineFixture, type BaselineFixture } from '../../helpers/p02-3/index.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REGISTER_HOOKS = fileURLToPath(new URL('../../helpers/node-ts-loader/register.mjs', import.meta.url));
const DETACHED_HOST_ENTRY = fileURLToPath(new URL('../../helpers/host/detached-host-entry.ts', import.meta.url));

function collectIo(): { io: AppCliIo; stdout: () => string; stderr: () => string } {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function parseJson(output: string): Record<string, any> {
  return JSON.parse(output) as Record<string, any>;
}

describe('P07-3 F-015 real CLI lifecycle flow', () => {
  let fixture: BaselineFixture | undefined;
  const roots: string[] = [];

  beforeAll(() => {
    execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { cwd: repoRoot, timeout: 60_000 });
  });
  beforeEach(() => { fixture = createBaselineFixture({ prefix: 'shiploop-f015-cli-' }); });
  afterEach(async () => {
    for (const root of roots) {
      const stop = collectIo();
      try {
        await runHostCli({ args: ['host', 'stop', '--data-root', root, '--json'], io: stop.io as HostCliIo, env: {} });
      } catch { /* fixture cleanup remains authoritative */ }
    }
    roots.length = 0;
    await fixture?.dispose();
    fixture = undefined;
  });

  it('archive → filtered list → restore（不启动 Run）→ stale CAS 拒绝', async () => {
    const root = fixture!.dataRoot('archive');
    roots.push(root);
    const launch = {
      entryArgv: ['--import', REGISTER_HOOKS, DETACHED_HOST_ENTRY],
      childEnv: fixture!.childEnv(),
      pollIntervalMs: 50,
    };
    const run = async (args: readonly string[]) => {
      const io = collectIo();
      const result = await runAppCli({ args: [...args, '--data-root', root, '--json'], io: io.io, launch });
      return { result, stdout: io.stdout(), stderr: io.stderr() };
    };

    const initial = await run(['project', 'init', fixture!.repos.withHead, '--name', 'F015-archive', '--confirm']);
    expect(initial.result.exitCode, initial.stderr).toBe(0);
    const projectId = parseJson(initial.stdout).result.registration.projectId as string;
    const detail = parseJson((await run(['project', 'get', projectId])).stdout);
    const revision = detail.result.project.revision as number;

    const archived = await run(['project', 'archive', projectId, '--revision', String(revision)]);
    expect(archived.result.exitCode, archived.stderr).toBe(0);
    const archivedEnvelope = parseJson(archived.stdout);
    expect(archivedEnvelope.command).toBe('project.archive');
    expect(archivedEnvelope.result.status).toBe('archived');
    expect(archivedEnvelope.result.settled).toBe(true);

    // 归档列表过滤：默认隐藏；status=archived 可见。
    const visibleList = parseJson((await run(['project', 'list'])).stdout);
    expect(visibleList.result.records.some((record: { id: string }) => record.id === projectId)).toBe(false);
    const archivedList = parseJson((await run(['project', 'list', '--status', 'archived'])).stdout);
    expect(archivedList.result.records.some((record: { id: string }) => record.id === projectId)).toBe(true);

    // 显式恢复：active；不创建 Run（恢复 ≠ 启动执行；归档收尾后 revision 已推进）。
    const archivedRevision = parseJson(archived.stdout).result.project.revision as number;
    const restored = await run(['project', 'restore', projectId, '--revision', String(archivedRevision)]);
    expect(restored.result.exitCode, restored.stderr).toBe(0);
    expect(parseJson(restored.stdout).result.status).toBe('active');
    const restoredDetail = parseJson((await run(['project', 'get', projectId])).stdout);
    expect(restoredDetail.result.project.status).toBe('active');

    // 旧 revision 重复归档：rejected（stale_revision）退出码非 0，不显示成功。
    const stale = await run(['project', 'archive', projectId, '--revision', String(revision)]);
    expect(stale.result.exitCode).not.toBe(0);
    const staleEnvelope = parseJson(stale.stdout);
    expect(staleEnvelope.ok).toBe(false);
    expect(staleEnvelope.error.code).toBe('conflict');
  });

  it('delete preview → confirm（accepted+operationId）→ 重放同一事实 → delete-operation 查询', async () => {
    const root = fixture!.dataRoot('delete');
    roots.push(root);
    const launch = {
      entryArgv: ['--import', REGISTER_HOOKS, DETACHED_HOST_ENTRY],
      childEnv: fixture!.childEnv(),
      pollIntervalMs: 50,
    };
    const run = async (args: readonly string[]) => {
      const io = collectIo();
      const result = await runAppCli({ args: [...args, '--data-root', root, '--json'], io: io.io, launch });
      return { result, stdout: io.stdout(), stderr: io.stderr() };
    };

    const initial = await run(['project', 'init', fixture!.repos.withHead, '--name', 'F015-delete', '--confirm']);
    expect(initial.result.exitCode, initial.stderr).toBe(0);
    const projectId = parseJson(initial.stdout).result.registration.projectId as string;
    const detail = parseJson((await run(['project', 'get', projectId])).stdout);
    const revision = detail.result.project.revision as number;
    expect((await run(['project', 'archive', projectId, '--revision', String(revision)])).result.exitCode).toBe(0);

    // 未归档状态（已归档后无 active 项目）—摘要漂移拒绝路径在 confirm 上验证。
    const preview = await run(['project', 'delete-preview', projectId]);
    expect(preview.result.exitCode, preview.stderr).toBe(0);
    const page = parseJson(preview.stdout).result.page as {
      projectRevision: number; previewDigest: string; expiresAtUtcMs: number; confirmable: boolean;
    };
    expect(page.confirmable).toBe(true);

    // 摘要漂移：错误 previewDigest 一致拒绝（非 0 退出码 + conflict）。
    const drift = await run([
      'project', 'delete-confirm', projectId, '--revision', String(page.projectRevision),
      '--preview-digest', 'c'.repeat(64), '--expires-at-ms', String(page.expiresAtUtcMs), '--confirm',
    ]);
    expect(drift.result.exitCode).not.toBe(0);
    expect(parseJson(drift.stdout).error.code).toBe('conflict');

    const confirm = await run([
      'project', 'delete-confirm', projectId, '--revision', String(page.projectRevision),
      '--preview-digest', page.previewDigest, '--expires-at-ms', String(page.expiresAtUtcMs), '--confirm',
    ]);
    expect(confirm.result.exitCode, confirm.stderr).toBe(0);
    const confirmEnvelope = parseJson(confirm.stdout);
    expect(confirmEnvelope.command).toBe('project.delete-confirm');
    expect(confirmEnvelope.result.status).toBe('accepted');
    const operationId = confirmEnvelope.result.operationId as string;
    const commandId = confirmEnvelope.result.commandId as string;

    // 重复删除命令（同 commandId 重放）返回同一删除事实（operationId 不变）。
    const replay = await run([
      'project', 'delete-confirm', projectId, '--revision', String(page.projectRevision),
      '--preview-digest', page.previewDigest, '--expires-at-ms', String(page.expiresAtUtcMs),
      '--confirm', '--command-id', commandId,
    ]);
    expect(replay.result.exitCode, replay.stderr).toBe(0);
    const replayEnvelope = parseJson(replay.stdout);
    expect(replayEnvelope.result.operationId).toBe(operationId);
    expect(replayEnvelope.result.replayed).toBe(true);

    // 删除操作受控查询：最小结果（intent；accepted ≠ 已删除）。
    const operation = await run(['project', 'delete-operation', operationId]);
    expect(operation.result.exitCode, operation.stderr).toBe(0);
    const operationEnvelope = parseJson(operation.stdout);
    expect(operationEnvelope.command).toBe('project.delete-operation');
    expect(operationEnvelope.result).toMatchObject({ operationId, projectId, status: 'intent' });
    expect(JSON.stringify(operationEnvelope)).not.toContain('manifest');
  });

  it('retention evaluation 只读输出；未配置政策的 cleanup rejected；未知子命令退出码 2', async () => {
    const root = fixture!.dataRoot('retention');
    roots.push(root);
    const launch = {
      entryArgv: ['--import', REGISTER_HOOKS, DETACHED_HOST_ENTRY],
      childEnv: fixture!.childEnv(),
      pollIntervalMs: 50,
    };
    const io = collectIo();
    const run = async (args: readonly string[]) => {
      const collected = collectIo();
      const result = await runAppCli({ args: [...args, '--data-root', root, '--json'], io: collected.io, launch });
      return { result, stdout: collected.stdout(), stderr: collected.stderr() };
    };
    void io;

    const evaluation = await run(['retention', 'evaluation']);
    expect(evaluation.result.exitCode, evaluation.stderr).toBe(0);
    const evaluationEnvelope = parseJson(evaluation.stdout);
    expect(evaluationEnvelope.command).toBe('retention.evaluation');
    expect(evaluationEnvelope.result.policy.status).toBe('not_configured');

    const cleanup = await run(['retention', 'cleanup']);
    expect(cleanup.result.exitCode).not.toBe(0);
    const cleanupEnvelope = parseJson(cleanup.stdout);
    expect(cleanupEnvelope.ok).toBe(false);
    expect(cleanupEnvelope.error.code).toBe('conflict');
    expect(cleanupEnvelope.error.details.reason).toBe('retention_policy_not_configured');

    const help = await runAppCli({
      args: ['retention', '--help'],
      io: collectIo().io,
      launch,
    });
    expect(help.exitCode).toBe(0);

    const unknown = await run(['retention', 'purge']);
    expect(unknown.result.exitCode).toBe(2);
  });
});
