import { expect, it } from 'vitest';
import { isManagedWorkflow, parseManagedWorkflow, runManagedWorkflow } from '../../../packages/cli/src/managed-workflow.ts';
import { withKnowledgeHost } from '../../helpers/host/knowledge-fixture.ts';
import { randomUUID } from 'node:crypto';
import type { HostClient } from '../../../packages/host/src/index.ts';

it('keeps public conflict details and the generated command identity in JSON errors', async () => {
  let submittedId: string | undefined;
  const stdout: string[] = [], stderr: string[] = [];
  const result = await runManagedWorkflow({
    args: ['planning', 'start', 'feature-1', '--project', '11111111-1111-4111-8111-111111111111', '--json'],
    connect: async () => ({ close() {}, async getFeature() {
      return { feature: { id: 'feature-1', phaseId: 'phase-1', projectId: '11111111-1111-4111-8111-111111111111', revision: 1 } };
    }, async startPlanning(input: { commandId: string }) {
      submittedId = input.commandId;
      throw Object.assign(new Error('secret internal text'), { code: 'conflict', details: { reason: 'planning_retirement_required', runId: 'run-1' } });
    } } as unknown as HostClient),
    io: { stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
  });
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(stdout.join(''))).toMatchObject({ ok: false, command: 'planning.start', commandId: submittedId,
    error: { code: 'conflict', details: { reason: 'planning_retirement_required', runId: 'run-1' } } });
  expect(stdout.join('')).not.toContain('secret internal text');
});

it('routes the simple workflow without shadowing legacy planning input files', () => {
  expect(isManagedWorkflow(['planning', 'start', 'feature-1', '--project', 'p'])).toBe(true);
  expect(isManagedWorkflow(['planning', 'start', 'feature-1', '--input', 'request.json'])).toBe(false);
  const args = ['feature', 'create', '--project', '11111111-1111-4111-8111-111111111111', '--phase', 'phase-1', '--title', 'T', '--prd', 'prd/f01.md'];
  expect(parseManagedWorkflow(args).command).toBe('feature.create');
  expect(() => parseManagedWorkflow([...args, '--prd', 'duplicate.md'])).toThrow();
  expect(() => parseManagedWorkflow(['document', 'write', '--project', 'bad'])).toThrow();
});

it('returns JSON input errors and routes retirement with explicit CAS and replay timestamp', async () => {
  const stdout:string[]=[];
  expect((await runManagedWorkflow({args:['planning','retire','f-1','--json'],io:{stdout:t=>stdout.push(t),stderr:()=>{}}})).exitCode).toBe(2);
  expect(JSON.parse(stdout.pop()!)).toMatchObject({ok:false,error:{code:'invalid_input'}});
  const commandId=randomUUID(),projectId=randomUUID(),issuedAt=new Date().toISOString();
  let called:unknown;
  const client={ close(){}, async getReceipt(){return {issuedAt};}, async retirePlanning(input:unknown,options:unknown){called={input,options};
    return {status:'rejected',error:{code:'conflict',details:{reason:'planning_retirement_stop_unconfirmed'}}};} } as unknown as HostClient;
  const r=await runManagedWorkflow({args:['planning','retire','f-1','--project',projectId,'--context','ctx-1','--candidate','c-1',
    '--run','r-1','--revision','1','--workspace-revision','27','--command-id',commandId,'--json'],connect:async()=>client,
    io:{stdout:t=>stdout.push(t),stderr:()=>{}}});
  expect(r.exitCode).toBe(1);
  expect(called).toEqual({input:{projectId,featureId:'f-1',contextId:'ctx-1',candidateId:'c-1',runId:'r-1',expectedRevision:1,workspaceRevision:27,commandId},options:{issuedAt}});
  expect(JSON.parse(stdout.pop()!)).toMatchObject({ok:false,commandId,error:{code:'conflict',details:{reason:'planning_retirement_stop_unconfirmed'}}});
});

