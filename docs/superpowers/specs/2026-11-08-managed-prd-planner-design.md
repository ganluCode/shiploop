# Managed PRD to Planner

The user-approved workflow is: create project PRD/design drafts, create a Feature referencing those files, run Planner directly, inspect/approve its automatically saved candidate. No manual document publication, artifact IDs, mapping JSON or planning request file is required in the normal path.

## Boundary

Draft Markdown lives under `<data-root>/projects/<projectId>/documents/working/`. PRD/design paths are relative to this project root. Skills may edit these drafts, never SQLite or immutable Artifact bodies. `shiploop project documents --project ID` prepares and returns this draft directory. `shiploop feature create --project ID --phase ID --title TITLE --prd RELATIVE.md` creates the formal empty draft and associates paths through Core. Optional design paths are supported. Shared architecture/product/index drafts are discovered only at documented conventional paths.

Use existing Feature import and planning commands with compatible optional fields. Before starting managed planning, Core captures current associated drafts using DocumentService/ArtifactPublisher and records real immutable requirementRefs. The existing planning input capture, candidate publication and manual approval remain authoritative. Existing input-file callers continue unchanged. CLI's simple planning path resolves current Phase/revision and constructs the existing bounded authorization without a token/cost cap; users may supply an explicit budget file instead. Do not start a model as part of Feature creation.

Managed source binding is persisted in SQLite by the Feature command transaction. Document version publication happens outside write transactions, preserving all old input versions. A new planning request sees edited drafts; executing Tasks read frozen references. Production Pi prioritizes managed input references and uses a dedicated frozen reader. Repository Markdown is an explicit compatibility fallback, not a mandatory primary source. No implicit business approval, cross-project paths, global scans, worktree writes, commit/push, real LLM requests or direct metadata edits by models.

## Verification

Test CLI no-input flow and parser errors, actual temporary SQLite/Artifact version publication, file changes across replays, Feature binding CAS/rollback, bounded/symlink-safe reads, candidate-to-coding frozen input propagation, production prompt/tool behavior and bilingual Skills. Validate affected tests, types, boundaries and build; no full regression required.
