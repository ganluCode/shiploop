# P01-3 项目身份与当前配置操作说明

- 适用阶段：P01-3（项目身份与当前配置服务）。
- 适用平台：macOS（首个正式支持平台）；Windows / WSL / Linux 未验收。
- 设计依据：`core-design/01-system-structure.md`、`core-design/02-domain-and-lifecycle.md`、
  `core-design/03-storage-and-transactions.md`、`core-design/06-project-and-context.md`、
  `core-design/11-database-model.md`、`08-migration-roadmap.md`（版本见验收报告
  [p01-3-f014-report.md](acceptance/p01-3-f014-report.md) 的 SHA-256 清单）。
- 本文只描述**已实现并已验收**的 Core 应用服务与端口；示例引用真实可调用接口，未提供的
  CLI / Host 命令一律不编造。契约与设计张力见
  [p01-3-application-contract.md](p01-3-application-contract.md)，完整证据与退出码见验收报告。

## 1. 入口与范围

P01-3 交付可独立调用的 **Core 应用服务**，经受控装配入口取得（不直接 new 适配器）：

| 能力 | 端口 / 用例 | 位置 |
|---|---|---|
| 组合根 | `openCoreApplication(options)` → `CoreApplication` | `packages/core/src/adapters/composition.ts`，经 `shiploop-core` 的 `./assembly` 子路径导出 |
| 项目身份 | `ProjectService`（注册 / 查询 / CAS 编辑 / 标签筛选 / 计数） | `packages/core/src/application/project-service.ts` |
| 仓库检查 | `RepositoryInspector.inspect(path)`（只读 Git/文件检查） | `packages/core/src/adapters/fs/repository-inspector.ts` |
| 当前配置 | `ConfigurationService`（创建 / CAS 更新 / 查询 / 有效合并 / 脱敏导出） | `packages/core/src/application/configuration-service.ts` |
| 路径 | `PathService`（数据根 / 项目目录 / 受权资源定位） | `packages/core/src/adapters/fs/path-service.ts` |
| 存储底座 | `StateStore` / `ArtifactStore` / `ArtifactFileStore`（前序，复用） | `packages/core/src/adapters/sqlite/*`、`adapters/fs/artifact-files.ts` |

`CoreApplication` 返回面**只含**窄端口与用例（`dataRoot`、`pathService`、`stateStore`、
`artifactStore`、`artifactFileStore`、`repositoryInspector`、`projectService`、
`configurationService` 与幂等 `close()`），不暴露 `SqliteStorageSession`、better-sqlite3、
Drizzle、Pi SDK 或 HTTP 类型。

## 2. 核心概念

### 2.1 稳定 ID、UTC 与 revision

- **稳定 ID**：应用侧生成 UUID；跨受控路径使用的 ID 还须满足
  `^[A-Za-z0-9][A-Za-z0-9._-]*$`（1–128 位）。`projectId` 不由 `displayName`、`description`、
  标签、标题或 Git remote 生成。
- **UTC 时间**：`created_at` / `updated_at` / `occurred_at` 由应用侧填充 UTC 毫秒整数。
- **`revision`（CAS 并发计数）**：每个可变聚合每次成功写入递增（初始 `1`）；更新携带
  `expectedRevision`，过期返回 `StorageError(kind='conflict')`，原记录不变。`revision` 不等于
  `schemaVersion`（payload 数据格式版本），也不等于制品 `version`（内容版本）。
- **事务**：写操作走单个短同步 `BEGIN IMMEDIATE` 事务；事务内禁止文件流、Git、网络、模型或
  凭据解析；输入先经运行时校验再进 SQL。

### 2.2 scope

- `scope` 是**唯一的目标身份渠道**：`{ kind: 'global' }`（全局单例）或
  `{ kind: 'project', projectId }`（每项目一条覆盖）。不存在第二条传入项目身份的渠道。
- 全局配置单例 ID 为 `GLOBAL_SETTINGS_ID = 'global'`；项目配置每项目一条
  （数据库 `UNIQUE(project_id)`）；**不建配置历史版本表**。

