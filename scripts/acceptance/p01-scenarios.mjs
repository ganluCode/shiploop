import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const [snapshot, root, mode = 'run', workerId] = process.argv.slice(2);
assert(snapshot && root, 'Usage: node p01-scenarios.mjs <snapshot> <owned-sandbox>');
const core = await import(pathToFileURL(join(snapshot, 'packages/core/dist/index.js')));
const { openCoreApplication } = await import(pathToFileURL(join(snapshot, 'packages/core/dist/adapters/composition.js')));
const catalog = core.createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'acceptance-only', providers: [{ providerId: 'local', models: ['baseline', 'override'] }] },
]);
const strategy = (model) => ({ runtime: 'acceptance-only', provider: 'local', model });
const payload = (model) => ({ schemaVersion: 2, strategies: { defaultStrategy: strategy(model) } });
const open = () => openCoreApplication({ dataRoot: join(root, 'data'), capabilityCatalog: catalog });
const read = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'));
const save = (name, data) => writeFileSync(join(root, name), JSON.stringify(data, null, 2));
const scope = (projectId) => ({ kind: 'project', projectId });
const verifier = (app) => core.createArtifactVerifier({ artifacts: app.artifactStore, files: app.artifactFileStore, limits: { maxReadBytes: 1048576 } });
function git(repo, ...args) {
  const result = spawnSync('git', args, {
    cwd: repo, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim();
}
function fingerprint(repo) {
  return createHash('sha256').update(JSON.stringify({
    head: git(repo, 'rev-parse', 'HEAD'), status: git(repo, 'status', '--porcelain'),
    refs: git(repo, 'show-ref'), files: readdirSync(repo).sort(),
    body: readFileSync(join(repo, 'README.md'), 'utf8'),
  })).digest('hex');
}
async function rejectUnchanged(fn, before, after) {
  await assert.rejects(fn);
  assert.deepEqual(await after(), before, 'Rejected command must not change stored state');
}
function child(nextMode, id = '') {
  return new Promise((resolveChild, reject) => {
    const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), snapshot, root, nextMode, id], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.stdout.on('data', () => {});
    const timer = setTimeout(() => { proc.kill('SIGKILL'); }, 60000);
    proc.on('error', (error) => { clearTimeout(timer); reject(error); });
    proc.on('close', (code) => { clearTimeout(timer); code === 0 ? resolveChild() : reject(new Error(`Child ${nextMode} failed (${code}): ${stderr}`)); });
  });
}

