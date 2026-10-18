# P02-1 F-013 多进程集成回归证据（脱敏）

- 任务：F-013 补齐 P02-1 的真实多进程集成回归（契约 §15 映射；证据只含
  非秘密实例/监听/锁/文件权限/进程退出与实际命令退出码）。
- 受测入口：生产 CLI 执行层 `runHostCli`（`packages/cli/src/host/execute.ts`）、
  Host 启动入口（`packages/host/src/runtime/`，经测试加载器 hooks 以 TS 源码
  或 dist 产物运行）、`shiploop-core` 装配入口（`openCoreApplication`）。
- 回归套件：`test/modules/host/p02-1-integration-regression.test.ts`（29 项）；CLI 驱动
  子进程夹具：`test/helpers/host/cli-driver-child.ts`（ready/go 同步屏障，
  在独立真实子进程中运行生产执行层）。
- 运行边界：macOS（flock）、真实临时数据根（沙箱内独立 home/tmp/data，
  不读写真实 HOME 或用户项目）、真实 Node 子进程、真实回环 HTTP；证据登记
  全部凭据为秘密，Authorization 头与 token 正文不进任何证据。
- 本文档不记录开发机绝对路径与真实凭据；未运行项显式记 `not_run`。

## 1. §15.1 FR 分支 → 测试映射

### FR-1 启动与发现

| 分支 | 覆盖用例（`test/modules/host/p02-1-integration-regression.test.ts`） |
|---|---|
| 正常：获锁→开 Core→Schema→回环端口→原子发现；重复 start 接同一实例 | 「两个 CLI 子进程同时 host start」「两个独立数据根并发 start」「合法 stop → … 重启新实例」 |
| 多候选竞争唯一持锁者 | 「三个 CLI 多候选竞争」（+ 两 CLI 用例；失败候选进程被 OS 核验退出，根下恰有一个 core.sqlite/writer.lock，胜者 pid==发现 pid；获锁先于 openCoreApplication 的直接锁顺序测试见 `test/modules/host/host-writer-lock.test.ts`/`test/modules/host/host-startup.test.ts`） |
| 路径别名同锁 | 「规范路径别名与真实路径两个 CLI 同时 start」（同一 dataRootIdentity、同一实例；锁/存储 API 拒绝非 realpath 输入） |
| 独立数据根 | 「两个独立数据根并发 start」（两 Host 并存、身份不同、各自持锁，停 A 不影响 B） |
| 错误/陈旧发现 | 「陈旧 PID 指向无关活进程」「崩溃后重新发现」（死端口 + 无关活 PID 获锁替换，无关进程存活；旧凭据 unauthorized） |
| 假服务 | 「假服务旧实例/数据根不匹配/协议不兼容/错误 schema/畸形响应」表驱动 + 302 重定向（只收到握手、无 writer.lock/core.sqlite） |
| 持锁但发现缺失/损坏（owner_unknown） | 「持锁但发现缺失」「持锁但发现损坏」（退出码 1、不绕过锁、不覆盖文件、候选被回收、原 Host 可认证；损坏文件恢复后可正常 stop） |
| 公网覆盖被拒 | 「T23 公开监听覆盖矩阵」（argv `--bind/--port` 与 `SHIPLOOP_HOST_BIND/SHIPLOOP_HOST_PORT` env × `0.0.0.0`/`::`/非回环 IP/域名 → 退出码 2，值不回显、根不创建） |
| 崩溃后释锁重获 | 「崩溃后重新发现」（SIGKILL 后锁立即可获；CLI start 换新实例） |

### FR-2 认证与停止

| 分支 | 覆盖用例 |
|---|---|
| 正常：Bearer 握手双向核验；只读 status；显式 stop 收尾→清理→释锁→退出 | 「两个 CLI 子进程同时 host start」（status 只读）、「合法 stop → 进程退出与锁释放 → 重启新实例…」（三证据 stopped） |
| 缺失/错误/陈旧 token | 「第三方篡改 auth.token」（unauthorized 退出码 1，零文件副作用，Host 存活；恢复后可用）、「崩溃后重新发现」与「合法 stop → …」（重启后旧 token 401） |
| 错误实例/数据根 | 「真 Host HTTP 负例矩阵」（409 instance_mismatch / data_root_mismatch）、「假服务旧实例/数据根不匹配」 |
| 协议不兼容 | 「真 Host HTTP 负例矩阵」（426 protocol_incompatible）、「假服务协议不兼容」（CLI 退出码 3） |
| 外部 Origin/Host | 「真 Host HTTP 负例矩阵」（Origin 401、伪造域名 Host 头 401） |
| 重复 stop 幂等（§10.4 行为子集） | 「同 commandId 停止请求进行中重放」（200 进度 replayed:true、enterQuiesce 恰一次；实例生命期结束后重复 stop → host_not_found 退出码 3） |
| stop 未确认保留锁 | 「停机未确认（quiesce_not_confirmed）」（CLI stop 退出码 1 resource_busy/quiesce_not_confirmed；CLI 竞争者 already_running 零候选、锁不可获、无第二写入者；活动收尾后同命令续跑 completed replayed:true） |
| 客户端退出 Host 存活 | 「两个 CLI 子进程同时 host start」（驱动子进程按 CLI 退出码退出后，另一客户端认证 status ready；F-010/F-012 套件另有启动中途被 SIGKILL 的用例） |
| SIGTERM 安全收尾 | 「持锁但发现缺失」（发现缺席按 skipped_discovery_absent 完成收尾；F-008 套件覆盖完整 SIGTERM/SIGINT 语义） |

