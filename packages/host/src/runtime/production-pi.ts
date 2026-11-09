import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticRuntimeCapabilityCatalog, RuntimeError } from 'shiploop-core';
import type { CommandProcessHandle, RuntimeExecutionRequest, WorkResourceSnapshot } from 'shiploop-core';
import { createCommandProcessAdapter } from 'shiploop-core/assembly';
import type { WorkRuntimeFactory } from 'shiploop-core/assembly';
import { createPiWorkRuntimeFactory } from './pi-work-runtime.js';
import { readProductionPiConfig } from './production-pi-config.js';
import { parseProductionPiConfig } from './production-pi-config.js';
import type { ProductionPiConfig } from './production-pi-config.js';
import type { HostStartOptions } from './host-startup.js';
import { createProductionPiFallback } from './production-pi-fallback.js';
import { resolveProductionRg } from './production-command-tools.js';
import { productionFeishuChannels } from './production-feishu.js';
import { startProductionPlanningBridge } from './production-planning-bridge.js';
import { captureProjectDocuments, parseProjectDocumentSnapshot } from './production-project-documents.js';

export interface ProductionPiBootstrap {
  readonly config: ProductionPiConfig;
  readonly dataRoot: string;
  readonly cwd: string;
  readonly invocationId: string;
  readonly hostTimeUtcMs?: number;
  readonly supervisorGroupId?: number;
  readonly rgPath?: string;
  readonly planningBridge?: { readonly port: number; readonly token: string };
  readonly projectSkills?: Awaited<ReturnType<NonNullable<Parameters<WorkRuntimeFactory>[0]['loadSelectedSkills']>>>;
  readonly projectDocuments?: RuntimeExecutionRequest['inputManifest'];
  readonly bodies: readonly { readonly ref: RuntimeExecutionRequest['prompt']; readonly base64: string }[];
}