## 3. 项目身份

### 3.1 注册与重复结果

```ts
const result = await app.projectService.registerRepository({
  repositoryPath: '/path/to/repo',   // 可为符号链接别名
  displayName: '示例项目',            // 展示名，不参与身份/路径
  description: '可选说明',            // 省略 / null / 空白 ⇒ null（空描述合法）
  labels: ['Alpha', ' beta ', 'alpha'],
});
// result: { status: 'registered' | 'already_exists', project, binding }
```

- 顺序：先做**只读**仓库检查得到 `canonicalPath`，再在同一短事务内原子保存项目 + 仓库绑定。
- 同 `canonicalPath`（含符号链接别名）重复注册 ⇒ `already_exists` 与既有项目/绑定，
  **不新增行、不覆盖**名称/描述/标签。
- 不同 clone（remote 相同、路径不同）分别注册，得到不同 `projectId` 与 `canonicalPath`；
  `remote` 只作信息，不作唯一身份。
- 跨进程竞争注册同一路径由「写锁下的检查并插入 + `canonical_path` 唯一约束」保证恰一个
  `registered`，其余复用胜者。
- `RepositoryBindingRecord` 含 `canonicalPath` / `gitCommonDir` / `repoIdentity` / `revision` /
  `bindingRevision` / UTC 时间；瞬时事实（HEAD/脏状态）**不持久化**。

### 3.2 仓库支持范围（F-004 定案）

- **接受**：工作树根（含无初始 commit、脏工作区）、根的符号链接别名、linked worktree 顶层。
- **拒绝**：不存在路径、普通文件、非 Git 目录、仓库**子目录**（`repository_root_required`）、
  **裸仓库**与 `.git` 内部目录（`bare_repository` / `not_a_worktree_root`）。
- **repoIdentity**：`gitdir-sha256:` + sha256(gitCommonDir realpath)；同一 clone 稳定，不含
  本地路径原文，可安全入索引/日志。
- 检查使用独立 argv、显式 `cwd`、有限超时与输出上限，不拼接 shell；不执行仓库脚本、
  `npm install`、commit、stash、reset、fetch；检查前后 HEAD、工作文件与哨兵内容一致。
- 失败返回 `RepositoryInspectionError`（`invalid_input` / `not_found` / `not_a_directory` /
  `not_a_repository` / `unavailable` / `timeout` / `permission` / `io`），**零业务行**。

### 3.3 标签规则（注册 / 编辑 / 筛选共用）

规范化：`trim` → **Unicode NFC** → **ASCII 小写**（仅 `A-Z`，非 ASCII 不转写）→ 实体内去重；
省略 `labels` 返回 `[]`。上限（`packages/core/src/ports/validation.ts`，Unicode 码点计）：

| 字段 | 上限常量 | 值 |
|---|---|---|
| `displayName` | `PROJECT_DISPLAY_NAME_MAX_LENGTH` | `200`（trim 后非空） |
| `description` | `DESCRIPTION_MAX_LENGTH` | `10000`（可空） |
| 单标签 | `LABEL_MAX_LENGTH` | `64` |
| 去重后标签数 | `LABELS_MAX_COUNT` | `50` |

标签只作不透明检索元数据，**不**解释为模型、权限、状态或子级继承政策。

### 3.4 查询、筛选与计数

```ts
const page = await app.projectService.listProjects({
  match: 'all',                 // 'any'（默认）任一命中 / 'all' 全部命中
  labels: ['P01', 'Backend'],
  limit: 50,                    // 默认 PROJECT_LIST_DEFAULT_LIMIT = 50
  cursor: undefined,            // 上一页 nextCursor（最后一条项目 id）
});
const counts = await app.projectService.countProjectLabels();
```

- `listProjects` 返回 `{ records, nextCursor }`；`nextCursor=null` 表示无更多。稳定排序为项目
  `id` 升序，跨页遍历不重复、不遗漏。
