# shiploop-cli 源码

CLI 承担：Host 生命周期命令的参数解析、结构化输出与 Host 客户端编排。详见设计
`core-design/08-host-api-and-cli.md` 与本仓库 `docs/p02-1-host-lifecycle-contract.md` §13。

- 允许：经包名 `shiploop-host` 公共面依赖 Host 的客户端/契约/启动器（F-011 起复用
  `isUuidV4`、错误码冻结表、`BIND_OVERRIDE_ENV_KEYS`、启动预算常量；F-012 起经
  `ensureHostRunning`/`connectToHost`/`resolveConnectDataRoot`/受保护存储/锁公共面
  编排纵向命令）。
- 禁止：导入 Host 启动入口（`dist/start.js` 由 Host 启动器 spawn，不由 CLI 内联启动）
  或 Host/Core 的内部实现文件；绕过 Host 直读 SQLite；在公共入口/纯面层读
  process.argv/env、监听端口、spawn 进程、启动模型或常驻进程、写用户数据。

当前状态：

- F-011 纯面层（经 `index.ts` 公共出口）：`host/args.ts`（`host start/status/stop`
  纯解析）、`host/help.ts`（帮助）、`host/output.ts`（§13.3 JSON 信封与四档退出码）；
  加载无副作用，解析失败不发生任何 I/O。
- F-012 执行层与显式入口：
  - `host/execute.ts` 的 `runHostCli`（不经公共 barrel 导出）：start 只经
    `ensureHostRunning` 连接或启动；status/stop 经 `connectToHost` 只读连接，
    永不启动 Host（无实例 host_not_found）；stop 按契约 §10.6 在预算内取得
    进程退出/锁可获/发现删除或替换三证据才报告 stopped，否则 stop_not_confirmed。
    执行层只允许 node:os/node:timers，不直接使用 HTTP/child_process/fs。
  - `bin.ts`（shebang）→ `dist/bin.js`，package.json
    `bin: { "shiploop": "./dist/bin.js" }`；是包内唯一读 process.argv/env 与
    退出进程的文件。`npm run build` 经 `scripts/prepare-cli-bin.ts` 校验 shebang
    并置 0755，构建冒烟在非源码 cwd 跑通纵向命令。

单向依赖规则见仓库根 `README.md`。
