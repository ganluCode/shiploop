## Planning Candidate Submission

Submit complete JSON text using the candidate parameter of planning_candidate_submit. Never write official Task files.
Managed document paths and documentId values are not Artifact references. When complete real Artifact references
are unavailable, leave feature.sourceRefs and tasks[].requirementsRefs empty; Core injects the frozen managed
document references at submission. Prefer constructing an object in codemode and passing JSON.stringify(candidate).
Do not submit source code, Markdown fences, comments or manually escaped nested JSON. Correct validation rejections
and resubmit; only a completed receipt confirms submission.
This illustrates structure only. Use frozen identities and replace example names/paths/criteria with actual requirements and code evidence.
Do not implement the example. sourceRefs/requirementsRefs/checkRefs/moduleRefs must be real references.

```json
{
  "schemaVersion": 1,
  "projectId": {{projectId}},
  "featureId": {{featureId}},
  "runId": {{runId}},
  "candidateId": {{candidateId}},
  "plan": {
    "schemaVersion": 1,
    "feature": { "title": "Actual Feature title", "description": "Actual scope", "labels": ["backend"], "sourceRefs": [] },
    "tasks": [{
      "id": "task-001",
      "title": "Actual independently verifiable outcome",
      "description": "Responsibility and boundaries; reused patterns or real complexity decisions",
      "complexity": "low",
      "labels": ["backend"],
      "languages": ["typescript"],
      "acceptance": { "criteria": ["Actual input produces an observable result", "Required negative behavior"] },
      "requirementsRefs": [],
      "dependsOn": []
    }]
  },
  "taskVerification": [{ "taskId": "task-001", "checkRefs": [], "moduleRefs": [], "impactScope": ["src/example.ts"] }],
  "summary": "Decomposition, reused implementation, test impact and open decisions"
}
```

Check taskLimit, complete acceptance coverage and an acyclic DAG. Classify actual complexity/languages rather than copying low/typescript.
taskVerification contains no shell/argv/env; do not treat unknown paths as existing test files. Include only affected source scope
or real trusted check references. After submission, summarize the candidate and pending approval; do not code or self-approve.
