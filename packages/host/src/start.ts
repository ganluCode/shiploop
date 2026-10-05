/**
 * F-006 Host 显式启动入口（契约 §13.1）。
 *
 * 用法：`node …/dist/start.js --data-root <abs>`（只接受受控 argv，无 shell）。
 * - 成功：stdout 打印单行脱敏 JSON（hostInstanceId/回环地址/实际端口/pid/
 *   dataRootIdentity/startedAt/lifecycleState），进程保持存活（Host 守护）；
 * - 失败：stderr 打印脱敏结构化错误；输入错误退出码 2，其余失败退出码 1；
 * - 本文件不是库模块：被执行即启动 Host；公共库面经 package.json exports
 *   的 index.js（加载无副作用）。
 */
import { runHostStartEntry, wireHostSignalShutdown } from './runtime/index.js';

const outcome = await runHostStartEntry(process.argv, {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
if (outcome.host === undefined) {
  process.exitCode = outcome.exitCode;
} else {
  // F-008（§10.7）：SIGTERM/SIGINT 走与显式 stop 相同的安全收尾；收尾完成
  // （按实例清理 + 释锁）后以退出码 0 退出；未确认保留进程、锁与现场。
  wireHostSignalShutdown(outcome.host, () => process.exit(0));
}