if (mode === 'reopen') {
  const expected = read('expected.json');
  const app = await open();
  try {
    assert.deepEqual(await app.projectService.getProject(expected.project.id), expected.project);
    assert.deepEqual(await app.configurationService.getCurrentSettings(scope(expected.project.id)), expected.settings);
    assert.deepEqual(await app.configurationService.getEffectiveSettings(expected.project.id), expected.effective);
    const content = await verifier(app).readVerifiedContent(expected.project.id, expected.artifact.id);
    assert.equal(Buffer.from(content.content).toString('utf8'), expected.body);
    assert.equal(content.contentHash, expected.artifact.contentHash);
    assert.equal(content.sizeBytes, Buffer.byteLength(expected.body));
    save('reopen.json', { passed: true });
  } finally { app.close(); }
} else if (mode === 'race') {
  const expected = read('expected.json');
  const app = await open();
  try {
    save(`ready-${workerId}.json`, { ready: true });
    const deadline = Date.now() + 10000;
    while (!existsSync(join(root, 'race-go'))) {
      assert(Date.now() < deadline, 'CAS barrier timeout');
      await sleep(10);
    }
    try {
      await app.configurationService.updateSettings(scope(expected.project.id), {
        expectedRevision: expected.settings.revision, payload: payload('baseline'),
      });
      save(`race-${workerId}.json`, { status: 'winner' });
    } catch (error) {
      assert.equal(error.kind, 'conflict');
      save(`race-${workerId}.json`, { status: 'conflict' });
    }
  } finally { app.close(); }
} else {
  assert.equal(mode, 'run');
  mkdirSync(root, { recursive: true });
  const checks = [];
  let app;
  async function check(id, title, fn) {
    await fn();
    checks.push({ id, title, status: 'pass' });
    save('checks.json', checks);
    console.log(`PASS ${id}: ${title}`);
  }
  const repo = join(root, '源码 仓库');
  const repo2 = join(root, '第二仓库');
  for (const dir of [repo, repo2]) {
    mkdirSync(dir);
    git(dir, 'init', '-b', 'main');
    writeFileSync(join(dir, 'README.md'), 'acceptance fixture\n');
    git(dir, 'add', '.');
    git(dir, '-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture');
  }
  const original = fingerprint(repo);
  let project, second, settings, published;
  const body = 'P01 集成验收：持久化、重开与项目隔离。\n';
  try {
    app = await open();
    await check('I01', '真实 Git 注册与规范路径幂等', async () => {
      const first = await app.projectService.registerRepository({ repositoryPath: repo, displayName: '验收项目', labels: ['Alpha', ' alpha ', '中文'] });
      project = first.project;
      const again = await app.projectService.registerRepository({ repositoryPath: repo, displayName: '不应覆盖', labels: ['changed'] });
      assert.equal(again.status, 'already_exists');
      assert.deepEqual(again.project, project);
      assert.equal(first.binding.canonicalPath, realpathSync(repo));
      second = (await app.projectService.registerRepository({ repositoryPath: repo2, displayName: '第二项目', labels: ['beta'] })).project;
      assert.notEqual(project.id, second.id);
    });
    await check('I02', '全局配置与项目覆盖整体替换及来源', async () => {
      await app.configurationService.createSettings({ kind: 'global' }, { payload: payload('baseline') });
      settings = await app.configurationService.createSettings(scope(project.id), { payload: payload('override') });
      const effective = await app.configurationService.getEffectiveSettings(project.id);
      assert.equal(effective.strategies.defaultStrategy.strategy.model, 'override');
      assert.equal(effective.strategies.defaultStrategy.source.kind, 'project_default');
      assert.equal(core.assessSettingsConfiguration(payload('override')).executable, false);
    });
    await check('I03', '非法配置拒绝且持久值不变', async () => {
      const before = await app.configurationService.getCurrentSettings(scope(project.id));
      await rejectUnchanged(() => app.configurationService.updateSettings(scope(project.id), {
        expectedRevision: settings.revision,
        payload: { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'unknown', provider: 'local', model: 'baseline' } } },
      }), before, () => app.configurationService.getCurrentSettings(scope(project.id)));
    });
    await check('I04', '制品真实发布与 SHA-256/UTF-8 核验', async () => {
      const publisher = core.createArtifactPublisher({ artifacts: app.artifactStore, files: app.artifactFileStore, limits: { maxSizeBytes: 1048576, timeoutMs: 10000 } });
      published = await publisher.publishArtifact({ projectId: project.id, kind: 'acceptance', mediaType: 'text/plain', locator: 'reports/p01.txt', expectedHash: createHash('sha256').update(body).digest('hex'), content: [Buffer.from(body)] });
      assert.equal(published.artifact.status, 'ready');
      assert.equal(Buffer.from((await verifier(app).readVerifiedContent(project.id, published.artifact.id)).content).toString('utf8'), body);
      save('expected.json', { project, settings: await app.configurationService.getCurrentSettings(scope(project.id)), effective: await app.configurationService.getEffectiveSettings(project.id), artifact: published.artifact, body });
    });
    app.close(); app = undefined;
    await check('I05', '全新 Node 进程重开后逐字段一致', async () => { await child('reopen'); assert.equal(read('reopen.json').passed, true); });
    await check('I06', '两个独立进程配置 CAS 恰一个胜者', async () => {
      const workers = [child('race', 'a'), child('race', 'b')];
      const completion = Promise.allSettled(workers);
      const deadline = Date.now() + 10000;
      while (!existsSync(join(root, 'ready-a.json')) || !existsSync(join(root, 'ready-b.json'))) {
        assert(Date.now() < deadline, 'Worker readiness timeout'); await sleep(10);
      }
      writeFileSync(join(root, 'race-go'), 'go');
      const results = await completion;
      for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.message);
      assert.deepEqual([read('race-a.json').status, read('race-b.json').status].sort(), ['conflict', 'winner']);
      app = await open();
      const current = await app.configurationService.getCurrentSettings(scope(project.id));
      assert.equal(current.revision, settings.revision + 1);
      assert.equal(current.payload.strategies.defaultStrategy.model, 'baseline');
    });
    await check('I07', '标签筛选与去重计数', async () => {
      const page = await app.projectService.listProjects({ labels: ['alpha'], match: 'any', limit: 10 });
      assert.deepEqual(page.records.map((p) => p.id), [project.id]);
      const count = (await app.projectService.countProjectLabels()).find((item) => item.label === 'alpha');
      assert.equal(count.projectCount, 1);
    });
    await check('I08', '跨项目制品读取拒绝且原项目仍可读', async () => {
      await assert.rejects(() => verifier(app).readVerifiedContent(second.id, published.artifact.id));
      assert.equal(Buffer.from((await verifier(app).readVerifiedContent(project.id, published.artifact.id)).content).toString('utf8'), body);
    });
    await check('I09', '篡改正文拒绝，恢复字节后重新核验', async () => {
      const file = resolve(app.dataRoot, published.finalRelativePath);
      assert(file.startsWith(realpathSync(root) + '/'));
      writeFileSync(file, 'tampered');
      await assert.rejects(() => verifier(app).readVerifiedContent(project.id, published.artifact.id));
      writeFileSync(file, body);
      assert.equal(Buffer.from((await verifier(app).readVerifiedContent(project.id, published.artifact.id)).content).toString('utf8'), body);
    });
    await check('I10', '正文缺失明确拒绝而非空内容成功', async () => {
      const file = resolve(app.dataRoot, published.finalRelativePath);
      unlinkSync(file);
      await assert.rejects(() => verifier(app).readVerifiedContent(project.id, published.artifact.id));
      writeFileSync(file, body);
      assert.equal(Buffer.from((await verifier(app).readVerifiedContent(project.id, published.artifact.id)).content).toString('utf8'), body);
    });
    await check('I11', '源 Git 仓库文件、HEAD、refs 与状态不变', async () => { assert.equal(fingerprint(repo), original); });
    await check('I12', '审计写入故障导致业务更新整组回滚', async () => {
      const Database = createRequire(join(snapshot, 'packages/core/package.json'))('better-sqlite3');
      const db = new Database(app.pathService.databaseFilePath());
      try {
        const before = await app.projectService.getProject(project.id);
        const eventsBefore = db.prepare('SELECT count(*) AS n FROM state_events').get().n;
        db.exec("CREATE TRIGGER acceptance_fail_audit BEFORE INSERT ON state_events BEGIN SELECT RAISE(ABORT, 'acceptance injected fault'); END");
        try {
          await rejectUnchanged(() => app.projectService.updateProjectMetadata(project.id, {
            expectedRevision: before.revision, displayName: '不得落盘', labels: ['changed'],
          }), before, () => app.projectService.getProject(project.id));
          assert.equal(db.prepare('SELECT count(*) AS n FROM state_events').get().n, eventsBefore);
        } finally { db.exec('DROP TRIGGER acceptance_fail_audit'); }
        app.close(); app = await open();
        assert.deepEqual(await app.projectService.getProject(project.id), before);
      } finally { db.close(); }
    });
  } catch (error) {
    save('failure.json', { message: error.message, stack: error.stack });
    throw error;
  } finally { app?.close(); }
}
