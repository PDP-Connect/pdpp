## Context

PDPP has many existing unique per-test allocations and normal-path cleanup.
They solve prompt local release, but not the separate defect of an unowned
outer process tree. A test command can spawn package managers, test runners,
shell/Python children, and parallel Node workers; a normal hook cannot safely
delete shared or arbitrary temporary roots after an interruption.

The boundary is therefore one owner per outer canonical invocation. It is a
deep module: callers supply an exact argv, while the module hides trusted
placement, allocation identity, marker state, inherited environment,
process-group lifecycle, cleanup, and recovery. It does not add a new test
framework or require a call-site migration.

## Goals and non-goals

Goals:

- Preserve exact argv, cwd, inherited stdio, output ordering, test concurrency,
  ordinary exit codes, and Node signal semantics.
- Contain ordinary descendants that honor the inherited temporary-directory
  environment, then remove only the verified run root.
- Fail closed when successful containment cannot be proved, and recover only
  stale roots whose ownership can be verified.
- Keep routing and literal-path coverage durable through static ratchets.

Non-goals:

- Replacing Node's test runner, creating a daemon, or mass-migrating existing
  `mkdtemp` call sites.
- Deleting ambient `TMPDIR`, `/tmp`, a workspace, container state, an external
  database, or a caller-provided arbitrary path.
- Claiming cleanup after SIGKILL, OOM, host failure, containers/services,
  hostile same-UID mutation, or Windows process-tree parity.
- Proving or removing descendants that intentionally call `setsid` or otherwise
  leave the owned process group. Process-group membership is the containment
  contract; this design makes no `/proc` or cgroup-containment claim.

## Ownership model

The owner allocates one `run-*` directory below a dedicated disk-backed
same-UID 0700 parent. Local placement uses the canonical target of
`~/.tmp/pdpp-test-scratch`; CI uses a dedicated 0700 child below `RUNNER_TEMP`.
Ambient `TMPDIR`, `TMP`, and `TEMP` are diagnostic input only and are never a
placement or deletion authority. A supplied placement base may be a symlink;
the owner resolves it once and deletes only its allocated child.

The owner exports one fixed root to the exact child argv:

- `TMPDIR`, `TMP`, `TEMP`, and `TEST_TMPDIR`
- `PDPP_TEST_SCRATCH_ROOT`
- `PDPP_TEST_SCRATCH_SCHEMA=pdpp.test-scratch/v1`
- `PDPP_TEST_SCRATCH_MARKER=<root>/.pdpp-test-scratch.json`
- `PDPP_TEST_SCRATCH_NONCE`
- `PDPP_TEST_SCRATCH_OWNER_PID`

Existing `mkdtemp(join(tmpdir(), prefix))` calls therefore retain unique
per-test children below the shared invocation root. A nested wrapper validates
the complete inherited marker, nonce, and root identity. If valid, it is a
participant: it passes the variables through, creates no root or process group,
and never attempts owner cleanup or recovery. Incomplete or invalid metadata
fails closed rather than authorizing a second owner or deletion.

On POSIX, membership in the detached process group is the only descendant
containment proof. The owner signals and checks that group by negative PGID; it
does not infer containment from `/proc` ancestry or claim cgroup isolation. A
descendant that deliberately invokes `setsid` is outside the guarantee and is
not proven absent or removable by scratch cleanup.

## Allocation, cleanup, and recovery

