/**
 * F-013 HostClient 应用能力验收（P02-2 契约 §11.2）：命令提交（冻结信封、
 * 超时先查回执、有限重发、结果不确定）、回执/结果读取、查询与分页、
 * SSE 订阅（跨分块解析、有界去重、snapshot_required 恢复分支、本地资源纪律）。
 *
 * 覆盖（验收点）：
 * - 响应运行时校验：畸形回执/事件、未知版本 → 协议错误（response_malformed /
 *   unsupported_schema_version），accepted 回执绝不放行；
 * - 一次逻辑命令一个冻结信封：传输失败先查回执，有限预算内才以完全相同信封
 *   重发（issuedAt/expiresAt/payload/commandId 不重新生成）；连接失败不折算为
 *   业务拒绝或完成；预算耗尽 → outcome_unknown（不无限重试、不另起 Host）；
 * - 真实 Host 已提交但响应丢失：经丢弃代理取得原 completed/resultRef，
 *   数据库只发生一次副作用（探针计数）；
 * - 查询按既定分页/白名单参数请求；404 → not_found；畸形响应拒绝；
 * - SSE：跨分块 UTF-8、心跳忽略、eventId 有界去重、Last-Event-ID 自动重连
 *   （真实 Core 装配）、建连前 409 与建连后 error 帧的 snapshot_required 都是
 *   明确恢复分支；close/Abort 只释放本地观察资源，绝不触发 stop；
 * - 不跟随重定向（目标零请求、零收证）；输出（错误体/消息）不含凭据。
 *
 * 不读真实凭据、不调用模型、不修改开发仓库或用户 HOME。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_HOST_CAPABILITIES,
  CURRENT_PROTOCOL_VERSION,
  CURRENT_SCHEMA_VERSION,
  HANDSHAKE_ROUTE,
  HostProtocolError,
  SNAPSHOT_ROUTE,
  isHostProtocolError,
  connectToHost,
  startHost,
  createHostLifecycleServer,
  createHostStopController,
  createIdleActivityGate,
  createEventStreamHub,
  validateCommandReceiptWire,
  validateStateEventWire,
  validateAppQueryResponse,
  type AppQueryOperation,
  type HostClient,
  // F-013 新增公共面（RED 阶段尚不存在）：
  type EventStreamEnd,
  type HostEventSubscription,
  type SubmitCommandInput,
} from '../../../packages/host/src/index.ts';
import {
  computeCommandRequestDigest,
  createCompletedReceipt,
  createResultRef,
  isUuidV4,
  validateCommandEnvelope,
  type CommandReceipt,
  type PublicStateEvent,
} from '../../../packages/core/src/index.ts';
import type { CoreApplication } from '../../../packages/core/src/adapters/composition.ts';
import { createCommandsTestFixture, type CommandsTestFixture } from '../../helpers/p02-2/index.ts';
import { loopbackRequest } from '../../helpers/host/index.ts';
import { createIsolatedHostEnvironment } from '../../helpers/host/isolated-environment.ts';
import { publishLoopbackDiscovery } from '../../helpers/host/discovery-fixture.ts';
import { openStorageProbe } from '../../helpers/p02-2/storage-probe.ts';

const FIXTURE_CLOCK_ISO = new Date(1_900_000_000_000).toISOString();

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function expectProtocolError(error: unknown, code: string): HostProtocolError {
  expect(isHostProtocolError(error)).toBe(true);
  const protocolError = error as HostProtocolError;
  expect(protocolError.code).toBe(code);
  return protocolError;
}

function noSecret(value: unknown, token: string): void {
  const serialized = JSON.stringify(value) ?? '';
  expect(serialized).not.toContain(token);
  expect(serialized.includes('Bearer')).toBe(false);
}

async function rejectionOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('应当以错误拒绝，实际成功返回');
}

/** 断言 completed 并收窄回执类型（result/resultRef 仅 completed 变体持有）。 */
function asCompleted(receipt: CommandReceipt): Extract<CommandReceipt, { status: 'completed' }> {
  expect(receipt.status).toBe('completed');
  if (receipt.status !== 'completed') {
    throw new Error(`expected completed receipt, got ${receipt.status}`);
  }
  return receipt;
}

/* ------------------------------------------------------------------ *
 * 可编排应用面对端（真实 node:http，仅测试）
 * ------------------------------------------------------------------ */

type ScriptedResponse =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'redirect'; location: string }
  | { kind: 'drop' }
  | { kind: 'hang' }
  | {
      kind: 'sse';
      frames: string[];
      keepOpen?: boolean;
      /** 每帧按该字节数分块写入（跨分块 UTF-8/帧解析）；缺省整帧一次写入。 */
      chunkBytes?: number;
    };

interface ScriptedObservation {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly body: unknown;
  readonly bodyText: string;
  readonly bearerPresent: boolean;
  readonly lastEventId?: string;
  readonly accept?: string;
}

interface ScriptedAppServer {
  readonly port: number;
  readonly requests: ScriptedObservation[];
  readonly openSseConnections: () => number;
  setScript(
    handler: (observation: ScriptedObservation) => ScriptedResponse | Promise<ScriptedResponse>,
  ): void;
  close(): Promise<void>;
}

async function startScriptedAppServer(identity: {
  hostInstanceId: string;
  dataRootIdentity: string;
}): Promise<ScriptedAppServer> {
  const observations: ScriptedObservation[] = [];
  let script: (
    observation: ScriptedObservation,
  ) => ScriptedResponse | Promise<ScriptedResponse> = () => ({ kind: 'json', status: 404, body: { error: { code: 'unknown_operation', message: 'x', operation: 'commands.submit' } } });
  const sseConnections = new Set<import('node:http').IncomingMessage>();
  let seq = 0;
  let closed = false;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      let exceeded = false;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > 200_000) {
          exceeded = true;
          break;
        }
        chunks.push(chunk as Buffer);
      }
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const url = request.url ?? '/';
      const queryIndex = url.indexOf('?');
      const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
      const query = queryIndex === -1 ? '' : url.slice(queryIndex + 1);
      let body: unknown;
      if (bodyText.length > 0 && !exceeded) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = undefined;
        }
      }
      seq += 1;
      const authorization = request.headers.authorization;
      const observation: ScriptedObservation = {
        seq,
        method: request.method ?? '',
        path,
        query,
        body,
        bodyText,
        bearerPresent: typeof authorization === 'string' && authorization.startsWith('Bearer '),
        ...(typeof request.headers['last-event-id'] === 'string'
          ? { lastEventId: request.headers['last-event-id'] as string }
          : {}),
        ...(typeof request.headers.accept === 'string' ? { accept: request.headers.accept } : {}),
      };
      observations.push(observation);

      if (path === HANDSHAKE_ROUTE) {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(
          JSON.stringify({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            protocolVersion: CURRENT_PROTOCOL_VERSION,
            hostInstanceId: identity.hostInstanceId,
            dataRootIdentity: identity.dataRootIdentity,
            lifecycleState: 'ready',
            startedAt: new Date().toISOString(),
            capabilities: CURRENT_HOST_CAPABILITIES,
          }),
        );
        return;
      }

      const behavior = await script(observation);
      if (behavior.kind === 'json') {
        response.writeHead(behavior.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(behavior.body));
        return;
      }
      if (behavior.kind === 'redirect') {
        response.writeHead(302, { location: behavior.location, 'cache-control': 'no-store' });
        response.end();
        return;
      }
      if (behavior.kind === 'drop') {
        response.destroy();
        request.socket.destroy();
        return;
      }
      if (behavior.kind === 'hang') {
        return; // 既不响应也不关闭：触发客户端请求超时/中止。
      }
      // SSE
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'close',
      });
      sseConnections.add(request);
      const writeChunked = async (text: string): Promise<void> => {
        if (behavior.chunkBytes === undefined) {
          response.write(text);
          return;
        }
        const buffer = Buffer.from(text, 'utf8');
        for (let offset = 0; offset < buffer.length; offset += behavior.chunkBytes) {
          response.write(buffer.subarray(offset, Math.min(offset + behavior.chunkBytes, buffer.length)));
          await new Promise((resolveTick) => setImmediate(resolveTick));
        }
      };
      for (const frame of behavior.frames) {
        await writeChunked(frame);
      }
      if (behavior.keepOpen === true) {
        // IncomingMessage 'close' 在请求接收完成时即触发（GET 立即触发），不能
        // 用于断开判定；以 ServerResponse 'close'（连接终止）为准（F-012 同）。
        response.on('close', () => sseConnections.delete(request));
        return;
      }
      sseConnections.delete(request);
      response.end();
    })().catch(() => {
      try {
        response.destroy();
      } catch {
        // 尽力收尾。
      }
    });
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    requests: observations,
    openSseConnections: () => sseConnections.size,
    setScript(handler) {
      script = handler;
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
    },
  };
}