- 上限：`PROJECT_LIST_MAX_LIMIT = 200`；非法 `limit`（0/负数/小数/字符串/超限）与非法 `cursor`
  拒绝。标签一律以绑定参数查询（`json_each(projects.labels)`），含 SQL 元字符的标签按字面量
  处理，不注入。
- `countProjectLabels` 返回 `{ label, projectCount }[]`，按项目去重（同一项目同标签只计一次，
  `COUNT(DISTINCT projects.id)`），仅统计**项目层**，不与 Phase/Feature/Task 相加。
- 均为只读查询：不新增表、不新增迁移、不写审计。

### 3.5 元数据 CAS 编辑

```ts
const current = await app.projectService.getProject(projectId);
const updated = await app.projectService.updateProjectMetadata(projectId, {
  expectedRevision: current.revision,
  displayName: '新名称',
  labels: ['示例', 'Example'],
});
```

- 至少提供 `displayName` / `description` / `labels` 之一；匹配 `expectedRevision` 后 `revision+1`。
- 成功更新在同一短事务内追加一条 `state_events`：
  `event_type='project.metadata_updated'`、`aggregate_type='project'`、`aggregate_id`/`project_id`
  = 项目 ID、`aggregate_revision`=写后 `revision`、`sequence` 数据库内单调、`occurred_at`=UTC 毫秒；
  `payload` **只含 `changedFields` 字段名数组**，不含字段值/凭据/路径。注入记录写入失败时元数据
  与 `revision` 一并回滚。
- 改名称或仅改标签**不**修改 `projectId`、`canonicalPath`、配置、`PathService` 位置或已有制品，
  不 rebind。
- 未知 ID 返回 `not_found`；过期 revision / 非法标签 / 未知字段返回 `validation` 或 `conflict`
  且零副作用。

## 4. 当前配置

### 4.1 schemaVersion 与写入

- 当前唯一支持 `SETTINGS_SCHEMA_VERSION = 2`（`packages/core/src/ports/settings-schema.ts`）。
  v1 payload 一律拒绝；读取到 v1 持久数据报 `corrupt`，不静默误读。
- payload v2 顶层只允许 `schemaVersion` / `strategies` / `policies`，未知键拒绝。
- **首次创建 `createSettings` 为 insert-only**（不携带 `expectedRevision`）：并发保护由
  「事务内存在性检查 + 唯一约束」提供，同一目标并发创建恰一个成功，其余 `conflict`，不覆盖。
- **更新 `updateSettings` 必须携带 `expectedRevision`**（≥1 整数），匹配则 `revision+1`。
- 写入前运行时校验：非法 scope/schema/payload、缺失项目在写事务之前拒绝，失败不改变现有
  payload/revision，首次创建失败不留配置行。

### 4.2 策略（`strategies`）

- 完整策略条目必须同时具备 `runtime` / `provider` / `model`，缺字段即报错，不从其它条目补齐。
- 白名单键：`defaultStrategy`、`modelMap`（复杂度仅 `low|medium|high`）、`purposeStrategies`
  （用途仅 `planner|judge|review`）、`agentOverrides`。
- `credentialRef` / `endpointRef` **只按引用字符串**校验与透传（非空、≤256 码点、无空白/控制
  字符、拒绝带凭据 URL `credential_in_url`），不解析、不读环境/Keychain。明文 `apiKey` /
  `token` / `password` 等作为未知键拒绝，错误不回显秘密。
- runtime/provider/model **兼容性**由应用层经可信装配注入的只读能力目录
  （`RuntimeCapabilityCatalog`）核验：未知 runtime `unknown_runtime`、不兼容 provider
  `incompatible_provider`、未列举 model `unsupported_model` 带字段定位拒绝；无封闭厂商枚举、
  不查网络、不导入 Pi SDK。目录为空时 fail-closed。

### 4.3 政策（`policies`，本阶段确认子集）

