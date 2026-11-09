import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseProviderArgs, runProviderCli } from '../../../packages/cli/src/provider-auth.ts';

it('parses only supported explicit auth commands and rejects unknown/ambiguous flags', () => {
  expect(parseProviderArgs(['provider', 'login', 'openai-codex', '--method', 'device', '--data-root', '/tmp/a']))
    .toMatchObject({ action: 'login', provider: 'openai-codex', method: 'device', dataRoot: '/tmp/a' });
  expect(parseProviderArgs(['provider', 'auth-status', 'openai-codex', '--json']))
    .toMatchObject({ action: 'auth-status', json: true });
  for (const args of [
    ['provider', 'login', 'p'], ['provider', 'login', 'openai-codex', '--method', 'wrong'],
    ['provider', 'logout', 'openai-codex', '--method', 'browser'],
    ['provider', 'models', 'openai-codex', '--bad'], ['provider', 'auth-status', 'openai-codex', '--json', '--json'],
  ]) expect(() => parseProviderArgs(args)).toThrow();
});

it('queries unconfigured status without starting Host, networking or printing credentials', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shiploop-provider-cli-')));
  const output: string[] = [];
  try {
    const result = await runProviderCli({ args: ['provider', 'auth-status', 'openai-codex', '--data-root', root, '--json'],
      io: { stdout: s => output.push(s), stderr: () => {} } });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(output.join(''))).toMatchObject({ ok: true, command: 'provider.auth-status',
      result: { provider: 'openai-codex', status: 'not_configured', verifiedOnline: false } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
