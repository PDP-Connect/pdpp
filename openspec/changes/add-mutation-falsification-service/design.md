## Context

See `proposal.md` for motivation. PDPP's current test-migration oracle already owns a strong, self-contained lifecycle: it creates fixture repositories, applies named faults, invokes mutation-specific judges, runs a positive control, proves rollback, and disposes its fixtures. The GroupMe connector also has real mutation-killing tests for historical pagination and cursor-progress faults.

The current test-accounting authority issues receipts only for manifest-owned complete plans on clean trees. It does not authorize arbitrary focused subsets or dirty mutants. A Git worktree isolates tracked source state but does not constrain filesystem, environment, network, credentials, processes, caches, databases, or Docker access. Local hashes bind content but do not authenticate an issuer.

## Goals / Non-Goals

**Goals:**

- Make one existing oracle's evidence structured without weakening its lifecycle.
- Run one trusted real-domain pilot against the current accounting authority's actual contract.
- Separate requested intent, machine observations, derived projections, and independent triage.
- Measure whether any shared infrastructure would reduce real repeated reasoning and audit cost.

**Non-Goals:**

- A generic source-mutating executor or untrusted-code sandbox.
- Arbitrary, packet-authored, or agent-generated patches and commands.
- A new test-accounting subset authority.
- StrykerJS, CI scheduling, blocking gates, mutation scores, or test-deletion authority.
- Hard CPU or memory containment where the host cannot enforce it.

## Decisions

### 1. Version one is a trusted local evidence program, not a service

There is no daemon, queue, server, network API, or remotely supplied executable input. A repository-owned registry names the only permitted adapters and operators. Intent may request a registered risk and a stricter budget; versioned repository policy derives the effective command, working directory, environment allowlist, immutable judge closure, focused evidence, complete backstop, and host limits.

This prevents a generator from choosing its own judge or safety policy. Arbitrary and agent-generated executable mutations require a separate sandbox design that proves filesystem, network, environment, process-tree, CPU, memory, disk, and output containment.

### 2. Adapters own mutation mechanics until common structure is earned

The migration oracle remains self-contained. It gains structured output but keeps its current named cases, fixture repositories, mutation-specific judges, positive control, and rollback proof. It demonstrates evidence shape and crash honesty, not a generic executor.

The second adapter is a GroupMe cursor/frontier pilot. It uses two or three checked-in declarative operators over `packages/polyfill-connectors/connectors/groupme/index.ts`, such as reintroducing the historical page ceiling or weakening non-progress detection. The operators have exact preimages and permitted postimages; they cannot alter tests, runners, policy, or manifests.

Only after both adapters run will a decision memo identify whether they share a deep stable boundary. Until then, duplication is preferable to a shallow common executor with adapter-specific escape hatches.

### 3. Evidence uses three immutable artifact types

An **intent packet** records requested risk, base identity, adapter/operator descriptor, and requested bounds. Its canonical digest is its identifier; callers do not supply the identifier.

An **attempt receipt** records one execution's raw observations: issued random attempt ID, deterministic trial key, resolved policy, exact effective plan, environment profile, base/mutant/judge identities, bounded artifact digests and sizes, baseline/materialization/focused/backstop/reachability/cleanup axes, duration, exit or signal, and any referenced accounting receipt digests.

A **triage receipt** is append-only and binds one attempt digest. It records an independent reviewer's claimed identity, disposition, evidence, reason, and timestamp. Version one does not authenticate that identity. A different reviewer from the operator/test author is required before likely-equivalent or uninteresting evidence is excluded from reported actionable results.

`killed`, `survived`, and `inconclusive` are computed projections, never caller fields. `not_exercised` requires adapter-supplied validated reachability evidence; otherwise reachability is `unknown`. Timeout remains a timeout unless a later predeclared repeat policy supports a stronger interpretation.

### 4. Digests provide integrity binding, not authenticity

Canonical JSON, schema version, canonicalization version, and hash algorithm are explicit. A trial key binds the intent digest, repository tree, adapter version, policy version, and mutation identity. Each run gets a random attempt ID, so replay has stable identity but different observations.

Before spawn, the adapter-specific runner writes an issued attempt marker in a verifier-owned run directory. Complete receipts publish atomically only after structured output validation and cleanup evidence. Interrupted markers remain incomplete and are discovered at next start. Referenced transcripts are bounded artifacts whose digests and sizes appear in the receipt.

Anyone controlling the host can rewrite records and recompute an unkeyed digest. Version one therefore claims internal consistency and tamper evidence relative to a separately retained digest, not issuer authenticity. Authenticated provenance would require a later CI signature or platform attestation.

### 5. The migration oracle is the evidence pilot

The first slice adds a structured JSON mode to `scripts/test-migration/mutation-oracle.ts`. Legacy and structured modes must agree on every named case, catching check, hole, positive control, and rollback result. The source checkout must remain unchanged.

The adapter-specific runner accepts only `test-migration-oracle/v1`; it derives the command and allowlisted environment. It imposes hard wall-time and output-byte limits, records partial/crash states honestly, and never interprets missing output as success. It does not claim focused selection, test-accounting authority, or domain value.

### 6. GroupMe is the real-domain calibration pilot

The pilot uses the existing hermetic GroupMe cursor/frontier tests as focused adapter evidence. It creates a fresh one-commit mutant descendant for each trusted operator. The clean complete `polyfill-connectors` suite always runs through the unchanged test-accounting authority. The mutant complete suite runs for every focused survivor; after a focused kill, policy may omit it only by recording `not_run_focused_kill`. Verified accounting receipt digests are referenced rather than duplicated.

