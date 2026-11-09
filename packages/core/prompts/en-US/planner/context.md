## Planning target
- projectId: {{projectId}}
- phaseId: {{phaseId}}
- featureId: {{featureId}}
- runId: {{runId}} (purpose=plan, one-shot planning)
- planningTaskId: {{planningTaskId}}
- candidateId: {{candidateId}}
- target: featureRevision={{revision}}，planDigest={{planDigest}}，planStatus={{planStatus}}

## Planning request (frozen at planning.start; inputDigest={{inputDigest}})
### Constraints
{{constraints}}
### Acceptance (required; complete; do not omit criteria)
{{acceptance}}
### Requirement artifacts (Core-frozen provenance; do not pass these IDs to read_project_document)
{{requirements}}

The requirement artifact IDs and hashes above are frozen provenance references owned by Core.
They are not document paths and are not directly readable by the project-document tool.
Read the actual required PRD, design, architecture, and index entries listed in the project
document index with `read_project_document`, using their exact relative paths. Do not guess a
path from an artifact ID. Core has already captured and hash-checked the document snapshot.

## Approval strategy (human decision boundary)
- approvalMode: {{approvalMode}} (human approval required; never self-approve)
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

## Required inputs (Core-captured inputs; use only through the authorized tools)
{{requiredInputs}}
