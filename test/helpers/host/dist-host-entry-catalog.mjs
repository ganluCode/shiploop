/**
 * F-011 正式构建产物 Host 入口夹具（带可信能力目录；仅测试脚本，不进 packages/）。
 *
 * 与生产入口 packages/host/dist/start.js 执行**同一段** runHostStartEntry +
 * wireHostSignalShutdown 生产逻辑，且加载的是 `npm run build` 的 **dist 产物**
 * （packages/host/dist/runtime/index.js、packages/core/dist/index.js）——
 * P03-1 局部集成回归（F-011）用它以「正式构建的 Host」跑真实子进程：
 * - 注入受信测试能力目录（pi/anthropic/openai），使配置命令的策略条目能通过
 *   Core 的能力兼容复检——生产入口的目录为空（fail-closed），此注入只服务于
 *   测试装配，不是产品能力放宽（与 detached-host-entry-catalog.ts 同一纪律；
 *   纯生产构建当前无法装配策略配置是已记录的已知缺口，见 docs/p03-1-handoff.md）。
 *
 * 纪律同 detached-host-entry.ts：stdio 由启动方置为 ignore；SIGTERM/SIGINT 走
 * 生产 §10.5 安全收尾；120s 兜底避免失败场景泄漏常驻进程。
 */
import {
  runHostStartEntry,
  wireHostSignalShutdown,
} from '../../../packages/host/dist/runtime/index.js';
import { createStaticRuntimeCapabilityCatalog } from '../../../packages/core/dist/index.js';

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
