// F-003 基线命令样例：成功退出（退出码 0）。
// 纯 node: 内置模块，无第三方依赖；以最小环境（PATH + 允许列表）可直接运行。
// 被检命令示例 argv：["node", "<此文件>"]；期望检查状态 passed。
process.stdout.write('sample-ok\n');
process.exit(0);
