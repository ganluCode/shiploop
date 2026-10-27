/** F-007 受控 Pi Runner 子进程：真实 Pi 适配器/Runner 协议，经环回 HTTP 调用受限提交工具。 */
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import { runPiWorkRunner } from '../../../packages/host/src/runtime/pi-runner.ts';
import { createPiRuntimeAdapter } from '../../../packages/host/src/runtime/pi-adapter.ts';
import { createPlanningCandidateSubmitTool } from '../../../packages/host/src/runtime/work-submission-tools.ts';

const port = Number(process.env.SHIPLOOP_F007_BRIDGE_PORT ?? '');
if (!Number.isInteger(port) || port <= 0) throw new Error('SHIPLOOP_F007_BRIDGE_PORT missing');
const base = `http://127.0.0.1:${port}`;
let listener: ((event: unknown) => void) | undefined;

async function relay(pathname: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}${pathname}`, body === undefined ? { method: 'GET' } : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`bridge relay failed: ${response.status}`);
  return await response.json();
}

const registration = createPiRuntimeAdapter({
  providers: [{ providerId: 'provider', models: ['model'] }], permissionGrants: [], isolationModes: ['trusted_project'],
  assembly: {
    agentDir: process.cwd(),
    resolveWorkingDirectory: () => process.cwd(),
    credentialRef: { kind: 'trusted-resolution', id: 'offline-f007-bridge' },
    inputReader: { read: async () => 'offline bound planning input' },
    resourceLoader: {} as NonNullable<CreateAgentSessionOptions['resourceLoader']>,
    resolveSubmissionTools: async request => {
      const work = request.identity;
      if (work.purpose !== 'work') throw new Error('work identity required');
      return [createPlanningCandidateSubmitTool({
        invoke: async input => relay('/planning-submit', input) as never,
        identity: { purpose: 'work', runId: work.runId, taskId: work.taskId, attemptId: work.attemptId },
        projectId: request.projectId,
        invocationId: request.invocationId,
        executionVersion: request.executionVersion,
      })];
    },
  },
  sessionFactory: async ({ customTools }) => {
    const tool = (customTools ?? [])[0] as
      | { execute(toolCallId: string, args: Record<string, unknown>): Promise<unknown> }
      | undefined;
    if (tool === undefined) throw new Error('planning submission tool missing');
    return {
      sessionId: 'offline-f007-planning-session',
      subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
      async prompt() {
        const candidate = String(await relay('/planning-candidate'));
        const result = await tool.execute('planning-submit-1', { candidate });
        if ((result as { isError?: boolean }).isError === true) {
          throw new Error(`planning submission rejected: ${JSON.stringify(result)}`);
        }
        listener?.({ type: 'message_end', message: { id: 'message-1', role: 'assistant',
          content: [{ text: 'Pi planning evidence' }], usage: { input: 6, output: 3 } } });
        listener?.({ type: 'agent_settled' });
      },
      async waitForIdle() {}, async abort() {}, dispose() {},
    };
  },
});
await runPiWorkRunner({
  adapter: registration.adapter,
  input: process.stdin,
  write: bytes => new Promise<void>((resolve, reject) => {
    process.stdout.write(bytes, error => { if (error) reject(error); else resolve(); });
  }),
});
