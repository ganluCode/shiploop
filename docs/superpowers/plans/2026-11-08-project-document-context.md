# Project Document Context Implementation Plan

**Goal:** Give every production Pi invocation explicit repository document locations and verifiable frozen reads.

**Architecture:** Bounded Host discovery and a versioned repository mapping feed a Core-published immutable Artifact. Runner prompts include the path index and use a snapshot-only document reader.

**Spec:** ../specs/2026-11-08-project-document-context-design.md

## Constraints

- Single Agent. Preserve current worktree changes; no commits, push or live requests.
- Preserve existing Task approval and input manifests; capture this additional context at invocation time.
- No unrestricted scans, symlink reads or silent truncation of required documents.

## Tasks

- [x] Add failing tests for discovery, explicit mapping, unsafe/missing documents, frozen reads and limits.
- [x] Implement bounded document loader and snapshot reader; localized prompt/tool assets.
- [x] Publish invocation context through Core's existing Artifact publisher; wire planning, coding and repair bootstraps, prompt index and provenance.
- [x] Update bilingual Skills/templates and documentation; run affected tests, typecheck and build.

## Validation

Discovery and Skill template tests were observed failing before implementation. Ten affected test files passed across scoped runs (48 unique tests), including actual SDK fake HTTP reads after the live document changes, real Core Artifact publication/integrity readback, Host startup and Feature repair regression. Typecheck, production boundary checks (574 files, zero diagnostics), diff whitespace validation and full build entry smoke tests passed. No live model request, full repository suite, commit or push was performed. Existing project Skills and document mappings were not overwritten.
