/**
 * P07-1 / F-001 受控 Verifier 检查命令（仅测试夹具，不进 packages/）。
 *
 * 由真实 Host 子进程内的生产 NodeTaskVerificationExecutor 作为受监督真实
 * 子进程启动（argv / cwd / 超时全部来自受信装配的检查定义）：
 * 1. 启动即写标记文件（pid/ppid/startTime/node 版本），供父测试证明
 *    「真实 Verifier 命令已启动」——不依赖日志文本，也不靠固定 sleep；
 * 2. hold 文件存在时有界等待（holdBudgetMs）：释放或预算耗尽二者取先，
 *    构成确定性的 Verifier 边界屏障；
 * 3. 校验 Runtime 写入的目标文件内容并输出 shiploop.node-check 协议行；
 *    内容匹配 exit 0，否则 exit 1。不访问网络、模型或真实凭据。
 *
 * 用法：node check-runner.mjs <markerPath> <holdPath> <targetPath>
 *       <expectedContent> [holdBudgetMs]
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { argv, exit, ppid, pid, platform, version } from 'node:process';

function reject(message) {
  process.stderr.write(`check-runner: ${message}\n`);
  exit(2);
}

const [, , markerPath, holdPath, targetPath, expectedContent, holdBudgetArg, testCountArg, descendantPath] = argv;
if (typeof markerPath !== 'string' || markerPath === '') reject('markerPath 必填');
if (typeof holdPath !== 'string' || holdPath === '') reject('holdPath 必填');
if (typeof targetPath !== 'string' || targetPath === '') reject('targetPath 必填');
if (typeof expectedContent !== 'string') reject('expectedContent 必填');
const holdBudgetMs = Number.parseInt(holdBudgetArg ?? '120000', 10);
if (!Number.isSafeInteger(holdBudgetMs) || holdBudgetMs < 0 || holdBudgetMs > 600000) {
  reject('holdBudgetMs 必须是 0..600000 的整数');
}

/* 边界证明先于一切等待：标记落盘即证明真实 Verifier 进程已启动。 */
writeFileSync(markerPath, `${JSON.stringify({
  schemaVersion: 1,
  kind: 'p07-1-verifier-started',
  pid,
  ppid,
  startedAtIso: new Date().toISOString(),
  nodeVersion: version,
  platform,
})}\n`);

if (descendantPath) {
  // Same controlled process group, but ignores TERM to exercise escalation on restart.
  spawn(process.execPath, ['-e', `const fs = require('node:fs'); process.on('SIGTERM', () => {});
    fs.writeFileSync(process.argv[1] + '.pid', String(process.pid));
    setInterval(() => fs.appendFileSync(process.argv[1], 'tick\\n'), 50);`, descendantPath], { stdio: 'ignore' });
}
const deadline = Date.now() + holdBudgetMs;
while (existsSync(holdPath) && Date.now() < deadline) {
  appendFileSync(`${markerPath}.heartbeat`, 'tick\n');
  await new Promise((resolve) => setTimeout(resolve, 100));
}

let matched = false;
let failure = null;
try {
  matched = readFileSync(targetPath, 'utf8') === expectedContent;
  if (!matched) failure = 'target_content_mismatch';
} catch (error) {
  failure = error !== null && typeof error === 'object' && 'code' in error
    ? `target_read_failed:${String(error.code)}`
    : 'target_read_failed';
}

console.log(`SHIPLOOP_NODE_CHECK_RESULT=${JSON.stringify({
  schemaVersion: 1,
  protocol: 'shiploop.node-check',
  collected: true,
  testCount: testCountArg === undefined ? 1 : Number(testCountArg),
  targets: ['p07-1-f001'],
})}`);
if (failure !== null) process.stderr.write(`check-runner: ${failure}\n`);
exit(matched ? 0 : 1);
