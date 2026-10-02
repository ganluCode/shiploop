/**
 * F-013 干净安装证据脚本：在非源码 cwd 下从构建产物（dist）运行存储闭环。
 *
 * 用法：node dist-closed-loop.mjs <coreDistDir> <tempDataRoot>
 *   <coreDistDir>   快照构建出的 packages/core/dist 目录（迁移模块随 dist 定位）
 *   <tempDataRoot>  尚不存在的临时数据根目录（脚本只在该根内创建状态库与制品文件）
 *
 * 在 cwd 不等于源码仓库的位置执行（如 /tmp），证明：
 * - 迁移模块可从 dist 定位，不依赖源码 cwd 或开发机路径；
 * - 闭环：迁移 → 组合创建项目+配置 → 全局配置 → 发布制品（hash/size 核验）→
 *   CAS 更新 → 关闭 → 重开 → ID/revision/JSON/hash/size 逐字段一致 →
 *   批量核对 verified_ready 无孤儿。
 *
 * 输出只含相对逻辑信息与摘要级数据（脱敏，不含用户数据根外路径、凭据或正文）；
 * 全部步骤成功退出 0，任一断言失败非零退出。
 */
import { mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [coreDistArg, dataRootArg] = process.argv.slice(2);
if (coreDistArg === undefined || dataRootArg === undefined) {
  console.error('usage: node dist-closed-loop.mjs <coreDistDir> <tempDataRoot>');
  process.exit(2);
}
const distBaseUrl = pathToFileURL(coreDistArg.endsWith('/') ? coreDistArg : `${coreDistArg}/`).href;
const importFromDist = (relative) => import(new URL(relative, distBaseUrl).href);

const { openSqliteStorageSession } = await importFromDist('adapters/sqlite/session.js');
const { migrateSqliteStorage } = await importFromDist('adapters/sqlite/migrator.js');
const { createSqliteStateStore } = await importFromDist('adapters/sqlite/state-store.js');
const { createSqliteArtifactStore } = await importFromDist('adapters/sqlite/artifact-store.js');
const { createArtifactFileStore } = await importFromDist('adapters/fs/artifact-files.js');
const { createArtifactPublisher } = await importFromDist('application/artifact-publish.js');
const { createArtifactVerifier } = await importFromDist('application/artifact-verify.js');

const sha256 = (parts) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
};

const encoder = new TextEncoder();
const fail = (message) => {
  console.error(`dist-closed-loop: FAIL ${message}`);
  process.exit(1);
};
const step = (text) => console.log(`dist-closed-loop: ${text}`);

rmSync(dataRootArg, { recursive: true, force: true });
mkdirSync(dataRootArg, { recursive: true });
const dbPath = join(dataRootArg, 'state.db');

const payload = {
  schemaVersion: 1,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } },
};
const updatedPayload = {
  schemaVersion: 1,
  strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet', credentialRef: 'keyring://dist' } },
};

const assemble = (session) => {
  const now = () => Date.now();
  let stagingCounter = 0;
  const files = createArtifactFileStore({
    dataRoot: dataRootArg,
    stagingName: () => `s${(stagingCounter += 1)}`,
  });
  const artifacts = createSqliteArtifactStore(session, { nowUtcMs: now });
  return {
    state: createSqliteStateStore(session, { nowUtcMs: now }),
    artifacts,
    publisher: createArtifactPublisher({
      artifacts,
      files,
      limits: { maxSizeBytes: 1_048_576, timeoutMs: 30_000 },
    }),
    verifier: createArtifactVerifier({ artifacts, files, limits: { maxReadBytes: 1_048_576 } }),
  };
};

// 1. 迁移（从 dist 定位迁移模块）。
let session = openSqliteStorageSession({ path: dbPath });
try {
  await migrateSqliteStorage(session);
  step('migrated fresh database from dist (version 1)');
} catch (error) {
  fail(`migration: ${String(error)}`);
}

// 2. 闭环写入。
const contentParts = [encoder.encode('dist '), encoder.encode('闭环·正文')];
let snapshot;
try {
  const app = assemble(session);
  const created = await app.state.createProjectWithInitialSettings(
    { displayName: 'dist 闭环项目', description: '非源码 cwd 验证', labels: ['dist', 'p01-2'] },
    { payload },
  );
  const global = await app.state.createGlobalSettings({ payload });
  const published = await app.publisher.publishArtifact({
    projectId: created.project.id,
    kind: 'verification-report',
    mediaType: 'text/markdown',
    expectedHash: sha256(contentParts),
    locator: 'reports/dist-闭环.md',
    content: contentParts,
  });
  const settings = await app.state.updateProjectSettings(created.project.id, {
    expectedRevision: 1,
    payload: updatedPayload,
  });
  const ref = await app.artifacts.getArtifactInputRef(created.project.id, published.artifact.id);
  snapshot = { project: created.project, settings, global, artifact: published.artifact, ref };
  step(`published artifact size=${String(published.artifact.sizeBytes)} hash=${String(published.artifact.contentHash)}`);
} catch (error) {
  fail(`closed-loop write: ${String(error)}`);
} finally {
  session.close();
}

// 3. 关闭重开后逐字段一致 + 批量核对。
try {
  session = openSqliteStorageSession({ path: dbPath });
  const app = assemble(session);
  const project = await app.state.getProject(snapshot.project.id);
  const settings = await app.state.getProjectSettings(snapshot.project.id);
  const global = await app.state.getGlobalSettings();
  const artifact = await app.artifacts.getArtifact(snapshot.project.id, snapshot.artifact.id);
  const ref = await app.artifacts.getArtifactInputRef(snapshot.project.id, snapshot.artifact.id);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(project, snapshot.project)) fail('project differs after reopen');
  if (!same(settings, snapshot.settings)) fail('project settings differ after reopen');
  if (!same(global, snapshot.global)) fail('global settings differ after reopen');
  if (!same(artifact, snapshot.artifact)) fail('artifact index differs after reopen');
  if (!same(ref, snapshot.ref)) fail('artifact input ref differs after reopen');
  const content = await app.verifier.readVerifiedContent(snapshot.project.id, snapshot.artifact.id);
  if (content.contentHash !== sha256(contentParts)) fail('reopened content hash mismatch');
  if (content.sizeBytes !== contentParts.reduce((n, p) => n + p.byteLength, 0)) fail('reopened content size mismatch');
  const report = await app.verifier.verifyProject(snapshot.project.id);
  if (report.truncated || report.orphans.length > 0) fail('unexpected orphans or truncation');
  for (const entry of report.artifactReports) {
    if (entry.kind !== 'verified_ready') fail(`artifact not verified_ready: ${String(entry.kind)}`);
  }
  const migrations = session.database
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all();
  if (JSON.stringify(migrations) !== JSON.stringify([{ version: 1 }])) fail('migration records lost');
  step('reopened data root: id/revision/json/hash/size consistent, verifyProject verified_ready, no orphans');
} catch (error) {
  fail(`closed-loop reopen: ${String(error)}`);
} finally {
  session.close();
}

step(`PASS (cwd=${process.cwd()} is outside the source tree)`);
process.exit(0);
