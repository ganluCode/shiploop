// F-003 基线命令样例：持续写入的派生（孙）子进程。
// 由 spawn-writer.mjs 派生；只要自身未被终止就持续在 argv[2] 目录写入文件，
// 用于验证「杀掉父进程不足以停止进程树」——必须核验整棵进程树停止。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (typeof dir !== 'string' || dir.length === 0) {
  process.stderr.write('persistent-writer-child: 缺少写入目录 argv[2]\n');
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

let tick = 0;
setInterval(() => {
  tick += 1;
  writeFileSync(join(dir, `child-write-${tick}.txt`), `tick ${tick}\n`);
}, 20);

process.stdout.write(`persistent-writer-child:${process.pid}\n`);
