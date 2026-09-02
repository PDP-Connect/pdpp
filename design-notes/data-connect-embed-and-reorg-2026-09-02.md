# Two moves, one seam: connectors canonical in data-connectors, the reference server moved into data-connect as a pinned dependency

**Status:** decision record, folding finished research and execution receipts into a permanent note. Written 2026-09-02. Move A and Move B are both executed on real repos, not rehearsed; several items remain genuinely open — see "What remains open" below.

## The shape of the reorg

PDPP's connector code and its Tauri-based desktop app (Data Connect / `data-connect`) started life in the same monorepo lineage as the core protocol repo (`pdpp`). Two moves separate them:

- **Move A**: make `data-connectors` (a standalone repo) the canonical home for connector source, with `pdpp` and `data-connect` consuming it rather than each carrying their own copy.
- **Move B**: move the reference server implementation (`reference-implementation/`) out of `pdpp` and into `data-connect`, so the desktop app can embed and drive it directly.

Both moves are described from the direction-setting side in `local/MOVE-B-DECISIONS-0831.md`, which records seven owner decisions made 2026-09-02 05:55 CDT by delegation ("i just want the best end state, you make the call"). The load-bearing ones for this note: the moved server's shared "contract" package stays a pinned published release inside `pdpp` rather than an auto-generated snapshot (decision 2, "D-22"); the site's sandbox pages talk to the moved server over the network rather than through a shared mini-package (decision 3); and the embedded server tab reuses the app's existing owner session via a URL-passed token "for now," with a private local address or OS credential vault flagged as a later hardening step, not a blocker (decision 6).

## Move A: connectors canonical in data-connectors — executed, mostly landed

`local/MOVE-A-CUTOVER-RECEIPT-0902.md` documents a real execution pass across two sessions on 2026-09-02, against live GitHub repos, not a rehearsal. The headline results:

