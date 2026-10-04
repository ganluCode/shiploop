/**
 * ShipLoop 默认确定性测试配置（F-003）。
 *
 * fail-closed 约定，任何一项都不得静默放宽：
 * - watch: false / run 模式：npm test 一次性执行后退出，绝不常驻；
 * - passWithNoTests: false：找不到真实测试文件时退出码非零；
 * - cache: false：不依赖上次运行残留的缓存文件；
 * - coverage.enabled: false：未安装覆盖率提供者，不制造“未运行即通过”的门槛；
 * - include 只收集 test/ 下的真实用例；helpers/fixtures 即使命名为 *.test.* 也显式排除；
 * - 固定 forks 池、不随机序、有限超时，保证可重复。
 *
 * 负向夹具（临时副本删除测试、注入失败断言、工具缺失）在
 * test/deterministic-test-harness.test.ts 中以真实子进程验证。
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // F-006：host 生产源码经包公共入口说明符引用 Core；测试进程直接运行
    // packages/ 源码，且干净树（无 dist）下 npm test 必须先于构建通过。
    // 精确匹配两个公共入口说明符到源码文件，不做前缀匹配；生产运行时仍由
    // node_modules 工作区链接解析到 dist 产物。
    alias: [
      {
        find: /^shiploop-core\/assembly$/,
        replacement: fileURLToPath(
          new URL('./packages/core/src/adapters/composition.ts', import.meta.url),
        ),
      },
      {
        find: /^shiploop-core$/,
        replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    watch: false,
    passWithNoTests: false,
    cache: false,
    pool: 'forks',
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'test/helpers/**',
      'test/fixtures/**',
    ],
    sequence: {
      shuffle: false,
      concurrent: false,
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      enabled: false,
    },
  },
});
