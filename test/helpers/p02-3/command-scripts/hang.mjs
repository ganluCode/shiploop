// F-003 基线命令样例：挂起（永不主动退出，保持事件循环存活）。
// 默认对 SIGTERM 敏感（可被受监督进程正常终止）；用于验证超时 → inconclusive/timed_out。
// 若父进程先退出，本进程成为孤儿并继续存活，因此必须由监督方显式核验并终止。
process.stdout.write('sample-hang\n');
setInterval(() => {}, 1_000);
