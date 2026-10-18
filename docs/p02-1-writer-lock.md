# P02-1 / F-004 macOS 写入锁决定与装配交接

范围：只交付真实 OS 锁与受锁保护的写入资源生命周期。不是 Host 启动、HTTP/CLI、Work 或 P02 验收报告。
协议依据：[生命周期契约 §6](p02-1-host-lifecycle-contract.md#6-os-排他锁与单例语义f-004-的契约面)。

## 决定：实际写入进程直接持 fd

- `packages/host/native/writer-lock.c` 是新编写的极小 N-API C 适配器，仅调用
  `fcntl(FD_CLOEXEC)` 与 `flock(fd, LOCK_EX | LOCK_NB)`；没有辅助进程、PID 文件、
  SQLite busy、目录占用模拟锁，也没有复制 Spike。实际 Node Host 同时是持锁者与写入者。
- Node 通过 `O_CREAT | O_RDWR | O_NOFOLLOW | O_NONBLOCK` 打开规范根内的
  `host/writer.lock`（0600），核验普通文件、当前属主、权限、nlink=1、路径/fd 的 dev+ino
  一致，并在每次尝试与获锁后复核。FD 隐藏在闭包内，不导出给业务或子进程；close 释锁。
- 私有父目录必须在**获锁前**建立或核验（0700），否则无锁目标可打开；获锁前只允许根解析、
  host/ 与锁文件创建/安全核验，不能开 Core、迁移或写发现/凭据。这澄清契约原来的父目录创建顺序。
  并发 mkdir 的 EEXIST 仍须复核目录，而不是跳过安全检查。
- 锁文件从不截断、移动、删除或原子替换。正常关闭后仍保留同一 inode。业务清理只能删除
  当前实例的发现/凭据。FD_CLOEXEC 避免 exec 子进程延长持锁生命期。
- SIGKILL/异常退出由内核在写入进程退出时释放锁。不存在「杀掉持锁辅助者但写入者仍活着」
  的窗口。不要把锁 fd 转交 worker/其他进程，也不要在业务写入未关闭时手动释放。
- 这是可信单用户的**协作式 advisory 锁**，不防同用户恶意进程主动替换锁 inode、绕开 API
  直接写 SQLite、关闭任意 fd 或加载恶意原生代码。只支持 macOS 本地数据根；共享 NAS、
  Linux/WSL/Windows、Electron/通用二进制发布另行验收。

## 原生工具与构建边界

不新增 npm 依赖，不修改精确工具版本或 lockfile。Node 内置 N-API 头文件用于编译；
构建需要 `/usr/bin/clang`、macOS SDK（Xcode Command Line Tools）及当前 Node 安装旁的
`include/node/node_api.h`。这些是显式开发构建前提，不是运行时辅助进程。

```sh
npm ci
npm run build
npm test -- test/modules/host/host-writer-lock.test.ts
npm run typecheck
npm run check:boundaries
npm run verify
```

- 根/host 包 `build` 先运行 `scripts/build-host-lock.ts`（60s 上限，无 shell/下载），
  以临时文件 + rename 发布 `packages/host/dist/native/writer-lock.node`，然后执行既有 TS
  构建与入口冒烟。原生文件随 host 包的 `files: ["dist"]` 携带。
- `npm test` 的锁测试显式编译适配器，因此干净源码树无需先 build；工具/编译失败使测试失败，
  不 skip。类型检查无需先编译原生模块。
- import 公共入口不加载原生模块、不访问用户目录、不创建文件、不监听或 spawn；
  只有 `acquireWriterLock` 才 dlopen。运行时不自动编译，原生产物缺失/不可加载或未知平台
  → `unsupported_platform`；不降级到 lockf/PID/目录方案。
- 目前是本机架构构建，正式 universal/prebuilt/签名分发未运行；不要冒称跨架构产品支持。

## F-006 / F-008 装配端口

公共导出（`shiploop-host`）：

- `acquireWriterLock({ canonicalRoot, timeoutMs?, ownerProbe? })`：默认 10 000ms，内部预算
  0..10 000ms；0 = 单次非阻塞尝试，25ms 有界重试。只接受已 realpath 固定的根。
  返回的 `releaseAfterWritesClosed()` 是可信装配底层原语，不是 stop/取消接口。
- **优先使用** `openLockedWriter(options, openWriter)`：先获锁，之后才调用写入资源工厂。
  F-006 在工厂中调用 `openCoreApplication`、Schema 检查，再装配监听/发布。
  返回 `{ writer, close(cleanup?) }`；close 串联「writer.close → 持锁 cleanup → 释锁」，
  合并并发关闭。Core/写入者关闭失败或 cleanup 失败时保留锁，不报告停止；可重试同一对象。
  已成功关闭的 writer 不重复关闭，失败的 cleanup 被保留并再次尝试，不可通过省略回调绕过。
- 打开工厂失败前必须自行关闭已获取的部分资源（P01 `openCoreApplication` 已保证失败收尾）；
  工厂 reject 后才允许该包装释放锁。监听/发布后的失败也必须在工厂内按逆序收尾，或由
  已返回的生命周期对象关闭，不能留下写入者再 throw。
- 成功的 `close` 只证明该对象资源已关闭和锁已释放，**不证明 Host 进程已退出**；
  F-008/F-010 仍须按契约 §10.6 独立核验进程退出、锁可获、发现清理三项证据。
- 底层锁 API 不自动处理 SIGTERM、不实现 quiesce；信号安全关闭留待 F-008。
  不在本任务内绕过 DAG 实现 Host/CLI/Runner。

## 冲突与 owner 诊断

沿用现有契约错误 `operation: host.discovery`（锁是发现/启动的本地子步骤）；
reason 为 `lock_busy_owner_unverified` 等受控枚举，错误中无路径/凭据/探测异常原文。

- 默认锁冲突 → `owner_unknown`：发现缺失、损坏、旧 PID、PID 指向无关活进程，均不授权
  删除锁/发现、杀进程、绕过锁打开写库或接管。锁本身是唯一写入权证据。
- `ownerProbe(discovery, token, signal)` 是可信装配注入的**窄认证探测端口**，不是任意
  网络地址配置。模块先从 F-003 受保护文件读取合法发现/凭据；探测只应在固定回环端口
  完成认证握手，成功返回响应体，否则 reject。F-007/F-009 的真实传输尚未交付，
  本任务只测试受控端口，不宣称 HTTP 认证完成。
- 响应再经共享 `validateHandshakeResponse` 核验协议、实例、根、状态与能力，才报
  `owner_active`（details 含非秘密实例与根身份）。仅发现合法或 PID 活着不足以得出 active。
- 探测耗时包含在获取总预算内（单次最多 1s），有 timer race 和 AbortSignal；
  无响应、拒绝、身份/协议错误 → unknown，吞掉可能包含秘密的原始错误，不写文件。
  信号使真实传输释放本地观察资源，不能对远端调用 stop。两种诊断都不授予写入权。
- `platform` / `nativeAddonPath` 仅供可信装配/测试注入，不从 argv/env/发现接受；
  实际 `process.platform` 也必须为 darwin，无法通过注入字符串开启其他平台。

## 真实测试证据边界

`test/modules/host/host-writer-lock.test.ts` 经默认 npm test 收集，使用临时沙箱与真实 Node/SQLite：

- IPC ready/go 同步竞争：同根别名两个候选只有一个获锁并打开 Core/迁移，失败者没有 opening
  事件；正常 close 后竞争者可获原 inode；不同根两个真实 Core 可同时持锁。
- 实际写入进程 SIGKILL/SIGABRT 前锁仍不可获，退出回收核验后可重新获得；没有辅助锁进程。
- 目录/符号链接/硬链接/宽权限拒绝且不覆盖；预算有限；已知/未知 owner 分支及探测超时脱敏。
- 打开失败释锁、写入关闭失败/清理失败保锁、重试与并发 close、迟到 close 不解锁新持有者。

子进程仅使用临时 HOME/cwd、最小环境和自有 IPC handle，外层等待/回收均有上限；
不杀发现 PID，不访问真实用户项目/凭据，不调用模型。正式 start/status/stop、浏览器认证、
真实业务活动取消及其他平台均未运行，不纳入本任务通过数。
