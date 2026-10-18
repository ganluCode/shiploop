/**
 * F-010（P02-3）受监督进程取消/超时/升级终止与停止核验。
 *
 * 协议依据：docs/p02-3-command-process.md（F-010 节）与
 * docs/p02-3-onboarding-contract.md §8.3（停止未确认 → failed/inconclusive/
 * stop_unconfirmed 且保留占用）、§13（SIGTERM→等待→SIGKILL 升级窗口 5s、
 * 升级后确认停止预算 5s、全局单并发占用）。
 *
 * 覆盖（真实进程 + 注入探测；每个真实进程用例都有外层预算与退出核验）：
 * - 取消与 timeout 共用同一条有界停止路径：先请求正常停止（监督者沿受控组
 *   SIGTERM）、宽限后核对持久提交的进程身份再强制终止整棵受控进程树；
 *   cancelled 与 timed_out 原因分别保留，不只 kill 父进程后报告成功；
 * - 真实挂起、忽略 SIGTERM、父进程先退出但子进程持续写入哨兵：终态前证明
 *   相关进程退出且哨兵写入停止；监督者自身被冻结时由 Host 侧升级终止；
 * - 停止未确认：返回明确 uncertain 结果并保留占用（真实 SQLite），竞争检查
 *   （第二个操作获取占用）被 baseline_in_progress 拒绝，不能启动；
 * - 重复取消幂等；取消与自然完成竞争仅提交一个有效终态；旧句柄不影响新执行；
 *   PID 复用/旧启动标识负例不误杀无关进程；身份/缺席探测失败不折算 stopped；
 * - 停止、等待和信号操作不含仓库 reset/stash/删除；失败与取消保留源文件与
 *   已收输出。
 */
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import {
  confirmGroupAbsence,
  forceStopControlledGroup,
  matchesSupervisorIdentity,
} from '../../../packages/core/src/adapters/process/stop-escalation.ts';
import type {
  StopEscalationProbe,
  SupervisedProcessRow,
} from '../../../packages/core/src/adapters/process/stop-escalation.ts';
import { finalizeBaselineOccupancyAfterProcessStop } from '../../../packages/core/src/application/baseline-process-stop.ts';
import type {
  CommandProcessHandle,
  CommandProcessIdentity,
  CommandProcessRequest,
} from '../../../packages/core/src/ports/command-process.ts';
import { openSqliteStorageSession } from '../../../packages/core/src/adapters/sqlite/session.ts';
import { migrateSqliteStorage } from '../../../packages/core/src/adapters/sqlite/migrator.ts';
import { createSqliteBaselineStore } from '../../../packages/core/src/adapters/sqlite/baseline-store.ts';
import { createSqliteAtomicCommandStore } from '../../../packages/core/src/adapters/sqlite/atomic-commands.ts';
import { isStorageError } from '../../../packages/core/src/ports/errors.ts';
import type { StorageError } from '../../../packages/core/src/ports/errors.ts';
import { createTempSandbox } from '../../helpers/temp-sandbox.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** 快速停止预算（可信装配注入；仍为有界值，不放宽冻结上限）。 */
const FAST_BUDGETS = { stopGraceMs: 1_500, stopConfirmMs: 2_000 } as const;

const resources: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
});

function sandbox(): string {
  const box = createTempSandbox('shiploop-stopping-');
  resources.push(() => box.cleanup());
  return realpathSync(box.path);
}

function request(cwd: string, script: string, overrides: Partial<CommandProcessRequest> = {}): CommandProcessRequest {
  return {
    argv: [process.execPath, '-e', script],
    cwd,
    environment: {},
    timeoutMs: 10_000,
    maxInputBytes: 65_536,
    maxOutputBytes: 8_388_608,
    ...overrides,
  };
}

const acknowledge = async (identity: CommandProcessIdentity) => ({ launchId: identity.launchId });

async function start(input: CommandProcessRequest, budgets?: { stopGraceMs?: number; stopConfirmMs?: number }): Promise<CommandProcessHandle> {
  const handle = await createCommandProcessAdapter({ ...budgets }).start(input, acknowledge);
  resources.push(async () => {
    await handle.cancel();
    expect((await handle.stopped).confirmed).toBe(true);
  });
  return handle;
}

