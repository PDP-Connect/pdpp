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
- A reusable execution coordinator, sandbox, or automatic crash-recovery system.
- Product-host portability claims based on this developer-only experiment.

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

`killed`, `survived`, and `inconclusive` are computed projections, never caller fields. The projection is total and conservative:

| Observations | Projection | Additional signal |
| --- | --- | --- |
| Any clean baseline, materialization, protocol, authority, artifact-retention, or cleanup failure | `inconclusive` | Preserve the failing axis. |
| Timeout, signal, resource stop, malformed or partial output, or unexplained nondeterminism | `inconclusive` | Preserve the exact failure; never infer a kill. |
| Validated `not_exercised` reachability | `inconclusive` | Send to independent triage; do not count it as survived. |
| Focused mutant check fails for a mutation-attributable test assertion | `killed` | The complete mutant backstop may be `not_run_focused_kill`. |
| Focused mutant check passes and the complete mutant backstop fails for a mutation-attributable test assertion | `killed` | Record a selector miss and stop selector promotion. |
| Focused mutant check and complete mutant backstop both pass | `survived` | Require independent triage before exclusion from actionable results. |

A failure is mutation-attributable only when the digest-identical clean command passed and the mutant command produced a recognized owning-test assertion failure, not an infrastructure, protocol, accounting, cleanup, or resource error. Version one performs no automatic retries. A reviewer may request a new attempt; contradictory valid attempts with the same trial key make the aggregate trial inconclusive. `not_exercised` requires adapter-supplied validated reachability evidence; otherwise reachability is `unknown`.

### 4. Digests provide integrity binding, not authenticity

RFC 8785 JSON canonicalization, schema version, canonicalization version, and SHA-256 are explicit. A trial key binds the intent digest, repository tree, adapter version, policy version, and mutation identity. Each run gets a random attempt ID, so replay has stable identity but different observations.

Before spawn, the adapter-specific runner writes an issued attempt marker in a verifier-owned, disk-backed evidence directory outside the disposable workspace. Complete receipts publish atomically only after structured output validation, retained-artifact validation, and cleanup evidence. The writer fsyncs each completed file and its parent directory after publication. Interrupted markers remain incomplete and are discovered at next start.

The experiment does not claim automatic process recovery or power-loss-proof containment. Before every run it scans its evidence and configured workspace roots. Any incomplete or corrupt marker, unexpected workspace, or prior cleanup failure blocks execution for explicit operator review. Age, PID liveness, and a successful `finally` block never authorize automatic reclamation. Retirement requires a separate append-only recovery receipt that records the operator claim, process and workspace observations, disposition, and retained evidence; it does not convert the interrupted attempt into a completed one.

Anyone controlling the host can rewrite records and recompute an unkeyed digest. Version one therefore claims internal consistency and tamper evidence relative to a separately retained digest, not issuer authenticity. Authenticated provenance would require a later CI signature or platform attestation.

### 5. The migration oracle is the evidence pilot

The first slice adds a structured JSON mode to `scripts/test-migration/mutation-oracle.ts`. Legacy and structured modes must agree on every named case, catching check, hole, positive control, and rollback result. The source checkout must remain unchanged.

The adapter-specific runner accepts only `test-migration-oracle/v1`; it derives the command and allowlisted environment. It bounds its direct structured-output capture, applies a finite wall deadline, records partial/crash states honestly, and never interprets missing output as success. These are adapter-local protections, not a claim that the runner survives its own crash or contains hostile descendants. It does not claim focused selection, test-accounting authority, or domain value.

### 6. GroupMe is the real-domain calibration pilot

The pilot uses the existing hermetic GroupMe cursor/frontier tests as focused adapter evidence. It creates a fresh one-commit mutant descendant for each trusted operator. The clean complete `polyfill-connectors` suite runs through the unchanged test-accounting authority before any mutant is interpreted. The mutant complete suite runs for every focused survivor; after a focused kill, policy may omit it only by recording `not_run_focused_kill`.

Before a disposable workspace is removed, the verifier copies the complete validated accounting bundle—authority record, transcript, completion record, receipt, and required closure or manifest identity—into its bounded evidence directory. It validates the copied bundle there and records each relative location, size, and digest in the attempt receipt. A digest without retained, revalidatable bytes is invalid evidence. Copy, validation, retention-budget, or publication failure makes the attempt inconclusive and quarantines its workspace.

Policy declares the evidence root, maximum retained bytes, maximum attempts, and retention deadline before a batch starts. It reserves that capacity without deleting prior evidence. A completed batch remains intact through the decision memo's independent review and for at least 30 days afterward; later deletion is an explicit audited operation. The harness stops before accepting a new attempt that could exceed the declared retained-byte or attempt-count budget.

The focused clean baseline and complete clean backstop must pass before interpreting mutant evidence. Every focused survivor receives the complete mutant backstop. A focused pass plus backstop failure is a selector miss and blocks selector promotion. If a required backstop cannot complete, the attempt is inconclusive.

A clean focused baseline and clean complete backstop may be reused only within one locked pilot batch, for at most two hours, while the repository tree, judge and adapter closure, effective commands, allowlisted environment, Node and dependency identities, and budgets remain digest-identical. The retained accounting bundle must still revalidate before every reference. The batch ends on any tree, policy, environment, dependency, or budget change, any missing retained byte, or the first unexplained failure. The next batch runs fresh clean evidence. Reuse changes neither the killed/survived denominator nor the raw count of clean executions; attempt receipts bind the exact baseline digest they used.

The source and judge closures are separate. Operators can change only predeclared production ranges in GroupMe's implementation. Tests, policy, runner, manifest, lockfile, and receipt validator remain immutable and are digest-bound.

### 7. Workspaces are one-shot source isolation, not sandboxes

