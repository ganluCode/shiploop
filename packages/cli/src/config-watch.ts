import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { HostClient, SubmitCommandInput } from 'shiploop-host';
import { readSettingsFile } from './config-file.js';

/** Key order/comments do not cause writes; fallback array order remains significant. */
export function canonicalConfig(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, item]) => [k, canonical(item)])) : v;
  return JSON.stringify(canonical(value));
}

export async function watchProjectConfig(options: {
  readonly projectId: string;
  readonly inputFile: string;
  readonly client: Pick<HostClient, 'getProjectSettings' | 'submitCommand' | 'getReceipt'>;
  readonly io: { stdout(text: string): void; stderr(text: string): void };
  readonly json: boolean;
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
}): Promise<0 | 1 | 3> {
  const { client, projectId, signal, io } = options;
  let knownRevision: number | null | undefined;
  let applied: string | undefined, rejected: string | undefined;
  let invalid = false;
  const report = (event: string, detail: Record<string, unknown> = {}) => {
    if (options.json) io.stdout(JSON.stringify({ ok: !['invalid', 'rejected', 'conflict', 'connection_error'].includes(event), command: 'config.watch', event, ...detail }) + '\n');
    else (['invalid', 'rejected', 'conflict', 'connection_error'].includes(event) ? io.stderr : io.stdout)(`shiploop config watch: ${event} ${JSON.stringify(detail)}\n`);
  };
  async function sync(): Promise<0 | 1 | 3 | undefined> {
    let payload: Record<string, unknown>;
    try { payload = readSettingsFile(options.inputFile, 'config.watch', options.json); }
    catch {
      if (!invalid) report('invalid', { reason: 'config_file_invalid_previous_settings_retained' });
      invalid = true; return;
    }
    invalid = false;
    const signature = canonicalConfig(payload);
    let current: Awaited<ReturnType<HostClient['getProjectSettings']>> | null;
    try { current = await client.getProjectSettings(projectId); }
    catch (error) {
      if ((error as { code?: string }).code === 'not_found') current = null;
      else { report('connection_error', { reason: 'settings_read_failed' }); return 3; }
    }
    const revision = current?.revision ?? null;
    if (knownRevision !== undefined && revision !== knownRevision) {
      report('conflict', { reason: 'external_settings_change', expectedRevision: knownRevision, actualRevision: revision });
      return 1;
    }
    knownRevision = revision;
    if (signal?.aborted || signature === applied || signature === rejected) return;
    if (current && canonicalConfig(current.payload) === signature) {
      applied = signature; report('unchanged', { revision }); return;
    }
    const commandId = randomUUID();
    const input: SubmitCommandInput = { commandId, issuedAt: new Date().toISOString(),
      operation: current ? 'settings.project.update' : 'settings.project.create',
      scope: { kind: 'project', projectId }, ...(current ? { expectedRevision: current.revision } : {}), payload };
    report('pending', { commandId, expectedRevision: revision });
    let receipt: Awaited<ReturnType<HostClient['submitCommand']>>;
    try { receipt = await client.submitCommand(input); }
    catch {
      // Unknown outcomes are resolved using the original identity; never mint another ID.
      try { receipt = await client.getReceipt(commandId); }
      catch { report('connection_error', { commandId, reason: 'outcome_unknown_query_original_receipt' }); return 3; }
    }
    if (receipt.status === 'accepted') {
      report('connection_error', { commandId, reason: 'unexpected_async_settings_receipt' }); return 3;
    }
    if (receipt.status === 'rejected') {
      const conflict = receipt.error.code === 'conflict';
      report(conflict ? 'conflict' : 'rejected', { commandId, code: receipt.error.code, reason: 'previous_settings_retained' });
      if (conflict) return 1;
      rejected = signature; return;
    }
    const next = (receipt.result as { revision?: unknown }).revision;
    if (typeof next !== 'number' || !Number.isSafeInteger(next)) {
      report('connection_error', { commandId, reason: 'settings_revision_missing' }); return 3;
    }
    knownRevision = next; applied = signature; rejected = undefined;
    report('synced', { commandId, revision: next });
  }
  report('watching', { projectId });
  while (!signal?.aborted) {
    const exit = await sync();
    if (exit !== undefined) return exit;
    try { await delay(options.intervalMs ?? 1000, undefined, { signal }); }
    catch { if (!signal?.aborted) throw new Error('config_watch_wait_failed'); }
  }
  report('stopped');
  return 0;
}
