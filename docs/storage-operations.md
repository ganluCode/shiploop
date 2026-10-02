# P01-2 存储操作与恢复说明

- 适用阶段：P01-2（SQLite 原子存储与制品落盘）。
- 适用平台：macOS（首个正式支持平台）；Windows / WSL / Linux 未验收。
- 设计依据：`core-design/03-storage-and-transactions.md`、`core-design/11-database-model.md`、
  `core-design/07-verification-and-delivery.md`、`08-migration-roadmap.md`（版本见验收报告
  [p01-2-f014-report.md](acceptance/p01-2-f014-report.md) 的 SHA-256 清单）。
- 本文只描述**已实现并已验收**的接口与行为；示例引用真实可调用接口，未提供的 CLI 命令一律不编造。
  完整证据与命令退出码见验收报告。

## 1. 范围

本阶段实现了四类窄端口与其 SQLite/文件适配器，以及两个 application 用例：

| 层 | 模块 | 能力 |
|---|---|---|
| ports | `shiploop-core`（公共入口） | `StateStore`、`ArtifactStore`、`ArtifactFileStore` 契约、结构化错误、运行时校验、配置 Payload Schema、迁移记录契约 |
| application | `artifact-publish.ts` | 制品流式发布编排（`createArtifactPublisher`） |
| application | `artifact-verify.ts` | 中断核对、损坏诊断与有效读取（`createArtifactVerifier`） |
| adapters | `adapters/sqlite/*` | 连接会话、迁移执行、StateStore、ArtifactStore |
| adapters | `adapters/fs/artifact-files.ts` | 受控逻辑定位、staging、不覆盖发布、有界扫描 |

**当前适配器位于 `packages/core/src/adapters/`，不经 `shiploop-core` 的 package `exports['.']` 暴露**
（契约区分层禁止反向依赖 `adapters`）。跨包组合根已由 P01-3 / F-012 在 Core 内定案为受控装配入口
`openCoreApplication`，经 `shiploop-core` 的 `./assembly` 子路径导出（见
[p01-3-operations.md §1](p01-3-operations.md) 与 [p01-4-handoff.md](p01-4-handoff.md)）。

## 2. 核心概念

### 2.1 schemaVersion 与 revision

- **`schemaVersion`（数据格式版本）**：描述 JSON `payload` 的结构版本，当前为 `2`（`SettingsPayload`
  只接受 `schemaVersion: 2`；F-008 由 1 显式升级为 2，新增 `policies` 政策子集，v1 不再接受）。它是**数据格式门槛**，未知版本拒绝，不与并发计数混用。
- **`revision`（CAS 并发计数）**：每个可变聚合每次成功写入递增（≥1），用于 `expectedRevision`
  条件更新。过期 revision 返回 `StorageError(kind='conflict')`，原记录不变。
- 三者分开表达：`schemaVersion`（格式）、`revision`（并发）、`version`（制品内容版本，≥1）。
- 时间为应用侧填充的 **UTC 毫秒整数**；不依赖数据库时钟默认值。

### 2.2 受控数据根与逻辑 locator

- 数据库文件位置与制品文件根都由调用方显式传入的**受控数据根**推导，不在 import 时打开用户库。
- `locator` 是制品索引中的**逻辑身份**字段（POSIX 相对路径），只参与校验与诊断，**绝不参与物理路径推导**。
- 物理位置只由 `dataRoot + projectId + artifactId` 推导：
  - 正式正文：`<数据根>/projects/<projectId>/artifacts/<artifactId>/content`
  - 暂存文件：`<数据根>/staging/<projectId>/<artifactId>.<随机>.part`
- `displayName`、`description`、`kind`、中文标题均不能控制物理路径。

### 2.3 busy 预算

SQLite 写事务使用 `BEGIN IMMEDIATE`，争用写锁时在**有限预算**内重试：