interface ScriptedSetup {
  readonly server: ScriptedAppServer;
  readonly client: HostClient;
  readonly token: string;
  readonly canonicalRoot: string;
  dispose(): Promise<void>;
}

async function setupScriptedClient(options?: {
  timeouts?: { appRequestMs?: number; submitBudgetMs?: number };
}): Promise<ScriptedSetup> {
  const environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-scripted-' });
  try {
    const root = environment.dataRoot();
    const credential = environment.mintHostCredential(root.canonicalRoot);
    const server = await startScriptedAppServer({
      hostInstanceId: credential.hostInstanceId,
      dataRootIdentity: credential.dataRootIdentity,
    });
    publishLoopbackDiscovery({
      canonicalRoot: root.canonicalRoot,
      port: server.port,
      hostInstanceId: credential.hostInstanceId,
      store: credential.store,
      token: credential.token,
    });
    const client = await connectToHost({
      canonicalRoot: root.canonicalRoot,
      ...(options?.timeouts === undefined ? {} : { timeouts: options.timeouts }),
    });
    return {
      server,
      client,
      token: credential.token,
      canonicalRoot: root.canonicalRoot,
      async dispose() {
        client.close();
        await server.close();
        await environment.dispose();
      },
    };
  } catch (error) {
    await environment.dispose();
    throw error;
  }
}

/** 由观察到的请求体构造合法 completed 回执（信封/摘要用 Core 同一纯函数）。 */
function receiptFor(observation: ScriptedObservation, overrides?: Partial<Record<string, unknown>>): CommandReceipt {
  const envelope = validateCommandEnvelope(observation.body);
  const digest = computeCommandRequestDigest(envelope);
  return createCompletedReceipt({
    commandId: envelope.commandId,
    principalId: 'local-owner',
    operation: envelope.operation,
    scope: envelope.scope,
    requestDigest: typeof overrides?.requestDigest === 'string' ? (overrides.requestDigest as string) : digest,
    issuedAt: envelope.issuedAt,
    completedAt: FIXTURE_CLOCK_ISO,
    result: { status: 'registered', project: { id: 'prj-f013' } },
    resultRef: createResultRef(randomBytes(32)),
  });
}

function registerInput(): SubmitCommandInput {
  return {
    operation: 'project.register',
    scope: { kind: 'registration' },
    issuedAt: FIXTURE_CLOCK_ISO,
    payload: {
      repositoryPath: '/tmp/does-not-matter-f013',
      displayName: 'F-013 scripted',
    },
  };
}

/* ------------------------------------------------------------------ *
 * A. Core 线上回执校验（纯函数）
 * ------------------------------------------------------------------ */

