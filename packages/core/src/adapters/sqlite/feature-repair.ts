import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import type { SqliteStorageSession } from './session.js';
import type { WorkRuntimeFactory } from '../work-execution.js';
import type { RuntimeCapabilityCatalog } from '../../ports/runtime-capabilities.js';
import type { RuntimeExecutionRequest } from '../../ports/runtime-execution.js';
import type { ResolvedFeatureAutoFixPolicy } from '../../application/feature-auto-fix-policy.js';
import type { ArtifactPublisher } from '../../application/artifact-publish.js';
import type { ProjectResourceService } from '../../application/project-resource-service.js';
import { createLocalOwnerPrincipal } from '../../ports/authorization.js';
import { createStaticRuntimeRegistry } from '../../ports/runtime-registry.js';
import { createRuntimeExecutionService } from '../../application/runtime-execution.js';
import type { EffectiveSettings } from '../../application/effective-settings.js';
import { observeWithin } from '../../application/execution-supervision.js';
import { loadBuiltinPromptTemplates } from '../fs/prompt-templates.js';
import { publishRuntimeDocumentContext } from '../runtime-document-context.js';
import { integrationRepairReservedTokens } from './integration-repair-budget.js';

type RepairPolicy = Extract<ResolvedFeatureAutoFixPolicy, { status: 'ready' }>;

/** A separate, durably budgeted repair writer under the existing Feature dispatch lease.
 * It never revives a passed Task, manufactures a Task Attempt, or marks checks passed. */
