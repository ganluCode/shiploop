# P08-1 发布清单模板

本文件定义 P08 发布清单的可复用字段与状态语义。P08-1 的实际填写见 [`acceptance/p08-1.release-manifest.json`](../../acceptance/p08-1.release-manifest.json)；机器读取以该 JSON 为准，本文只解释字段和边界。

清单不是发布授权，也不是阶段通过证明。它必须如实区分代码交付、Task 局部单元检查、Feature 门禁和 P08 Phase 集成；`not_run` 不得写成 `passed`。清单不得记录凭据、token、私钥、真实认证内容或开发机绝对路径。

## 1. 模板

```json
{
  "schemaVersion": 1,
  "kind": "shiploop.p08.release-manifest",
  "phase": "P08",
  "feature": "P08-1",
  "identity": {
    "gitCommit": "<40 位完整 Git SHA>",
    "branch": "<feat/pNN/feature-key>",
    "gitCommitScope": "<该 SHA 覆盖的代码范围；文档提交需另行说明>"
  },
  "packages": [
    {
      "name": "shiploop-core",
      "version": "<包版本>",
      "private": true
    }
  ],
  "toolchain": {
    "node": "<Node 精确版本>",
    "npm": "<npm 精确版本>",
    "platform": "<平台>",
    "packageManager": "npm@<npm 精确版本>"
  },
  "compatibility": {
    "hostProtocol": {
      "wireProtocolVersions": [1],
      "wireSchemaVersion": 6,
      "legacyHandshakeSchemaVersionsAccepted": [5],
      "discoverySchemaVersions": [1],
      "unknownVersionPolicy": "reject"
    },
    "databaseSchema": {
      "engine": "sqlite",
      "readableAppliedVersions": { "min": 1, "max": 64 },
      "writableTargetVersion": 64,
      "higherVersionPolicy": "reject"
    }
  },
  "artifacts": {
    "status": "not_run",
    "reason": "<为何没有当前提交的制品摘要>",
    "items": [
      {
        "name": "shiploop-core",
        "version": "<包版本>",
        "filename": "shiploop-core-<包版本>.tgz",
        "sha256": null
      }
    ]
  },
  "checks": [
    {
      "id": "<检查 ID>",
      "layer": "task-local-unit",
      "command": ["<argv>"],
      "status": "not_run",
      "exitCode": null,
      "evidence": "<仓库相对证据位置>",
      "reason": "<未运行原因>"
    }
  ],
  "layers": {
    "codeDelivery": "delivered",
    "taskLocalChecks": "not_run",
    "featureGate": "not_run",
    "phaseIntegration": "not_run"
  },
  "phaseIntegration": {
    "status": "not_run",
    "items": [
      { "id": "<Phase 集成项>", "status": "not_run" }
    ]
  },
  "releaseBlockers": [
    { "id": "<发布身份缺口>", "status": "pending", "note": "<待负责人确认事项>" }
  ],
  "knownGaps": ["<已知缺口>"]
}
```

## 2. 必需字段

| 字段路径 | 含义 | 规则 |
|---|---|---|
| `identity.gitCommit` | Git SHA | 完整 40 位；必须是本仓库真实提交；文档/清单变更需说明是否包含在内 |
| `packages[].version` | 包版本 | 与三个工作区 `package.json` 及 `distribution-compatibility.json` 的 `unifiedVersion` 一致 |
| `compatibility.hostProtocol` | 协议范围 | 与冻结兼容声明逐字段一致，不猜测降级 |
| `compatibility.databaseSchema` | Schema 支持范围 | 与冻结兼容声明一致，高版本 `reject` |
| `toolchain.node` / `toolchain.npm` | Node/npm | 精确版本，不允许范围 |
| `toolchain.platform` | 平台 | 当前正式支持 `darwin`（macOS） |
| `artifacts.items[].sha256` | 制品摘要 | 真实 tarball 的 SHA-256；没有当前提交产物时必须标 `not_run` 并允许为 `null` |
| `checks[].exitCode` | 检查退出码 | 实际进程退出码；`not_run` 为 `null`，不能用 0 冒充 |
| `checks[].evidence` | 证据位置 | 仓库相对路径或外部证据引用；不得写 Harness 私有运行目录 |
| `layers` | 分层状态 | 必须同时区分代码交付、Task 局部单元检查、Feature 门禁和 P08 Phase 集成 |
| `phaseIntegration.items[].status` | Phase 集成状态 | 未执行保持 `not_run` |
| `releaseBlockers` | 发布身份缺口 | 许可证、npm scope、公开包名、发布身份等 `pending` 项 |
| `knownGaps` | 已知缺口 | 至少保留真实安装、协议矩阵、进程清理、演示和人工/live 未运行项 |

## 3. 状态词汇

- `delivered`：代码已在本地分支提交，只表示交付动作完成，不表示验收通过。
- `passed`：该层检查实际执行并以真实退出码/断言通过。
- `failed`：检查执行但失败；必须保留失败证据，不得用文档改写成通过。
- `not_run`：未执行或没有当前提交的有效证据；不得折算为通过。
- `pending`：等待负责人确认或授权，例如许可证、npm scope、公开包名、发布身份。

## 4. 填写与审阅边界

- 先解析最终 Git SHA、锁文件、工具版本和兼容声明，再填写清单；提交或制品变化后重新核对。
- 制品摘要必须对应真实 tarball；本 Task 不允许为了填表而执行 pack 或发布。
- 真实三包安装、Host/CLI 运行、协议兼容/不兼容、进程清理、Todo/存量演示由 P08 Phase 集成执行；清单只登记状态和证据位置。
- 交付报告可供 P08-4 读取，但不替代 P08-4 的跨 Feature 集成、人工确认或 live 授权。
