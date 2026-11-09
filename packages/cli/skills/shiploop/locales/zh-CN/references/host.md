# Host 和桌面端边界

外部 Node 应用优先使用 `shiploop-host` 的 `connectToHost`；其他语言通过本机 Host HTTP 协议接入。

```ts
import { connectToHost } from 'shiploop-host';

const client = await connectToHost({ canonicalRoot: dataRoot });
try {
  console.log(await client.status());
} finally {
  client.close();
}
```

- Host 只监听本机 `127.0.0.1` 随机端口。
- 使用受保护 discovery/auth 文件和 Bearer token；不要把 token 写入 Skill、日志或仓库。
- `client.close()` 只关闭客户端观察，不停止 Host 或取消任务。
- 查询使用分页和 cursor；先列出摘要，再读取指定 Session/Artifact 证据。
- 桌面 Renderer 不应直接持有 Host token，应由可信主进程调用 HostClient。
- 不直接连接 SQLite；不绕过 Host 修改 Core 状态。

生命周期路由：

```text
POST /v1/host/handshake
GET  /v1/host/status
POST /v1/host/stop
POST /v1/commands
GET  /v1/receipts/:commandId
GET  /v1/results/:resultId
GET  /v1/events
```

跨语言客户端必须核对 discovery、协议版本、实例身份、dataRootIdentity 和能力目录，不要只看 HTTP 200。
## 受管项目文档

`GET /v1/projects/:projectId/documents` 查询文档根目录；可选 `featureId` 查询绑定。`POST /v1/projects/:projectId/documents/write` 接收 `{path,content,expectedHash?}`，通过 CAS 写入相对 Markdown 草稿。正式规划由 Core 固定文档版本和上下文。
