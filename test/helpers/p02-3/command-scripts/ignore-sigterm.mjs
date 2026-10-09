// F-003 基线命令样例：忽略 SIGTERM（只有 SIGKILL 能终止）。
// 用于验证取消/超时的 SIGTERM→等待→SIGKILL 升级窗口与「退出经核验」。
process.on('SIGTERM', () => {
  process.stdout.write('sample-ignore-sigterm:term-ignored\n');
});
process.stdout.write('sample-ignore-sigterm\n');
setInterval(() => {}, 1_000);