/** Returns an empty catalog until the operator explicitly installs private pi/runtime.json. */
export async function productionPiOptions(dataRoot: string): Promise<Pick<HostStartOptions, 'capabilityCatalog' | 'workRuntimeFactory' | 'notificationChannels'>> {
  dataRoot = existsSync(dataRoot) ? realpathSync(dataRoot) : dataRoot;
  const config = readProductionPiConfig(dataRoot);
  if (!config) return { capabilityCatalog: createStaticRuntimeCapabilityCatalog([]) };
  const { getBuiltinModels, getBuiltinProviders } = await import('@earendil-works/pi-ai/providers/all');
  for (const provider of config.providers.filter(p => p.custom === undefined)) {
    const builtin = getBuiltinProviders().find(id => id === provider.id);
    if (!builtin || provider.models.some(id => !getBuiltinModels(builtin).some(model => model.id === id))) {
      throw new Error('production_pi_config_model_unknown');
    }
  }
  const providers = config.providers.map(p => ({ providerId: p.id, models: [...p.models] }));
  const capabilityCatalog = createStaticRuntimeCapabilityCatalog([{
    runtimeId: 'pi', providers, contractVersion: 1, permissionGrants: [], isolationModes: ['trusted_project'],
  }]);
  let effectiveSettings: Parameters<WorkRuntimeFactory>[0]['effectiveSettings'];
  const workRuntimeFactory: WorkRuntimeFactory = context => {
    if (context.effectiveSettings) effectiveSettings = context.effectiveSettings;
    const processPort = createCommandProcessAdapter();
    const handles = new Map<string, CommandProcessHandle>();
    const proofs = new WeakMap<object, WorkResourceSnapshot>();
    const base = createPiWorkRuntimeFactory({
      providers, permissionGrants: [], isolationModes: ['trusted_project'],
      argv: [process.execPath, fileURLToPath(new URL('./production-pi-runner.js', import.meta.url))],
      cwd: dataRoot, environment: {},
      process: {
        async start(input, confirm) {
          const request = JSON.parse(Buffer.from(input.stdin!).toString('utf8')) as RuntimeExecutionRequest;
          const reader = context.reader(request);
          if (!reader || request.strategy.credentialRef !== `credential://pi/${request.strategy.provider}`) {
            throw new RuntimeError('authentication', 'production_pi_credential_reference_required');
          }
          const provider = config.providers.find(p => p.id === request.strategy.provider);
          if (request.strategy.endpointRef !== undefined && (!provider?.custom
            || request.strategy.endpointRef !== `endpoint://pi/${provider.id}`)) {
            throw new RuntimeError('configuration', 'production_pi_endpoint_reference_unknown');
          }
          const allowedRoot = context.workspaceRoots[request.cwd.root];
          if (!allowedRoot) throw new RuntimeError('permission', 'production_pi_workspace_unknown');
          const root = realpathSync(allowedRoot), cwd = realpathSync(join(root, request.cwd.relativePath));
          const childPath = relative(root, cwd);
          if (!childPath || childPath === '..' || childPath.startsWith('../') || isAbsolute(childPath)) {
            throw new RuntimeError('permission', 'production_pi_workspace_outside_root');
          }
          const bodies: ProductionPiBootstrap['bodies'][number][] = [];
          for (const ref of [request.prompt, request.inputManifest]) {
            const bound = reader.list().find(r => r.purpose === ref.purpose && r.artifactId === ref.artifactId
              && r.version === ref.version && r.contentHash === ref.contentHash && r.sizeBytes === ref.sizeBytes);
            if (!bound) throw new RuntimeError('configuration', 'production_pi_input_unbound');
            const body = await reader.read(bound.purpose);
            bodies.push({ ref, base64: Buffer.from(body.content).toString('base64') });
          }
          const managed = reader.list().filter(ref => ref.locator.startsWith('managed-documents/contexts/'));
          if (managed.length > 1) throw new Error('managed_document_context_ambiguous');
          const documents = managed.length ? parseProjectDocumentSnapshot(
            new TextDecoder('utf-8', { fatal: true }).decode((await reader.read(managed[0]!.purpose)).content), request.featureId)
            : await captureProjectDocuments(cwd, request.featureId);
          let projectDocuments: RuntimeExecutionRequest['inputManifest'] | undefined;
          if (context.publishDocumentContext) {
            const content = Buffer.from(JSON.stringify({ schemaVersion: 1, projectId: request.projectId,
              featureId: request.featureId, invocationId: request.invocationId, identity: request.identity,
              ...(managed[0] ? { sourceArtifact: managed[0] } : {}),
              capturedAtUtcMs: context.nowUtcMs?.() ?? Date.now(), documents }));
            projectDocuments = await context.publishDocumentContext(request, content);
            if (projectDocuments.projectId !== request.projectId || projectDocuments.purpose !== 'project-documents'
              || projectDocuments.sizeBytes !== content.length || projectDocuments.contentHash !== createHash('sha256').update(content).digest('hex')) {
              throw new Error('production_document_context_unbound');
            }
            bodies.push({ ref: projectDocuments, base64: content.toString('base64') });
          } else if (documents.documents.length || documents.mapping) throw new Error('production_document_publisher_missing');
          const parent = join(dataRoot, 'host/pi-work');
          mkdirSync(parent, { recursive: true, mode: 0o700 });
          const dir = mkdtempSync(join(parent, 'invocation-'));
          let planningBridge: Awaited<ReturnType<typeof startProductionPlanningBridge>> | undefined;
          if (request.prompt.kind === 'planning-prompt') {
            if (!context.bindPlanningTool) throw new RuntimeError('configuration', 'production_planning_bridge_not_assembled');
            try { planningBridge = await startProductionPlanningBridge(context.bindPlanningTool(request)); }
            catch (error) {
              const value = error as { reason?: unknown; details?: { reason?: unknown }; code?: unknown };
              const reason = value.reason ?? value.details?.reason ?? value.code;
              throw new RuntimeError('configuration', typeof reason === 'string' && /^[a-z_]{1,80}$/.test(reason)
                ? `planning_grant_${reason}` : 'planning_grant_failed');
            }
          }
          const projectSkills = await context.loadSelectedSkills?.(request.projectId);
          const projectPolicies = context.effectiveSettings?.(request.projectId).policies;
          const execution = { ...config.execution, ...projectPolicies?.piExecution?.value };
          for (const key of ['maxRequests', 'maxInputBytes', 'maxOutputTokens', 'commandTimeoutMs'] as const) {
            if (config.execution?.[key] !== undefined && execution[key] !== undefined) execution[key] = Math.min(config.execution[key]!, execution[key]!);
          }
          const invocationConfig = parseProductionPiConfig({ ...config,
            pi_agent: { ...config.pi_agent, ...projectPolicies?.piAgent?.value }, execution });
          const bootstrap: ProductionPiBootstrap = { config: invocationConfig, dataRoot, cwd, invocationId: request.invocationId, bodies, projectSkills,
            ...(projectDocuments ? { projectDocuments } : {}),
            hostTimeUtcMs: context.nowUtcMs?.() ?? Date.now(),
            rgPath: resolveProductionRg(), ...(planningBridge ? { planningBridge: { port: planningBridge.port, token: planningBridge.token } } : {}) };
          writeFileSync(join(dir, 'bootstrap.json'), JSON.stringify(bootstrap), { mode: 0o600, flag: 'wx' });
          try {
            const handle = await processPort.start({ ...input,
              environment: { SHIPLOOP_PI_BOOTSTRAP: join(dir, 'bootstrap.json') },
            }, async identity => {
              writeFileSync(join(dir, 'bootstrap.json'), JSON.stringify({ ...bootstrap, supervisorGroupId: identity.processGroupId }), { mode: 0o600 });
              return confirm(identity);
            });
            handles.set(request.invocationId, handle);
            // Delete only private transient input after process stop is positively confirmed.
            void handle.stopped.then(stop => {
              planningBridge?.close();
              if (stop.confirmed) rmSync(dir, { recursive: true, force: true });
            }).catch(() => {});
            return handle;
          } catch (error) {
            planningBridge?.close();
            // Launch uncertainty is retained for diagnosis; never infer process absence.
            throw error;
          }
        },
      },
      resourceStop: {
        snapshot(request) {
          if (request.identity.purpose !== 'work') throw new RuntimeError('permission', 'work_required');
          const handle = handles.get(request.invocationId);
          return { identity: { projectId: request.projectId, attemptId: request.identity.attemptId,
            owner: request.owner.principalId, hostInstanceId: request.owner.hostInstanceId, executionVersion: request.executionVersion },
          invocationId: request.invocationId, processIdentity: handle?.identity ?? null, leases: [] };
        },
        verifier: {
          async verify(snapshot) {
            if (!snapshot.processIdentity || !(await processPort.recoverStop!(snapshot.processIdentity)).confirmed) return null;
            const proof = Object.freeze({}); proofs.set(proof, snapshot); return proof;
          },
          inspect(proof) {
            const snapshot = typeof proof === 'object' && proof !== null ? proofs.get(proof) : undefined;
            if (!snapshot) throw new Error('production_pi_stop_proof_unknown');
            return snapshot;
          },
        },
      },
    })(context);
    return { ...base, failureRouting: createProductionPiFallback({ dataRoot, config,
      catalog: context.capabilityCatalog, descriptor: base.entries[0].descriptor,
      controlsFor: projectId => context.effectiveSettings?.(projectId).policies.piAgent?.value }) };
  };
  return { capabilityCatalog, workRuntimeFactory, notificationChannels: productionFeishuChannels(dataRoot, config, () => effectiveSettings) };
}
