/** Host-instance-local credential mapping. Only trusted assembly receives issue/revoke/close. */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { WorkAccessBinding, WorkToolBridge, createWorkToolChannel } from 'shiploop-core';

export interface HostWorkToolAuthentication {
  authenticate(request: IncomingMessage): Pick<WorkToolBridge, 'invoke'> | null;
}
export interface HostWorkToolAccess extends HostWorkToolAuthentication {
  /** access is a declaration; binding comes independently from live trusted Work authority. */
  issue(access: unknown, binding: WorkAccessBinding): { readonly token: string; revoke(): void };
  close(): void;
}

export function createHostWorkToolAccess(channel?: Pick<ReturnType<typeof createWorkToolChannel>, 'bind'>): HostWorkToolAccess {
  const grants = new Map<string, WorkToolBridge>();
  let closed = false;
  const digest = (token: string) => createHash('sha256').update(token).digest('hex');
  return {
    issue(access, binding) {
      if (closed || channel === undefined || grants.size >= 1024) throw new TypeError('Work tool authority unavailable');
      const bridge = channel.bind(access, binding);
      const token = randomBytes(32).toString('hex');
      const key = digest(token);
      grants.set(key, bridge);
      return Object.freeze({ token, revoke() { bridge.revoke(); grants.delete(key); } });
    },
    authenticate(request) {
      if (closed) return null;
      const header = request.headers.authorization;
      if (typeof header !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(header)) return null;
      return grants.get(digest(header.slice(7))) ?? null;
    },
    close() {
      closed = true;
      for (const bridge of grants.values()) bridge.revoke();
      grants.clear();
    },
  };
}