- 默认：`busyTimeoutMs = 250`、`busyRetryAttempts = 3`（总预算 = attempts × busyTimeoutMs）。
- 上限：`MAX_BUSY_TIMEOUT_MS = 60_000`、`MAX_BUSY_RETRY_ATTEMPTS = 16`（防止事实上的无限等待）。
- 预算耗尽抛 `StorageError(kind='busy')`，`details` 只含 `{ attempts, busyTimeoutMs }`，不含数据库路径或 SQL 原文。
- 事务内**禁止**文件流、SDK、Git、网络或长检查；回调必须同步返回，`async`/Promise 回调被拒绝且整组回滚。

### 2.4 连接 PRAGMA 策略

每次实际连接都应用并现场核验（`pragmaSnapshot()` 可交叉核对）：

| PRAGMA | 值 | 说明 |
|---|---|---|
| `foreign_keys` | `ON` | per-connection，每次打开重新启用 |
| `journal_mode` | `wal` | 支持持锁期间并发读与在线备份 |
| `synchronous` | `FULL`（=2） | 每次提交 fsync，首版优先正确性 |
| `busy_timeout` | 预算参数 | 与 open 参数一致 |

## 3. 最小端口使用示例

以下示例**与 [`test/sqlite-storage-integration.test.ts`](../test/sqlite-storage-integration.test.ts)
的全链路闭环同构**，并由 [`test/docs-storage-operations.test.ts`](../test/docs-storage-operations.test.ts)
编译并执行（编译检查 + 运行断言）。示例仅使用真实导出接口，未编造命令。

```ts
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createArtifactPublisher } from '../packages/core/src/application/artifact-publish.ts';
import { createArtifactVerifier } from '../packages/core/src/application/artifact-verify.ts';
import { createArtifactFileStore } from '../packages/core/src/adapters/fs/artifact-files.ts';
import { createSqliteArtifactStore } from '../packages/core/src/adapters/sqlite/artifact-store.ts';
import { createSqliteStateStore } from '../packages/core/src/adapters/sqlite/state-store.ts';
import { migrateSqliteStorage } from '../packages/core/src/adapters/sqlite/migrator.ts';
import { openSqliteStorageSession } from '../packages/core/src/adapters/sqlite/session.ts';

const dataRoot = '/受控/临时/数据根'; // 调用方显式提供的受控数据根
const dbPath = join(dataRoot, 'state.db');

// 1) 打开会话（固定 PRAGMA 策略）；先迁移后使用。
const session = openSqliteStorageSession({ path: dbPath });
await migrateSqliteStorage(session);

// 2) 装配端口与用例（时钟可注入以获得确定性时间）。
const state = createSqliteStateStore(session, { nowUtcMs: Date.now });
const artifacts = createSqliteArtifactStore(session, { nowUtcMs: Date.now });
const files = createArtifactFileStore({ dataRoot });
const publisher = createArtifactPublisher({
  artifacts,
  files,
  limits: { maxSizeBytes: 1_048_576, timeoutMs: 30_000 },
});
const verifier = createArtifactVerifier({
  artifacts,
  files,
  limits: { maxReadBytes: 1_048_576 },
});

// 3) 原子组合创建项目 + 初始项目配置（无半条记录）。
const created = await state.createProjectWithInitialSettings(
  { displayName: '示例项目', description: '可选说明', labels: ['P01 ', '示例'] },
  { payload: { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } } } },
);

// 4) 流式发布制品：pending 登记 → 事务外 staging 写入/同步 → hash 核验 → 不覆盖发布 → CAS ready。
const content = [new TextEncoder().encode('ShipLoop '), new TextEncoder().encode('示例正文')];
const expectedHash = createHash('sha256').update(Buffer.concat(content.map(Buffer.from))).digest('hex');
const published = await publisher.publishArtifact({
  projectId: created.project.id,
  kind: 'verification-report',
  mediaType: 'text/markdown',
  expectedHash,
  locator: 'reports/示例.md',
  content,
});

// 5) 读取有效输入引用（仅同项目 ready 制品可得）。
const ref = await artifacts.getArtifactInputRef(created.project.id, published.artifact.id);
// 6) 核验后读取正文（读前做完整性检查，缺失/篡改报 corrupt 而非空内容）。
const contentRead = await verifier.readVerifiedContent(created.project.id, published.artifact.id);

// 7) 关闭；重开同一数据根后逐字段一致（不依赖内存缓存）。
session.close();
```