export async function executeFeatureRepair(options: {
  session: SqliteStorageSession; runtimeFactory: WorkRuntimeFactory; capabilityCatalog: RuntimeCapabilityCatalog;
  publisher: ArtifactPublisher; projectResources?: ProjectResourceService; dataRoot: string;
  projectId: string; featureId: string; runId: string; ordinal: number; inputDigest: string;
  ownerId: string; hostInstanceId: string; cwd: string; policy: RepairPolicy;
  parentDeadline: number; failures: unknown; checkScope: unknown;
  signal: AbortSignal; assertCurrent(): void; now(): number;
  effectiveSettings?: (projectId: string) => EffectiveSettings;
  managedContext?: { ref: RuntimeExecutionRequest['inputManifest']; content: Uint8Array };
}): Promise<{ stopped: boolean; repaired: boolean }> {
  const o = options, db = o.session.database;
  const priorLocale = db.prepare('SELECT locale FROM feature_repair_attempts WHERE project_id=? AND run_id=? ORDER BY ordinal LIMIT 1').get(o.projectId, o.runId) as { locale: string } | undefined;
  const templates = loadBuiltinPromptTemplates(priorLocale?.locale ?? o.effectiveSettings?.(o.projectId).locale ?? 'en-US');
  const repairPrompt = templates.render('repair/feature.md', { failures: JSON.stringify(o.failures), checkScope: JSON.stringify(o.checkScope) })
    + '\n\n' + templates.render('runtime/reply-language.md');
  let tokenLimit = o.policy.maxTokenTotal === undefined ? Number.MAX_SAFE_INTEGER : Math.floor(o.policy.maxTokenTotal / o.policy.maxRepairs);
  const prior = db.prepare('SELECT MIN(deadline) AS deadline FROM feature_repair_attempts WHERE project_id=? AND run_id=?')
    .get(o.projectId, o.runId) as { deadline: number | null };
  const deadline = Math.min(o.parentDeadline, prior.deadline ?? o.now() + (o.policy.timeoutMs ?? (o.parentDeadline - o.now())));
  if (tokenLimit < 1 || deadline <= o.now()) return { stopped: true, repaired: false };
  o.assertCurrent();
  o.session.transactWrite('FeatureRepair.reserve', () => {
    const parent = db.prepare(`SELECT b.* FROM execution_batches b JOIN runs r ON r.batch_id=b.id
      WHERE r.project_id=? AND r.id=?`).get(o.projectId, o.runId) as
      { id: string; status: string; runtime_starts: number; budget_snapshot: string; deadline_at: number } | undefined;
    if (!parent || !['queued', 'running'].includes(parent.status)) throw new Error('feature_repair_parent_inactive');
    const limits = JSON.parse(parent.budget_snapshot).batch as { maxRuntimeStarts: number; maxTokenTotal?: number; maxCostTotal?: number };
    if (parent.runtime_starts >= limits.maxRuntimeStarts || parent.deadline_at <= o.now()) throw new Error('feature_repair_parent_budget');
    if (limits.maxCostTotal !== undefined) throw new Error('feature_repair_cost_budget_unconfirmed');
    if (limits.maxTokenTotal !== undefined) {
      let used = integrationRepairReservedTokens(o.session, o.projectId, parent.id);
      const coding = db.prepare(`SELECT a.usage_summary FROM attempts a JOIN runs r ON r.id=a.run_id
        WHERE a.project_id=? AND r.batch_id=?`).all(o.projectId, parent.id) as { usage_summary: string | null }[];
      for (const item of coding) {
        const usage = item.usage_summary === null ? null : JSON.parse(item.usage_summary);
        if (!Number.isSafeInteger(usage?.inputTokens) || !Number.isSafeInteger(usage?.outputTokens)) throw new Error('feature_repair_parent_usage_unknown');
        used += usage.inputTokens + usage.outputTokens;
      }
      const repairs = db.prepare(`SELECT a.token_limit FROM feature_repair_attempts a JOIN runs r ON r.id=a.run_id
        WHERE a.project_id=? AND r.batch_id=?`).all(o.projectId, parent.id) as { token_limit: number }[];
      // Every repair permanently consumes its full reservation; unknown usage never refunds a grant.
      used += repairs.reduce((sum, row) => sum + row.token_limit, 0);
      const gitRepairs = db.prepare(`SELECT a.max_tokens FROM git_agent_repair_attempts a JOIN git_agent_repairs r ON r.repair_id=a.repair_id
        WHERE r.project_id=? AND r.batch_id=?`).all(o.projectId, parent.id) as { max_tokens: number }[];
      used += gitRepairs.reduce((sum, row) => sum + row.max_tokens, 0);
      if (!Number.isSafeInteger(used) || used >= limits.maxTokenTotal) throw new Error('feature_repair_parent_token_budget');
      tokenLimit = Math.min(tokenLimit, limits.maxTokenTotal - used);
    }
    const existing = db.prepare('SELECT ordinal FROM feature_repair_attempts WHERE project_id=? AND run_id=? AND ordinal=?').get(o.projectId, o.runId, o.ordinal);
    if (existing) throw new Error('feature_repair_already_reserved');
    db.prepare(`INSERT INTO feature_repair_attempts
      (id,project_id,run_id,ordinal,strategy,input_digest,status,token_limit,deadline,locale)
      VALUES (?,?,?,?,?,?,'reserved',?,?,?)`).run(`${o.runId}:${o.ordinal}`, o.projectId, o.runId, o.ordinal, JSON.stringify(o.policy.strategy), o.inputDigest, tokenLimit, deadline, templates.locale);
    const updated = db.prepare(`UPDATE execution_batches SET runtime_starts=runtime_starts+1,revision=revision+1,updated_at=?
      WHERE id=? AND runtime_starts=? AND status IN ('queued','running')`).run(o.now(), parent.id, parent.runtime_starts);
    if (updated.changes !== 1) throw new Error('feature_repair_parent_budget_changed');
  });
  const id = createHash('sha256').update(`${o.projectId}:${o.runId}:${o.ordinal}`).digest('hex').slice(0, 24);
  const bodies = new Map<string, { content: Uint8Array; ref: RuntimeExecutionRequest['prompt'] }>();
  if (o.managedContext) bodies.set(o.managedContext.ref.purpose, o.managedContext);
  async function publish(purpose: string, kind: string, text: string) {
    const bytes = Buffer.from(text);
    if (bytes.length > (purpose === 'recording' ? 8388608 : 262144)) throw new Error('feature_repair_input_limit');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const locator = `feature-repairs/${o.runId}/${o.ordinal}/${purpose}.json`;
    const published = await o.publisher.publishArtifact({ projectId: o.projectId, kind,
      mediaType: purpose === 'prompt' ? 'text/plain' : 'application/json', expectedHash: digest, locator, content: [bytes] });
    const ref = { projectId: o.projectId, artifactId: published.artifact.id, kind, purpose, version: published.artifact.version,
      contentHash: digest, sizeBytes: bytes.length, locator, mediaType: published.artifact.mediaType,
      origin: { kind: 'file' as const, root: 'managed-work', relativePath: locator } };
    bodies.set(purpose, { content: bytes, ref });
    return ref;
  }
  const prompt = await publish('prompt', 'feature-repair-prompt', repairPrompt);
  const manifest = await publish('manifest', 'feature-repair-manifest', JSON.stringify({ schemaVersion: 1,
    locale: templates.locale, projectId: o.projectId, featureId: o.featureId, runId: o.runId, ordinal: o.ordinal,
    promptTemplates: templates.provenance(['repair/feature.md', 'runtime/reply-language.md']),
    productionLimits: { maxRequests: o.policy.maxTurns ?? 10000, tokenLimit }, prompt }));
  const request: RuntimeExecutionRequest = { schemaVersion: 1, projectId: o.projectId, featureId: o.featureId,
    sessionId: `repair-session-${id}`, executionVersion: o.ordinal,
    owner: { principalId: o.ownerId, hostInstanceId: o.hostInstanceId },
    identity: { purpose: 'work', runId: o.runId, taskId: `repair-task-${id}`, attemptId: `repair-attempt-${id}` },
    invocationId: `repair-invocation-${id}`, strategy: o.policy.strategy, prompt, inputManifest: manifest,
    cwd: { root: 'managed-work', relativePath: relative(o.dataRoot, o.cwd).split('\\').join('/') },
    permissions: { isolation: 'trusted_project', grants: [] },
    limits: { timeoutMs: Math.max(1000, deadline - o.now()), toolTimeoutMs: Math.min(600000, Math.max(1000, deadline - o.now())),
      maxEvents: 10000, maxOutputBytes: 8388608 }, recovery: { mode: 'new' } };
  const runtime = o.runtimeFactory({ capabilityCatalog: o.capabilityCatalog, workspaceRoots: { 'managed-work': o.dataRoot },
    publishDocumentContext: (request, content) => publishRuntimeDocumentContext(o.publisher, request, content),
    effectiveSettings: o.effectiveSettings,
    reader: () => ({ list: () => [...bodies.values()].map(body => body.ref), async read(purpose) {
      if (typeof purpose !== 'string') throw new Error('feature_repair_input_missing');
      const body = bodies.get(purpose);
      if (!body) throw new Error('feature_repair_input_missing');
      return { purpose, artifactId: body.ref.artifactId, contentHash: body.ref.contentHash, sizeBytes: body.ref.sizeBytes, content: body.content };
    } }),
    projectResourceSelection: o.projectResources ? projectId => o.projectResources!.snapshotForAttempt(createLocalOwnerPrincipal(), projectId) : undefined,
    loadSelectedSkills: o.projectResources ? projectId => o.projectResources!.loadSelectedSkills(createLocalOwnerPrincipal(), projectId) : undefined,
    async commitCommandIdentity(identity, actual) {
      o.assertCurrent();
      if (actual.invocationId !== request.invocationId) throw new Error('feature_repair_identity_changed');
      o.session.transactWrite('FeatureRepair.confirmProcess', () => {
        const changed = db.prepare(`UPDATE feature_repair_attempts SET process_identity=?,status='running'
          WHERE project_id=? AND run_id=? AND ordinal=? AND status='reserved' AND process_identity IS NULL`)
          .run(JSON.stringify(identity), o.projectId, o.runId, o.ordinal);
        if (changed.changes !== 1) throw new Error('feature_repair_launch_not_authorized');
      });
      o.assertCurrent();
      return { launchId: identity.launchId };
    } });
  const service = createRuntimeExecutionService({ configuration: o.capabilityCatalog,
    registry: createStaticRuntimeRegistry(runtime.entries, o.capabilityCatalog) });
  o.assertCurrent();
  const handle = await service.start(request);
  let terminate!: () => void;
  const terminating = new Promise<void>(resolve => { terminate = resolve; });
  const abort = () => { terminate(); void handle.cancel().catch(() => undefined); };
  o.signal.addEventListener('abort', abort, { once: true });
  if (o.signal.aborted) abort();
  const timer = setTimeout(abort, Math.max(1, deadline - o.now()));
  const events: unknown[] = [];
  let bytes = 0;
  const drain = (async () => {
    for await (const event of handle.events) {
      bytes += Buffer.byteLength(JSON.stringify(event));
      if (events.length >= 10000 || bytes > 7340032) { abort(); throw new Error('feature_repair_recording_limit'); }
      events.push(event);
    }
  })();
  void drain.catch(abort);
  try {
    const result = await Promise.race([handle.result, terminating.then(() => { throw new Error('feature_repair_cancelled'); })]);
    if (await observeWithin(drain.then(() => true), 2000) !== true) throw new Error('feature_repair_drain_unconfirmed');
    const stop = await observeWithin(handle.stopped, 2000) ?? { confirmed: false };
    const usage = result.usage;
    const tokens = usage?.inputTokens !== null && usage?.inputTokens !== undefined
      && usage.outputTokens !== null ? usage.inputTokens + usage.outputTokens
        + (usage.cacheReadIncludedInInput === false ? usage.cacheReadTokens ?? 0 : 0)
        + (usage.cacheWriteIncludedInInput === false ? usage.cacheWriteTokens ?? 0 : 0) : null;
    const record = await publish('recording', 'feature-repair-recording', JSON.stringify({ events, result, stop }));
    o.session.transactWrite('FeatureRepair.settle', () => {
      db.prepare(`UPDATE feature_repair_attempts SET status=?,tokens_used=?,result_ref=?,stop_confirmed=?
        WHERE project_id=? AND run_id=? AND ordinal=?`).run(!stop.confirmed ? 'uncertain' : result.terminal === 'completed' ? 'completed' : 'failed',
        tokens, record.artifactId, stop.confirmed ? 1 : 0, o.projectId, o.runId, o.ordinal);
    });
    return { stopped: stop.confirmed, repaired: stop.confirmed && result.terminal === 'completed' && !o.signal.aborted
      && (tokens === null || tokens <= tokenLimit) };
  } catch (error) {
    abort();
    const stop = await observeWithin(handle.stopped.catch(() => ({ confirmed: false })), 2000) ?? { confirmed: false };
    o.session.transactWrite('FeatureRepair.fail', () => {
      db.prepare('UPDATE feature_repair_attempts SET status=?,stop_confirmed=? WHERE project_id=? AND run_id=? AND ordinal=?')
        .run(stop.confirmed ? 'failed' : 'uncertain', stop.confirmed ? 1 : 0, o.projectId, o.runId, o.ordinal);
    });
    throw error;
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener('abort', abort);
  }
}
