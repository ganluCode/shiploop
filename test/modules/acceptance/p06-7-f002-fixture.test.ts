/**
 * P06-7 / F-002 Todo 存量仓库夹具自测。
 *
 * 覆盖 F-002 五条验收：
 * 1. 真实 Git 仓库/隔离 HOME/数据根/SQLite + 脏文件、未跟踪文件、预置文档、
 *    可复现失败检查、可受限修改的 Todo 文件；
 * 2. 已选择/未选择 Skill/MCP 资源、无凭据本地 stdio Fake server、恶意脚本哨兵、
 *    跨项目第二仓库；
 * 3. 就绪/写入/退出/停止屏障；失败、超时、取消、部分初始化保留可核对事实，
 *    不以 dispose 调用代替停止证明；
 * 4. 重复创建和清理只删除本次持有的临时根；不访问开发仓库、用户 HOME、
 *    真实凭据或远程网络；原始脏文件和已知失败状态可逐项比较；
 * 5. 正常构造、缺工具、失败检查、子进程遗留、清理失败注入、敏感哨兵与
 *    开发机绝对路径不进入普通证据文本。
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  TodoFixturePartialInitError,
  createTodoBrownfieldFixture,
} from '../../../test/helpers/p06-7/index.ts';
import { git } from '../../../test/helpers/git-repo.ts';
import { waitForFakeMcpFile } from '../../../test/helpers/mcp-stdio-fake-server.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const REAL_TMP = realpathSync(tmpdir());
const EXPECTED_DIRTY_STATUS = ['?? NOTES-untracked.md', ' M src/todo.ts', 'M  src/feature.ts'];

function statusLines(porcelain: string): string[] {
  return porcelain.split('\n').filter((line) => line.length > 0).sort();
}

it('[case:p06-f002-todo-repo-dirty-baseline] 正常构造真实 Todo 仓库与脏状态基线', async () => {
  const fixture = createTodoBrownfieldFixture({ prefix: 'shiploop-p06-f002-normal-' });
  try {
    // 沙箱位于系统临时目录，且不在开发仓库或用户 HOME 之内。
    expect(fixture.root.startsWith(`${REAL_TMP}/`)).toBe(true);
    expect(fixture.root.startsWith(REPO_ROOT)).toBe(false);
    expect(fixture.root.startsWith(realpathSync(homedir()))).toBe(false);

    // 隔离 HOME/TMPDIR 与规范数据根 + 真实 SQLite（WAL/FK）。
    expect(realpathSync(fixture.homeDir)).not.toBe(realpathSync(homedir()));
    expect(fixture.dataRoot.startsWith(`${fixture.root}/`)).toBe(true);
    expect(fixture.dataRootIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.sqlite.pragmaSnapshot()).toMatchObject({ foreignKeysEnabled: true, journalMode: 'wal' });
    expect(fixture.sqliteFacts()).toMatchObject({ open: true, recordCount: 1 });

    // 脏状态：已跟踪修改、暂存修改、未跟踪文件；文档与 Todo 文件已提交。
    const status = git(['status', '--porcelain=v1'], fixture.todoRepositoryPath, { home: fixture.homeDir });
    expect(statusLines(status)).toEqual([...EXPECTED_DIRTY_STATUS].sort());
    for (const doc of ['docs/getting-started.md', 'docs/architecture.md']) {
      expect(existsSync(join(fixture.todoRepositoryPath, ...doc.split('/')))).toBe(true);
    }
    const todoFile = readFileSync(join(fixture.todoRepositoryPath, 'todo', 'inbox.txt'), 'utf8');
    expect(todoFile).toContain('TODO-1');

    // 已知失败检查与基线快照。
    const baseline = fixture.dirtyBaseline();
    expect(baseline.head).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline.knownFailure).toEqual({ checkKey: 'todo-check-known-failure', expectedExitCode: 3 });
    expect(baseline.entries.map((entry) => entry.path).sort()).toEqual(
      ['NOTES-untracked.md', 'src/feature.ts', 'src/todo.ts', 'todo/inbox.txt'].sort(),
    );

    // 恶意初始化脚本存在但哨兵未出现（夹具从不执行仓库脚本）。
    expect(existsSync(fixture.maliciousScriptPath)).toBe(true);
    expect(existsSync(fixture.maliciousSentinelPath)).toBe(false);
  } finally {
    await fixture.dispose();
  }
  expect(existsSync(fixture.root)).toBe(false);
});

it('[case:p06-f002-checks-failing-missing-timeout] 失败检查可复现、缺工具留事实、超时有界停止且现场不变', async () => {
  const fixture = createTodoBrownfieldFixture({ prefix: 'shiploop-p06-f002-checks-', stepMs: 100 });
  try {
    // 已知失败检查：确定性退出码 3 + 事实文件写入屏障 + 可复现。
    const first = await fixture.runCheck('failing');
    expect(first).toMatchObject({
      checkKey: 'todo-check-known-failure',
      exitCode: 3,
      timedOut: false,
      stopConfirmed: true,
      spawnErrorCode: undefined,
    });
    expect(first.stderr).toContain('P06-TODO-KNOWN-FAILURE');
    expect(first.factPath).toBeTruthy();
    expect(first.runs).toBe(1);
    const second = await fixture.runCheck('failing');
    expect(second.exitCode).toBe(3);
    expect(second.runs).toBe(2);

    // 通过检查与缺工具检查（ENOENT 留下可核对事实）。
    const ok = await fixture.runCheck('ok');
    expect(ok).toMatchObject({ exitCode: 0, runs: 1 });
    const missing = await fixture.runCheck('missingTool');
    expect(missing.spawnErrorCode).toBe('ENOENT');
    expect(missing.exitCode).not.toBe(0);
    expect(missing.factPath).toBeTruthy();
    expect(missing.runs).toBe(1);

    // 超时：挂起检查经停止升级核验后终止，事实保留。
    const hang = await fixture.runCheck('hang', { timeoutMs: 300 });
    expect(hang).toMatchObject({ timedOut: true, stopConfirmed: true });
    expect(hang.exitCode).toBeNull();
    expect(hang.signal ?? hang.escalated.length > 0).toBeTruthy();

    // 检查运行不改写原始脏现场：逐项比较保持一致。
    expect(fixture.compareDirtyBaseline()).toEqual({ matches: true, differences: [] });
    expect(statusLines(fixture.gitFacts().todoStatusPorcelain)).toEqual([...EXPECTED_DIRTY_STATUS].sort());
    expect(existsSync(fixture.maliciousSentinelPath)).toBe(false);
  } finally {
    await fixture.dispose();
  }
});

it('[case:p06-f002-resources-and-isolation] Skill/MCP 资源差异、本地 Fake server 命令与跨项目第二仓库', async () => {
  const fixture = createTodoBrownfieldFixture({ prefix: 'shiploop-p06-f002-resources-' });
  try {
    const selected = fixture.readResourceManifest('selected');
    expect(selected.schemaVersion).toBe(1);
    expect(selected.resources.map((resource) => `${resource.kind}:${resource.name}`).sort()).toEqual(
      ['mcp:local-fake-tools', 'skill:todo-review'].sort(),
    );
    const unselected = fixture.readResourceManifest('unselected');
    expect(unselected.resources.map((resource) => resource.name).sort()).toEqual(
      ['global-helper', 'global-registry'].sort(),
    );
    for (const manifest of [selected, unselected]) {
      for (const resource of manifest.resources) {
        expect(resource.credentialRef).toBeNull();
      }
    }
    const mcpResource = selected.resources.find((resource) => resource.kind === 'mcp');
    expect(mcpResource).toMatchObject({ transport: 'stdio', required: true });

    // 跨项目第二仓库：真实独立仓库、不同 HEAD、无远程。
    const facts = fixture.gitFacts();
    expect(facts.otherHead).toMatch(/^[0-9a-f]{40}$/);
    expect(facts.otherHead).not.toBe(facts.todoHead);
    expect(facts.todoRemotes).toEqual([]);
    expect(facts.otherRemotes).toEqual([]);
    expect(existsSync(join(fixture.secondRepositoryPath, 'docs', 'other.md'))).toBe(true);

    // 无凭据本地 stdio Fake server 命令：本地可执行 + 无 URL/凭据字段。
    expect(fixture.mcpServerCommand.executable).toBe(process.execPath);
    const configJson = fixture.mcpServerCommand.argv[fixture.mcpServerCommand.argv.length - 1] ?? '';
    expect(configJson).toContain(fixture.mcpServerDir);
    expect(configJson).not.toMatch(/https?:\/\//i);
    expect(configJson.toLowerCase()).not.toContain('token');
  } finally {
    await fixture.dispose();
  }
});

it('[case:p06-f002-process-barriers] Fake server 就绪/写入/退出/停止屏障与受管进程取消', async () => {
  const fixture = createTodoBrownfieldFixture({ prefix: 'shiploop-p06-f002-barriers-', stepMs: 100 });
  try {
    // 就绪屏障：startFakeMcpServer 返回前 ready 文件已出现。
    const server = await fixture.startFakeMcpServer();
    expect(existsSync(server.readyFile)).toBe(true);
    expect(existsSync(server.pidFile)).toBe(true);

    // 写入屏障：initialize / tools.list 标记文件按协议交互出现。
    server.sendRpc('initialize', 1);
    await waitForFakeMcpFile(server.initializeFile, 2_000);
    server.sendRpc('notifications/initialized', null);
    server.sendRpc('tools/list', 2);
    await waitForFakeMcpFile(server.toolsListFile, 2_000);
    expect(server.process.stdout).toContain('"jsonrpc"');

    // 退出屏障：stdin 结束后 exit.json 记录真实退出码；exited 为核验事实。
    server.process.stdin?.end();
    const exitFact = await server.waitExitFact();
    expect(exitFact.code).toBe(0);
    await expect(server.process.exited).resolves.toMatchObject({ code: 0, signal: null });

    // 停止屏障：受管挂起进程被取消（SIGTERM）后记录事实，不以 dispose 代替证明。
    const hanging = fixture.spawnManagedProcess({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      label: 'cancel-child',
    });
    expect(hanging.isAlive()).toBe(true);
    expect(hanging.kill('SIGTERM')).toBe(true);
    await expect(hanging.exited).resolves.toMatchObject({ signal: 'SIGTERM' });
    const processFacts = fixture.processFacts();
    expect(processFacts).toMatchObject({ owned: true, spawned: 2, alive: 0 });
    expect(processFacts.identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pid: server.process.pid, alive: false }),
        expect.objectContaining({ pid: hanging.pid, alive: false, signal: 'SIGTERM' }),
      ]),
    );
  } finally {
    await fixture.dispose();
  }
});

it('[case:p06-f002-cleanup-ownership] 重复创建清理只删除本次持有的临时根', async () => {
  const first = createTodoBrownfieldFixture({ prefix: 'shiploop-p06-f002-own-a-' });
  const second = createTodoBrownfieldFixture({ prefix: 'shiploop-p06-f002-own-b-' });
  try {
    expect(first.root).not.toBe(second.root);
    await first.runCheck('failing');
    await first.dispose();
    expect(existsSync(first.root)).toBe(false);

    // 另一夹具不受影响：资源完整、脏状态原样。
    expect(existsSync(join(second.todoRepositoryPath, 'README.md'))).toBe(true);
    const status = git(['status', '--porcelain=v1'], second.todoRepositoryPath, { home: second.homeDir });
    expect(statusLines(status)).toEqual([...EXPECTED_DIRTY_STATUS].sort());
  } finally {
    await second.dispose();
  }
  expect(existsSync(second.root)).toBe(false);
});

it('[case:p06-f002-cleanup-injection] 子进程遗留停止升级与清理失败注入保留现场和事实', async () => {
  // 子进程遗留：忽略 SIGTERM 的 server 由清理经真实升级（SIGTERM→SIGKILL）停止核验，
  // 不是 dispose 静默；停止后资源才被删除。
  const leftover = createTodoBrownfieldFixture({ prefix: 'shiploop-p06-f002-leftover-', stepMs: 100 });
  try {
    const server = await leftover.startFakeMcpServer({ ignoreTerminate: true });
    expect(existsSync(server.readyFile)).toBe(true);
    expect(server.process.isAlive()).toBe(true);
    const failedOrPassed = await leftover.cleanup();
    expect(failedOrPassed.status).toBe('passed');
    expect(failedOrPassed.processStopped).toBe(true);
    expect(failedOrPassed.resourcesRemoved).toBe(true);
    const identity = leftover.processFacts().identities.find((entry) => entry.pid === server.process.pid);
    expect(identity).toMatchObject({ alive: false, signal: 'SIGKILL' });
    expect(identity?.stopEscalated).toEqual(expect.arrayContaining(['SIGTERM', 'SIGKILL']));
  } finally {
    await leftover.dispose();
  }

  // 清理失败注入：停止确认回调拒绝 → failed 且现场保留；重试通过。
  const injected = createTodoBrownfieldFixture({ prefix: 'shiploop-p06-f002-inject-' });
  try {
    const rejected = await injected.cleanup({ confirmStopped: () => false });
    expect(rejected.status).toBe('failed');
    expect(rejected.resourcesRemoved).toBe(false);
    expect(rejected.reason).toContain('停止确认回调');
    expect(existsSync(injected.root)).toBe(true);
    const retry = await injected.cleanup();
    expect(retry.status).toBe('passed');
  } finally {
    await injected.dispose();
  }
});

it('[case:p06-f002-partial-init] 部分初始化抛结构化事实并清理自有临时根', () => {
  let retainedRoot: string | undefined;
  try {
    createTodoBrownfieldFixture({ prefix: 'shiploop-p06-f002-partial-', stopAfter: 'repo-init' });
    throw new Error('expected partial initialization failure');
  } catch (error) {
    expect(error).toBeInstanceOf(TodoFixturePartialInitError);
    const partial = error as TodoFixturePartialInitError;
    expect(partial.kind).toBe('partial_init');
    expect(partial.stage).toBe('repo-init');
    expect(partial.prepared).toContain('sqlite');
    expect(partial.prepared).not.toContain('repo-commit');
    retainedRoot = partial.root;
  }
  // 自有临时根已清理：部分初始化不泄漏资源。
  expect(retainedRoot !== undefined && existsSync(retainedRoot)).toBe(false);
});

it('[case:p06-f002-evidence-redaction] 敏感哨兵与开发机绝对路径不进入普通证据文本', async () => {
  const fixture = createTodoBrownfieldFixture({ prefix: 'shiploop-p06-f002-redact-' });
  try {
    // 哨兵文件真实存在，值登记为秘密；受保护路径为开发仓库与真实 HOME。
    expect(existsSync(fixture.sensitiveSentinelPath)).toBe(true);
    expect(fixture.sensitiveSentinelValue.length).toBeGreaterThanOrEqual(8);

    const serialized = fixture.evidence.serialize();
    expect(serialized).not.toContain(fixture.sensitiveSentinelValue);
    expect(serialized).not.toContain(fixture.bearerSentinelValue);
    expect(serialized).not.toContain(REPO_ROOT);
    expect(serialized).not.toContain(homedir());

    // 普通事实摘要可安全进入证据（fail-closed 校验通过）且不含敏感内容。
    const event = fixture.recordEvidenceEvent('todo.fixture.describe', fixture.describeFacts());
    expect(event.seq).toBeGreaterThan(0);
    const factsText = JSON.stringify(fixture.describeFacts());
    for (const forbidden of [fixture.sensitiveSentinelValue, fixture.bearerSentinelValue, REPO_ROOT, homedir()]) {
      expect(factsText).not.toContain(forbidden);
    }
    expect(factsText).toContain('todo-app');

    // fail-closed：携带哨兵或受保护路径的字段被拒绝，不留半截记录。
    expect(() => fixture.evidence.record('leak', { note: `value ${fixture.sensitiveSentinelValue}` })).toThrow();
    expect(() => fixture.evidence.record('leak', { note: `path ${REPO_ROOT}` })).toThrow();
    expect(fixture.evidence.events()).toHaveLength(1);
  } finally {
    await fixture.dispose();
  }
});

it('[case:p06-f002-no-network-no-credentials] 子进程环境白名单且不携带真实凭据或网络端点', async () => {
  const fixture = createTodoBrownfieldFixture({ prefix: 'shiploop-p06-f002-env-' });
  try {
    const env = fixture.childEnv();
    expect(Object.keys(env).sort()).toEqual(['HOME', 'NODE_NO_WARNINGS', 'PATH', 'TMPDIR']);
    expect(env.HOME).toBe(fixture.homeDir);
    expect(env.TMPDIR).toBe(fixture.tmpDir);
    for (const key of Object.keys(env)) {
      expect(key.toLowerCase()).not.toMatch(/token|secret|password|credential/);
    }
    // 两仓库均无 remote：夹具不访问远程网络。
    expect(fixture.gitFacts().todoRemotes).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});
