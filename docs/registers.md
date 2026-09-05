# Registers and the data behind them

PDP-Connect keeps three stores. Two are public and hold no personal data. One
is private and holds all of it. This document says what is in each, how data
moves between them, who can reach them, and how to hand the private one over or
delete it.

It is written for whoever inherits this, which may not be anyone who set it up.

## The three stores

### 1. The private signatory repository

`PDP-Connect/supporters-private`. Private. **Holds personal data.**

One file per confirmed signatory at `signatories/<yyyy>/<id>.json`, holding the
name as entered, the computed public name, the organisation, the signatory's
name and role, the email address, the country, the type, the four consent
flags, the Principles version, and the confirmation timestamp.

Also `withdrawn.log`: dates only, one line per withdrawal, with no identifier
and no reason.

The site writes these files to the private repository's `signatures` branch.
That branch is the live register of record. The private repository's default
branch, `main`, holds control documentation and does **not** contain the live
register; nothing in the running system reads it.

`PDPP_PRIVATE_REPO_BRANCH` names the branch a deployment writes. On Vercel the
site accepts exactly one branch per environment:

| Vercel environment (`VERCEL_ENV`) | `PDPP_PRIVATE_REPO_BRANCH` |
| --- | --- |
| `production` | `signatures` |
| `preview` | `signatures-preview` |
| any other value, or unset | signing is refused |

`signatures-preview` is a disposable rehearsal branch, started empty from
private `main`. A rehearsal against a preview deployment writes a real confirmed
record, so it must not land in the register a real signatory appears in. The
site enforces the pairing rather than trusting the configuration: on Vercel,
production accepts only `signatures` and preview accepts only
`signatures-preview`, and any other combination — including a deployment whose
`VERCEL_ENV` is missing or unrecognised — fails before the site makes a single
GitHub request.

**Signing is refused under `vercel dev`.** It runs with `VERCEL=1` and a
`VERCEL_ENV` that is neither `production` nor `preview` — Vercel documents
`development` for this case — so it takes the unrecognised-environment path and
every signing attempt returns 503. This is deliberate: there is no
`development` arm to add without giving a local machine a branch policy of its
own.

Local development with live providers therefore runs **off Vercel** — `next dev`
or a plain `node` server, with `VERCEL` unset. Off Vercel there is no
environment to read, so the branch is whatever `PDPP_PRIVATE_REPO_BRANCH` says
and defaults to `signatures`. That default exists so a non-Vercel production
host keeps working; it is the wrong branch for a rehearsal, so **set
`PDPP_PRIVATE_REPO_BRANCH=signatures-preview` by hand** before running a live
local journey.

A branch-policy refusal is raised when the site writes the record, which on the
confirm path happens after the pending submission has been read. That read does
not consume the submission: confirm reads, writes, and deletes the pending
record only once the private record is durable. So a refusal on a misconfigured
deployment leaves the confirmation link usable — fix the branch configuration
and the same link still works. The signatory sees an error and nothing is lost.

After a rehearsal, delete the test records from `signatures-preview` or reset
that branch to its empty base. Its records are not withdrawals from the
production register: never publish them, and never copy its `withdrawn.log`
into `signatures`.

The public repository's daily `publish-supporters` workflow runs
as `github-actions[bot]`. Its private checkout uses
`PDPP_PRIVATE_REPO_TOKEN`, a fine-grained access token owned by the
maintainer account `tnunamak`. The token is scoped to
`PDP-Connect/supporters-private` with Contents read and write, and is stored as
the `pdpp` repository's Actions secret. It is neither branch-limited nor
read-only; the workflow itself checks out only `signatures`, sets
`persist-credentials: false`, and has no private-register write step. The
workflow writes the public register with this repository's `GITHUB_TOKEN` by
opening a PR from the fixed `publish/supporters` branch, never by committing to
`main`.

This public workflow is the only publisher. The private repository's own publish
workflow is retired, and nothing else writes the public register.

When `PDPP_PUBLISH_PR_TOKEN` is set, the publisher opens or updates its generated
PR itself. It is a fine-grained personal access token scoped only to the public
`PDP-Connect/pdpp` repository with Pull requests: write and Contents: read; it
never needs access to the private repository. Without the token, the publisher still pushes
`publish/supporters`, reports the compare URL, and prints the `gh pr create`
command a maintainer runs to open the PR. After its required checks pass, a
maintainer merges it with **Squash and merge**.

`signatures` is never merged into the private repository's default branch. A
merge would put a second, stale copy of the personal data on `main` and make a
branch nothing reads look authoritative. Instead, once a week a maintainer
fetches `origin/signatures` over SSH and reviews the new commits, the current
signatory file count, and the date-only withdrawal entries. Unexpected paths, a
force push, or a commit by an unknown actor is an incident, not a tidy-up.

