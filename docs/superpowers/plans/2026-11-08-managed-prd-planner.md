# Managed PRD Planner Implementation Plan

**Goal:** Make PRD + Feature sufficient to launch planning using project-managed files.

**Spec:** ../specs/2026-11-08-managed-prd-planner-design.md

**Architecture:** Reuse document versions, Artifact publication and existing Feature/planning command receipts. Add a narrow source-binding store and CLI convenience path; keep explicit legacy input files compatible.

## Constraints

- Single Agent, no live requests, preserve dirty worktree and existing approvals.
- Project-managed drafts do not follow code branches; immutable execution inputs never read latest silently.
- Filesystem work outside SQLite transactions; Feature binding inside the command transaction.

## Steps

- [x] Pin managed document capture/versioning behavior with failing offline tests.
- [x] Implement narrow SQLite bindings and reuse DocumentService for automatic capture.
- [x] Wire Feature creation, no-input planning CLI, managed input preparation and frozen Runtime reading.
- [x] Replace default repository documentation instructions in bilingual Skills and prompts.
- [x] Run affected offline regressions, typecheck, boundaries and build; update global installation and restart idle Host.

## Verification (2026-11-08)

- Managed CLI/document/production-planning/Skills/document-snapshot regression: 5 files, 19 tests passed. Offline SSE server only, no paid model requests.
- SQLite schema, project-delete preview and planning-start command regressions passed. Migration runner: 16 tests passed after synchronizing the table inventory and the pre-existing locale migration expectation.
- Feature closeout and auto-repair: all 4 related tests passed. The combined run exposed sensitivity to a 15-second planning Batch settlement assertion under process load; the isolated planning run passed, and the final bounded 45-second diagnostic assertion passed in the 5-file regression.
- Concurrent same-hash draft updates: one succeeds and one conflicts; managed-document regression passed after serializing Host writes/capture.
- `npm run typecheck`, `npm run check:boundaries`, `git diff --check`, `npm run build`: passed; build includes actual packaged Core/Host/CLI startup smoke.
- Global command points to the rebuilt dist entry. Idle Host gracefully stopped and restarted as `df839410-f6bf-4623-ad09-c28b56cd2b85`, ready. Actual `project documents` returned the managed root for desktop-platform.
- No full suite, live Planner, source commit/push, PRD migration or installed project Skills overwrite was performed.

## Remaining Scope

Editable drafts are preserved separately from published Artifacts: back up the working directory separately; existing backup packages include published versions and contexts. Project deletion currently preserves working drafts. Existing projects need re-init to receive updated Skills.
