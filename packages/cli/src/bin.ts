#!/usr/bin/env node
/**
 * F-012 ShipLoop CLI 显式可执行入口（契约 §13.1）：
 *   shiploop host start|status|stop [options]
 *
 * 这是 packages/cli 中唯一读 process.argv/process.env、唯一退出进程的文件：
 * - 公共入口 src/index.ts 与 src/host/ 纯面层 import 无副作用（不解析 argv、
 *   不读 env、不联网、不 spawn），执行逻辑集中在 src/host/execute.ts；
 * - 本文件只做 argv/env/IO 注入与退出码落地，不含业务逻辑；
 * - CLI 自身不打开 SQLite：后台 Host 由 shiploop-host 启动器以独立 argv spawn。
 */
import { homedir } from 'node:os';
import { runHostCli, type HostCliIo } from './host/execute.js';

const io: HostCliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

runHostCli({
  args: process.argv.slice(2),
  env: process.env,
  io,
  userHomeDir: homedir(),
}).then(
  (result) => {
    process.exit(result.exitCode);
  },
  () => {
    // 执行层自身已兜底所有错误；到这里说明入口装配失败，输出脱敏通用诊断。
    process.stderr.write('shiploop: internal: CLI 发生未预期错误（错误不含秘密）\n');
    process.exit(1);
  },
);