| 段 | 字段 | 规则 |
|---|---|---|
| `executionLimits` | `maxConcurrentWorks` | 整数 `1..16` |
| | `workTimeoutMs` | 整数 `1000..86400000` |
| | `maxAttemptsPerTask` | 整数 `1..100` |
| | `envAllowlist` | 只接受非敏感环境变量名；去重后 ≤64；含 SECRET/TOKEN/PASSWORD/CREDENTIAL/KEY/PRIVATE/AUTH 等分段的名称拒绝 |
| `verification` | `requireChecksBeforeDone` | 仅布尔 |
| `securityPolicy` | `isolation` | 仅 `trusted_project`；要求强隔离（`strong_sandbox` 等）以 `unsupported_isolation` 明确拒绝，**不静默降级** |

其它政策段（`memoryPolicy` / `deliveryPolicy` 等）未定义即不属于合法 payload，未知段一律拒绝。

### 4.4 有效配置合并与来源（F-009）

```ts
const effective = await app.configurationService.getEffectiveSettings(projectId);
```

- 三类输入均合法：只有全局默认 / 全局+项目覆盖 / 项目无配置（等价全部继承全局）；双方均无任一
  策略时返回 `configured: false`（明确未配置/不可执行），**不注入默认 Claude/API**。
- **键级继承**：省略某键 = 继承全局；提供该键 = 项目覆盖。
- **完整条目整体替换**：`defaultStrategy` 及 `modelMap` / `purposeStrategies` / `agentOverrides`
  中同名键以项目的完整条目整体替换，**不跨来源拼接** `runtime`/`provider`/`model`；项目条目
  缺字段直接报错，不能借全局字段拼成另一个有效策略。
- **政策段级整体覆盖**：项目提供某政策段即以项目段整体替换全局段，段内字段不跨来源继承；
  数组（`envAllowlist`）随段整体替换；空段对象 `{}` / 空 `modelMap:{}` 表示不覆盖、继承全局。
- 每个有效条目与政策段附 `EffectiveSource`（`global_default` / `project_default` +
  `sourceKey` + 来源 `scopeRevision`）。输出全为新对象，不改原始 payload、不解析凭据引用。
- **合法 ≠ 可执行**：合并只表达结构与来源；P01 未装配 Runner/认证/模型执行能力，
  `assessSettingsConfiguration().executable` 恒为 `false`。

### 4.5 一致性前置条件（防陈旧依赖，F-010）

项目配置写入在一致性视图内做合并校验（合并后策略集合随当前能力目录复检，继承条目不豁免），
并把校验时读到的全局 revision 作为 `consistency.globalRevision` 前置条件由适配器在**同一写
事务内**核对：不一致返回 conflict（`reason='stale_dependency'`，details 含
expected/actualGlobalRevision），不提交基于陈旧依赖校验过的结果。调用方不得自行声明
`consistency`，由服务从自己的读取推导。成功 CAS 更新同事务追加脱敏记录
（`settings.global_updated` / `settings.project_updated`，摘要由 `settingsChangeSummary`
派生，只含 `schemaVersion` 与策略键名/政策段名，绝不含值/引用/模型名/秘密）。

### 4.6 查询与脱敏导出

```ts
const current = await app.configurationService.getCurrentSettings({ kind: 'project', projectId });
const exportJson = await app.configurationService.exportSettings(projectId); // 省略 projectId 导出全局
```

- `getCurrentSettings(scope)`：按 scope 返回 `schemaVersion` / 已校验 `payload` / `revision`；
  缺失 `not_found`、未知版本/损坏 `corrupt`（不回落其它来源）。
- `getEffectiveSettings(projectId)`：先核验项目存在（未知项目 `not_found`，与「存在但无覆盖」
  区分），再读全局/项目当前记录并返回精确合并值与逐项来源。
