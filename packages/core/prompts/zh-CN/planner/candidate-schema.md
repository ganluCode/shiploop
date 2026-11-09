## 规划候选提交形状

使用 planning_candidate_submit 的 candidate 参数提交完整 JSON 字符串，不写官方 Task 文件。
下面是结构示意；身份使用本次冻结值，示例任务名/路径/验收必须替换成实际需求与代码事实，
不是让你创建示例功能。sourceRefs/requirementsRefs/checkRefs/moduleRefs 只能填真实引用。
受管文档的路径和 documentId 不是 Artifact 引用；没有完整的真实 Artifact 引用时，
feature.sourceRefs 和 tasks[].requirementsRefs 填 []，Core 提交时会补入冻结的受管文档引用。
建议在 codemode 中构造普通对象，再以 JSON.stringify(candidate) 提交；不要手写多层转义 JSON，
不要把代码、Markdown 围栏或注释作为 candidate 正文。收到校验拒绝后修正并重新提交，只有 completed 才算提交成功。

```json
{
  "schemaVersion": 1,
  "projectId": {{projectId}},
  "featureId": {{featureId}},
  "runId": {{runId}},
  "candidateId": {{candidateId}},
  "plan": {
    "schemaVersion": 1,
    "feature": { "title": "实际 Feature 名称", "description": "实际范围", "labels": ["backend"], "sourceRefs": [] },
    "tasks": [{
      "id": "task-001",
      "title": "实际可独立验证的实现结果",
      "description": "职责与边界；简述已有模式或影响难度的真实决策",
      "complexity": "low",
      "labels": ["backend"],
      "languages": ["typescript"],
      "acceptance": { "criteria": ["实际输入产生实际可观察结果", "必要负例行为"] },
      "requirementsRefs": [],
      "dependsOn": []
    }]
  },
  "taskVerification": [{ "taskId": "task-001", "checkRefs": [], "moduleRefs": [], "impactScope": ["src/example.ts"] }],
  "summary": "拆分依据、已有实现复用、测试影响范围和仍待确认事项"
}
```

先确认 taskLimit 与全部验收覆盖，保持 DAG 无环；难度和语言按实际 Task 填写，不照抄例子的 low/typescript。
taskVerification 不含 shell/argv/env，不把未知路径当已存在的测试文件；只填写受影响源码范围
或真实受信检查引用。提交成功后汇报候选摘要和等待批准状态，不开始编码或自批通过。
