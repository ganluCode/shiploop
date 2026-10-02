/**
 * F-007 测试子进程加载器的模块解析钩子（仅测试使用，不进 packages/）。
 *
 * 用途：跨进程竞争用例需要在独立真实子进程中运行 SQLite 适配器源码。
 * 源码内部按 NodeNext 约定使用 `.js` 扩展名引用同包 `.ts` 文件；Node 22 原生
 * 类型擦除不做 `.js`→`.ts` 重映射，因此这里只对“相对路径且目标 `.ts` 文件
 * 实际存在”的说明符做存在性重映射，其余一律交给默认解析。
 *
 * 边界：不处理裸包说明符（better-sqlite3 等走 node_modules 正常解析）；
 * 钩子逻辑确定性，不读环境变量，不产生文件副作用。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    specifier.endsWith('.js') &&
    typeof context.parentURL === 'string'
  ) {
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (candidate.protocol === 'file:' && existsSync(fileURLToPath(candidate))) {
      return next(candidate.href, context);
    }
  }
  return next(specifier, context);
}