> 说明：以上为源码相对导入示例（供仓库内测试与阅读）；跨包使用时端口与用例经
> `shiploop-core` 公共入口导出，真实 SQLite/文件适配器的跨包装配边界见交接文档。

## 4. 项目与配置操作

`StateStore`（项目 / 全局当前配置 / 项目当前配置）关键方法：

| 方法 | 语义 | 失败形态 |
|---|---|---|
| `createProject(input)` | 创建项目，初始 `revision=1`、`status='active'`、`labels` 规范化 | 非法输入 `validation`，零持久化副作用 |
| `getProject(projectId)` | 读取项目 | 不存在 `not_found` |
| `updateProject(projectId, input)` | 元数据 CAS 更新（名称/说明/标签），至少一个字段 | 过期 `conflict`，原记录不变 |
| `createProjectWithInitialSettings(project, settings)` | 项目 + 初始项目配置**原子组合创建** | 任一步失败整组回滚，无半条记录 |
| `createGlobalSettings(input)` / `getGlobalSettings()` / `updateGlobalSettings(input)` | 全局单例（`id='global'`）；更新成功同事务追加 `settings.global_updated` 脱敏审计记录 | 重复创建 `conflict`，过期 `conflict` |
| `createProjectSettings(projectId, input)` / `getProjectSettings(projectId)` / `updateProjectSettings(projectId, input)` | 每项目一条；更新成功同事务追加 `settings.project_updated` 脱敏审计记录；创建/更新接受可选 `consistency.globalRevision` 一致性前置条件（同一写事务内核对，防基于陈旧全局依赖提交） | 项目不存在 `not_found`，重复 `conflict`，过期 `conflict`，前置条件不满足 `conflict`（stale_dependency） |

校验规则（失败即 `StorageError(kind='validation')`，不产生持久化副作用）：

- 项目/配置输入一律经运行时校验；TypeScript 类型不替代校验。
- 当前配置只接受通过 `schemaVersion=2` 限定 Schema 的 `payload`；未知 schemaVersion / 未知键 /
  不完整策略条目一律拒绝，任意对象不能冒充可执行策略。
- 读取持久 JSON 时再次校验；损坏 JSON / 未知格式返回 `corrupt`，绝不作为有效配置返回。
- 标签规范化：`trim → NFC → ASCII 小写 → 实体内去重`；默认空数组。

## 5. 制品生命周期

### 5.1 状态机

```
pending ──(CAS, 实测 hash 匹配 + 实际 size)──▶ ready
   └────(CAS, 原因与阶段证据)───────────────▶ failed
```

- `pending`：`registerArtifact` 登记索引（应用侧 UUID、`revision=1`、`content_hash/size=NULL`）。
  大正文永不进 SQLite。
- `ready`：发布核验通过后经 `transitionArtifact` 条件转换；**内容身份（hash/size/version/locator）
  一经 ready 不接受普通更新覆盖**，正文变更必须创建新制品。
- `failed`：保留 `failureReason`（阶段化脱敏证据）；终态重复转换返回 `conflict`，不覆盖既有状态。
- `getArtifactInputRef` 仅同项目 `ready` 且证据完整时返回引用；`pending`/`failed` 返回 `conflict`；
  跨项目访问返回 `ownership`（即使制品 ready，也不能仅凭全局 `artifactId` 放行）。

### 5.2 发布顺序（`publishArtifact`）

1. `registerArtifact`（短事务 pending）；
2. `openStagingWrite` + 逐块背压写入（增量 hash 与字节计数，不缓冲整流）；
3. `finishStaging`（fsync + 关闭）；
4. 核验实测 SHA-256 / 字节数与登记预期；
5. `publishStaging`（同文件系统 hard link，不覆盖；目标已存在返回 `conflict` 并保留）；
6. `transitionArtifact`（短事务 CAS 标 `ready`）。

