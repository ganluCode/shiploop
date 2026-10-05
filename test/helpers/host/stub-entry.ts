/**
 * F-010 启动器负例桩入口（仅测试脚本，不进 packages/）。
 *
 * 启动器把 `--data-root <abs>` 追加在 entryArgv 之后，因此本桩的自有参数
 * 位于 argv[2]（mode），其余原样转交生产入口逻辑：
 *   node --import <hooks> stub-entry.ts <mode> --data-root <abs>
 *
 * mode：
 * - `exit3`：立即以退出码 3 结束（模拟候选启动失败且锁空闲）；
 * - `linger`：不获锁、不发布发现、不监听，仅驻留（默认 SIGTERM 可终止），
 *   30s 兜底自毁防泄漏（模拟候选迟迟不就绪 → start_timeout）；
 * - `delayed-host`：延迟 STUB_HOST_DELAY_MS（默认 800ms）后执行与
 *   detached-host-entry 相同的生产入口逻辑（模拟慢启动 + 父进程中途退出）。
 */
import {
  runHostStartEntry,
  wireHostSignalShutdown,
} from '../../../packages/host/src/runtime/index.ts';

const mode = process.argv[2];

if (mode === 'exit3') {
  process.exit(3);
}

if (mode === 'linger') {
  // 引用态兜底计时器同时充当事件循环保活；默认 SIGTERM 处理可直接终止本进程。
  setTimeout(() => process.exit(9), 30_000);
  await new Promise(() => undefined);
}

if (mode === 'delayed-host') {
  const delayMs = Number(process.env.STUB_HOST_DELAY_MS ?? '800');
  await new Promise((resolveDelay) => {
    setTimeout(resolveDelay, delayMs);
  });
  const outcome = await runHostStartEntry(['node', 'start.js', ...process.argv.slice(3)], {
    stdout: () => undefined,
    stderr: () => undefined,
  });
  if (outcome.host === undefined) {
    process.exit(outcome.exitCode);
  }
  const host = outcome.host;
  wireHostSignalShutdown(host, () => process.exit(0));
  const watchdog = setTimeout(() => {
    void host
      .requestSignalShutdown()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  }, 120_000);
  watchdog.unref();
} else if (mode !== 'exit3') {
  process.stderr.write(`stub-entry: 未知 mode ${String(mode)}\n`);
  process.exit(2);
}
