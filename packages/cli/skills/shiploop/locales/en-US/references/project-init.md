# Project Initialization

project init registers a local repository, binds a ShipLoop project and synchronizes official Skills. It does not install dependencies, run scripts/baselines or create Git commits. Confirmed init writes Skills and may leave uncommitted files.

```bash
shiploop project init "$REPO" --data-root "$DATA_ROOT" --json
shiploop project init "$REPO" --name "Project name" --confirm --data-root "$DATA_ROOT" --json
```

Preview checks canonical path, HEAD, dirty state, repository identity and binding.
First registration requires --name; an existing canonical path reuses its binding/name/description/labels and permits:
```bash
shiploop project init . --confirm
```

After successful registration CLI replaces only its two dedicated directories in each Harness:
```text
.agents/skills/shiploop/
.agents/skills/shiploop-plan-feature/
.claude/skills/shiploop/
.claude/skills/shiploop-plan-feature/
```

The global locale selects English (en-US, default) or Chinese (zh-CN). Rerun confirmed init to sync a new language/version; changing locale does not silently overwrite existing projects. Other Skills remain untouched. Sync does not prove the Harness actually loads a Skill.
The planning Skill uses the current Harness to design Features/PRDs/DAG without extra models or execution. Templates stay inside Skills. Query project documents for the unified project workingDirectory and keep PRDs/architecture/designs there, independent of source branches (see [documentation](documentation.md)). Init does not overwrite documents.
Separate local clones of the same GitHub remote are separate local projects by default.
