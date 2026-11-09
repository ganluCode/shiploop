import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { WorkToolBridge } from 'shiploop-core';

/** Private loopback bridge: one live grant, one permitted Core tool channel, no discovery. */
export async function startProductionPlanningBridge(bridge: WorkToolBridge) {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    const auth = request.headers.authorization;
    const expected = Buffer.from(`Bearer ${token}`);
    const supplied = Buffer.from(typeof auth === 'string' ? auth : '');
    if (request.method !== 'POST' || request.url !== '/v1/work/tools' || supplied.length !== expected.length
      || !timingSafeEqual(supplied, expected)) { response.writeHead(403).end(); return; }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const bytes of request) {
        size += bytes.length;
        if (size > 1048576) { response.writeHead(413).end(); request.destroy(); return; }
        chunks.push(bytes);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = await bridge.invoke(value);
      const status = 'status' in result && result.status === 'rejected'
        ? result.error.code === 'forbidden' ? 403 : result.error.code === 'not_found' ? 404 : result.error.code === 'conflict' ? 409 : 400 : 200;
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      const e = error as { code?: unknown; reason?: unknown; details?: { reason?: unknown; field?: unknown } };
      const field = e.details?.field;
      const reason = e.reason ?? e.details?.reason ?? (typeof e.code === 'string' && /^SQLITE_[A-Z_]{1,80}$/.test(e.code) ? e.code.toLowerCase()
        : typeof field === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(field) ? `invalid_${field.replaceAll('.', '_')}`
        : error instanceof TypeError ? 'bridge_type_error' : error instanceof Error && error.name === 'SqliteError' ? 'bridge_storage_error' : 'planning_bridge_rejected');
      const code = typeof e.code === 'string' && ['forbidden', 'conflict', 'invalid_input', 'not_found', 'unsupported_schema_version'].includes(e.code) ? e.code : 'forbidden';
      response.writeHead(code === 'conflict' ? 409 : code === 'invalid_input' || code === 'unsupported_schema_version' ? 400 : 403,
        { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code,
          details: { reason: typeof reason === 'string' && /^[a-z0-9_]{1,100}$/.test(reason) ? reason : 'planning_bridge_rejected' } } }));
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  let closed = false;
  return { port, token,
    close() {
      if (closed) return;
      closed = true;
      bridge.revoke();
      server.close();
      server.closeAllConnections();
    } };
}
