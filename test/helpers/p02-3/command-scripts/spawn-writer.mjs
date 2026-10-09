// F-003 基线命令样例：派生持续写入子进程并自身挂起。
// 启动后派生 persistent-writer-child.mjs（在同一 argv[2] 目录持续写入），
// 把子进程真实 pid 打印到 stdout（供监督方核验进程树身份），父进程随后挂起。
// 语义：杀掉父进程不会停止孙进程，监督方必须核验整棵进程树停止，
// 不得把「父进程探测失败」当成「进程树已停止」。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = process.argv[2];
if (typeof dir !== 'string' || dir.length === 0) {
  process.stderr.write('spawn-writer: 缺少写入目录 argv[2]\n');
  process.exit(2);
}
const childScript = join(dirname(fileURLToPath(import.meta.url)), 'persistent-writer-child.mjs');
const child = spawn(process.execPath, [childScript, dir], { stdio: 'ignore' });

process.stdout.write(`spawn-writer:${process.pid}\n`);
process.stdout.write(`spawn-writer-child-pid:${child.pid ?? -1}\n`);

setInterval(() => {}, 1_000);
