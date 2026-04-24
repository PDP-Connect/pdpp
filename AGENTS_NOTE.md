# Steward agent at work — please read

A **steward agent** is running on this repo for the next ~8–12 hours (starting 2026-04-22). Its only job is to keep your good work safely committed and pushed to `origin/main` just-in-time.

## What the steward does

- Polls `git status` every ~30 minutes.
- Groups unrelated changes into separate logical commits when reasonable.
- Commits and pushes to `main` directly.
- Leaves half-merged / conflicted state alone and notes it here.

## What you (other agents) should do

- **Keep working normally.** Edit, create files, run tests. Don't worry about committing — the steward will pick it up.
- **If you commit yourself, that's fine too.** The steward will just push what's already committed.
- **Leave files in a compilable / non-broken state when you pause.** The steward can't tell "mid-edit" from "done" — it commits whatever looks coherent.
- **Don't rebase, force-push, or rewrite history on `main`.** The steward is pushing fast-forward only.
- **Don't delete this file.** Update it if you need to flag something to the steward (e.g. "don't commit `foo/` yet, I'm mid-refactor").

## What the steward will NOT do

- No feature work, no refactors, no cleanup beyond formatting hooks that already run via lefthook.
- No force-push, no `reset --hard`, no deleting branches.
- No committing of files that look like secrets (`.env*`, credentials, tokens).
- No touching files with merge conflict markers or obvious mid-write state.

## Flagging something to the steward

If you need the steward to skip specific paths this cycle, add a line below:

### Paths the steward always skips

- `.claude/scheduled_tasks.json` and `.claude/scheduled_tasks.lock` — steward's own cron state, must not be committed.
- `pdpp-ts-refactor/` — git worktree for the TS-refactor overnight brief. Shows as untracked in `git status` but is a real worktree (contains its own `.git` file pointing into `.git/worktrees/pdpp-ts-refactor`). Never `git add` this path.

### Dev server state (2026-04-23 afternoon)

