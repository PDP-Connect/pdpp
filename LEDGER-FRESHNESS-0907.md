# Ledger freshness — 2026-09-07

**Your question (09-02): "you missed a gap that I happened to catch. how can we ensure all gaps are caught?"**

The mechanism: `scripts/ledger-freshness.ts` re-tests the ledger's status column
against GitHub and git. For every row citing a PR, issue, branch or commit sha,
it resolves what that reference is *now* and reports the rows whose recorded
status disagrees. It re-finds all four stale rows the intent audit found by hand
(rows 3, 27, 31, 32), plus a fifth the audit did not report (row 61).

Run it: `node --import tsx scripts/ledger-freshness.ts`. Read-only, ~4 minutes.

## Today's result

| | Count |
|---|---|
| Rows parsed | 379 |
| References resolved | 792 |
| **Stale rows** (status contradicts reality) | **12 findings across 9 rows** — 11 real, 1 false positive (row 30, below) |
| Uncheckable citations (`#N` with no repo named) | 201 across 92 rows |
| Rows citing nothing resolvable | 100 |

The ledger is live — other sessions appended rows throughout (394 → 410 lines
while this was written), so the totals move between runs. The **same 12 findings
appeared in all five runs today**; re-run for current numbers.

## The stale rows

Every line below was produced by the command in its Proof column, run today
after fetching all three remotes.

| Row | Line | Recorded | Reality | What to do |
|---|---|---|---|---|
| **3** | 15 | `OPEN` | data-connectors **#9 MERGED** 08-31, and its tracking issue **#42 is CLOSED** | Close the row. The 17-script SPDX work is done. |
| **27** | 39 | `UNACCOUNTED` | `304e70222` off pdpp main, but `error-classification.test.ts` + `imap-error-classification.ts` are on **pdpp and data-connectors main** | Close the row against the shipped files, not the orphan commit. |
| **31** | 60 | `UNACCOUNTED — pushed, no PR` | `b9347f1` off data-connectors main, but `archive-scan.test.ts` + `ARCHIVAL-CONTRACT.md` are on **data-connect and data-connectors main** | Close the row. "Open the PR" is no longer the next action. |
| **32** | 61 | `UNACCOUNTED` | `a932674f8` off pdpp main, but all 3 of its files are **on data-connect main** (`postgres-test-template.ts`) | Close as superseded; the technique landed via data-connect #51. |
| **61** | 91 | `PR OPEN — for the reviewer` | pdpp **#287 and #278 are both CLOSED, unmerged** | Decide: reopen, or record that the gate-speed work was dropped. |
| **28** | 40 | `UNACCOUNTED` | pdpp **#125 MERGED** 08-14 | The Spotify follow-up was gated on #125; that gate cleared 3 weeks ago. |
| **60** | 90 | `2 of 3 DONE` | pdpp **#263 still OPEN** (not draft) | The row reads more finished than it is; #263 still needs your reviewer. |
| **21** | 33 | `STALE` | `4cf3c5e94`/`b923b33fe` off main, but `spec-date-check.test.ts` is **on main** | Already marked stale; the fix did land. Close it. |

**Rows 27, 31, 32 are the same defect in three places:** the row tracks a
*commit*, the work shipped as a *reimplementation elsewhere*, and nobody
reconciled the two. Move B relocated whole trees between the repos, so this
will keep happening. The check now flags it as `SUPERSEDED-ELSEWHERE`.

**Row 61 is the one the intent audit missed.** Two PRs the ledger still hands to
your external reviewer were closed without merging.

## One false positive, reported honestly

**Row 30** ("connector tier-demotion … work appears LOST") is flagged because
its sha `43ac1c2e` is on data-connectors main. That is not a real disagreement:
the row cites that sha precisely to say the branch is *behind* main. The row's
actual claim is correct — `waspflow/connector-tier-demotion-0830` is gone from
origin (`git ls-remote` returns nothing), so the demotion still needs rebuilding.

I left this in rather than special-casing it away. A checker tuned until it
reports only what I already believed would be worthless.

## What it cannot catch

Stating these plainly, because the honest boundary is the point of the answer.

1. **Rows that cite nothing.** 100 of 379 rows have no PR, branch or sha. They
   are invisible to this check. The mechanism covers citations, not claims.
2. **Reimplementation under new filenames.** `SUPERSEDED-ELSEWHERE` matches on
   basenames. Work rewritten with different names reads as simply off-main.
