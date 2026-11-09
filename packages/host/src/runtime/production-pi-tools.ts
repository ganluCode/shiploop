import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { PiSubmissionToolDefinition } from './pi-adapter.js';
import { getRuntimePromptTemplates } from './prompt-templates.js';

export async function productionFilePath(cwd: string, value: unknown, createParents: boolean): Promise<string> {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\0')
    || value.split(/[\\/]/).some(part => part === '..' || part === '.git')) throw new Error('file_path_rejected');
  const target = resolve(cwd, value), rel = relative(cwd, target);
  if (!rel || rel.startsWith('../') || isAbsolute(rel)) throw new Error('file_path_rejected');
  let current = cwd;
  for (const part of rel.split('/').slice(0, -1)) {
    current = join(current, part);
    if (createParents) await mkdir(current, { recursive: false }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('file_path_rejected');
  }
  const stat = await lstat(target).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error('file_path_rejected');
  return target;
}

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Reads only AGENTS.md files applicable to an explicit target, bounded by the worktree root. */
export async function loadProductionInstructions(cwd: string, target = '.') {
  const directory = target === '.' ? cwd : dirname(await productionFilePath(cwd, target, false).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return resolve(cwd, target);
  }));
  const relativeDir = relative(cwd, directory);
  const parts = relativeDir ? relativeDir.split('/') : [];
  const records: { path: string; content: string; sha256: string }[] = [];
  let total = 0;
  for (let depth = 0; depth <= parts.length; depth++) {
    const path = [...parts.slice(0, depth), 'AGENTS.md'].join('/');
    try {
      const file = await open(await productionFilePath(cwd, path, false), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32768 || total + stat.size > 98304) throw new Error('project_instructions_limit');
        const bytes = await file.readFile();
        total += bytes.length;
        if (bytes.length > 32768 || total > 98304) throw new Error('project_instructions_limit');
        records.push({ path, content: new TextDecoder('utf8', { fatal: true }).decode(bytes), sha256: hash(bytes) });
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return records;
}

/** GitAgent gets file operations only, with no live instruction discovery or command capability. */
export function createProductionGitAgentTools(options: Parameters<typeof createProductionFileTools>[0] & { writablePaths: readonly string[] }): PiSubmissionToolDefinition[] {
  return createProductionFileTools(options).filter(tool => tool.name !== 'read_project_instructions');
}

export function createProductionFileTools(options: { cwd: string; deadline: number; signal?: AbortSignal; promptTemplates?: import('shiploop-core').PromptTemplateCatalog; writablePaths?: readonly string[] }): PiSubmissionToolDefinition[] {
  const templates = options.promptTemplates ?? getRuntimePromptTemplates();
  return ['list_files', 'read_file', 'write_file', 'edit_file', 'read_project_instructions'].map(name => ({
    name, label: name, executionMode: 'sequential',
    description: templates.render(`runtime/tools/${name}.md`),
    parameters: { type: 'object', properties: { path: { type: 'string' },
      ...(name === 'write_file' ? { content: { type: 'string' } } : {}),
      ...(name === 'edit_file' ? { oldText: { type: 'string' }, newText: { type: 'string' }, expectedHash: { type: 'string' } } : {}) },
      required: name === 'write_file' ? ['path', 'content'] : name === 'edit_file' ? ['path', 'oldText', 'newText'] : ['path'], additionalProperties: false },
    async execute(_id, params, toolSignal) {
      const check = () => { if (options.signal?.aborted || toolSignal?.aborted || Date.now() >= options.deadline) throw new Error('tool_cancelled'); };
      check();
      const p = params as { path: string; content?: string; oldText?: string; newText?: string; expectedHash?: string };
      if (name === 'read_project_instructions') return { content: [{ type: 'text', text: JSON.stringify(await loadProductionInstructions(options.cwd, p.path)) }], details: {} };
      if (name === 'list_files') {
        const placeholder = p.path === '.' ? join(options.cwd, '.shiploop-list-placeholder')
          : await productionFilePath(options.cwd, `${p.path}/.shiploop-list-placeholder`, false);
        const entries = await readdir(dirname(placeholder), { withFileTypes: true });
        return { content: [{ type: 'text', text: entries.filter(e => e.name !== '.git').sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 200).map(e => e.name + (e.isDirectory() ? '/' : '')).join('\n') }], details: {} };
      }
      const writing = name === 'write_file' || name === 'edit_file';
      if (writing && options.writablePaths && !options.writablePaths.includes(p.path)) throw new Error('git_agent_path_not_authorized');
      const target = await productionFilePath(options.cwd, p.path, name === 'write_file');
      const file = await open(target, (writing ? constants.O_RDWR : constants.O_RDONLY)
        | (name === 'write_file' ? constants.O_CREAT : 0) | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('file_path_rejected');
        if (stat.size > (writing ? 1048576 : 262144)) throw new Error('file_size_limit');
        const before = await file.readFile();
        let content: string;
        if (name === 'read_file') return { content: [{ type: 'text', text: new TextDecoder('utf8', { fatal: true }).decode(before) }], details: { sha256: hash(before) } };
        if (name === 'edit_file') {
          if (typeof p.oldText !== 'string' || !p.oldText || typeof p.newText !== 'string') throw new Error('edit_invalid');
          if (p.expectedHash !== undefined && p.expectedHash !== hash(before)) throw new Error('edit_content_changed');
          const text = new TextDecoder('utf8', { fatal: true }).decode(before);
          const index = text.indexOf(p.oldText);
          if (index < 0) throw new Error('edit_match_missing');
          if (text.indexOf(p.oldText, index + 1) !== -1) throw new Error('edit_match_ambiguous');
          content = text.slice(0, index) + p.newText + text.slice(index + p.oldText.length);
        } else {
          if (typeof p.content !== 'string') throw new Error('file_content_required');
          content = p.content;
        }
        const after = Buffer.from(content, 'utf8');
        if (after.length > 1048576) throw new Error('file_size_limit');
        check();
        const current = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const latestStat = await current.stat();
          if (latestStat.ino !== stat.ino || latestStat.dev !== stat.dev || latestStat.nlink !== 1
            || latestStat.size > 1048576 || hash(await current.readFile()) !== hash(before)) throw new Error('edit_content_changed');
        } finally { await current.close(); }
        await file.truncate(0);
        for (let offset = 0; offset < after.length;) {
          const written = await file.write(after, offset, after.length - offset, offset);
          if (written.bytesWritten === 0) throw new Error('file_write_incomplete');
          offset += written.bytesWritten;
        }
        return { content: [{ type: 'text', text: 'written' }], details: { sha256: hash(after), outputBytes: after.length } };
      } finally { await file.close(); }
    },
  }));
}
