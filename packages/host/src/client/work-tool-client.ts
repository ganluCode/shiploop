/** Explicit restricted endpoint only. No discovery, owner credential reader, launcher or retries. */
import { isPublicError, publicErrorHttpStatus, validateCommandEnvelopeFields, WORK_TOOL_OPERATION_SPECS, validateWireCommandReceipt } from 'shiploop-core';
import type { CommandReceipt, WorkTaskResult } from 'shiploop-core';
import { HostProtocolError, MAX_APP_BODY_BYTES } from '../contract/index.js';
import { mapErrorResponse, requestLoopbackJson } from './http-json.js';

export function createWorkToolClient(options: { readonly port: number; readonly token: string }) {
  const { port, token } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    throw new HostProtocolError('invalid_input', 'work.tools.invoke');
  }
  return Object.freeze({
    async invoke(input: unknown): Promise<CommandReceipt | WorkTaskResult> {
      let envelope;
      try { envelope = validateCommandEnvelopeFields(input, WORK_TOOL_OPERATION_SPECS); }
      catch (error) { throw new HostProtocolError(isPublicError(error) ? error.code : 'invalid_input', 'work.tools.invoke'); }
      const response = await requestLoopbackJson({ port, token, method: 'POST', path: '/v1/work/tools',
        operation: 'work.tools.invoke', body: input, connectTimeoutMs: 1000, overallTimeoutMs: 10_000,
        maxResponseBytes: MAX_APP_BODY_BYTES });
      const value = response.json;
      try {
        if (envelope.operation !== 'task.read') {
          const receipt = validateWireCommandReceipt(value, 'work.tools.invoke');
          if (receipt.commandId !== envelope.commandId || receipt.operation !== envelope.operation
            || receipt.scope.kind !== 'project' || envelope.scope.kind !== 'project'
            || receipt.scope.projectId !== envelope.scope.projectId) throw new Error('receipt mismatch');
          if (receipt.status === 'accepted' || response.statusCode !== (receipt.status === 'completed' ? 200 : publicErrorHttpStatus(receipt.error.code))) {
            throw new Error('status mismatch');
          }
          return receipt;
        }
        if (response.statusCode === 200 && value !== null && typeof value === 'object') {
          const result = value as WorkTaskResult;
          if (result.operation === 'task.read' && typeof result.task?.id === 'string'
            && typeof result.task.title === 'string' && typeof result.task.status === 'string') {
            const { id, title, status, acceptance } = result.task;
            return { operation: 'task.read', task: { id, title, status, acceptance } };
          }
        }
      } catch { /* map structured errors below; never retain arbitrary response data */ }
      if (response.statusCode >= 400) throw mapErrorResponse(response.statusCode, value, 'work.tools.invoke');
      throw new HostProtocolError('response_malformed', 'work.tools.invoke');
    },
  });
}
