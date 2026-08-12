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
PGID when available. Normal cleanup and recovery SHALL act only through the
allocation capability. Before a quarantine rename, they SHALL prove both the
source and nonce-derived quarantine target are immediate children of the
validated canonical parent: the target `dirname` SHALL equal that parent, its
relative path SHALL be one non-empty non-traversal component, and its basename
SHALL be the exact nonce-derived quarantine name. They SHALL refuse an existing
quarantine target, revalidate non-symlink directory device/inode identity, and
recursively remove only that entry. Recursive removal SHALL unlink, not
traverse, a symlink inside the owned root. POSIX separators, Windows
separators, drive/UNC-looking values, nested names, absolute-looking text,
encoded separators, and Unicode slash variants in a marker nonce SHALL be
malformed and retained.

Startup recovery SHALL inspect only immediate `run-*` children of the dedicated
parent. It SHALL remove a candidate only when it is past the grace interval,
same-UID, non-symlink, 0700, has a parseable known marker with a strict nonce
agreeing on identity, and has a demonstrably absent owner; a same-boot running
candidate also requires an absent process group. Recovery SHALL NOT signal marker PIDs
or PGIDs. All unverifiable candidates SHALL remain with stable reason codes.

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

A normal child code, including voluntary 130 or 143, SHALL remain a normal
code. A signal-terminated child or wrapper SHALL be reported by self-signaling
with the same signal after bounded group shutdown and cleanup; it SHALL NOT be
converted to `128 + signal`. SIGINT/SIGTERM to the owner SHALL be forwarded
once to the negative owned PGID, then remaining members MAY be SIGKILLed after
the bounded grace period while the original initiating signal remains the
result. A successful child whose root cannot be proven removed SHALL return
infrastructure code 74; a failed or signaled child result remains dominant.

#### Scenario: A child exits voluntarily with 130

**WHEN** the child exits normally with code 130
**THEN** the observing Node parent SHALL receive `{ code: 130, signal: null }`
after cleanup succeeds.

#### Scenario: The owner receives SIGTERM while descendants are running

**WHEN** the owner receives SIGTERM after a child and grandchild are ready
**THEN** it SHALL forward SIGTERM to the owned group, wait and escalate only as
needed, remove its root, and self-signal with SIGTERM
**AND** the observing parent SHALL receive `{ code: null, signal: 'SIGTERM' }`.

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