- `exportSettings(projectId?)`：`ExportedSettings` = `exportFormatVersion`
  （`SETTINGS_EXPORT_FORMAT_VERSION = 1`）+ `scope` + `projectId?` + `current`（当前值逐字段
  白名单投影：`schemaVersion`/`revision`/`strategies`/`policies`，引用原样保留）+ `effective`
  （合并值与来源）。**不含** executable/ready 执行标记，不读取环境/认证文件/Keychain/
  CredentialProvider，用合成秘密断言序列化输出不回显秘密。
- 查询切片只读：不调用写入端口、不写 `state_events`、不改 revision、不创建 Task/执行快照。

## 5. PathService（稳定数据根）

- 稳定 namespace：`DATA_NAMESPACE = "shiploop"`；macOS 默认根
  `~/Library/Application Support/shiploop`（`MACOS_APPLICATION_SUPPORT_RELATIVE_DIR` +
  `DATA_NAMESPACE`，从注入的用户目录解析，不硬编码绝对路径）。数据库文件
  `DATABASE_FILE_NAME = "core.sqlite"`。展示品牌变化不改变数据目录。
- **显式根**（绝对路径）与**注入用户目录**二选一；`openCoreApplication` 只创建数据根本身
  （mode 0700），不隐式创建项目/Run/Session 目录，不迁移源仓库。数据根经 realpath 固定。
- 项目目录按稳定 `projectId` 定位（`<root>/projects/<projectId>`）；`displayName`/`description`/
  标签/标题变化不移动位置。数据库与项目制品与源仓库**分离**。
- 受权定位资源类型（`PROJECT_RESOURCE_TYPES`，白名单）：
  `project_directory` / `artifacts_directory` / `staging_directory` / `artifact_content`；
  未知类型（Run/Session/Worktree 等）一律拒绝。
- 受权定位 `locateProjectResource(scope, resource)` 先核验项目存在且属于调用绑定的项目范围，
  再返回范围内位置；项目 A 范围不能定位项目 B 的资源（`ownership`），未知项目 `not_found`；
  未装配存在性核验端口时 fail-closed。
- 拒绝非法 ID、绝对 locator、父目录穿越、目录/文件符号链接逃逸（realpath/祖先核对/no-follow
  三层防线）；真实根外哨兵文件不变。
- **可信项目模式 ≠ 强 OS 沙箱**：检查与操作之间的并发替换窗口由「单 Host 写入者 + 用户明确
  授权」收窄，不宣称强隔离。

## 6. 最小可运行示例

以下示例使用**公开装配入口** `openCoreApplication`（跨包时经 `shiploop-core/assembly`），
与 [`examples/p01-3-standalone.ts`](../examples/p01-3-standalone.ts) 同构，并由
[`test/docs-p01-3-operations.test.ts`](../test/docs-p01-3-operations.test.ts) 编译并执行
（编译检查 + 运行断言）。示例仅使用真实导出接口，不编造 CLI 命令。

```ts
import { openCoreApplication } from 'shiploop-core/assembly';
import { createStaticRuntimeCapabilityCatalog } from 'shiploop-core';

const capabilityCatalog = createStaticRuntimeCapabilityCatalog([
  { runtimeId: 'pi', providers: [{ providerId: 'anthropic', models: ['claude-sonnet'] }] },
]);

// 1) 打开 Core 应用：受控数据根 + 可信能力目录（不读真实用户目录）。
const app = await openCoreApplication({ dataRoot: '/受控/临时/数据根', capabilityCatalog });
try {
  // 2) 注册真实仓库：稳定 projectId + 仓库绑定，同路径幂等复用。
  const registration = await app.projectService.registerRepository({
    repositoryPath: '/受控/临时/仓库',
    displayName: '示例项目',
    description: '最小示例',
    labels: ['Alpha', ' beta ', 'alpha'],   // ⇒ ['alpha', 'beta']
  });
  const projectId = registration.project.id;

  // 3) CAS 编辑元数据（同事务脱敏审计）。
  const fetched = await app.projectService.getProject(projectId);
  const updated = await app.projectService.updateProjectMetadata(projectId, {
    expectedRevision: fetched.revision,
    displayName: '示例项目（已改名）',
  });

  // 4) 全局默认 + 项目覆盖（insert-only 首次创建）。
  await app.configurationService.createSettings(
    { kind: 'global' },
    { payload: { schemaVersion: 2, strategies: { defaultStrategy: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } } } },
  );
  await app.configurationService.createSettings(
    { kind: 'project', projectId },
    { payload: { schemaVersion: 2, strategies: { modelMap: { low: { runtime: 'pi', provider: 'anthropic', model: 'claude-sonnet' } } } } },
  );

  // 5) 有效配置（精确值与逐项来源）、脱敏导出、受权定位。
  const effective = await app.configurationService.getEffectiveSettings(projectId);
  const exported = await app.configurationService.exportSettings(projectId);
  const located = await app.pathService.locateProjectResource(
    { projectId },
    { type: 'project_directory', projectId },
  );
} finally {
  app.close();
}

// 6) 关闭重开同一数据根后读取一致（迁移幂等）。
```

