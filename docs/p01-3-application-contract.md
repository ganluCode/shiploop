# P01-3 项目身份与当前配置服务 — Core 应用契约与范围说明

- 对应任务：F-001（P01-3 项目身份与当前配置服务）。
- 文档状态：P01-3 实施前置契约（实施依据，不是阶段验收报告）。
- 适用平台：macOS（首个正式支持平台）；Windows/WSL/Linux 未验收。
- 输入依据：[PRD p01-project-config.md](../../../../ai-coding/shiploop-harness/workspace/features/2026-10-01-23-44-21_p01-3/input/p01-project-config.md)
  与设计 01/02/03/06/11（版本见 §2）。本文不静默改变领域语义；发现的矛盾集中记录于 §9。

本文只规定 **P01-3 范围内的 Core 应用契约、复用规则、存储扩展与范围边界**。它描述
P01-3 其余任务（F-002 ~ F-014）应实现的接口语义，不代替任何任务的验收报告。示例接口
按现有分层（`domain` / `application` / `ports` / `adapters`）书写；产品代码只在 ShipLoop
目标仓库实现，Harness 仅编排，不在 Harness 重建工程。

---

## 1. 前序基线核验（P01-1 / P01-2）

### 1.1 分支与提交

- 实际执行分支：`feat/2026-10-01-23-44-21_p01-3`（worktree
  `/Users/ganlu/Documents/my-dev/code/mygit/AI/shiploop-2026-10-01-23-44-21_p01-3`）。
- 基线（`feature.yaml.metadata.base_branch`）：
  `feat/2026-10-01-23-44-21_p01-2-sqlite`，置于当前分支历史中且为其祖先。
- 已核验祖先链（`git merge-base --is-ancestor`，均为真）：
  - `feat/2026-10-01-23-44-21_p01-1` = `44c8c30…`（P01-1 工程基础与持久化内核）。
  - `feat/2026-10-01-23-44-21_p01-2-sqlite` = `74934ac…`（P01-2 SQLite 原子存储与制品落盘，F-014 文档提交）。
  - 当前 HEAD = `74934ac…`（P01-3 尚未新增提交）。
- 已验收报告在库内且随分支携带：
  - `docs/acceptance/p01-1-f006-report.md`
  - `docs/acceptance/p01-2-f014-report.md`
  - 证据目录：`docs/acceptance/evidence-p01-1/`、`docs/acceptance/evidence-p01-2/`（`.gitignore` 有显式例外）。

### 1.2 端口与测试确实存在（非占位）

| 能力 | 已验收端口/入口 | 位置 |
|---|---|---|
| 项目与当前配置 | `StateStore`（`createProject` / `getProject` / `updateProject` / `createProjectWithInitialSettings` / `createGlobalSettings` / `getGlobalSettings` / `updateGlobalSettings` / `createProjectSettings` / `getProjectSettings` / `updateProjectSettings`） | `packages/core/src/ports/state-store.ts` |
| 制品索引 | `ArtifactStore`（`registerArtifact` / `getArtifact` / `transitionArtifact` / `getArtifactInputRef` / `listArtifacts`） | `packages/core/src/ports/artifact-store.ts` |
| 制品文件 | `ArtifactFileStore`（受控定位 / staging / 不覆盖发布 / 有界扫描） | `packages/core/src/ports/artifact-files.ts`、`adapters/fs/artifact-files.ts` |
| 迁移 | `migrateSqliteStorage`、`SQLITE_MIGRATIONS`（当前唯一版本 `version=1`，六表） | `packages/core/src/adapters/sqlite/migrator.ts`、`migrations.ts` |
| 连接会话 | `openSqliteStorageSession`（固定 PRAGMA、短同步写事务、有界 busy、幂等 close） | `packages/core/src/adapters/sqlite/session.ts` |
| 结构化错误 | `StorageError`（`validation` / `not_found` / `conflict` / `busy` / `corrupt` / `unsupported_version` / `ownership`） | `packages/core/src/ports/errors.ts` |
| 配置 Schema | `SETTINGS_SCHEMA_VERSION`、`validateSettingsPayload`、`parseStoredSettingsPayload`（F-008 由 1 显式升级为 2，见 §5.1） | `packages/core/src/ports/settings-schema.ts` |
| 运行时校验原语 | `normalizeLabels`、`validateStableId`、`validateExpectedRevision`、`validateArtifactLocator` 等 | `packages/core/src/ports/validation.ts` |

P01-3 建立在这些端口之上，不重建脚手架；F-002 ~ F-012 只做**增量**扩展（见 §7、§8）。

### 1.3 基线验证命令与退出码

在受控源码快照中执行（`node_modules` 由 `npm ci` 重建，精确锁定）：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 依赖安装 | `npm ci` | 退出 0，47 packages，0 vulnerabilities |
| 工程验证 | `npm run verify` | **退出 0**（`PASS 3/3`） |
| ├─ 测试 | `npm test` | 退出 0，**20 test files / 443 tests passed** |
| ├─ 类型 | `npm run typecheck` | 退出 0 |
| └─ 构建 | `npm run build` | 退出 0（三个包 dist 入口可加载、无副作用） |

环境：macOS arm64 / Node `22.19.0` / npm `10.9.3`（根 `engines` 与 `.node-version`/`.nvmrc`
一致）。结论：**前序 p01-engineering 与 p01-state-artifacts 的已验收能力均在当前分支可用，
无阻塞项**，F-001 不需以前序缺失为由记录阻塞。

---

## 2. 输入文档版本

设计输入为 Harness 知识目录 `architecture-redesign/`（不在本仓库），以内容哈希固化版本：

| 文档 | SHA-256 |
|---|---|
| `core-design/01-system-structure.md` | `1f66552a4e7e7b83c81f33138fbe81d5d9e4e5d9cb6ae5b69b92766e143c7490` |
| `core-design/02-domain-and-lifecycle.md` | `6fabe0e602e2e22667a9cf3e37c0b9b85049e96a1b51d7cf4876e18096f65f99` |
| `core-design/03-storage-and-transactions.md` | `c393f95c96d62c9ec708e3043fde78194c85acea2ea1dad6924b31fd83f7183d` |
| `core-design/06-project-and-context.md` | `ea9ef3e50e9f9ea5423ca673e41f6d3397996fd774c543b268316397d00c1394` |
| `core-design/11-database-model.md` | `57dc3c6eab520fea43b5078a131821525f5c85336c09990719f10f9b705e5fa9` |
| `08-migration-roadmap.md` | `c6f527bd0846e805189b6ea8369cedb90442f6254198a3216dc3600c3d9c04a6` |

