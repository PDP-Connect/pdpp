## Context

The tracked census includes 1,213 test-like paths. Existing runners have
independent globs and lists. The authority must own execution evidence, rather
than verify receipt-shaped JSON after a runner has finished.

## Goals and non-goals

Goals are complete discovery, verifier-issued execution evidence, explicit
profile skips, and stale-task invalidation. This change does not choose a test
framework, convert tests to TypeScript, change product behavior, or require live
services for an optional profile.

## Decisions

- Derive tracked paths with `git ls-files`, classify supported test suffixes, and
  keep every exclusion named, owned, profiled, and expiring.
- The authority issues a single-use run ID and nonce with an expiry. Before it
  spawns a child, it binds the integration base, current SHA, complete tracked
  source tree, manifest, suite/profile, argv/cwd, and selected files. It owns the
  transcript, completion, receipt, and verification ledger in Git-private
  state; callers cannot select an authority directory.
- Children emit one structured result for their issued selection. The result has
  assertion, pass, failure, skip, reason, and profile counts. Empty and generic
  skip reasons are invalid. Every required suite/profile is required by default;
  optional profiles require explicit selection.
- Runtime edges resolve literal imports and subprocess arguments from tokenized
  source, not comments or substring matches. The authority's variable child
  command is resolved from its checked manifest declaration, and every manifest
  command edge is required in the packet. A generated check copies the source to
  an isolated directory, removes the output, runs the canonical generator, and
  compares recreated bytes.
- A task packet validates its exact integration base and a closure that binds
  owned and forbidden paths, resolved edges, generated artifacts, and manifest.
  A tracked packet may also validate in the one commit that directly materializes
  it from that base, avoiding an impossible self-referential commit SHA. That
  materialization commit must add or modify the declared packet and may change
  only its owned or explicitly retired paths; a later descendant is stale. Its
  Git-private atomic lease binds those same inputs; it is not a distributed lease
  service.

## Alternatives rejected

Hashing caller-written receipts, parsing concatenated TAP summaries, and using a
static task ledger cannot prove execution, child selection, or output generation.
Replacing all runners with a new framework would not close those seams.

## Acceptance checks

The unmutated focused authority and packet fixtures pass. Each reviewer
reproduction fails: invented receipt, replay, expiry, selection/count/profile
mutation, generic skip, comment-masked dynamic target, omitted manifest spawn
edge, no-output or inert-argument generator, stale base, closure/lease boundary mutation,
overlap, and escaped path. The commands are local and deterministic.