Allocation records a capability, not a caller-controlled path:
`{ canonicalParent, root, dev, ino, nonce }`. The nonce is exactly 48 lowercase
ASCII hexadecimal characters, the sole representation produced by 24 random
bytes, and is rejected at marker parsing otherwise. POSIX separators, Windows
separators and drive/UNC-looking values, nested names, absolute-looking text,
encoded separators, and Unicode slash variants are all malformed. The root is a same-UID,
non-symlink 0700 `mkdtemp` child. Its marker is written exclusively with mode
0600 and atomically transitions from `allocated` to durable `launching` before
calling `spawn()`. After `spawn()` returns a positive direct-child PID, the
next durable transition records that PID as the `running` PGID. A marker write
syncs its file and parent directory. `launching` is intentionally ambiguous:
the live owner can return it to `allocated` only when it proves no spawn was
attempted, but a later recovery retains an owner-dead `launching` root as
`launch-unknown`. Age, an absent owner, and an absent later group do not prove
that the unrecorded handoff never created a process. Markers include schema,
nonce, creation time, optional Linux boot ID, owner PID, canonical parent/root
identities, device, inode, and the running PGID when applicable.

Normal cleanup first waits for the owned process group to quiesce. It writes
and syncs a parent-side 0600 cleanup journal before rename. The journal records
the complete allocation marker and exact nonce-derived quarantine path; it is
data for recovery, not another cleanup owner. Cleanup proves both the source
and nonce-derived opaque quarantine target are immediate children of the
already validated canonical parent before rename: the target's
`dirname` equals that parent, its relative path is one non-empty non-traversal
component, and its basename is the exact nonce-derived opaque name. It refuses
an existing quarantine target and renames the exact root only then.
It then requires a non-symlink directory with the recorded device/inode before
recursive removal. The journal is unlinked only after both the original and
quarantine locations are absent. The rename gives concurrent cleaners one
winner and the identity recheck refuses path swaps. Recursive removal must
unlink a symlink inside the root without traversing it.

Owner startup reads immediate dirent names without candidate stat or marker
fanout, sorts them lexically, then rotates after a durable same-UID 0600
parent-side scan cursor. The cursor is scheduling metadata only: a malformed or
missing cursor starts at the lexical head, and it never authorizes deletion.
Recovery deeply inspects sequentially and has fixed limits for inspected
entries, journal/rename state transitions, and recursive-removal attempts. It
durably advances the cursor after the final inspected name. Limit exhaustion
emits `recovery-budget-exhausted` and defers work; it never blocks a new
allocation. These limits bound candidate and concurrent recovery work, not the
recursive time or bytes of an individual permitted removal.

A `run-*` candidate is removable only when it is old enough to be past the
allocation grace interval; is a same-UID non-symlink 0700 directory; has a
parseable known-state marker with a strict nonce whose path/device/inode agree;
and has a demonstrably absent recorded owner. `allocated` may meet that common
predicate. `launching` is retained as `launch-unknown`. A `running` candidate
also requires a positive PGID and a syntactically valid lowercase Linux UUID
boot ID. Regardless of whether that UUID matches the live host,
`kill(-pgid, 0)` must prove the recorded group absent before deletion; a live
group is retained as `group-live` to protect against PID/PGID reuse. An
unavailable live boot ID retains `unverifiable-boot` after that group proof.
Recovery never signals a recorded PID or PGID.

A validated journal may resume its exact original `run-*` or exact
`.quarantine-<nonce>` device/inode target after the same owner and group proof,
then remove the journal only after both locations are absent. A pre-journal
quarantine can use its intact embedded marker only with those equivalent
proofs. A partly deleted quarantine without either capability is retained as
`quarantine-no-capability`. Any other ambiguity (fresh, live or reused
identity, malformed boot ID, wrong owner or mode, symlink, foreign, unknown
state, or identity mismatch) is retained with a stable reason code.

SIGKILL and host failure leave an orphan until a later owner recovery or a
bounded host/CI cleaner. A cleaner may target only this dedicated parent. It
must never use age alone to delete an owner-dead `launching` root.

## Command and signal semantics

On POSIX the owner parses only `-- <command> <args...>` and spawns that exact
argv with `shell: false`, unchanged cwd, inherited stdio, and `detached: true`.
The direct child PID is the owned PGID. Source-controlled compound scripts may
explicitly use `bash -c`; the wrapper never parses or quotes a command string.
It waits for `close`, not only `exit`, so stdout/stderr drain.