---

## 3. 复用规则（全部沿用前序，不另立第二套）

以下规则在 P01-2 已实现并有测试基线，P01-3 不得分叉：

1. **稳定 ID**：应用侧生成 UUID（`randomUUID`），数据库存 `TEXT`；跨受控路径使用的 ID 还须
   通过 `validateStableId`（`1-128` 位，`^[A-Za-z0-9][A-Za-z0-9._-]*$`）。`projectId` 不由
   `displayName`、`description`、标签、标题或 Git remote 生成。
2. **UTC 时间**：应用侧以 UTC 毫秒整数填充 `created_at` / `updated_at` / `occurred_at`；
   不依赖数据库时钟默认值；测试可注入 `nowUtcMs`。
3. **`revision`（CAS 并发计数）**：可变聚合每次成功写入递增（初始 `1`）；更新一律携带
   `expectedRevision`，过期返回 `StorageError(kind='conflict')`，原记录不变。`revision`
   **不等于** `schemaVersion`（payload 数据格式版本），也**不等于**制品 `version`（内容版本）。
4. **事务**：写操作走 `session.transactWrite`（`BEGIN IMMEDIATE` + 短同步事务）；**事务内禁止**
   文件流/`fsync`、Git、网络、模型、凭据解析或长检查；输入先经运行时校验再进 SQL；busy
   在有限预算内退避，超预算返回 `kind='busy'`。
5. **受控文件定位**：物理位置只由「授权数据根 + 稳定 `projectId`/`artifactId`」推导；
   `locator` 只是索引中的**逻辑身份**，不参与物理路径。拒绝绝对路径、`..` 穿越、反斜杠、
   NUL；`realpath`/`lstat`/`no-follow` 三层防线（沿用 `adapters/fs/artifact-files.ts`）。
6. **运行时校验**：跨端口边界的 `unknown` 必须先经 `ports/validation.ts` 校验器；TypeScript
   类型不替代校验；失败零持久化副作用。
7. **结构化错误**：所有失败返回带 `operation` 与实体身份的结构化错误；`details` 只放可序列化、
   已脱敏字段（`field`/`reason`/`expectedRevision` 等），不含绝对路径、payload 原文或凭据。
8. **标签规范化（F-002，注册/编辑/筛选共用同一规则）**：`trim` → **Unicode NFC** → **ASCII 小写**
   （仅 `A-Z`，不改写非 ASCII 文字）→ 实体内去重；省略 `labels` 返回 `[]`；拒绝非数组、非字符串
   元素、空白标签与违反长度/数量限制的输入，错误定位到字段。标签不解释为模型、权限、状态或
   子级继承政策；`normalizeLabels` 与既有契约保持一致，不另建第二套标签 Schema。
9. **项目元数据字段规则（F-002，注册/编辑/查询共用）**：`displayName` 必须为非空字符串，
   去除首尾空白后以 trim 文本保存且不超过 `PROJECT_DISPLAY_NAME_MAX_LENGTH = 200`（Unicode
   码点）；`description` 省略/`null`/空或全空白规范化为 `null`（空描述合法），其余按原样保留
   （Markdown/Unicode 不转写），不超过 `DESCRIPTION_MAX_LENGTH = 10000`；单个标签（`trim`+NFC
   后）不超过 `LABEL_MAX_LENGTH = 64`，去重后数量不超过 `LABELS_MAX_COUNT = 50`。长度以
   **Unicode 码点**计（`emoji`/组合字符不被误计），上限是注册、元数据编辑与查询筛选共用的
   **同一套**常量，定义于 `packages/core/src/ports/validation.ts`；设计文档未给定数值，此为
   P01-3 实施契约值，**请求确认**（见 §9-5）。

---

## 4. P01-3 应用服务契约（命令 / 查询）

应用服务位于 `packages/core/src/application/`，只依赖 `ports`（不依赖 `adapters`、HTTP、Pi SDK、
ORM）。装配（组合根）由 F-012 提供，见 §7.4。

### 4.1 ProjectService（F-005 / F-006 / F-007）

负责仓库注册、项目身份查询、元数据 CAS 编辑与标签筛选。仓库/文件检查在事务外完成，结果作为
已核验输入传入单个短事务。

```ts
interface RegisterRepositoryInput {
  readonly repositoryPath: string;                 // 用户提供的本地路径（可为符号链接别名）
  readonly displayName: string;                   // 展示名，不参与身份/路径
  readonly description?: string | null;           // 按 PRD 保留；可空
  readonly labels?: readonly string[];            // 字符串数组；默认 []
}

type RegisterRepositoryResult =
  | { readonly status: 'registered'; readonly project: ProjectRecord; readonly binding: RepositoryBindingRecord }
  | { readonly status: 'already_exists'; readonly project: ProjectRecord; readonly binding: RepositoryBindingRecord };

interface ProjectService {
  // 命令
  registerRepository(input: unknown): Promise<RegisterRepositoryResult>;
  updateProjectMetadata(projectId: string, input: unknown): Promise<ProjectRecord>; // expectedRevision CAS
  // 查询
  getProject(projectId: string): Promise<ProjectRecord>;                            // not_found
  getRepositoryBinding(projectId: string): Promise<RepositoryBindingRecord>;        // not_found
  listProjects(filter: unknown): Promise<ProjectPage>;                              // 标签 any/all + 分页
  countProjectLabels(): Promise<readonly ProjectLabelCount[]>;                      // 项目层去重计数
}
```

语义要点：

- `registerRepository`：先做**只读**仓库检查（§4.2）得到 `canonicalPath`；再在同一短事务内原子
  保存项目 + 仓库绑定。同 `canonicalPath` 已注册 → 返回 `already_exists` 与既有项目/绑定，
  **不新增行、不覆盖**名称/描述/标签；不同 clone（remote 相同、路径不同）分别注册。

F-005 定案（实施契约；与 §6.2「仓库绑定读写端口」一致）：

- **幂等原语在端口内**：`StateStore.createProjectWithRepositoryBinding(project, binding)` 在单个
  `BEGIN IMMEDIATE` 事务内「按 `canonical_path` 检查并插入」——检查与插入被写锁串行化，跨进程
  竞争注册同一路径恰有一个 `registered`，其余复用胜者；`repository_bindings.canonical_path`
  唯一索引为兑底，约束冲突时事务整体回滚后**有界核对一次**（重读到既有绑定则返回
  `already_exists`，否则原错误继续抛出），绝不遗留孤立项目或绑定。应用层不经端口开事务。
