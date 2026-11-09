# Stable Git Naming Implementation Plan

**Goal:** Freeze readable Feature branch names and use stable Task commit prefixes.
**Architecture:** Incremental SQLite migration plus trusted naming helpers; preserve historical workspace and operation identities.
**Tech Stack:** TypeScript, better-sqlite3, Vitest.
**Spec:** ../specs/2026-11-09-git-naming-design.md

## Steps

- [x] Add failing tests for stable names, migration preservation, workspace reuse and Task prefixes.
- [x] Add immutable branch metadata, populate it at Feature creation and expose it through Feature queries.
- [x] Resolve workspace preparation from persisted branch metadata; retain legacy branch reuse.
- [x] Generate new Task messages from persistent aliases; reuse historical intents unchanged.
- [x] Update bilingual operation Skills and Git naming documentation.
- [x] Run targeted tests, typecheck, boundary checks and build. No model requests or business coding.

## Verification

- Workspace preparation + naming + notification aliases: 34 tests passed.
- Schema + built CLI Task commit + candidate approval + naming: 87 tests passed.
- Planner input/dispatch + workspace integration + naming/wire compatibility: 44 tests passed.
- Typecheck, module boundaries and build with Core/Host/CLI smoke passed.
- These are targeted suites with overlapping naming tests, not a full regression run.
- No production Host restart or production workspace migration was performed.
