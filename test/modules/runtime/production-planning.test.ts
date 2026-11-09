import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { openF007Fixture, F007_NOW_BASE } from '../../helpers/planning/p05-1-f007-fixture.ts';
import { randomUUID } from 'node:crypto';
import { createArtifactVerifier } from '../../../packages/core/src/application/artifact-verify.ts';

beforeAll(() => { execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-b', 'packages/core/tsconfig.json', 'packages/host/tsconfig.json'], { timeout: 60000 }); }, 65000);

it.each(['legacy', 'managed'] as const)('submits a candidate through production Pi without approving it: %s', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'production-planner-'));
  let fixture: Awaited<ReturnType<typeof openF007Fixture>> | undefined;
  let requests = 0;
  let submittedMessages = '';
  let declaredTools: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', bytes => chunks.push(bytes));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const tools = body.tools?.map((t: { function: { name: string } }) => t.function.name) ?? [];
      declaredTools = tools;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({
        id: `planning-${requests}`, object: 'chat.completion.chunk', created: 1, model: 'model',
        choices: [{ index: 0, delta, finish_reason }],
        ...(finish_reason ? { usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } } : {}),
      })}\n\n`);
      if (mode === 'managed') {
        const system = JSON.stringify(body.messages.filter((message: { role: string }) => message.role === 'system'));
        expect(system).toContain('prd/feature.md');
        expect(system).not.toContain('ORIGINAL_MANAGED_PRD');
        expect(system).not.toContain('CHANGED_MANAGED_PRD');
      }
      ++requests;
      if (mode === 'managed' && requests === 1) {
        event({ role: 'assistant', tool_calls: [{ index: 0, id: 'read-prd', type: 'function',
          function: { name: 'read_project_document', arguments: JSON.stringify({ path: 'prd/feature.md' }) } }] }, null);
        event({}, 'tool_calls');
      } else if (requests === (mode === 'managed' ? 2 : 1)) {
        if (mode === 'managed') expect(JSON.stringify(body.messages)).toContain('ORIGINAL_MANAGED_PRD');
        const candidate = JSON.parse(fixture!.candidateBody());
        if (mode === 'managed') candidate.plan.tasks.unshift({ id: 't-1', title: '既有草稿编码任务',
          acceptance: { criteria: ['草稿可规划'] }, dependsOn: [] });
        event({ role: 'assistant', tool_calls: [{ index: 0, id: 'planning-submit-1', type: 'function',
          function: { name: 'planning_candidate_submit', arguments: JSON.stringify({ candidate: JSON.stringify(candidate) }) } }] }, null);
        event({}, 'tool_calls');
      } else {
        submittedMessages = JSON.stringify(body.messages.filter((message: { role: string }) => message.role === 'tool'));
        event({ role: 'assistant', content: '候选已提交，等待人工审阅。' }, null);
        event({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    mkdirSync(join(root, 'pi'), { mode: 0o700 });
    writeFileSync(join(root, 'pi/auth.json'), JSON.stringify({ provider: { type: 'api_key', key: 'offline-key' } }), { mode: 0o600 });
    writeFileSync(join(root, 'pi/runtime.json'), JSON.stringify({ schemaVersion: 1, providers: [{ id: 'provider', models: ['model'],
      custom: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        contextWindow: 128000, maxTokens: 8192, reasoning: false } }] }), { mode: 0o600 });
    const built = await import(new URL('../../../packages/host/dist/runtime/production-pi.js', import.meta.url).href);
    const options = await built.productionPiOptions(root);
    fixture = await openF007Fixture({ prefix: 'production-planning-', workRuntimeFactory: options.workRuntimeFactory,
      ...(mode === 'managed' ? { managedPrd: '# ORIGINAL_MANAGED_PRD' } : {}),
      plannerCredentialRef: 'credential://pi/provider', runTimeLimitMs: 60000 });
    if (mode === 'managed') {
      const location = await fixture.core.managedDocuments.locations(fixture.box.localOwner(), fixture.projectId);
      writeFileSync(join(location.workingDirectory, 'prd/feature.md'), '# CHANGED_MANAGED_PRD');
    }
    await fixture.core.workExecution.scan();
    await expect.poll(() => fixture!.query('SELECT status FROM runs WHERE id=?', fixture!.planningRunId).status, { timeout: 30000 })
      .toMatch(/^(succeeded|failed|paused)$/);
    const facts = { requests, submittedMessages, run: fixture.query('SELECT status,reason FROM runs WHERE id=?', fixture.planningRunId),
      attempts: fixture.session.database.prepare('SELECT status,error_kind,diagnostic_ref FROM attempts WHERE task_id=?').all(fixture.planningTaskId),
      sessions: fixture.session.database.prepare('SELECT status,result_ref FROM sessions').all() };
    const resultRef = (facts.sessions[0] as { result_ref?: string } | undefined)?.result_ref;
    const diagnostic = resultRef ? await createArtifactVerifier({ artifacts: fixture.core.artifactStore, files: fixture.core.artifactFileStore,
      limits: { maxReadBytes: 1048576 } }).readVerifiedContent(fixture.projectId, resultRef) : null;
    expect(facts.run, JSON.stringify({ ...facts, diagnostic: diagnostic ? new TextDecoder().decode(diagnostic.content).slice(0, 4000) : null })).toMatchObject({ status: 'succeeded' });
    expect(fixture.query('SELECT status FROM planning_contexts WHERE run_id=?', fixture.planningRunId)).toMatchObject({ status: 'candidate_published' });
    expect(requests).toBe(mode === 'managed' ? 3 : 2);
    const recording = fixture.session.database.prepare(`SELECT diagnostics FROM recording_manifests
      WHERE project_id=? AND finalized=1 ORDER BY version DESC LIMIT 1`).get(fixture.projectId) as { diagnostics: string };
    expect(JSON.parse(recording.diagnostics)).toContain('request_connection_failures:0');
    expect(declaredTools).toContain('planning_candidate_submit');
    expect(declaredTools).toContain('read_project_document');
    const documentArtifact = fixture.session.database.prepare(`SELECT id FROM artifacts
      WHERE project_id=? AND kind='project-document-context' AND status='ready'`).get(fixture.projectId) as { id: string };
    expect(documentArtifact).toBeDefined();
    const documentContent = await createArtifactVerifier({ artifacts: fixture.core.artifactStore, files: fixture.core.artifactFileStore,
      limits: { maxReadBytes: 2097152 } }).readVerifiedContent(fixture.projectId, documentArtifact.id);
    expect(JSON.parse(new TextDecoder().decode(documentContent.content))).toMatchObject({
      schemaVersion: 1, projectId: fixture.projectId, documents: { schemaVersion: 1, featureMapped: mode === 'managed' },
    });
    if (mode === 'managed') {
      await expect.poll(async () => {
        await fixture!.core.workExecution.scan();
        const status = fixture!.query('SELECT status FROM execution_batches WHERE id=(SELECT batch_id FROM runs WHERE id=?)',
          fixture!.planningRunId).status;
        if (status !== 'succeeded') throw new Error(JSON.stringify({ status,
          dispatch: fixture!.core.workExecution.dispatchState(fixture!.projectId, fixture!.planningRunId) }));
        return status;
      }, { timeout: 45000 }).toBe('succeeded');
      const detail = await fixture.core.planningQueryService.getPlanningCandidate(fixture.box.localOwner(), { projectId: fixture.projectId, candidateId: fixture.candidateId });
      expect(detail.candidate.state).toBe('published');
      if (detail.candidate.state === 'published') {
        const body = await createArtifactVerifier({ artifacts: fixture.core.artifactStore, files: fixture.core.artifactFileStore,
          limits: { maxReadBytes: 2097152 } }).readVerifiedContent(fixture.projectId, detail.candidate.artifact.artifactId);
        const saved = JSON.parse(new TextDecoder().decode(body.content));
        expect(saved.plan.feature.sourceRefs).toHaveLength(1);
        const approval = await fixture.core.commandService.submit(fixture.box.localOwner(), { schemaVersion: 5,
          commandId: randomUUID(), issuedAt: new Date(F007_NOW_BASE).toISOString(), operation: 'planning.candidate.decide',
          scope: { kind: 'project', projectId: fixture.projectId }, expectedRevision: detail.context.targetRevision,
          payload: { candidateId: fixture.candidateId, candidateDigest: detail.candidate.candidateDigest, decision: 'approve', reason: 'offline test' } });
        expect(approval.status, JSON.stringify(approval)).toBe('completed');
        expect(JSON.parse(String(fixture.query('SELECT source_refs FROM features WHERE id=?', fixture.featureId).source_refs)))
          .toEqual(saved.plan.feature.sourceRefs);
      }
    }
    expect(declaredTools).not.toContain('execute_command');
    expect(declaredTools).not.toContain('write_file');
    expect(fixture.query('SELECT COUNT(*) AS n FROM runs WHERE purpose=\'code\'')).toEqual({ n: 0 });
  } finally {
    await fixture?.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
}, 90000);
