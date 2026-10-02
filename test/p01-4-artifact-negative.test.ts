/**
 * P01-4 / F-005 制品缺失、篡改与发布中断核对的阶段负例（检查
 * `P01-FR2-ARTIFACT-MISSING` / `P01-FR2-ARTIFACT-RECOVERY`，契约见
 * docs/p01-4-acceptance-contract.md §2.1 / §3.3）：在 F-002 夹具的隔离数据根
 * 与真实 Git 仓库上，经**真实发布入口**与真实核对端口证明：
 *
 * - P01-FR2-ARTIFACT-MISSING：ready 制品正文被删除（只删本次临时夹具的文件）
 *   后，有效读取（readVerifiedContent）与核对（verifyArtifact）明确报告
 *   corrupt/missing，不返回有效引用或空正文；正文被篡改（同长改字节 /
 *   追加字节）分别报告 hash_mismatch / size_mismatch 并拒绝读取；索引状态、
 *   revision 与残留文件不被核对改写；其他正常制品、项目和配置保持可读取且
 *   内容不变；
 * - P01-FR2-ARTIFACT-RECOVERY：复用前序真实受控进程
 *   （test/helpers/interrupt-publish-child.ts，非零退出码 70/71/72 模拟
 *   Host 中断），进程退出后以**新的装配实例**重开核对：pending 无正文 /
 *   仅 staging 残留保持不可用（残留保留原位），pending + 正式文件只有验证
 *   hash/size 后才经 CAS 补 ready；无索引 staging 孤儿经 verifyProject 生成
 *   证据并 kept_in_place（不立即删除）；核对重复运行不新增重复索引、不覆盖
 *   已核验正文；路径穿越与符号链接拒绝保持根外哨兵不变。
 *
 * 纪律：
 * - 只经产品公共入口读写（openCoreApplication → ArtifactStore/ArtifactFileStore
 *   + 发布/核对用例）；注入故障只删除/改写**文件**或创建不可信文件系统条件，
 *   绝不为演示直接改 SQLite 制品状态；
 * - 证据（原 hash/size、逻辑 locator、文件缺失事实、索引诊断、子进程退出码、
 *   孤儿处置、脱敏索引与文件摘要）在删除临时业务资源之前序列化到独立报告
 *   目录；证据不含绝对路径，业务清理后仍可读；
 * - 必需工具缺失由夹具显式失败而非 skip；子进程有界等待并核验退出码/信号。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CoreApplication } from '../packages/core/src/adapters/composition.ts';
import { createArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import type { ArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import {
  createArtifactVerifier,
  isArtifactVerifyError,
} from '../packages/core/src/application/artifact-verify.ts';
import type { ArtifactVerifier } from '../packages/core/src/application/artifact-verify.ts';
import { deriveArtifactFinalRelativePath } from '../packages/core/src/ports/artifact-files.ts';
import { isArtifactFileError } from '../packages/core/src/ports/artifact-files.ts';
import { isStorageError } from '../packages/core/src/ports/errors.ts';
import { DATABASE_FILE_NAME } from '../packages/core/src/ports/path-service.ts';
import { canonicalJson, sha256Hex, withP01AcceptanceFixture } from './helpers/p01-4-fixture.ts';
import type { P01AcceptanceFixture, P01EvidenceRef } from './helpers/p01-4-fixture.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = join(testDir, 'helpers', 'interrupt-publish-child.ts');
const CHILD_REGISTER = join(testDir, 'helpers', 'node-ts-loader', 'register.mjs');

const PUBLISH_LIMITS = { maxSizeBytes: 1_048_576, timeoutMs: 30_000 } as const;
const VERIFY_LIMITS = { maxReadBytes: 1_048_576 } as const;

type InterruptCheckpoint = 'registered' | 'staged' | 'published';

/** 与 test/helpers/interrupt-publish-child.ts 约定的检查点退出码。 */
const CHECKPOINT_EXIT: Record<InterruptCheckpoint, number> = {
  registered: 70,
  staged: 71,
  published: 72,
};

type ChildResult = {
  readonly artifactId: string;
  readonly stagingRelativePath?: string;
  readonly finalRelativePath?: string;
};

/** 有界等待子进程退出；超时先 SIGKILL 再失败，绝不悬挂测试进程。 */
function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`子进程退出超时（${timeoutMs}ms），已 SIGKILL`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

