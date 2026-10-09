// F-003 基线命令样例：修改受检源码（运行期间变更工作区）。
// 追加一行到 argv[2] 指定文件（须位于被检仓库内），用于验证「执行后复核代码身份」
// 发现源码变化 → reason source_changed / 检查 inconclusive。
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const target = process.argv[2];
if (typeof target !== 'string' || target.length === 0) {
  process.stderr.write('modify-source: 缺少目标文件 argv[2]\n');
  process.exit(2);
}
mkdirSync(dirname(target), { recursive: true });
appendFileSync(target, `// modified-by-sample ${Date.now()}\n`);
process.stdout.write(`sample-modified:${target}\n`);
process.exit(0);
