# P03-5 Workspace Inspection Contract

`WorkspaceInspector.inspect(baseline)` is a read-only evidence port, exported from
Core. The filesystem adapter is `createWorkspaceInspector` in
`packages/core/src/adapters/fs/workspace-inspector.ts`.

## Authorization And Ownership

The caller supplies a Core-authorized, immutable `WorkspaceBaseline` from a
binding/preparation intent and trusted `authorizedRoots` from PathService. A
caller-controlled directory or Git registration does not authorize ownership.
Canonical paths must match exactly; the configured macOS temporary-root alias
may normalize, but workspace and metadata aliases are rejected.

Assembly must supply `confirmProcessIdentity`. It has the existing command port
semantics: persist each launch identity BEFORE resolving with its launch ID.
This reader neither invents a process occupancy table nor bypasses this callback.
The default process adapter is the existing macOS supervisor; tests alone may
acknowledge isolated disposable processes without a business database.

The caller retains project/workspace occupancy and the short Git operation
boundary defined by F-003 while inspecting. Do not hold a SQLite write transaction
across inspection. F-004 does not acquire/release occupancy, prepare a workspace,
approve external HEAD movement, stop old writers, or authorize deletion. Later
reuse policy must compare observed HEAD/code evidence to its durable authorized
history; an existing base commit or a descendant is not sufficient authorization.

## Evidence

Successful evidence is complete, versioned, and contains the binding ID/revision,
canonical workspace/common-dir, repository identity, confirmed base commit type,
observed HEAD/branch, reciprocal linked-worktree metadata, and Git registration.
Two bounded Git/filesystem observations must agree. Source refs, HEAD, index and
all content are read only. Git executes with explicit argv/cwd, fixed environment,
no optional locks, no global/system config, no fsmonitor or hooks, no replacement
objects or lazy fetch (all transport protocols are also disabled). Gitlinks and symbolic tracked entries are refused before
status can recurse into another repository. No shell, repository script,
dependency install, checkout, reset, ref write or worktree mutation is performed.

Paths are exact UTF-8 strings parsed from NUL Git records, never line splitting
or shell unquoting. Unsupported non-UTF-8 Git output fails closed. SHA-256 hashes
cover exact bytes, executable permissions, index state, unstaged/staged deletions,
tracked source/config and all untracked content. A staged index removal records a
tracked deletion while surviving untracked/ignored bytes remain independently
protected. `codeDigest` excludes ignored
bytes; ignored entries have their own `ignoredDigest` and `preserve` conclusion.
All directories, including empty ignored directories, have independent preserve
evidence. `none_present` for ignored files does NOT authorize directory deletion.
Submodules, symlinks (including internal ones), special files and unreadable files
are conservatively rejected rather than followed or silently omitted.

`evidenceId` is SHA-256 over structured identity/content facts, excluding timestamps
and inode observation stamps. Unchanged observations keep the same evidence ID;
ignored changes alter evidence ID without changing the code digest. UTC timestamps
record each observation interval. Missing content size/digest/index information is
null, not a fabricated zero. Porcelain status is stored as base64 to preserve its
NUL framing; error messages omit raw stderr, credentials and absolute paths.

## Bounds And Failure

Default hard ceilings (trusted assembly can only lower them):

- 20,000 filesystem entries, including directories; tracked deletions also count
  against the Git inventory ceiling.
- 256 MiB content bytes per observation, two observations, 64 directory levels.
- 8 MiB combined stdout/stderr across the entire inspection, at most 22 Git calls.
- 10 seconds per Git command; 120 seconds inspection budget, no retries.
- Git pointer files are regular, no-follow/nonblocking reads, at most 16 KiB each.

All Git commands reuse supervised cancellation and require confirmed group stop,
even after exit code zero. Startup has the existing 5-second handshake ceiling;
stop escalation/confirmation retain their existing bounded tail (up to 15 seconds)
and do not turn an uncertain stop into success. The total deadline also aborts
startup and is checked throughout file reads. Filesystem operations assume the
supported local trusted filesystem, not arbitrary hostile blocking devices.

Errors have a structured reason, `complete: false`, and nullable actual exit/signal
information. No failed inspection returns partial content or digest. Distinct
reasons cover absent paths, unauthorized roots, repository mismatch, damaged
registration, missing commit, detached HEAD, wrong branch, limits, permission,
links, special files, concurrent change and unconfirmed stop.

This is a trusted-project check, NOT an OS sandbox or an atomic filesystem/Git
snapshot. Cooperative occupancy and stop verification remain necessary; arbitrary
external writers can always race after an observation. Never use this evidence
alone to mark a Task passed or a workspace safe to delete.