- **结果形态**：`{ status: 'registered' | 'already_exists', project, binding }`；
  `RepositoryBindingRecord` 含 `canonicalPath`/`gitCommonDir`/`repoIdentity`/`revision`/
  `bindingRevision`/UTC 时间；`projects.repository_binding_id` 在同一事务内回写（同项目复合
  外键由 DDL 强制）。绑定输入经 `validateCreateRepositoryBindingInput`（NUL/相对路径/空身份
  在任何 SQL 之前拒绝）。
- **不持久化瞬时事实**：`headCommit`/`hasInitialCommit`/`hasUncommittedChanges` 只用于注册时
  的只读核验，不入库；运行时状态按需重新检查。
- **错误传播**：元数据/输入非法为 `StorageError(kind='validation')`（先于任何 I/O，检查端口
  不被调用）；仓库检查失败为 `RepositoryInspectionError` 原样传播（零业务行）；存储失败为
  `StorageError` 原样传播。Git/文件检查发生在数据库写事务之外（检查失败时写入端口未被调用，
  有测试证据）。
- `StateStore.getRepositoryBinding(projectId)` 按项目读取绑定：项目不存在与项目尚无绑定分别
  返回带不同实体身份的 `not_found`。

F-006 定案（实施契约；与 §6.3 的 `state_events` 一致）：

- **查询**：`ProjectService.getProject(projectId)` 复用 `StateStore.getProject`（返回
  `ProjectRecord`，含 `repositoryBindingId`）；`ProjectService.getRepositoryBinding(projectId)`
  复用 `StateStore.getRepositoryBinding`（返回完整 `RepositoryBindingRecord`）。两者对未知 ID
  返回带实体身份的 `not_found`，不新增第二套读取路径。
- **审计落点**：项目元数据编辑复用 `StateStore.updateProject`，在同一短事务内完成 CAS 更新并
  追加一条 `state_events`：`event_type='project.metadata_updated'`、`aggregate_type='project'`、
  `aggregate_id`/`project_id`=项目 ID、`aggregate_revision`=写后 `revision`、`sequence` 数据库内
  单调分配、`occurred_at`=应用 UTC 毫秒；`payload` **只含 `changedFields` 字段名数组**，不含字段值、
  凭据或路径。注入记录写入失败时元数据与 `revision` 一并回滚（无半条记录）；校验失败/过期
  revision 不写记录；诊断 logger 不充当权威记录。表由迁移 v2（`state_events`）建立，见 §6.3。
- `updateProjectMetadata`：至少提供 `displayName`/`description`/`labels` 之一；匹配
  `expectedRevision` 后 `revision+1`；不改 `projectId`、`canonicalPath`、配置、PathService 位置
  或已有制品；不得借元数据编辑做 rebind。

F-007 定案（实施契约；标签筛选/分页/计数）：

- **查询入口**：`ProjectService.listProjects(filter?)` 与 `ProjectService.countProjectLabels()`
  直接复用 `StateStore.listProjects` / `StateStore.countProjectLabels`，应用层不另立第二套标签规则。
- **筛选语义**：`filter = { match?: 'any' | 'all', labels?: string[], limit?: number, cursor?: string }`；
  `match='any'` 为任一命中、`match='all'` 为全部命中（默认 `'any'`）。`labels` 省略或空数组表示
  不加标签约束（返回全部可见项目）；无命中返回空页且 `nextCursor=null`；未知 `match`/未知键/
  非字符串标签/空白标签在进入 SQL 之前返回 `validation`。
- **共用规范化**：筛选标签复用 F-002 的 `normalizeLabels`（trim → NFC → ASCII 小写 → 去重），
  与注册/编辑共用同一常量与规则；包含重复规范化输入的筛选得到一致结果。
- **有限分页**：默认 `PROJECT_LIST_DEFAULT_LIMIT = 50`、上限 `PROJECT_LIST_MAX_LIMIT = 200`；
  非法 `limit`（0、负数、小数、字符串、超过上限）与非法 `cursor`（空、含 `/`、非稳定 ID）拒绝。
  稳定排序为项目 `id` **升序**，游标为上一页 `nextCursor`（最后一条项目 `id`），跨页遍历
  不重复、不遗漏（与 `listArtifacts` 同一键集分页形态）。
- **绑定参数查询（防注入）**：标签一律以绑定参数传入 SQL（`json_each(projects.labels)` 的
  `EXISTS`/命中计数谓词），绝不拼接标签原文；含 SQL 元字符的标签被当作字面标签，既不放行全表、
  也不破坏表。
- **标签计数**：返回 `{ label, projectCount }[]`，按项目去重（同一项目同标签只计一次，
  `COUNT(DISTINCT projects.id)`），仅统计项目层，**不**与 Phase/Feature/Task 层级相加；可见
  范围与 `listProjects` 相同（P01-3 无授权收窄，后续授权过滤时两者共用同一谓词）。
- **明确不做**：不实现「按标签启动 Batch」，不提供 Phase/Feature/Task 标签查询；不宣称 T32
  全量完成（本 Feature 只交付项目层子集）。`listProjects`/`countProjectLabels` 为只读查询，
  不新增表、不新增迁移、不写审计。

### 4.2 RepositoryInspector（F-004，只读）

```ts
interface RepositoryInspection {
  readonly canonicalPath: string;   // realpath 规范化后的仓库根
  readonly gitCommonDir: string | null;
  readonly repoIdentity: string;    // 稳定本地身份；remote 只作信息，不作唯一身份
  readonly headCommit: string | null;
  readonly hasInitialCommit: boolean;
  readonly hasUncommittedChanges: boolean;
}

interface RepositoryInspector {
  inspect(repositoryPath: unknown): Promise<RepositoryInspection>;  // 边界输入 unknown，运行时校验
}
```

- 使用独立 argv、显式 `cwd`、有限超时与输出上限，不拼接 shell；目录名含空格/Unicode/元字符
  不得触发注入。
- **不执行**仓库脚本、`npm install`、commit、stash、reset、fetch；检查前后 HEAD、工作文件与
  哨兵内容一致。Git/文件系统检查在数据库写事务之外。
