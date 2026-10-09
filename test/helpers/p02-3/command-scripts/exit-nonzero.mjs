// F-003 基线命令样例：非零退出码（默认 3，可由 argv[2] 覆盖）。
// 期望检查状态 failed（退出码被记录，不折算为 error/inconclusive）。
const requested = Number(process.argv[2] ?? 3);
const code = Number.isInteger(requested) && requested !== 0 ? requested : 3;
process.stderr.write(`sample-nonzero-exit:${code}\n`);
process.exit(code);