文件流、`fsync` 与发布**全部在数据库事务之外**；限制（`maxSizeBytes` / `timeoutMs` /
`AbortSignal`）显式有限。失败保留 `stage`（`register` / `staging` / `verify` / `publish` / `commit`）
与 `code` 证据；`commit` 阶段失败（正式文件已发布但 ready 提交失败）保持 `pending` + 正式文件供恢复，
**不标 failed、不删文件**。

### 5.3 文件路径安全

- 输入校验失败抛 `StorageError(kind='validation')`；运行期文件条件抛 `ArtifactFileError`
  （`invalid_input` / `escape` / `conflict` / `not_found` / `not_regular_file` / `permission` / `io`）。
- 三层防线：稳定 ID 受限字符集校验 → 已存在祖先 `realpath` 必须位于授权根内 →
  文件操作 `lstat`/`no-follow`（读取 `O_NOFOLLOW` 打开 + `fstat` 复核常规文件）。
- staging 与正式文件结构性地位于同一文件系统；发布使用 `link` 的 `EEXIST` 语义保证**不覆盖**，
  无检查-操作窗口。
- 可信项目模式边界：检查与操作之间的并发替换窗口由「单 Host 写入者 + 用户明确授权的可信项目」
  前提收窄，**不宣称强 OS 沙箱**。

## 6. 中断核对与损坏诊断

`createArtifactVerifier` 提供三个入口：

| 入口 | 用途 |
|---|---|
| `verifyArtifact(projectId, artifactId)` | 单制品核对，返回 `ArtifactVerifyReport` |
| `verifyProject(projectId, options?)` | 项目级批量核对 + 孤儿扫描（有界分页） |
| `readVerifiedContent(projectId, artifactId)` | 必要完整性检查后的有效读取（缓冲受 `maxReadBytes` 上限） |

`ArtifactVerifyReport.kind` 取值：

| kind | 含义 | 索引状态变化 |
|---|---|---|
| `recovered_ready` | pending + 正式文件核验通过，CAS 补 `ready` | pending → ready |
| `verified_ready` | ready 且完整性通过（幂等） | 不变（revision 不变） |
| `interrupted` | pending 只有 staging 残留或无正文（`staging_only` / `no_content`） | 保持 pending，不可用 |
| `corrupt` | 正文损坏（见下） | 不变，不覆盖、不删除 |
| `failed_evidence` | failed 终态，保留原因与残留证据 | 不变 |
| `untrusted_file` | 逃逸/非常规文件/权限/IO，不跟随、不删除 | 不变 |

损坏诊断 `ArtifactCorruption.kind`（互斥）：

- `missing`：正文缺失；
- `size_mismatch`：字节数不符；
- `hash_mismatch`：摘要被篡改（`expectedHash` / `actualHash` / 大小证据随报告携带）。

`readVerifiedContent` 在读取前执行存在性/大小/摘要检查；缺失或篡改抛
`ArtifactVerifyError(code='corrupt')` 并携带 `corruption`，**不把缺失正文当空内容**。

`verifyProject` 扫描正式区与 staging 区（不跟随链接、每批有界），生成孤儿/未信任条目证据
（`final_without_index` / `staging_without_index` / `untrusted_entry`）。孤儿处置 `orphanPolicy='kept_in_place'`：
**原文件一律保留在原位置，不立即删除、不创建索引、不跨项目自动绑定**（安全隔离迁移待保留策略设计）。

## 7. 恢复步骤

### 7.1 发布中断（Host 崩溃 / 断电后的重开）

1. 重开同一数据根（`openSqliteStorageSession` + `migrateSqliteStorage` 幂等）。
2. 对目标制品调用 `verifyArtifact`：
   - 返回 `recovered_ready`：正式文件已存在且 hash/size 匹配，索引已 CAS 补齐，恢复正常使用；
   - 返回 `interrupted`：只有 staging 残留或无文件，保持不可用；残留位置与字节数在报告
     `stagingResidues` 中（不自动删除，待人工/后续策略处理）；
   - 返回 `corrupt`：正式文件存在但摘要/大小不符，保留文件与诊断，**不覆盖**。
