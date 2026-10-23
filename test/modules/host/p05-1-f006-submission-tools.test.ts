/**
 * P05-1 / F-006 规划候选提交的 Host 通道与 Pi 自定义工具桥（脚本化，无付费模型）。
 *
 * 覆盖：
 * - 端到端接线：Pi 自定义工具（planning_candidate_submit）→ WorkToolClient（真实
 *   环回 HTTP + Bearer 受限凭据）→ Host 工具入口 → Core Work 工具桥 → 受管
 *   Artifact 发布与单候选绑定；副作用数量与持久回执可核对；
 * - 工具结果映射：完成/拒绝回执映射为脱敏 structuredContent；同命令重放经通道
 *   复用持久回执；通道错误映射为受控错误码的 isError 结果（不泄露原文）；
 * - Pi 接线边界：resolveSubmissionTools 按请求注入结构化工具并传到 session 工厂；
 *   工具定义形态校验（名字词法/去重/描述有界）；未提供装配时无自定义工具。
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createHostLifecycleServer, createHostStopController, createIdleActivityGate,
  createHostWorkToolAccess, createWorkToolClient,
  createPlanningCandidateSubmitTool, PLANNING_SUBMIT_TOOL_NAME,
  createPiRuntimeAdapter, validatePiSubmissionTools,
} from '../../../packages/host/src/index.ts';
import type { HostApplicationContext, LifecycleState } from '../../../packages/host/src/index.ts';
import type { PiSessionFactoryOptions, PiSubmissionToolDefinition } from '../../../packages/host/src/index.ts';
import type { CommandReceipt } from 'shiploop-core/protocol';
import { openPlanningSubmitFixture, SUBMIT_NOW } from '../../helpers/planning/p05-1-candidate-submit-fixture.ts';
import type { PlanningSubmitFixture } from '../../helpers/planning/p05-1-candidate-submit-fixture.ts';

beforeAll(() => { execFileSync(process.execPath, ['scripts/build-host-lock.ts'], { timeout: 60_000 }); });

async function servePlanningTool(f: PlanningSubmitFixture) {
  const workTools = createHostWorkToolAccess(f.channel);
  const grant = workTools.issue({
    schemaVersion: 1,
    context: {
      grantId: crypto.randomUUID(), principalId: f.binding.principal.principalId, projectId: f.projectId,
      hostInstanceId: f.hostInstanceId, identity: f.binding.identity, invocationId: f.invocationId,
      executionVersion: f.executionVersion, issuedAtUtcMs: SUBMIT_NOW - 100, expiresAtUtcMs: SUBMIT_NOW + 3_600_000,
      operations: ['task.read', 'planning.candidate.submit'],
    },
    runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2',
    authentication: { kind: 'local_login', sourceRef: crypto.randomUUID(), pluginId: null, environmentRefs: [] },
    resources: [],
  }, { ...f.binding, nowUtcMs: SUBMIT_NOW });
  const ownerToken = randomBytes(32).toString('hex');
  let lifecycle: LifecycleState = 'ready';
  const stop = createHostStopController({ activityGate: createIdleActivityGate(),
    getLifecycleState: () => lifecycle, setLifecycleState(next) { lifecycle = next; workTools.close(); },
    prepareTeardown: async () => {}, releaseAfterTeardown: async () => {} });
  // Any dispatch to owner services is a test failure; restricted calls use the real Core channel.
  const ownerSubmit = () => { throw new Error('unexpected owner dispatch'); };
  const server = createHostLifecycleServer({ hostInstanceId: f.hostInstanceId, dataRootIdentity: 'ab'.repeat(32),
    startedAt: new Date().toISOString(), pid: process.pid, authToken: ownerToken,
    getLifecycleState: () => lifecycle, getActivities: () => stop.getActivities(), stop,
    application: { workTools, principal: f.binding.principal, commandService: { submit: ownerSubmit },
      getLifecycleState: () => lifecycle } as unknown as HostApplicationContext,
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('invalid test listener');
  const client = createWorkToolClient({ port: address.port, token: grant.token });
  const tool = createPlanningCandidateSubmitTool({
    invoke: input => client.invoke(input),
    identity: f.binding.identity, projectId: f.projectId,
    invocationId: f.invocationId, executionVersion: f.executionVersion,
    nowIso: () => new Date(SUBMIT_NOW).toISOString(),
  });
  return {
    tool, client, grant,
    close: async () => { workTools.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); },
  };
}

describe('P05-1 / F-006 Host 通道与 Pi 工具桥', () => {
  it('[case:tool-bridge-e2e] 工具→真实环回 HTTP→Core 通道：发布单候选并返回脱敏回执摘要', async () => {
    const f = await openPlanningSubmitFixture();
    try {
      const host = await servePlanningTool(f);
      try {
        const body = f.candidateBody();
        const result = await host.tool.execute('tool-call-1', { candidate: body }, undefined) as {
          isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text: string }[];
        };
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ status: 'completed' });
        expect(typeof result.structuredContent?.candidateDigest).toBe('string');
        // 正文/凭据/路径不出现在工具结果中。
        const text = JSON.stringify(result);
        expect(text).not.toContain(body.slice(0, 40));
        expect(text).not.toContain(host.grant.token);
        // 持久副作用：恰好一份候选制品 + 单候选绑定 + 一条回执。
        const artifacts = f.snapshot().artifacts.filter(row => (row as { kind: string }).kind === 'planning-candidate');
        expect(artifacts).toHaveLength(1);
        expect(f.planningContext()).toMatchObject({ status: 'candidate_published' });
        expect((f.snapshot().command_receipts as { operation?: string }[]).filter(
          row => row.operation === 'planning.candidate.submit',
        )).toHaveLength(1);
      } finally { await host.close(); }
    } finally { f.close(); }
  });

  it('[case:tool-replay-and-errors] 工具层重放复用持久回执；非法候选与通道错误映射受控结果', async () => {
    const f = await openPlanningSubmitFixture();
    try {
      let commandId = crypto.randomUUID();
      const calls: unknown[] = [];
      const tool = createPlanningCandidateSubmitTool({
        invoke: async input => { calls.push(input); return f.bridge.invoke(input); },
        identity: f.binding.identity, projectId: f.projectId,
        invocationId: f.invocationId, executionVersion: f.executionVersion,
        newCommandId: () => commandId, nowIso: () => new Date(SUBMIT_NOW).toISOString(),
      });
      // 非法 JSON 候选（上下文仍 open 时提交）→ 拒绝回执 → isError + 受控原因。
      commandId = crypto.randomUUID();
      const rejected = await tool.execute('c3', { candidate: '{"broken": ' }, undefined) as {
        isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[];
      };
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toMatchObject({ status: 'rejected', reason: 'candidate_json_invalid' });
      const body = f.candidateBody();
      commandId = crypto.randomUUID();
      const first = await tool.execute('c1', { candidate: body }, undefined) as { structuredContent?: Record<string, unknown> };
      expect(first.structuredContent).toMatchObject({ status: 'completed', commandId });
      // 同命令重放：工具生成同 commandId → 通道复用持久回执（replayed 标记可见）。
      const replay = await tool.execute('c2', { candidate: body }, undefined) as { structuredContent?: Record<string, unknown> };
      expect(replay.structuredContent).toMatchObject({ status: 'completed', replayed: true });
      expect(calls).toHaveLength(3);
      // 参数缺失/非字符串 → 受控错误，不触通道。
      const missing = await tool.execute('c4', {}, undefined) as { isError?: boolean; content: { text: string }[] };
      expect(missing.isError).toBe(true);
      expect(calls).toHaveLength(3);
      // 通道错误（撤权）→ isError + 受控错误码，不回显原文。
      commandId = crypto.randomUUID();
      f.setCurrent(null);
      const denied = await tool.execute('c5', { candidate: body }, undefined) as { isError?: boolean; content: { text: string }[] };
      expect(denied.isError).toBe(true);
      expect(denied.content[0]?.text).toMatch(/planning_candidate_submit failed: [a-z_]+/);
    } finally { f.close(); }
  });

  it('[case:sdk-tool-wiring] resolveSubmissionTools 按请求注入并传到 session 工厂；未装配则无工具', async () => {
    const f = await openPlanningSubmitFixture();
    try {
      const tool = createPlanningCandidateSubmitTool({
        invoke: async () => { throw new Error('not reached'); },
        identity: f.binding.identity, projectId: f.projectId,
        invocationId: f.invocationId, executionVersion: f.executionVersion,
      });
      const captured: PiSessionFactoryOptions[] = [];
      const registration = createPiRuntimeAdapter({
        providers: [{ providerId: 'anthropic', models: ['claude-sonnet-2'] }],
        permissionGrants: [], isolationModes: ['trusted_project'],
        assembly: {
          agentDir: f.dataRoot,
          resolveWorkingDirectory: () => f.dataRoot,
          inputReader: { read: async () => 'prompt' },
          credentialRef: { kind: 'trusted-resolution', id: 'f006-offline' },
          resourceLoader: {} as never,
          resolveSubmissionTools: () => [tool],
        },
        sessionFactory: async (options) => {
          captured.push(options);
          throw new Error('stop-after-capture');
        },
      });
      const request = {
        schemaVersion: 1 as const, projectId: f.projectId, featureId: f.featureId, sessionId: 'session-1',
        executionVersion: f.executionVersion,
        owner: { principalId: 'principal-1', hostInstanceId: f.hostInstanceId },
        identity: f.binding.identity, invocationId: f.invocationId,
        strategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet-2' },
        prompt: ref('prompt'), inputManifest: ref('manifest'), cwd: { root: 'workspace' as const, relativePath: '.' },
        permissions: { grants: [], isolation: 'trusted_project' as const },
        limits: { timeoutMs: 1_000, maxEvents: 10, maxOutputBytes: 10_000 }, recovery: { mode: 'new' as const },
      };
      await expect(registration.adapter.start(request)).rejects.toThrow();
      expect(captured).toHaveLength(1);
      expect(captured[0]?.customTools).toEqual([tool]);
      // 未提供 resolveSubmissionTools → 不注入工具键。
      const bare: PiSessionFactoryOptions[] = [];
      const bareRegistration = createPiRuntimeAdapter({
        providers: [{ providerId: 'anthropic', models: ['claude-sonnet-2'] }],
        permissionGrants: [], isolationModes: ['trusted_project'],
        assembly: {
          agentDir: f.dataRoot,
          resolveWorkingDirectory: () => f.dataRoot,
          inputReader: { read: async () => 'prompt' },
          credentialRef: { kind: 'trusted-resolution', id: 'f006-offline' },
          resourceLoader: {} as never,
        },
        sessionFactory: async (options) => { bare.push(options); throw new Error('stop-after-capture'); },
      });
      await expect(bareRegistration.adapter.start(request)).rejects.toThrow();
      expect(bare[0]?.customTools).toBeUndefined();
      // 形态校验：非法名字/重复拒绝；合法通过。
      expect(() => validatePiSubmissionTools([{ ...tool, name: 'Bad Name' } as PiSubmissionToolDefinition])).toThrow();
      expect(() => validatePiSubmissionTools([tool, { ...tool }])).toThrow();
      expect(validatePiSubmissionTools([tool])).toEqual([tool]);
      expect(tool.name).toBe(PLANNING_SUBMIT_TOOL_NAME);
    } finally { f.close(); }
  });

  it('[case:client-envelope] WorkToolClient 信封校验接受规划提交操作', async () => {
    const f = await openPlanningSubmitFixture();
    try {
      const host = await servePlanningTool(f);
      try {
        // 非法操作（未知操作名）在客户端信封层拒绝。
        await expect(host.client.invoke(f.request({ operation: 'planning.candidate.replace' }))).rejects.toThrow();
        // 规划操作可送达（有效提交得到回执）。
        const receipt = await host.client.invoke(f.request()) as CommandReceipt;
        expect(receipt.operation).toBe('planning.candidate.submit');
        expect(receipt.status).toBe('completed');
      } finally { await host.close(); }
    } finally { f.close(); }
  });
});

function ref(purpose: string) {
  const digest = 'a'.repeat(64);
  return { projectId: 'p', artifactId: `artifact-${purpose}`, kind: 'execution-input', purpose,
    version: 1, contentHash: digest, sizeBytes: 10, locator: `execution-inputs/${purpose}`,
    mediaType: 'text/plain', origin: { kind: 'file' as const, root: 'workspace' as const, relativePath: `${purpose}.txt` } };
}
