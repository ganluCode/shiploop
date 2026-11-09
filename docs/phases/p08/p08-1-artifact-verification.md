# P08-1 制品检查说明

本文说明如何为本地 pack 生成可审阅的制品与完整性结果。它只描述检查入口和证据，不代表已经执行真实安装、Host 运行或 P08 阶段验收；`not_run` 不计为通过。本阶段不发布任何 npm 包。

## 1. 入口与顺序

在已提交、干净的源码仓库副本内，按固定顺序执行：

```sh
npm ci
npm run build
npm run pack:local -- --output artifacts/local-pack
npm run verify:artifacts
```

- `npm run pack:local`：按 `shiploop-core → shiploop-host → shiploop-cli` 顺序生成 tarball，并写出 `artifacts/local-pack/distribution-manifest.json`。
- `npm run verify:artifacts`：读取制品、清单和 `distribution-compatibility.json`，写出 `artifacts/local-pack/artifact-verification.json`。
- 任一命令非零即 fail-closed：不得安装、不得把旧结果当作当前提交的通过证据。
- 本流程不执行 `npm publish`、不 push、不创建 PR、不调用真实模型。

## 2. 输入与输出

| 对象 | 位置 | 说明 |
|---|---|---|
| 三包 tarball | `artifacts/local-pack/shiploop-{core,host,cli}-0.0.0.tgz` | 名称/版本必须与包清单和统一版本一致 |
| 分发清单 | `artifacts/local-pack/distribution-manifest.json` | Git commit、平台、工具链、协议/Schema 范围和逐文件 SHA-256 |
| 制品检查结果 | `artifacts/local-pack/artifact-verification.json` | 检查对象、状态、问题、证据摘要和 `not_run` 项 |
| 兼容声明 | `distribution-compatibility.json` | 协议/Schema/平台/工具链的权威冻结值 |
| CI 摘要 | `artifacts/ci-summary.md`（CI 运行时） | 脱敏汇总，不替代制品检查结果 |

摘要字段必须真实：制品 `sha256` 对应实际 tarball，清单 `gitCommit` 对应生成时的源码提交。提交或制品变化后必须重新生成，不能沿用旧摘要。

## 3. 检查项与状态

`artifact-verification.json` 的 `checks[]` 至少覆盖：

- 清单头、工具链、平台与制品集合；
- 制品 commit 与检查环境 commit 一致；
- 包名/版本、tarball 摘要、包内文件摘要；
- dist 入口、exports、CLI bin；
- 依赖闭包、workspace/file 依赖与开发依赖边界；
- Host 协议范围、数据库 Schema 范围；
- 敏感内容、开发机路径与凭据形态；
- Phase 集成范围的 `not_run` 登记。

状态词汇固定为 `passed` / `failed` / `not_run`。只有 `passed` 表示该检查成立；`failed` 必须保留问题与证据；`not_run` 不得折算为通过。命令退出码 0 只表示检查器完成，不能替代逐项状态。

## 4. 真实安装与 Phase 集成缺口

以下项目属于 P08 Phase 集成，不由本检查器或文档签署：

| 项目 | 当前状态 |
|---|---|
| 在独立干净目录真实安装三个 tarball 并运行 | `not_run` |
| 安装产物中 better-sqlite3 / Host 原生写入锁加载 | `not_run` |
| 打包产物 Host 真实启动与生命周期冒烟 | `not_run` |
| 已有 Host 兼容/不兼容（旧客户端握手、未知/高版本拒绝） | `not_run` |
| 停止后的原生进程与临时资源清理 | `not_run` |
| Todo 演示与存量仓库增量变更 | `not_run` |

上述项目必须在 P08 阶段验收中用真实临时目录/仓库/进程执行并保存证据。P08-4 负责跨 Feature 集成与最终引用；本说明不替代该工作。

## 5. 证据与失败处理

- 保留完整 stdout/stderr、真实退出码和 `artifact-verification.json`；不覆盖之前的失败记录。
- 摘要不一致、缺文件、版本漂移、未知协议/高 Schema 版本、疑似凭据或开发机路径时，检查器必须非零退出。
- 失败后先核对 commit、锁文件、构建产物和清单来源，再决定是否重新生成；不要通过手工改摘要、删检查或扩大忽略范围放行。