3. **Whether the behaviour actually matches.** For rows 27/31/32 the check
   proves the *files* are on main. It does not prove they do what the row
   promised — only you or a test can say that.
4. **Whether an open PR is any good.** `OPEN` is a state, not a judgment.

## The 201 uncheckable citations

`#42` today is a closed PR in pdpp, a closed PR in data-connect, **and** the
closed tracking issue in data-connectors the ledger meant. Three different
answers to one string. The check refuses to guess: guessing would have gotten
row 3 right by luck and something else wrong silently.

Worst offenders: row 111 (13 bare numbers), rows 102/107 (9 each), row 135 and
row 287 (8 each). The fix is one character of discipline — write `data-connect#50`,
not `#50`. Do that and those 201 become checkable.

## Answering the question directly

You asked how to ensure all gaps are caught. This does not do that, and no
script will. What it does is convert one specific failure mode — *a status
column nobody re-tests* — from something a human has to notice into something a
command reports. The intent audit found four stale rows by reading 299 of them
carefully once. This finds them in four minutes, and will find the next four
without anyone deciding to look.

The generalisable part is the shape, not the script: **the ledger recorded
claims that pointed at verifiable things, and nothing verified them.** Any
record with that property rots the same way. Where a row cites something
resolvable, resolve it on a schedule; where it cites nothing, know that it is
unverifiable and stop trusting its status as if it were evidence.

## Deliverables

| Item | Location |
|---|---|
| Checker | `scripts/ledger-freshness.ts` (branch `tools/ledger-freshness`, local) |
| Tests | `scripts/ledger-freshness.test.ts` — 29/29 pass |
| Docs | `docs/reference/ledger-freshness.md`, linked from `docs/README.md` |

The ledger itself was not edited, per the brief. The branch is **one signed
commit on `origin/main`**, local and unpushed — see PUSH-READY at the end.

## Verification

```
$ node --test scripts/ledger-freshness.test.ts
ℹ tests 29   ℹ pass 29   ℹ fail 0

$ npx tsc --noEmit -p tsconfig.json     # clean for these files
$ npx biome check scripts/ledger-freshness*.ts     # exit 0

$ node scripts/ledger-freshness.ts --json
remotes: ["pdpp: fetched","data-connect: fetched","data-connectors: fetched"]
rows 379   refs 792   stale 12 across 9 rows   ambiguous 201 across 92 rows
```

Run on the rebuilt branch, base `origin/main` @ `7acd4bac24`.

Two findings in an earlier run were false positives caused by local clones
being two days stale; the check now fetches first, which also revealed row 32.
That bug is why the tool refreshes remotes before judging anything.

## PUSH-READY

The branch is already signed and rebuilt. Nothing needs re-signing.

| | |
|---|---|
| Branch | `tools/ledger-freshness` (local, unpushed) |
| Base | `origin/main` @ `7acd4bac24` |
| Commits ahead | **1** |
| Signature | `%G? = G` — Good "git" signature, ED25519 `SHA256:euxCzhlDs35mOKqJw6ZLVip5ZR/3zWaq7DuoPtTBXIs` |

The commit sha is deliberately not pinned here: this report is *inside* the
commit, so writing its own sha would change it. Read it live with the pre-flight
below — the checks that matter (one commit, on `origin/main`, signature `G`) are
what you are confirming anyway.

```bash
cd /home/tnunamak/code/pdpp-waspflow-ledger-freshness-0907

# pre-flight — expect: 1, then "G <sha>"
git rev-list --count origin/main..HEAD
git log -1 --format='%G? %h'

git push -u origin tools/ledger-freshness
gh pr create --repo PDP-Connect/pdpp --base main \
  --head tools/ledger-freshness \
  --title "feat(scripts): ledger freshness check" \
  --body-file PR-BODY.md
```

### Correction to the earlier draft of this report

The first version of this section told you to run
`git rebase --exec '... -S' origin/main`. That was wrong and would have been
destructive: the branch was cut from a local `main` **742 commits ahead of
`origin/main`**, so that rebase would have rewritten 742 pdpp commits, not the
four of mine.

Two mistakes behind it. I read "unattended GPG failed" as "this repo cannot
sign" — but **pdpp signs over SSH**, and only data-connect/data-connectors need
the locked GPG key, so `-S` worked here all along. And I wrote a rebase command
without checking what `origin/main..HEAD` actually contained.