/** 有界等待哨兵出现并读取 workload 真实 pid（stdout 在监督者被冻结时不可靠）。 */
async function readPidFile(path: string, deadlineMs = 5_000): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (existsSync(path)) {
      const value = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(value) && value > 0) return value;
    }
    if (Date.now() > deadline) throw new Error(`pid 哨兵在 ${deadlineMs}ms 内未出现: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 有界等待条件成立（外层预算；超时抛错，不无限等待）。 */
async function waitUntil(probe: () => boolean, deadlineMs = 5_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() > deadline) throw new Error(`条件在 ${deadlineMs}ms 内未满足`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** 两次采样哨兵尺寸（间隔 gapMs）：终态后写入必须停止。 */
async function sampleTwice(read: () => number, gapMs = 300): Promise<[number, number]> {
  const first = read();
  await new Promise((resolve) => setTimeout(resolve, gapMs));
  return [first, read()];
}

function capture(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (cause) {
    return cause;
  }
}

function freezeSupervisorScript(pidFile: string, sentinel: string): string {
  // 冻结监督者（SIGSTOP）后持续写哨兵：正常停止路径无法由监督者完成。
  return `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));`
    + `process.kill(process.ppid,'SIGSTOP');let i=0;`
    + `setInterval(()=>{fs.appendFileSync(${JSON.stringify(sentinel)},'tick '+(++i)+'\\n');},25);`;
}

function ignoreSigtermScript(sentinel: string): string {
  return `const fs=require('node:fs');process.on('SIGTERM',()=>{});let i=0;`
    + `setInterval(()=>{fs.appendFileSync(${JSON.stringify(sentinel)},'x');},25);`;
}

describe('F-010 stop escalation decision core (injected probes)', () => {
  const identity: CommandProcessIdentity = {
    launchId: '11111111-2222-4333-8444-555555555555',
    pid: 4242,
    processGroupId: 4242,
    startTime: 'Mon Oct 10 10:10:10 2026',
  };
  const matchingRow: SupervisedProcessRow = {
    pid: 4242,
    processGroupId: 4242,
    startTime: 'Mon Oct 10 10:10:10 2026',
    command: `/usr/bin/node --no-warnings command-supervisor.js ${identity.launchId}`,
  };

  it('matches only the exact committed identity (pid, pgid, lstart and launch id)', () => {
    expect(matchesSupervisorIdentity(matchingRow, identity)).toBe(true);
    expect(matchesSupervisorIdentity({ ...matchingRow, pid: 4243 }, identity)).toBe(false);
    expect(matchesSupervisorIdentity({ ...matchingRow, processGroupId: 4243 }, identity)).toBe(false);
    expect(matchesSupervisorIdentity({ ...matchingRow, startTime: 'Tue Oct 11 11:11:11 2026' }, identity)).toBe(false);
    // 旧执行标识：同一 PID/启动时间但命令行携带别的 launchId（或多余后缀）。
    expect(matchesSupervisorIdentity({ ...matchingRow, command: '/usr/bin/node supervisor.js 99999999-9999-4999-8999-999999999999' }, identity)).toBe(false);
    expect(matchesSupervisorIdentity({ ...matchingRow, command: `${matchingRow.command} extra` }, identity)).toBe(false);
  });

  it('force-kills the controlled group only after the committed identity matches', async () => {
    const signals: Array<[number, string]> = [];
    const probe: StopEscalationProbe = {
      readSupervisorRow: async () => matchingRow,
      listGroupMembers: async () => (signals.length > 0 ? [] : [4242, 4243]),
      signalGroup: (pgid, signal) => {
        signals.push([pgid, signal]);
        return true;
      },
      delay: async () => {},
    };
    const outcome = await forceStopControlledGroup(identity, probe, { confirmMs: 200, pollMs: 5 });
    expect(outcome).toEqual({ confirmed: true, escalated: true, identity: 'matched' });
    expect(signals).toEqual([[4242, 'SIGKILL']]);
  });

  it('refuses to signal an unrelated process that reused the supervisor PID', async () => {
    const signals: Array<[number, string]> = [];
    const probe: StopEscalationProbe = {
      // PID 相同但 lstart 与命令行都变了：OS 层 PID 复用后的无关进程。
      readSupervisorRow: async () => ({ pid: 4242, processGroupId: 4242, startTime: 'Tue Oct 11 11:11:11 2026', command: '/usr/bin/unrelated-worker' }),
      listGroupMembers: async () => [4242],
      signalGroup: (pgid, signal) => {
        signals.push([pgid, signal]);
        return true;
      },
      delay: async () => {},
    };
    const outcome = await forceStopControlledGroup(identity, probe, { confirmMs: 100, pollMs: 5 });
    expect(outcome).toEqual({ confirmed: false, escalated: false, identity: 'mismatched' });
    expect(signals).toEqual([]);
  });

  it('treats an identity probe failure as unknown: never signals, never reports stopped', async () => {
    for (const readSupervisorRow of [
      async () => { throw new Error('ps failed'); },
      async () => undefined,
    ] as StopEscalationProbe['readSupervisorRow'][]) {
      const signals: Array<[number, string]> = [];
      const probe: StopEscalationProbe = {
        readSupervisorRow,
        listGroupMembers: async () => [],
        signalGroup: (pgid, signal) => {
          signals.push([pgid, signal]);
          return true;
        },
        delay: async () => {},
      };
      const outcome = await forceStopControlledGroup(identity, probe, { confirmMs: 100, pollMs: 5 });
      expect(outcome).toEqual({ confirmed: false, escalated: false, identity: 'probe_failed' });
      expect(signals).toEqual([]);
    }
  });

  it('confirms absence without signaling when the supervisor already exited', async () => {
    const signals: Array<[number, string]> = [];
    const probe: StopEscalationProbe = {
      readSupervisorRow: async () => null,
      listGroupMembers: async () => [],
      signalGroup: (pgid, signal) => {
        signals.push([pgid, signal]);
        return true;
      },
      delay: async () => {},
    };
    const outcome = await forceStopControlledGroup(identity, probe, { confirmMs: 200, pollMs: 5 });
    expect(outcome).toEqual({ confirmed: true, escalated: false, identity: 'absent' });
    expect(signals).toEqual([]);
  });

  it('stays unconfirmed when group members persist beyond the confirmation budget', async () => {
    let polls = 0;
    const probe: StopEscalationProbe = {
      readSupervisorRow: async () => matchingRow,
      listGroupMembers: async () => {
        polls += 1;
        return [4242];
      },
      signalGroup: () => true,
      delay: async () => {},
    };
    const outcome = await forceStopControlledGroup(identity, probe, { confirmMs: 120, pollMs: 20 });
    expect(outcome).toEqual({ confirmed: false, escalated: true, identity: 'matched' });
    expect(polls).toBeGreaterThanOrEqual(3); // 有界轮询，不是单次探测即放弃。
  });

  it('does not convert absence probe failures into stopped', async () => {
    const probe: StopEscalationProbe = {
      readSupervisorRow: async () => null,
      listGroupMembers: async () => {
        throw new Error('ps failed');
      },
      signalGroup: () => true,
      delay: async () => {},
    };
    await expect(confirmGroupAbsence(identity, probe, { confirmMs: 80, pollMs: 10 })).resolves.toBe(false);
    await expect(forceStopControlledGroup(identity, probe, { confirmMs: 80, pollMs: 10 }))
      .resolves.toMatchObject({ confirmed: false });
  });
});

describe('F-010 supervised process stopping (real processes)', () => {
  it('kills a SIGTERM-ignoring workload via escalation and preserves the cancel reason', async () => {
    const root = sandbox();
    const sentinel = join(root, 'ignore-sigterm.log');
    const handle = await start(request(root, ignoreSigtermScript(sentinel)));
    await waitUntil(() => existsSync(sentinel) && statSync(sentinel).size > 0); // workload 已开始写哨兵。
    await handle.cancel();
    const result = await handle.result;
    expect(result.reason).toBe('cancelled');
    expect(result.stop.confirmed).toBe(true);
    expect((await handle.stopped).confirmed).toBe(true);
    const [a, b] = await sampleTwice(() => statSync(sentinel).size);
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });

  it('preserves the distinct timed_out reason through the same bounded stop path', async () => {
    const root = sandbox();
    const sentinel = join(root, 'ignore-sigterm-timeout.log');
    const handle = await start(request(root, ignoreSigtermScript(sentinel), { timeoutMs: 800 }));
    const result = await handle.result;
    expect(result.reason).toBe('timed_out');
    expect(result.stop.confirmed).toBe(true);
    const [a, b] = await sampleTwice(() => statSync(sentinel).size);
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });

  it('stops the whole tree when the command parent exits but a descendant keeps writing', async () => {
    const root = sandbox();
    const sentinel = join(root, 'descendant-sentinel.log');
    const pidFile = join(root, 'descendant.pid');
    const childCode = `const fs=require('node:fs');setInterval(()=>{fs.appendFileSync(${JSON.stringify(sentinel)},'x');},20);`;
    const parentCode = `const fs=require('node:fs');const {spawn}=require('node:child_process');`
      + `const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});c.unref();`
      + `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`;
    const handle = await start(request(root, parentCode), FAST_BUDGETS);
    const descendant = await readPidFile(pidFile);
    expect(() => process.kill(descendant, 0)).not.toThrow();
    let settled = false;
    void handle.stopped.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(settled).toBe(false); // 后代仍写入：终态前不得报告 stopped。
    expect(statSync(sentinel).size).toBeGreaterThan(0);
    await handle.cancel();
    const result = await handle.result;
    expect(result.stop.confirmed).toBe(true);
    expect(() => process.kill(descendant, 0)).toThrow();
    const [a, b] = await sampleTwice(() => statSync(sentinel).size);
    expect(a).toBe(b);
  });

  it('escalates with identity verification and force-kill when the supervisor itself is frozen', async () => {
    const root = sandbox();
    const pidFile = join(root, 'frozen.pid');
    const sentinel = join(root, 'frozen-sentinel.log');
    const handle = await start(request(root, freezeSupervisorScript(pidFile, sentinel)), FAST_BUDGETS);
    const workload = await readPidFile(pidFile);
    expect(handle.query().state).toBe('running');
    await handle.cancel();
    const result = await handle.result;
    expect(result.reason).toBe('cancelled');
    expect(result.stop.confirmed).toBe(true);
    expect((await handle.stopped).confirmed).toBe(true);
    // 相关进程（workload 与监督者）确已退出，哨兵写入停止。
    expect(() => process.kill(workload, 0)).toThrow();
    expect(() => process.kill(handle.identity.pid, 0)).toThrow();
    const [a, b] = await sampleTwice(() => statSync(sentinel).size);
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });

  it('returns an explicit uncertain outcome, retains occupancy and blocks competing checks when absence cannot be confirmed', async () => {
    const root = sandbox();
    const session = openSqliteStorageSession({ path: join(root, 'state.db') });
    resources.push(() => session.close());
    await migrateSqliteStorage(session);
    const operationA = '11111111-1111-4111-8111-111111111111';
    const operationB = '22222222-2222-4222-8222-222222222222';
    session.database.exec(`INSERT INTO projects (id, created_at, updated_at, display_name, status, labels)
      VALUES ('p', 0, 0, 'p', 'active', '[]');
      INSERT INTO baseline_operations (id, created_at, updated_at, project_id, kind, status)
      VALUES ('${operationA}', 0, 0, 'p', 'baseline', 'accepted');
      INSERT INTO baseline_operations (id, created_at, updated_at, project_id, kind, status)
      VALUES ('${operationB}', 0, 0, 'p', 'baseline', 'accepted');`);
    const clock = { nowUtcMs: () => 1_700_000_000_000 };
    const store = createSqliteBaselineStore(session, clock);
    const atomic = createSqliteAtomicCommandStore(session, clock);

    const pidFile = join(root, 'unconfirmed.pid');
    const sentinel = join(root, 'unconfirmed-sentinel.log');
    let committed: CommandProcessIdentity | undefined;
    // 真实身份核对 + 真实 SIGKILL，但成员清点永远谎报非空：停止无法确认。
    const lyingMembersProbe: StopEscalationProbe = {
      readSupervisorRow: async () => (committed
        ? {
            pid: committed.pid,
            processGroupId: committed.processGroupId,
            startTime: committed.startTime,
            command: `/usr/bin/node --no-warnings command-supervisor.js ${committed.launchId}`,
          }
        : null),
      listGroupMembers: async () => [999_999],
      signalGroup: (pgid) => {
        try {
          process.kill(-pgid, 'SIGKILL');
          return true;
        } catch {
          return false;
        }
      },
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
    resources.push(() => {
      // 仅清理已核验的自有资源：监督者仍存活才升级终止整组。
      try {
        if (committed && process.kill(committed.pid, 0)) process.kill(-committed.processGroupId, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    });
    const handle = await createCommandProcessAdapter({ ...FAST_BUDGETS, stopProbe: lyingMembersProbe })
      .start(request(root, freezeSupervisorScript(pidFile, sentinel)), async (identity) => {
        committed = identity;
        atomic.transact('baseline.test', (transaction) => transaction
          .acquireBaselineOccupancy({ operationId: operationA, processIdentity: { ...identity } }));
        return { launchId: identity.launchId };
      });
    const workload = await readPidFile(pidFile);
    expect(await handle.cancel()).toEqual({ accepted: true });
    const result = await handle.result;
    expect(result.stop.confirmed).toBe(false);
    expect(result.reason).toBe('cancelled');
    expect(handle.query().state).toBe('uncertain');
    expect((await handle.stopped).confirmed).toBe(false);
    // 探测谎报不等于进程仍在：真实 SIGKILL 已按身份核对送达，进程确已退出。
    expect(() => process.kill(workload, 0)).toThrow();
    expect(() => process.kill(handle.identity.pid, 0)).toThrow();
    const [a, b] = await sampleTwice(() => statSync(sentinel).size);
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);

    // Core 收尾：停止未确认 → 保留占用；竞争检查不能启动。
    const retained = atomic.transact('baseline.test', (transaction) => finalizeBaselineOccupancyAfterProcessStop(
      { transaction, occupancyReader: store }, operationA, { stopConfirmed: false }));
    expect(retained.released).toBe(false);
    expect(retained.retained).toBe(true);
    expect(retained.occupancy.holderOperationId).toBe(operationA);
    expect(retained.occupancy.processIdentity).toMatchObject({ launchId: handle.identity.launchId });
    const conflict = capture(() => atomic.transact('baseline.test', (transaction) => transaction
      .acquireBaselineOccupancy({ operationId: operationB, processIdentity: null })));
    expect(isStorageError(conflict, 'conflict')).toBe(true);
    expect((conflict as StorageError).details?.reason).toBe('baseline_in_progress');
    expect(store.readBaselineOccupancy().holderOperationId).toBe(operationA);

    // 停止事后被核验（如恢复核对）才允许释放；随后新检查才能启动。
    const released = atomic.transact('baseline.test', (transaction) => finalizeBaselineOccupancyAfterProcessStop(
      { transaction, occupancyReader: store }, operationA, { stopConfirmed: true }));
    expect(released.released).toBe(true);
    expect(released.occupancy.holderOperationId).toBeNull();
    const acquired = atomic.transact('baseline.test', (transaction) => transaction
      .acquireBaselineOccupancy({ operationId: operationB, processIdentity: null }));
    expect(acquired.holderOperationId).toBe(operationB);
  });

  it('treats repeated cancels as idempotent and settles exactly one final outcome', async () => {
    const handle = await start(request(sandbox(), "process.stdout.write('racing\\n');setInterval(()=>{},1000)"), FAST_BUDGETS);
    const [first, second] = await Promise.all([handle.cancel(), handle.cancel()]);
    expect(first).toEqual({ accepted: true });
    expect(second).toEqual({ accepted: true });
    const outcome = await handle.result;
    expect(outcome).toMatchObject({ reason: 'cancelled' });
    expect(await handle.result).toBe(outcome); // 同一终态对象：仅一个有效终态。
    expect(await handle.cancel()).toEqual({ accepted: true });
    expect(await handle.result).toBe(outcome);
    expect((await handle.stopped).confirmed).toBe(true);
  });

  it('keeps the natural completion outcome when cancel arrives after completion', async () => {
    const handle = await start(request(sandbox(), "process.stdout.write('done\\n')"), FAST_BUDGETS);
    const outcome = await handle.result;
    expect(outcome).toMatchObject({ exitCode: 0, reason: null });
    expect(await handle.cancel()).toEqual({ accepted: true });
    expect(await handle.result).toBe(outcome);
    expect(outcome.reason).toBeNull();
    expect((await handle.stopped).confirmed).toBe(true);
  });

  it('an old handle cannot signal or overwrite the state of a newer execution', async () => {
    const root = sandbox();
    const first = await start(request(root, "process.stdout.write('first\\n')"), FAST_BUDGETS);
    const firstOutcome = await first.result;
    expect(firstOutcome.exitCode).toBe(0);
    const second = await start(request(root, 'setInterval(()=>{},1000)'), FAST_BUDGETS);
    expect(await first.cancel()).toEqual({ accepted: true }); // 旧句柄重复取消：幂等接受。
    await nextTurn();
    expect(second.query().state).toBe('running'); // 新执行不受旧句柄影响。
    expect(await first.result).toBe(firstOutcome); // 旧终态不被覆盖。
    await second.cancel();
    expect((await second.stopped).confirmed).toBe(true);
    expect((await second.result).reason).toBe('cancelled');
  });

  it('preserves source files and already-collected output across cancel', async () => {
    const root = sandbox();
    const dirty = join(root, 'dirty-source.txt');
    writeFileSync(dirty, 'keep-me');
    const handle = await start(request(root, "process.stdout.write('collected-before-stop\\n');setInterval(()=>{},1000)"), FAST_BUDGETS);
    const iterator = handle.output[Symbol.asyncIterator]();
    const firstChunk = await iterator.next();
    expect(Buffer.from(firstChunk.value!.bytes).toString()).toContain('collected-before-stop');
    await handle.cancel();
    let drained = '';
    for (let item = await iterator.next(); !item.done; item = await iterator.next()) {
      drained += Buffer.from(item.value.bytes).toString();
    }
    const result = await handle.result;
    expect(result.outputBytes)
      .toBe(Buffer.byteLength(Buffer.from(firstChunk.value!.bytes).toString() + drained)); // 已收输出保留。
    expect(result.reason).toBe('cancelled');
    expect(existsSync(dirty)).toBe(true);
    expect(readFileSync(dirty, 'utf8')).toBe('keep-me'); // 源文件原样保留。
  });

  it('keeps stop, wait and signal operations free of repository reset/stash/delete logic', () => {
    const sources = [
      'packages/core/src/adapters/process/command-process.ts',
      'packages/core/src/adapters/process/command-supervisor.ts',
      'packages/core/src/adapters/process/stop-escalation.ts',
    ].map((relative) => readFileSync(join(REPO_ROOT, relative), 'utf8'));
    expect(sources.length).toBe(3);
    for (const source of sources) {
      expect(source).not.toMatch(/git\s+(-\S+\s+)*(reset|stash|clean|checkout|rm)\b/);
      expect(source).not.toMatch(/reset\s+--hard|--stash|stash@\{|git\s+checkout/);
      expect(source).not.toMatch(/unlinkSync|rmSync|rmdirSync|rm\s+-[rf]/);
      expect(source).not.toMatch(/spawn\(.*git|execFile\(.*git/);
    }
  });
});

describe('F-010 baseline occupancy stop finalization (real SQLite)', () => {
  async function openHarness(prefix: string): Promise<{
    session: ReturnType<typeof openSqliteStorageSession>;
    store: ReturnType<typeof createSqliteBaselineStore>;
    atomic: ReturnType<typeof createSqliteAtomicCommandStore>;
    operationA: string;
    operationB: string;
  }> {
    const box = createTempSandbox(prefix);
    resources.push(() => box.cleanup());
    const root = realpathSync(box.path);
    const session = openSqliteStorageSession({ path: join(root, 'state.db') });
    resources.push(() => session.close());
    await migrateSqliteStorage(session);
    const operationA = '11111111-1111-4111-8111-111111111111';
    const operationB = '22222222-2222-4222-8222-222222222222';
    session.database.exec(`INSERT INTO projects (id, created_at, updated_at, display_name, status, labels)
      VALUES ('p', 0, 0, 'p', 'active', '[]');
      INSERT INTO baseline_operations (id, created_at, updated_at, project_id, kind, status)
      VALUES ('${operationA}', 0, 0, 'p', 'baseline', 'accepted');
      INSERT INTO baseline_operations (id, created_at, updated_at, project_id, kind, status)
      VALUES ('${operationB}', 0, 0, 'p', 'baseline', 'accepted');`);
    const clock = { nowUtcMs: () => 1_700_000_000_000 };
    return {
      session,
      store: createSqliteBaselineStore(session, clock),
      atomic: createSqliteAtomicCommandStore(session, clock),
      operationA,
      operationB,
    };
  }

  it('releases occupancy only for the holder after a confirmed stop, idempotently', async () => {
    const harness = await openHarness('shiploop-stop-guard-');
    const identity = {
      launchId: '33333333-3333-4333-8333-333333333333',
      pid: 4242,
      processGroupId: 4242,
      startTime: 'Mon Oct 10 10:10:10 2026',
    };
    harness.atomic.transact('baseline.test', (transaction) => transaction
      .acquireBaselineOccupancy({ operationId: harness.operationA, processIdentity: identity }));
    const finalization = harness.atomic.transact('baseline.test', (transaction) => finalizeBaselineOccupancyAfterProcessStop(
      { transaction, occupancyReader: harness.store }, harness.operationA, { stopConfirmed: true }));
    expect(finalization.released).toBe(true);
    expect(finalization.occupancy.holderOperationId).toBeNull();
    // 重复收尾（已释放）幂等，不抛错、不复活占用。
    const repeated = harness.atomic.transact('baseline.test', (transaction) => finalizeBaselineOccupancyAfterProcessStop(
      { transaction, occupancyReader: harness.store }, harness.operationA, { stopConfirmed: true }));
    expect(repeated.released).toBe(true);
    expect(harness.store.readBaselineOccupancy().holderOperationId).toBeNull();
    const acquired = harness.atomic.transact('baseline.test', (transaction) => transaction
      .acquireBaselineOccupancy({ operationId: harness.operationB, processIdentity: null }));
    expect(acquired.holderOperationId).toBe(harness.operationB);
  });

  it('retains occupancy on unconfirmed stop and rejects non-holder finalization', async () => {
    const harness = await openHarness('shiploop-stop-guard-');
    harness.atomic.transact('baseline.test', (transaction) => transaction
      .acquireBaselineOccupancy({ operationId: harness.operationA, processIdentity: null }));
    const finalization = harness.atomic.transact('baseline.test', (transaction) => finalizeBaselineOccupancyAfterProcessStop(
      { transaction, occupancyReader: harness.store }, harness.operationA, { stopConfirmed: false }));
    expect(finalization.released).toBe(false);
    expect(finalization.retained).toBe(true);
    expect(harness.store.readBaselineOccupancy().holderOperationId).toBe(harness.operationA);
    // 非持有者不能借“确认停止”释放他人占用。
    const ownership = capture(() => harness.atomic.transact('baseline.test', (transaction) => finalizeBaselineOccupancyAfterProcessStop(
      { transaction, occupancyReader: harness.store }, harness.operationB, { stopConfirmed: true })));
    expect(isStorageError(ownership, 'ownership')).toBe(true);
    expect(harness.store.readBaselineOccupancy().holderOperationId).toBe(harness.operationA);
  });

  it('rejects malformed holder ids, evidence and ports before any side effect', async () => {
    const harness = await openHarness('shiploop-stop-guard-');
    harness.atomic.transact('baseline.test', (transaction) => transaction
      .acquireBaselineOccupancy({ operationId: harness.operationA, processIdentity: null }));
    const release = (holder: string, confirmed: boolean) => harness.atomic.transact('baseline.test', (transaction) => finalizeBaselineOccupancyAfterProcessStop(
      { transaction, occupancyReader: harness.store }, holder, { stopConfirmed: confirmed }));
    expect(() => release('not-a-uuid', true)).toThrow(TypeError);
    expect(() => release(harness.operationA, 'yes' as unknown as boolean)).toThrow(TypeError);
    expect(() => finalizeBaselineOccupancyAfterProcessStop(
      { occupancyReader: harness.store } as never, harness.operationA, { stopConfirmed: true })).toThrow(TypeError);
    expect(() => finalizeBaselineOccupancyAfterProcessStop(
      { transaction: {} } as never, harness.operationA, { stopConfirmed: true })).toThrow(TypeError);
    // 校验失败零副作用：占用原样保留。
    expect(harness.store.readBaselineOccupancy().holderOperationId).toBe(harness.operationA);
  });
});
