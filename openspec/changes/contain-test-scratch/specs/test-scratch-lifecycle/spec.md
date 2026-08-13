## ADDED Requirements

### Requirement: Canonical test commands SHALL have one verified invocation scratch owner

Every canonical PDPP test or supported host-writing verification entrypoint
SHALL execute under exactly one outer test-scratch owner. The owner SHALL
allocate a non-symlink same-UID 0700 `run-*` directory below a dedicated,
validated same-UID 0700 parent; it SHALL NOT use ambient `TMPDIR`, `TMP`,
`TEMP`, `/tmp`, a workspace, or a caller-controlled path as its deletion root.
It SHALL export `TMPDIR`, `TMP`, `TEMP`, `TEST_TMPDIR`,
`PDPP_TEST_SCRATCH_ROOT`, `PDPP_TEST_SCRATCH_SCHEMA`,
`PDPP_TEST_SCRATCH_MARKER`, `PDPP_TEST_SCRATCH_NONCE`, and
`PDPP_TEST_SCRATCH_OWNER_PID` to the exact child command. Existing test-local
cleanup remains valid and SHALL NOT require a repository-wide migration.

#### Scenario: An ordinary descendant allocates temporary state

**WHEN** a canonical command's Node, shell, Python, package-manager, worker,
or grandchild descendant uses the inherited temporary-directory environment
**THEN** it SHALL observe the owner's one invocation root
**AND** its ordinary temporary state SHALL be placed under that root
**AND** independent outer invocations SHALL use distinct root identities.

#### Scenario: A nested wrapper receives valid inherited ownership metadata

**WHEN** a nested wrapper validates the inherited marker, nonce, and exact root
identity
**THEN** it SHALL participate in that owner boundary
**AND** it SHALL NOT allocate another root, process group, or cleanup right.

#### Scenario: A raw developer command bypasses the owner

**WHEN** a developer directly runs `node --test`, `tsx`, or a shell command
without `pnpm test:scratch -- <command> [args...]` or a routed canonical alias
**THEN** that command SHALL be documented as outside this containment guarantee.

### Requirement: Scratch ownership cleanup and recovery SHALL fail closed

The owner SHALL record an exclusively-created 0600 marker containing its known
schema state, a nonce of exactly 48 lowercase ASCII hexadecimal characters,
parent/root identity, device, inode, creation time, owner PID, and running
PGID when available. It SHALL durably transition `allocated` to `launching`
before calling `spawn()`, and SHALL durably transition `launching` to `running`
with the direct-child PID as PGID immediately after successful spawn. Marker
writes SHALL sync both the file and its parent directory. Only the live owner
MAY return `launching` to `allocated` after proving spawn was not attempted.

Normal cleanup and recovery SHALL act only through the allocation capability.
Before a quarantine rename, cleanup SHALL write and sync a same-UID,
non-symlink 0600 parent-side journal containing the full marker capability and
the exact nonce-derived quarantine path. The journal SHALL NOT start a process
or grant an independent cleanup owner. Cleanup SHALL prove both the source and
nonce-derived quarantine target are immediate children of the validated
canonical parent: the target `dirname` SHALL equal that parent, its relative
path SHALL be one non-empty non-traversal component, and its basename SHALL be
the exact nonce-derived quarantine name. It SHALL refuse an existing quarantine
target, revalidate non-symlink directory device/inode identity, recursively
remove only that entry, and unlink the journal only after both original and
quarantine locations are absent. Recursive removal SHALL unlink, not traverse,
a symlink inside the owned root. POSIX separators, Windows separators, drive/
UNC-looking values, nested names, absolute-looking text, encoded separators,
and Unicode slash variants in a marker nonce SHALL be malformed and retained.

Startup recovery SHALL read all immediate dirent names without candidate stat
or marker fanout, sort those names lexically, and rotate the scan strictly
after a durable same-UID non-symlink 0600 parent-side cursor. The cursor SHALL
be scheduling metadata only and SHALL NOT authorize deletion; a missing,
malformed, unreadable, or wrong-mode cursor SHALL safely restart at the lexical
head. Recovery SHALL deeply inspect only a fixed bound of the rotated names,
with concurrent candidate work fixed at one, and SHALL durably advance the
cursor after the last inspected name. It SHALL use fixed bounds for inspected
entries, journal/rename transitions, and recursive-removal attempts; it SHALL
emit `recovery-budget-exhausted` and defer remaining work when any bound is
reached. A bound SHALL NOT prevent a new owner allocation. The bounds SHALL NOT
claim a bound on recursive deletion time or bytes for an individual permitted
removal.

