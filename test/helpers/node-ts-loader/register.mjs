/**
 * F-007 测试子进程加载器注册入口（仅测试使用）。
 *
 * 父进程以 `node --import <本文件> <子脚本.ts>` 启动子进程：注册
 * hooks.mjs 的 `.js`→`.ts` 存在性重映射后，子进程即可在 Node 22 原生
 * 类型擦除下直接加载 packages/core/src 的真实适配器源码。
 */
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
