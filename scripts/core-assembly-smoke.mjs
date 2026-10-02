/**
 * F-012 构建产物冒烟子进程：在 **非源码 cwd**（如临时沙箱）下从编译产物加载
 * `shiploop-core` 的受控装配入口（`./assembly` 子路径 → dist/adapters/composition.js），
 * 并用真实临时 Git 仓库与临时数据根跑一段与 `examples/p01-3-standalone.ts` 同构的
 * 调用序列：
 *
 *   打开 Core 应用（迁移随装配执行）→ 注册项目 → 创建全局/项目当前配置 →
 *   读取有效配置 → 受权定位项目目录 → 发布固定正文制品并核验读取 → 关闭 →
 *   重开核验项目/配置/制品逐字段一致并再次核验正文 → 关闭。
 *
 * 只使用 dist 产物（不 import 任何源码 .ts）、只接收绝对路径参数；不访问真实用户
 * 目录/凭据/网络，只读 Git 元数据。任一断言失败非零退出；成功输出一行脱敏摘要。
 *
 * 用法：node core-assembly-smoke.mjs <assemblyEntry.js> <rootEntry.js> <sandboxDir>
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [assemblyEntryArg, rootEntryArg, sandboxArg] = process.argv.slice(2);
if (assemblyEntryArg === undefined || rootEntryArg === undefined || sandboxArg === undefined) {
  process.stderr.write(
    'core-assembly-smoke: usage: node core-assembly-smoke.mjs <assemblyEntry.js> <rootEntry.js> <sandboxDir>\n',
  );
  process.exit(2);
}

const fail = (message) => {
  process.stderr.write(`core-assembly-smoke: FAIL ${message}\n`);
  process.exit(1);
};

const importByPath = (absolutePath) => import(pathToFileURL(absolutePath).href);

const dataRoot = join(sandboxArg, 'data');
const repoPath = join(sandboxArg, 'repo');
mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
mkdirSync(repoPath, { recursive: true });

// 最小确定的 git 环境：隔离机器级配置，不读真实用户 git 配置。
const gitEnv = {
  PATH: process.env.PATH ?? '',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
};
const git = (args, cwd) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', timeout: 30_000 });

try {
  git(['init', '--initial-branch=main', repoPath], sandboxArg);
  writeFileSync(join(repoPath, 'README.md'), '# core assembly smoke\n', 'utf-8');
  git(['add', '-A'], repoPath);
  git(
    [
      '-c',
      'user.name=ShipLoop Smoke',
      '-c',
      'user.email=shiploop-smoke@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'init',
    ],
    repoPath,
  );
} catch (error) {
  fail(`git fixture: ${error instanceof Error ? error.message : String(error)}`);
}

let assembly;
let core;
try {
  assembly = await importByPath(assemblyEntryArg);
  core = await importByPath(rootEntryArg);
} catch (error) {
  fail(`loading built entries: ${error instanceof Error ? error.message : String(error)}`);
}
if (typeof assembly.openCoreApplication !== 'function') {
  fail('assembly entry does not export openCoreApplication');
}
if (typeof core.createStaticRuntimeCapabilityCatalog !== 'function') {
  fail('root entry does not export createStaticRuntimeCapabilityCatalog');
}
if (typeof core.createArtifactPublisher !== 'function') {
  fail('root entry does not export createArtifactPublisher');
}
if (typeof core.createArtifactVerifier !== 'function') {
  fail('root entry does not export createArtifactVerifier');
}

const artifactBytes = new TextEncoder().encode('ShipLoop core assembly smoke artifact \u6b63\u6587 \ud83d\udce6\n');
const artifactHash = createHash('sha256').update(artifactBytes).digest('hex');

const capabilityCatalog = core.createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }] },
]);

let projectId;
let artifactId;
let artifactRelativePath;
try {
  const app = await assembly.openCoreApplication({ dataRoot, capabilityCatalog });
  try {
    const registration = await app.projectService.registerRepository({
      repositoryPath: repoPath,
      displayName: 'Assembly Smoke',
      labels: ['Smoke', ' smoke '],
    });
    projectId = registration.project.id;
    await app.configurationService.createSettings(
      { kind: 'global' },
      {
        payload: {
          schemaVersion: 2,
          strategies: {
            defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' },
          },
        },
      },
    );
    await app.configurationService.createSettings(
      { kind: 'project', projectId },
      { payload: { schemaVersion: 2 } },
    );
    const effective = await app.configurationService.getEffectiveSettings(projectId);
    const located = await app.pathService.locateProjectResource(
      { projectId },
      { type: 'project_directory', projectId },
    );
    if (effective.configured !== true) {
      fail('effective settings must be configured after project/global write');
    }
    if (located.resourceType !== 'project_directory') {
      fail('authorized path resolution must return project_directory');
    }

    const publisher = core.createArtifactPublisher({
      artifacts: app.artifactStore,
      files: app.artifactFileStore,
      limits: { maxSizeBytes: 1_048_576, timeoutMs: 30_000 },
    });
    const published = await publisher.publishArtifact({
      projectId,
      kind: 'smoke_report',
      mediaType: 'text/plain; charset=utf-8',
      expectedHash: artifactHash,
      locator: 'smoke/assembly-artifact.txt',
      version: 1,
      content: [artifactBytes],
    });
    artifactId = published.artifact.id;
    artifactRelativePath = published.finalRelativePath;
    if (published.artifact.status !== 'ready' || published.artifact.contentHash !== artifactHash) {
      fail('published artifact is not ready with the verified content hash');
    }

    const verifier = core.createArtifactVerifier({
      artifacts: app.artifactStore,
      files: app.artifactFileStore,
      limits: { maxReadBytes: 1_048_576 },
    });
    const verified = await verifier.readVerifiedContent(projectId, artifactId);
    if (
      Buffer.from(verified.content).toString('utf-8') !==
      Buffer.from(artifactBytes).toString('utf-8')
    ) {
      fail('verified artifact content mismatch before close');
    }
  } finally {
    app.close();
  }
} catch (error) {
  fail(`assembly flow: ${error instanceof Error ? error.message : String(error)}`);
}

try {
  const reopened = await assembly.openCoreApplication({ dataRoot, capabilityCatalog });
  try {
    const project = await reopened.projectService.getProject(projectId);
    const settings = await reopened.configurationService.getCurrentSettings({
      kind: 'project',
      projectId,
    });
    const artifact = await reopened.artifactStore.getArtifact(projectId, artifactId);
    if (project.id !== projectId || settings.revision !== 1) {
      fail('reopened state mismatch');
    }
    if (
      artifact.status !== 'ready' ||
      artifact.contentHash !== artifactHash ||
      artifact.sizeBytes !== artifactBytes.byteLength
    ) {
      fail('reopened artifact index mismatch');
    }
    const verifier = core.createArtifactVerifier({
      artifacts: reopened.artifactStore,
      files: reopened.artifactFileStore,
      limits: { maxReadBytes: 1_048_576 },
    });
    const verified = await verifier.readVerifiedContent(projectId, artifactId);
    if (
      verified.relativePath !== artifactRelativePath ||
      verified.contentHash !== artifactHash ||
      Buffer.from(verified.content).toString('utf-8') !==
        Buffer.from(artifactBytes).toString('utf-8')
    ) {
      fail('verified artifact content mismatch after reopen');
    }
  } finally {
    reopened.close();
  }
} catch (error) {
  fail(`reopen flow: ${error instanceof Error ? error.message : String(error)}`);
}

if (!existsSync(join(dataRoot, 'core.sqlite'))) {
  fail('state database missing under data root');
}

process.stdout.write(
  `core-assembly-smoke: ok project=${projectId} artifact=${artifactId} artifactHash=${artifactHash.slice(0, 12)} dataRootEntries=core.sqlite migrated=true\n`,
);
