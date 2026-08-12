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
- Claiming cleanup after SIGKILL, OOM, host failure, detached descendants,
  containers/services, hostile same-UID mutation, or Windows process-tree
  parity.

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

## Allocation, cleanup, and recovery

Allocation records a capability, not a caller-controlled path:
`{ canonicalParent, root, dev, ino, nonce }`. The root is a same-UID,
non-symlink 0700 `mkdtemp` child. Its marker is written exclusively with mode
0600 and atomically transitions from `allocated` to `running` once the child
PGID exists. It includes schema, nonce, creation time, optional Linux boot ID,
owner PID, canonical parent/root identities, device, inode, and the running
PGID when applicable.

Normal cleanup first waits for the owned process group to quiesce. It renames
the exact root to an opaque quarantine sibling in the already validated parent,
then requires a non-symlink directory with the recorded device/inode before
recursive removal. The rename gives concurrent cleaners one winner and the
identity recheck refuses path swaps. Recursive removal must unlink a symlink
inside the root without traversing it.

Owner startup performs opportunistic recovery only over immediate `run-*`
children of the dedicated validated parent. A candidate is removable only when
it is old enough to be past the allocation/handoff grace interval; is a
same-UID non-symlink 0700 directory; has a parseable known-state marker whose
nonce/path/device/inode agree; and has a demonstrably absent recorded owner.
For a same-boot `running` marker, `kill(-pgid, 0)` must also prove the group is
absent. Recovery never signals a recorded PID or PGID. Any ambiguity (fresh,
live or reused identity, prior-platform ambiguity, malformed, wrong owner or
mode, symlink, foreign, unknown state, or identity mismatch) is retained with
a stable reason code. Verified stale cleanup uses the same quarantine path.

SIGKILL and host failure leave an orphan until a later owner recovery or a
bounded host/CI age cleaner. Such a cleaner may target only this dedicated
parent and must have a TTL greater than the supported test duration plus
margin.

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

On owner SIGINT or SIGTERM, the first signal is latched and forwarded once to
the validated negative PGID. The owner waits a bounded grace period, escalates
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
`reference-stack-project-safety.yml`. `packages/list-envelope` is
authority-only and is not given a new package test front door.

The routing ratchet enumerates canonical root/package/workflow entrypoints and
requires every one to own, delegate to, or declare a reviewed exemption from
the boundary. It rejects new raw CI `node --test`, `tsx *.test.ts`, and test
shell invocations that bypass it.

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
speculative migration. The host-write ratchet classifies executable writes rather than banning
all `/tmp` strings. Parser fixtures, container-internal paths (including
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
malformed, wrong-UID/mode, symlink, inode-swap, foreign, and concurrent cases.

Integration coverage runs the boundary through authority, RI, secondary
runners, shell and Python leaves, representative affected package/smoke
aliases, and the accounting command. Static routing and literal ratchets run
after targeted migrations. Formatting/typecheck and affected suites provide
the final accounting gate.