The steward started `pnpm dev` once earlier today. Next.js (:3000) has crashed twice with a native-level Turbopack fault (V8 stacktrace, no application error). Multiple `pnpm dev` trees are now running concurrently (steward's plus at least one other), which is preventing clean restart without cross-process coordination. Steward has stopped trying to manage dev servers — whoever needs :3000 should kill the stale trees (`pkill -f 'pnpm dev'`) and start their own. Reference-implementation :7662/:7663 appear stable.

### Steward discipline (lessons learned)

- **HARD RULE: before every `git commit`, run `git diff --cached --name-only`. If it shows any path the steward didn't just `git add`, run `git reset` to unstage everything, then re-add only the steward's paths.** This has been violated twice (d96c500 on 04-22, 072d08a on 04-23). Reading-past the check output counts as violating the rule. No exceptions.
- **Prefer `git add <specific paths>` over `git add .` or `git add -A`.** Already doing this — but the lesson above still matters because pre-existing stage is independent of what steward adds.
- **Follow mislabel-note convention (`chore(history): note mislabeled commit <sha>`) if a commit lands with a wrong subject.** Do not amend or reset pushed history.

### Paths to skip this cycle

<!-- Add entries like: `apps/web/src/feature-x/ — mid-refactor, don't commit until I update this note` -->

(none — integration-test extractions for gmail, chase, usaa, chatgpt, slack, codex, claude_code all landed cleanly in pairs 2026-04-23.)

- 2026-04-23 evening: `packages/polyfill-connectors/connectors/claude_code/index.ts` — 140-line disk-spool redesign (Tranche C follow-up) with no paired test yet. Skipped pending the matching test/commit to land together.
- 2026-04-23 later evening: claude_code "Option 2" stop-report set (index.ts disk-spool + orchestration.test.ts + bench + docs) is ready to commit BUT lefthook is blocking with 2 real lint errors: (1) extra JSDoc asterisks in `connectors/claude_code/index.ts:654`, (2) `resolveSessionGroups()` cognitive complexity 25 > 20 at line 661. Steward won't fix — author should resolve these lints and then either commit themselves or signal the steward. Also new untracked `bench/discover-probe.ts` rides along in the same working set.
- 2026-04-23 night: `reference-implementation/server/index.js`, `reference-implementation/server/transport.js`, `reference-implementation/package.json`, `pnpm-lock.yaml`, and new `reference-implementation/repro-sqlite-crash.mjs` — the core pino/logging change implementing `add-reference-impl-logging` is landed in-working-tree, but wrapped with an active silent-crash investigation: (a) index.ts has an explicit "TEMPORARY DIAGNOSTIC" block hooking every POSIX signal for stderr tracing, (b) package.json swapped `dev` off `--watch` with a "DIAGNOSTIC: --watch removed temporarily" comment, (c) the untracked `repro-sqlite-crash.mjs` is the reproduction script for that investigation. Steward committed the openspec proposal for this change but skipped the runtime code + lock + repro pending author's own commit once the diagnostic block comes out (or the diagnostic is intentionally kept with a proper "why it stays" comment).
- 2026-04-23 night (follow-up poll): same cluster still dirty, no author commit yet. Two additional untracked repros appeared (`reference-implementation/repro-crash.mjs`, `reference-implementation/repro-dashboard.mjs`) — investigation is ongoing. Steward continuing to skip the whole cluster until the TEMPORARY DIAGNOSTIC block is resolved.
- 2026-04-23 late night: `swap-sqlite-driver` implementation in flight (root `package.json`, `packages/polyfill-connectors/package.json`, `reference-implementation/package.json`, `pnpm-lock.yaml`, `reference-implementation/server/db.js`, untracked `reference-implementation/server/queries/` with 15 empty subdirs and no `.sql` files yet). Steward committed the openspec proposal (`openspec/changes/swap-sqlite-driver/`) but skipped all runtime files — db.js rewrite is live (mtime ~5 min) and the queries/ tree is placeholder-only. Author should land the SQL files and finalize the db.js swap, then commit the runtime cluster together.
- 2026-04-23 late night (follow-up poll): driver-swap scope has grown to polyfill-connector callers — `packages/polyfill-connectors/bin/verify-all.ts` and `packages/polyfill-connectors/connectors/imessage/index.ts` migrated from `@databases/sqlite` to `better-sqlite3`, and `packages/polyfill-connectors/types/databases-sqlite.d.ts` deleted. These are tightly coupled to the still-dirty db.js rewrite + empty queries/ tree, so the steward is skipping them as part of the same cluster. Still zero `.sql` files in `reference-implementation/server/queries/`; db.js mtime is fresh (~6 min). Author should land the whole cluster together.
- 2026-04-24 very early morning: driver-swap cluster is now in an **active commit-preparation state** — author has staged 9 files (deps, transport.js, polyfill callers, and a first-cut db.js rewrite) but has 13 more unstaged (remaining call sites in `lib/spine.js`, `runtime/controller.js`, `server/auth.js`, `server/index.js`, `server/records.js`, `server/ref-control.js`, plus 6 test files). `db.js` shows `MM` (staged AND unstaged changes — live iteration). Steward is NOT touching the stage this cycle — any `git reset` or partial commit could clobber the author's in-progress prep. Also notable: `TEMPORARY DIAGNOSTIC` block is gone from index.js (the silent-crash investigation resolved), the 3 repro-*.mjs scripts have been deleted, and the `server/queries/` directory was removed entirely (author chose not to extract SQL files as part of this swap). Next steward cycle should be safe once the author completes their commit.
- 2026-04-24 morning: another active commit-prep state. ~10 files in `MM` (both staged and unstaged) across `apps/web/.source/`, `apps/web/content/docs/spec-*.md`, `apps/web/src/app/dashboard/{lib/rs-client.ts,search/page.tsx}`, `packages/reference-contract/src/public/index.js`, `pnpm-lock.yaml`, `reference-implementation/server/auth.js`. Two deletions already staged: `apps/web/content/docs/spec-semantic-retrieval-extension.md`, `reference-implementation/server/search-semantic.js`, `reference-implementation/test/semantic-retrieval.test.js`. Steward is NOT touching the stage. Also: new **untracked git worktree at `pdpp-ts-refactor/`** (42k files, including node_modules) for the TS-refactor brief — git worktrees show as `??` but must NOT be `git add`ed. Steward always skips `pdpp-ts-refactor/` going forward.
- 2026-04-23 evening (fix-rs-query-memory-pressure slices 1-4 landed): four commits (876119e, 0840be6, 54b3ea6, and the slice-1+2 combined) push the records + expansion + spine + timeline read paths into SQL. Repro-harness result after slice 4: **3/3 runs survived** (previously ~50% crash rate). Heap peak dropped from 600-730 MB old-space to ~14 MB old-space (>40× smaller). `/dashboard/records` latency dropped from ~8.7s to ~0.4s. The `composed browser origin` test still fails identically to main — pre-existing unrelated SSR leak. Remaining tasks 3.x (server defenses + dashboard client coordination) and 4.x (extend repro oracle) are owner-deferred to a separate batch.
- 2026-04-24 afternoon: `apps/web/src/app/dashboard/deployment/page.tsx` — mtime was ~36s old at the start of this steward cycle (in-progress edit window). Held back from the lexical-backfill wiring + CopyButton web commits. Next steward cycle can pick it up once it settles (or the author commits it themselves).

---
Questions/trouble: ping the owner.
