# Default Feature Closeout Implementation Plan

**Goal:** 默认 Host 自动执行 Feature 验收、受控交付并推进依赖，失败时有界修复或停止。
**Architecture:** 复用 Verifier、最终审批、Git operation 和 Feature DAG；首次收尾不伪装 retryFinal。
**Tech Stack:** TypeScript、Node22、SQLite、Vitest，单 Agent 实施。
**Spec:** harness/input/shiploop-v1/p07-default-feature-closeout-design.md，已批准实施。

## Constraints

人工阻塞优先；不隐式全仓测试或真实模型调用；不改历史 Task 通过记录；未知 Git
结果先核对，不重复提交；修复上限默认三次，次数和预算跨重启不清零。

## Tasks

- [x] A. 持久收尾准入及协调器：绑定 project/run/输入摘要，重复唤醒复用阶段结果，
  外部副作用前持久标记，恢复中不盲重做。测试多连接竞争、计数及旧回执。
- [ ] B. 首次 Feature Verifier、批准范围、审批及 Git 交付，最后原子结算。
  测试失败不解锁、身份变化拒绝、审批阻塞和取消竞争。
- [ ] C. 默认 Core/Host 的 onHandoff 接线及继续 Feature DAG，保留 retryFinal 原义。
  真实临时 SQLite/Git 加离线 Runtime 测试成功继续与失败停止。
- [ ] D. 通用修复配置、受信 Runtime 消费者及有界恢复；模型不得改元数据或审批。
- [ ] E. 文档同步、定向测试、类型和边界检查；未完成前不签署 Phase、不合并 main。

## Review Focus

副作用后崩溃、人工阻塞/取消竞争、旧摘要回执、跨项目身份、零测试或缺失证据，
必须有失败关闭行为，不能靠模型自报通过。

## A 验证记录（2026-11-02）

新增迁移 v64 与 Drizzle 定义、项目删除清点/保留保护、SQLite CAS 存储及应用协调器。
三个定向文件 84 项测试通过，类型及层边界检查通过。覆盖独立连接竞争、跨项目
错误归属、旧回执、重开不清零、修复上限、缺失证据、人工阻塞及未知提交结果。

本阶段协调器只定义受信消费者接口，尚未装配真实 Feature Verifier/Git/Runtime。
新 Host 不能自动接管旧 Host 正在执行的副作用，需 B/C 中接停止证据及显式核对路径。
默认 Host 闭环仍未完成，P07 不放行；不以新增表或 mock 消费者测试冒充闭环通过。

## B 组件进展（2026-11-02）

已增加 Feature 检查允许列表（featureChecks）、当前 Feature 并集选择、首次 Verifier
适配及交付消费者。117 项定向回归通过；真实 Node/SQLite/制品检查另行验证。
交付消费者复用原结算事务，不重跑通过的测试，单元覆盖审批等待/失效证据/未知 Git。
配置摘要包含新字段，不配置不全量回退，不自动生成或批准检查范围。

B 仍未勾选：真实默认装配的资源交接及授权上下文尚未完成，见
docs/feature-closeout-contract.md。后续不得把显式测试资源预留当成生产实现。

## C 资源组件进展（2026-11-02）

新增 Run 级资源桥接与 Runtime 停止制品核验，复用持久认领/槽位/Feature 资源与
既有带回执围栏的续租，不复活 Task。真实资源测试覆盖旧 owner/保留 Task 租约拒绝、
续租代次不变、过期隔离、Runtime 停止制品正向及缺失/身份错误拒绝。
AbortSignal 已贯通 FeatureCoordinator → Node Verifier，已中止则不启动进程。
普通派发结算新增未知收尾/Git 终态保护，防止后续补扫误释放尚待核对的资源。

实际默认工厂、onHandoff、状态结算/依赖推进与 Runtime 修复仍未装配，C/D 不勾选。

## 默认入口进展（2026-11-02）

已接默认普通 Run 的 onHandoff，使用该 Host 派发身份、当前 Task 终态引用、
真实停止制品与 Run/Feature 租约，执行获准检查并集；受控 Git 成功后原子结算。
默认闭环测试不恢复 Task 租约、不新增 Runtime 调用，明确播种 Task 通过证据。
成功路径验证真实检查、Git、业务结算、派发资源释放及重复扫描幂等；失败路径
验证不提交、保留失败批次引用、Feature partial/Run failed。未调用真实模型。

四文件 18 项通过，另三文件 6 项上下文/资源/取消/deadline 定向回归通过；
类型、边界和 diff 检查通过。共享 Batch 子结算测试单独通过，但不能据此
宣称共享 Batch 默认全链路已完成。C 仍包含跨 Host 恢复与依赖全链路未验收项，
D Runtime 自动修复仍未实施，不勾选整项，不合并 main 或签署 P07。

## D 配置与准入边界（2026-11-02）

已增加可选 featureAutoFix 政策段、整体覆盖、完整策略能力校验及纯策略解析：
默认关闭，启用最多三次；显式模型优先，否则只选已配置 high；Token 总预算、
轮次与超时须显式有界。解析后冻结摘要进入 closeout 输入身份。

默认消费者尚无通用修复 Runtime，启用配置时在执行任何 Feature 检查/提交前
明确暂停，避免字段合法但功能被静默忽略。现有 Work 请求绑定 Task/Attempt，
GitAgent 请求绑定 Git 专用授权，均不能直接冒充通用修复身份。后续需补专属
持久预算/执行身份、受控输入和权限、Runtime 停止与恢复，再打开实际消费者。
D 不勾选；未调用真实模型，未开启当前项目的自动修复配置。

验证：配置/合并/模式三文件 104 项通过；配置服务、查询、能力目录和命令等
五文件 91 项通过；最新新增政策文件 16 项通过。默认成功/失败/缺执行器及
上下文/协调器三文件 10 项通过。上述集合存在重叠，不作为唯一测试总数相加。
类型、548 源文件边界及 diff 检查通过；未运行全仓/整轮 Phase 验收。