The focused clean baseline and complete clean backstop must pass before interpreting mutant evidence. Every focused survivor receives the complete mutant backstop. A focused pass plus backstop failure is a selector miss and blocks selector promotion. If a required backstop cannot complete, the attempt is inconclusive.

A clean baseline may be reused across operators only when the repository tree, judge and adapter closure, effective command, allowlisted environment, dependency identity, and budget remain digest-identical. Otherwise it must run again.

The source and judge closures are separate. Operators can change only predeclared production ranges in GroupMe's implementation. Tests, policy, runner, manifest, lockfile, and receipt validator remain immutable and are digest-bound.

### 7. Workspaces are one-shot source isolation, not sandboxes

Domain attempts use a configured disk-backed root with free-space preflight. Each attempt gets a fresh workspace and clean committed mutant descendant. Dependencies are materialized with the repository-pinned `pnpm@10.33.0`, offline and frozen from the lockfile, with lifecycle scripts disabled for this pure TypeScript pilot. If that exact materialization cannot satisfy the pilot, execution stops and the design must be reviewed rather than silently sharing mutable build output.

Successful workspaces are deleted before the completed attempt receipt is published. Interrupted or cleanup-failed workspaces are quarantined and never reused. Next-start recovery reports owned incomplete markers and quarantines before new work. This handles hard termination honestly; it does not pretend `finally` runs after power loss or `SIGKILL`.

Version one supports only Linux hosts with cgroup v2 and a usable systemd user manager. Each adapter, focused check, and authority backstop runs as a uniquely named transient systemd user service with `KillMode=control-group`, a finite `RuntimeMaxSec`, and policy-selected cgroup task, CPU, and memory limits. The initial `TasksMax` is 512, not an assumed Node file count; the clean complete backstop records peak tasks so later policy can be calibrated without invalidating the immutable command. macOS, Windows, non-cgroup-v2 Linux, and Linux without the required user-service controls fail closed in version one.

The launcher only requests a uniquely named transient service; it never starts adapter work itself. The top-level attempt wrapper begins inside the manager-owned service with no adapter descendants. It writes and fsyncs a complete claim record containing the unit name to a unique temporary file, then atomically hard-links that record to the repository-scoped active-marker path. If the link loses to an existing marker, the service exits before spawning adapter work. If it wins, the wrapper queries systemd for its actual unit, `ControlGroup`, and `InvocationID`, atomically publishes the bound record, verifies that its own process is in that control group, and only then starts the adapter.

This ordering removes the late-start race: a delayed start request can create only a service whose wrapper must win the same marker before doing work. Launcher death is harmless because systemd owns any accepted service. Recovery stops the marker-bound unit and invocation, waits for the stop job, verifies the cgroup absent or unpopulated and the unit inactive, and only then retires the marker. It never relies on a recorded child PID, so PID reuse cannot establish cleanup. An incomplete, mismatched, or unverifiable claim quarantines the attempt and blocks further mutation work until reviewed.

Initial policy permits one adapter or backstop service at a time, at most 20 domain mutants and 10 wall-clock minutes. It hard-bounds captured output and sets a 60-second cleanup deadline. The cgroup caps the complete descendant tree at 50% of available CPU, a policy-selected memory maximum, and 512 tasks, including full-suite children, threads, and grandchildren. Workspace size uses a disk-free preflight, reserved host headroom, and periodic observation. Crossing the threshold stops and quarantines the attempt, but it is explicitly not a filesystem quota and cannot promise zero overshoot or host-disk impact. Live credentials, personal data, third-party network, stateful browsers, and shared production-like databases are prohibited. Required unsupported controls cause refusal.

### 8. The decision gate precedes shared infrastructure

The pilot predefines valid-trial denominators and reports raw counts for execution axes, projections, selector misses, triage dispositions, runtime, output/workspace size, cleanup, and reviewer minutes. Setup time is reported separately.

Stop or narrow immediately on a cleanup or containment failure, an unexplained selector miss, authority/receipt mismatch, or evidence corruption. Stop generalization if setup consumes most runtime, review exceeds five minutes per disputed attempt, most operators are invalid/trivial, no useful risk evidence appears within 20 mutants/10 minutes, or the adapters do not expose repeated policy/evidence logic.

Continue only if evidence is interpretable, costs are acceptable, there are no unexplained selector or cleanup failures, and a proposed shared module would hide substantial repeated invariants across both adapters. Any coordinator, generic executor, Stryker experiment, CI lane, or sandbox is a new reviewed OpenSpec change.

## Risks / Trade-offs

- **The narrow slices may not justify a framework** → treat stopping with two useful purpose-fit adapters as success.
- **Local evidence lacks authenticated issuer identity** → state the trust boundary and preserve external attestation as a separate future capability.
- **Full connector backstops may dominate runtime** → measure setup and execution separately; stop rather than weaken the mandatory calibration backstop.
- **A trusted mutant can still affect ambient host state accidentally** → constrain paths/operators/environment, use hermetic tests, run sequentially, and never call a worktree a sandbox.
- **Offline dependency materialization may fail** → refuse the attempt and review the dependency strategy; do not share mutable outputs silently.
- **Version-one containment is Linux-specific** → fail closed elsewhere and require separate reviewed host adapters before claiming macOS or Windows support.
- **Small samples cannot prove selector completeness** → report raw counts and treat any observed miss as disqualifying, without claiming zero misses proves completeness.

## Migration Plan

1. Land this revised design only after a second independent architecture review returns LAND.
2. Add structured evidence to the existing migration oracle and validate it without generic execution infrastructure.
3. Run the trusted GroupMe cursor/frontier pilot under mandatory clean and mutant backstops.
4. Publish a continue, narrow, or stop decision memo. Do not implement shared infrastructure from this change.

Rollback removes structured output and pilot artifacts while preserving both existing test suites and their legacy entry points.
