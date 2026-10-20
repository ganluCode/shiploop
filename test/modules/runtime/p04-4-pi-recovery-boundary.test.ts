import { describe, expect, it } from 'vitest';
import {
  decideRuntimeRecovery,
  validateRuntimeRecoveryCapabilities,
  validateRuntimeRecoveryRequest,
} from '../../../packages/core/src/index.ts';
import {
  PI_ADAPTER_VERSION,
  PI_NATIVE_SESSION_FORMAT,
  PI_NATIVE_SESSION_FORMAT_VERSION,
  PI_RECOVERY_EVIDENCE_REF,
  PI_RUNTIME_ID,
  PI_RUNTIME_RECOVERY_CAPABILITIES,
  PI_SDK_VERSION,
  createPiRuntimeAdapter,
} from '../../../packages/host/src/runtime/pi-adapter.ts';
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import type { RuntimeRecoveryRequest, RuntimeRecoveryReference } from '../../../packages/core/src/ports/runtime-recovery.ts';
import type { PiTrustedAssembly } from '../../../packages/host/src/runtime/pi-adapter.ts';

const digest = 'a'.repeat(64);

function recoveryRequest(mode: 'auto' | 'required', kind: 'conversation' | 'checkpoint' = 'conversation'): RuntimeRecoveryRequest {
  const source: RuntimeRecoveryReference = kind === 'checkpoint'
    ? {
        schemaVersion: 1,
        purpose: 'work',
        kind,
        sourceProjectId: 'project-1',
        sourceSessionId: 'session-old',
        sourceTaskId: 'task-1',
        sourceAttemptId: 'attempt-old',
        runtime: PI_RUNTIME_ID,
        provider: 'provider',
        model: 'model',
        providerSessionId: 'provider-session-old',
        nativeArchiveRef: 'artifact-native-archive',
        nativeFormat: PI_NATIVE_SESSION_FORMAT,
        nativeFormatVersion: PI_NATIVE_SESSION_FORMAT_VERSION,
        sourceDigest: digest,
        checkpointRef: 'artifact-checkpoint',
      }
    : {
        schemaVersion: 1,
        purpose: 'work',
        kind,
        sourceProjectId: 'project-1',
        sourceSessionId: 'session-old',
        sourceTaskId: 'task-1',
        sourceAttemptId: 'attempt-old',
        runtime: PI_RUNTIME_ID,
        provider: 'provider',
        model: 'model',
        providerSessionId: 'provider-session-old',
        nativeArchiveRef: 'artifact-native-archive',
        nativeFormat: PI_NATIVE_SESSION_FORMAT,
        nativeFormatVersion: PI_NATIVE_SESSION_FORMAT_VERSION,
        sourceDigest: digest,
      };
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    sessionId: 'session-new',
    executionVersion: 2,
    invocationId: 'invocation-new',
    identity: { purpose: 'work', runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-new' },
    strategy: { runtime: PI_RUNTIME_ID, provider: 'provider', model: 'model' },
    recovery: { mode, kind, source },
  };
}

function assembly(): PiTrustedAssembly {
  return {
    agentDir: 'trusted-agent-dir',
    resolveWorkingDirectory: () => 'trusted-workspace',
    inputReader: { read: async () => 'controlled input' },
    resourceLoader: {} as NonNullable<CreateAgentSessionOptions['resourceLoader']>,
    credentialRef: { kind: 'trusted-resolution', id: 'credential-ref' },
  };
}

describe('P04-4 standard Pi Work recovery boundary', () => {
  it('[case:pi-recovery-capability-matrix] publishes versioned evidence for every native capability', () => {
    const descriptor = validateRuntimeRecoveryCapabilities(PI_RUNTIME_RECOVERY_CAPABILITIES);
    expect(descriptor).toMatchObject({
      runtimeId: PI_RUNTIME_ID,
      adapterVersion: PI_ADAPTER_VERSION,
      sdkVersion: PI_SDK_VERSION,
      nativeFormats: [{ format: PI_NATIVE_SESSION_FORMAT, versions: [PI_NATIVE_SESSION_FORMAT_VERSION] }],
    });
    for (const capability of Object.values(descriptor.capabilities)) {
      expect(capability).toMatchObject({ status: 'unsupported', evidenceRef: PI_RECOVERY_EVIDENCE_REF });
      expect(capability.limits.length).toBeGreaterThan(0);
    }
  });

  it('[case:pi-recovery-auto-required-policy] leaves downgrade and rejection to the Core decision', () => {
    expect(decideRuntimeRecovery(recoveryRequest('auto'), PI_RUNTIME_RECOVERY_CAPABILITIES)).toEqual({
      mode: 'new', reasons: ['conversationResume:unsupported', 'nativeFork:unsupported'],
    });
    expect(decideRuntimeRecovery(recoveryRequest('required'), PI_RUNTIME_RECOVERY_CAPABILITIES)).toEqual({
      mode: 'rejected', reasons: ['conversationResume:unsupported', 'nativeFork:unsupported'],
    });
    expect(decideRuntimeRecovery(recoveryRequest('required', 'checkpoint'), PI_RUNTIME_RECOVERY_CAPABILITIES)).toEqual({
      mode: 'rejected', reasons: ['executionRecovery:unsupported', 'nativeFork:unsupported'],
    });
  });

  it('[case:pi-recovery-registration] returns the same trusted recovery evidence beside the Runtime adapter', () => {
    const registration = createPiRuntimeAdapter({
      providers: [{ providerId: 'provider', models: ['model'] }],
      permissionGrants: ['fs.read'],
      isolationModes: ['trusted_project'],
      assembly: assembly(),
      sessionFactory: async () => { throw new Error('not started'); },
    });
    expect(registration.recoveryCapabilities).toBe(PI_RUNTIME_RECOVERY_CAPABILITIES);
  });

  it('[case:pi-recovery-source-artifact-only] keeps client supplied native paths outside the recovery reference', () => {
    const request = recoveryRequest('required');
    if (request.recovery.mode === 'new' || request.recovery.source === undefined) throw new Error('source fixture missing');
    const invalid = {
      ...request,
      recovery: {
        ...request.recovery,
        source: { ...request.recovery.source, nativeArchiveRef: '/tmp/native-session.jsonl' },
      },
    };
    expect(() => validateRuntimeRecoveryRequest(invalid)).toThrow();
  });
});
