## What this adds

`scripts/ledger-freshness.ts` — a read-only check that re-tests the status
column of `local/OWNER-COMMITMENTS.md` against the current state of GitHub and
git.

## Why

The commitments ledger is the accountability contract: rows close only with
evidence, and every watch cycle re-reads it. But a status column is prose. It
records what somebody believed when they typed it, and nothing re-tests that
belief afterwards.

The 2026-09-07 intent audit found the ledger drifting in both directions at
once — rows marked `OPEN`/`UNACCOUNTED` whose work is already on main, and rows
whose branches no longer exist. A reader gets both false-open and false-closed
answers from the one file that exists to prevent exactly that.

## How it works

For every table row it extracts each cited PR/issue, branch and commit sha,
resolves the reference's current state, and reports rows whose recorded status
contradicts it.

| Reference | Resolved with | States |
|---|---|---|
| PR / issue | `gh pr view`, `gh api repos/…/issues/N` | `MERGED` `CLOSED` `OPEN` `DRAFT` |
| Branch | `git ls-remote --heads` | `ON-REMOTE` `LOCAL-ONLY` `ABSENT` |
| Commit sha | `git merge-base --is-ancestor` | `IN-MAIN` `NOT-IN-MAIN` `SUPERSEDED-ELSEWHERE` |

Against the ledger today: **12 findings across 9 rows**, including all four
stale rows the intent audit found by hand and one it did not (row 61 — two PRs
the ledger still routes to the external reviewer were closed unmerged).

## Three decisions worth reviewing

**A bare `#42` is not resolvable, so it is not resolved.** Today `#42` is a
closed PR in pdpp, a closed PR in data-connect, and the closed tracking issue in
data-connectors that the ledger meant. Guessing a repo would have produced the
right verdict for one row by luck and a wrong one elsewhere. References resolve
only when the row attributes them; the 198 that cannot are reported as their own
class rather than mixed into the stale-row list.

**Move B means "not on main" is not the same as "not shipped."** Whole trees
moved between the three repos, so a cited commit can be orphaned while the work
it introduced is on another repo's main. That is reported as
`SUPERSEDED-ELSEWHERE` for review — it proves the files are present, not that
the behaviour matches.

**It fetches before it judges.** Reading a stale local mirror produced two
confident false positives during development, and hid one true finding. The
fetch writes only to each clone's own remote-tracking refs; `--offline` skips
it.

## Scope

Read-only, and not a gate: findings never change the exit status (an operational
failure still exits non-zero). It never writes to the ledger, a working tree, or
GitHub. The ledger is not edited by this PR.

`--offline` skips every network call and reports `UNKNOWN` for anything that
needed one. It will not say a branch is absent from a remote it never asked, and
will not print a command it did not run — an earlier revision did both, which is
what the offline resolver tests now pin.

## Verification

```
node --test scripts/ledger-freshness.test.ts   # 23/23 pass
npx tsc --noEmit -p tsconfig.json              # clean
npx biome check scripts/ledger-freshness*.ts   # exit 0
```

Docs: `docs/reference/ledger-freshness.md`, linked from `docs/README.md`.

Assisted-by: AI
