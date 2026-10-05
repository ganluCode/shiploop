/**
 * F-010 独立后台 Host 入口夹具（仅测试脚本，不进 packages/）。
 *
 * 与生产入口 packages/host/src/start.ts（dist/start.js）执行**同一段**
 * runHostStartEntry + wireHostSignalShutdown 生产逻辑，但以 TS 源码形式存在，
 * 供启动器在干净树（无 dist）下以独立 argv 做 detached 真实子进程启动：
 *   node --import <hooks> detached-host-entry.ts --data-root <abs>
 *
 * 纪律：
 * - stdio 由启动器置为 ignore（detached 后台进程不依赖父进程 stdin/stdio）；
 * - SIGTERM/SIGINT 走与生产相同的 §10.5 安全收尾，completed 后退出码 0；
 * - 120s 兜底：若一直无人显式停止（测试失败泄漏场景），走同一安全收尾退出，
 *   避免孤 Host 常驻。
 */
import {
  runHostStartEntry,
  wireHostSignalShutdown,
} from '../../../packages/host/src/runtime/index.ts';

const outcome = await runHostStartEntry(process.argv, {
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
