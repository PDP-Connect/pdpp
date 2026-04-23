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

### Paths to skip this cycle

<!-- Add entries like: `apps/web/src/feature-x/ — mid-refactor, don't commit until I update this note` -->

(none)

---
Questions/trouble: ping the owner.
