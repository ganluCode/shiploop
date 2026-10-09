#!/usr/bin/env node
/**
 * F-012/F-015 ShipLoop CLI 显式可执行入口（契约 §13.1、§12.1）：
 *   shiploop host start|status|stop [options]
 *   shiploop project register|list|get|edit|labels [options]
 *
 * 这是 packages/cli 中唯一读 process.argv/process.env、唯一退出进程的文件：
 * - 公共入口 src/index.ts 与纯面层 import 无副作用（不解析 argv、不读 env、
 *   不联网、不 spawn）；执行逻辑集中在 src/host/execute.ts（生命周期）与
 *   src/app-execute.ts（应用命令）；
 * - 本文件只做 argv/env/IO 注入、按首个 token 选择执行层与退出码落地，不含业务逻辑；
 * - CLI 自身不打开 SQLite：后台 Host 由 shiploop-host 启动器以独立 argv spawn。
 */
import { homedir } from 'node:os';
import { APP_CLI_COMMANDS } from './app/index.js';
import { runAppCli } from './app-execute.js';
import { runHostCli } from './host/execute.js';

const io = {
  stdout: (text: string) => process.stdout.write(text),
  stderr: (text: string) => process.stderr.write(text),
};

const args = process.argv.slice(2);
const isAppCommand =
  args.length > 0 && (APP_CLI_COMMANDS as readonly string[]).includes(args[0] as string);

const run = isAppCommand
  ? runAppCli({ args, env: process.env, io, userHomeDir: homedir() })
  : runHostCli({ args, env: process.env, io, userHomeDir: homedir() });

run.then(
  (result) => {
    process.exit(result.exitCode);
  },
  () => {
    // 执行层自身已兜底所有错误；到这里说明入口装配失败，输出脱敏通用诊断。
    process.stderr.write('shiploop: internal: CLI 发生未预期错误（错误不含秘密）\n');
    process.exit(1);
  },
);
