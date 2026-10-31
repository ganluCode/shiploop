/**
 * P07-4 / F-010 受控检查命令（仅测试夹具，不进 packages/）。
 *
 * 由生产 NodeTaskVerificationExecutor 作为受监督真实子进程启动
 * （argv/cwd/超时全部来自受信装配的检查定义）：
 * 1. 启动即写标记文件（pid/ppid/startTime/node 版本），供父测试证明
 *    「真实检查进程已启动」——不依赖日志文本，也不靠固定 sleep；
 * 2. 校验 Runtime 写入的目标文件内容并输出 shiploop.node-check 协议行
 *    （targets 绑定 p07-4-f010）；内容匹配 exit 0，否则 exit 1；
 * 3. 预期内容传入 "--fail" 前缀时直接确定性失败（失败工作流）。
 *
 * 用法：node p07-4-check-runner.mjs <markerPath> <targetPath> <expectedContent|--fail>
 */
import { writeFileSync } from 'node:fs';
import { exit, pid, ppid, platform, version } from 'node:process';

const [, , markerPath, targetPath, expectedContent] = process.argv;
if (typeof markerPath !== 'string' || markerPath === '') {
  process.stderr.write('p07-4-check-runner: markerPath 必填\n');
  exit(2);
}
if (typeof targetPath !== 'string' || targetPath === '') {
  process.stderr.write('p07-4-check-runner: targetPath 必填\n');
  exit(2);
}
if (typeof expectedContent !== 'string' || expectedContent === '') {
  process.stderr.write('p07-4-check-runner: expectedContent 必填\n');
  exit(2);
}

/* 边界证明先于一切判定：标记落盘即证明真实检查进程已启动。 */
writeFileSync(markerPath, `${JSON.stringify({
  schemaVersion: 1,
  kind: 'p07-4-f010-check-started',
  pid,
  ppid,
  platform,
  nodeVersion: version,
  startedAtIso: new Date().toISOString(),
})}\n`);

let failure = null;
if (expectedContent === '--fail') {
  failure = 'injected check failure (F-010 失败工作流)';
} else {
  try {
    const { readFileSync } = await import('node:fs');
    const actual = readFileSync(targetPath, 'utf8');
    if (actual !== expectedContent) failure = `target content mismatch: ${actual.slice(0, 80)}`;
  } catch (error) {
    failure = `target unreadable: ${String(error).slice(0, 120)}`;
  }
}

console.log(`SHIPLOOP_NODE_CHECK_RESULT=${JSON.stringify({
  schemaVersion: 1,
  protocol: 'shiploop.node-check',
  collected: true,
  testCount: 1,
  targets: ['p07-4-f010'],
})}`);
if (failure !== null) {
  process.stderr.write(`p07-4-check-runner: ${failure}\n`);
  exit(1);
}
exit(0);
