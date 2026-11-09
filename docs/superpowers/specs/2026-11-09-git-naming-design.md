# Stable Git Naming

Approved approach: persist Feature.branchName rather than recomputing it during execution.

- New Features freeze `feat/p01/f01-project-foundation` at creation, using persistent display codes and an ASCII kebab-case title slug (fallback `feature` for titles without ASCII words). Titles, plan revisions, moves and retries do not rename branches.
- Migration preserves the exact managed workspace branch for existing Features. Existing Features without a workspace receive `feat/p01/f01-feature`. Never rename Git refs or rewrite commits during migration.
- Core resolves workspace preparation from the persisted branchName, including legacy names. Missing naming metadata refuses preparation instead of guessing a different branch.
- New Task commit intents use `T001: <task title>` from the same-project, same-Feature persistent Task alias. Normalize the title to one line. Existing intents retain their exact message on recovery/replay.
- Public Feature queries expose branchName; CLI JSON and bilingual Skills describe the convention. Branch names do not encode ancestry: dependency SHA selection is a separate change.
- Scope excludes automatic migration of live worktrees, changes to approved plan digests, starting models, and production data changes outside normal schema migration.

Alternatives: runtime recomputation is rejected because title changes would rename branches. UUID/hash-only refs remain supported for historical workspaces, but are unsuitable as the new human-facing convention.