describe('F-013 Core 线上回执校验 validateWireCommandReceipt', () => {
  const baseReceipt = {
    schemaVersion: 5,
    commandId: randomUUID(),
    principalId: 'local-owner',
    operation: 'project.register',
    scope: { kind: 'registration' },
    requestDigest: 'a'.repeat(64),
    status: 'completed',
    result: { ok: true },
    resultRef: createResultRef(randomBytes(32)),
    issuedAt: FIXTURE_CLOCK_ISO,
    completedAt: FIXTURE_CLOCK_ISO,
    replayed: false,
  };

  it('接受合法 completed 回执（replayed true/false 均为线上合法）', async () => {
    const { validateWireCommandReceipt } = await import("../../../packages/core/src/index.ts");
    for (const replayed of [false, true]) {
      const receipt = validateWireCommandReceipt({ ...baseReceipt, replayed }, 'receipts.get');
      expect(receipt.status).toBe('completed');
      expect(receipt.replayed).toBe(replayed);
    }
  });

  it.each([
    ['accepted 状态', { ...baseReceipt, status: 'accepted', result: undefined, resultRef: undefined }],
    ['未知键', { ...baseReceipt, extra: 1 }],
    ['未知 schema 版本', { ...baseReceipt, schemaVersion: 6 }],
    ['坏 resultRef', { ...baseReceipt, resultRef: '../etc/passwd' }],
    ['rejected 携带 result', { ...baseReceipt, status: 'rejected', result: { ok: 1 }, resultRef: undefined, error: { code: 'conflict', message: '冲突' } }],
    ['error details 白名单外键', { ...baseReceipt, status: 'rejected', result: undefined, resultRef: undefined, error: { code: 'conflict', message: '冲突', details: { secret: 'x' } } }],
  ])('拒绝：%s', async (_label, bad) => {
    const { validateWireCommandReceipt, isStorageError } = await import("../../../packages/core/src/index.ts");
    let rejected = false;
    try {
      validateWireCommandReceipt(bad, 'receipts.get');
    } catch (error) {
      rejected = true;
      expect(isStorageError(error, 'validation')).toBe(true);
    }
    expect(rejected).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * B. 客户端响应校验器（纯函数，无网络）
 * ------------------------------------------------------------------ */

const SAMPLE_PROJECT = {
  id: 'prj-f013',
  displayName: 'F-013',
  description: null,
  status: 'registered',
  labels: ['alpha'],
  repositoryBindingId: null,
  revision: 1,
  createdAt: FIXTURE_CLOCK_ISO,
  updatedAt: FIXTURE_CLOCK_ISO,
};

const SAMPLE_EVENT: PublicStateEvent = {
  schemaVersion: 1,
  eventId: randomUUID(),
  sequence: 1,
  type: 'project.metadata_updated',
  scope: { kind: 'project', projectId: 'prj-f013' },
  aggregate: { type: 'project', id: 'prj-f013', revision: 2 },
  occurredAt: FIXTURE_CLOCK_ISO,
  payload: { changedFields: ['displayName'] },
};

describe('F-013 客户端响应校验器', () => {
  it('validateCommandReceiptWire：合法回执通过并核对身份/摘要', () => {
    const envelope = validateCommandEnvelope({
      schemaVersion: 5,
      commandId: randomUUID(),
      operation: 'project.register',
      scope: { kind: 'registration' },
      issuedAt: FIXTURE_CLOCK_ISO,
      payload: { repositoryPath: '/tmp/x', displayName: 'x' },
    });
    const digest = computeCommandRequestDigest(envelope);
    const receipt = createCompletedReceipt({
      commandId: envelope.commandId,
      principalId: 'local-owner',
      operation: envelope.operation,
      scope: envelope.scope,
      requestDigest: digest,
      issuedAt: envelope.issuedAt,
      completedAt: FIXTURE_CLOCK_ISO,
      result: { status: 'registered' },
      resultRef: createResultRef(randomBytes(32)),
      replayed: true,
    });
    const view = validateCommandReceiptWire(receipt, {
      expectedCommandId: envelope.commandId,
      expectedRequestDigest: digest,
      expectedOperation: 'project.register',
    });
    expect(view.replayed).toBe(true);
  });

  it.each([
    ['digest 不符', { expectedRequestDigest: 'b'.repeat(64) }, 'response_malformed'],
    ['commandId 不符', { expectedCommandId: randomUUID() }, 'response_malformed'],
    ['未知 schema 版本', { schemaVersion: 6 }, 'unsupported_schema_version'],
    ['accepted 回执', { status: 'accepted', result: undefined, resultRef: undefined }, 'response_malformed'],
  ])(
    'validateCommandReceiptWire 拒绝：%s → %s',
    (_label, patch, expectedCode) => {
      const receipt = {
        schemaVersion: 5,
        commandId: randomUUID(),
        principalId: 'local-owner',
        operation: 'project.register',
        scope: { kind: 'registration' },
        requestDigest: 'a'.repeat(64),
        status: 'completed',
        result: { ok: 1 },
        resultRef: createResultRef(randomBytes(32)),
        issuedAt: FIXTURE_CLOCK_ISO,
        completedAt: FIXTURE_CLOCK_ISO,
        replayed: false,
        ...patch,
      };
      const error = expectProtocolError(
        (() => {
          try {
            validateCommandReceiptWire(receipt, { expectedCommandId: receipt.commandId as string });
            throw new Error('应拒绝');
          } catch (caught) {
            return caught;
          }
        })(),
        expectedCode,
      );
      noSecret(error.toErrorBody(), 'irrelevant-token');
    },
  );

  it('validateStateEventWire：合法事件通过；未知类型/版本拒绝', () => {
    expect(validateStateEventWire(SAMPLE_EVENT).eventId).toBe(SAMPLE_EVENT.eventId);
    expectProtocolError(
      (() => {
        try {
          validateStateEventWire({ ...SAMPLE_EVENT, type: 'work.started' });
          throw new Error('应拒绝');
        } catch (caught) {
          return caught;
        }
      })(),
      'response_malformed',
    );
    expectProtocolError(
      (() => {
        try {
          validateStateEventWire({ ...SAMPLE_EVENT, schemaVersion: 2 });
          throw new Error('应拒绝');
        } catch (caught) {
          return caught;
        }
      })(),
      'unsupported_schema_version',
    );
  });

  it('validateAppQueryResponse：列表/详情/配置/快照正例通过', () => {
    const list = validateAppQueryResponse('projects.list', {
      schemaVersion: 5,
      scope: 'project-list',
      records: [SAMPLE_PROJECT],
      nextCursor: null,
      limit: 50,
    });
    expect(list.records).toHaveLength(1);
    const detail = validateAppQueryResponse('projects.get', { project: SAMPLE_PROJECT, binding: null });
    expect(detail.project.id).toBe('prj-f013');
    const snapshot = validateAppQueryResponse(
      'snapshot.get',
      {
        schemaVersion: 5,
        scope: { kind: 'project', projectId: 'prj-f013' },
        project: SAMPLE_PROJECT,
        binding: null,
        settings: null,
        effective: { configured: false, schemaVersion: 2, strategies: {}, policies: {} },
        watermark: { sequence: 2, cursor: 'evcur_v1_' + 'A'.repeat(48) },
        readAt: FIXTURE_CLOCK_ISO,
      },
      { scope: { kind: 'project', projectId: 'prj-f013' } },
    );
    expect(snapshot.watermark.sequence).toBe(2);
  });

  it('validateAppQueryResponse：未知键/错版本/scope 不符拒绝', () => {
    expectProtocolError(
      (() => {
        try {
          validateAppQueryResponse('projects.list', {
            schemaVersion: 5,
            scope: 'project-list',
            records: [],
            nextCursor: null,
            limit: 50,
            extra: 1,
          });
          throw new Error('应拒绝');
        } catch (caught) {
          return caught;
        }
      })(),
      'response_malformed',
    );
    expectProtocolError(
      (() => {
        try {
          validateAppQueryResponse('projects.list', {
            schemaVersion: 6,
            scope: 'project-list',
            records: [],
            nextCursor: null,
            limit: 50,
          });
          throw new Error('应拒绝');
        } catch (caught) {
          return caught;
        }
      })(),
      'unsupported_schema_version',
    );
    expectProtocolError(
      (() => {
        try {
          validateAppQueryResponse('snapshot.get', {
            schemaVersion: 5,
            scope: { kind: 'global' },
            settings: null,
            watermark: { sequence: 0, cursor: 'evcur_v1_x' },
            readAt: FIXTURE_CLOCK_ISO,
          }, { scope: { kind: 'project', projectId: 'prj-f013' } });
          throw new Error('应拒绝');
        } catch (caught) {
          return caught;
        }
      })(),
      'response_malformed',
    );
  });
});

/* ------------------------------------------------------------------ *
 * C. submitCommand：冻结信封、先查回执、有限重发、结果不确定
 * ------------------------------------------------------------------ */

describe('F-013 submitCommand 冻结信封与有限重试（可编排伪 Host）', () => {
  it('响应丢失 → 先查回执：回执命中即返回原结果，不重发', async () => {
    const setup = await setupScriptedClient();
    try {
      const committed = new Map<string, CommandReceipt>();
      setup.server.setScript((observation) => {
        if (observation.path === '/v1/commands' && observation.method === 'POST') {
          const receipt = receiptFor(observation);
          committed.set(receipt.commandId, receipt);
          return { kind: 'drop' };
        }
        if (observation.path.startsWith('/v1/receipts/')) {
          const receipt = [...committed.values()].at(-1);
          if (receipt === undefined) {
            return {
              kind: 'json',
              status: 404,
              body: { error: { code: 'not_found', message: '回执不存在', operation: 'receipts.get' } },
            };
          }
          return { kind: 'json', status: 200, body: receipt };
        }
        return { kind: 'json', status: 404, body: { error: { code: 'unknown_operation', message: 'x', operation: 'commands.submit' } } };
      });

      const receipt = await setup.client.submitCommand(registerInput());
      expect(receipt.status).toBe('completed');
      expect(receipt.replayed).toBe(false);
      expect(isUuidV4(receipt.commandId)).toBe(true);
      // 恰一次 POST + 恰一次回执查询；没有第二次提交。
      const posts = setup.server.requests.filter((request) => request.path === '/v1/commands');
      const gets = setup.server.requests.filter((request) => request.path.startsWith('/v1/receipts/'));
      expect(posts).toHaveLength(1);
      expect(gets).toHaveLength(1);
      expect(gets[0]!.bearerPresent).toBe(true);
      noSecret(receipt, setup.token);
    } finally {
      await setup.dispose();
    }
  }, 20_000);

  it('回执未知才重发：两次 POST 请求体逐字节相同（不重新生成 commandId/issuedAt/payload）', async () => {
    const setup = await setupScriptedClient();
    try {
      setup.server.setScript((observation) => {
        if (observation.path === '/v1/commands' && observation.method === 'POST') {
          if (setup.server.requests.filter((request) => request.path === '/v1/commands').length <= 1) {
            return { kind: 'drop' };
          }
          return { kind: 'json', status: 200, body: receiptFor(observation) };
        }
        return {
          kind: 'json',
          status: 404,
          body: { error: { code: 'not_found', message: '回执不存在', operation: 'receipts.get', details: { reason: 'receipt_not_found' } } },
        };
      });

      const explicitCommandId = randomUUID();
      const receipt = await setup.client.submitCommand({
        ...registerInput(),
        commandId: explicitCommandId,
      });
      expect(receipt.commandId).toBe(explicitCommandId);
      const posts = setup.server.requests.filter((request) => request.path === '/v1/commands');
      expect(posts).toHaveLength(2);
      // 冻信封：重发与首次逐字节相同。
      expect(posts[0]!.bodyText).toBe(posts[1]!.bodyText);
      const body = posts[0]!.body as Record<string, unknown>;
      expect(body.commandId).toBe(explicitCommandId);
      // 回执查询发生在两次提交之间。
      const timeline = setup.server.requests.map((request) => request.path);
      expect(timeline[0]).toBe('/v1/host/handshake');
      expect(timeline[1]).toBe('/v1/commands');
      expect(timeline[2]?.startsWith('/v1/receipts/')).toBe(true);
      expect(timeline[3]).toBe('/v1/commands');
      noSecret(body, setup.token);
    } finally {
      await setup.dispose();
    }
  }, 20_000);

  it('预算耗尽仍未知 → outcome_unknown：有限次数、有界时长、保留 commandId', async () => {
    const setup = await setupScriptedClient({
      timeouts: { appRequestMs: 150, submitBudgetMs: 900 },
    });
    try {
      setup.server.setScript(() => ({ kind: 'drop' }));
      const startedAt = Date.now();
      const commandId = randomUUID();
      const error = await rejectionOf(() =>
        setup.client.submitCommand({ ...registerInput(), commandId }),
      );
      const elapsed = Date.now() - startedAt;
      const protocolError = expectProtocolError(error, 'outcome_unknown');
      expect((protocolError.details as Record<string, unknown>).commandId).toBe(commandId);
      expect(elapsed).toBeLessThan(10_000);
      // 有限请求：提交与回执查询都有上限。
      const posts = setup.server.requests.filter((request) => request.path === '/v1/commands');
      const gets = setup.server.requests.filter((request) => request.path.startsWith('/v1/receipts/'));
      expect(posts.length).toBeGreaterThanOrEqual(1);
      expect(posts.length).toBeLessThanOrEqual(3);
      expect(gets.length).toBeLessThanOrEqual(3 * 3);
      noSecret(protocolError.toErrorBody(), setup.token);
      noSecret(protocolError.message, setup.token);
    } finally {
      await setup.dispose();
    }
  }, 30_000);

  it('明确业务/协议拒绝不重试：409 错误体、业务 rejected 回执、command_expired 均一次请求', async () => {
    const setup = await setupScriptedClient();
    try {
      const bodies = [
        { error: { code: 'conflict', message: '幂等键冲突', operation: 'commands.submit', details: { reason: 'idempotency_key_reuse' } } },
      ];
      let call = 0;
      setup.server.setScript(() => {
        call += 1;
        return { kind: 'json', status: 409, body: bodies[0] };
      });
      const conflict = await rejectionOf(() => setup.client.submitCommand(registerInput()));
      expectProtocolError(conflict, 'conflict');
      expect(call).toBe(1);
      expect(setup.server.requests.filter((request) => request.path.startsWith('/v1/receipts/'))).toHaveLength(0);

      // 业务 rejected 回执：409 + 回执体 → 返回回执对象，同样不重试。
      call = 0;
      setup.server.setScript((observation) => {
        call += 1;
        const envelope = validateCommandEnvelope(observation.body);
        return {
          kind: 'json',
          status: 409,
          body: {
            schemaVersion: 5,
            commandId: envelope.commandId,
            principalId: 'local-owner',
            operation: envelope.operation,
            scope: envelope.scope,
            requestDigest: computeCommandRequestDigest(envelope),
            status: 'rejected',
            error: { code: 'conflict', message: 'CAS 冲突', details: { expectedRevision: 1, actualRevision: 2 } },
            issuedAt: envelope.issuedAt,
            completedAt: FIXTURE_CLOCK_ISO,
            replayed: false,
          },
        };
      });
      const rejected = await setup.client.submitCommand(registerInput());
      expect(rejected.status).toBe('rejected');
      expect(call).toBe(1);
    } finally {
      await setup.dispose();
    }
  }, 20_000);

  it('重定向被拒绝：目标地址零请求、不重发凭据', async () => {
    const target = await startScriptedAppServer({ hostInstanceId: '0', dataRootIdentity: '0' });
    const setup = await setupScriptedClient();
    try {
      setup.server.setScript(() => ({
        kind: 'redirect',
        location: `http://127.0.0.1:${target.port}/v1/commands`,
      }));
      const error = await rejectionOf(() => setup.client.submitCommand(registerInput()));
      expectProtocolError(error, 'redirect_rejected');
      expect(target.requests).toHaveLength(0);
      const posts = setup.server.requests.filter((request) => request.path === '/v1/commands');
      expect(posts).toHaveLength(1);
      noSecret((error as HostProtocolError).toErrorBody(), setup.token);
    } finally {
      await setup.dispose();
      await target.close();
    }
  }, 20_000);

  it.each<[string, ScriptedResponse]>([
    ['畸形 JSON', { kind: 'json', status: 200, body: undefined }],
    ['非回执对象', { kind: 'json', status: 200, body: { nope: true } }],
    ['accepted 回执', { kind: 'json', status: 200, body: 'accepted-placeholder' }],
    ['摘要不符', { kind: 'json', status: 200, body: 'digest-placeholder' }],
    ['未知版本', { kind: 'json', status: 200, body: 'version-placeholder' }],
  ])('畸形响应拒绝（%s）→ response_malformed/unsupported_schema_version，不重试', async (label, behavior) => {
    const setup = await setupScriptedClient();
    try {
      setup.server.setScript((observation) => {
        if (behavior.kind === 'json' && behavior.body === 'accepted-placeholder') {
          const receipt = receiptFor(observation);
          return {
            kind: 'json',
            status: 200,
            body: { ...receipt, status: 'accepted', result: undefined, resultRef: undefined },
          };
        }
        if (behavior.kind === 'json' && behavior.body === 'digest-placeholder') {
          const receipt = receiptFor(observation, { requestDigest: 'c'.repeat(64) });
          return { kind: 'json', status: 200, body: receipt };
        }
        if (behavior.kind === 'json' && behavior.body === 'version-placeholder') {
          const receipt = receiptFor(observation);
          return { kind: 'json', status: 200, body: { ...receipt, schemaVersion: 6 } };
        }
        if (label === '畸形 JSON') {
          return { kind: 'json', status: 200, body: undefined };
        }
        return behavior;
      });
      const error = await rejectionOf(() => setup.client.submitCommand(registerInput()));
      const code = label === '未知版本' ? 'unsupported_schema_version' : 'response_malformed';
      expectProtocolError(error, code);
      expect(setup.server.requests.filter((request) => request.path === '/v1/commands')).toHaveLength(1);
    } finally {
      await setup.dispose();
    }
  }, 20_000);

  it('响应体超过 65 536 B 上限 → response_malformed', async () => {
    const setup = await setupScriptedClient();
    try {
      setup.server.setScript(() => ({
        kind: 'json',
        status: 200,
        body: { padding: 'x'.repeat(70_000) },
      }));
      const error = await rejectionOf(() => setup.client.submitCommand(registerInput()));
      expectProtocolError(error, 'response_malformed');
    } finally {
      await setup.dispose();
    }
  }, 20_000);

  it('信封输入校验零网络：非法 scope/未知操作/非法 commandId 均不发请求', async () => {
    const setup = await setupScriptedClient();
    try {
      const requestsBefore = setup.server.requests.length;
      for (const bad of [
        { ...registerInput(), scope: { kind: 'global' } },
        { ...registerInput(), operation: 'work.start' },
        { ...registerInput(), commandId: 'not-a-uuid' },
        { ...registerInput(), payload: { repositoryPath: '/tmp/x' } },
      ]) {
        const error = await rejectionOf(() => setup.client.submitCommand(bad as SubmitCommandInput));
        expectProtocolError(error, 'invalid_input');
      }
      expect(setup.server.requests).toHaveLength(requestsBefore);
    } finally {
      await setup.dispose();
    }
  }, 20_000);

  it('AbortSignal 中止提交：立即停止重试，错误为 unreachable/aborted', async () => {
    const setup = await setupScriptedClient();
    try {
      setup.server.setScript(() => ({ kind: 'drop' }));
      const controller = new AbortController();
      const commandId = randomUUID();
      setTimeout(() => controller.abort(), 120);
      const error = await rejectionOf(() =>
        setup.client.submitCommand({ ...registerInput(), commandId }, { signal: controller.signal }),
      );
      const protocolError = expectProtocolError(error, 'unreachable');
      expect((protocolError.details as Record<string, unknown>).reason).toBe('aborted');
      // 中止后不再有新请求。
      const counts = () => setup.server.requests.length;
      const atAbort = counts();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(counts()).toBe(atAbort);
      expect(protocolError.code).not.toBe('outcome_unknown');
    } finally {
      await setup.dispose();
    }
  }, 20_000);

  it('提交前已中止：零网络请求', async () => {
    const setup = await setupScriptedClient();
    try {
      const controller = new AbortController();
      controller.abort();
      const requestsBefore = setup.server.requests.length;
      const error = await rejectionOf(() =>
        setup.client.submitCommand(registerInput(), { signal: controller.signal }),
      );
      expectProtocolError(error, 'unreachable');
      expect(setup.server.requests).toHaveLength(requestsBefore);
    } finally {
      await setup.dispose();
    }
  }, 20_000);
});

/* ------------------------------------------------------------------ *
 * D. 查询与回执读取（可编排伪 Host）
 * ------------------------------------------------------------------ */

describe('F-013 查询、分页与回执读取', () => {
  it('listProjects 按既定分页请求（查询串精确），响应经校验返回', async () => {
    const setup = await setupScriptedClient();
    try {
      setup.server.setScript((observation) => {
        if (observation.path === '/v1/projects' && observation.query.includes('limit=2')) {
          return {
            kind: 'json',
            status: 200,
            body: {
              schemaVersion: 5,
              scope: 'project-list',
              records: [SAMPLE_PROJECT],
              nextCursor: 'prj-next',
              limit: 2,
            },
          };
        }
        return { kind: 'json', status: 500, body: { error: { code: 'internal', message: 'x', operation: 'projects.list' } } };
      });
      const page = await setup.client.listProjects({
        limit: 2,
        cursor: 'prj-1',
        labels: ['alpha', 'beta'],
        match: 'all',
      });
      expect(page.records[0]!.id).toBe('prj-f013');
      expect(page.nextCursor).toBe('prj-next');
      const listRequest = setup.server.requests.find((request) => request.path === '/v1/projects')!;
      expect(listRequest.method).toBe('GET');
      expect(listRequest.query).toBe('limit=2&cursor=prj-1&label=alpha&label=beta&match=all');
      expect(listRequest.bearerPresent).toBe(true);
    } finally {
      await setup.dispose();
    }
  }, 20_000);

  it('非法分页/筛选在本地拒绝：零网络', async () => {
    const setup = await setupScriptedClient();
    try {
      const requestsBefore = setup.server.requests.length;
      for (const bad of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { match: 'some' }, { labels: [42] }]) {
        const error = await rejectionOf(() => setup.client.listProjects(bad as { limit?: number }));
        expectProtocolError(error, 'invalid_input');
      }
      expect(setup.server.requests).toHaveLength(requestsBefore);
    } finally {
      await setup.dispose();
    }
  }, 20_000);

  it('服务端 not_found（404）→ 客户端 not_found；getReceipt 读取本 principal 回执', async () => {
    const setup = await setupScriptedClient();
    try {
      setup.server.setScript((observation) => {
        if (observation.path === '/v1/settings/global') {
          return {
            kind: 'json',
            status: 404,
            body: { error: { code: 'not_found', message: '未配置', operation: 'settings.global.get' } },
          };
        }
        if (observation.path.startsWith('/v1/receipts/')) {
          return { kind: 'json', status: 200, body: 'receipt-placeholder' };
        }
        return { kind: 'json', status: 404, body: { error: { code: 'unknown_operation', message: 'x', operation: 'x' } } };
      });
      const missing = await rejectionOf(() => setup.client.getGlobalSettings());
      expectProtocolError(missing, 'not_found');

      // getReceipt：返回合法回执（scripted 占位替换为真实形状）。
      setup.server.setScript((observation) => {
        if (observation.path.startsWith('/v1/receipts/')) {
          const commandId = observation.path.slice('/v1/receipts/'.length);
          const envelope = validateCommandEnvelope({
            schemaVersion: 5,
            commandId,
            operation: 'project.register',
            scope: { kind: 'registration' },
            issuedAt: FIXTURE_CLOCK_ISO,
            payload: { repositoryPath: '/tmp/x', displayName: 'x' },
          });
          return {
            kind: 'json',
            status: 200,
            body: createCompletedReceipt({
              commandId,
              principalId: 'local-owner',
              operation: envelope.operation,
              scope: envelope.scope,
              requestDigest: computeCommandRequestDigest(envelope),
              issuedAt: envelope.issuedAt,
              completedAt: FIXTURE_CLOCK_ISO,
              result: { status: 'registered' },
              resultRef: createResultRef(randomBytes(32)),
              replayed: true,
            }),
          };
        }
        return { kind: 'json', status: 404, body: { error: { code: 'not_found', message: 'x', operation: 'receipts.get' } } };
      });
      const commandId = randomUUID();
      const receipt = await setup.client.getReceipt(commandId);
      expect(receipt.commandId).toBe(commandId);
      expect(receipt.replayed).toBe(true);
      // 非法 commandId 本地拒绝，零网络。
      const before = setup.server.requests.length;
      const bad = await rejectionOf(() => setup.client.getReceipt('nope'));
      expectProtocolError(bad, 'invalid_input');
      expect(setup.server.requests).toHaveLength(before);
    } finally {
      await setup.dispose();
    }
  }, 20_000);

  it('快照查询按 scope 请求；scope 不符响应拒绝', async () => {
    const setup = await setupScriptedClient();
    try {
      setup.server.setScript((observation) => {
        if (observation.path === '/v1/snapshot' && observation.query === 'scope=global') {
          return {
            kind: 'json',
            status: 200,
            body: {
              schemaVersion: 5,
              scope: { kind: 'global' },
              settings: null,
              watermark: { sequence: 0, cursor: 'evcur_v1_' + 'B'.repeat(48) },
              readAt: FIXTURE_CLOCK_ISO,
            },
          };
        }
        return { kind: 'json', status: 404, body: { error: { code: 'unknown_operation', message: 'x', operation: 'snapshot.get' } } };
      });
      const snapshot = await setup.client.getSnapshot({ kind: 'global' });
      expect(snapshot.watermark.sequence).toBe(0);
      expect(setup.server.requests.at(-1)!.query).toBe('scope=global');

      setup.server.setScript(() => ({
        kind: 'json',
        status: 200,
        body: {
          schemaVersion: 5,
          scope: { kind: 'global' },
          settings: null,
          watermark: { sequence: 0, cursor: 'evcur_v1_x' },
          readAt: FIXTURE_CLOCK_ISO,
        },
      }));
      const mismatch = await rejectionOf(() =>
        setup.client.getSnapshot({ kind: 'project', projectId: 'prj-f013' }),
      );
      expectProtocolError(mismatch, 'response_malformed');
    } finally {
      await setup.dispose();
    }
  }, 20_000);

  it('非法 scope/项目 ID 的快照输入本地拒绝；畸形配置 payload 响应拒绝', async () => {
    const setup = await setupScriptedClient();
    try {
      const before = setup.server.requests.length;
      for (const bad of [
        { kind: 'global', projectId: 'x' } as never,
        { kind: 'project' } as never,
        { kind: 'weird' } as never,
      ]) {
        const error = await rejectionOf(() => setup.client.getSnapshot(bad));
        expectProtocolError(error, 'invalid_input');
      }
      expect(setup.server.requests).toHaveLength(before);

      setup.server.setScript(() => ({
        kind: 'json',
        status: 200,
        body: {
          schemaVersion: 2,
          scope: { kind: 'global' },
          revision: 1,
          payload: { strategies: { planner: { runtime: 42 } } },
        },
      }));
      const corrupt = await rejectionOf(() => setup.client.getGlobalSettings());
      expectProtocolError(corrupt, 'response_malformed');
    } finally {
      await setup.dispose();
    }
  }, 20_000);

  it('resolveResult 经授权结果引用读取；非法 resultRef 本地拒绝', async () => {
    const setup = await setupScriptedClient();
    try {
      const resultRef = createResultRef(randomBytes(32));
      setup.server.setScript((observation) => {
        if (observation.path === `/v1/results/${resultRef}`) {
          const envelope = validateCommandEnvelope({
            schemaVersion: 5,
            commandId: randomUUID(),
            operation: 'project.register',
            scope: { kind: 'registration' },
            issuedAt: FIXTURE_CLOCK_ISO,
            payload: { repositoryPath: '/tmp/x', displayName: 'x' },
          });
          return {
            kind: 'json',
            status: 200,
            body: createCompletedReceipt({
              commandId: envelope.commandId,
              principalId: 'local-owner',
              operation: envelope.operation,
              scope: envelope.scope,
              requestDigest: computeCommandRequestDigest(envelope),
              issuedAt: envelope.issuedAt,
              completedAt: FIXTURE_CLOCK_ISO,
              result: { status: 'registered', project: { id: 'prj-f013' } },
              resultRef,
            }),
          };
        }
        return { kind: 'json', status: 404, body: { error: { code: 'not_found', message: 'x', operation: 'results.resolve' } } };
      });
      const receipt = asCompleted(await setup.client.resolveResult(resultRef));
      expect((receipt.result as { status: string }).status).toBe('registered');
      const before = setup.server.requests.length;
      const bad = await rejectionOf(() => setup.client.resolveResult('../etc/passwd'));
      expectProtocolError(bad, 'invalid_input');
      expect(setup.server.requests).toHaveLength(before);
    } finally {
      await setup.dispose();
    }
  }, 20_000);
});

/* ------------------------------------------------------------------ *
 * E. 真实 Host / 真实 Core 端到端
 * ------------------------------------------------------------------ */

let fixture: CommandsTestFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe('F-013 真实 Host：命令、回执、结果与查询闭环', () => {
  it('注册 → completed/resultRef → resolveResult/getReceipt → 重放零副作用 → 查询与持久状态一致', async () => {
    fixture = createCommandsTestFixture({ prefix: 'shiploop-f013-e2e-' });
    const host = await startHost({
      dataRoot: fixture.dataRoot,
      capabilityCatalog: fixture.capabilityCatalog,
      env: {},
    });
    const environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-e2e-' });
    try {
      const token = readFileSync(join(fixture.dataRoot, 'host', 'auth.token'), 'utf8');
      environment.evidence.registerSecret(token);
      const client = await connectToHost({ canonicalRoot: fixture.dataRoot });
      expect(client.handshake.schemaVersion).toBe(5);

      const input: SubmitCommandInput = {
        operation: 'project.register',
        scope: { kind: 'registration' },
        payload: {
          repositoryPath: fixture.repoDirA,
          displayName: 'F-013 真实闭环',
          labels: ['f013'],
        },
      };
      const receipt = asCompleted(await client.submitCommand(input));
      const result = receipt.result as { status: string; project: { id: string; revision: number } };
      expect(result.status).toBe('registered');
      const projectId = result.project.id;
      expect(result.project.revision).toBe(1);

      // resultRef 解析 → 提交时固化的同一结果。
      const resolved = asCompleted(await client.resolveResult(receipt.resultRef));
      expect(resolved.result).toEqual(receipt.result);

      // 回执读取（本 principal）。
      const stored = asCompleted(await client.getReceipt(receipt.commandId));
      expect(stored.resultRef).toBe(receipt.resultRef);

      // 重放同一冻结信封（同 commandId + 同 issuedAt）：replayed、同 resultRef、零新增副作用。
      const replayed = asCompleted(await client.submitCommand({
        ...input,
        commandId: receipt.commandId,
        issuedAt: receipt.issuedAt,
      }));
      expect(replayed.replayed).toBe(true);
      expect(replayed.resultRef).toBe(receipt.resultRef);

      const probe = openStorageProbe(join(fixture.dataRoot, 'core.sqlite'));
      try {
        const counts = probe.counts();
        expect(counts.projects).toBe(1);
        expect(counts.state_events).toBe(1);
        expect(counts.command_receipts).toBe(1);
      } finally {
        probe.close();
      }

      // 查询与持久状态一致。
      const page = await client.listProjects({ labels: ['f013'] });
      expect(page.records.map((record) => record.id)).toEqual([projectId]);
      const detail = await client.getProject(projectId);
      expect(detail.project.displayName).toBe('F-013 真实闭环');
      expect(detail.binding).not.toBeNull();
      const binding = await client.getRepositoryBinding(projectId);
      expect(binding.binding.projectId).toBe(projectId);
      const labelCounts = await client.countProjectLabels();
      expect(labelCounts.labels).toEqual([{ label: 'f013', projectCount: 1 }]);

      // 项目无配置 → not_found；全局无配置 → not_found。
      expectProtocolError(await rejectionOf(() => client.getProjectSettings(projectId)), 'not_found');
      expectProtocolError(await rejectionOf(() => client.getGlobalSettings()), 'not_found');

      // 快照：项目 scope 含项目/绑定/有效配置与水位。
      const snapshot = await client.getSnapshot({ kind: 'project', projectId });
      expect(snapshot.project.id).toBe(projectId);
      expect(snapshot.watermark.sequence).toBe(1);
      expect(snapshot.watermark.cursor.startsWith('evcur_v1_')).toBe(true);

      // 元数据 CAS 更新 → completed；同 commandId 不同 payload → conflict。
      const update = await client.submitCommand({
        operation: 'project.metadata.update',
        scope: { kind: 'project', projectId },
        expectedRevision: 1,
        payload: { displayName: 'F-013 更新' },
      });
      expect(update.status).toBe('completed');
      const conflict = await rejectionOf(() =>
        client.submitCommand({
          commandId: update.commandId,
          operation: 'project.metadata.update',
          scope: { kind: 'project', projectId },
          expectedRevision: 2,
          payload: { displayName: '不同参数复用命令 ID' },
        }),
      );
      expectProtocolError(conflict, 'conflict');
      noSecret(conflict, token);
      client.close();
    } finally {
      await host.close();
      await environment.dispose();
    }
  }, 60_000);

  it('真实 Host 已提交但响应丢失：客户端取回原 completed/resultRef，数据库只有一次副作用', async () => {
    fixture = createCommandsTestFixture({ prefix: 'shiploop-f013-loss-' });
    const host = await startHost({
      dataRoot: fixture.dataRoot,
      capabilityCatalog: fixture.capabilityCatalog,
      env: {},
    });
    const environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-loss-' });
    // 丢弃代理（HTTP 级）：把请求转发给真实 Host（重写 Host 头为真实监听端口，
    // 保持真实 Host 的 Host/Origin 校验有效）；首个 POST /v1/commands 在请求体
    // 完整写入上游后立即销毁客户端连接——Host 已收全请求并继续提交，但客户端
    // 永远收不到响应。其余请求透明转发响应。
    let droppedRequests = 0;
    const proxy: Server = createServer((incoming, outgoing) => {
      const dropThis =
        incoming.method === 'POST' &&
        (incoming.url ?? '').split('?')[0] === '/v1/commands' &&
        droppedRequests < 1;
      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port: host.port,
          method: incoming.method,
          path: incoming.url,
          headers: { ...incoming.headers, host: `127.0.0.1:${host.port}` },
        },
        (upstreamResponse) => {
          if (outgoing.destroyed) {
            // 客户端连接已销毁：丢弃上游响应，绝不复活客户端连接。
            upstreamResponse.resume();
            return;
          }
          outgoing.writeHead(upstreamResponse.statusCode ?? 500, upstreamResponse.headers);
          upstreamResponse.pipe(outgoing);
        },
      );
      upstream.on('error', () => {
        outgoing.destroy();
      });
      if (dropThis) {
        droppedRequests += 1;
        // finish = 完整请求体已写入上游套接字（Host 将继续处理并提交）。
        upstream.on('finish', () => {
          outgoing.destroy();
        });
      }
      incoming.pipe(upstream);
    });
    try {
      await new Promise<void>((resolveListen) => {
        proxy.listen(0, '127.0.0.1', () => resolveListen());
      });
      const proxyPort = (proxy.address() as { port: number }).port;
      // 发现指向代理（同实例/凭据/数据根身份）。
      publishLoopbackDiscovery({
        canonicalRoot: fixture.dataRoot,
        port: proxyPort,
        hostInstanceId: host.hostInstanceId,
      });

      const client = await connectToHost({ canonicalRoot: fixture.dataRoot });
      const receipt = asCompleted(await client.submitCommand({
        operation: 'project.register',
        scope: { kind: 'registration' },
        payload: {
          repositoryPath: fixture.repoDirA,
          displayName: 'F-013 响应丢失',
        },
      }));
      // 响应丢失路径：回执经 GET /v1/receipts 取回，replayed=false（原始提交）。
      expect(receipt.replayed).toBe(false);
      expect((receipt.result as { status: string }).status).toBe('registered');
      expect(droppedRequests).toBe(1);

      // 数据库只有一次副作用。
      const probe = openStorageProbe(join(fixture.dataRoot, 'core.sqlite'));
      try {
        const counts = probe.counts();
        expect(counts.projects).toBe(1);
        expect(counts.state_events).toBe(1);
        expect(counts.command_receipts).toBe(1);
      } finally {
        probe.close();
      }
      client.close();
    } finally {
      await new Promise<void>((resolveClose) => {
        proxy.close(() => resolveClose());
        proxy.closeAllConnections();
      });
      await host.close();
      await environment.dispose();
    }
  }, 60_000);
});

/* ------------------------------------------------------------------ *
 * F. SSE 订阅（可编排伪 Host）
 * ------------------------------------------------------------------ */

function eventFrame(event: PublicStateEvent): string {
  return `id: ${event.eventId}\nevent: state-event\ndata: ${JSON.stringify(event)}\n\n`;
}

function sampleEvent(sequence: number): PublicStateEvent {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    sequence,
    type: 'project.metadata_updated',
    scope: { kind: 'project', projectId: 'prj-f013' },
    aggregate: { type: 'project', id: 'prj-f013', revision: sequence },
    occurredAt: FIXTURE_CLOCK_ISO,
    payload: { changedFields: ['displayName'] },
  };
}

