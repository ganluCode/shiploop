# Project Document Context

Status: retained as repository-layout compatibility. The default workflow is superseded by [Managed PRD Planner](2026-11-08-managed-prd-planner-design.md), which freezes managed project documents before planning and carries them through approval, coding and repair.

## Scope

Implement the approved document-context proposal for production Pi planning, coding and Feature repair. Repository Markdown remains Git-owned design material; Core owns execution state and immutable evidence. Do not invoke models, change existing approvals or scan global resources.

## Approach

Use a small path/hash index in prompts and an immutable per-invocation document snapshot in the existing Artifact store. Avoid automatic full-text injection and avoid a second document database. The Runner exposes a read-only tool for reading the frozen documents; normal file reads remain live workspace reads.

Discover Markdown only beneath docs, with fixed depth, entry, file and total-byte bounds and no symlink traversal. Conventional docs/README.md and product/architecture overview files are shared entry points. Other documents are optional discovery candidates, never guessed to be the current Feature.

For explicit project layouts and exact Feature binding, support docs/shiploop-context.json: schemaVersion 1, shared document entries, and features keyed by official Feature ID. Each entry has path, role (index/product/architecture/prd/design/other), and required boolean. All paths are relative regular Markdown files within the authorized worktree; explicit missing/unsafe documents fail before a model request. This manifest is documentation configuration, never Task or Feature state. No implicit matching of f01 aliases to business UUIDs.

## Evidence and Tools

Host captures bytes before launch, publishes a project-document-context Artifact with project/Feature/invocation identity and the full snapshot, then puts its immutable reference into private bootstrap. The prompt contains only role, required flag, path, hash and size. The Runner verifies the Artifact body and document hashes before use; read_project_document reads frozen content by exact indexed path. Mark capture time as invocation-time, separate from the existing earlier Core task input manifest; do not claim retroactive approval or input capture.

Shared entry points and explicitly required documents must be read before work. Other Feature documents are listed for discovery only. Missing conventional documents are reported as absent, not invented. Explicit mappings must be completed for exact PRD/design association. Localized Markdown owns instructions and tool descriptions.

## Verification

Offline tests cover ordinary discovery, exact Feature mapping, missing required docs, symlink/path escapes, limits, frozen reads after source edits, actual production prompt/Artifact wiring, and planning/repair compatibility. No full regression or live model requests are needed for this change.
