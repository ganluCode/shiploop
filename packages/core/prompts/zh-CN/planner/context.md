## Planning target
- projectId: {{projectId}}
- phaseId: {{phaseId}}
- featureId: {{featureId}}
- runId: {{runId}}（purpose=plan，一次性规划）
- planningTaskId: {{planningTaskId}}
- candidateId: {{candidateId}}
- target: featureRevision={{revision}}，planDigest={{planDigest}}，planStatus={{planStatus}}

## Planning request (frozen at planning.start; inputDigest={{inputDigest}})
### Constraints
{{constraints}}
### Acceptance (required; complete; 不得删项)
{{acceptance}}
### Requirement artifacts（Core 已冻结的追溯身份；不要把这些 ID 传给 read_project_document）
{{requirements}}

上面的需求制品 ID 和哈希是 Core 保存的追溯引用，不是文档路径，不能直接交给项目文档工具读取。
请使用项目文档索引中列出的准确相对路径，通过 `read_project_document` 读取 PRD、设计、架构和索引文档。
不要根据制品 ID 猜路径。Core 已在启动规划时完成文档快照和哈希校验。

## Approval strategy (human decision boundary)
- approvalMode: {{approvalMode}}（候选由人工批准；模型不能自批通过）
- taskLimit: {{taskLimit}}

## Code baseline (designated snapshot; read-only; verify before relying)
- worktreeId: {{worktreeId}}
- headCommit: {{headCommit}}
- codeDigest: {{codeDigest}}

## Purpose strategy (actual copy; source: {{configSource}}{{configSourceKey}})
- runtime: {{runtime}}
- provider: {{provider}}
- model: {{model}}
{{credentialLine}}{{endpointLine}}
## Permissions
{{permissions}}

## Required inputs（Core 已捕获的输入；只能通过授权工具使用）
{{requiredInputs}}