- 缺失路径、普通文件、非 Git 目录、不符合已确认根目录契约、超时、Git 不可用、权限错误返回
  带操作与路径原因的结构化错误；不创建项目或目录，不伪装成有效绑定。

F-004 定案（实施契约；理由与核对请求见 §9-6）：

- **支持范围**：接受工作树根（含无初始 commit、脏工作区）、根的符号链接别名与 linked
  worktree 顶层；明确拒绝不存在路径、普通文件、非 Git 目录、仓库**子目录**
  （`repository_root_required`，不误绑定到外层仓库，由调用方改传工作树根）、**裸仓库**与
  `.git` 内部目录（`bare_repository` / `not_a_worktree_root`，无工作树可绑定）。
- **repoIdentity 派生**：`gitdir-sha256:` + sha256(gitCommonDir realpath)。同一 clone 重检/
  关闭重开一致；同 remote 不同 clone 不合并；不含本地路径原文，可安全入索引/日志。linked
  worktree 与主 checkout 共享公共目录：身份一致而 `canonicalPath` 不同，`canonical_path`
  全库唯一约束仍把不同 checkout 分开（与「同 remote 多 clone 分别注册」语义一致）。
- **gitCommonDir**：来自实际 `git rev-parse --git-common-dir`（相对输出按 cwd 解析）并
  realpath 规范化；linked worktree 时指向主 checkout 的 `.git`（可位于 canonicalPath 之外）。
- **HEAD/脏状态**：`rev-parse --verify --quiet HEAD^{commit}` 退出码 1 = 无初始 commit
  （headCommit=null，不猜 main）；脏状态由 `status --porcelain --untracked-files=normal`
  判定（显式旗标覆盖仓库配置）。
- **子进程环境**：最小确定环境（仅 PATH + LC_ALL=C + GIT_CONFIG_NOSYSTEM/GLOBAL/SYSTEM 隔离
  机器配置 + GIT_TERMINAL_PROMPT=0 禁交互 + GIT_OPTIONAL_LOCKS=0 保证只读）；默认有限超时
  10s（上限 120s）与输出上限 1MiB（上限 16MiB），超限报错而非截断。
- **错误类型**：`RepositoryInspectionError`（kind：`invalid_input` / `not_found` /
  `not_a_directory` / `not_a_repository` / `unavailable` / `timeout` / `permission` / `io`），
  携带 operation 与结构化 reason 码；message/details 不含绝对路径与 stderr 原文。

### 4.3 PathService（F-003）

```ts
interface PathService {
  dataRoot(): string;                                   // 已 realpath 的授权数据根
  databaseFilePath(): string;                           // <dataRoot>/core.sqlite（设计 03 §4 布局）
  projectDirectory(projectId: string): string;          // <dataRoot>/projects/<projectId>（纯推导）
  // 受权定位：先核验项目存在且属于调用绑定的项目范围，再返回范围内位置
  locateProjectResource(scope: { projectId: string }, resource: unknown): Promise<LocatedPath>;
}
```

实现落点（F-003 已交付）：契约 `packages/core/src/ports/path-service.ts`（常量
`DATA_NAMESPACE="shiploop"` / `DATABASE_FILE_NAME="core.sqlite"`、纯推导、资源类型白名单
`PROJECT_RESOURCE_TYPES`、`PathResolutionError`），适配器
`packages/core/src/adapters/fs/path-service.ts`。项目存在性核验端口
（`ProjectExistenceLookup = Pick<StateStore,'getProject'>`）由装配注入：先解析数据根，
再打开存储，最后以 `withProjectLookup(stateStore)` 绑定；未装配时受权定位 fail-closed
（`invalid_input`），不仅凭传入 projectId 授权。资源类型只含 `project_directory` /
`artifacts_directory` / `staging_directory` / `artifact_content`（与 F-010 推导一致）。

- **默认根**：稳定技术 `dataNamespace` + 注入的 macOS 用户目录解析，默认
  `~/Library/Application Support/shiploop`；**显式根**经校验与规范化后供 `StateStore`、
  `ArtifactStore`、项目服务共用。不使用真实用户目录于测试（注入临时 home/dataRoot）。
- **稳定 namespace**：P01-3 固定 `dataNamespace = "shiploop"`（技术品牌，见设计 01 §4；
  产品展示名/桌面品牌变化不改变数据目录）。首次创建目录遵循受控创建；本项目**只解析与使用**
  已存在根，不隐式迁移源仓库。
- 项目目录按稳定 `projectId` 定位；`displayName`/`description`/标签/标题/展示品牌变化不移动位置；
  数据库与项目制品与源仓库**分离**。
- 拒绝非法 ID、绝对 locator、父目录穿越、目录/文件符号链接逃逸（沿用 realpath/祖先核对/
  no-follow）；真实根外哨兵文件不变。
- 受权定位核验「所请求项目存在且属于调用时绑定的项目范围」；项目 A 范围不能定位项目 B 的制品；
  未知项目返回明确错误；**不能仅凭传入 `projectId` 授权**。
- 只支持已实现目录类型（项目/制品）；未知资源类型拒绝；不提前创建 Run/Session/Worktree。
- 可信项目模式 ≠ 强 OS 沙箱：检查与操作之间的并发替换窗口由「单 Host 写入者 + 用户明确授权」
  前提收窄，不宣称强隔离。

### 4.4 ConfigurationService（F-008 / F-009 / F-010 / F-011）

```ts
type SettingsScope = { readonly kind: 'global' } | { readonly kind: 'project'; readonly projectId: string };

type EffectiveSource =
  | { readonly kind: 'global_default'; readonly scopeRevision: number; readonly sourceKey?: string }
  | { readonly kind: 'project_default'; readonly scopeRevision: number; readonly sourceKey?: string };

interface EffectiveSettings {
  readonly configured: boolean;                 // 无任何策略时 false（未配置/不可执行）
  readonly schemaVersion: number;
  readonly strategies: EffectiveStrategies;      // 每个键附带来源
  readonly policies: EffectivePolicies;          // F-009：每段附带来源（段级整体覆盖）
}

interface ConfigurationService {
  // 命令（首次创建 insert-only；更新 expectedRevision CAS）
  createSettings(scope: unknown, input: unknown): Promise<SettingsRecord>;
  updateSettings(scope: unknown, input: unknown): Promise<SettingsRecord>; // 写值 + 变更记录同事务
  // 查询
  getCurrentSettings(scope: unknown): Promise<SettingsRecord>;             // not_found / corrupt
  getEffectiveSettings(projectId: string): Promise<EffectiveSettings>;     // F-009 合并 + 来源
  exportSettings(projectId?: string): Promise<ExportedSettings>;           // 普通脱敏导出
}
```

