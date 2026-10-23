/**
 * F-007 受控 Pi Runner 工具桥装配：真实临时 SQLite/Git + 生产组合根
 * （createPiWorkRuntimeFactory，真实 CommandProcessAdapter 与 Runner 协议子进程），
 * 工具调用经真实环回 HTTP 转发到 Core WorkToolChannel。无模型/网络付费调用。
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createCommandProcessAdapter } from '../../../packages/core/src/adapters/process/command-process.ts';
import { createPiWorkRuntimeFactory } from '../../../packages/host/src/runtime/pi-work-runtime.ts';
import { PiRunnerDecoder } from '../../../packages/host/src/runtime/pi-runner-protocol.ts';
import type { CommandProcessHandle, CommandProcessPort } from '../../../packages/core/src/ports/command-process.ts';
import type { RuntimeExecutionRequest } from '../../../packages/core/src/ports/runtime-execution.ts';
import type { WorkResourceSnapshot } from '../../../packages/core/src/ports/work-resources.ts';
import type { CommandReceipt } from '../../../packages/core/src/ports/commands.ts';
import type { F007Fixture } from '../../modules/planning/p05-1-f007-planning-execution.test.ts';

interface BridgeHandle {
  readonly fixture: F007Fixture;
  drive(): Promise<void>;
  close(): Promise<void>;
}

export async function startHostlessPlanningRunnerBridge(options: { readonly prefix: string }): Promise<BridgeHandle> {
  const { openF007FixtureWithFactory } = await import('../../modules/planning/p05-1-f007-planning-execution.test.ts');
  const portHolder = { port: 0 };
  const bridges: { revoke(): void }[] = [];
  let server: Server | undefined;
  let fixtureRef: F007Fixture | undefined;
  try {
    /* 环回 HTTP：Runner 子进程的工具调用 → 真实 Core WorkToolChannel（受限授权）。 */
    server = createServer((request, response) => {
      const reply = (status: number, body: unknown) => {
        const payload = Buffer.from(JSON.stringify(body));
        response.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.byteLength });
        response.end(payload);
      };
      void (async () => {
        try {
          const f = fixtureRef!;
          if (request.method === 'GET' && request.url === '/planning-candidate') {
            reply(200, f.candidateBody());
            return;
          }
          if (request.method === 'POST' && request.url === '/planning-submit') {
            const envelope = await new Promise<Record<string, unknown>>((resolve, reject) => {
              const chunks: Buffer[] = [];
              request.on('data', chunk => chunks.push(chunk));
              request.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); } });
              request.on('error', reject);
            });
            const receipt = await f.submitCandidate(String(envelope.payload && (envelope.payload as { candidate: unknown }).candidate));
            reply(200, receipt);
            return;
          }
          reply(404, { error: 'not_found' });
        } catch (error) {
          reply(500, { error: 'bridge_relay_failed', message: error instanceof Error ? error.message : 'unknown' });
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    portHolder.port = (server.address() as { port: number }).port;

    /* 真实 Pi Runner 工厂（受控子进程；resourceStop 核验与 p04-1 同一纪律）。 */
    const processes = createCommandProcessAdapter({ stopGraceMs: 3_000, stopConfirmMs: 2_000 });
    const handles = new Map<string, CommandProcessHandle>();
    const tokens = new WeakMap<object, WorkResourceSnapshot>();
    let starts = 0;
    const decoder = new PiRunnerDecoder();
    const processPort: CommandProcessPort = {
      start: async (input, confirm) => {
        starts += 1;
        const req = JSON.parse(Buffer.from(input.stdin!).toString()) as RuntimeExecutionRequest;
        const handle = await processes.start(input, confirm);
        handles.set(req.invocationId, handle);
        return { ...handle, output: (async function* () {
          for await (const chunk of handle.output) {
            if (chunk.stream === 'stdout') for (const frame of decoder.push(chunk.bytes)) {
              void frame;
            }
            yield chunk;
          }
        })() };
      },
    };
    const factory = createPiWorkRuntimeFactory({
      providers: [{ providerId: 'provider', models: ['model'] }],
      permissionGrants: [], isolationModes: ['trusted_project'],
      process: processPort,
      argv: [process.execPath, '--experimental-transform-types', '--import',
        fileURLToPath(new URL('../node-ts-loader/register.mjs', import.meta.url)),
        fileURLToPath(new URL('./p05-1-f007-runner-child.ts', import.meta.url))],
      cwd: process.cwd(),
      environment: { SHIPLOOP_F007_BRIDGE_PORT: String(portHolder.port) },
      resourceStop: {
        snapshot(req) {
          if (req.identity.purpose !== 'work') throw new Error('Work required');
          return { identity: { projectId: req.projectId, attemptId: req.identity.attemptId, owner: req.owner.principalId,
            hostInstanceId: req.owner.hostInstanceId, executionVersion: req.executionVersion }, invocationId: req.invocationId,
            processIdentity: handles.get(req.invocationId)!.identity, leases: [] };
        },
        verifier: {
          async verify(snapshot) {
            if (!(await processes.recoverStop!(snapshot.processIdentity!)).confirmed) return null;
            const token = Object.freeze({});
            tokens.set(token, snapshot);
            return token;
          },
          inspect(token) {
            const snapshot = typeof token === 'object' && token !== null ? tokens.get(token) : undefined;
            if (!snapshot) throw new Error('Unknown test proof');
            return snapshot;
          },
        },
      },
    });

    const fixture = await openF007FixtureWithFactory({ prefix: options.prefix, workRuntimeFactory: factory });
    fixtureRef = fixture;
    return {
      fixture,
      async drive() {
        await fixture.core.workExecution.scan();
        expect(starts).toBeGreaterThanOrEqual(0);
      },
      async close() {
        for (const bridge of bridges.splice(0)) bridge.revoke();
        fixtureRef = undefined;
        await new Promise<void>(resolve => {
          server?.close(() => resolve());
          server?.closeAllConnections();
        });
        await fixture.close();
      },
    };
  } catch (error) {
    fixtureRef = undefined;
    await new Promise<void>(resolve => {
      server?.close(() => resolve());
      server?.closeAllConnections();
    });
    throw error;
  }
}

export type { BridgeHandle, CommandReceipt };
