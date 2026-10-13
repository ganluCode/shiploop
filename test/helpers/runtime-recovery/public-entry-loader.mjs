/**
 * F-005 公共入口加载守卫（仅测试辅助；经 module.register 注入干净子进程）。
 *
 * 职责：
 * 1. 禁止厂商 SDK 与基础设施说明符进入解析（Pi SDK/Durable、Electron、
 *    better-sqlite3、Drizzle、node:http(s)/net/dgram）——公共契约面命中即
 *    加载失败，证明「无 SDK 依赖仍能加载」不是静态猜测；
 * 2. 将 packages 源码内部的相对 `.js` 说明符映射到真实 `.ts` 文件，使干净
 *    Node 子进程无需构建即可加载生产 TypeScript 入口（Node 22 原生类型擦除）。
 *
 * 非字面量 import/require 不受本守卫豁免；解析失败按加载失败处理。
 */
import { existsSync } from 'node:fs';

const FORBIDDEN = [
  /^@earendil-works\//,
  /^pi-coding-agent$/,
  /^pi-ai$/,
  /^pi-durable$/,
  /^chord$/,
  /^electron$/,
  /^better-sqlite3$/,
  /^drizzle-orm$/,
  /^node:(https?|net|dgram)$/,
];

export async function resolve(specifier, context, nextResolve) {
  for (const pattern of FORBIDDEN) {
    if (pattern.test(specifier)) {
      throw new Error(`forbidden specifier: ${specifier}`);
    }
  }
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    specifier.endsWith('.js') &&
    context.parentURL
  ) {
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (existsSync(candidate)) {
      return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
}