Recovery SHALL remove a `run-*` candidate only when it is past the grace
interval, same-UID, non-symlink, 0700, has a parseable known marker with a
strict nonce agreeing on identity, and has a demonstrably absent owner.
`allocated` may satisfy that predicate. An owner-dead `launching` candidate
SHALL remain with `launch-unknown`; recovery SHALL NOT use age, owner absence,
or later group absence as proof to remove it. A `running` candidate SHALL have
a positive PGID and a syntactically valid lowercase Linux UUID boot ID.
Regardless of whether its UUID matches the live host, recovery SHALL require
`kill(-pgid, 0)` to prove the recorded group absent before deletion; a live
group SHALL remain with `group-live` to protect against PID/PGID reuse. An
unavailable live boot ID SHALL retain `unverifiable-boot` after the group proof.
Recovery SHALL NOT signal marker PIDs or PGIDs. A valid journal MAY resume only its exact recorded `run-*` or
`.quarantine-*` device/inode target after the same owner/group proof. An intact
pre-journal quarantine marker MAY provide the equivalent capability; a partial
quarantine with neither valid capability SHALL remain with
`quarantine-no-capability`. All unverifiable candidates SHALL remain with
stable reason codes.

#### Scenario: Cleanup receives a swapped root

**WHEN** the recorded root no longer has the recorded non-symlink directory
identity at cleanup time
**THEN** cleanup SHALL refuse removal with a deterministic diagnostic
**AND** it SHALL NOT delete the replacement or any outside path.

#### Scenario: A valid stale root is recovered

**WHEN** a later owner finds a verified old root whose recorded owner and,
when required, process group are absent
**THEN** it SHALL quarantine and remove only that root
**AND** malformed, live, wrong-owner, wrong-mode, foreign, symlink, or
identity-mismatched entries SHALL remain.

#### Scenario: SIGKILL interrupts the spawn-to-running handoff

**WHEN** an external SIGKILL terminates the owner after the durable `launching`
transition and after `spawn()` returns, but before `running` persistence
**THEN** a later recovery SHALL retain the root with `launch-unknown`
**AND** it SHALL retain that root even after the child group later becomes absent.

#### Scenario: Cleanup crashes after journal persistence or quarantine rename

**WHEN** cleanup is interrupted after its journal sync or after rename while
the embedded marker is partly deleted
**THEN** recovery SHALL use the journal to validate and remove only its exact
recorded device/inode target
**AND** it SHALL remove the journal only after the target is absent.

#### Scenario: A recovery budget is exhausted

**WHEN** the dedicated parent contains more recovery candidates than a fixed
startup limit permits
**THEN** recovery SHALL emit `recovery-budget-exhausted`, defer remaining work,
and permit the new outer owner to allocate its own root.

#### Scenario: A stale candidate is beyond the first recovery page

**WHEN** lexically earlier entries consume the current inspection budget
**THEN** the durable non-authoritative cursor SHALL advance after that page
**AND** a later invocation SHALL rotate past those entries and inspect the
verified stale candidate without increasing recovery concurrency.

#### Scenario: Hard termination interrupts an owner

**WHEN** the owner is terminated by SIGKILL, OOM, or host failure
**THEN** the implementation SHALL NOT claim immediate cleanup
**AND** a later owner or bounded dedicated host/CI cleaner MAY recover only a
verified stale root.

### Requirement: The owner SHALL preserve exact POSIX command result semantics

On POSIX the owner SHALL parse only `-- <command> <args...>`, spawn that exact
argv with `shell: false`, unchanged cwd, inherited stdio, and one detached
process group, and wait for the child `close` event before final result
handling. It SHALL not add normal-path stdout/stderr output or change
concurrency/output ordering.

Process-group membership SHALL be the containment contract for descendants.
The owner SHALL NOT claim a `/proc` ancestry proof or cgroup containment, and
an intentionally detached `setsid` descendant SHALL be outside the guarantee:
it is neither proven absent nor removed by this lifecycle.

A normal child code, including voluntary 130 or 143, SHALL remain a normal
code. A signal-terminated child or wrapper SHALL be reported by self-signaling
with the same signal after bounded group shutdown and cleanup; it SHALL NOT be
converted to `128 + signal`. The outer owner SHALL install and latch
SIGINT/SIGTERM before recovery or allocation. A latched signal during recovery
SHALL prevent allocation; a latched signal during allocation SHALL clean the
verified allocation and SHALL prevent spawn. SIGINT/SIGTERM to the owner after
`running` SHALL be forwarded once to the negative owned PGID, then remaining
members MAY be SIGKILLed after the bounded grace period while the original
initiating signal remains the result. A successful child whose root cannot be
proven removed SHALL return infrastructure code 74; a failed or signaled child
result remains dominant.

#### Scenario: A child exits voluntarily with 130

**WHEN** the child exits normally with code 130
**THEN** the observing Node parent SHALL receive `{ code: 130, signal: null }`
after cleanup succeeds.

