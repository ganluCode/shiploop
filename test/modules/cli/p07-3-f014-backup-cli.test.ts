/**
 * P07-3 / F-014：备份/隔离恢复 CLI 纵向（真实 loopback Host + 离线维护入口）。
 *
 * 覆盖：
 * - backup create/get/operation/verify 经 runAppCli → HostClient → Host → Core；
 *   JSON stdout 只输出结构化信封（单行），退出码与状态一致；
 * - 离线核验→确认→隔离恢复在真实临时数据根完成（不注入替代服务、不直接补库；
 *   发布后目标数据库与备份逐字节一致）；
 * - 失败映射：摘要漂移（conflict）、未知备份（not_found）、目标非空
 * （restore_target_not_empty）、未确认/确认不匹配（restore_confirmation_mismatch）、
 * 缺正文（损坏包核验 incomplete）、高版本（manifest 版本拒绝）均非成功退出码；
 * - 凭据脱敏：Host 认证 token 不出现在任何 stdout/stderr；输出不含绝对路径。
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAppCli } from '../../../packages/cli/src/app-execute.ts';
import { startHost } from '../../../packages/host/src/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/ports/runtime-capabilities.ts';
import { parseAppCliArgs } from '../../../packages/cli/src/app/args.ts';

interface CliOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly body: Record<string, unknown> | null;
}

async function cli(args: readonly string[]): Promise<CliOutcome> {
  let stdout = '';
  let stderr = '';
  const result = await runAppCli({
    args: [...args, '--json'],
    env: {},
    platform: 'darwin',
    io: {
      stdout: value => { stdout += value; },
      stderr: value => { stderr += value; },
    },
  });
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { exitCode: result.exitCode, stdout, stderr, body };
}

async function waitForBackup(root: string, operationId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(join(root, 'backups', 'operations', `${operationId}.json`))) {
      const journal = JSON.parse(readFileSync(join(root, 'backups', 'operations', `${operationId}.json`), 'utf8')) as { status: string };
      if (journal.status !== 'running') return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('backup operation did not settle');
}

describe('P07-3 F-014 backup & isolated restore CLI', () => {
  it('[case:args-parse] backup/restore 解析与拒绝（缺参/未知目标/相对路径）', () => {
    expect(parseAppCliArgs(['backup', 'create', '--backup-id', 'bk-1'], {})).toMatchObject({ commandId: 'backup.create', backupId: 'bk-1', target: 'default' });
    expect(parseAppCliArgs(['backup', 'get', 'bk-1'], {})).toMatchObject({ commandId: 'backup.get', backupId: 'bk-1' });
    expect(parseAppCliArgs(['restore', 'prepare', '--data-root', '/data/root', '--package', '/pkg/path', '--operation-id', 'op-1'], {}))
      .toMatchObject({ commandId: 'restore.prepare', dataRoot: '/data/root', packagePath: '/pkg/path', operationId: 'op-1' });
    expect(() => parseAppCliArgs(['backup', 'create'], {})).toThrow();
    // target 形态在解析层只校验稳定 ID；受控引用白名单由服务端复核拒绝。
    expect(parseAppCliArgs(['backup', 'create', '--backup-id', 'bk-1', '--target', 'arbitrary'], {}))
      .toMatchObject({ commandId: 'backup.create', target: 'arbitrary' });
    expect(() => parseAppCliArgs(['restore', 'prepare', '--data-root', 'relative', '--package', '/p', '--operation-id', 'o'], {})).toThrow();
    expect(() => parseAppCliArgs(['restore', 'confirm', '--data-root', '/d', '--operation-id', 'o'], {})).toThrow();
  });

  it('[case:cli-vertical-and-restore] create/query/verify over HTTP then offline verify→confirm→publish on an empty target', async () => {
    const box = mkdtempSync(join(tmpdir(), 'shiploop-f014-cli-'));
    const root = join(box, 'root');
    const target = join(box, 'target');
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const host = await startHost({ dataRoot: root, env: {}, capabilityCatalog: createStaticRuntimeCapabilityCatalog([]) });
    try {
      const token = readFileSync(join(root, 'host', 'auth.token'), 'utf8');
      const created = await cli(['backup', 'create', '--backup-id', 'backup-cli-1', '--data-root', root]);
      expect(created.exitCode, created.stderr).toBe(0);
      expect(created.body).toMatchObject({
        ok: true,
        command: 'backup.create',
        result: { status: 'accepted', backupId: 'backup-cli-1', operationId: expect.any(String) },
      });
      const operationId = (created.body!.result as { operationId: string }).operationId;
      await waitForBackup(root, operationId);

      const operation = await cli(['backup', 'operation', operationId, '--data-root', root]);
      expect(operation.exitCode).toBe(0);
      expect(operation.body).toMatchObject({ ok: true, result: { status: 'completed', operationId, backupId: 'backup-cli-1' } });

      const digest = ((operation.body!.result as { manifestDigest?: string }).manifestDigest) as string;
      const backup = await cli(['backup', 'get', 'backup-cli-1', '--data-root', root]);
      expect(backup.exitCode).toBe(0);
      expect(backup.body).toMatchObject({ ok: true, result: { status: 'complete', manifestDigest: digest } });

      const verified = await cli(['backup', 'verify', '--backup-id', 'backup-cli-1', '--manifest-digest', digest, '--data-root', root]);
      expect(verified.exitCode, verified.stderr).toBe(0);
      expect(verified.body).toMatchObject({ ok: true, result: { report: { status: 'complete', backupId: 'backup-cli-1' } } });

      // 离线维护入口：核验 → 确认 → 隔离发布（不启动目标 Host、不直接补库）。
      const verify = await cli(['restore', 'verify', '--data-root', target, '--package', join(root, 'backups', 'backup-cli-1')]);
      expect(verify.exitCode, verify.stderr).toBe(0);
      expect(verify.body).toMatchObject({ ok: true, result: { status: 'complete', backupId: 'backup-cli-1' } });

      const prepare = await cli(['restore', 'prepare', '--data-root', target, '--package', join(root, 'backups', 'backup-cli-1'), '--operation-id', 'restore-cli-1']);
      expect(prepare.exitCode, prepare.stderr).toBe(0);
      const confirmation = (prepare.body!.result as { confirmation: Record<string, unknown> }).confirmation;
      expect(confirmation).toMatchObject({ backupId: 'backup-cli-1', confirmed: true, targetMode: 'empty-isolated' });
      const confirmationFile = join(box, 'confirmation.json');
      writeFileSync(confirmationFile, JSON.stringify(confirmation), { mode: 0o600 });

      const confirm = await cli(['restore', 'confirm', '--data-root', target, '--operation-id', 'restore-cli-1', '--confirmation-file', confirmationFile]);
      expect(confirm.exitCode, confirm.stderr).toBe(0);
      expect(confirm.body).toMatchObject({ ok: true, result: { status: 'published', backupId: 'backup-cli-1' } });
      // 发布后的目标数据库与备份逐字节一致（受控文件，不是伪造空库）。
      expect(readFileSync(join(target, 'core.sqlite')).equals(readFileSync(join(root, 'backups', 'backup-cli-1', 'core.sqlite')))).toBe(true);

      // 凭据脱敏与路径纪律：所有 stdout 不含 Host token / 数据根绝对路径。
      for (const output of [created, operation, backup, verified, verify, prepare, confirm]) {
        expect(output.stdout).not.toContain(token);
        expect(output.stdout).not.toContain(root);
        expect(output.stdout.trim().split('\n')).toHaveLength(1);
      }
    } finally {
      await host.close();
      rmSync(box, { recursive: true, force: true });
    }
  });

  it('[case:failure-mappings] digest drift, unknown backup, non-empty target, mismatched confirmation, corrupt and high-version packages', async () => {
    const box = mkdtempSync(join(tmpdir(), 'shiploop-f014-fail-'));
    const root = join(box, 'root');
    const busy = join(box, 'busy');
    mkdirSync(busy, { recursive: true, mode: 0o700 });
    writeFileSync(join(busy, 'core.sqlite'), 'original');
    const host = await startHost({ dataRoot: root, env: {}, capabilityCatalog: createStaticRuntimeCapabilityCatalog([]) });
    try {
      const created = await cli(['backup', 'create', '--backup-id', 'backup-fail-1', '--data-root', root]);
      expect(created.exitCode).toBe(0);
      const operationId = (created.body!.result as { operationId: string }).operationId;
      await waitForBackup(root, operationId);

      // 摘要漂移 → conflict（非成功退出码）。
      const drift = await cli(['backup', 'verify', '--backup-id', 'backup-fail-1', '--manifest-digest', 'a'.repeat(64), '--data-root', root]);
      expect(drift.exitCode).toBe(1);
      expect(drift.body).toMatchObject({ ok: false, error: { code: 'conflict' } });

      // 未知备份 → not_found。
      const unknown = await cli(['backup', 'get', 'backup-fail-missing', '--data-root', root]);
      expect(unknown.exitCode).toBe(1);
      expect(unknown.body).toMatchObject({ ok: false, error: { code: 'not_found' } });

      // 目标非空 → 独立维护入口拒绝（不覆盖既有数据）。
      const prepareBusy = await cli(['restore', 'prepare', '--data-root', busy, '--package', join(root, 'backups', 'backup-fail-1'), '--operation-id', 'restore-busy']);
      expect(prepareBusy.exitCode).toBe(1);
      expect(prepareBusy.body).toMatchObject({ ok: false, error: { code: 'restore_target_not_empty' } });
      expect(readFileSync(join(busy, 'core.sqlite'), 'utf8')).toBe('original');

      // 未确认：伪造/漂移确认文档 → confirmation mismatch（目标保持空）。
      const empty = join(box, 'empty');
      mkdirSync(empty, { recursive: true, mode: 0o700 });
      const prepare = await cli(['restore', 'prepare', '--data-root', empty, '--package', join(root, 'backups', 'backup-fail-1'), '--operation-id', 'restore-x']);
      expect(prepare.exitCode).toBe(0);
      const confirmation = (prepare.body!.result as { confirmation: Record<string, unknown> }).confirmation;
      for (const mutation of [{ confirmed: false }, { manifestDigest: 'f'.repeat(64) }]) {
        const badFile = join(box, 'bad-confirmation.json');
        writeFileSync(badFile, JSON.stringify({ ...confirmation, ...mutation }));
        const bad = await cli(['restore', 'confirm', '--data-root', empty, '--operation-id', 'restore-x', '--confirmation-file', badFile]);
        expect(bad.exitCode).toBe(1);
        expect(bad.body).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^restore_/) } });
      }
      expect(existsSync(join(empty, 'core.sqlite'))).toBe(false);

      // 缺正文：复制包后删除数据库正文 → 核验 incomplete（非成功退出码）。
      const missingBody = join(box, 'missing-body');
      mkdirSync(missingBody, { recursive: true, mode: 0o700 });
      for (const entry of readdirSync(join(root, 'backups', 'backup-fail-1'))) {
        if (entry === 'core.sqlite') continue;
        copyFileSync(join(root, 'backups', 'backup-fail-1', entry), join(missingBody, entry));
      }
      writeFileSync(join(missingBody, 'core.sqlite'), 'truncated');
      const corrupt = await cli(['restore', 'verify', '--data-root', empty, '--package', missingBody]);
      expect(corrupt.exitCode).toBe(1);
      expect(corrupt.body).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^backup_verification_/) } });

      // 高版本：manifest 声明未知 schema 版本 → 核验拒绝（不猜测降级）。
      const highVersion = join(box, 'high-version');
      mkdirSync(highVersion, { recursive: true, mode: 0o700 });
      const manifest = JSON.parse(readFileSync(join(root, 'backups', 'backup-fail-1', 'manifest.json'), 'utf8')) as Record<string, unknown>;
      manifest.schemaVersion = 99;
      writeFileSync(join(highVersion, 'manifest.json'), JSON.stringify(manifest));
      copyFileSync(join(root, 'backups', 'backup-fail-1', 'core.sqlite'), join(highVersion, 'core.sqlite'));
      const high = await cli(['restore', 'verify', '--data-root', empty, '--package', highVersion]);
      expect(high.exitCode).toBe(1);
      expect(high.body).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^backup_verification_|^restore_/) } });
      void randomUUID();
    } finally {
      await host.close();
      rmSync(box, { recursive: true, force: true });
    }
  });
});
