/**
 * ShipLoop CLI 公共入口（构建产物）。
 *
 * 阶段边界：
 * - P01-1 / F-002：本文件为无副作用空骨架。
 * - F-011（P02-1）：导出 Host 生命周期 CLI 纯面层（src/host/）：
 *   host start/status/stop 的参数解析（parseHostCliArgs）、帮助文本
 *   （getHostCliHelp）、§13.3 JSON 信封与四档退出码。解析与执行分离：
 *   加载/导入本模块不解析 argv、不读环境、不读发现、不访问网络、不启动
 *   Host、不生成停止 commandId；env 必须显式注入。唯一外部包依赖是
 *   shiploop-host 公共面（UUID 判定、错误码表、冻结 env 覆盖键表与启动
 *   预算常量），不引用 Host 内部子路径、不直连 Core。
 * - F-012（待实现）：新增显式可执行入口 src/bin.ts（shebang）→ dist/bin.js
 *   与 package.json bin 字段，把解析结果接到 HostClient/启动器；本公共
 *   入口在 F-012 后仍保持无副作用。
 */
export * from './host/index.js';
