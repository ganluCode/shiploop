/**
 * F-005 公共入口干净子进程（仅测试辅助）。
 *
 * 用法：node public-entry-child.mjs <mode> <entry-absolute-path>
 * - load  ：在注册加载守卫后动态导入公共入口，stdout 输出排序后的导出键 JSON。
 * - guard ：动态导入一个已知会拉入受禁依赖的入口，预期被守卫拒绝
 *           （输出 forbidden specifier 并以 0 退出）；意外成功退出 2，其他
 *           错误原样抛出（非 0）——证明守卫非空转。
 *
 * 子进程只继承 PATH，HOME/TMPDIR 与 cwd 由启动方重定向到临时沙箱；
 * 加载不得监听端口、写文件或常驻。
 */
import { register } from 'node:module';

register('./public-entry-loader.mjs', import.meta.url);

const [mode, entry] = process.argv.slice(2);
if (typeof mode !== 'string' || typeof entry !== 'string') {
  process.stderr.write('usage: public-entry-child.mjs <load|guard> <entry>\n');
  process.exit(2);
}

if (mode === 'load') {
  const mod = await import(entry);
  process.stdout.write(JSON.stringify(Object.keys(mod).sort()));
} else if (mode === 'guard') {
  try {
    await import(entry);
    process.stderr.write('guard-check: import unexpectedly succeeded\n');
    process.exit(2);
  } catch (error) {
    const message = String((error && error.message) || error);
    if (message.includes('forbidden specifier')) {
      process.stdout.write(message);
      process.exit(0);
    }
    throw error;
  }
} else {
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exit(2);
}