Normal child codes, including voluntary 130 and 143, return unchanged to a
Node parent as `{ code, signal: null }`. If a child dies by signal, the owner
cleans, removes its handler, restores default handling, and signals itself with
that same signal. It must not substitute `process.exit(128 + signal)`.

The outer owner installs SIGINT/SIGTERM listeners before recovery or
allocation. The listener only latches the first signal until a validated group
exists. A signal during recovery prevents allocation; a signal during
allocation cleans the closed allocated capability and prevents spawn, including
when a pre-launch hook then throws. A signal after the durable `launching`
transition but before spawn returns the marker to `allocated` before cleanup.
If the launching transition itself may have reached disk and then fails, the
root remains fail-closed. On owner SIGINT or SIGTERM after `running`, the
first signal is forwarded once to the validated negative PGID. The owner waits a bounded grace period, escalates
remaining group members to SIGKILL, cleans the root, then self-signals with
the initiating signal. After a normal direct-child close, lingering members of
the owned group are terminated before deletion. The initiating signal remains
the observable result even when escalation was needed. The owner must not call
`process.exit()` before streams and cleanup drain.

Allocation failure prevents child spawn and returns infrastructure code 74. If
the child succeeded but cleanup cannot prove removal, the owner returns 74; if
the child already failed or was signaled, its result remains dominant and a
deterministic cleanup diagnostic is emitted. The accounting authority keeps its
aggregate exit behavior and exact leaf receipt fields; wrapping must not make
a signaled leaf signal the authority or introduce fail-fast behavior.

## Routing and hard-coded writers

