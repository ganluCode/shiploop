import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { PiSubmissionToolDefinition } from './pi-adapter.js';
import { productionFilePath } from './production-pi-tools.js';
import { getRuntimePromptTemplates } from './prompt-templates.js';

export interface ProductionCommandOptions {
  readonly promptTemplates?: import('shiploop-core').PromptTemplateCatalog;
  readonly cwd: string;
  readonly deadline: number;
  readonly signal?: AbortSignal;
  readonly commandTimeoutMs?: number;
  readonly rgPath?: string;
  readonly environment?: Readonly<Record<string, string>>;
  /** Must stop the already-durably-owned Runner group. Never return to the model after uncertainty. */
  readonly terminateInvocation: (reason: string) => void;
}

/** Resolve on the trusted Host, before launching an environment-isolated Runner. */
export function resolveProductionRg(): string | undefined {
  return (process.env.PATH ?? '').split(':').filter(isAbsolute).map(dir => join(dir, 'rg')).find(existsSync);
}

/** Children inherit the durable Runner process group. No detached command or second supervisor. */
export function createProductionCommandTools(options: ProductionCommandOptions): PiSubmissionToolDefinition[] {
  const environment = { PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: 'en_US.UTF-8', ...options.environment };
  async function run(argv: string[], toolSignal?: AbortSignal) {
    if (options.signal?.aborted || toolSignal?.aborted || Date.now() >= options.deadline) throw new Error('tool_cancelled');
    const started = Date.now();
    const maxBytes = 65536;
    const chunks: Buffer[] = [];
    let observed = 0, retained = 0, fatal: string | null = null;
    const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, env: environment, detached: false,
      shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const terminate = (reason: string) => {
      if (fatal) return;
      fatal = reason;
      child.kill('SIGTERM');
      options.terminateInvocation(reason);
    };
    const abort = () => terminate('command_cancelled');
    const timer = setTimeout(() => terminate('command_timed_out'), Math.max(1,
      Math.min(options.commandTimeoutMs ?? 600000, options.deadline - started)));
    options.signal?.addEventListener('abort', abort, { once: true });
    toolSignal?.addEventListener('abort', abort, { once: true });
    const collect = (bytes: Buffer) => {
      observed += bytes.length;
      const part = bytes.subarray(0, Math.max(0, maxBytes - retained));
      retained += part.length;
      if (part.length) chunks.push(Buffer.from(part));
      if (observed > 8388608) terminate('command_output_overflow');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    try {
      const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', () => reject(new Error('command_spawn_failed')));
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
      });
      const details = { ...result, elapsedMs: Date.now() - started, outputBytes: retained,
        droppedOutputBytes: Math.max(0, observed - retained), reason: fatal };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...details,
        output: Buffer.concat(chunks).toString('utf8') }) }], details,
        isError: fatal !== null || (argv[0] === '/bin/sh' ? result.exitCode !== 0 : ![0, 1].includes(result.exitCode ?? -1)) };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      toolSignal?.removeEventListener('abort', abort);
    }
  }
  const templates = options.promptTemplates ?? getRuntimePromptTemplates();
  const execute: PiSubmissionToolDefinition = { name: 'execute_command', label: '执行命令', executionMode: 'sequential',
    description: templates.render('runtime/tools/execute_command.md'),
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
    async execute(_id, params, signal) {
      const command = (params as { command?: unknown }).command;
      if (typeof command !== 'string' || !command || command.includes('\0') || Buffer.byteLength(command) > 32768) throw new Error('command_invalid');
      return run(['/bin/sh', '-c', command], signal);
    } };
  const search = ['search_files', 'search_content'].map((name): PiSubmissionToolDefinition => ({
    name, label: name, executionMode: 'parallel', description: templates.render('runtime/tools/search.md'),
    parameters: { type: 'object', properties: { path: { type: 'string' }, pattern: { type: 'string' } },
      required: ['pattern'], additionalProperties: false },
    async execute(_id, params, signal) {
      const p = params as { path?: string; pattern?: string };
      if (typeof p.pattern !== 'string' || p.pattern.length > 4096 || p.pattern.includes('\0')) throw new Error('search_pattern_invalid');
      const path = p.path ?? '.';
      if (path !== '.') await productionFilePath(options.cwd, `${path}/.search-placeholder`, false);
      const rg = options.rgPath;
      if (!rg) throw new Error('search_rg_unavailable');
      const exclusions = ['!.git', '!node_modules', '!dist', '!build', '!coverage', '!pi-sessions'].flatMap(g => ['--glob', g]);
      return run([rg, ...exclusions, ...(name === 'search_files'
        ? ['--files', '--glob', p.pattern, '--', path]
        : ['--line-number', '--max-count', '100', '--max-columns', '500', '-e', p.pattern, '--', path])], signal);
    },
  }));
  return [execute, ...search];
}