The branch is now rebuilt as one commit directly on `origin/main`. All five new
files are byte-identical to the earlier version (blob hashes compared); the only
content change is `docs/README.md`, where my section now applies on top of
`origin/main`'s current line instead of reverting its "testing policy" wording.

---

## Round 3 — offline mode was fabricating evidence (Codex HOLD, §5c)

**The finding was right, and it is the worst class of bug this tool could have.**

Codex built a one-row fixture citing `` pdpp `tools/ledger-freshness` `` with
status `PUSHED`, ran it with `--offline`, and got a confident stale-row finding:

```
reality  : tools/ledger-freshness → LOCAL-ONLY [pdpp] — absent from origin; local branch at 46f755c1f
why stale: status says the work is pushed, but branch ... exists only locally
proof    : git -C ~/code/pdpp ls-remote --heads origin refs/heads/tools/ledger-freshness (empty) + ...
```

Three things there are invented. `--offline` skips `ls-remote`, so **origin was
never asked** — "absent from origin" was asserted, not observed. The proof line
quotes that skipped command and annotates it `(empty)`, which is a result that
never existed. And the disagreement itself is manufactured: the row's `PUSHED`
claim was contradicted on no evidence at all.

The cause was structural, not a typo. The offline path fell *through* into code
whose precondition was "ls-remote ran and returned nothing", and that code had no
way to tell the difference between "asked, got nothing" and "never asked".

A tool whose entire purpose is to replace trust with verification cannot invent
verification. This is exactly the failure I built it to catch, committed by the
thing built to catch it.

### The fix

| Path | Before (offline) | After (offline) |
|---|---|---|
| Branch, local ref exists | `LOCAL-ONLY` "absent from origin" | `UNKNOWN` — "local branch at *sha*; remote NOT checked" |
| Branch, no local ref, unattributed | `ABSENT` "absent from all three repos" | `UNKNOWN` — "no local branch…; remotes NOT checked" |
| PR / issue | `UNKNOWN`, but quoted an unrun `gh api` | `UNKNOWN`, **no proof command at all** |
| Commit sha | `IN-MAIN` / `NOT-IN-MAIN` | unchanged — needs no network |

Two rules now hold everywhere: **offline never concludes remote absence**, and
**no proof line names a command that did not execute**. Online output is
unchanged except that the earned proof now reads `→ empty` instead of `(empty)`,
because that command did run.

### Tests that actually bite

Six resolver tests were added — the previous 23 covered only parsing and rules,
which is precisely why a green suite hid this. I checked they fail on the old
code rather than assuming:

```
old resolver + new tests → 29 tests, 24 pass, 5 FAIL
new resolver + new tests → 29 tests, 29 pass, 0 fail
```

### Documentation corrections, also from §5c

- **"Stale rows need an edit to the ledger"** overstated it. They are review
  candidates; `SUPERSEDED-ELSEWHERE` is basename-matched, and a row can be
  flagged for a sha it cites incidentally (row 30). Now stated as such.
- **34/16 vs 12/9** are now dated and explained: 34 was the 17:26 run before
  remote-fetching; 12 is every run after the fetch and status-precedence fixes.
- **`node --import tsx`** needs dev dependencies. Node 24 strips types natively,
  so the docs now lead with plain `node` and note the loader form.
- **"Exits 0 whatever it finds"** conflated findings with errors. Findings never
  change the exit code; an unreadable ledger still exits 1 (verified both ways).
- **Row 32 as a "limit" example** was wrong — it *is* caught once clones are
  fetched. Replaced with the honest limit: renamed files defeat basename matching.

### Unchanged by this round

The live run still reports **the same 12 findings across 9 rows**, so the online
verdicts in this report stand. Offline runs now report fewer, more honest
findings — which is the point.

### Round 3 identifiers

| | |
|---|---|
| Base | `origin/main` @ `7acd4bac24` |
| Commits ahead | **1** (squashed) |
| Signature | `%G? = G`, ED25519 `SHA256:euxCzhl…` |
| Patch-id (pre-amend) | `b8847c7afd49fc665997c0134b1214079051633b` |

The sha and final patch-id are read live — this report is inside the commit, so
recording its own sha would change it:

```bash
git rev-list --count origin/main..HEAD      # 1
git log -1 --format='%G? %H'                # G <sha>
git diff origin/main..HEAD | git patch-id --stable
```