it('exposes the actual managed root through HostClient and persists safe drafts without touching Git', async () => withKnowledgeHost(async f => {
  const location = await f.client.getProjectDocuments(f.projectId);
  expect(location.workingDirectory).toContain(`/projects/${f.projectId}/documents/working`);
  const first = await f.client.writeProjectDocument(f.projectId, { path: 'prd/test.md', content: '# PRD' });
  expect(first.status).toBe('created');
  expect((await f.client.writeProjectDocument(f.projectId, { path: 'prd/test.md', content: '# PRD' })).status).toBe('unchanged');
  await expect(f.client.writeProjectDocument(f.projectId, { path: 'prd/test.md', content: '# overwrite' })).rejects.toThrow();
  expect((await f.client.writeProjectDocument(f.projectId, { path: 'prd/test.md', content: '# edited', expectedHash: first.sha256 })).status).toBe('updated');
  await expect(f.client.writeProjectDocument(f.projectId, { path: '../escape.md', content: 'bad' })).rejects.toThrow();
  const output: string[] = [];
  const result = await runManagedWorkflow({ args: ['project', 'documents', '--project', f.projectId, '--data-root', f.root, '--json'],
    io: { stdout: text => output.push(text), stderr: text => output.push(text) } });
  expect(result.exitCode, output.join('')).toBe(0);
  expect(JSON.parse(output.join('')).result.workingDirectory).toBe(location.workingDirectory);
  const created = await f.client.createPhase({ projectId: f.projectId, title: 'Managed planning' });
  if (created.status !== 'completed') throw new Error('phase creation failed');
  const phase = (created.result as { phase: { id: string } }).phase;
  const commandId = randomUUID();
  const args = ['feature', 'create', '--project', f.projectId, '--phase', phase.id, '--title', 'Example',
    '--prd', 'prd/test.md', '--command-id', commandId, '--data-root', f.root, '--json'];
  const run = async (arguments_: string[]) => {
    const output: string[] = [];
    const result = await runManagedWorkflow({ args: arguments_, io: { stdout: text => output.push(text), stderr: text => output.push(text) } });
    return { ...result, output: output.join('') };
  };
  const feature = await run(args);
  expect(feature.exitCode, feature.output).toBe(0);
  const repeated = await run(args);
  expect(repeated.exitCode, repeated.output).toBe(0);
  expect(JSON.parse(repeated.output).replayed).toBe(true);
  const changed = await run(args.map(value => value === 'Example' ? 'Different' : value));
  expect(changed.exitCode).toBe(1);
  expect(changed.output).toContain('receipt_conflict');
}));

it('starts planning without a request file and replays its frozen scope and budget', async () => {
  const projectId = '11111111-1111-4111-8111-111111111111', commandId = randomUUID();
  let request: Record<string, unknown> | undefined;
  let starts = 0, closes = 0;
  const accepted = { schemaVersion: 7, status: 'accepted', operation: 'planning.start', scope: { kind: 'project', projectId },
    candidateId: 'candidate-1', runId: 'run-1' };
  const client = {
    async getReceipt() { if (!request) throw Object.assign(new Error('missing'), { code: 'not_found' }); return accepted; },
    async getFeature() { return { feature: { id: 'feature-1', projectId, phaseId: 'phase-1', revision: 2 } }; },
    async startPlanning(input: Record<string, unknown>) { starts++; request = input; return accepted; },
    async getPlanningContext() { return { context: { featureId: 'feature-1', phaseId: 'phase-1', targetRevision: 2 },
      budget: { batch: { budget: request!.budget } } }; },
    close() { closes++; },
  } as unknown as HostClient;
  const args = ['planning', 'start', 'feature-1', '--project', projectId, '--command-id', commandId, '--json'];
  const run = async (values: string[]) => {
    const output: string[] = [];
    const result = await runManagedWorkflow({ args: values, connect: async () => client,
      io: { stdout: text => output.push(text), stderr: text => output.push(text) } });
    return { ...result, output: output.join('') };
  };
  const first = await run(args);
  expect(first.exitCode, first.output).toBe(0);
  expect(request).toMatchObject({ projectId, featureId: 'feature-1', phaseId: 'phase-1', expectedRevision: 2,
    managedDocuments: true, requirementRefs: [], strategy: { approvalMode: 'manual', taskLimit: null } });
  expect((await run(args)).exitCode).toBe(0);
  expect(starts).toBe(1);
  expect((await run(args.map(value => value === 'feature-1' ? 'feature-2' : value))).exitCode).toBe(1);
  expect(starts).toBe(1);
  expect(closes).toBe(3);
});