/** 启动受控中断子进程并核验退出码与结果文件（有界等待，失败显式报错）。 */
async function runInterruptedChild(config: {
  dbPath: string;
  dataRoot: string;
  projectId: string;
  kind: string;
  mediaType: string;
  expectedHash: string;
  locator: string;
  contentBase64: string;
  checkpoint: InterruptCheckpoint;
  resultFile: string;
}): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  result: ChildResult;
}> {
  const child = spawn(
    process.execPath,
    ['--import', CHILD_REGISTER, CHILD_SCRIPT, JSON.stringify(config)],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  try {
    const exit = await waitForExit(child, 60_000);
    if (exit.code !== CHECKPOINT_EXIT[config.checkpoint] || !existsSync(config.resultFile)) {
      throw new Error(
        `子进程未在检查点 ${config.checkpoint} 中断（exit=${String(exit.code)} signal=${String(exit.signal)}）：${stderr}`,
      );
    }
    return {
      exitCode: exit.code,
      signal: exit.signal,
      stderr,
      result: JSON.parse(readFileSync(config.resultFile, 'utf8')) as ChildResult,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
}

/** 捕获预期错误；调用未抛错即失败（负例必须同时有错误断言与副作用断言）。 */
async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出错误但调用成功');
}

/** 断言错误文本不携带绝对路径（脱敏核对：只含相对逻辑位置与摘要级信息）。 */
function expectNoAbsolutePathLeak(error: unknown, dataRoot: string): void {
  const text = JSON.stringify({
    message: error instanceof Error ? error.message : String(error),
    details:
      error !== null && typeof error === 'object' && 'details' in error
        ? (error as { details: unknown }).details ?? null
        : null,
  });
  expect(text.includes(dataRoot)).toBe(false);
  expect(text.includes(REPO_ROOT)).toBe(false);
}

function makePublisher(app: CoreApplication): ArtifactPublisher {
  return createArtifactPublisher({
    artifacts: app.artifactStore,
    files: app.artifactFileStore,
    limits: PUBLISH_LIMITS,
  });
}

function makeVerifier(app: CoreApplication): ArtifactVerifier {
  return createArtifactVerifier({
    artifacts: app.artifactStore,
    files: app.artifactFileStore,
    limits: VERIFY_LIMITS,
  });
}

/** 经产品服务注册夹具项目并写入固定全局/项目配置（供「其他业务不变」对照）。 */
async function setupBaseline(
  fixture: P01AcceptanceFixture,
  app: CoreApplication,
): Promise<{
  projectId: string;
  project: unknown;
}> {
  const input = fixture.businessInput;
  const registration = await app.projectService.registerRepository({
    repositoryPath: fixture.repoDir,
    displayName: input.project.displayName,
    description: input.project.description,
    labels: [...input.project.labels],
  });
  expect(registration.status).toBe('registered');
  const projectId = registration.project.id;
  await app.configurationService.createSettings(
    { kind: 'global' },
    { payload: input.globalSettings },
  );
  await app.configurationService.createSettings(
    { kind: 'project', projectId },
    { payload: input.projectSettings },
  );
  return { projectId, project: registration.project };
}

/** 断言项目与全局/项目配置仍可读取且内容不变（其他业务不受负例影响）。 */
async function expectBaselineIntact(
  fixture: P01AcceptanceFixture,
  app: CoreApplication,
  projectId: string,
  project: unknown,
): Promise<void> {
  expect(await app.projectService.getProject(projectId)).toEqual(project);
  const globalSettings = await app.configurationService.getCurrentSettings({ kind: 'global' });
  expect(globalSettings.payload).toEqual(fixture.businessInput.globalSettings);
  const projectSettings = await app.configurationService.getCurrentSettings({
    kind: 'project',
    projectId,
  });
  expect(projectSettings.payload).toEqual(fixture.businessInput.projectSettings);
}

/**
 * 只删除/改写受控数据根内的本次正文文件：先核验真实路径确实位于数据根内
 * （防误删根外资源），返回绝对路径供后续 existsSync/stat 断言。
 */
function controlledContentPath(dataRoot: string, finalRelativePath: string): string {
  const absolute = join(dataRoot, ...finalRelativePath.split('/'));
  const dataRootReal = realpathSync(dataRoot);
  const parentReal = realpathSync(dirname(absolute));
  expect(parentReal.startsWith(dataRootReal + '/')).toBe(true);
  expect(absolute.endsWith('/content')).toBe(true);
  return absolute;
}

describe('F-005 制品缺失与篡改负例（P01-FR2-ARTIFACT-MISSING）', () => {
  it('删除本次正文文件后读取/核对明确 missing/corrupt：不返回有效引用或空正文，索引不变，其他业务不变，证据先行落盘', async () => {
    await withP01AcceptanceFixture(async (fixture) => {
      const repoBefore = fixture.snapshotSourceRepo();
      const outsideBefore = fixture.snapshotOutsideSentinel();
      const app = await fixture.openApplication();
      const { projectId, project } = await setupBaseline(fixture, app);
      const publisher = makePublisher(app);
      const verifier = makeVerifier(app);
      const input = fixture.businessInput;

      // 受害制品（固定夹具正文）与对照制品（不同 locator/正文）。
      const victim = await publisher.publishArtifact({
        projectId,
        kind: input.artifact.kind,
        mediaType: input.artifact.mediaType,
        expectedHash: fixture.artifactSha256,
        locator: input.artifact.locator,
        version: input.artifact.version,
        content: [new Uint8Array(fixture.artifactBytes)],
      });
      const victimId = victim.artifact.id;
      expect(victim.artifact.status).toBe('ready');
      const controlBytes = Buffer.from('# 对照制品\n第二制品固定正文 🔒\n', 'utf-8');
      const controlHash = sha256Hex(controlBytes);
      const control = await publisher.publishArtifact({
        projectId,
        kind: 'verification-report',
        mediaType: input.artifact.mediaType,
        expectedHash: controlHash,
        locator: 'artifacts/reports/p01-4-control.md',
        version: 1,
        content: [new Uint8Array(controlBytes)],
      });
      const controlId = control.artifact.id;

      // 先确认有效读取可用（ready 基线），再只删除本次临时夹具的正文文件。
      const baselineRead = await verifier.readVerifiedContent(projectId, victimId);
      expect(Buffer.from(baselineRead.content)).toEqual(fixture.artifactBytes);
      const victimAbs = controlledContentPath(app.dataRoot, victim.finalRelativePath);
      expect(existsSync(victimAbs)).toBe(true);
      rmSync(victimAbs);
      expect(existsSync(victimAbs)).toBe(false);

      // 有效读取：明确 corrupt/missing，绝不返回有效引用或空正文。
      const readError = await captureError(() =>
        verifier.readVerifiedContent(projectId, victimId),
      );
      expect(isArtifactVerifyError(readError, 'corrupt')).toBe(true);
      if (!isArtifactVerifyError(readError)) {
        throw new Error('预期 ArtifactVerifyError');
      }
      expect(readError.corruption?.kind).toBe('missing');
      expect(readError.corruption?.expectedHash).toBe(fixture.artifactSha256);
      expect(readError.corruption?.expectedSizeBytes).toBe(fixture.artifactBytes.length);
      expectNoAbsolutePathLeak(readError, app.dataRoot);

      // 核对：明确 corrupt/missing 诊断；不改变索引状态/revision/登记摘要。
      const report = await verifier.verifyArtifact(projectId, victimId);
      expect(report.kind).toBe('corrupt');
      expect(report.corruption?.kind).toBe('missing');
      expect(report.corruption?.expectedHash).toBe(fixture.artifactSha256);
      expect(report.corruption?.expectedSizeBytes).toBe(fixture.artifactBytes.length);
      expect(report.status).toBe('ready');
      expect(report.revision).toBe(victim.artifact.revision);
      const recordAfter = await app.artifactStore.getArtifact(projectId, victimId);
      expect(recordAfter).toEqual(victim.artifact);

      // 重复核对：同一诊断、不新增索引、不改写状态。
      const again = await verifier.verifyArtifact(projectId, victimId);
      expect(again.kind).toBe('corrupt');
      expect(again.corruption?.kind).toBe('missing');
      const listed = await app.artifactStore.listArtifacts(projectId, { limit: 256 });
      expect(listed.records.map((record) => record.id).sort()).toEqual(
        [victimId, controlId].sort(),
      );

      // 对照制品仍可按原字节有效读取；项目与配置内容不变。
      const controlRead = await verifier.readVerifiedContent(projectId, controlId);
      expect(Buffer.from(controlRead.content)).toEqual(controlBytes);
      await expectBaselineIntact(fixture, app, projectId, project);

      // 源仓库与根外哨兵逐字节不变（负例只触碰受控数据根内的本次文件）。
      expect(fixture.snapshotSourceRepo()).toEqual(repoBefore);
      expect(fixture.snapshotOutsideSentinel()).toBe(outsideBefore);

      // 证据先行落盘（契约 §2.1 字段：原 hash/size、逻辑 locator、文件缺失
      // 事实、索引诊断、其他实体可读性）。
      const ref = fixture.writeEvidence(
        'artifact-negative/fr2-artifact-missing.json',
        JSON.stringify(
          {
            checkId: 'P01-FR2-ARTIFACT-MISSING',
            status: 'pass',
            scenario: 'ready_content_file_deleted',
            artifact_id: victimId,
            original: {
              content_hash: fixture.artifactSha256,
              size_bytes: fixture.artifactBytes.length,
              locator: input.artifact.locator,
              relative_path: victim.finalRelativePath,
            },
            file_missing_fact: { exists_after_delete: false },
            read_outcome: {
              rejected: true,
              error_code: 'corrupt',
              corruption_kind: 'missing',
              no_content_returned: true,
            },
            index_diagnosis: {
              verify_kind: report.kind,
              corruption_kind: report.corruption?.kind ?? null,
              status_after_verify: report.status,
              revision_after_verify: report.revision,
              index_record_unchanged: true,
              repeat_verify_same_diagnosis: again.corruption?.kind === 'missing',
              indexed_artifact_count: listed.records.length,
            },
            other_entities: {
              control_artifact_id: controlId,
              control_readable_byte_identical: true,
              project_readable_unchanged: true,
              settings_readable_unchanged: true,
            },
            source_repo_unchanged: canonicalJson(fixture.snapshotSourceRepo()) === canonicalJson(repoBefore),
            outside_sentinel_sha256: outsideBefore,
            tools: fixture.tools,
          },
          null,
          2,
        ),
      );
      await assertEvidenceSurvivesCleanup(fixture, [ref], 'artifact-negative/fr2-artifact-missing.json', outsideBefore);
    });
  });

  it('正文被篡改（同长改字节→hash_mismatch、追加字节→size_mismatch）：读取拒绝且核对诊断精确，索引与残留字节不变', async () => {
    await withP01AcceptanceFixture(async (fixture) => {
      const repoBefore = fixture.snapshotSourceRepo();
      const outsideBefore = fixture.snapshotOutsideSentinel();
      const app = await fixture.openApplication();
      const { projectId, project } = await setupBaseline(fixture, app);
      const publisher = makePublisher(app);
      const verifier = makeVerifier(app);
      const input = fixture.businessInput;

      // 篡改目标 A：同长度改字节（stat 大小不变，实测摘要不符）。
      const tamperedABytes = Buffer.from(fixture.artifactBytes);
      tamperedABytes[5] = tamperedABytes[5]! ^ 0xff;
      tamperedABytes[11] = tamperedABytes[11]! ^ 0x01;
      expect(tamperedABytes.length).toBe(fixture.artifactBytes.length);
      expect(sha256Hex(tamperedABytes)).not.toBe(fixture.artifactSha256);
      const victimA = await publisher.publishArtifact({
        projectId,
        kind: input.artifact.kind,
        mediaType: input.artifact.mediaType,
        expectedHash: fixture.artifactSha256,
        locator: 'artifacts/reports/p01-4-tamper-hash.md',
        version: 1,
        content: [new Uint8Array(fixture.artifactBytes)],
      });
      const victimAAbs = controlledContentPath(app.dataRoot, victimA.finalRelativePath);
      writeFileSync(victimAAbs, tamperedABytes);

      // 篡改目标 B：追加字节（stat 大小即不符）。
      const tamperedBBytes = Buffer.concat([
        fixture.artifactBytes,
        Buffer.from('\n追加的篡改字节\n', 'utf-8'),
      ]);
      const victimB = await publisher.publishArtifact({
        projectId,
        kind: input.artifact.kind,
        mediaType: input.artifact.mediaType,
        expectedHash: fixture.artifactSha256,
        locator: 'artifacts/reports/p01-4-tamper-size.md',
        version: 1,
        content: [new Uint8Array(fixture.artifactBytes)],
      });
      const victimBAbs = controlledContentPath(app.dataRoot, victimB.finalRelativePath);
      writeFileSync(victimBAbs, tamperedBBytes);

      // 对照制品保持原样。
      const controlBytes = Buffer.from('# 对照制品\n未被篡改的正文\n', 'utf-8');
      const control = await publisher.publishArtifact({
        projectId,
        kind: 'verification-report',
        mediaType: input.artifact.mediaType,
        expectedHash: sha256Hex(controlBytes),
        locator: 'artifacts/reports/p01-4-tamper-control.md',
        version: 1,
        content: [new Uint8Array(controlBytes)],
      });

      // A：hash_mismatch——读取拒绝并携带实际摘要；核对报告同一诊断。
      const readErrorA = await captureError(() =>
        verifier.readVerifiedContent(projectId, victimA.artifact.id),
      );
      expect(isArtifactVerifyError(readErrorA, 'corrupt')).toBe(true);
      if (!isArtifactVerifyError(readErrorA)) {
        throw new Error('预期 ArtifactVerifyError');
      }
      expect(readErrorA.corruption?.kind).toBe('hash_mismatch');
      expect(readErrorA.corruption?.expectedHash).toBe(fixture.artifactSha256);
      expect(readErrorA.corruption?.actualHash).toBe(sha256Hex(tamperedABytes));
      expectNoAbsolutePathLeak(readErrorA, app.dataRoot);
      const reportA = await verifier.verifyArtifact(projectId, victimA.artifact.id);
      expect(reportA.kind).toBe('corrupt');
      expect(reportA.corruption?.kind).toBe('hash_mismatch');
      expect(reportA.corruption?.actualHash).toBe(sha256Hex(tamperedABytes));
      expect(reportA.status).toBe('ready');
      expect(reportA.revision).toBe(victimA.artifact.revision);

      // B：size_mismatch——stat 字节数与索引不符即拒绝（不读入正文放行）。
      const readErrorB = await captureError(() =>
        verifier.readVerifiedContent(projectId, victimB.artifact.id),
      );
      expect(isArtifactVerifyError(readErrorB, 'corrupt')).toBe(true);
      if (!isArtifactVerifyError(readErrorB)) {
        throw new Error('预期 ArtifactVerifyError');
      }
      expect(readErrorB.corruption?.kind).toBe('size_mismatch');
      expect(readErrorB.corruption?.expectedSizeBytes).toBe(fixture.artifactBytes.length);
      expect(readErrorB.corruption?.actualSizeBytes).toBe(tamperedBBytes.length);
      const reportB = await verifier.verifyArtifact(projectId, victimB.artifact.id);
      expect(reportB.kind).toBe('corrupt');
      expect(reportB.corruption?.kind).toBe('size_mismatch');

      // 核对不改写索引与被篡改字节：记录逐字段不变、文件保留篡改后内容。
      expect(await app.artifactStore.getArtifact(projectId, victimA.artifact.id)).toEqual(
        victimA.artifact,
      );
      expect(await app.artifactStore.getArtifact(projectId, victimB.artifact.id)).toEqual(
        victimB.artifact,
      );
      expect(readFileSync(victimAAbs)).toEqual(tamperedABytes);
      expect(readFileSync(victimBAbs)).toEqual(tamperedBBytes);

      // 对照制品与项目/配置保持可读取且内容不变。
      const controlRead = await verifier.readVerifiedContent(projectId, control.artifact.id);
      expect(Buffer.from(controlRead.content)).toEqual(controlBytes);
      await expectBaselineIntact(fixture, app, projectId, project);
      expect(fixture.snapshotSourceRepo()).toEqual(repoBefore);
      expect(fixture.snapshotOutsideSentinel()).toBe(outsideBefore);

      const ref = fixture.writeEvidence(
        'artifact-negative/fr2-artifact-corrupt.json',
        JSON.stringify(
          {
            checkId: 'P01-FR2-ARTIFACT-MISSING',
            status: 'pass',
            scenario: 'ready_content_tampered',
            hash_mismatch: {
              artifact_id: victimA.artifact.id,
              expected_hash: fixture.artifactSha256,
              actual_hash: sha256Hex(tamperedABytes),
              size_bytes_unchanged: tamperedABytes.length === fixture.artifactBytes.length,
              read_rejected: true,
              verify_kind: reportA.kind,
              corruption_kind: reportA.corruption?.kind ?? null,
            },
            size_mismatch: {
              artifact_id: victimB.artifact.id,
              expected_size_bytes: fixture.artifactBytes.length,
              actual_size_bytes: tamperedBBytes.length,
              read_rejected: true,
              verify_kind: reportB.kind,
              corruption_kind: reportB.corruption?.kind ?? null,
            },
            index_and_residue: {
              index_records_unchanged: true,
              tampered_files_kept_in_place: true,
              control_artifact_readable: true,
            },
            source_repo_unchanged: canonicalJson(fixture.snapshotSourceRepo()) === canonicalJson(repoBefore),
            outside_sentinel_sha256: outsideBefore,
          },
          null,
          2,
        ),
      );
      await assertEvidenceSurvivesCleanup(fixture, [ref], 'artifact-negative/fr2-artifact-corrupt.json', outsideBefore);
    });
  });
});

/** 证据先行落盘 + 业务清理后仍可读 + 根外哨兵不变的统一收尾断言。 */
async function assertEvidenceSurvivesCleanup(
  fixture: P01AcceptanceFixture,
  refs: readonly P01EvidenceRef[],
  expectedRelativePath: string,
  outsideBefore: string,
): Promise<void> {
  expect(refs.length).toBeGreaterThan(0);
  for (const ref of refs) {
    expect(ref.relativePath).toBe(expectedRelativePath);
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(join(fixture.reportDir, ref.relativePath))).toBe(true);
  }
  fixture.cleanup();
  expect(fixture.cleaned).toBe(true);
  expect(existsSync(fixture.dataRoot)).toBe(false);
  const parsed = JSON.parse(
    readFileSync(join(fixture.reportDir, expectedRelativePath), 'utf-8'),
  ) as Record<string, unknown>;
  expect(String(parsed.checkId)).toMatch(/^P01-FR2-ARTIFACT-/);
  expect(parsed.status).toBe('pass');
  // 证据不含受测仓库/Harness 个人目录作为运行依赖。
  expect(readFileSync(join(fixture.reportDir, expectedRelativePath), 'utf-8')).not.toContain(
    REPO_ROOT,
  );
  expect(fixture.snapshotOutsideSentinel()).toBe(outsideBefore);
}

describe('F-005 发布中断核对与保守恢复（P01-FR2-ARTIFACT-RECOVERY）', () => {
  it('受控子进程三检查点中断后重开核对：no_content/staging_only 保持不可用（残留保留），pending+正式文件仅 hash/size 核验后补 ready，孤儿 kept_in_place，重复核对幂等', async () => {
    await withP01AcceptanceFixture(async (fixture) => {
      const repoBefore = fixture.snapshotSourceRepo();
      const outsideBefore = fixture.snapshotOutsideSentinel();

      // 父进程建项目后关闭全部连接；子进程独立连接同一真实库与文件根。
      const setupApp = await fixture.openApplication();
      const registration = await setupApp.projectService.registerRepository({
        repositoryPath: fixture.repoDir,
        displayName: fixture.businessInput.project.displayName,
        description: fixture.businessInput.project.description,
        labels: [...fixture.businessInput.project.labels],
      });
      expect(registration.status).toBe('registered');
      const projectId = registration.project.id;
      setupApp.close();

      // 真实受控子进程：三个确定性检查点中断（真实 SQLite + 真实文件根）。
      const childRuns: Array<{
        checkpoint: InterruptCheckpoint;
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        result: ChildResult;
      }> = [];
      for (const checkpoint of ['registered', 'staged', 'published'] as const) {
        const run = await runInterruptedChild({
          dbPath: join(fixture.dataRoot, DATABASE_FILE_NAME),
          dataRoot: fixture.dataRoot,
          projectId,
          kind: 'verification-report',
          mediaType: 'application/json',
          expectedHash: fixture.artifactSha256,
          locator: `reports/p01-4-interrupt-${checkpoint}.json`,
          contentBase64: fixture.artifactBytes.toString('base64'),
          checkpoint,
          resultFile: join(fixture.root, `p01-4-child-result-${checkpoint}.json`),
        });
        expect(run.exitCode).toBe(CHECKPOINT_EXIT[checkpoint]);
        expect(run.signal, run.stderr).toBeNull();
        expect(run.result.artifactId).toMatch(/^[0-9a-f-]{36}$/);
        childRuns.push({ checkpoint, exitCode: run.exitCode, signal: run.signal, result: run.result });
      }

      // 进程退出后以**新的装配实例**重开同一数据根核对（不依赖子进程内存）。
      const reopened = await fixture.openApplication();
      expect(reopened).not.toBe(setupApp);
      const verifier = makeVerifier(reopened);
      const byCheckpoint = new Map(childRuns.map((run) => [run.checkpoint, run.result]));

      // checkpoint=registered：pending 无任何正文 → interrupted/no_content，不可用。
      const registeredResult = byCheckpoint.get('registered')!;
      const registeredReport = await verifier.verifyArtifact(
        projectId,
        registeredResult.artifactId,
      );
      expect(registeredReport.kind).toBe('interrupted');
      expect(registeredReport.interruption?.reason).toBe('no_content');
      expect(registeredReport.status).toBe('pending');
      expect(registeredReport.revision).toBe(1);
      expect(registeredReport.stagingResidues).toEqual([]);
      const registeredRefError = await captureError(() =>
        reopened.artifactStore.getArtifactInputRef(projectId, registeredResult.artifactId),
      );
      expect(isStorageError(registeredRefError, 'conflict')).toBe(true);

      // checkpoint=staged：仅 staging 残留 → interrupted/staging_only，残留保留原位。
      const stagedResult = byCheckpoint.get('staged')!;
      const stagedReport = await verifier.verifyArtifact(projectId, stagedResult.artifactId);
      expect(stagedReport.kind).toBe('interrupted');
      expect(stagedReport.interruption?.reason).toBe('staging_only');
      expect(stagedReport.status).toBe('pending');
      expect(stagedReport.revision).toBe(1);
      expect(stagedResult.stagingRelativePath).toBeDefined();
      expect(stagedReport.stagingResidues.map((entry) => entry.relativePath)).toEqual([
        stagedResult.stagingRelativePath,
      ]);
      expect(
        existsSync(join(fixture.dataRoot, ...stagedResult.stagingRelativePath!.split('/'))),
      ).toBe(true);
      const stagedRefError = await captureError(() =>
        reopened.artifactStore.getArtifactInputRef(projectId, stagedResult.artifactId),
      );
      expect(isStorageError(stagedRefError, 'conflict')).toBe(true);

      // checkpoint=published：正式文件已落盘但 pending → 只有验证 hash/size 后
      // 才经 CAS 补 ready；随后可读、可取有效输入引用。
      const publishedResult = byCheckpoint.get('published')!;
      const publishedReport = await verifier.verifyArtifact(
        projectId,
        publishedResult.artifactId,
      );
      expect(publishedReport.kind).toBe('recovered_ready');
      expect(publishedReport.status).toBe('ready');
      expect(publishedReport.revision).toBe(2);
      expect(publishedReport.contentHash).toBe(fixture.artifactSha256);
      expect(publishedResult.finalRelativePath).toBe(
        deriveArtifactFinalRelativePath({
          projectId,
          artifactId: publishedResult.artifactId,
          locator: `reports/p01-4-interrupt-published.json`,
        }),
      );
      const recoveredRef = await reopened.artifactStore.getArtifactInputRef(
        projectId,
        publishedResult.artifactId,
      );
      expect(recoveredRef.contentHash).toBe(fixture.artifactSha256);
      expect(recoveredRef.sizeBytes).toBe(fixture.artifactBytes.length);
      const recoveredRead = await verifier.readVerifiedContent(
        projectId,
        publishedResult.artifactId,
      );
      expect(Buffer.from(recoveredRead.content)).toEqual(fixture.artifactBytes);

      // 核对重复运行：verified_ready 幂等，不新增重复索引、不覆盖已核验正文。
      const finalAbs = join(
        fixture.dataRoot,
        ...publishedResult.finalRelativePath!.split('/'),
      );
      const bytesBeforeRepeat = readFileSync(finalAbs);
      const mtimeBeforeRepeat = statSync(finalAbs).mtimeMs;
      const repeatReport = await verifier.verifyArtifact(projectId, publishedResult.artifactId);
      expect(repeatReport.kind).toBe('verified_ready');
      expect(repeatReport.status).toBe('ready');
      expect(repeatReport.revision).toBe(2);
      expect(repeatReport.contentHash).toBe(fixture.artifactSha256);
      expect(readFileSync(finalAbs)).toEqual(bytesBeforeRepeat);
      expect(statSync(finalAbs).mtimeMs).toBe(mtimeBeforeRepeat);
      const listedOnce = await reopened.artifactStore.listArtifacts(projectId, { limit: 256 });
      expect(listedOnce.records).toHaveLength(3);

      // 无索引 staging 孤儿：经文件端口写入（不建索引行），verifyProject 生成
      // 证据并 kept_in_place——不立即删除、不创建索引、不跨项目绑定。
      const orphanId = 'orphan-staging-0001';
      const orphanWrite = await reopened.artifactFileStore.openStagingWrite({
        projectId,
        artifactId: orphanId,
        locator: 'reports/p01-4-orphan.json',
      });
      orphanWrite.stream.write(Buffer.from('无索引孤儿残留字节\n', 'utf-8'));
      orphanWrite.stream.end();
      const orphanStaged = await reopened.artifactFileStore.finishStaging(orphanWrite);

      const projectReport = await verifier.verifyProject(projectId);
      expect(JSON.stringify(projectReport).includes(fixture.dataRoot)).toBe(false);
      expect(projectReport.truncated).toBe(false);
      expect(projectReport.orphanPolicy).toBe('kept_in_place');
      expect(projectReport.artifactReports).toHaveLength(3);
      const orphanEvidence = projectReport.orphans.find(
        (entry) => entry.candidateArtifactId === orphanId,
      );
      expect(orphanEvidence?.area).toBe('staging');
      expect(orphanEvidence?.reason).toBe('staging_without_index');
      expect(orphanEvidence?.relativePath).toBe(orphanStaged.relativePath);
      // 孤儿文件保留原位（核对后立即存在），索引行数不变。
      expect(existsSync(join(fixture.dataRoot, ...orphanStaged.relativePath.split('/')))).toBe(
        true,
      );
      const listedAfterProjectVerify = await reopened.artifactStore.listArtifacts(projectId, {
        limit: 256,
      });
      expect(listedAfterProjectVerify.records).toHaveLength(3);
      // 重复项目核对：孤儿证据一致，不产生重复索引。
      const projectReportAgain = await verifier.verifyProject(projectId);
      expect(projectReportAgain.orphans.map((entry) => entry.relativePath).sort()).toEqual(
        projectReport.orphans.map((entry) => entry.relativePath).sort(),
      );
      expect(
        (await reopened.artifactStore.listArtifacts(projectId, { limit: 256 })).records,
      ).toHaveLength(3);

      // 源仓库与根外哨兵不变。
      expect(fixture.snapshotSourceRepo()).toEqual(repoBefore);
      expect(fixture.snapshotOutsideSentinel()).toBe(outsideBefore);

      // 清理前的脱敏索引与文件摘要（只含逻辑相对位置与摘要，无绝对路径）。
      const indexDigest = sha256Hex(canonicalJson(listedAfterProjectVerify.records));
      const fileDigests: Record<string, string> = {
        [publishedResult.finalRelativePath!]: sha256Hex(readFileSync(finalAbs)),
        [stagedResult.stagingRelativePath!]: sha256Hex(
          readFileSync(join(fixture.dataRoot, ...stagedResult.stagingRelativePath!.split('/'))),
        ),
        [orphanStaged.relativePath]: sha256Hex(
          readFileSync(join(fixture.dataRoot, ...orphanStaged.relativePath.split('/'))),
        ),
      };

      const ref = fixture.writeEvidence(
        'artifact-negative/fr2-artifact-recovery.json',
        JSON.stringify(
          {
            checkId: 'P01-FR2-ARTIFACT-RECOVERY',
            status: 'pass',
            child_runs: childRuns.map((run) => ({
              checkpoint: run.checkpoint,
              exit_code: run.exitCode,
              signal: run.signal,
              artifact_id: run.result.artifactId,
            })),
            outcomes: {
              registered: {
                verify_kind: registeredReport.kind,
                interruption_reason: registeredReport.interruption?.reason ?? null,
                status: registeredReport.status,
                usable_ref_rejected: true,
              },
              staged: {
                verify_kind: stagedReport.kind,
                interruption_reason: stagedReport.interruption?.reason ?? null,
                status: stagedReport.status,
                staging_residue_relative_path: stagedResult.stagingRelativePath ?? null,
                residue_kept_in_place: true,
                usable_ref_rejected: true,
              },
              published: {
                verify_kind: publishedReport.kind,
                status: publishedReport.status,
                revision: publishedReport.revision,
                content_hash: publishedReport.contentHash,
                size_bytes: fixture.artifactBytes.length,
                recovered_after_hash_size_verified: true,
                repeat_verify_kind: repeatReport.kind,
                repeat_verify_idempotent: true,
                verified_content_not_overwritten: true,
              },
            },
            orphans: {
              policy: projectReport.orphanPolicy,
              entries: projectReport.orphans.map((entry) => ({
                area: entry.area,
                relative_path: entry.relativePath,
                reason: entry.reason,
                candidate_artifact_id: entry.candidateArtifactId,
              })),
              kept_in_place: true,
              repeat_project_verify_same_orphans: true,
            },
            index: {
              artifact_count: listedAfterProjectVerify.records.length,
              no_duplicate_index_after_repeat: true,
              digest_sha256: indexDigest,
            },
            file_digests_sha256: fileDigests,
            source_repo_unchanged: canonicalJson(fixture.snapshotSourceRepo()) === canonicalJson(repoBefore),
            outside_sentinel_sha256: outsideBefore,
            tools: fixture.tools,
          },
          null,
          2,
        ),
      );
      await assertEvidenceSurvivesCleanup(
        fixture,
        [ref],
        'artifact-negative/fr2-artifact-recovery.json',
        outsideBefore,
      );
    });
  }, 120_000);

  it('路径穿越与符号链接拒绝：零副作用、不跟随链接，根外哨兵不变；核对重复运行不覆盖已核验正文', async () => {
    await withP01AcceptanceFixture(async (fixture) => {
      const outsideBefore = fixture.snapshotOutsideSentinel();
      const app = await fixture.openApplication();
      const registration = await app.projectService.registerRepository({
        repositoryPath: fixture.repoDir,
        displayName: fixture.businessInput.project.displayName,
        description: fixture.businessInput.project.description,
        labels: [...fixture.businessInput.project.labels],
      });
      const projectId = registration.project.id;
      const publisher = makePublisher(app);
      const verifier = makeVerifier(app);

      // 路径穿越/绝对路径/空段 locator 一律校验拒绝，且零副作用（无索引行、
      // 数据根不出现越界文件）。
      const dataRootEntriesBefore = readdirSync(app.dataRoot).sort();
      const badLocators = ['../escape-outside.txt', '/absolute/path.txt', 'a//b.txt', 'a/./b.txt'];
      for (const locator of badLocators) {
        const error = await captureError(() =>
          publisher.publishArtifact({
            projectId,
            kind: 'verification-report',
            mediaType: 'application/json',
            expectedHash: fixture.artifactSha256,
            locator,
            version: 1,
            content: [new Uint8Array(fixture.artifactBytes)],
          }),
        );
        expect(isStorageError(error, 'validation')).toBe(true);
      }
      expect(
        (await app.artifactStore.listArtifacts(projectId, { limit: 256 })).records,
      ).toHaveLength(0);
      expect(existsSync(join(app.dataRoot, 'escape-outside.txt'))).toBe(false);
      expect(readdirSync(app.dataRoot).sort()).toEqual(dataRootEntriesBefore);

      // 符号链接拒绝回归：ready 目标叶被替换为指向根外哨兵的链接时，
      // stat/读取/核对均不跟随，哨兵逐字节不变。
      const symlinkRecord = await app.artifactStore.registerArtifact({
        projectId,
        kind: 'verification-report',
        mediaType: 'application/json',
        expectedHash: fixture.artifactSha256,
        locator: 'reports/p01-4-symlink-leaf.json',
        version: 1,
      });
      const symlinkKey = {
        projectId,
        artifactId: symlinkRecord.id,
        locator: symlinkRecord.locator,
      };
      const symlinkFinalRel = deriveArtifactFinalRelativePath(symlinkKey);
      const symlinkFinalAbs = join(app.dataRoot, ...symlinkFinalRel.split('/'));
      mkdirSync(dirname(symlinkFinalAbs), { recursive: true });
      symlinkSync(fixture.outsideSentinelPath, symlinkFinalAbs, 'file');

      const statError = await captureError(() => app.artifactFileStore.statFinal(symlinkKey));
      expect(isArtifactFileError(statError, 'escape')).toBe(true);
      expectNoAbsolutePathLeak(statError, app.dataRoot);
      const openError = await captureError(() => app.artifactFileStore.openFinalRead(symlinkKey));
      expect(isArtifactFileError(openError, 'escape')).toBe(true);
      const symlinkReport = await verifier.verifyArtifact(projectId, symlinkRecord.id);
      expect(symlinkReport.kind).toBe('untrusted_file');
      expect(symlinkReport.status).toBe('pending');
      expect(symlinkReport.untrustedDetail).toContain('escape');
      // 索引不被核对改写；根外哨兵未被读取/修改（不跟随链接）。
      expect(await app.artifactStore.getArtifact(projectId, symlinkRecord.id)).toEqual(
        symlinkRecord,
      );
      expect(fixture.snapshotOutsideSentinel()).toBe(outsideBefore);

      // 正常制品：发布→核对→重复核对，索引行数不变、已核验正文不被覆盖。
      const good = await publisher.publishArtifact({
        projectId,
        kind: 'verification-report',
        mediaType: 'application/json',
        expectedHash: fixture.artifactSha256,
        locator: 'reports/p01-4-guardrail-good.json',
        version: 1,
        content: [new Uint8Array(fixture.artifactBytes)],
      });
      const goodAbs = join(app.dataRoot, ...good.finalRelativePath.split('/'));
      const goodBytesBefore = readFileSync(goodAbs);
      const goodMtimeBefore = statSync(goodAbs).mtimeMs;
      const first = await verifier.verifyArtifact(projectId, good.artifact.id);
      const second = await verifier.verifyArtifact(projectId, good.artifact.id);
      expect(first.kind).toBe('verified_ready');
      expect(second.kind).toBe('verified_ready');
      expect(second.revision).toBe(good.artifact.revision);
      expect(readFileSync(goodAbs)).toEqual(goodBytesBefore);
      expect(statSync(goodAbs).mtimeMs).toBe(goodMtimeBefore);
      expect(
        (await app.artifactStore.listArtifacts(projectId, { limit: 256 })).records,
      ).toHaveLength(2);

      const ref = fixture.writeEvidence(
        'artifact-negative/fr2-artifact-guardrails.json',
        JSON.stringify(
          {
            checkId: 'P01-FR2-ARTIFACT-RECOVERY',
            status: 'pass',
            scope: 'repeat_idempotence + path_traversal_reject + symlink_reject',
            path_traversal: {
              rejected_locators: badLocators,
              error_kind: 'validation',
              zero_side_effects: true,
              data_root_entries_unchanged: true,
            },
            symlink: {
              artifact_id: symlinkRecord.id,
              stat_rejected: 'escape',
              read_rejected: 'escape',
              verify_kind: symlinkReport.kind,
              index_unchanged: true,
              outside_sentinel_sha256: outsideBefore,
              sentinel_not_followed_or_modified: true,
            },
            repeat_verify: {
              artifact_id: good.artifact.id,
              first_kind: first.kind,
              second_kind: second.kind,
              content_not_overwritten: true,
              no_duplicate_index: true,
            },
            tools: fixture.tools,
          },
          null,
          2,
        ),
      );
      await assertEvidenceSurvivesCleanup(
        fixture,
        [ref],
        'artifact-negative/fr2-artifact-guardrails.json',
        outsideBefore,
      );
    });
  });
});