`pnpm test:scratch -- <argv...>` is the supported ad hoc boundary. Root
test/accounting aliases, supported host-writing smoke/verification aliases,
public package test aliases (including RI's special modes), and the remaining
raw workflow test commands route through it exactly once. The RI root alias
delegates to the RI package front door and therefore creates no second owner.
Existing authority and secondary runners keep their proven environment
propagation; they are not wrapped per leaf.

The initial routing set is deliberately explicit: root aliases
`docker:first-boot:test`, `docker:core:headed-oracle:test`,
`railway:template:test`, `railway:ghcr-public:test`, `railway:env-check:test`,
`railway:mcp-query-smoke:test`, `read-surface:smoke:test`,
`flyio:env:check:test`, `stream:parity:oracle`, `agent-skill:boundary-check`,
`openspec:archive-check:test`, `public-tree:hygiene-check:test`,
`release:policy-check:test`, `release:matrix:test`,
`release:dist-tag-check:test`, `owner-journey:acceptance:test`,
`console:health-surface-gate:test`, `ci:mode:test`,
`test-accounting:check`, `test-accounting:test`, and
`ri-suite:completion:test`; supported host-writing aliases
`docker:reference:verify`, `docker:smoke`,
`docker:neko:dynamic-allocator-smoke`,
`docker:core:amazon-routes-smoke`, `docker:stream-smoke`,
`railway:sqlite-restart-smoke`, `railway:mcp-query-smoke`,
`read-surface:smoke`, `cli:connect-smoke`, and `stream:no-human-verify`; test
front doors in `reference-implementation/package.json`, `packages/cli`,
`packages/local-collector`, `packages/read-core`, `packages/mcp-server`,
`packages/polyfill-connectors`, `packages/display`,
`packages/reference-contract`, `packages/operator-ui`,
`packages/pdpp-brand-react`, `apps/console`, and `apps/site`; and raw test
commands in `.github/workflows/reference-implementation.yml`,
`openspec-archive-check.yml`, `remote-surface.yml`, `docker-images.yml`, and
`reference-stack-project-safety.yml`. The lifecycle oracle workflow directly
runs its tests without an inherited owner so it can prove owner behavior; the
canonical-entrypoint ratchet permits only that exact reviewed command.
`packages/list-envelope` is
authority-only and is not given a new package test front door.

The routing ratchet derives its inventory from every repository package
manifest and every GitHub workflow YAML `run` block, rather than maintaining a
fixed alias or workflow list. It recognizes package test front doors and direct
test runner commands, then requires each covered entrypoint to own, delegate
to, or use a narrowly reviewed exception. It rejects a newly added raw CI
`node --test`, `tsx *.test.ts`, or test-shell invocation without changing the
ratchet inventory.

The lifecycle workflow runs when any tracked executable source extension that
the host-write ratchet scans changes (`.cjs`, `.cts`, `.js`, `.jsx`, `.mjs`,
`.mts`, `.sh`, `.ts`, or `.tsx`), or when a package manifest, workflow, lockfile,
or the scoped configuration changes. It runs a strict TypeScript project for
all `scripts/test-scratch/*.ts` and its fixtures. This is an intentionally
scoped gate for the lifecycle and canonical-ratchet implementation; it does not
claim the unrelated repository-wide TypeScript baseline is green.

Only confirmed executable host writers present in this worktree migrate: the RI
browser ledger direct `/tmp` allocation and the listed n.eko
network/dynamic-allocator bind-mounted profile roots plus their path-contract
tests. The exact files are
`reference-implementation/test/browser-surface-replacement-ledger-store.test.ts`;
`scripts/docker-neko-network-durability-smoke.sh`,
`scripts/docker-neko-network-migration-smoke.sh`,
`scripts/docker-neko-dynamic-allocator-smoke-config.mjs`, and
`scripts/docker-neko-dynamic-allocator-smoke.sh`; and their
`reference-implementation/test/reference-stack-network-durability.test.ts`
and `scripts/docker-neko-dynamic-allocator-smoke.test.mjs` path-contract
tests. The arbiter's three Netflix files under
`packages/polyfill-connectors/connectors/netflix_export/` are absent from this
worktree (`rg --files` found no matching path), so this change makes no
speculative migration. The host-write ratchet derives executable source and
shell candidates from the repository, parses JavaScript/TypeScript write-call
arguments, and recognizes shell write/redirection forms rather than banning
all `/tmp` strings. Each reviewed exception is an exact file and source-pattern
with a reason. Parser fixtures, container-internal paths (including
`scripts/docker-smoke.sh`'s SQLite path), production/external roots, and the
dynamic n.eko stable cross-run flock remain narrowly allowlisted with reasons.
The flock is shared coordination state and must not move into an invocation
root or be unlinked while waiters exist.

## Verification

Independent fixture-based tests observe, rather than trust, the cleanup
implementation. They prove normal exits 0/1/42/voluntary-130; untouched
ambient temp sentinels; inner-symlink survival and root-swap refusal;
cleanup-failure result precedence; byte-exact stdout/stderr drainage;
self-signal and forwarded SIGINT/SIGTERM semantics; TERM-ignoring child and
grandchild escalation; parallel roots/nonces; nested participants and parallel
workers; and crash recovery across allocated/running/prior-boot/live/reused,
malformed, traversal/absolute/encoded nonce variants, malformed boot IDs,
wrong-UID/mode, symlink, inode-swap, foreign, and concurrent cases. They also
kill an external wrapper after `spawn()` but before `running` persistence,
exercise SIGTERM before recovery and before spawn, resume cleanup after journal
creation and after a renamed marker is deleted, and prove bounded recovery
defers inventory and recursive removal without preventing the next owner.

Integration coverage runs the boundary through authority, RI, secondary
runners, shell and Python leaves, representative affected package/smoke
aliases, and the accounting command. Static routing and literal ratchets run
after targeted migrations, including injected package, workflow, and host-write
bypasses that the repository-derived inventory must catch. Formatting/typecheck
and affected suites provide the final accounting gate.