describe('F-013 SSE 订阅：帧解析、去重与终止分支（可编排伪 Host）', () => {
  it('CRLF 帧跨分块仍可解析，不因换行形式卡住', async () => {
    const setup = await setupScriptedClient();
    try {
      setup.server.setScript(() => ({ kind: 'sse',
        frames: [eventFrame(sampleEvent(1)).replaceAll('\n', '\r\n')],
        keepOpen: true, chunkBytes: 3 }));
      const received: PublicStateEvent[] = [];
      const subscription = await setup.client.subscribeEvents({
        scope: { kind: 'project', projectId: 'prj-f013' }, cursor: 'evcur_v1_' + 'C'.repeat(48),
        onEvent: (event) => received.push(event),
      });
      const deadline = Date.now() + 1_000;
      while (!received.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(1);
      subscription.close();
      await subscription.ended;
    } finally { await setup.dispose(); }
  });

  it('结构合法但来自其他项目的事件拒绝投递且不推进游标', async () => {
    const setup = await setupScriptedClient();
    try {
      const foreign: PublicStateEvent = { ...sampleEvent(1),
        scope: { kind: 'project', projectId: 'prj-other' },
        aggregate: { type: 'project', id: 'prj-other', revision: 1 } };
      setup.server.setScript(() => ({ kind: 'sse', frames: [eventFrame(foreign)], keepOpen: true }));
      const received: PublicStateEvent[] = [];
      const subscription = await setup.client.subscribeEvents({
        scope: { kind: 'project', projectId: 'prj-f013' }, cursor: 'evcur_v1_' + 'C'.repeat(48),
        onEvent: (event) => received.push(event),
      });
      const end = await Promise.race([subscription.ended,
        new Promise((r) => setTimeout(() => r({ kind: 'test_timeout' }), 1_000))]);
      expect(end).toEqual({ kind: 'protocol_error', reason: 'event_scope_mismatch' });
      expect(received).toHaveLength(0);
      expect(subscription.lastEventId()).toBeUndefined();
    } finally { await setup.dispose(); }
  });

  it('每次成功连接立即断开也消耗重连预算，不能无限循环', async () => {
    const setup = await setupScriptedClient();
    try {
      let connections = 0;
      setup.server.setScript(() => { connections += 1;
        return { kind: 'sse', frames: [': heartbeat\n\n'], keepOpen: false }; });
      const subscription = await setup.client.subscribeEvents({
        scope: { kind: 'project', projectId: 'prj-f013' }, cursor: 'evcur_v1_' + 'C'.repeat(48),
        onEvent: () => {},
      });
      const end = await Promise.race([subscription.ended,
        new Promise((r) => setTimeout(() => r({ kind: 'test_timeout' }), 2_000))]);
      expect(end).toEqual({ kind: 'protocol_error', reason: 'reconnect_budget_exhausted' });
      expect(connections).toBe(6); // 首次连接 + 最多五次重连。
    } finally { await setup.dispose(); }
  });

  it('跨分块 UTF-8 与心跳注释：事件正确解码、注释忽略', async () => {
    const setup = await setupScriptedClient();
    try {
      const unicodeEvent: PublicStateEvent = {
        ...sampleEvent(1),
        payload: { changedFields: ['显示名称 🚢'] },
      };
      setup.server.setScript(() => ({
        kind: 'sse',
        frames: [': ping\n\n', eventFrame(unicodeEvent)],
        keepOpen: true,
        chunkBytes: 3,
      }));
      const received: PublicStateEvent[] = [];
      const subscription = await setup.client.subscribeEvents({
        scope: { kind: 'project', projectId: 'prj-f013' },
        cursor: 'evcur_v1_' + 'C'.repeat(48),
        onEvent: (event) => received.push(event),
      });
      const deadline = Date.now() + 10_000;
      while (received.length < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(received).toHaveLength(1);
      expect(received[0]!.payload).toEqual({ changedFields: ['显示名称 🚢'] });
      subscription.close();
      const end = await subscription.ended;
      expect(end.kind).toBe('aborted');
      expect(setup.server.openSseConnections()).toBe(0);
    } finally {
      await setup.dispose();
    }
  }, 30_000);

  it('按 eventId 有界去重：重复事件只投递一次', async () => {
    const setup = await setupScriptedClient();
    try {
      const first = sampleEvent(1);
      const second = sampleEvent(2);
      setup.server.setScript(() => ({
        kind: 'sse',
        frames: [eventFrame(first), eventFrame(first), eventFrame(second)],
        keepOpen: true,
      }));
      const received: PublicStateEvent[] = [];
      const subscription = await setup.client.subscribeEvents({
        scope: { kind: 'project', projectId: 'prj-f013' },
        cursor: 'evcur_v1_' + 'D'.repeat(48),
        onEvent: (event) => received.push(event),
      });
      const deadline = Date.now() + 10_000;
      while (received.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(received.map((event) => event.sequence)).toEqual([1, 2]);
      expect(subscription.lastEventId()).toBe(second.eventId);
      subscription.close();
      await subscription.ended;
    } finally {
      await setup.dispose();
    }
  }, 30_000);

  it('去重缓存有界：520 个不同事件全部投递，缓存上限不阻塞新事件', async () => {
    const setup = await setupScriptedClient();
    try {
      const events = Array.from({ length: 520 }, (_unused, index) => sampleEvent(index + 1));
      setup.server.setScript(() => ({
        kind: 'sse',
        frames: events.map(eventFrame),
        keepOpen: true,
      }));
      const received: PublicStateEvent[] = [];
      const subscription = await setup.client.subscribeEvents({
        scope: { kind: 'project', projectId: 'prj-f013' },
        cursor: 'evcur_v1_' + 'E'.repeat(48),
        onEvent: (event) => received.push(event),
      });
      const deadline = Date.now() + 20_000;
      while (received.length < 520 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(received).toHaveLength(520);
      expect(new Set(received.map((event) => event.eventId)).size).toBe(520);
      subscription.close();
      await subscription.ended;
    } finally {
      await setup.dispose();
    }
  }, 45_000);

  it.each([
    [
      '畸形 data JSON',
      () => ({ kind: 'sse', frames: ['id: x\nevent: state-event\ndata: {oops\n\n'], keepOpen: true }),
      'protocol_error',
    ],
    [
      '未知事件类型',
      () => ({
        kind: 'sse',
        frames: [eventFrame({ ...sampleEvent(1), type: 'work.started' as never })],
        keepOpen: true,
      }),
      'protocol_error',
    ],
    [
      '流溢出 error 帧',
      () => ({
        kind: 'sse',
        frames: ['event: error\ndata: {"code":"stream_overflow","snapshotRoute":"/v1/snapshot"}\n\n'],
        keepOpen: false,
      }),
      'stream_overflow',
    ],
    [
      '建连后 snapshot_required error 帧',
      () => ({
        kind: 'sse',
        frames: ['event: error\ndata: {"code":"snapshot_required","snapshotRoute":"/v1/snapshot"}\n\n'],
        keepOpen: false,
      }),
      'snapshot_required',
    ],
  ])('终止分支：%s → %s', async (_label, scriptFactory, expectedKind) => {
    const setup = await setupScriptedClient();
    try {
      setup.server.setScript(scriptFactory as never);
      const subscription = await setup.client.subscribeEvents({
        scope: { kind: 'project', projectId: 'prj-f013' },
        cursor: 'evcur_v1_' + 'F'.repeat(48),
        onEvent: () => {},
      });
      const end = await subscription.ended;
      expect(end.kind).toBe(expectedKind);
      if (end.kind === 'snapshot_required' || end.kind === 'stream_overflow') {
        expect(end.snapshotRoute).toBe(SNAPSHOT_ROUTE);
      }
      expect(setup.server.openSseConnections()).toBe(0);
    } finally {
      await setup.dispose();
    }
  }, 30_000);

  it('帧数据超过上限 → protocol_error 结束（不无限缓冲）', async () => {
    const setup = await setupScriptedClient();
    try {
      setup.server.setScript(() => ({
        kind: 'sse',
        frames: [`id: big\nevent: state-event\ndata: ${'x'.repeat(300_000)}\n\n`],
        keepOpen: false,
      }));
      const subscription = await setup.client.subscribeEvents({
        scope: { kind: 'project', projectId: 'prj-f013' },
        cursor: 'evcur_v1_' + 'G'.repeat(48),
        onEvent: () => {},
      });
      const end = await subscription.ended;
      expect(end.kind).toBe('protocol_error');
    } finally {
      await setup.dispose();
    }
  }, 30_000);

  it('缺省恢复位置（无 cursor/lastEventId）→ invalid_input，零网络', async () => {
    const setup = await setupScriptedClient();
    try {
      const before = setup.server.requests.length;
      const error = await rejectionOf(() =>
        setup.client.subscribeEvents({
          scope: { kind: 'project', projectId: 'prj-f013' },
          onEvent: () => {},
        }),
      );
      expectProtocolError(error, 'invalid_input');
      expect(setup.server.requests).toHaveLength(before);
    } finally {
      await setup.dispose();
    }
  }, 20_000);

  it('AbortSignal 只释放本地观察资源：连接关闭、无 stop 请求', async () => {
    const setup = await setupScriptedClient();
    try {
      setup.server.setScript(() => ({
        kind: 'sse',
        frames: [eventFrame(sampleEvent(1))],
        keepOpen: true,
      }));
      const controller = new AbortController();
      const subscription = await setup.client.subscribeEvents({
        scope: { kind: 'project', projectId: 'prj-f013' },
        cursor: 'evcur_v1_' + 'H'.repeat(48),
        onEvent: () => {},
        signal: controller.signal,
      });
      const deadline = Date.now() + 10_000;
      while (setup.server.openSseConnections() < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(setup.server.openSseConnections()).toBe(1);
      controller.abort();
      const end = await subscription.ended;
      expect(end.kind).toBe('aborted');
      const closed = Date.now() + 5_000;
      while (setup.server.openSseConnections() > 0 && Date.now() < closed) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(setup.server.openSseConnections()).toBe(0);
      // 绝不触发 stop：伪服务从未收到 /v1/host/stop。
      expect(setup.server.requests.some((request) => request.path === '/v1/host/stop')).toBe(false);
    } finally {
      await setup.dispose();
    }
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * G. SSE 真实 Core 装配：水位恢复、断线重连、越权与下界
 * ------------------------------------------------------------------ */

interface RealEventSetup {
  readonly client: HostClient;
  readonly port: number;
  readonly token: string;
  readonly server: Server;
  readonly hub: ReturnType<typeof createEventStreamHub>;
  dispose(): Promise<void>;
}

async function setupRealEventServer(options?: {
  replayLowerBound?: (scope: { kind: 'project'; projectId: string } | { kind: 'global' }) => number;
  fixtureGitRepo?: string;
}): Promise<RealEventSetup> {
  fixture = createCommandsTestFixture({ prefix: 'shiploop-f013-sse-' });
  const app: CoreApplication = await fixture.openApplication();
  const environment = createIsolatedHostEnvironment({ prefix: 'shiploop-f013-sse-env-' });
  try {
    const root = environment.dataRoot();
    const credential = environment.mintHostCredential(root.canonicalRoot);
    let lifecycle = 'ready' as const;
    const stopController = createHostStopController({
      activityGate: createIdleActivityGate(),
      getLifecycleState: () => lifecycle,
      setLifecycleState: () => {},
      prepareTeardown: () => Promise.resolve(),
      releaseAfterTeardown: () => Promise.resolve(),
    });
    const hub = createEventStreamHub({
      queryService: app.queryService,
      principal: fixture.localOwner(),
      getLifecycleState: () => lifecycle,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 60_000,
      ...(options?.replayLowerBound === undefined ? {} : { getReplayLowerBound: options.replayLowerBound }),
    });
    const server = createHostLifecycleServer({
      hostInstanceId: credential.hostInstanceId,
      dataRootIdentity: credential.dataRootIdentity,
      startedAt: FIXTURE_CLOCK_ISO,
      pid: process.pid,
      authToken: credential.token,
      getLifecycleState: () => lifecycle,
      getActivities: () => stopController.getActivities(),
      stop: stopController,
      application: {
        principal: fixture.localOwner(),
        commandService: app.commandService,
        queryService: app.queryService,
        commandReceiptsService: app.commandReceiptsService,
        onboardingService: app.onboardingService,
        baselineQueryService: app.baselineQueryService,
        baselineExecutionService: app.baselineExecutionService,
        getLifecycleState: () => lifecycle,
        eventStreams: hub,
      },
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const port = (server.address() as { port: number }).port;
    publishLoopbackDiscovery({
      canonicalRoot: root.canonicalRoot,
      port,
      hostInstanceId: credential.hostInstanceId,
      store: credential.store,
      token: credential.token,
    });
    const client = await connectToHost({ canonicalRoot: root.canonicalRoot });
    return {
      client,
      port,
      token: credential.token,
      server,
      hub,
      async dispose() {
        client.close();
        await hub.closeAll();
        await new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
          server.closeAllConnections();
        });
        await app.close();
        await environment.dispose();
      },
    };
  } catch (error) {
    await app.close();
    await environment.dispose();
    throw error;
  }
}

describe('F-013 SSE 真实 Core 装配：水位、断线重连与恢复分支', () => {
  it('快照水位订阅 + 断线后 Last-Event-ID 自动重连：事件无缺口、不重复、中断只释放本地资源', async () => {
    const setup = await setupRealEventServer();
    try {
      // 注册一个真实项目（经同一 Host 的命令入口，local-owner）。
      const register = asCompleted(await setup.client.submitCommand({
        operation: 'project.register',
        scope: { kind: 'registration' },
        issuedAt: FIXTURE_CLOCK_ISO,
        payload: {
          repositoryPath: fixture!.repoDirA,
          displayName: 'F-013 SSE 项目',
        },
      }));
      const projectId = (register.result as { project: { id: string } }).project.id;

      const snapshot = await setup.client.getSnapshot({ kind: 'project', projectId });
      const watermarkSequence = snapshot.watermark.sequence;

      const received: PublicStateEvent[] = [];
      const subscription = await setup.client.subscribeEvents({
        scope: { kind: 'project', projectId },
        cursor: snapshot.watermark.cursor,
        onEvent: (event) => received.push(event),
      });

      // 订阅建连后写入一条事件。
      await setup.client.submitCommand({
        operation: 'project.metadata.update',
        scope: { kind: 'project', projectId },
        expectedRevision: 1,
        issuedAt: FIXTURE_CLOCK_ISO,
        payload: { displayName: 'F-013 SSE 更新 1' },
      });
      const firstDeadline = Date.now() + 10_000;
      while (received.length < 1 && Date.now() < firstDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(received.map((event) => event.sequence)).toEqual([watermarkSequence + 1]);

      // 服务端切断全部连接：客户端在预算内以 Last-Event-ID 自动重连，不丢事件。
      setup.server.closeAllConnections();
      await setup.client.submitCommand({
        operation: 'project.metadata.update',
        scope: { kind: 'project', projectId },
        expectedRevision: 2,
        issuedAt: FIXTURE_CLOCK_ISO,
        payload: { displayName: 'F-013 SSE 更新 2' },
      });
      const secondDeadline = Date.now() + 10_000;
      while (received.length < 2 && Date.now() < secondDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(received.map((event) => event.sequence)).toEqual([
        watermarkSequence + 1,
        watermarkSequence + 2,
      ]);
      expect(new Set(received.map((event) => event.eventId)).size).toBe(2);
      expect(subscription.lastEventId()).toBe(received[1]!.eventId);
      expect(subscription.resumeCursor()).toBe(snapshot.watermark.cursor);

      // close() 只释放本地观察资源：Hub 无在途连接，Host 仍可查询。
      subscription.close();
      const end = await subscription.ended;
      expect(end.kind).toBe('aborted');
      expect(setup.hub.activeCount()).toBe(0);
      const status = await loopbackRequest({
        port: setup.port,
        method: 'GET',
        path: '/v1/host/status',
        token: setup.token,
      });
      expect(status.statusCode).toBe(200);
    } finally {
      await setup.dispose();
    }
  }, 60_000);

  it('建连前游标低于可续读下界 → 订阅以 snapshot_required 明确拒绝（恢复分支）', async () => {
    const setup = await setupRealEventServer({ replayLowerBound: () => 1_000_000 });
    try {
      // 真实游标来自真实快照（持久 state_events 驱动）；伪游标会被 Core
      // 按 invalid_cursor 拒绝，到不了下界判定。
      const register = asCompleted(await setup.client.submitCommand({
        operation: 'project.register',
        scope: { kind: 'registration' },
        issuedAt: FIXTURE_CLOCK_ISO,
        payload: {
          repositoryPath: fixture!.repoDirA,
          displayName: 'F-013 下界项目',
        },
      }));
      const projectId = (register.result as { project: { id: string } }).project.id;
      const snapshot = await setup.client.getSnapshot({ kind: 'project', projectId });
      const error = await rejectionOf(() =>
        setup.client.subscribeEvents({
          scope: { kind: 'project', projectId },
          cursor: snapshot.watermark.cursor,
          onEvent: () => {},
        }),
      );
      const protocolError = expectProtocolError(error, 'snapshot_required');
      expect((protocolError.details as Record<string, unknown>).snapshotRoute).toBe(SNAPSHOT_ROUTE);
      expect(setup.hub.activeCount()).toBe(0);
    } finally {
      await setup.dispose();
    }
  }, 45_000);
});
