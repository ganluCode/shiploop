import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnedProcessTree } from '../../../scripts/acceptance/owned-process-tree.ts';

const mocks = vi.hoisted(() => ({ ps: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.ps }));

const start = 'Thu Oct 22 22:20:00 2026';
const row = (pid: number, ppid: number, args = 'command', at = start) => `${pid} ${ppid} S ${at} ${args}`;
const snapshots = (...rows: string[]) => mocks.ps.mockReturnValue(rows.join('\n'));
const inspect = (tree: OwnedProcessTree) => tree as unknown as { owned: Map<number, string> };

describe('acceptance process ownership is bounded and identity-fenced', () => {
  beforeEach(() => { vi.useFakeTimers(); mocks.ps.mockReset(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('uses a finite snapshot budget with headroom for concurrent real-process tests', async () => {
    snapshots(row(100, 1));
    const tree = new OwnedProcessTree(100);
    expect(mocks.ps).toHaveBeenCalledWith('/bin/ps', expect.any(Array),
      expect.objectContaining({ timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }));
    await tree.finish(false);
  });

  it('retains only current matching identities across many short-lived children', async () => {
    snapshots(row(100, 1), row(101, 100));
    const tree = new OwnedProcessTree(100);
    for (let pid = 102; pid < 302; pid++) {
      snapshots(row(100, 1), row(pid, 100));
      vi.advanceTimersByTime(200);
    }
    expect(inspect(tree).owned.size).toBe(2);
    await tree.finish(false);
  });

  it('stores compact identities rather than retaining large argv/table strings', async () => {
    snapshots(row(100, 1, 'x'.repeat(524288)), row(101, 100));
    const tree = new OwnedProcessTree(100);
    expect([...inspect(tree).owned.values()].every(identity => identity.length === 64)).toBe(true);
    await tree.finish(false);
  });

  it('keeps a previously proven live orphan and discovers descendants out of row order', async () => {
    snapshots(row(102, 101), row(101, 100), row(100, 1));
    const tree = new OwnedProcessTree(100);
    snapshots(row(102, 1));
    vi.advanceTimersByTime(200);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    tree.kill();
    expect(kill.mock.calls).toEqual([[102, 'SIGKILL']]);
    await tree.finish(false);
  });

  it('never adopts a recycled root PID or its unrelated descendants', async () => {
    snapshots(row(100, 1));
    const tree = new OwnedProcessTree(100);
    snapshots();
    vi.advanceTimersByTime(200);
    snapshots(row(100, 1, 'command', 'Thu Oct 22 22:21:00 2026'), row(103, 100));
    vi.advanceTimersByTime(200);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    tree.kill();
    expect(kill).not.toHaveBeenCalled();
    await tree.finish(false);
  });

  it('never adopts a root first seen after the initial identity probe failed', async () => {
    mocks.ps.mockImplementationOnce(() => { throw new Error('initial probe failed'); });
    const tree = new OwnedProcessTree(100);
    snapshots(row(100, 1, 'unrelated'), row(103, 100));
    vi.advanceTimersByTime(200);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    tree.kill();
    expect(kill).not.toHaveBeenCalled();
    await tree.finish(false);
  });

  it('does not signal a child whose argv changed even when PID/start time match', async () => {
    snapshots(row(100, 1), row(101, 100));
    const tree = new OwnedProcessTree(100);
    snapshots(row(101, 1, 'other-command'));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    tree.kill();
    expect(kill).not.toHaveBeenCalled();
    await tree.finish(false);
  });

  it('does not discard proven ownership after a failed scan or claim confirmed cleanup', async () => {
    snapshots(row(100, 1), row(101, 100));
    const tree = new OwnedProcessTree(100);
    mocks.ps.mockImplementationOnce(() => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); });
    vi.advanceTimersByTime(200);
    expect(inspect(tree).owned.size).toBe(2);
    snapshots();
    expect(await tree.finish(true)).toBe(false);
    expect(tree.diagnostic()).toContain('ownership_scan_failed=true');
  });
});