- 全局配置单例（`global_settings.id='global'`）；项目配置每项目一条
  （`project_settings UNIQUE(project_id)`）；**不建配置历史版本表**。
- 写入前运行时校验：非法 scope/schema/payload、缺失项目、未授权项目范围在**写事务之前**拒绝；
  项目 A 范围不能更新项目 B；失败不改变现有 payload/revision；首次创建失败不留配置行。
- 更新使用**条件写入**（`UPDATE ... WHERE revision = expectedRevision`），不先读后无条件覆盖；
  与默认更新竞争时以事务或 revision 核对防止基于陈旧依赖提交。
- 校验涉及的全局与项目当前配置来自**一致性视图**（同一事务/同一读取快照）。
- 记录落点见 §6，与配置写入同事务；失败回滚。

F-008 定案（实施契约；版本化校验与能力区分）：

- **显式升级 schemaVersion 1 → 2**：v2 在 v1 的 `strategies` 结构之上新增**本阶段确认的
  政策子集** `policies`（见 §5.1）；v1 payload 一律拒绝（读取持久数据时为 `corrupt`），
  旧版本不被静默误读（§7.2）。
- **校验分两层**：存储端口侧只做 `validateSettingsPayload` 结构/政策/凭据引用校验（纯函数，
  适配器无法接触能力目录）；runtime/provider/model **兼容性检查**在应用层经
  `ports/runtime-capabilities.ts` 的 `RuntimeCapabilityCatalog`（可信装配注入的窄能力描述）
  完成——不存在封闭厂商枚举、不查询网络、不导入 Pi SDK；能力目录为空时 fail-closed。
- **合法性 ≠ 可执行**：`assessSettingsConfiguration` 区分 configured/executable；P01 未装配
  Runner/认证/模型执行能力，`executable` 恒为 false；未提供策略返回明确
  `no_strategy_configured`（未配置/不可执行）。
- **scope 校验**：`validateSettingsScope`（global 单例 / project 携带稳定 projectId），
  非法 scope 先于任何 I/O 拒绝。
- **凭据引用卫生**：`credentialRef`/`endpointRef` 只按引用字符串校验（拒绝带凭据 URL、
  空白/控制字符、超长）；明文 `apiKey`/`token`/`password` 等字段作为未知键拒绝，
  错误不回显秘密值；`envAllowlist` 只接受非敏感环境变量名（秘密形态名称拒绝）。

F-009 定案（实施契约；有效配置合并，实现于 `application/effective-settings.ts` 纯函数
`mergeEffectiveSettings`；从 StateStore 组装来源输入的查询服务由 F-011 交付）：

- **合并输入**：`{ global?: { scopeRevision, payload }, project?: { scopeRevision, payload } }`，
  边界为 `unknown`，每个来源的 payload 在合并前重新经 `validateSettingsPayload`
  （schemaVersion=2 门槛）校验，`scopeRevision` 为该 scope 当前记录的 revision（≥1 整数）。
  任一来源非法（未知版本/未知键/不完整条目/非法政策）带字段定位拒绝，**不悄悄忽略或降级**
  成另一来源；无效全局配置同样报错，不被合法项目覆盖掩盖。
- **三类输入**：只有全局默认 / 全局+项目覆盖 / 项目无配置（无项目记录、空 payload 或空
  `strategies:{}`/`policies:{}` 均等价于全部继承全局）；双方均无任一策略时返回
  `configured: false` 的明确未配置结果，**不注入默认 Claude/API**。
- **合并结果**：`EffectiveSettings`（`configured` / `schemaVersion` / `strategies` /
  `policies`）；每个有效策略条目与政策段附 `EffectiveSource`（`global_default` /
  `project_default` + `sourceKey` + 来源 scope 的 `scopeRevision`）。输出全部为新对象，
  不修改原始 payload、不解析凭据引用、不创建 Task、不写执行快照。
- **合法 ≠ 可执行**：合并结果只表达结构与来源；执行能力可用性仍由 F-008
  `assessSettingsConfiguration` 区分（P01 `executable` 恒 false）。
- 本次只交付合并纯函数与测试，不宣称 T24 的 Task 策略复制已完成。

---

## 5. 配置语义（明确规则）

### 5.1 scope 与 schemaVersion

- `scope`：`global`（单例默认）或 `project`（带 `projectId`，每项目一条覆盖），由
  `validateSettingsScope` 校验。
- `schemaVersion`：**F-008 起当前唯一支持 `SETTINGS_SCHEMA_VERSION = 2`**
  （`packages/core/src/ports/settings-schema.ts`）。它是 **payload 数据格式门槛**，与 `revision`
  分离；未知版本一律 `StorageError(kind='validation')`（读取持久数据时为 `corrupt`）。
  v1 payload 自 F-008 起不再接受（显式升级，见 §9-2）。
- payload v2 顶层仅允许 `schemaVersion`、`strategies` 与 `policies`，未知键一律拒绝；
  `strategies` 允许 `defaultStrategy` / `modelMap` / `purposeStrategies` / `agentOverrides`（白名单）。
- **F-008 确认的政策子集**（`policies`，全部可选；空对象表示不覆盖）：
  - `executionLimits`：`maxConcurrentWorks`（1..16）、`workTimeoutMs`（1000..86400000）、
    `maxAttemptsPerTask`（1..100）为有界整数，越界/非整数/错误类型带字段定位拒绝；
    `envAllowlist` 只接受**非敏感环境变量名**（形态 `[A-Za-z_][A-Za-z0-9_]*`，去重后 ≤64，
    含 SECRET/TOKEN/PASSWORD/CREDENTIAL/KEY/PRIVATE/AUTH 等分段的名称拒绝）——只含变量名，
    绝不含值（设计 06 §3：环境变量按允许列表，不继承整个 Host 环境）。
  - `verification`：`requireChecksBeforeDone` 仅接受布尔值。
  - `securityPolicy`：`isolation` 仅接受 `trusted_project`（首版可信项目模式）；
    要求强隔离（`strong_sandbox` 等）明确拒绝（`unsupported_isolation`），**不静默降级**。
  - 其它政策段（`memoryPolicy`/`deliveryPolicy`/Agent 职责模式等）**未定义即不属于合法
    payload**，未知政策段一律拒绝而非静默忽略；不得以任意 JSON 冒充可执行配置。
