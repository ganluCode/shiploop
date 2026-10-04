/**
 * F-007 测试子进程加载器的模块解析钩子（仅测试使用，不进 packages/）。
 *
 * 用途：跨进程竞争用例需要在独立真实子进程中运行 SQLite 适配器源码。
 * 源码内部按 NodeNext 约定使用 `.js` 扩展名引用同包 `.ts` 文件；Node 22 原生
 * 类型擦除不做 `.js`→`.ts` 重映射，因此这里只对“相对路径且目标 `.ts` 文件
 * 实际存在”的说明符做存在性重映射，其余一律交给默认解析。
 *
 * F-006 扩展（仍仅测试使用）：Host 生产源码经包公共入口说明符引用 Core
 * （'shiploop-core' 与 'shiploop-core/assembly'）。生产运行时这两个说明符由
 * node_modules 工作区链接解析到 dist 产物；测试子进程直接运行 packages/ 源码，
 * 且在干净树（无 dist）下 `npm test` 必须先于构建通过，因此这里把这两个
 * **精确的公共入口说明符**确定性重映射到对应源码文件。不做前缀/模式匹配，
 * 不映射任何内部子路径（内部子路径仍由边界检查禁止）。
 *
 * 边界：其他裸包说明符（better-sqlite3 等）走 node_modules 正常解析；
 * 钩子逻辑确定性，不读环境变量，不产生文件副作用。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 工作区公共入口 → 源码的精确映射（与 packages/core/package.json exports 对齐）。 */
const CORE_SRC_ROOT = new URL('../../../packages/core/src/', import.meta.url);
const WORKSPACE_PUBLIC_ENTRY_SOURCES = new Map([
  ['shiploop-core', new URL('index.ts', CORE_SRC_ROOT).href],
  ['shiploop-core/assembly', new URL('adapters/composition.ts', CORE_SRC_ROOT).href],
]);

export async function resolve(specifier, context, next) {
  const publicEntrySource = WORKSPACE_PUBLIC_ENTRY_SOURCES.get(specifier);
  if (publicEntrySource !== undefined) {
    return next(publicEntrySource, context);
  }
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
