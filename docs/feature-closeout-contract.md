# 首次 Feature 收尾组件

状态（2026-11-02）：默认普通 Run 的首次自动验收与交付已接线，单 Feature Batch
离线成功/失败闭环已验证。Runtime 自动修复、跨 Host 恢复及共享 Batch 全链路仍未验收，P07 不放行。

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

早期组件测试显式保留最终资源，只证明验收适配器。新增默认装配测试不恢复 Task
租约：Task 通过证据显式播种，Feature 的真实 Node 检查、进程登记、停止核验、Git、
业务结算与派发资源释放走默认 Core。未执行真实模型，不证明跨 Host 崩溃接管。

## 交付适配

`createFeatureCloseoutDelivery` 在交付前重核持久 VerificationBatch 的
project/feature/run、operation、代码与政策摘要、检查结果及输出完整性，
不再次启动已经通过的检查命令。随后复用 FeatureFinalizationService 的
审批、受控 Git 提交与 Feature/Run/Batch 原子结算。

人工阻塞保持等待；未知提交结果保留 pending，须核对而不是再提交。prepare、
readApproval 和 ControlledGitCommitService 都必须由默认装配绑定当前真实授权，
不能由模型、客户端请求或自报 JSON 提供。

## 默认装配与剩余边界

### 默认资源桥接

`createSqliteFeatureCloseoutLease` 保持同一个 Run 派发认领、槽位与 Feature
资源集合，核验无活动 Attempt、无保留 Task 租约及无未知停止事实，使用同代次
成功 Attempt 的持久认领回执作为续租围栏。它不重建 Task、不重新获取 Task 租约。
旧 owner、暂停/终态、缺失资源或过期身份被拒绝；过期按已有机制隔离，不冒充释放。

`createSqliteFeatureCloseoutStopVerifier` 在受信 Run 租约内读取当前已通过 Task 的
Runtime 停止制品，逐一复核 project/run/task/attempt/session/invocation/version/owner
及内容完整性。没有停止证据即拒绝；已登记 Verifier 进程按完整身份有界停止核验，
不是扫描所有 Session 或只看 PID。没有 Task 租约不再等于“无停止证据”。

租约丢失沿 AbortSignal 传到现有 Node 检查进程；资源桥接结束本身不证明停止，
也不自动释放派发资源。Run 终态仍有未知 Git 结果，或 closeout 为 reconcile_required，
普通结算会保留/隔离资源。活动 Run 正常的 pending Git 意图不会被误判成租约失效。

### 已接线

- `createSqliteFeatureCloseoutContext` 从当前 Task 终态事件引用的验收批次
  计算检查并集和稳定输入摘要；校验计划批准、检查定义、手工阻塞、工作区绑定
  和父级截止时间。默认 Host 已调用。它不扫描 Session JSONL，也不执行检查。
- 调度器允许消费者返回 `recordHandoff: false`，保留消费者自己的阻塞原因，
  不写入旧式“一次性交接”标记；旧消费者返回 void 的行为保持兼容。
- finalization 原语已支持固定成员 Batch：只结算当前 Feature/Run；全部成员
  Feature 终态且该 Batch 内所有成员 Run 终态后才结束父 Batch。缺少成员 Run
  不算完成，重试历史失败不覆盖成员最终成功。全部成员成功交付才标记父 Batch
  succeeded，否则 failed。成员等待审批不暂停兄弟 Run；父 Batch 人工暂停或
  已终态时拒绝启动未完成成员的收尾。重复子 Feature 终态不重复验证或 Git。
  这不是共享 Batch 默认执行装配已完成的证明，失败后的整体停止策略仍需装配。
- 默认 `onHandoff` 使用本 Host 的派发 owner/instance，继续 Run/Feature 租约，
  在 Node 检查前后复核真实停止证据；父 deadline 传到进程执行器。Host 关闭会
  中止并等待正在进行的收尾。通过后受控 Git 提交并结算，已有成功交付只核对、
  不重复提交；未知结果不重放。原 Feature DAG 仍负责依赖和代码集成门禁，不绕过。
- 默认未启用 Runtime 自动修复。检查失败保存批次引用，Feature partial/Run failed；
  缺配置、人工阻塞或未知结果保留暂停/核对状态，不重写 Task 通过事实。
- 当前默认环境仅支持 null environmentRef；非空环境引用明确拒绝，不能隐式读取
  整个 Host 环境。cwd 使用真实路径包含性检查，不允许逃逸受管工作区。

### 剩余工作

- 重启后的停止核对、持久 ledger 接管与显式恢复（不可直接解除暂停后盲重放）。
- 共享 Batch 的默认批准上下文和依赖推进全链路验收；子 Feature 结算原语已单独覆盖。
- 通用 Runtime 自动修复的实际消费者和持久预算，启用后最多三次且预算跨重启保留。

## 自动修复配置（执行器尚未接通）

`policies.featureAutoFix` 为可选 v2 配置段，缺省/未 enabled 为关闭。项目段整体
覆盖全局段，`{enabled:false}` 明确关闭，不继承全局模型或预算。

- `strategy`：可选完整 runtime/provider/model，允许既有 credentialRef/endpointRef
  引用，禁止明文凭据；与其他策略一样验证能力目录。省略时只读取有效 modelMap.high，
  缺 high 明确阻塞，不擅自改用 defaultStrategy、medium 或其他模型。
- `maxRepairs`：1..3，启用时省略为 3；不是修改已有 ledger 计数或重置预算的入口。
- `maxTokenTotal`：1..1,000,000,000，修复总 Token 上限，启用必须显式配置。
- `timeoutMs`：1,000..86,400,000，每次修复上限，启用必须显式配置；后续执行器
  必须与剩余父 deadline 取较小值，不能每次重建父 deadline。
- `maxTurns`：1..1,000，每次修复轮次上限，启用必须显式配置。

解析器只生成冻结配置及摘要，不启动模型、不扣预算。摘要进入收尾输入身份，
运行中的政策/模型变化不能继续借用旧授权。旧版本 Core 对新键明确拒绝，不能
把含新字段的设置交给旧版本后期待自动忽略。

当前默认消费者遇到启用配置会暂停并报告 `feature_auto_fix_runtime_not_assembled`
（缺 high 则 `feature_auto_fix_strategy_missing`），在验收/修复/Git 前阻塞，不
静默退化成“未启用”。现在应保持关闭。后续还需独立修复执行身份、持久预算预占、
输入/权限绑定及真实 Runtime 消费者；不得复活已通过 Task 或冒用 GitAgent 专用授权。

不得将这些缺口计为 P07 通过条件已满足；不得据组件测试清理工作区或修改阶段状态。