#### Scenario: The owner receives SIGTERM while descendants are running

**WHEN** the owner receives SIGTERM after a child and grandchild are ready
**THEN** it SHALL forward SIGTERM to the owned group, wait and escalate only as
needed, remove its root, and self-signal with SIGTERM
**AND** the observing parent SHALL receive `{ code: null, signal: 'SIGTERM' }`.

#### Scenario: A descendant deliberately leaves the process group

**WHEN** a descendant invokes `setsid` and leaves the owned process group
**THEN** the owner SHALL only terminate and verify the original negative PGID
**AND** it SHALL NOT claim that the detached descendant was removed.

#### Scenario: The owner receives SIGTERM before allocation

**WHEN** the outer owner receives SIGTERM while recovering or while allocating
its root
**THEN** it SHALL not spawn a child
**AND** after any verified allocated root is cleaned, the observing parent SHALL
receive `{ code: null, signal: 'SIGTERM' }`.

### Requirement: Canonical routing and host-write checks SHALL remain explicit

The repository SHALL derive its inventory from repository package manifests and
GitHub workflow YAML `run` blocks. Each covered test or verification entrypoint
SHALL be owner-routed, a reviewed delegate to an owner-routed command, or a
documented reviewed exemption. A new raw CI `node --test`, `tsx` test, or test
shell invocation that does not meet one of those conditions SHALL fail the
static gate without an inventory edit.

The repository SHALL derive executable source and shell host-writer candidates
from the repository. Its check SHALL parse JavaScript/TypeScript write-call
arguments and recognize shell write/redirection forms, distinguish live writes
from fixtures and reads, and retain narrow exact-file/source-pattern reasons
for reviewed container paths, parser/path fixtures, production/external roots,
and the stable shared dynamic n.eko flock. The flock SHALL NOT be moved into
per-invocation scratch or unlinked while waiters can exist.

The lifecycle CI workflow SHALL trigger when any source extension scanned by
the host-write ratchet changes (`.cjs`, `.cts`, `.js`, `.jsx`, `.mjs`, `.mts`,
`.sh`, `.ts`, or `.tsx`), or when a package manifest, workflow, lockfile, or
its scoped TypeScript configuration changes. It SHALL run strict TypeScript for
every `scripts/test-scratch/*.ts` lifecycle/canonical-gate source and fixture.
That scoped result SHALL NOT claim the unrelated repository-wide TypeScript
baseline is green.

When test accounting runs under an outer scratch owner, its inherited-owner
batch SHALL NOT include the lifecycle or canonical-entrypoint oracle files.
Those files SHALL have exactly one dedicated direct accounting-suite owner. The
suite SHALL remove every known `PDPP_TEST_SCRATCH_*` capability variable through
portable Node environment construction before its leaf starts. A manifest that
declares only a partial capability removal list SHALL fail validation.

#### Scenario: A canonical workflow adds a raw Node test command

**WHEN** a workflow adds a raw `node --test` invocation without owner routing
or a reviewed exemption
**THEN** the canonical-entrypoint gate SHALL fail.

#### Scenario: A newly added package test front door bypasses the owner

**WHEN** a newly discovered package manifest adds a direct test runner without
owner routing or a reviewed exemption
**THEN** the canonical-entrypoint gate SHALL fail without editing its inventory.

#### Scenario: A reviewed container path remains literal `/tmp`

**WHEN** a reviewed literal denotes a container-internal path rather than an
executable host scratch write
**THEN** the host-write gate SHALL retain it only through its narrow documented
exception
**AND** it SHALL NOT use that exception to permit a new host writer.

#### Scenario: A newly added executable host writer uses literal `/tmp`

**WHEN** a newly discovered executable source or shell file writes to literal
`/tmp` without an exact reviewed exception
**THEN** the host-write gate SHALL fail without editing its inventory.

#### Scenario: A scanned host-writer source changes outside test-scratch

**WHEN** an executable source or shell file under any repository location uses
an extension scanned by the host-write ratchet
**THEN** the lifecycle CI workflow SHALL run the canonical-entrypoint gate.

#### Scenario: Test accounting runs the lifecycle oracle below an outer owner

**WHEN** an accounting authority receives inherited scratch capability metadata
and schedules the lifecycle or canonical-entrypoint oracle
**THEN** the dedicated suite SHALL remove every capability variable before its
leaf starts
**AND** the oracle SHALL allocate its own outer owner rather than participate
in the authority root
**AND** the manifest inventory SHALL assign each oracle file exactly one owner.

#### Scenario: The lifecycle suite omits the capability scrub

**WHEN** a manifest owns either lifecycle oracle file but omits
`environment_unset`
**THEN** manifest validation SHALL fail before any leaf starts.
