import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkResourceStopVerifier } from '../../../packages/core/src/application/work-resource-stop.ts';
import type { CommandProcessIdentity } from '../../../packages/core/src/ports/command-process.ts';
import type { WorkResourceSnapshot } from '../../../packages/core/src/ports/work-resources.ts';
import {
  createMcpStdioProcessRegistry,
  type McpStdioProcessRegistration,
} from '../../../packages/host/src/runtime/mcp-stdio.ts';

const UUID = '11111111-1111-4111-8111-111111111111';
const MCP_UUID = '22222222-2222-4222-8222-222222222222';
const identity: CommandProcessIdentity = {
  launchId: UUID, pid: 1234, processGroupId: 1234, startTime: 'Tue Oct 28 10:00:00 2026',
};
const childIdentity: CommandProcessIdentity = {
  launchId: MCP_UUID, pid: 2345, processGroupId: 2345, startTime: 'Tue Oct 28 10:01:00 2026',
};
const registration: McpStdioProcessRegistration = {
  processIdentity: childIdentity, projectId: 'project-1', sessionId: 'session-1', serverId: 'server-1',
  invocationId: 'invocation-1', executionVersion: 2, planDigest: 'a'.repeat(64),
};
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function snapshot(managedProcesses: WorkResourceSnapshot['managedProcesses'] = [
  { kind: 'mcp', ...registration },
]): WorkResourceSnapshot {
  return {
    identity: { projectId: 'project-1', attemptId: 'attempt-1', owner: 'owner-1', hostInstanceId: 'host-1', executionVersion: 2 },
    invocationId: 'invocation-1', processIdentity: identity,
    leases: [1, 2, 3] as unknown as WorkResourceSnapshot['leases'], managedProcesses,
  };
}

describe('P06-4 F-006 MCP process ownership and recovery', () => {
  it('[case:mcp-registration-survives-host-rebuild] persists an invocation-scoped MCP registration and excludes another session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shiploop-mcp-f006-'));
    roots.push(root);
    const path = join(root, 'mcp-processes.json');
    const first = createMcpStdioProcessRegistry({ path });
    await expect(first.register(registration)).resolves.toEqual({ launchId: childIdentity.launchId });
    const rebuilt = createMcpStdioProcessRegistry({ path });
    expect(rebuilt.list({ projectId: 'project-1', sessionId: 'session-1', invocationId: 'invocation-1', executionVersion: 2 })).toEqual([registration]);
    expect(rebuilt.list({ projectId: 'project-1', sessionId: 'session-2', invocationId: 'invocation-1', executionVersion: 2 })).toEqual([]);
    const stopped: CommandProcessIdentity[] = [];
    await expect(rebuilt.recover({ projectId: 'project-1', sessionId: 'session-1', invocationId: 'invocation-1', executionVersion: 2 }, async value => {
      stopped.push(value);
      return { confirmed: true };
    })).resolves.toMatchObject({ confirmed: true, registrations: [registration] });
    expect(stopped).toEqual([childIdentity]);
    expect(rebuilt.list({ projectId: 'project-1', sessionId: 'session-1', invocationId: 'invocation-1', executionVersion: 2 })).toEqual([]);
  });

  it('[case:mcp-stop-proof-fails-closed] requires Runner and every registered MCP process to stop before finalizing', async () => {
    const recovered: CommandProcessIdentity[] = [];
    let finalized = 0;
    const verifier = createWorkResourceStopVerifier({
      process: { recoverStop: async value => {
        const process = value as CommandProcessIdentity;
        recovered.push(process);
        return { confirmed: process.launchId === UUID };
      } },
      finalize: async () => { finalized++; return true; },
    });
    await expect(verifier.verify(snapshot())).resolves.toBeNull();
    expect(recovered).toEqual([identity, childIdentity]);
    expect(finalized).toBe(0);
    recovered.length = 0;
    const token = await verifier.verify(snapshot([{ kind: 'mcp', ...registration, processIdentity: { ...childIdentity, launchId: UUID } }]));
    expect(token).not.toBeNull();
    expect(finalized).toBe(1);
  });
});
