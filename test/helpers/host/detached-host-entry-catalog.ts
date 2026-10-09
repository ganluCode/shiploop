/**
 * F-016 独立后台 Host 入口夹具（带可信能力目录；仅测试脚本，不进 packages/）。
 *
 * 与生产入口 packages/host/src/start.ts（dist/start.js）执行**同一段**
 * runHostStartEntry + wireHostSignalShutdown 生产逻辑，但：
 * - 以 TS 源码形式存在，供启动器在干净树（无 dist）下以独立 argv 做 detached
 *   真实子进程启动；
 * - 注入受信测试能力目录（pi/anthropic/openai），使配置命令的策略条目能通过
 *   Core 的能力兼容复检——生产入口的目录为空（fail-closed），此注入只服务于
 *   F-016 配置纵向验收，不是产品能力放宽。
 *
 * 纪律同 detached-host-entry.ts：stdio 由启动器置为 ignore；SIGTERM/SIGINT 走
 * 生产 §10.5 安全收尾；120s 兜底避免失败场景泄漏常驻进程。
 */
import {
  runHostStartEntry,
  wireHostSignalShutdown,
} from '../../../packages/host/src/runtime/index.ts';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/src/index.ts';

const capabilityCatalog = createStaticRuntimeCapabilityCatalog([
  {
    runtimeId: 'pi',
    providers: [
      { providerId: 'anthropic', models: ['claude-sonnet', 'claude-opus'] },
      { providerId: 'openai' },
    ],
  },
]);

const outcome = await runHostStartEntry(
  process.argv,
  { stdout: () => undefined, stderr: () => undefined },
  { startOptions: { capabilityCatalog } },
);
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
