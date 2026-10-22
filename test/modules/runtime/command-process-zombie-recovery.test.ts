import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const identity = { launchId: '11111111-2222-4333-8444-555555555555', pid: 4242,
  processGroupId: 4242, startTime: 'Fri Oct 23 07:15:34 2026' };

function census(supervisor: string | (() => string), members: () => string | Error) {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const columns = (args[1] as string[])[1];
    const result = columns === 'pid=,pgid=,stat=,lstart=,command='
      ? (typeof supervisor === 'function' ? supervisor() : supervisor) : members();
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(result instanceof Error ? result : null, result instanceof Error ? '' : result, '');
    return {} as ChildProcess;
  }) as typeof execFile);
  return vi.spyOn(process, 'kill').mockImplementation(() => true);
}

it('waits for the entire group after a zombie supervisor, without signalling its lost argv', async () => {
  let reads = 0;
  const signal = census('4242 4242 Z Fri Oct 23 07:15:34 2026 (node)',
    () => ++reads === 1 ? '4242 4242\n4243 4242\n' : '');
  expect(await createCommandProcessAdapter({ stopConfirmMs: 100 }).recoverStop!(identity))
    .toEqual({ confirmed: true });
  expect(reads).toBe(2);
  expect(signal).not.toHaveBeenCalled();
});

it('cannot infer group absence from a zombie when member census fails', async () => {
  const signal = census('4242 4242 Z Fri Oct 23 07:15:34 2026 (node)', () => new Error('ps failed'));
  expect(await createCommandProcessAdapter({ stopConfirmMs: 100 }).recoverStop!(identity))
    .toEqual({ confirmed: false });
  expect(signal).not.toHaveBeenCalled();
});

it('still refuses a live supervisor whose command does not match', async () => {
  const members = vi.fn(() => '');
  const signal = census('4242 4242 S Fri Oct 23 07:15:34 2026 unrelated', members);
  expect(await createCommandProcessAdapter({ stopConfirmMs: 100 }).recoverStop!(identity))
    .toEqual({ confirmed: false });
  expect(members).not.toHaveBeenCalled();
  expect(signal).not.toHaveBeenCalled();
});

it('reprobes unavailable macOS argv without treating its comm placeholder as identity or stop proof', async () => {
  let reads = 0;
  const signal = census(() => ++reads === 1 ? '4242 4242 Ss Fri Oct 23 07:15:34 2026 (node)' : '', () => '');
  expect(await createCommandProcessAdapter({ stopConfirmMs: 100 }).recoverStop!(identity))
    .toEqual({ confirmed: true });
  expect(reads).toBe(2);
  expect(signal).not.toHaveBeenCalled();
});

it('retains uncertainty when argv stays unavailable, even if an unrelated empty census could be supplied', async () => {
  const members = vi.fn(() => '');
  const signal = census('4242 4242 Ss Fri Oct 23 07:15:34 2026 (node)', members);
  expect(await createCommandProcessAdapter({ stopConfirmMs: 100 }).recoverStop!(identity))
    .toEqual({ confirmed: false });
  expect(members).not.toHaveBeenCalled();
  expect(signal).not.toHaveBeenCalled();
});
