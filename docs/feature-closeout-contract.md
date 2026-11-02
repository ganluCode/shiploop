# 首次 Feature 收尾组件

状态（2026-11-02）：内部组件已实现，默认 Host 装配仍未完成，不代表可以自动跑通 Feature。

## 验收范围

`policies.verification.featureChecks` 是项目确认的 Feature 检查允许列表，引用
同段 `checkDefinitions`，只允许非 project 范围的检查；空列表、重复、未知或
project 范围引用被拒绝。该字段参与检查政策摘要，修改后旧计划批准失效，
不得在运行中悄悄追加并继续使用旧批准。

允许列表不等于每个 Feature 都执行的列表。受信 prepare 适配器必须从当前 Feature
已持久化且有效的 Task 检查事实计算去重 `checkKeys`，绑定本次输入摘要；
计划器只在允许列表内选择这些键，按政策顺序执行。缺并集、越界或缺配置均拒绝，
不自动回退到 fullFallback，不根据文件名/命令文本猜测 unit。

检查 argv 来自已确认定义，不采用模型输出的任意命令；跨语言由各自受信检查器提供
同一验证协议，不能以解析 npm 命令代替范围授权。

底层 VerificationBatch 暂沿用旧 `full_fallback` 模式词汇表示选中范围的完整执行，
不代表启动项目全量。`environmentSummary.featureCheckScope` 明确记录
`feature-task-union` 与实际检查键，报告应以此和 checkSnapshot 展示真实范围。

## 验收适配

`createFeatureCloseoutVerifier` 复用 FeatureVerificationCoordinator：
Task 完成门禁、停止核验、资源包裹、检查前后代码身份复核均保留；输出批次还须由
受信 verifyEvidence 重新核对制品。准备阶段的明确配置阻塞不会触发 Runtime 修复。

真实 Node 验证通过临时 Git/SQLite、现有受监督 CommandProcess 与 ArtifactStore
留证；未执行真实模型。测试夹具显式保留最终资源，仅证明验收适配器，不证明
生产 Host 已具备资源取得、续租、崩溃接管或调度。

## 交付适配

`createFeatureCloseoutDelivery` 在交付前重核持久 VerificationBatch 的
project/feature/run、operation、代码与政策摘要、检查结果及输出完整性，
不再次启动已经通过的检查命令。随后复用 FeatureFinalizationService 的
审批、受控 Git 提交与 Feature/Run/Batch 原子结算。

人工阻塞保持等待；未知提交结果保留 pending，须核对而不是再提交。prepare、
readApproval 和 ControlledGitCommitService 都必须由默认装配绑定当前真实授权，
不能由模型、客户端请求或自报 JSON 提供。

## 尚未接通

- 从默认 Host 持久事实计算并集、输入摘要及真实上下文。
- 从 Task 到 Feature 的资源交接、续租和重启停止核验。
- 默认 onHandoff 接线、交付后的依赖调度及失败状态结算。
- 通用 Runtime 自动修复配置与实际消费者。

不得将这些缺口计为 P07 通过条件已满足；不得据组件测试清理工作区或修改阶段状态。
