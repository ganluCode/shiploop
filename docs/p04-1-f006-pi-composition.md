# P04-1 F-006：Pi Work 可信静态装配

F-006 通过 Host 公共出口 `createPiWorkRuntimeFactory` 接入现有 `WorkRuntimeFactory`。Host 的 `workRuntimeFactory` 与 Core 的同名选项使用同一条装配路径；Core 仍负责输入绑定、认领、启动预算、命令进程身份落库、录制、fencing、资源占用和终态结算。Pi 只提供 Runtime 句柄，不直接推进 Task passed。

## 可信入口与目录一致性

启动代码固定提供 Runner 的进程端口、argv、cwd、环境和资源停止核验器，并将生成的 factory 传给 `startHost`。项目设置只保存稳定 runtime/provider/model 策略，不接收 factory、模块路径或安装命令。CLI 参数、prompt 和模型输出均不参与模块解析；没有自动安装、插件发现、默认 Pi 回退或活动适配器替换入口。

```ts
import { createStaticRuntimeCapabilityCatalog } from 'shiploop-core';
import { createPiWorkRuntimeFactory, startHost } from 'shiploop-host';

// 下列值来自可信启动代码；trustedRunnerOptions 不是项目配置或 CLI 参数。
const providers = [{ providerId: 'provider', models: ['model'] }];
const permissionGrants: string[] = [];
const isolationModes = ['trusted_project'];
const capabilityCatalog = createStaticRuntimeCapabilityCatalog([{
  runtimeId: 'pi', providers, permissionGrants, isolationModes, contractVersion: 1,
}]);
const workRuntimeFactory = createPiWorkRuntimeFactory({
  ...trustedRunnerOptions, providers, permissionGrants, isolationModes,
});
const host = await startHost({ dataRoot, capabilityCatalog, workRuntimeFactory, env: {} });
```

Factory 使用 `WorkRuntimeContext.capabilityCatalog`，要求 Pi 目录显式声明 contractVersion、permissionGrants 和 isolationModes。现有静态注册表按集合核对 provider/model、权限和隔离模式，并严格核对契约版本；重复/未知 runtime ID、模块字符串和不兼容描述符在调用适配器前拒绝。Core 装配失败测试同时断言 Attempt 数和 runtime_starts 均为零。旧 Fake 目录可以省略新增字段，保留原有配置兼容性。

Pi 描述符、argv 和环境在 factory 创建时复制；每个 Core 装配持有自己的 Runner adapter。命令进程启动前的身份确认直接使用 Core 注入的 `commitCommandIdentity`。Runner 保留同一启动身份的单次调用缓存，拒绝旧 executionVersion 和不同 invocation 的重复占用。请求中的 runtime/provider/model、权限、隔离和恢复模式在创建进程前再次核验。

公开事件 ID 使用 `pi.<session/invocation/executionVersion 的 SHA-256 前缀>.<sequence>`。Factory 将同一前缀规则交给 Core Recorder，避免真实 Pi 事件因为身份格式不同被录制器拒绝。

## SDK 隔离与实测边界

Host 的公共入口不再立即加载 Pi SDK。标准 Session factory 只在授权初始化时动态导入固定包名 `@earendil-works/pi-coding-agent`，并要求实际 `VERSION` 与锁定版本相等，否则报 `sdk_version_incompatible`。它不从外部字符串导入包。缺失 SDK 时，Core/Host/CLI 仍能导入；不注入执行适配器时，现有 `runtime_not_found` 诊断保持不变且不创建 Attempt。FakeRuntime 的独立测试装配不需要 Pi。

本地实际版本：

| 项目 | 版本/状态 | 证据 |
| --- | --- | --- |
| Node.js | 22.19.0，macOS | 当前执行环境 |
| 标准 Pi SDK | 1.0.4，MIT | 实际导入 SDK，断言 `piSdk.VERSION === PI_SDK_VERSION` 及 Session 生命周期 API |
| Pi adapter | 0.1.0 | Factory 描述符与 Host Session 查询 |
| Adapter contract | 1 | Factory 与能力目录严格比较 |
| Runner 协议 | 1 | 复用现有受监督 Runner 与私有通道 |

装配测试使用真实 Git、SQLite、Host/HostClient 和真实受监督子进程；子进程运行标准 Pi adapter/Work Runner，Session 由受控测试工厂提供。没有真实 provider 请求、凭据访问或模型工具执行。SDK 缺失测试用导入即抛错的模块替身保护 Core/Host/CLI 公共加载路径，并在同一条件下实际执行独立 Fake Work。

能力与限制：

- 正常 Work：Host 查询到唯一 Attempt、Work Session、公开 message/usage 事件、完整录制和结算证据。用量来源为 `reported`；Runtime completed 后 Attempt 为 verifying，Task 尚未 passed。再次扫描不重复启动，runtime_starts 仅扣一次。
- 取消：实际进程组信号进入 Runner/SDK abort；Core 结算 cancelled。Core 主动中止采集，因此明确保留 `recording_required` 缺口与 incomplete 录制状态。
- 迟到 executionVersion：Core 将旧事实隔离到诊断，不改写旧 Attempt、不给它完成结算，也不触发工作区收尾或释放占用。
- 启动异常、Runner 崩溃：结算为 interrupted，保留 held/quarantined 工作区租约；Runner 的部分公开事件仍可读取。进程退出不能代替独立工具/资源停止证明。
- 资源停止核验必须由可信启动代码提供。未提供时保持 stopped=false，Core 保守保留占用。测试核验器仅证明本测试没有外部工具的受控进程组，不代表生产工具已获验证。
- conversationResume、executionRecovery 均保持 unsupported。Durable 为后续可选实验，Chat 不在此任务范围。

## 本地证据与独立回归交接

日志均位于 Feature workspace 的 `verifications/F-006/runtime-logs/`；完整 stdout/stderr 和 helper 生成的退出码 sidecar 均保留。

| 检查 | 日志 | 结果 |
| --- | --- | --- |
| 最终任务局部测试：composition 18 项 + adapter 13 项 | `test-2_572q7a.log` | exit 0，31 passed，0 failed，0 skipped |
| 最终类型检查 | `test-mxpr5bld.log` | exit 0 |
| 包边界检查 | `test-k2mtgvel.log` | exit 0，292 个生产源文件，0 diagnostics |
| macOS Host 原生锁构建（测试前置） | `test-oh3_p82k.log` | exit 0 |
| 权限目录不一致 RED / 初次 GREEN | `test-j9ggub2w.log` / `test-q2qql2h1.log` | exit 1 / exit 0 |
| Factory 缺失 RED / 初次 GREEN | `test-lh4pkzno.log` / `test-jd70p30l.log` | exit 1 / exit 0 |

中间整合失败也完整保留：Host 原生锁前置未构建、公开字段/用量来源断言、测试回调身份层级和 Core 保守状态/租约断言的修正均没有删除日志。最终通过的 31 项包含正常执行、启动失败、重复身份、旧版本、取消、Runner 崩溃、目录漂移及无 SDK 的独立 Fake 路径。

唯一执行范围索引为 `test/index/phases/P04/features/P04-1/tasks/F-006.json`，Harness 的 `test-selection.json` 仅引用此索引。前两个文件已在本地执行；其余十个文件是交给 Nezha 的受影响回归选择，涵盖 Runtime 能力/注册契约、Runner、停止、Core/Host 装配、执行服务和结算。未在本地运行这些较广回归、全仓测试、组合 verify 或阶段验收；任务局部通过不代表独立验收通过。
