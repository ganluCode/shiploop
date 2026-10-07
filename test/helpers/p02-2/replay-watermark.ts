/**
 * F-004 可续读下界水位控制器（仅测试使用，不是产品实现，不进 packages/）。
 *
 * 契约依据：docs/p02-2-commands-events-contract.md §9.4——P02-2 不做事件清理，
 * 持久序列自 1 起全保留，正常库下界为 0。snapshot_required 的过期分支本期
 * 只允许由「受控测试夹具注入的保留下界水位」触发，**绝不为测试删除或篡改
 * state_events 持久审计行**。
 *
 * 本控制器只是内存中的测试缝值：F-012 的可信测试装配在判断游标是否低于
 * 「现存最小可读 sequence」时查询它；生产装配没有任何代码路径引用本文件
 * （由 test/p02-2-fixture-kit.test.ts 源码扫描固定 packages/ 无 test-only 入口）。
 */
import { isUuidV4 } from '../../../packages/core/src/ports/commands.ts';

export type ReplayWatermarkScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly projectId: string };

export interface ReplayLowerBoundController {
  /** 设置该 scope 的保留下界（≥0 安全整数）；非法输入拒绝。 */
  setRetained(scope: ReplayWatermarkScope, sequence: number): void;
  /** 读取保留下界；未设置为 0（正常全保留库）。 */
  retainedSequence(scope: ReplayWatermarkScope): number;
  /** 复位单个 scope；不给定则全部复位。 */
  reset(scope?: ReplayWatermarkScope): void;
  /** 证据快照：内部键值的只读副本。 */
  snapshot(): Record<string, number>;
}

function scopeKey(scope: ReplayWatermarkScope): string {
  if (scope === null || typeof scope !== 'object') {
    throw new TypeError('replay watermark scope 必须是对象');
  }
  if (scope.kind === 'global') {
    return 'global';
  }
  if (scope.kind === 'project') {
    if (!isUuidV4(scope.projectId)) {
      throw new TypeError('replay watermark project scope: projectId 必须是 UUID v4');
    }
    return `project:${scope.projectId}`;
  }
  throw new TypeError(`replay watermark scope: 未知 kind ${String((scope as { kind?: unknown }).kind)}`);
}

function validateSequence(sequence: unknown): asserts sequence is number {
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new TypeError(`保留下界必须是 ≥0 的安全整数，实际：${String(sequence)}`);
  }
}

export function createReplayLowerBoundController(): ReplayLowerBoundController {
  const retained = new Map<string, number>();

  return {
    setRetained(scope: ReplayWatermarkScope, sequence: number): void {
      validateSequence(sequence);
      retained.set(scopeKey(scope), sequence);
    },

    retainedSequence(scope: ReplayWatermarkScope): number {
      return retained.get(scopeKey(scope)) ?? 0;
    },

    reset(scope?: ReplayWatermarkScope): void {
      if (scope === undefined) {
        retained.clear();
        return;
      }
      retained.delete(scopeKey(scope));
    },

    snapshot(): Record<string, number> {
      return Object.fromEntries([...retained.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    },
  };
}
