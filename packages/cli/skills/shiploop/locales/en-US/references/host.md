# Host and Desktop Integration

Node consumers should use connectToHost from shiploop-host; other languages use local Host HTTP.
```ts
import { connectToHost } from 'shiploop-host';
const client = await connectToHost({ canonicalRoot: dataRoot });
try { console.log(await client.status()); }
finally { client.close(); }
```

- Bind only 127.0.0.1 on a random port; use protected discovery/auth files and Bearer token, never in logs/Skills/repositories.
- client.close closes observation only, not Host/tasks.
- Page with cursor; query summaries then selected Session/Artifact evidence.
- Desktop renderers should call through a trusted main process, not hold Host tokens.
- Do not connect directly to SQLite or bypass Core state operations.

```text
POST /v1/host/handshake
GET  /v1/host/status
POST /v1/host/stop
POST /v1/commands
GET  /v1/receipts/:commandId
GET  /v1/results/:resultId
GET  /v1/events
```

Cross-language clients must verify discovery, protocol version, instance/dataRootIdentity and capabilities; HTTP200 alone is insufficient.
## Managed project documents

`GET /v1/projects/:projectId/documents` returns the managed root; optional `featureId` returns bindings. `POST /v1/projects/:projectId/documents/write` accepts `{path,content,expectedHash?}` for CAS-protected relative Markdown draft writes. Core freezes document versions and planning inputs.
