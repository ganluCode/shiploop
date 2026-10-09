// F-003 基线命令样例：大量 stdout/stderr 输出。
// argv[2]/argv[3] 为 stdout/stderr 目标字节数（默认各 1 MiB）；用于验证有界采集、
// 输出溢出（output_overflow）与制品发布路径。分块写入避免单次大缓冲。
const stdoutBytes = Number(process.argv[2] ?? 1_048_576);
const stderrBytes = Number(process.argv[3] ?? 1_048_576);
const CHUNK = 8_192;
const line = 'x'.repeat(CHUNK - 1) + '\n';

function writeChunk(stream, targetBytes) {
  let written = 0;
  while (written < targetBytes) {
    const size = Math.min(CHUNK, targetBytes - written);
    stream.write(size === CHUNK ? line : 'y'.repeat(size - 1) + '\n');
    written += size;
  }
}

writeChunk(process.stdout, stdoutBytes);
writeChunk(process.stderr, stderrBytes);
// 不调用 process.exit：管道写入是异步的，强制退出会截断尚未刷出的 stderr。
// 令事件循环在全部写入 drain 后自然退出（退出码 0）。
process.exitCode = 0;
