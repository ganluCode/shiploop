import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { git } from '../git-repo.ts';

/** Evidence lives outside disposable resources and is written even when assertions fail. */
export async function withGitFaultEvidence<T>(name: string, capture: () => unknown, body: () => Promise<T>): Promise<T> {
  const directory = process.env.P03_EVIDENCE_DIR
    ? resolve(process.env.P03_EVIDENCE_DIR, `f012-${name}-${randomUUID()}`)
    : mkdtempSync(join(tmpdir(), `shiploop-f012-${name}-evidence-`));
  mkdirSync(directory, { recursive: true });
  let failure: string | null = null;
  try { return await body(); }
  catch (error) { failure = String(error); throw error; }
  finally {
    let scene: unknown;
    try { scene = capture(); } catch (error) { scene = { captureError: String(error) }; }
    writeFileSync(join(directory, 'scene.json'), JSON.stringify({ taskId: 'F-012', name, failure,
      capturedBeforeTeardown: true, scene }, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(`F-012 evidence: ${join(directory, 'scene.json')}\n`);
  }
}

export function gitScene(root: string) {
  return { head: git(['rev-parse', 'HEAD'], root).trim(), tree: git(['rev-parse', 'HEAD^{tree}'], root).trim(),
    indexEntries: git(['ls-files', '--stage'], root), branch: git(['branch', '--show-current'], root).trim(),
    status: git(['status', '--porcelain=v1'], root), stash: git(['stash', 'list'], root),
    worktrees: git(['worktree', 'list', '--porcelain'], root) };
}
