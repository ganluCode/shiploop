import { describe, expect, it } from 'vitest';
import { runAppCli, type AppCliIo } from '../../../packages/cli/src/app-execute.ts';
import { parseAppCliArgs, type ParsedAppCliCommand } from '../../../packages/cli/src/app/args.ts';

const PROJECT = '11111111-1111-4111-8111-111111111111';

function command(args: string[]): ParsedAppCliCommand {
  const parsed = parseAppCliArgs(args);
  expect(parsed.kind).toBe('command');
  if (parsed.kind !== 'command') throw new Error('expected command');
  return parsed;
}

describe('P06-1 F-006 Profile CLI arguments', () => {
  it('[case:profile-detect-arguments] requires explicit confirmation and rejects paths and mutation payloads', () => {
    expect(command(['project', 'profile', 'detect', PROJECT, '--confirm']))
      .toMatchObject({ commandId: 'project.profile-detect', projectId: PROJECT, confirm: true });
    expect(() => parseAppCliArgs(['project', 'profile', 'detect', PROJECT])).toThrow('明确确认');
    for (const flag of ['--path', '--input', '--revision']) {
      expect(() => parseAppCliArgs(['project', 'profile', 'detect', PROJECT, '--confirm', flag, '/tmp/untrusted'])).toThrow();
    }
  });
  it('[case:profile-query-input] parses profile get and match with explicit project scope', () => {
    expect(command(['project', 'profile', 'get', PROJECT])).toMatchObject({
      commandId: 'project.profile-get',
      projectId: PROJECT,
    });
    expect(command([
      'project', 'profile', 'match', '--project', PROJECT,
      '--language', 'typescript', '--required-module', 'test-vitest', '--scope', 'src',
    ])).toMatchObject({
      commandId: 'project.profile-match',
      projectId: PROJECT,
      languages: ['typescript'],
      requiredModuleIds: ['test-vitest'],
      scope: ['src'],
    });
  });

  it('[case:profile-write-authorization] requires revision, input and explicit confirmation for writes', () => {
    expect(command([
      'project', 'profile', 'confirm', '--project', PROJECT, '--revision', '1',
      '--input', '/tmp/profile.json', '--confirm', '--command-id', '11111111-1111-4111-8111-111111111112',
    ])).toMatchObject({
      commandId: 'project.profile-confirm', projectId: PROJECT, revision: 1, confirm: true,
      inputFile: '/tmp/profile.json',
    });
    expect(command([
      'project', 'profile', 'modify', PROJECT, '--revision', '2', '--input', '/tmp/profile.json', '--confirm',
    ])).toMatchObject({ commandId: 'project.profile-modify', projectId: PROJECT, revision: 2, confirm: true });
    expect(command([
      'project', 'profile', 'reject', PROJECT, '--revision', '3', '--confirm',
    ])).toMatchObject({ commandId: 'project.profile-reject', projectId: PROJECT, revision: 3, confirm: true });
  });

  it('[case:profile-explicit-confirmation] rejects missing confirmation, revision or input before Host I/O', () => {
    expect(() => parseAppCliArgs(['project', 'profile', 'confirm', PROJECT, '--revision', '1', '--input', '/tmp/profile.json']))
      .toThrow('明确确认');
    expect(() => parseAppCliArgs(['project', 'profile', 'confirm', PROJECT, '--input', '/tmp/profile.json', '--confirm']))
      .toThrow('缺少必填参数');
    expect(() => parseAppCliArgs(['project', 'profile', 'confirm', PROJECT, '--revision', '1', '--confirm']))
      .toThrow('缺少必填参数');
    expect(parseAppCliArgs(['project', 'profile', '--help'])).toMatchObject({ kind: 'help', scope: 'project' });
  });

  it('[case:profile-json-boundary] keeps parse and input failures structured on stdout with diagnostics on stderr', async () => {
    let stdout = '';
    let stderr = '';
    const io: AppCliIo = {
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    };
    const result = await runAppCli({
      args: ['project', 'profile', 'confirm', PROJECT, '--revision', '1', '--input', '/definitely/missing/profile.json', '--confirm', '--json'],
      io,
      platform: 'darwin',
    });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, command: 'project.profile-confirm', error: { code: 'invalid_input' } });
    expect(stderr).toContain('invalid_input');
    expect(stderr).not.toContain('/definitely/missing/profile.json');
  });
});
