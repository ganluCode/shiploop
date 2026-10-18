# 已知全量回归与验收范围变更

## 保留原结论

2026-10-19 00:25（Asia/Shanghai），P03-9 原始 `npm run verify` 失败，
18 个 Task 的独立检查已通过，但 Feature 完整门禁未通过。第一步 `npm test` 运行约
29 分钟后退出 1，类型检查与构建没有在该轮 verify 中运行。

原始受测提交：`61c2ca100ffc407dd60f9e00bf36fab1c895b4f1`。
原门禁输出被 Nezha 截断，不能据此声称完整失败清单已保存，也不能断言所有失败均为旧断言。
原记录与迁移前选择清单保存在 Harness 的
`workspace/features/2026-10-11-17-45-49_p03-9/verifications/test-layout-20261019/`。

## 已确认的问题

| 迁移后文件 | 已确认现象 | 状态 |
|---|---|---|
| test/modules/storage/sqlite/sqlite-baseline-store.test.ts | 最新迁移列表仍只列到 v28，而实际已有 v29 | 待修复复验 |
| test/modules/execution/budget/p03-3-attempt-budget-reservation.test.ts | 升级后最后版本仍断言 v28 | 待修复复验 |
| test/modules/verification/p03-7-f002-verification-store.test.ts | 最新版本、迁移记录数量与升级结果仍断言 v28 | 待修复复验 |
| test/modules/storage/sqlite/sqlite-storage-integration.test.ts | 期望的迁移记录只列到 v26 | 待修复复验 |
| 其他完整门禁失败 | 原输出中段缺失，尚未完成分类；不能归零或全部归因于版本变化 | 待完整诊断 |

本次目录迁移不修改迁移 SQL、历史 checksum 或这些失败断言来获得绿色结果。
后续应区分「历史版本契约冻结」与「当前最新版本数量」；不能简单把所有旧数字替换成新数字。

## 新的局部验收范围

P03-9 的局部索引覆盖本 Feature 的 18 个 Task、19 个测试文件；保留真实恢复、
并发和交付用例，只移除与当前 Task 局部验收无直接关系的历史大组回归。

局部通过不是对原失败的修复证明。Phase 发布级验收仍需处理全部相关失败并通过完整门禁；
Phase 索引声明 `not_accepted`，不会因为目录整理或缩小范围而自动修改。
