import { describe, expect, it } from 'vitest';
import { runAppCli, type AppCliIo } from '../../../packages/cli/src/app-execute.ts';
import { withKnowledgeHost } from '../../helpers/host/knowledge-fixture.ts';
import {
  AppCliParseError,
  getAppCliHelp,
  parseAppCliArgs,
} from '../../../packages/cli/src/index.ts';

const PROJECT = '12345678-1234-4123-8234-1234567890ab';

function parse(args: readonly string[]) {
  const result = parseAppCliArgs(args);
  if (result.kind !== 'command') throw new Error('expected command');
  return result;
}

describe('P06-2 F-008 knowledge CLI', () => {
  it('[case:knowledge-args] parses bounded search and read scopes', () => {
    expect(parse([
      'knowledge', 'search', '--project', PROJECT, '--keyword', 'runner',
      '--document-id', 'docs-runtime', '--version', '2', '--limit', '5',
      '--snippet-max-chars', '80', '--max-read-bytes', '4096', '--max-candidates', '20', '--json',
    ])).toMatchObject({
      commandId: 'knowledge.search', projectId: PROJECT, keyword: 'runner',
      documentId: 'docs-runtime', version: 2, limit: 5,
      snippetMaxChars: 80, maxReadBytes: 4096, maxCandidates: 20, json: true,
    });
    expect(parse([
      'knowledge', 'read', 'docs-runtime', '--project', PROJECT, '--version', '2',
      '--max-read-bytes', '4096', '--json',
    ])).toMatchObject({
      commandId: 'knowledge.read', projectId: PROJECT, documentId: 'docs-runtime',
      version: 2, maxReadBytes: 4096, json: true,
    });
  });

  it('[case:knowledge-invalid-input] rejects empty queries, invalid versions, scope ambiguity and unknown options', () => {
    expect(() => parseAppCliArgs(['knowledge', 'search', '--project', PROJECT])).toThrow(AppCliParseError);
    expect(() => parseAppCliArgs(['knowledge', 'search', '--project', PROJECT, '--keyword', ''])).toThrow('不能为空');
    expect(() => parseAppCliArgs(['knowledge', 'search', '--project', PROJECT, '--keyword', 'x', '--version', '0'])).toThrow('version');
    expect(() => parseAppCliArgs(['knowledge', 'read', 'docs-runtime', '--document-id', 'other', '--project', PROJECT])).toThrow('scope');
    expect(() => parseAppCliArgs(['knowledge', 'read', 'docs-runtime', '--project', PROJECT, '--secret', 'x'])).toThrow('未知参数');
    expect(() => parseAppCliArgs(['knowledge', 'read', 'docs-runtime', '--project', 'other'])).toThrow('UUID');
  });

  it('[case:knowledge-cli-host-restart] reads registered knowledge through HostClient and keeps identity stable after restart', async () => {
    await withKnowledgeHost(async (fixture) => {
      const invoke = async (args: readonly string[]) => {
        let stdout = '';
        let stderr = '';
        const io: AppCliIo = {
          stdout: (text) => { stdout += text; },
          stderr: (text) => { stderr += text; },
        };
        const result = await runAppCli({ args, io, platform: 'darwin' });
        return { result, stdout, stderr };
      };
      const root = fixture.root;
      const searchArgs = [
        'knowledge', 'search', '--project', fixture.projectId, '--keyword', 'needle',
        '--data-root', root, '--json',
      ];
      const search = await invoke(searchArgs);
      expect(search.result.exitCode, search.stderr).toBe(0);
      const searchEnvelope = JSON.parse(search.stdout) as { ok: boolean; result: { projectId: string; results: readonly { documentId: string; version: number; contentHash: string }[]; budget: unknown; diagnostics: unknown } };
      expect(searchEnvelope.ok).toBe(true);
      expect(searchEnvelope.result.projectId).toBe(fixture.projectId);
      expect(searchEnvelope.result.results[0]).toMatchObject({ documentId: fixture.published.document.id, version: 1, contentHash: fixture.published.version.contentHash });
      expect(search.stdout).not.toContain(root);
      const read = await invoke([
        'knowledge', 'read', fixture.published.document.id, '--project', fixture.projectId,
        '--version', '1', '--data-root', root, '--json',
      ]);
      expect(read.result.exitCode, read.stderr).toBe(0);
      const readEnvelope = JSON.parse(read.stdout) as { ok: boolean; result: { projectId: string; documentId: string; version: number; contentHash: string; contentText: string; budget: unknown } };
      expect(readEnvelope.result).toMatchObject({ projectId: fixture.projectId, documentId: fixture.published.document.id, version: 1, contentHash: fixture.published.version.contentHash, contentText: fixture.body });
      expect(read.stdout).not.toContain(root);
      await fixture.restart();
      const reopened = await invoke([
        'knowledge', 'read', fixture.published.document.id, '--project', fixture.projectId,
        '--version', '1', '--data-root', root, '--json',
      ]);
      const reopenedEnvelope = JSON.parse(reopened.stdout) as { ok: boolean; result: { documentId: string; version: number; contentHash: string } };
      expect(reopened.result.exitCode, reopened.stderr).toBe(0);
      expect(reopenedEnvelope.result).toMatchObject({ documentId: readEnvelope.result.documentId, version: readEnvelope.result.version, contentHash: readEnvelope.result.contentHash });
    });
  });

  it('[case:knowledge-cli-no-results] maps empty search diagnostics to a failure exit without business success text', async () => {
    await withKnowledgeHost(async (fixture) => {
      let stdout = '';
      let stderr = '';
      const result = await runAppCli({
        args: ['knowledge', 'search', '--project', fixture.projectId, '--keyword', 'absent', '--data-root', fixture.root, '--json'],
        platform: 'darwin',
        io: { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
      });
      expect(result.exitCode).toBe(1);
      const envelope = JSON.parse(stdout) as { ok: boolean; error: { code: string; details: { budget: unknown; diagnostics: unknown } } };
      expect(envelope).toMatchObject({ ok: false, error: { code: 'no_results' } });
      expect(envelope.error.details).toHaveProperty('budget');
      expect(stderr).toContain('no_results');
    });
  });

  it('[case:knowledge-help] documents Host-backed bounded search/read and output boundaries', () => {
    const help = getAppCliHelp('knowledge');
    expect(help).toContain('knowledge search');
    expect(help).toContain('knowledge read');
    expect(help).toContain('--project');
    expect(help).toContain('HostClient');
    expect(help).toContain('不读取 SQLite');
  });
});

