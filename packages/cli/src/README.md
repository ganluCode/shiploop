# shiploop-cli 源码

CLI 承担：Host 生命周期命令的参数解析、结构化输出与 Host 客户端编排。详见设计
`core-design/08-host-api-and-cli.md` 与本仓库 `docs/p02-1-host-lifecycle-contract.md` §13。

- 允许：经包名 `shiploop-host` 公共面依赖 Host 的客户端/契约/启动器（F-011 起复用
  `isUuidV4`、错误码冻结表、`BIND_OVERRIDE_ENV_KEYS`、启动预算常量）；经 HostClient
  调用命令与查询。
- 禁止：导入 Host 启动入口（`dist/start.js` 由 Host 启动器 spawn，不由 CLI 内联启动）
  或 Host/Core 的内部实现文件；绕过 Host 直读 SQLite；在公共入口/解析层读
  process.argv/env、监听端口、spawn 进程、启动模型或常驻进程、写用户数据。

当前状态：

- F-011：`host/args.ts`（`host start/status/stop` 纯解析）、`host/help.ts`（帮助）、
  `host/output.ts`（§13.3 JSON 信封与四档退出码），经 `index.ts` 纯 re-export；
  加载无副作用，解析失败不发生任何 I/O。
- F-012（待实现）：显式可执行入口 `bin.ts`（shebang）→ `dist/bin.js` 与
  package.json `bin` 字段，把解析结果接到 HostClient/启动器。

单向依赖规则见仓库根 `README.md`。