When a withdrawal makes the rebuilt public register equal to `main`, the
publisher closes the open `publish/supporters` PR with the comment `register now
equals main; nothing to publish` and deletes that branch. This removes a stale
public-register change instead of leaving a withdrawn signatory in review.

Reachable by the maintainers listed in [`MAINTAINERS.md`](../MAINTAINERS.md)
and the site's Vercel deployment credential. The publisher uses the separate
fine-grained token described above only for its private checkout. Nothing else.

This store exists only because signing opened before LF Decentralized Trust
hosting was confirmed. It is meant to stop existing.

### 2. The public supporters register

`apps/site/public/principles/supporters.json` in this repository. Public.
**Holds no email addresses and no signatory names.**

Five fields per listed signatory: public name, type, country, date signed, and
Principles version. The public name is first name and last initial for an
individual, or the organisation name for an organisation. It is computed when
the signature is confirmed and stored, so a later change to the naming rule
never renames someone who already consented to appear a particular way.

Rendered on `/principles`.

### 3. The external mailing list

An LF Decentralized Trust list, outside both repositories.

Nobody is subscribed automatically. The "email me about new versions" checkbox
stores a flag in the private record and does nothing else.
`scripts/export-list-optins.mjs` at the private repository root prints the
opted-in addresses for a maintainer to subscribe once, by hand. This repository
sends no email and holds no list.

## How data moves

```
  the form on /principles
          |
          |  POST /api/sign
          v
  pending store (KV, 48h TTL)  ---- expires, leaving nothing ---->  gone
          |
          |  the signatory uses the confirmation link
          v
  PRIVATE repo: signatories/<yyyy>/<id>.json
          |
          |  public-repository workflow reads signatures, five fields only
          v
  PUBLIC repo: apps/site/public/principles/supporters.json
          |
          v
  /principles
```

Three properties hold this together, and each is worth keeping:

- **An unconfirmed submission leaves no residue.** It lives in a store with a
  TTL and is never written anywhere durable until the person who owns the
  address acts.
- **One direction only.** The site writes to the private repository. The public
  repository's workflow reads the private register and writes its own public
  JSON. Nothing reads back the other way, and the public site has no credential
  that can read the private store.
- **The publish script is an allowlist.** It names the five public fields one
  at a time rather than deleting the private ones, so a record that grows a
  field does not leak it.

## Who has access

| Store | Read | Write |
| --- | --- | --- |
| Private signatory repo | Maintainers in `MAINTAINERS.md`, plus `PDPP_PRIVATE_REPO_TOKEN` (the `tnunamak` fine-grained access token with Contents read/write; the publisher checks out only `signatures`) | Those maintainers, plus the site's fine-grained access token |
| Public supporters JSON | Anyone | `github-actions[bot]` through this repository's `GITHUB_TOKEN`, via `publish/supporters` PRs, and maintainers via PR |
| Mailing list | LFDT list administrators | LFDT list administrators |

Access to the private repository is reviewed whenever `MAINTAINERS.md` changes.
Someone who leaves that file loses access at the same time.

## Handing the private store to a successor controller

Run this when hosting is confirmed with LF Decentralized Trust, or whenever the
interim controller changes.

1. **Tell the signatories.** Write to every address in `signatories/` saying who
   the controller is becoming and when. This is the one message the programme
   sends that the signing system does not, and it is sent by a person.
2. **Export.** `git clone --mirror` the private repository, or use
   `gh repo archive`. Verify the archive opens and the file count matches.
3. **Hand over** on a channel the successor has named, and get their written
   confirmation that they hold it.
4. **Rotate the fine-grained access token.** Revoke the existing token, issue
   the replacement against the successor's store scoped to that repository with
   Contents read and write, and update the Vercel secret
   `PDPP_PRIVATE_REPO_TOKEN`.
5. **Check the site still works.** Rehearse on a preview deployment writing
   `signatures-preview`, using a marked `+pdpp-test-<run>` alias of an address
   you control: submit, confirm, and watch the record land in the successor's
   store. Then delete the test record from `signatures-preview`. Confirm the
   production journey separately by watching the next real signature reach
   `/principles`.
6. **Delete the private repository.** An interim store kept "just in case" is
   no longer interim.

If the programme ends without a successor, do step 1, then delete the private
repository and empty `supporters.json` in the same week.

## Deleting a single signatory

The withdrawal link in the confirmation email does this without anyone's help:
it deletes the file and appends the date to `withdrawn.log`. The entry leaves
the public register at the next publish.

A request that arrives by email instead is served by deleting the same file by
hand and adding the same one line. Do not record who asked.

## If personal data reaches this public repository

Treat it as an incident, not a tidy-up.

1. Remove the content and force-push the branch that carried it.
2. Ask GitHub Support to purge the cached objects: force-pushed commits stay
   reachable by SHA for a period.
3. Rotate the fine-grained access token.
4. Tell the people whose data was exposed.
