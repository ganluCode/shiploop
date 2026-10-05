/**
 * F-012 构建后 CLI 显式入口准备（fail-closed 工程脚本，非 ShipLoop 业务 Verifier）。
 *
 * tsc 发射 packages/cli/dist/bin.js 后：
 * 1. 校验 dist/bin.js 存在、以 `#!/usr/bin/env node` shebang 开头（tsc 保留源码首行）；
 * 2. 校验 package.json bin 字段指向该产物；
 * 3. 设置可执行位 0o755（npm/pnpm 安装时也会按 bin 链接处理，直接
 *    `dist/bin.js` 执行同样可用）。
 *
 * 仅使用可擦除 TypeScript 语法，由 Node 22 原生类型擦除直接运行，无需先构建。
 */
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const cliDir = resolve(repoRoot, 'packages/cli');
const binPath = resolve(cliDir, 'dist/bin.js');
const manifestPath = resolve(cliDir, 'package.json');

function fail(message: string): never {
  process.stderr.write(`prepare-cli-bin: FAIL ${message}\n`);
  process.exit(1);
}

if (!existsSync(binPath)) {
  fail('packages/cli/dist/bin.js 不存在（tsc -b 必须先发射显式入口）');
}
const head = readFileSync(binPath, 'utf8').slice(0, 64);
if (!head.startsWith('#!/usr/bin/env node')) {
  fail('dist/bin.js 必须以 #!/usr/bin/env node shebang 开头');
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  bin?: unknown;
};
if (manifest.bin !== './dist/bin.js' && JSON.stringify(manifest.bin) !== JSON.stringify({ shiploop: './dist/bin.js' })) {
  fail('package.json bin 必须声明 { "shiploop": "./dist/bin.js" }');
}
const mode = statSync(binPath).mode & 0o777;
chmodSync(binPath, 0o755);
process.stdout.write(`prepare-cli-bin: ok dist/bin.js shebang verified, mode ${mode.toString(8)} -> 755\n`);