- `data-connectors#41` (the main catch-up branch) merged as a genuine two-parent merge, `4683cc445`, after three separate pin-freshness bumps chased a moving `pdpp` main. 20/20 CI checks passed at merge time.
- `data-connectors#51` (an ownership-doc flip) merged as `6bdd851da`.
- `data-connectors#54` (a new "Connectors Tree Gate" CI workflow, guarding against unreviewed changes to the connector tree) merged as `d38e9aef9` — this is the workflow that closes the same class of gap that let an earlier PR (#25) slip a connector change through with zero CI.
- `pdpp#271` (a CI write-freeze guard on `packages/polyfill-connectors/connectors/**`) merged as `f6ae1a9e9`, after a real behavioral proof (a throwaway PR touching a frozen path, confirmed to fail the guard) rather than a claim.
- `pdpp#273` (a vendor tarball re-repack, needed because a pin bump upstream made the previously-vendored tarball stale) merged as `7d8a66107`.
- A companion sync PR in `data-connect` itself, `data-connect#41` (different repo, same PR number), synced three stale vendored connectors (`claude_code`, `codex`, `google_messages`) and two runtime-primitive files to match the newly-canonical `data-connectors` content, and merged as `82a45176e`.

The receipt is candid about two real mistakes made and caught during execution: a scoped-registry experiment that briefly deleted 29 connector artifact tarballs from `artifacts/` (caught via `git status`, restored, never pushed), and a pin-bump sequence that initially missed a second-order dependency (bumping a data-connect pin without accounting for an unrelated dependabot bump already merged underneath it), which was caught live in CI rather than by inference.

**What is still open on Move A**: the required-check ruleset mutation on `data-connectors` — adding "Connectors Tree Gate" to the branch protection ruleset (id `19477209`) so a red gate actually blocks merges — needs GitHub `admin` permission on the repo. The executing session's identity only has `maintain`. The exact `gh api ... --method PUT` command (with a paired revert command) is written out in full in `local/MOVE-A-CUTOVER-RECEIPT-0902.md`, ready for the owner or anyone with admin to run directly. A merge-block proof PR (`data-connectors#55`, an intentionally-broken test) is already open and waiting — it is confirmed `mergeable: MERGEABLE` today (the "before" state, with only DCO required) and should flip to blocked once the mutation lands; that follow-up check is the one piece the receipt could not close itself. This is the "admin-only ruleset PUT" referenced in project memory as the one remaining piece of Move A.

Separately, `github-pdpp`'s real re-pin to current `pdpp` main (as opposed to a same-commit dependency refresh) is flagged as still open and unattempted, a reasonable next-session target.

## Move B: the reference server moved into data-connect, live-proven end to end

`local/MOVE-B-IMPLEMENT-RECEIPT-0902.md` and the standalone runbook at `~/.tmp/move-b-prepare-0902/RUNBOOK.md` describe Steps 1 through 6 of the cutover as executed and proven, with Step 7 (deleting `pdpp`'s copy and pushing to `pdpp` main) deliberately never automated — it is a human-run action with an exact, printed-not-executed command sequence and a documented rollback path.

What was proven, concretely:

- A DCO-clean history extraction of `reference-implementation/` was regenerated fresh against current `pdpp` main and merged into `data-connect` as a real two-parent merge with zero conflicts. A durable rollback tag (`pre-dco-rewrite-move-b-0902`) was pushed to `pdpp` before any history rewriting, so the pre-rewrite state is recoverable.
- Workspace wiring (import paths, `workspace:*` dependency sites, a loosened Next.js peer pin, a missing type-definitions package) was fixed, plus a build-tooling bug the earlier rehearsal missed entirely: three moved packages had `prepare`/`prepack` scripts written for `pdpp`'s pnpm workspace that silently break inside `data-connect`'s npm workspace.
- The shared "contract" package (decision 2 above) was materialized as an interim step: a packed, digest-recorded tarball built the same way `pdpp`'s own `vendor/` directory already builds cross-repo tarballs, with the swap to a real npm-registry release written down as a one-line change once the owner publishes.
- The embedded server tab was cherry-picked in and **live-proven**, not just typechecked: a running desktop app, driven through a real synthetic click, rendered the actual PDPP owner console signed in with real audit data. A separate protocol-level curl trace confirmed the login call sets a real session cookie and that an authenticated route accepts it while an unauthenticated one is refused. Getting there required finding and fixing a real bug — the embedded tab's HTTP client followed redirects by default, but the server's login endpoint sets its session cookie only on the redirect response itself, so the client was discarding the cookie on every login.

**The one gap this session found but explicitly did not close**: booting the moved server standalone (rather than proving it via the still-unmoved `pdpp` server, which is what the live proof above actually used) surfaced a dependency on `packages/polyfill-connectors` — 45 files across five connector implementations reaching into code that was never in Move B's scope. Per the owner's explicit ruling recorded in the runbook: **none of that 45-file gap was vendored or copied into the moved server, because a second copy is exactly the drift Move A exists to prevent.** Instead, the session produced a precise import-surface map (grouping every file by what `data-connectors` already exports versus what it still needs to export) as `~/.tmp/move-b-prepare-0902/AMENDED-STEP-polyfill-connectors-import-surface.md`, to be closed by Move A's canonical `data-connectors` package exporting the missing surface — not by vendoring. This is the "polyfill-connectors needs Move A" gap noted in project memory. The live proof of the embed tab and the login/cookie mechanism did not need this gap closed, because it ran against the real, unmoved `pdpp` server.

## The seam: pinned dependency, not a copy

The mechanism that makes both moves coherent together is the same one: `data-connect` and `pdpp` each consume connector and shared-contract code as a **pinned, versioned dependency** on the canonical `data-connectors` package (or, for the reference-contract package specifically, a pinned tarball pending a real npm publish) — never a second vendored copy that can silently drift. This is stated as an explicit rule in the Move B runbook (the polyfill-connectors gap must land as a `data-connectors` export, not a vendor copy) and matches the existing pattern `pdpp`'s own `vendor/` directory already uses for `pdpp-collector-runtime` and `pdpp-connector-protocol` (see `pdpp#270`). Where a vendored copy still exists today as an interim measure (for example, `data-connect`'s own copies of `claude_code`/`codex`/`google_messages` before the Move A sync PR, or drift-check CI jobs like `Drift — vendored connector sources` and `Pin freshness — data-connect` in `data-connectors`' Cross-Repo Integrity Gate), it functions as a safety net that CI actively checks for staleness — not the long-term shape. The intent, confirmed by both the Move A cutover receipt and the Move B runbook, is that these vendored copies and their drift gates are a transitional bridge until the canonical package can be depended on directly, at which point the vendored copy and its drift check are retired.

## What remains open

- **The Move A ruleset PUT** on `data-connectors` (admin-only, exact command in `local/MOVE-A-CUTOVER-RECEIPT-0902.md`) — untouched, waiting on someone with admin access.
- **Move B Step 7** (delete `pdpp`'s copy of `reference-implementation/`, push to `pdpp` main) — deliberately never automated; the runbook's prerequisites (both feature branches merging to their respective mains) are satisfied and pushed, but the deletion/push itself is a human action with a printed-not-executed command.
- **The polyfill-connectors import-surface gap** — scoped and mapped, not closed; needs Move A's `data-connectors` package to export the missing surface before the moved `reference-implementation` can boot standalone inside `data-connect`.
- **The real npm publish of `@pdpp/reference-contract`** — the current state is an interim packed, digest-pinned tarball; a real registry release is a separate, owner-gated action, with the swap documented as a one-line change once it happens.
- **`start_reference_server`'s externally-pointed checkout spawn** (`src-tauri/src/commands/ref_server.rs`) — still spawns `pnpm dev` against an externally-pointed checkout directory rather than `data-connect`'s own now-local `reference-implementation/` tree or a bundled binary. Flagged as separate, smaller follow-on work in the runbook.
- **`github-pdpp`'s full re-pin** to current `pdpp` main (versus the same-commit dependency refresh already done) — flagged as a reasonable next-session target, not attempted.

## Related

`design-notes/connector-runtime-trust-and-isolation-2026-09-02.md` — the isolation/trust question that Move B's embed decision (Option C, native-OS isolation on Linux, honest degradation elsewhere) sits underneath but does not resolve.

Sources cited directly: `local/MOVE-A-CUTOVER-RECEIPT-0902.md`, `local/MOVE-B-IMPLEMENT-RECEIPT-0902.md`, `local/MOVE-B-DECISIONS-0831.md`, `~/.tmp/move-b-prepare-0902/RUNBOOK.md` (gitignored research scratch and a temp-directory runbook, not tracked in this repo).
