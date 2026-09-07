# Ledger freshness check

`scripts/ledger-freshness.ts` re-tests the status column of
`local/OWNER-COMMITMENTS.md` against the current state of GitHub and git.

## Why it exists

The commitments ledger is the accountability contract: rows close only with
evidence, and every watch cycle re-reads it. But a status column is prose. It
records what somebody believed when they typed it, and nothing re-tests that
belief afterwards.

The 2026-09-07 intent audit found the ledger drifting in both directions at
once — rows marked `OPEN`/`UNACCOUNTED` whose work is on main, and rows with
hopeful framing whose branches no longer exist. So reading the ledger produces
both false-open and false-closed answers, which is the failure the ledger was
built to prevent.

This check closes that loop. A status column that can be tested cannot silently
rot.

## What it does

For every table row, it extracts each cited PR/issue (`#N`), branch
(`waspflow/…`, `fix/…`, …) and commit sha, resolves the reference's current
state read-only, and reports the rows whose recorded status contradicts it.

| Reference | Resolved with | States |
|---|---|---|
| PR / issue | `gh pr view` / `gh api repos/…/issues/N` | `MERGED` `CLOSED` `OPEN` `DRAFT` |
| Branch | `git ls-remote --heads` | `ON-REMOTE` `LOCAL-ONLY` `ABSENT` |
| Commit sha | `git merge-base --is-ancestor <sha> <remote>/main` | `IN-MAIN` `NOT-IN-MAIN` `SUPERSEDED-ELSEWHERE` |

`SUPERSEDED-ELSEWHERE` is the Move B case: a commit that is not on its own
repo's main, but whose files are present on another repo's main. Move B
relocated whole trees between `pdpp`, `data-connect` and `data-connectors`, so
work can be genuinely shipped while the commit the ledger cites is orphaned.
The check reports it for review; it does not assert the behaviour matches.

## Usage

```bash
node scripts/ledger-freshness.ts              # default ledger
node scripts/ledger-freshness.ts --row 27     # one row number
node scripts/ledger-freshness.ts --json       # machine-readable
node scripts/ledger-freshness.ts --offline    # local git only
```

Node 24 strips the types natively, so no loader and no `pnpm install` is needed.
Under an older Node, or to match the other scripts in this directory, prefix
with `node --import tsx` — that form needs the repo's dev dependencies
installed. Requires `gh` authenticated and the three clones present (see
`REPOS` at the top of the script).

| Flag | Effect |
|---|---|
| `--ledger <path>` | Check a different file (default `local/OWNER-COMMITMENTS.md`) |
| `--row <n>` | Restrict to rows with that row number; repeatable |
| `--all` | Print every resolved reference, not just the disagreements |
| `--json` | Emit findings as JSON, each with the command that proved it |
| `--offline` | Skip `gh` and `ls-remote`; resolve from local git only |
| `--strict` | List every uncheckable citation instead of summarising |

A full run makes roughly 700 reference lookups and takes a few minutes.

Tests: `node --test scripts/ledger-freshness.test.ts`.

## Reading the output

Findings come in two classes, reported separately on purpose.

**Stale rows** are rows whose status contradicts a resolved reference. These are
**review candidates, not verdicts** — read the proof line before editing the
ledger. `SUPERSEDED-ELSEWHERE` in particular matches on file basenames, so it
says "these files are on another repo's main", not "this row is done". A row can
also cite a sha incidentally, as evidence for something other than its own
status, and be flagged for it (row 30 on 2026-09-07 was exactly that).

On 2026-09-07 a run at 17:26, before the tool fetched remotes, reported 34
findings across 16 rows. After the fetch fix and the status-precedence fix, runs
later that evening reported a stable 12 across 9 rows. The larger number was
mostly stale local clones and rows whose status already said `STALE`; the
smaller one is the signal.

**Uncheckable citations** are references naming a number but no repo. `#42` on
2026-09-07 was simultaneously a closed PR in `pdpp`, a closed PR in
`data-connect`, and the closed tracking issue in `data-connectors` that the
ledger meant. The tool refuses to guess: guessing would have produced the right
answer for that row by luck and a wrong one elsewhere. Fix these by writing the
repo next to the number (`data-connect#50`).

## Limits worth knowing

- **It tests citations, not claims.** A row with no PR, branch or sha in it is
  not checked at all. The mechanism covers the part of the ledger that points
  at something machine-resolvable.
- **It cannot see a reimplementation under new filenames.** Supersession is
  detected by basename, so work rewritten under different names reads as simply
  off-main. (Row 32's Postgres gate-templating work happened to keep its
  filenames, so it *is* caught — but only once the clones are fetched. Do not
  read that case as proof the check finds renamed work.)
- **File presence is not behavioural equivalence.** `SUPERSEDED-ELSEWHERE`
  proves the files exist on another main. Whether they do what the row promised
  is a question only a human or a test can answer.
- **`STALE` in a status is treated as already-acknowledged.** Rows whose status
  literally says `STALE` have been marked as not reflecting reality, usually
  with the newer state spelled out beside them. Re-reporting them is noise.
- **`--offline` narrows what can be concluded, and says so.** Without the
  network it never reports a branch as absent from a remote it did not ask, and
  never prints a command it did not run. Those references come back `UNKNOWN`.
- **It is read-only and never a gate.** No finding changes the exit code — it
  exits 0 however many stale rows it reports. An operational failure (an
  unreadable ledger, say) still exits non-zero, so "no findings" and "exit 0"
  are not the same statement. It never
  writes to the ledger, a working tree, or GitHub. It does run `git fetch` into
  each clone's own remote-tracking refs first: reading a two-day-old mirror
  reports the mirror's staleness as the ledger's, which produced two false
  positives while this was being built. `--offline` skips the fetch too.