- 完整策略条目必须同时具备 `runtime`/`provider`/`model`，缺字段即报错，不从其它条目补齐；
  `credentialRef`/`endpointRef` 只按**引用字符串**校验与透传（非空、≤256 码点、无空白/控制
  字符、拒绝带凭据 URL `credential_in_url`），不解析、不读环境/Keychain。
- 复杂度键仅 `low|medium|high`；用途键仅 `planner|judge|review`。非法键拒绝。
- runtime/provider/model **兼容性**不属于结构校验：由应用层经可信装配注入的
  `RuntimeCapabilityCatalog` 窄能力描述核验（未知 runtime/不兼容 provider/未列举 model
  带字段定位拒绝），不建封闭厂商枚举。

### 5.2 首次创建与 expectedRevision 约定

P01-3 确认沿用前序「创建 / 更新」分离的约定，不引入 `expectedRevision=0` 之类的哨兵：

- **首次创建**：`createSettings` 为 insert-only。并发保护由「事务内存在性检查 + 唯一约束」
  提供：全局 `id='global'` 主键、项目 `UNIQUE(project_id)`。同一目标并发创建时**恰有一个成功**，
  其余返回 `StorageError(kind='conflict')`（`already_exists` 语义），**不覆盖**已存在记录。
  首次创建**不**携带 `expectedRevision`。
- **更新**：`updateSettings` 必须携带 `expectedRevision`（`≥1` 整数）；匹配则 `revision+1`。
- 首次创建失败（校验/竞争）不留任何行；重复创建不覆盖名称、描述、标签或既有 payload。
- 组合创建场景（注册项目时的初始配置等）沿用 `createProjectWithInitialSettings`：两个输入在
  任何 SQL 之前完成校验，第二步失败整组回滚，无半条记录。

### 5.3 覆盖 / 数组 / 空值规则（有效配置合并，F-009）

- **键级继承**：省略某键 = 从全局继承；提供该键 = 项目覆盖。
- **完整条目整体替换**：`defaultStrategy`、以及 `modelMap`/`purposeStrategies`/`agentOverrides`
  中**同名键**的策略条目，以项目的完整条目**整体替换**全局条目，**不跨来源拼接** `runtime`/
  `provider`/`model`。其它未覆盖的键继续继承全局。
- **项目条目必须自洽**：项目提供某条目时若缺 `runtime`/`provider`/`model`，直接报错；不得借
  全局字段拼成另一个「有效策略」。
- **空值/空对象**：v1 不接受 `null` 策略条目（无「null=清除」语义）；要「不覆盖」就**省略该键**。
  空的 `modelMap: {}` / `purposeStrategies: {}` 表示不覆盖、全部继承。空数组不是合法策略值。
- **未配置**：全局与项目均无任一策略时，`getEffectiveSettings` 返回 `configured: false`
  （明确「未配置/不可执行」），**不注入默认 Claude/API**，不猜降级。
- **政策段合并（F-009 定案）**：政策以**段级整体覆盖**——项目提供某政策段
  （`policies.executionLimits` / `policies.verification` / `policies.securityPolicy`）即以项目
  段整体替换全局段，段内字段**不跨来源继承**（项目段只给 `workTimeoutMs` 时，全局段的
  `maxConcurrentWorks` 不进入有效配置）；数组（`envAllowlist`）随段整体替换，不做并集/拼接；
  空政策段对象 `{}` 与空 `modelMap: {}` 一致表示**不覆盖该段、继承全局**。这是实施契约值
  （设计 06/11 未规定政策合并粒度），**请求核对**（见 §9-7）。
- **不修改原始 payload**：合并只读，不解析凭据引用，不写执行快照，不改 `revision`。
- **来源说明**：每个有效键附 `global_default` / `project_default` 及对应 `sourceKey`
  （如 `modelMap.low`、`purposeStrategies.planner`）与 scope `revision`；来源仅说明，不是执行时
  动态引用。策略结构与合法性**合法 ≠ 可执行**：P01 未装配 Runner/认证/模型执行能力时，不得把
  「结构合法」标为可运行。

---

## 6. 存储字段与最小扩展清单

### 6.1 已存在字段（P01-2，复用，不改语义）

| 表 | 字段（P01-3 相关） |
|---|---|
| `projects` | `id`、`created_at`、`revision`、`updated_at`、`display_name`、`status`、`description`（可空）、`labels`（JSON 字符串数组，默认 `[]`）、`repository_binding_id` |
| `repository_bindings` | `id`、`created_at`、`project_id`、`revision`、`updated_at`、`canonical_path`（**全库唯一**）、`git_common_dir`（可空）、`repo_identity`、`binding_revision` |
| `global_settings` | `id`（`='global'` 单例）、`created_at`、`revision`、`updated_at`、`schema_version`、`payload` |
| `project_settings` | `id`、`created_at`、`project_id`（`UNIQUE`）、`revision`、`updated_at`、`schema_version`、`payload` |
| `schema_migrations` | `version`（唯一）、`checksum`、`applied_at` |

约束沿用：`projects(id, repository_binding_id)` → `repository_bindings(project_id, id)` 的同项目
复合外键 + `ON DELETE RESTRICT`；`labels` 的 `json_valid AND json_type='array'`；`revision≥1`。
`description` 是 PRD 要求的可空列（设计 11 §3 字典未列），已在前序契约注明依据；`displayName`
不参与身份与物理路径。

### 6.2 最小扩展清单（P01-3 需要新增）

| 扩展 | 目的 | 说明 |
|---|---|---|
| 仓库绑定读写端口 | 注册/幂等复用/查询绑定 | P01-2 只有 `projects.repository_binding_id`，无绑定的创建/读取方法。P01-3 增加窄方法（可置于 `StateStore` 或独立 `RepositoryBindingStore`）：按 `canonical_path` 查找、原子「项目 + 绑定」组合创建、按项目读取绑定。**F-005 已交付**：置于 `StateStore`（`createProjectWithRepositoryBinding` / `getRepositoryBinding`，无新表、无新迁移）。 |
| 变更记录 | 元数据/配置的脱敏审计 | 见 §6.3。**F-006 已交付**：迁移 v2 建立 `state_events`，项目元数据编辑同事务追加脱敏记录；配置审计留待 F-010。 |
| `listProjects` / 标签计数查询端口 | F-007 筛选、分页、计数 | 基于 `projects.labels` 的 `json_each` 查询；首版**不新增派生索引表**（设计 11 §10：数据增长后再加），不做跨层级求和。**F-007 已交付**：`StateStore.listProjects` / `countProjectLabels`（只读，无新表、无新迁移；标签绑定参数查询，稳定 `id` 升序键集分页，项目层去重计数）。 |

