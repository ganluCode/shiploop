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
