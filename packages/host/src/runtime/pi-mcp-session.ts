/** Invocation-owned explicit MCP assembly. No SDK MCP extension or configuration discovery. */
import {
  RuntimeError, assembleProjectResourceLoadManifest, PROJECT_RESOURCE_PUBLIC_OPERATIONS,
} from 'shiploop-core';
import type { ProjectResourceLoadManifest, RuntimeEventPayload, RuntimeExecutionRequest } from 'shiploop-core';
import type { PiSubmissionToolDefinition } from './pi-adapter.js';
import { prepareMcpStartupPlan, type McpTrustedResourceResolver } from './mcp-startup-plan.js';
import { createMcpStdioConnection, type McpStdioConnection, type McpStdioConnectionOptions } from './mcp-stdio.js';
import { createMcpRuntimeAudit } from './mcp-runtime-audit.js';

export interface PiMcpAssembly extends Pick<McpStdioConnectionOptions,
  'registerProcess' | 'handshakeTimeoutMs' | 'closeTimeoutMs' | 'callTimeoutMs'> {
  readonly processRegistry: NonNullable<McpStdioConnectionOptions['processRegistry']>;
  readonly resolver: McpTrustedResourceResolver;
  /** Persist actual load evidence, bound to this invocation; never rewrite the approved input. */
  readonly recordManifest: (request: RuntimeExecutionRequest, manifest: ProjectResourceLoadManifest) => Promise<void>;
}

export function createPiMcpScope(input: {
  readonly request: RuntimeExecutionRequest;
  readonly assembly?: PiMcpAssembly;
  readonly publish: (payload: RuntimeEventPayload) => void;
  readonly signal?: AbortSignal;
  readonly requestStop: () => void;
}) {
  const controller = new AbortController();
  const connections: McpStdioConnection[] = [];
  const deadline = Date.now() + input.request.limits.timeoutMs;
  let closed = false;
  let closing: Promise<boolean> | undefined;
  const close = (): Promise<boolean> => {
    closed = true;
    input.signal?.removeEventListener('abort', onAbort);
    controller.abort();
    closing ??= (async () => {
      let confirmed = true;
      for (const connection of [...connections].reverse()) {
        try { if (!(await connection.close()).confirmed) confirmed = false; }
        catch { confirmed = false; }
      }
      return confirmed;
    })();
    return closing;
  };
  const onAbort = () => { void close(); };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  return {
    close,
    async prepare(expected: ProjectResourceLoadManifest | undefined, submissionNames: readonly string[], builtInNames: readonly string[]) {
      const request = input.request;
      const selected = request.workAccess?.resources.entries.filter(entry => entry.kind === 'mcp') ?? [];
      if (selected.length === 0) return [];
      if (!expected) throw new RuntimeError('permission', 'mcp_resource_manifest_missing');
      if (!input.assembly && selected.some(entry => entry.required !== false || entry.onUnavailable !== 'omit')) {
        throw new RuntimeError('permission', 'mcp_assembly_missing');
      }
      const plan = input.assembly ? await prepareMcpStartupPlan(request, {
        resolver: input.assembly.resolver,
        submissionToolNames: submissionNames, builtInToolNames: builtInNames,
      }) : undefined;
      const audit = plan ? createMcpRuntimeAudit({ plan, publish: input.publish, requestStop: () => {
        void close(); input.requestStop();
      } }) : undefined;
      const loaded = new Set<string>();
      const tools: PiSubmissionToolDefinition[] = [];
      for (const server of plan?.servers ?? []) {
        if (closed) throw new RuntimeError('process', 'mcp_scope_closed');
        const entry = selected.find(item => item.id === server.resourceId)!;
        let connection: McpStdioConnection | undefined;
        try {
          if (!input.assembly) throw new RuntimeError('configuration', 'mcp_assembly_missing');
          connection = createMcpStdioConnection({ ...input.assembly, plan: plan!, server, audit,
            signal: controller.signal, outerDeadlineUtcMs: deadline });
          connections.push(connection);
          await connection.start();
          const catalog = await connection.createToolCatalog();
          if (catalog.tools.length !== server.tools.length) throw new RuntimeError('permission', 'mcp_required_tool_missing');
          tools.push(...catalog.tools);
          loaded.add(server.resourceId);
        } catch (error) {
          if (connection && !(await connection.close()).confirmed) throw new RuntimeError('process', 'mcp_cleanup_unconfirmed');
          if (entry.required !== false || entry.onUnavailable !== 'omit' || audit?.failed) throw error;
        }
      }
      const descriptors = expected.resources.map(({ status: _status, unavailableReason: _reason, loadedCapabilities: _caps, ...descriptor }) => descriptor);
      const manifest = assembleProjectResourceLoadManifest({ schemaVersion: 1, projectId: expected.projectId,
        revision: expected.selectionRevision, resources: descriptors, operations: [...PROJECT_RESOURCE_PUBLIC_OPERATIONS],
        allowGlobalScan: false, allowProjectDirectoryScan: false, allowSdkDefaultScan: false }, expected.resources.map(entry => {
        if (entry.kind !== 'mcp') return { ...entry, status: entry.status === 'omitted' ? 'unavailable' : 'available' };
        const available = loaded.has(entry.id);
        return { ...entry, status: available ? 'available' : 'unavailable',
          loadedCapabilities: available ? ['mcp_stdio'] : [],
          unavailableReason: available ? null : entry.transport !== 'stdio' ? 'unsupported' : 'unverified' };
      }));
      if (closed || audit?.failed) throw new RuntimeError('process', 'mcp_scope_closed');
      await input.assembly?.recordManifest(request, manifest);
      input.publish({ kind: 'diagnostic', code: 'pi.mcp.manifest', message: manifest.digest });
      for (const gap of manifest.gaps.filter(gap => selected.some(entry => entry.id === gap.resourceId))) {
        input.publish({ kind: 'diagnostic', code: `pi.mcp.${gap.reason}`, message: `${gap.resourceId}:${gap.capability}` });
      }
      return tools;
    },
  };
}
