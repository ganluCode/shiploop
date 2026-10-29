# P06-7 F-006 结构化证据边界

本任务交付清理前事实采集、不可覆盖的场景记录和离线复核接口。正式 `accept:p06` 入口、阶段报告聚合与产品 Feature 执行报告接线由 F-007 消费这些接口；本记录不表示 P06 或 Feature 验收通过。

## 接口和顺序

`scripts/acceptance/p06-evidence.ts` 提供：

- `collectP06Scenario(options)`：核对 runId / testedCommit / inputDigest 与输入，采集真实临时 SQLite、Git、文件和受管进程事实，扫描并导出，重读确认后才调用拥有者的 cleanup，最后保存 `result.json`。调用者传入实际命令结果、明确的业务核对结果、工具版本与用量来源；采集器不执行或猜测业务命令，也不从日志推断状态。
- `verifyP06Scenario(directory, record, expectedIdentity)`：临时资源删除之后检查记录、证据身份、相对路径、hash/size、各类别结构和 cleanup 事实。仅重算外层 hash 不能绕过内部 SQLite 行摘要、文件 hash/size、命令一致性或后代扫描校验。
- `notRunP06Scenario` / `reconcileP06Evidence`：FR-1、FR-2、I01～I08 与七类关键故障各有独立身份；缺项生成带完整受测身份、空命令、null 退出码、明确原因和 pending cleanup 的 `not_run` 记录。每个 Attempt 保留，失败后的重试不会覆盖原事实；后续缺项说明 `halted_by_prior_failure`。

输出布局为 `<run-directory>/<scenarioId>-a<attempt>/`，包含 `sqlite.json`、`git.json`、`process.json`、`artifact.json`、`command-exit.json`、`usage.json`、`manifest.json`、`cleanup.json` 和 `result.json`。每份证据封套独立绑定运行、场景、Attempt、commit、输入摘要与类别，引用携带 SHA-256 和字节数。目录和文件使用独占创建，拒绝同一 Attempt 重写、重复身份/路径及符号链接。重试显式递增 Attempt；新运行使用新的 runId 和资源根。

原命令非零退出、超时、取消或业务拒绝保持 fail，即使退出码为 0 的取消也不通过。`failures` 依次追加采集、清理、报告写入错误；`outcome` / `reason` 保留首因。最终报告无法写入时，函数返回 `publicationError=report_write_failed` 的失败记录，调用控制器必须将其保存在自己的失败结果中并停止放行。没有成功报告文件不能按成功处理。

故障注入检查本身可以通过：例如验证命令返回 0，断言实际 CAS 拒绝且状态不变；其中被测业务操作的失败事实保存在副作用材料中。若直接采集故障命令，其原始失败记录仍是 fail，不能借“这是负例”自动改成 pass。阶段层须明确区分被测操作与验证命令。

## 事实、安全与所有权

`scripts/acceptance/p06-facts.ts` 使用独立 readonly SQLite 连接，在一致读事务中导出 `quick_check`、journal mode、表结构、全部受限行及行摘要，不迁移、不更新业务 SQL。Git 导出 HEAD/tree、porcelain、工作区和暂存 diff，禁用外部 diff/textconv/fsmonitor，并核对 Git common-dir 位于自有根。文件正文先脱敏，再计算导出 hash/size。

`OwnedProcessTree.snapshot()` 增加只读历史导出，按真实祖先关系捕获 PID、PPID 和启动身份摘要；父进程退出后保留已发现后代。Todo 夹具将这些事实接入 `processFacts().trees`。采集器在 cleanup 后再次读取 OS 进程表核对同一身份已消失，并检查资源根实际不存在，不只信任 cleanup 返回值。扫描失败或停止不确定均不能通过。无法捕获到的历史进程不能凭此补造证明。

资源路径须位于本次持有的规范临时根，文件与 Git 元数据不得通过符号链接逃逸；证据目录独立于被删除的根。只有原资源拥有者执行清理。SQLite 快照限制为至多 512 表、每表 1000 行及总行文本 8 MiB；单文件 4 MiB、单份证据 8 MiB。超限、不可解码文本及未提供专门导出器的二进制 SQLite 列明确失败，不静默截断。

复用 P05 扫描器，增加参数形式凭据扫描；字符串叶子与序列化文本均扫描，覆盖合成秘密、Bearer、凭据键、macOS/Linux/Windows 开发机路径，包括 JSON 转义路径。已登记敏感值替换后重新计算导出 hash/size；未登记命中拒绝写出。Node 可执行位置和源码路径须由可信调用者登记为敏感值。错误仅输出允许的内部/系统原因码，不回显任意 callback 错误、原命令输出或扫描命中正文。

这些材料属于阶段事实；不能冒充产品 Feature 执行报告，也不构成 Pi 默认工具的强 OS 沙箱证明。真实模型、live、负责人签署和正式阶段运行仍有独立门槛。

## 验证范围

新增 `test/modules/acceptance/p06-7-f006-evidence.test.ts` 的 15 项用例覆盖：真实 Core 服务注册与 CAS 冲突后的全库不变、清理前导出和清理后复核；类别缺失/损坏/错身份/重算 hash/符号链接；失败与重试保留、另一运行隔离；真实超时、SIGTERM 取消及后代停止；业务拒绝结果保存；清理拒绝和虚假清理声明；真实损坏 SQLite、越界文件、脱敏与未登记泄露拒绝；多重失败历史、任意 callback 错误安全及最终报告写入失败。

F-006 仓库 v2 索引还登记 Todo 夹具、既有进程清理和七个关联回归文件。本地三个文件共 26 项通过：F-006 的 15 项日志为 `test-ai8ryqfb.log`，夹具 9 项在此前 `test-z9mfpbbs.log` 的 23 项组合结果中通过，既有进程清理 2 项为 `test-gqc5q6r6.log`。最终类型检查 `test-bivw3ygi.log` 通过；边界检查 `test-1tpkl935.log` 通过（468 生产文件、0 诊断）。日志均在 Harness `verifications/F-006/runtime-logs/`，附带完整命令及真实退出码 sidecar。另七个回归文件仅登记交 Nezha 独立验证，不计为本地通过。

最新样本为 Harness `verifications/F-006/evidence-final/p06-f006-906b5b98-73be-413f-9853-826b6e9f1767/`，受测基准为 `3bebdc99400a31bde7c3f8b37f987a62a6f95bb6` 加本次未提交补丁；保存 8 类证据和含 1 个注册 Project 的 60 表 SQLite 快照，引用的 hash/size 均可独立核对。

设置 `SHIPLOOP_P06_F006_EVIDENCE_DIR` 后，正常场景复制已扫描的导出到指定目录，再在临时根已删除的条件下复核。`regression-input.json` 明确记录受测时的 `sourceDirty`、`phaseAccepted=false` 和用途；样本只证明本证据层行为，缺少的 FR/其他场景在 `reconciliation.json` 保持 `not_run`，聚合结果为 fail。旧样本和 RED 日志保留，不覆盖失败记录。
