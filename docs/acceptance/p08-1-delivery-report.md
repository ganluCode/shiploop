# P08-1 安装包与用户操作文档交付报告（F-007）

日期：2026-11-02。分支：`feat/2026-11-02-14-56-22_p08-1`。范围：P08-1 的本地打包、制品检查、最小发布 CI、新用户指南、操作 Skills、发布清单与文档入口接线。

本文是 Feature 交付记录，供 P08-4 读取；**不构成 P08 阶段验收结论，不替代跨 Feature 集成、人工确认或 live 授权**。机器检查通过、文档完整或清单存在都不能单独放行阶段。

## 1. 代码与文档身份

本报告绑定的功能代码基线为 `2271bcd0a211cda9f85fba449adee802b2784b2a`（F-006，HEAD）。F-007 只新增发布文档、清单、索引和本报告，不改变运行时行为；最终提交由 Git 记录，P08-4 必须重新解析当前 HEAD，不能把本报告的基线 SHA 当作最终交付 SHA。

| Task | 提交 | 内容 |
|---|---|---|
| F-001 | `3f39fad798ca9ec44e303df85d9bbb7bbf60e73d` | 冻结三包分发元数据、版本/引擎/平台与协议/Schema 兼容声明 |
| F-002 | `bb11568a6dc42252a7a8c525b9fa469e5d183c07` | 本地 pack 与三包 tarball/制品清单 |
| F-003 | `ec1b21701364e384a9be8b1142ce0affbea941aa` | 制品完整性与兼容检查器 |
| F-004 | `d5a37fa10a009217eae3430f79de4cc9c331db86` | 最小发布 CI 与本地 fail-closed 配置检查 |
| F-005 | `63bf8ca5c4db14b4147996854c4af226dbdb6a9b` | 新用户安装与操作指南及文档守护 |
| F-006 | `2271bcd0a211cda9f85fba449adee802b2784b2a` | 操作 Skills 与 CLI 命令面同步 |
| F-007 | 本报告/清单所在本地提交 | 支持矩阵、变更说明、制品检查说明、发布清单模板、README 导航与交付报告 |

F-007 新增/更新的主要文件：

- `docs/p08-1-support-matrix.md`：平台、工具链、协议、Schema、分层状态与缺口。
- `CHANGELOG.md`：0.0.0 未发布变更说明。
- `docs/p08-1-artifact-verification.md`：pack/制品检查入口、输出、状态与 Phase 缺口。
- `docs/acceptance/p08-1-release-manifest.md`：发布清单模板与字段/状态语义。
- `acceptance/p08-1.release-manifest.json`：P08-1 实际发布清单（机器可读）。
- `docs/acceptance/p08-1-delivery-report.md`：本报告。
- `test/modules/engineering/p08-1-f007-release-manifest-docs.test.ts` 与 P08-1 测试索引：文档链接、清单 schema、脱敏与版本身份守护。

## 2. 工具版本与实际局部检查

工具链：Node `22.19.0`、npm `10.9.3`、平台 macOS（`darwin`）。版本与 `distribution-compatibility.json` 一致。

| 检查 | 实际命令 | 退出码 | 证据 |
|---|---|---:|---|
| F-007 文档/清单守护 | `node scripts/run-tests.ts test/modules/engineering/p08-1-f007-release-manifest-docs.test.ts` | 0 | `verifications/F-007/runtime-logs/test-ykxqyhll.log`；11/11 通过 |
| F-007 严格类型检查 | `npm run typecheck` | 0 | `verifications/F-007/runtime-logs/test-5not7ord.log` |
| 制品检查 | `npm run verify:artifacts` | not_run | 现有产物属于 F-003 提交；本 Task 禁止发包，未重新生成 |
| Feature 门禁 | Nezha 独立执行去重 Task 索引 | not_run | 本 Task 不运行全量/Feature 门禁 |
| P08 Phase 集成 | 阶段验收/P08-4 | not_run | 见第 4 节 |

局部检查只读取仓库文档、JSON、Git 对象和既有测试入口；不执行全仓历史回归、不发包、不 push、不合并、不修改 Phase/Feature/Task 状态。局部测试通过只证明 F-007 的文档/清单约束成立，不证明真实安装或运行。

## 3. 分层状态

| 层次 | 状态 | 说明 |
|---|---|---|
| 代码交付 | `delivered` | F-001～F-006 已本地提交；F-007 文档/清单变更按本 Task 提交 |
| Task 局部单元检查 | `passed` | F-007 守护测试通过；其他 Task 以各自索引/日志为准 |
| Feature 门禁 | `not_run` | 由 Nezha 在最终代码上独立执行，不由本报告代跑或代签 |
| P08 Phase 集成 | `not_run` | 真实安装、运行、协议矩阵、清理与演示均待 P08-4/阶段验收 |
| 负责人确认 / live | 未提供 | 人工确认与 live 授权必须独立执行 |

## 4. P08 Phase 集成待运行项

以下项目保持 `not_run`，不得由文档、清单或局部测试签署通过：

- 真实三包安装：在独立干净目录安装三个本地 tarball 并运行。
- Host/CLI 运行：打包产物 Host 启动、CLI 调用、生命周期与停止证据。
- 协议兼容：已有 Host/客户端在支持版本内的握手与升级路径。
- 协议不兼容：未知/更高协议或 Schema 版本、旧客户端的明确拒绝与不写入。
- 进程清理：停止/失败后没有遗留 Host、Runner、测试子进程或临时资源。
- Todo 演示：从干净安装目录完成 Todo CLI 需求到交付。
- 存量演示：接入非 Nezha 创建的旧仓库完成一次增量变更。

上述项目的机器可读记录见 `acceptance/p08-1.release-manifest.json` 的 `phaseIntegration` 与 `knownGaps`。

## 5. 发布身份缺口

- 许可证、npm scope、公开包名、公开发布身份与 registry 策略均待负责人确认（`releaseBlockers` 全部 `pending`）。
- 本 Feature 只生成本地 pack 候选，不执行 `npm publish`、不 push、不创建 PR、不合并。
- 清单和报告不含凭据；真实认证材料不得写入仓库或文档。

## 6. 已知缺口与 P08-4 使用方式

- 当前提交没有重新生成 tarball，因此发布清单中的制品摘要保持 `not_run`/`null`；不得引用 F-003 旧产物冒充当前提交。
- 真实安装目录、原生模块加载、协议兼容/不兼容矩阵、进程清理和两类演示均未运行。
- 本报告可作为 P08-4 的输入，帮助其定位已交付范围、提交、工具版本、局部检查与待运行项；P08-4 必须重新执行跨 Feature 集成、真实证据核对、人工确认与 live 授权，不能直接复制本报告结论。
- 若 P08-4 发现索引、文档链接、版本或脱敏问题，应保留失败证据并修复后重新验证；不得通过修改清单状态或删除缺口来放行。
