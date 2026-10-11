# P03-2 执行必需输入受控采集与校验读取契约（F-004）

- 文档状态：P03-2 / F-004 交付的执行必需输入采集/读取契约（Core 层）。
  上游：`docs/p01-3-application-contract.md`（制品索引/文件契约）、F-011
  制品流式发布、F-012 中断核对与有效读取。InputManifest/prompt 生成属
  F-005，执行输入准备编排与 snapshot 制品组属 F-006，Host/CLI 接线属
  F-007/F-008（本项不实现）。
- 实现入口：`packages/core/src/ports/execution-input.ts`（引用形态
  `ExecutionInputRef`、来源校验 `validateExecutionInputItem`、受控源读取
  端口 `InputSourceFileReader` 与 `InputSourceError`）、
  `packages/core/src/adapters/fs/input-source-files.ts`
  （`createInputSourceFileReader`，获准根白名单 + realpath/no-follow 真实
  文件系统读取）、`packages/core/src/application/execution-input.ts`
  （`createExecutionInputService`：`captureRequiredInputs` /
  `readRequiredInput`）。均经 `shiploop-core` 公共入口导出（适配器经
  adapters 层路径）。

## 1. 引用形态（内容身份摘要，不是正文本身）

`ExecutionInputRef` 字段：`projectId` / `artifactId` / `kind` / `purpose` /
`version` / `contentHash` / `sizeBytes` / `locator` / `mediaType` / `origin`。

- 已有受管引用来源（`source.kind='artifact'`）只携带 `artifactId`；采集时
  经 ArtifactStore 核验同项目归属（跨项目 `ownership`）与 ready 状态
  （pending/failed → `not_ready`），引用身份字段一律取自权威索引记录，
  不信任请求方携带值，绝不修补 hash；
- 可变文件来源（`source.kind='file'`）表达为「获准根 ID + POSIX 相对
  路径」；`origin` 只保留该逻辑身份，**源文件绝对路径不当最终快照**、
  不进入引用与错误；
- `purpose`（≤128 字符，不含路径分隔符/NUL，非 `.`/`..`）参与受控
  locator 推导（`execution-inputs/<purpose>`）；所有项都是必需输入，
  空 `items` 与重复 `purpose` 一律 validation 拒绝（不静默省略）。

## 2. 受控采集（可变来源 → 同项目不可变正文引用）

`captureRequiredInputs({ projectId, taskId?, items })`：

- 文件来源：经 `InputSourceFileReader.openSourceRead` 打开（路径安全见
  §3），逐块有界捕获实际字节（增量 SHA-256 与字节数、逐块时间预算检查、
  stat 与实测字节数不一致即 `source_unavailable`，拒绝捕获不确定正文），
  复用 **ArtifactPublisher** 发布为同项目不可变受管 Artifact
  （kind=`execution-input`，登记预期摘要 = 实测摘要，发布用例自身再做
  staging/hash 核验/不覆盖发布/短事务 CAS ready，文件 I/O 不在 SQLite
  写事务内）；
- 整批 fail-fast：任一项失败即抛出 `ExecutionInputError`（关联
  projectId/taskId/artifactId/purpose），不静默省略；失败前已发布的制品
  保持不可变（本身是可核对证据），不回滚；
- 发布后修改或删除源文件不改变已捕获正文；重新采集生成新引用（新
  artifactId/hash），旧制品保持原字节与 hash（制品索引不提供内容身份的
  普通更新入口）；
- 发布失败保留可诊断证据：`ExecutionInputError(code='publish')` 包装
  `ArtifactPublishError`（保留 cause、阶段与 artifactId），索引保留
  failed/pending 状态与阶段化失败原因，staging 残留保留供 F-012 核对。

## 3. 路径安全（获准根 + realpath/no-follow，复用既有规则）

`createInputSourceFileReader({ roots })` 与 F-010 制品文件适配器同一三层
防线：

1. 输入校验：locator 契约使 `..`/绝对路径/反斜杠/NUL 无法进入推导
   （StorageError kind='validation'）；
2. 目标 realpath 必须位于获准根之内（符号链接祖先逃逸在任何读取之前
   拒绝，`InputSourceError(kind='escape')`）；
3. lstat 目标叶（符号链接一律拒绝、非常规文件拒绝）+ O_NOFOLLOW 打开
   + fstat 复核常规文件（检查与打开之间的链接替换被 O_NOFOLLOW 拦截）。

获准根白名单由可信装配显式注入，构造时逐个 realpath 固定并核验为已存在
真实目录（缺失/非目录/相对根 `invalid_input`）；空白名单 fail-closed
（任何根引用 `unknown_root`）。适配器只读：不创建/修改/删除任何文件。

**边界**：可信项目模式 ≠ 强 OS 沙箱——检查与操作之间的并发替换窗口由
「单 Host 写入者 + 用户明确授权的可信项目」前提收窄，本契约不宣称强隔离。

## 4. 校验读取（完整性核验 + 引用一致性）

`readRequiredInput(projectId, ref)`：

1. 引用形态校验（严格字段集，非法摘要/版本/未知键 validation）；
2. 引用项目与请求项目不一致 → `ownership`（跨项目引用拒绝）；
3. 引用 sizeBytes 超过单项上限 → `limit_exceeded`（不无限缓存）；
4. 复用 **ArtifactVerifier.readVerifiedContent** 核验 ready 状态、预期
   摘要、字节数与受控位置：ready 正文缺失/篡改/大小不符 → `corrupt`
   （missing/hash_mismatch/size_mismatch，明确失败而不是返回空内容）；
   pending/failed → `not_ready`；
5. 读取时间预算 `readTimeoutMs`（超时 `timeout`，核验通过但超预算同样
   丢弃内容）；
6. 引用一致性核对：请求方引用的 contentHash/sizeBytes/locator 必须与权威
   核验结果一致，不一致即 `mismatch`（疑似修补引用，拒绝放行，绝不采用
   引用携带值）。

读取只按 artifactId 定点核验，**不扫描全部历史**（项目级批量核对属
F-012 verifyProject，不在本用例内）。

## 5. 预算与秘密纪律

- 预算全部显式有限（`ExecutionInputLimits`）：`maxItems`（引用数量）、
  `maxItemBytes`（单项字节，采集与读取都适用）、`maxTotalBytes`（批量
  总字节）、`captureTimeoutMs`（采集逐块检查）、`readTimeoutMs`（读取）；
  时钟可注入以保证确定性测试；
- 秘密纪律：输入项不允许内联正文/凭据字段（契约层 `rejectUnknownKeys`
  fail-closed）；凭据只以引用表达，不解析认证材料；`ExecutionInputError`
  与 `InputSourceError` 的消息与 details 只含相对逻辑位置、摘要、字节数、
  限制值与脱敏错误码，**不含绝对路径或正文内容**；
- 错误关联适用项目、Task 和 Artifact 身份（`projectId`/`taskId`/
  `artifactId`/`purpose` 字段 + cause）。

## 6. 本项不实现

InputManifest/prompt 生成与版本化 ContextBuilder（F-005）、执行输入准备
编排与 snapshot/manifest/prompt 制品组（F-006）、Host/CLI 接线
（F-007/F-008）、强 OS 沙箱；不新建制品库、不做通用知识检索。