3. 需要批量恢复时调用 `verifyProject`（`pageSize` / `maxArtifacts` / `maxOrphans` 有界）。
4. 核对与状态更新竞争时，核对结果一律经端口 CAS 提交；`conflict` 时重新读取并按新状态重新核对
   （重试 ≤3 次），**旧检查结果绝不倒写**。
5. 需要重新发布时**创建新制品**（`publishArtifact`），不复用已 ready 的内容身份。

### 7.2 迁移失败

- `migrateSqliteStorage` 分三步：`verify`（任何写入之前核验调用方清单与已应用记录）→
  `backup`（已有库且有迁移时，在线一致性备份 + `integrity_check`）→ `apply`（每个迁移在同一短事务内
  DDL + 写 `schema_migrations`）。
- 拒绝写入（不修改库，`StorageError`）：
  - 高于支持版本：`unsupported_version`（`details` 含 applied/supported 版本）；
  - checksum 漂移：`corrupt`（`details` 含 version）；
  - 版本缺口/乱序、已有用户表但无迁移记录：`corrupt`；
  - 清单 checksum 与内容不符、序列断裂：`validation`（在接触库前）。
- 备份或应用阶段失败抛 `SqliteMigrationError`（`step` ∈ `verify`/`backup`/`apply`、`version`、
  `backupPath`）；失败迁移的变更与记录**全部回滚**，备份证据保留不删除。修复后重开可从一致的原版本继续，
  **不伪装初始化成功**。
- 从备份恢复（人工演练）：备份是**数据库级**一致性备份；恢复时复制该备份文件到独立位置后用
  `openSqliteStorageSession` 打开，并用 `integrity_check` 核验。**不要**复制正在使用的单个 `.db` 文件
  冒充 WAL 备份。恢复演练与 `integrity_check=ok` 由
  [`test/sqlite-migration-runner.test.ts`](../test/sqlite-migration-runner.test.ts) 覆盖。
- **备份边界**：备份只覆盖 SQLite 状态库，**不包含受控文件根中的制品正文**。数据库备份 ≠ 含制品正文的
  全量备份；正文证据需另行核对（见 §6），当前**未声明全量恢复能力**。

### 7.3 busy / 冲突

- `StorageError(kind='busy')`：写事务在有限预算内未获锁。确认锁释放后由调用方重试；失败不提交相关写入。
- `StorageError(kind='conflict')`：CAS 过期或终态重复转换。重新读取最新记录（含 revision）后用新
  `expectedRevision` 重试；不得先读后无条件覆盖。
- `StorageError(kind='not_found' / 'ownership' / 'validation' / 'corrupt' / 'unsupported_version')`
  分别对应缺失、跨项目归属、输入非法、持久数据损坏、不支持版本；错误携带 `operation` 与实体身份，
  消息与 details 脱敏（不含绝对路径与秘密）。

## 8. 由 P01-3 补齐 / 仍未实现（不得冒充）

> P01-3 已在本文所述端口之上补齐下列能力，细节见 [p01-3-operations.md](p01-3-operations.md)：
> 仓库注册流程（幂等复用 / 同 remote 多 clone 分别注册）、统一 `PathService` 数据根解析与受权
> 定位、配置有效合并 / 逐项来源、项目列表分页与标签筛选/计数、`state_events` 脱敏审计（迁移 v2）。

仍未实现：

- 未建立执行 / Chat / 知识等后续表（Phase/Feature/Task/Run/Attempt/Batch/Session/Chat、
  project_profiles、capability_modules、verification_batches 等）；`source_attempt_id`、
  `retention_class` 等字段随对应功能迁移增加。
- 未实现模型路由、Task 策略复制、凭据解析（只保存引用）、配置历史版本表。
- 未提供 Host/CLI 命令、`accept:p01` 阶段验收。
- 未做真实断电 / 磁盘满演练、Windows/WSL/Linux 平台验收、Electron 原生模块打包、模型 Live 调用、
  强 OS 沙箱。
- 孤儿文件安全隔离迁移（当前 `kept_in_place` 保留原位）、Host 停机升级编排与自动降级。
