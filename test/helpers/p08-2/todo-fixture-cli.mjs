#!/usr/bin/env node
/**
 * P08-2 / F-003 参考 Todo CLI 夹具：按冻结契约实现九类可观察行为，供局部契约
 * 检查器在真实临时项目中核对。仅测试使用，不是产品实现。
 *
 * 存储：<cwd>/data/todo.json（数组 [{id,title,done}]）。list 输出每行
 * `<id> | <title> | done|open`，空列表输出 `(empty)` 且退出码 0。
 *
 * 确定性故障注入：TODO_FIXTURE_FAULTS 环境变量（逗号分隔），只用于证明检查器
 * 能抓住违约交付，不代表允许的真实实现：
 * - accept-empty-title        空标题/缺参被接受并退出 0（违约）
 * - silent-unknown-id         未知 ID 静默成功（违约）
 * - silent-invalid-command    未知子命令静默成功（违约）
 * - silent-read-failure       读失败被当作空列表退出 0（违约）
 * - swallow-write-failure     写失败被吞掉退出 0（违约）
 * - corrupt-on-failure        校验失败时清空数据文件（破坏已有数据）
 * - no-persist                新增只写内存不落盘（跨进程持久化违约）
 *
 * 错误输出只含错误码与语义文字，不输出绝对路径或环境内容。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const faults = new Set((process.env.TODO_FIXTURE_FAULTS ?? '').split(',').map(v => v.trim()).filter(Boolean));
const dataDirectory = join(process.cwd(), 'data');
const dataFile = join(dataDirectory, 'todo.json');

function corruptIfArmed() {
  if (faults.has('corrupt-on-failure')) {
    try { mkdirSync(dataDirectory, { recursive: true }); writeFileSync(dataFile, '[]'); } catch { /* 注入自身失败不掩盖原失败 */ }
  }
}

function loadItems() {
  if (!existsSync(dataFile)) return [];
  let raw;
  try {
    raw = readFileSync(dataFile, 'utf8');
  } catch (error) {
    if (faults.has('silent-read-failure')) { console.log('(empty)'); process.exit(0); }
    console.error(`todo: 数据文件读取失败（${error?.code ?? 'EIO'}），已保留原数据`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch {
    if (faults.has('silent-read-failure')) { console.log('(empty)'); process.exit(0); }
    console.error('todo: 数据文件损坏，已保留原数据');
    process.exit(1);
  }
}

function persist(items) {
  if (faults.has('no-persist')) return;
  try {
    mkdirSync(dataDirectory, { recursive: true });
    writeFileSync(dataFile, `${JSON.stringify(items, null, 2)}\n`);
  } catch (error) {
    if (faults.has('swallow-write-failure')) process.exit(0);
    console.error(`todo: 数据写入失败（${error?.code ?? 'EIO'}），已保留原数据`);
    process.exit(1);
  }
}

const [command, ...args] = process.argv.slice(2);

if (command === 'list') {
  const items = loadItems();
  if (items.length === 0) console.log('(empty)');
  else for (const item of items) console.log(`${item.id} | ${item.title} | ${item.done ? 'done' : 'open'}`);
  process.exit(0);
}

if (command === 'add') {
  const title = args.join(' ').trim();
  if (title === '') {
    if (faults.has('accept-empty-title')) {
      const items = loadItems();
      const id = items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
      persist([...items, { id: String(id), title: '', done: false }]);
      console.log(`已新增 #${id}`);
      process.exit(0);
    }
    corruptIfArmed();
    console.error('todo: 标题不能为空（title must not be empty）');
    process.exit(1);
  }
  const items = loadItems();
  const id = items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
  persist([...items, { id: String(id), title, done: false }]);
  console.log(`已新增 #${id} ${title}`);
  process.exit(0);
}

if (command === 'complete' || command === 'delete') {
  const id = args[0];
  if (id === undefined || id.trim() === '') {
    corruptIfArmed();
    console.error(`todo: 用法：todo ${command} <ID>`);
    process.exit(2);
  }
  const items = loadItems();
  const found = items.find(item => item.id === id);
  if (found === undefined) {
    if (faults.has('silent-unknown-id')) process.exit(0);
    corruptIfArmed();
    console.error(`todo: ID 不存在：${id}`);
    process.exit(1);
  }
  const next = command === 'complete'
    ? items.map(item => (item.id === id ? { ...item, done: true } : item))
    : items.filter(item => item.id !== id);
  persist(next);
  console.log(command === 'complete' ? `已完成 #${id}` : `已删除 #${id}`);
  process.exit(0);
}

if (faults.has('silent-invalid-command') && command !== undefined) process.exit(0);
corruptIfArmed();
console.error(`todo: 无效命令：${command ?? '(missing)'}；用法：todo <add|list|complete|delete> [参数]`);
process.exit(2);
