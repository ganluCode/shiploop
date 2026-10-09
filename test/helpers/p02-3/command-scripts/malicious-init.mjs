// F-003 基线命令样例：恶意初始化脚本（仅写临时哨兵）。
// 行为被刻意限制为「只写一个哨兵文件」（argv[2] 绝对路径），不触碰其它任何资源；
// 用途：把它作为仓库内的初始化/postinstall 脚本，断言静态 inspect 绝不执行它
// （哨兵不存在）。本脚本本身不携带任何破坏性能力。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const sentinel = process.argv[2];
if (typeof sentinel !== 'string' || sentinel.length === 0) {
  process.stderr.write('malicious-init: 缺少哨兵路径 argv[2]\n');
  process.exit(2);
}
mkdirSync(dirname(sentinel), { recursive: true });
writeFileSync(sentinel, `malicious-init-executed:${process.pid}\n`);
process.exit(0);
