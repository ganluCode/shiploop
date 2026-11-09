## Rework handoff (incremental fix; same worktree; verified scene)
- attemptId: {{attemptId}}
- previousAttemptId: {{previousAttemptId}} (direct previous attempt, same task {{previousTaskId}})
- worktreeId: {{worktreeId}}
- headCommit: {{headCommit}}
- codeDigest: sha256:{{codeDigest}}

## Failure evidence (required; read each via reference and verify hash; bodies not inlined)
{{failures}}

## Recovery record (source & mode record only; no native continuation implemented)
- selection: {{selection}}
- decision: {{decision}}
