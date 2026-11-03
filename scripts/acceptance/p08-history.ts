import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Index historical evidence without converting historical decisions into current test results. */
export function verifyP08History(root: string, isAncestor: (commit: string) => boolean) {
  const path = join(root, 'acceptance/p08-history.json');
  if (!existsSync(path)) return { status: 'not_run' as const, refs: [] as string[], ownerReview: [] as string[] };
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (raw.schemaVersion !== 1 || raw.kind !== 'shiploop.p08.historical-evidence-index'
      || !Array.isArray(raw.entries) || raw.entries.length !== 7) throw new Error('history_index_invalid');
  const refs = ['acceptance/p08-history.json'];
  const seen = new Set<string>();
  const ownerReview: string[] = [];
  for (const item of raw.entries) {
    if (!/^P0[1-7]$/.test(item.phase) || seen.has(item.phase)
        || item.path !== `docs/acceptance/p08-history/${item.phase}.txt`
        || !/^[a-f0-9]{40}$/.test(item.commit) || !isAncestor(item.commit)
        || !/^[a-f0-9]{64}$/.test(item.sha256) || !/^[a-f0-9]{64}$/.test(item.originalSha256)
        || !['historical-report', 'owner-confirmation', 'owner-confirmation-original-missing'].includes(item.evidenceLevel)) throw new Error('history_identity_invalid');
    const file = join(root, item.path);
    for (const part of [join(root, 'docs'), join(root, 'docs/acceptance'), join(root, 'docs/acceptance/p08-history'), file]) {
      if (lstatSync(part).isSymbolicLink()) throw new Error('history_symlink_rejected');
    }
    if (!lstatSync(file).isFile() || createHash('sha256').update(readFileSync(file)).digest('hex') !== item.sha256) throw new Error('history_digest_mismatch');
    seen.add(item.phase); refs.push(item.path);
    if (item.evidenceLevel === 'owner-confirmation-original-missing') ownerReview.push(`${item.phase}:historical_original_report_missing`);
  }
  return { status: 'pass' as const, refs, ownerReview };
}