**明确不建**（本 Feature 范围外）：Phase/Feature/Task/Run/Attempt/Batch/Session/Chat 等执行表；
`tasks.execution_config`（Task 策略复制）；`project_profiles`/`capability_modules`、
`project_baselines`/`onboarding_operations`（基线扫描）；配置历史版本表；`repository_bindings`
的 rebind/路径迁移。需要时随对应功能新迁移版本加入，不得为占位建表或建悬空外键。

### 6.3 脱敏变更记录落点（F-006 / F-010 共用）

- **落点**：设计 11 §9 的 `state_events`（R1，持久化业务状态变化，供审计/重连/通知）。P01-3 只
  实现其**审计切片**：同一写事务内追加记录；**不实现** SSE 推送与通知投递（Host/通知属后续）。
  **F-006 已落地**：迁移 v2 建立 `state_events`（`schema.ts` 的 `stateEvents` + `migrations.ts`），
  项目元数据更新经 `StateStore.updateProject` 同事务写入 `project.metadata_updated`；配置事件类型
  （`settings.global_updated` / `settings.project_updated`）留待 F-010 使用。
- **记录内容**（脱敏，字段级）：
  - `event_type`：操作类型，如 `project.metadata_updated`、`settings.global_updated`、
    `settings.project_updated`。
  - `aggregate_type` / `aggregate_id` / `aggregate_revision`：实体类型（`project`/
    `global_settings`/`project_settings`）、实体 ID（全局为 `global`）、写入后的 `revision`。
  - `project_id`：项目范围写所属项目；全局范围见下条约束。
  - `payload`：**只含变更字段名/策略键名/`schemaVersion`** 等摘要，绝不包含 payload 值、
    `credentialRef`/`endpointRef` 值、绝对路径或任何合成秘密。
  - `occurred_at`：UTC 毫秒；`sequence`：数据库内单调递增的持久游标（`BEGIN IMMEDIATE` 下由
    同事务分配，重启不重置）。
- **原子性**：记录与元数据/配置写入在**同一短事务**；注入记录写入失败时，实体写入与 `revision`
  一并回滚，不产生半条记录。诊断 logger **不充当**权威记录。
- **已记录的设计张力**：设计 11 §9 字典将 `state_events.project_id` 标为必填（带项目 FK），但
  **全局配置变更没有适用项目**。P01-3 的最小扩展为：`state_events.project_id` 改为**可空**，
  并加 CHECK `(project_id IS NOT NULL) OR (aggregate_type = 'global_settings')`，使全局范围的
  业务事件可表达且项目 FK 在有值时仍受保护。此为对设计字典的**显式偏离**，按 F-001 要求记录
  依据并请求核对（§9-1），不静默改变语义。
- 现有 `test/sqlite-schema-migrations.test.ts` 的 `FORBIDDEN_TABLE_NAMES` 曾含 `state_events`；
  F-006 引入该表时已同步更新该守卫（从禁止列表移除、加入 `SCHEMA_TABLES` 期望集合、补 FK 与
  约束矩阵），并同步更新迁移执行器测试的版本期望（v2 为真实迁移）。

---

## 7. 范围与非目标（本 Feature 只交付 Core 应用服务与测试）

本次交付**只**包含：

1. 可独立调用的 **Core 应用服务**（`ProjectService`、`RepositoryInspector`、`PathService`、
   `ConfigurationService`）及其 `ports` 增量与 `adapters` 实现。
2. 真实临时资源测试：临时 SQLite、临时 Git 仓库、临时数据根/受控子进程（不访问真实用户目录、
   不调用真实模型）。
3. F-012 的公共入口装配与可编译调用示例；F-013 的集成验收矩阵；F-014 的文档与报告。

**明确不做**（不得自行扩展）：

- **Host 网络接口 / CLI 路由**：不新增 HTTP/SSE、不新增 `shiploop` CLI 命令或参数解析
  （CLI 属后续阶段；示例不得编造尚不存在的 CLI 命令）。
- **Task 策略复制**：`tasks.execution_config`、Planner/Judge/review 策略复制属后续；本 Feature
  只做「当前配置」的保存/合并/来源，不写执行快照。
- **执行表 / Runtime 调用**：不建 Run/Attempt/Batch/Session 等表，不导入或调用 Pi SDK/模型。
- **存量基线扫描**：不执行仓库脚本、不装依赖、不做静态扫描/基线体检（属 R2）。
- **rebind / 源代码迁移**：不做仓库移动、路径改写或源仓库迁移。
- **不修改 Harness YAML / executor / agent 配置**；不做 `accept:p01`（阶段验收由 P01-4 交付）。

### 7.1 依赖与版本

沿用前序精确版本，不隐式升级：Node `22.19.0`、npm `10.9.3`、TypeScript `7.0.2`、
Vitest `5.0.3`、`better-sqlite3` `13.0.3`、`drizzle-orm` `0.45.3`、
`@types/better-sqlite3` `9.6.0`、`@types/node` `22.20.4`。新增依赖需明确授权并更新锁文件。

### 7.2 schemaVersion

配置 payload 自 F-008 起为 `2`（v1 的 `strategies` 结构 + 新增 `policies` 政策子集）。v1
payload 与 v1 持久数据一律拒绝（读取为 `corrupt`），不被新版本静默误读；本阶段无生产存量
数据，未提供 v1→v2 数据迁移。如需再增政策段，必须显式提升 `SETTINGS_SCHEMA_VERSION` 并同步
`validateSettingsPayload`/`parseStoredSettingsPayload`。

### 7.3 结构化错误

应用层失败复用 `StorageError`（`kind` 见 §1.2）；仓库/路径检查新增窄错误类型（如
`RepositoryInspectionError`、`PathResolutionError`）时，同样携带 `operation`、实体/路径原因与
脱敏 `details`，不把 Git/文件系统错误伪装成有效绑定。

### 7.4 组合根与公共入口（F-012 方向）

- 契约区（`domain`/`application`/`ports`/公共入口）**禁止**导入 `adapters` 与
  better-sqlite3/Drizzle/Pi/HTTP（`scripts/check-boundaries.ts` 强制）。