## 2. §15.2 设计 09 编号子集声明（只认领已覆盖子集）

| 编号 | 本次（F-013 增量后）覆盖结论 |
|---|---|
| T10 | 仅凭据基础子集：发现/凭据/锁文件 0700/0600 与属主核验、Bearer-only、错误与证据不泄密、Origin/Host 拒绝；审批与项目隔离不属本 Feature（not_run） |
| T15 | 仅 Host 单例基础子集：重复 start 接同一实例、多候选/多客户端、崩溃后重新发现、规范根别名等价类；项目注册语义不覆盖（not_run） |
| T17 | 本 Feature 完整覆盖：Host 竞争、认证、协议版本、客户端退出（真实多进程） |
| T23 | 本 Feature 完整覆盖：本地 Host 不可改公网监听，配置/env/CLI 覆盖被拒绝（0.0.0.0/::/非回环 IP/域名） |
| T26 | 仅「同一实例 stop 的进程内版本化幂等」行为子集（§10.4：同 commandId 同摘要重放、不同摘要 conflict、实例生命期后 host_not_found）；`command_receipts` 持久化与设计 09 T26 配置 CAS/计划/审批 not_run（编号不一致核对请求见契约 §15.4） |

## 3. not_run（显式记录，不折算通过）

- 非 macOS 平台（Windows/WSL/Linux）的锁与生命周期验收。
- 项目注册/配置/基线命令、SSE/事件游标、Work/Batch/Run/Attempt 调度、
  Scheduler、Runner、Pi SDK 与模型执行、执行取消（进程树强制终止）、
  Chat、Web/Electron 配对。
- 通用命令回执体系与 `command_receipts` 持久化。
- `npm run accept:p02`（阶段末项；本 Feature 未提供任何整阶段通过脚本）。
- 强 OS 沙箱（同用户恶意进程不在强隔离保证内；advisory flock 边界见
  `docs/p02-1-writer-lock.md`）。
- 「重开 Core 查询前序持久数据」用例覆盖项目注册行的身份/元数据/绑定一致性；
  工件存储与更广的 P01 数据面回归沿用既有套件，不在本套件重复。

## 4. 非秘密证据类别（测试内 `evidence.record` fail-closed 落档）

- 实例：hostInstanceId（UUID v4）、dataRootIdentity（64hex，非凭据）。
- 监听：`127.0.0.1:随机端口`（发现端口 == 实际分配端口）。
- 文件权限：`host/` 0700；`discovery.json`/`auth.token`/`writer.lock` 0600。
- 进程：胜者/落选候选/驱动子进程 PID、退出码（0/1/2/3）与信号、ESRCH 核验。
- 锁：持有时非阻塞获锁失败（owner_unknown/owner_active）；释放后可获即释。
- 命令退出码：各表驱动用例断言的 CLI 退出码 0/1/2/3（见 §1 映射行内标注）。

## 5. 实际检查命令与退出码（本任务验证记录，macOS / Node 22.19.0 / npm 10.9.3）

| 命令 | 结果 | 退出码 |
|---|---|---|
| `npm test -- test/modules/host/p02-1-integration-regression.test.ts`（连跑 4 次） | 29/29 通过 ×4，ps 核验零夹具/Host 残留 | 0 |
| `npm run typecheck` | 无诊断 | 0 |
| `npm run check:boundaries` | 62 个生产 TS 文件、0 诊断 | 0 |
| `npm test`（全量） | 58 files / **1329 tests** 全绿（新增 29；F-012 时 1300 保持全绿；含 `test/modules/engineering/boundary-check.test.ts` 真实子进程边界检查） | 0 |
| `npm run build` | 原生锁 + 三包 tsc -b + prepare-cli-bin + 冒烟（core assembly、host start、cli bin 纵向、三包入口无副作用）全 0 | 0 |
| `npm run verify` | test/typecheck/build 3/3 EXIT 0，PASS | 0 |
| 干净树实测（移除三包 dist）：`npm run typecheck` + 本套件/`host-cli-execute`/`host-launcher` | 全部退出 0（CLI 驱动子进程经加载器第三处精确映射 `shiploop-host` → host src 运行源码）；随后重建 `npm run build` | 0 |

> `npm run verify` 内含 test/typecheck/build 三步（边界检查经 `npm test` 中的
> `test/modules/engineering/boundary-check.test.ts` 真实子进程执行），任何一步非 0 即整体非 0；
> 失败先补失败回归再修复，不删测试/降门槛。
