/**
 * F-012 公共入口 import 冒烟探针（P02-ENG-CLEAN-REPLAY 的 public-import-smoke 步骤）。
 *
 * 用法：node p02-clean-replay-import-probe.mjs <entry.js> [<entry.js> ...]
 *
 * 行为（fail-closed）：
 * 1. 在任何受测 import 之前安装进程/网络副作用护栏：child_process 的 spawn/exec
 *    家族、net 的 connect/createServer/listen、http(s) 的 request/get/createServer、
 *    dgram.createSocket、dns 查询全部替换为「调用即抛错」的占位实现；
 * 2. 依次动态 import 传入的公共入口（packages/{core,host,cli}/dist/index.js）；
 *    任一入口在 import 期间触发上述副作用即抛错、非零退出；
 * 3. 全部入口加载成功后立即退出码 0（监听端口/常驻句柄会让事件循环无法结束而被
 *    外部有界超时判失败）。文件写入副作用由驱动方在隔离 HOME/XDG/TMPDIR 前后
 *    树快照差异中断言（见 p02-clean-replay.ts）。
 *
 * 护栏在本进程内对内置模块导出对象先行改写，晚于改写的 ESM 门面会捕获改写后
 * 的实现；因此必须保持「先护栏、后 import」的顺序，不得把受测 import 提前。
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

function blocked(name) {
  return function blockedImplementation() {
    throw new Error(`public import 触发禁止的进程/网络副作用：${name}`);
  };
}

const childProcess = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = blocked(`child_process.${name}`);
}

const net = require('node:net');
net.connect = blocked('net.connect');
net.createConnection = blocked('net.createConnection');
net.createServer = blocked('net.createServer');
net.Socket.prototype.connect = blocked('net.Socket#connect');
net.Server.prototype.listen = blocked('net.Server#listen');

const http = require('node:http');
http.request = blocked('http.request');
http.get = blocked('http.get');
http.createServer = blocked('http.createServer');

const https = require('node:https');
https.request = blocked('https.request');
https.get = blocked('https.get');
https.createServer = blocked('https.createServer');

const dgram = require('node:dgram');
dgram.createSocket = blocked('dgram.createSocket');

const dns = require('node:dns');
dns.lookup = blocked('dns.lookup');
dns.resolve = blocked('dns.resolve');

const entries = process.argv.slice(2);
if (entries.length === 0) {
  process.stderr.write('import-probe: 缺少公共入口参数\n');
  process.exit(2);
}

for (const entry of entries) {
  await import(pathToFileURL(entry).href);
}

process.stdout.write(`import-probe: OK ${entries.length} entries imported without process/network side effects\n`);