- F-012 在 Core 内提供受控装配入口，把 `adapters`（SQLite/文件）接到 `ports`，并让应用服务只
  依赖 `ports`；跨包只经包 `exports` 的 `"."` 使用，禁止跨包内部相对路径或包内自引用绕边界
  （§1.2 与 `p01-3-handoff.md` §3 的待定项由 F-012 定案）。

---

## 8. 失败分支与验收矩阵（F-013 汇总，F-002 ~ F-012 落地）

F-013 需以真实资源覆盖（不止检查成功日志）：

- 重复路径注册 / 符号链接别名注册 → 同一 `projectId`/绑定、`already_exists`、不新增行。
- 同 remote 两个 clone → 不同 `projectId` 与 `canonicalPath`，不合并。
- 跨进程同步屏障竞争注册同一路径 → 恰一项目、一有效绑定，另一请求复用。
- 非法标签 / 空白标签 / 错误类型 → `validation`，未调用写入端口、零业务行。
- 配置结构/版本拒绝（未知 `schemaVersion`、未知键、不完整策略、非法复杂度/用途键）。
- 全局与项目配置 CAS 竞争（同 revision，一成功一 `conflict`，revision 只增一次）。
- 事务失败注入 → 无半条项目/绑定/配置/变更记录，原值保留。
- 合成秘密导出/错误/记录 → 均不泄漏；明文 `apiKey`/`token`/`password`/带凭据 URL 被拒绝。
- 稳定 namespace / 路径逃逸 / 跨项目拒绝（A 不能定位 B 的制品）。
- 关闭重开逐字段一致（项目 ID/绑定/元数据、配置 revision/来源、制品 hash/size）。

T03（当前配置原子性）、T26（当前配置基础）、T32（项目标签）、T24（默认/来源基础）在本 Feature
只为**子集**，不得冒充认领、活动执行锁或 Task 策略复制的完整验收；`accept:p01` 与阶段最终报告
由 P01-4 交付。

---

## 9. 已记录的设计张力与待核对项

1. **`state_events.project_id` 可空**（§6.3）：设计 11 §9 标为必填，但全局配置变更无适用项目。
   P01-3 以「可空 + CHECK（仅 `global_settings` 允许空）」表达，属显式偏离，**请求核对**。
   （F-006 已按此落地为迁移 v2；项目范围事件均带 `project_id`。）
2. **配置政策段**：设计 11 §3.1 列出 `verification`/`executionLimits`/`securityPolicy`/
   `memoryPolicy`/`deliveryPolicy`。**F-008 已定案**：显式升级 schemaVersion 1→2，确认本阶段
   政策子集为 `executionLimits`（maxConcurrentWorks 1..16 / workTimeoutMs 1000..86400000 /
   maxAttemptsPerTask 1..100 / envAllowlist 非敏感变量名 ≤64）、`verification`
   （requireChecksBeforeDone 布尔）与 `securityPolicy`（isolation 仅 trusted_project；
   强隔离等未支持能力明确拒绝不降级）。`memoryPolicy`/`deliveryPolicy`/Agent 职责模式段仍未
   定义即非法。数值上限与变量名启发式为实施契约值（设计未给定），**请求核对**；若设计给出
   不同范围，应由显式变更同步常量、文档与测试。
3. **数据 namespace 值**：设计 01 §4/05 §161 要求「稳定技术 namespace 及精确系统路径在发布前
   确定」。P01-3 暂定 `dataNamespace = "shiploop"`、macOS 默认根
   `~/Library/Application Support/shiploop`（从注入的用户目录解析，不硬编码绝对路径）。
   这是本阶段的实施值，**请求确认**；确认后变更属显式迁移。
4. **组合根位置**：`shiploop-core` 当前 `exports` 只暴露 `"."`，适配器不经包导出；P01-3 由 F-012
   在 Core 内定受控装配入口并保持契约区不反向依赖 `adapters`（沿用 `p01-3-handoff.md` §3）。
5. **元数据长度/数量上限**：设计 11 §10 只规定标签**规范化**，未规定 `displayName`/`description`/
   标签的安全上限。P01-3 在 `ports/validation.ts` 记录并实现 §3-9 的有限上限（防止任意长输入
   进入存储与查询），注册/编辑/查询共用。这是实施契约值而非设计结论，**请求核对**；若设计给出
   不同数值，应由一个显式变更同步常量、DDL 门槛与本文。
6. **仓库检查支持范围与 repoIdentity 派生**（F-004，§4.2）：设计 06 §1 只给出「规范路径 +
   Git 与脏状态识别」与「同 remote 不同 clone 可注册不同项目」，未规定子目录/裸仓库/linked
   worktree 的接受范围，也未规定 `repo_identity` 的具体派生。F-004 定案：拒绝子目录（不猜测
   绑定外层仓库）与裸/`.git` 内部目录（无工作树），接受 linked worktree 顶层（身份同主仓库、
   路径分离）；`repoIdentity = gitdir-sha256:` + sha256(gitCommonDir realpath)（不含路径原文、
   同 clone 稳定、不同 clone 不合并）。这是实施契约值而非设计结论，**请求核对**；若设计给出
   不同身份规则（如需跨搬移稳定的身份），应由显式变更同步派生函数、文档与 rebind 设计。
7. **政策段合并粒度**（F-009，§5.3）：设计 06/11 未规定有效配置合并中政策段的粒度。
   F-009 定案为**段级整体覆盖**（段内字段不跨来源继承、数组随段整体替换、空段对象 `{}`
   表示不覆盖该段而继承全局），与策略条目「完整整体替换」同构。这是实施契约值而非设计
   结论，**请求核对**；若设计给出不同粒度（如段内字段级合并），应由显式变更同步
   `mergeEffectiveSettings`、本文与测试。

未列入的矛盾按「已有契约优先复用」处理；不得由实施任务静默改变领域语义。

---

## 10. 复核

- 基线：§1（`npm ci` 退出 0；`npm run verify` 退出 0；20 files / 443 tests）。
- 文档示例与常量一致性由 `test/docs-p01-3-application-contract.test.ts` 守护（交叉核对本文
  引用的真实常量与表/错误枚举，防止文档与实现漂移）。
- 本轮不自动修改任何 Harness 配置；未验收平台、强 OS 沙箱与模型 Live 明确为 `not_run`/未支持。