## 7. 错误与恢复

结构化错误（`StorageError.kind`）：`validation` / `not_found` / `conflict` / `busy` /
`corrupt` / `unsupported_version` / `ownership`。应用层新增窄错误类型
（`RepositoryInspectionError`、`PathResolutionError`、`ArtifactFileError` 等）同样携带
`operation` 与结构化 `details`，消息与 details 一律脱敏（不含绝对路径、payload 原文或秘密）。

| 情形 | 错误 | 处理 |
|---|---|---|
| 标签/字段/scope/payload 非法 | `validation` | 修正输入；失败零持久化副作用 |
| 未知项目 / 无绑定 | `not_found` | 先注册项目或修正 ID |
| 过期 `expectedRevision` / 重复创建 | `conflict` | 重新读取最新 revision（含记录）后用新值重试，不得先读后无条件覆盖 |
| 项目配置写入的全局依赖过期 | `conflict`（`stale_dependency`） | 重新读取全局与项目当前配置后重试整个写入 |
| 写锁预算耗尽 | `busy` | 确认锁释放后重试；失败不提交 |
| 持久数据未知版本 / 损坏 | `corrupt` | 不回落其它来源；按前序恢复步骤核对（见 storage-operations.md） |
| 跨项目引用 / 定位 | `ownership` | 使用调用绑定范围内的 projectId |
| 仓库不可用 / 超时 / 权限 | `RepositoryInspectionError` | 修正路径/环境后重试；未产生业务行 |

注入审计记录写入失败时，实体写入与 `revision` 一并回滚，不产生半条记录；诊断 logger 不充当
权威记录。

## 8. 未实现 / not_run（不得冒充）

- **Host 网络接口 / CLI 命令**：未新增 HTTP/SSE、未新增 `shiploop` CLI 命令或参数解析。
- **执行 / Runtime**：未建 Phase/Feature/Task/Run/Attempt/Batch/Session 等执行表，未导入或
  调用 Pi SDK/模型（`accept:p04:live` 等 Live 验收为 `not_run`）。
- **Task 策略复制**：`tasks.execution_config`、Planner/Judge/review 策略复制属后续（本 Feature
  只做当前配置的保存/合并/来源）。
- **存量基线扫描**、**rebind / 源代码迁移**、配置历史版本表、`accept:p01` 阶段验收均未实现。
- Windows / WSL / Linux、强 OS 沙箱、模型 Live 均为 `not_run` / 未支持。
- 数值上限、能力目录、导出 Schema 等为 P01-3 实施契约值而非设计结论，已集中记录于
  [p01-3-application-contract.md §9](p01-3-application-contract.md) 并请求核对。

## 9. 验证

仓库级验证：`npm test`（开发内循环）；`npm run verify`（锁文件预检 + `npm test` /
`typecheck` / `build` 串联，fail-closed）。文档示例与实现的一致性由
`test/docs-p01-3-operations.test.ts` 守护（真实装配 + 运行断言 + 常量交叉核对）。
