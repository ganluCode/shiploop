# Project Documents and Planning

PRDs, architecture and Feature designs live in the unified project data directory, independently of code branches. Query its actual location:

```bash
shiploop project documents --project "$PROJECT_ID" --json
```

workingDirectory is `<data-root>/projects/<projectId>/documents/working/`. Maintain UTF-8 Markdown there:

```text
README.md
product/overview.md
architecture/overview.md
phases/p01/scope.md
phases/p01/acceptance.md
phases/p01/features/f01-example.md
phases/p01/designs/f01-example.md
```

Create directories as needed, preserve existing files and index actual documents/status/owners. p01/f01 are aliases, never business IDs. Use [PRD](../templates/feature-prd.md) and [design](../templates/technical-design.md) templates. Edit drafts directly, or copy generated Markdown through official commands:

```bash
shiploop document write --project "$PROJECT_ID" --path phases/p01/features/f01-example.md --input /tmp/f01-prd.md --json
shiploop feature create --project "$PROJECT_ID" --phase "$PHASE_ID" --title "Example" \
  --prd phases/p01/features/f01-example.md --design phases/p01/designs/f01-example.md --json
shiploop planning start "$FEATURE_ID" --project "$PROJECT_ID" --json
```

--design is optional. Paths are relative to workingDirectory and must exist. write is idempotent for equal content; replacing different content requires --expected-hash. Never put credentials in documents. CLI resolves Phase/revision; Core still checks CAS/ownership. Creating a Feature does not start a model.

Planner automatically captures the associated PRD/design and existing README.md, product/overview.md and architecture/overview.md as immutable document versions and requirementRefs in SQLite. No manual publication, artifact IDs, mapping JSON or planning-request file. Unchanged content reuses the version; new planning sees edits, while active Tasks retain frozen input. Do not edit immutable Artifact bodies or SQLite.

Simple planning grants one Run, up to 3 Attempts/starts, 7 days and no token/cost cap. --budget accepts the existing full budget object. Advanced planning start --phase --revision --input JSON remains compatible; do not mix modes. Retain commandId, inspect receipts after uncertain responses and never blindly use a new ID. --command-id supports checked replay.

Successful submission stores a candidate automatically. Review with planning candidate, then planning approve to apply formal Task metadata. Approval does not authorize coding. accepted, candidate storage and model prose are not delivery proof.

## Prompts and Compatibility

For source=managed-project-documents, use read_project_document for the frozen version outside the worktree, never resolve its paths with read_file. Prompts contain path/role/version/required/hash metadata, not automatic full-text injection. Coding and repair retain the fixed input.

Repository docs remain an optional compatibility source; preserve old files. Legacy tasks without managed inputs may use repository discovery or existing docs/shiploop-context.json. Normal new workflows do not need mapping JSON. Document edits never rewrite active Task inputs.

## Writing and Acceptance

Back up editable working drafts separately. Existing backup packages collect published document versions and context Artifacts, but do not yet collect working draft bodies. Project deletion currently preserves the working draft directory.

- Read project AGENTS.md, linked documents and index. Search selectively, never whole session histories.
- State goals/non-goals, observable acceptance, real dependencies and test scope. Keep owner decisions proposed until confirmed.
- Architecture owns shared interfaces/data/permissions/runtime boundaries. Specify cross-task signatures/contracts and link one authoritative document.
- Feature dependencies form a DAG with shared file/Schema/resource ownership and integration prerequisites. Numbering is not a dependency.
- Tasks include TDD and related unit tests; Features run their scoped union; Phases run impact-based regression/integration. Full regression belongs to CI or explicit authorization.
- Organize code/tests by meaningful modules, avoiding giant flat directories and excessive tiny folders. Use real or explicitly pending test paths, never invented functions.
- Synchronize affected docs and index. Design status is not acceptance; record SHA/date/commands/results/evidence/not_run.
- Business metadata, dependencies, approvals and status only change through CLI/Host. Models must not edit official Task JSON/Feature YAML or run SQL.