Domain attempts use a configured disk-backed root with free-space preflight. Each attempt gets an independent local clone made without hard links, a fresh dependency tree, and a clean committed mutant descendant. The clone does not share a Git common directory with the source checkout. All writable attempt state—including `HOME`, `TMPDIR`, XDG directories, pnpm store and virtual store, test temporary files, and test-accounting run files—resolves beneath the attempt root. The evidence directory is the only retained writable path and is outside that root.

Policy records the repository-pinned Node `v25.8.2`, the actual Node executable digest, repository-pinned `pnpm@10.33.0`, the actual pnpm executable and version, lockfile digest, and materialization command. Dependencies are materialized offline and frozen from the lockfile, with lifecycle scripts disabled for this pure TypeScript pilot. The offline package source is read-only and digest-inventoried; pnpm uses copy import semantics into the attempt-local store and dependency tree rather than links to mutable host content. A preflight runs the exact clean focused and complete commands with this layout before the batch begins. If lifecycle suppression or local materialization cannot satisfy the pilot, execution stops and the design is reviewed rather than silently sharing mutable output.

Successful workspaces are deleted only after required evidence has been copied and revalidated. The external verifier confirms deletion, then publishes the completed attempt receipt. Interrupted or cleanup-failed workspaces are quarantined and never reused. A later run reports them and refuses automatic recovery. The operator must independently establish that no related process remains before explicitly retiring an incomplete marker. This is source and writable-state isolation for trusted repository code; it is not a sandbox and does not claim containment after verifier death.

The resource contract is deliberately narrow:

| Resource | Mechanism | Enforcement and observation | Receipt projection |
| --- | --- | --- | --- |
| Trial count | Repository policy counter | Refuse a new trial after the declared count | No attempt is created. |
| Wall time | Adapter-local deadline and owning-process-group termination | Stop the group when the deadline fires; verify no selected-command process remains; record deadline, signal, and cleanup observation | `inconclusive` |
| Direct structured output | Streaming byte counter before buffering | Stop the adapter when its declared byte cap is crossed; retain a bounded prefix and byte count | `inconclusive` |
| Test-accounting transcript | Unchanged authority plus trusted hermetic command | Observe and record size; no hard byte-cap claim until the authority gains one in a separate change | Over-budget is `inconclusive` and stops the batch. |
| Workspace bytes | Free-space preflight plus periodic observation | Stop and quarantine after the soft threshold; overshoot remains possible | `inconclusive` |
| CPU, memory, and task count | Host observations only | Record peaks when available; no throttle, quota, or kill guarantee | Over-budget is `inconclusive` and stops the batch. |
| Cleanup | Finite verifier wait plus filesystem/process observations | Failure quarantines and blocks the next run | `inconclusive` |

Initial policy permits one trusted command at a time, two or three domain operators, and 10 wall-clock minutes for the declared pilot batch. Environment construction starts empty and admits only policy-listed non-secret values plus the isolated writable paths. A credential-sentinel test proves ambient values are absent. Live credentials, personal data, third-party network, stateful browsers, Docker sockets, and shared production-like databases are forbidden by policy; because version one is not a sandbox, the adapter preflight must also prove that the selected commands need none of them. This experiment is verified only on its declared Linux developer-host profile. No result changes or narrows PDPP's heterogeneous product-host support contract.

### 8. The decision gate precedes shared infrastructure

The pilot predefines valid-trial denominators and reports raw counts for execution axes, projections, selector misses, triage dispositions, runtime, output/workspace size, cleanup, and reviewer minutes. The valid-result denominator is exactly `killed + survived`; inconclusive, invalid, and not-run attempts remain visible as separate raw counts and never enter that denominator. Setup time is reported separately.

Stop or narrow immediately on a cleanup failure, abandoned process, unexplained selector miss, authority/receipt mismatch, or evidence corruption. Stop generalization if setup consumes most runtime, review exceeds five minutes per disputed attempt, most operators are invalid/trivial, no useful risk evidence appears within the two-or-three-operator/10-minute batch, or the adapters do not expose repeated policy/evidence logic.

Continue only if evidence is interpretable, costs are acceptable, there are no unexplained selector or cleanup failures, and a proposed shared module would hide substantial repeated invariants across both adapters. Any coordinator, generic executor, Stryker experiment, CI lane, or sandbox is a new reviewed OpenSpec change.

## Risks / Trade-offs

- **The narrow slices may not justify a framework** → treat stopping with two useful purpose-fit adapters as success.
- **Local evidence lacks authenticated issuer identity** → state the trust boundary and preserve external attestation as a separate future capability.
- **Full connector backstops may dominate runtime** → measure setup and execution separately; stop rather than weaken the mandatory calibration backstop.
- **A trusted mutant can still affect ambient host state accidentally** → isolate writable paths, constrain operators and environment, use hermetic tests, run sequentially, and stop on any unexpected effect; never call the clone a sandbox.
- **Offline dependency materialization may fail** → refuse the attempt and review the dependency strategy; do not share mutable outputs silently.
- **Version-one evidence is calibrated on one Linux developer profile** → record that profile and make no inference about PDPP product-host support.
- **Small samples cannot prove selector completeness** → report raw counts and treat any observed miss as disqualifying, without claiming zero misses proves completeness.

## Migration Plan

1. Land this revised design only after a second independent architecture review returns LAND.
2. Add structured evidence to the existing migration oracle and validate it without generic execution infrastructure.
3. Run the trusted GroupMe cursor/frontier pilot under mandatory clean and mutant backstops.
4. Publish a continue, narrow, or stop decision memo. Do not implement shared infrastructure from this change.

Rollback removes structured output and pilot artifacts while preserving both existing test suites and their legacy entry points.
