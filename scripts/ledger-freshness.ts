#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Ledger freshness check for local/OWNER-COMMITMENTS.md.
//
// The commitments ledger is the accountability contract: rows close only with
// evidence, and every watch cycle re-reads it. But a status column is prose. It
// records what somebody believed when they typed it, and nothing re-tests that
// belief afterwards. The 09-07 intent audit found the ledger drifting in BOTH
// directions at once: rows marked OPEN/UNACCOUNTED whose work is on main, and
// rows with hopeful framing whose branches no longer exist. Reading the ledger
// therefore produces both false-open and false-closed answers.
//
// This script re-tests the belief. For every row citing a PR, an issue, a
// branch or a commit sha, it resolves the CURRENT state read-only via `gh` and
// `git`, then reports the rows where the recorded status disagrees with
// reality. It is the mechanism answer to "how can we ensure all gaps are
// caught?" — a status column that can be tested cannot silently rot.
//
// Usage:
//   node --import tsx scripts/ledger-freshness.ts [options]
//
//   --ledger <path>   ledger to check (default: local/OWNER-COMMITMENTS.md)
//   --json            emit the full findings as JSON
//   --all             report every resolved reference, not just disagreements
//   --row <n>         restrict to ledger rows whose row number is <n> (repeatable)
//   --offline         skip all network calls (git ls-remote / gh); local git only
//   --strict          list every uncheckable citation instead of summarising
//
// Findings never change the exit status — it exits 0 however many stale rows it
// reports, because this is a reporting tool for the owner, not a gate. An
// operational failure (an unreadable ledger) still exits non-zero. It never
// writes to the ledger, to a working tree, or to GitHub. The one write it does
// make is `git fetch` into each local clone's own remote-tracking refs, because
// reading a stale mirror would report the mirror's staleness as the ledger's.
//
// --offline skips every network call. It then reports UNKNOWN for anything that
// needed one, and quotes only commands it actually ran: without ls-remote there
// is no basis for saying a branch is absent from a remote, and a proof line
// naming an unexecuted command is fabricated evidence.
//
// WHAT IT DELIBERATELY WILL NOT DO
//
// A bare "#42" is ambiguous: on 2026-09-07 it was a closed PR in pdpp, a closed
// PR in data-connect, AND the closed tracking issue in data-connectors that the
// ledger actually meant. Guessing a repo would have produced the right verdict
// for that row by luck and a wrong one elsewhere. So a reference resolves only
// when the row (or the ledger's own conventions) says which repo it belongs to;
// otherwise it is reported as AMBIGUOUS with the candidates listed. Ambiguity is
// a finding, not an error — an unattributable citation is itself a gap in the
// record.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

export interface RepoSpec {
  /** `owner/name` on GitHub. */
  slug: string;
  /** Local clone used for sha/branch resolution. */
  dir: string;
  /** Remote name inside that clone that points at `slug`. */
  remote: string;
  /** Tokens in ledger prose that attribute a reference to this repo. */
  aliases: string[];
}

export const REPOS: RepoSpec[] = [
  {
    slug: "PDP-Connect/pdpp",
    dir: `${process.env.HOME}/code/pdpp`,
    remote: "origin",
    aliases: ["pdpp"],
  },
  {
    slug: "PDP-Connect/data-connect",
    dir: `${process.env.HOME}/code/data-connect`,
    remote: "canonical",
    aliases: ["data-connect", "dc"],
  },
  {
    slug: "PDP-Connect/data-connectors",
    dir: `${process.env.HOME}/code/data-connectors`,
    remote: "origin",
    aliases: ["data-connectors", "dcx"],
  },
];

const repoBySlug = new Map(REPOS.map((r) => [r.slug, r]));

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

export interface LedgerRow {
  /** 1-based line in the ledger file. The stable identity: row numbers repeat. */
  line: number;
  /** The number in the first cell. Not unique — the ledger has duplicates. */
  num: string;
  date: string;
  text: string;
  status: string;
  /** Status + evidence, i.e. everything after the commitment text. */
  statusAndEvidence: string;
}

/**
 * Split one ledger table row.
 *
 * The table is `| # | date | commitment | status | evidence |`, but evidence
 * and commitment prose contain raw `|` characters, and some rows omit the
 * trailing cell entirely. So: take the first three cells from the left, then
 * treat the remainder as status + evidence and take the status as the next
 * cell from the left of that remainder. Never split from the right — a row with
 * a pipe inside a code span would silently mis-column.
 */
export function parseRow(rawLine: string, line: number): LedgerRow | null {
  if (!/^\|\s*\d+\s*\|/.test(rawLine)) return null;
  const body = rawLine.replace(/^\|/, "").replace(/\|\s*$/, "");
  const cells = body.split("|");
  if (cells.length < 3) return null;

  const num = (cells[0] ?? "").trim();
  const date = (cells[1] ?? "").trim();
  const text = (cells[2] ?? "").trim();
  const rest = cells.slice(3).join("|");
  const status = (rest.split("|")[0] ?? "").trim();

  return { line, num, date, text, status, statusAndEvidence: rest.trim() };
}

export function parseLedger(content: string): LedgerRow[] {
  return content
    .split("\n")
    .map((l, i) => parseRow(l, i + 1))
    .filter((r): r is LedgerRow => r !== null);
}

// ---------------------------------------------------------------------------
// Reference extraction
// ---------------------------------------------------------------------------

export type RefKind = "pr-or-issue" | "branch" | "sha";

export interface Reference {
  kind: RefKind;
  /** Exactly as written in the ledger, for the report. */
  raw: string;
  /** Number for pr-or-issue, branch name, or sha. */
  value: string;
  /** Repo slugs this could refer to. One = attributed; many = ambiguous. */
  candidates: string[];
  /** How the repo was attributed, shown in the report so a reader can audit it. */
  attribution: string;
}

const BRANCH_PREFIXES = [
  "waspflow",
  "fix",
  "feat",
  "chore",
  "docs",
  "consent",
  "tools",
  "prod",
  "refactor",
  "test",
  "ci",
];

/** Paths that look like branches but are files; the ledger cites both. */
function looksLikePath(name: string): boolean {
  return /\.(md|ts|tsx|js|json|ya?ml|sh|txt|sql)$/i.test(name);
}

/**
 * Attribute a reference to a repo using the nearest repo alias to its left in
 * the row, falling back to any alias in the row. Proximity matters: a row
 * saying "#238 ... data-connect#36" must not hand both numbers to data-connect.
 */
function attribute(
  matchIndex: number,
  haystack: string,
): { candidates: string[]; attribution: string } {
  const before = haystack.slice(0, matchIndex);

  let nearest: { slug: string; alias: string; at: number } | null = null;
  for (const repo of REPOS) {
    for (const alias of repo.aliases) {
      // `dc`/`dcx` are only meaningful as explicit repo tags, so require them
      // to be adjacent to the reference rather than loose in prose.
      const pattern =
        alias.length <= 3
          ? new RegExp(`\\b${alias}\\s*(?=#)`, "gi")
          : new RegExp(`\\b${alias}\\b`, "gi");
      for (const m of before.matchAll(pattern)) {
        if (nearest === null || m.index > nearest.at) {
          nearest = { slug: repo.slug, alias, at: m.index };
        }
      }
    }
  }
  if (nearest) {
    const distance = before.length - nearest.at;
    return {
      candidates: [nearest.slug],
      attribution: `nearest repo token "${nearest.alias}" ${distance} chars to the left`,
    };
  }

  // Nothing to the left. Fall back to a repo named elsewhere in the row, but
  // only if that mention is FREE — not already acting as the qualifier of some
  // other reference. "#238 merged; data-connect#36 merged" must leave #238
  // ambiguous: the single `data-connect` in the row belongs to #36, and
  // borrowing it would confidently resolve #238 against the wrong repo.
  const mentioned = REPOS.filter((repo) =>
    repo.aliases.some((a) => {
      const bound = a.length <= 3 ? new RegExp(`\\b${a}\\s*(?=#)`, "i") : null;
      if (bound) return false; // short aliases are only ever qualifiers
      const free = new RegExp(`\\b${a}\\b(?!\\s*#)`, "i");
      return free.test(haystack);
    }),
  );
  const only = mentioned.length === 1 ? mentioned[0] : undefined;
  if (only) {
    return {
      candidates: [only.slug],
      attribution: `only repo named unqualified in the row (${only.aliases[0] ?? only.slug})`,
    };
  }

  return {
    candidates: REPOS.map((r) => r.slug),
    attribution: "no repo named in the row",
  };
}

export function extractReferences(row: LedgerRow): Reference[] {
  const refs: Reference[] = [];
  const seen = new Set<string>();
  const haystack = `${row.text} | ${row.statusAndEvidence}`;

  const push = (ref: Reference) => {
    const key = `${ref.kind}:${ref.value}:${ref.candidates.join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  // PRs and issues: #N, optionally repo-qualified as `data-connect#41`. The
  // preceding character may be a word char precisely because of that form, so
  // only a preceding `#` is excluded (to skip markdown headings like `##1`).
  for (const m of haystack.matchAll(/(^|[^#])#(\d+)\b/g)) {
    const number = m[2];
    if (!number) continue;
    const at = m.index + (m[1] ?? "").length;
    const { candidates, attribution } = attribute(at, haystack);
    push({
      kind: "pr-or-issue",
      raw: `#${number}`,
      value: number,
      candidates,
      attribution,
    });
  }

  // Branches: prefix/name, backticked or bare.
  const branchRe = new RegExp(
    `\\b((?:${BRANCH_PREFIXES.join("|")})/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*)`,
    "g",
  );
  for (const m of haystack.matchAll(branchRe)) {
    const name = m[1];
    if (!name || looksLikePath(name)) continue;
    const { candidates, attribution } = attribute(m.index, haystack);
    push({
      kind: "branch",
      raw: name,
      value: name,
      candidates,
      attribution,
    });
  }

  // Commit shas: only inside backticks. Bare hex in prose is far too noisy
  // (dates, ids, container names) and a false sha resolves to a real "unknown".
  for (const m of haystack.matchAll(/`([0-9a-f]{7,40})`/g)) {
    const sha = m[1];
    if (!sha || /^\d+$/.test(sha)) continue; // all-digits: a number, not a sha
    const { candidates, attribution } = attribute(m.index, haystack);
    push({
      kind: "sha",
      raw: sha,
      value: sha,
      candidates,
      attribution,
    });
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Resolution (read-only)
// ---------------------------------------------------------------------------

export type RealState =
  | "MERGED"
  | "CLOSED"
  | "OPEN"
  | "DRAFT"
  | "ON-REMOTE"
  | "LOCAL-ONLY"
  | "ABSENT"
  | "IN-MAIN"
  | "NOT-IN-MAIN"
  /** Off main where cited, but its files are on another repo's main. */
  | "SUPERSEDED-ELSEWHERE"
  | "UNKNOWN"
  | "AMBIGUOUS";

export interface Resolution {
  ref: Reference;
  state: RealState;
  /** Repo the state was read from, when attribution succeeded. */
  repo?: string;
  /** Human-readable detail plus the command that produced it. */
  detail: string;
  command: string;
}

async function run(
  file: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? e.message ?? "").trim(),
    };
  }
}

interface ResolveOptions {
  offline: boolean;
}

/**
 * Refresh each clone's remote refs before anything is resolved.
 *
 * Without this the check reads a local mirror and reports its staleness as the
 * ledger's. Both of the false positives seen while building this were exactly
 * that: commits that `merge-base --is-ancestor` called off-main against a
 * two-day-old `main`, and that were plainly on main after a fetch. A freshness
 * checker that reads stale data is self-defeating.
 *
 * `git fetch` writes only to the clone's own remote-tracking refs — it does not
 * touch a working tree, a branch, or anything on the remote.
 */
export async function refreshRemotes(opts: ResolveOptions): Promise<string[]> {
  if (opts.offline) return [];
  const refreshed: string[] = [];
  for (const repo of REPOS) {
    const res = await run("git", [
      "-C",
      repo.dir,
      "fetch",
      "--quiet",
      "--prune",
      repo.remote,
    ]);
    refreshed.push(
      `${repo.slug.split("/")[1]}: ${res.ok ? "fetched" : `fetch failed (${res.stderr.split("\n")[0]})`}`,
    );
  }
  return refreshed;
}

async function resolvePrOrIssue(
  ref: Reference,
  slug: string,
  opts: ResolveOptions,
): Promise<Resolution> {
  const command = `gh api repos/${slug}/issues/${ref.value}`;
  if (opts.offline) {
    // No command is quoted: none was run, and a proof line naming an
    // unexecuted command reads as evidence that does not exist.
    return {
      ref,
      state: "UNKNOWN",
      repo: slug,
      detail: "not checked (--offline)",
      command: "",
    };
  }
  const res = await run("gh", [
    "api",
    `repos/${slug}/issues/${ref.value}`,
    "--jq",
    // `issues` covers both; `pull_request` present means it is a PR.
    '[(.pull_request != null), .state, .state_reason // "", .title] | @tsv',
  ]);
  if (!res.ok) {
    return {
      ref,
      state: "UNKNOWN",
      repo: slug,
      detail: `not resolvable: ${res.stderr.split("\n")[0]}`,
      command,
    };
  }
  const [isPr, state, , title] = res.stdout.split("\t");
  const kind = isPr === "true" ? "PR" : "issue";

  if (isPr === "true") {
    const pr = await run("gh", [
      "pr",
      "view",
      ref.value,
      "--repo",
      slug,
      "--json",
      "state,isDraft,mergedAt,title",
      "--jq",
      '[.state, (.isDraft|tostring), (.mergedAt // "")] | @tsv',
    ]);
    if (pr.ok) {
      const [prState, isDraft, mergedAt] = pr.stdout.split("\t");
      const real: RealState =
        prState === "MERGED"
          ? "MERGED"
          : prState === "CLOSED"
            ? "CLOSED"
            : isDraft === "true"
              ? "DRAFT"
              : "OPEN";
      const when = mergedAt ? ` ${mergedAt}` : "";
      return {
        ref,
        state: real,
        repo: slug,
        detail: `PR ${real.toLowerCase()}${when} — ${title}`,
        command: `gh pr view ${ref.value} --repo ${slug} --json state,isDraft,mergedAt`,
      };
    }
  }

  return {
    ref,
    state: state === "closed" ? "CLOSED" : "OPEN",
    repo: slug,
    detail: `${kind} ${state} — ${title}`,
    command,
  };
}

async function resolveBranch(
  ref: Reference,
  slug: string,
  opts: ResolveOptions,
): Promise<Resolution> {
  const repo = repoBySlug.get(slug);
  if (!repo) {
    return { ref, state: "UNKNOWN", repo: slug, detail: "unknown repo", command: "" };
  }
  const command = `git -C ${repo.dir} ls-remote --heads ${repo.remote} refs/heads/${ref.value}`;
  const localCommand = `git -C ${repo.dir} rev-parse --verify refs/heads/${ref.value}`;

  const readLocal = async () =>
    await run("git", [
      "-C",
      repo.dir,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${ref.value}`,
    ]);

  // Offline: whether the branch is on the remote is simply not known, and
  // saying otherwise would invent the finding. Local presence is still worth
  // reporting, but it can never be reported as "absent from the remote" —
  // that conclusion requires the ls-remote that offline mode skips. Only the
  // command actually executed is quoted as proof.
  if (opts.offline) {
    const local = await readLocal();
    const has = local.ok && local.stdout.length > 0;
    return {
      ref,
      state: "UNKNOWN",
      repo: slug,
      detail: has
        ? `local branch at ${local.stdout.slice(0, 9)}; remote NOT checked (--offline), so on-remote vs deleted is unknown`
        : "no local branch; remote NOT checked (--offline)",
      command: localCommand,
    };
  }

  // ls-remote is authoritative. A local remote-tracking ref can survive a
  // branch that was deleted upstream, which is exactly the false-positive this
  // check exists to catch.
  const remote = await run("git", [
    "-C",
    repo.dir,
    "ls-remote",
    "--heads",
    repo.remote,
    `refs/heads/${ref.value}`,
  ]);
  if (!remote.ok) {
    return {
      ref,
      state: "UNKNOWN",
      repo: slug,
      detail: `ls-remote failed: ${remote.stderr.split("\n")[0]}`,
      command,
    };
  }
  if (remote.stdout.length > 0) {
    const sha = (remote.stdout.split(/\s+/)[0] ?? "").slice(0, 9);
    return {
      ref,
      state: "ON-REMOTE",
      repo: slug,
      detail: `present on ${repo.remote} at ${sha}`,
      command,
    };
  }

  // ls-remote ran and returned nothing. Now "absent from the remote" is earned.
  const local = await readLocal();
  if (local.ok && local.stdout) {
    return {
      ref,
      state: "LOCAL-ONLY",
      repo: slug,
      detail: `absent from ${repo.remote}; local branch at ${local.stdout.slice(0, 9)}`,
      command: `${command} → empty ; ${localCommand}`,
    };
  }
  return {
    ref,
    state: "ABSENT",
    repo: slug,
    detail: `absent from ${repo.remote} and from local branches`,
    command: `${command} → empty ; ${localCommand} → none`,
  };
}

async function resolveSha(
  ref: Reference,
  slug: string,
  _opts: ResolveOptions,
): Promise<Resolution> {
  const repo = repoBySlug.get(slug);
  if (!repo) {
    return { ref, state: "UNKNOWN", repo: slug, detail: "unknown repo", command: "" };
  }
  const mainRef = `${repo.remote}/main`;
  const command = `git -C ${repo.dir} merge-base --is-ancestor ${ref.value} ${mainRef}`;

  const exists = await run("git", [
    "-C",
    repo.dir,
    "cat-file",
    "-e",
    `${ref.value}^{commit}`,
  ]);
  if (!exists.ok) {
    return {
      ref,
      state: "UNKNOWN",
      repo: slug,
      detail: "commit object not present in this clone",
      command: `git -C ${repo.dir} cat-file -e ${ref.value}^{commit}`,
    };
  }

  const ancestor = await run("git", [
    "-C",
    repo.dir,
    "merge-base",
    "--is-ancestor",
    ref.value,
    mainRef,
  ]);
  const subject = await run("git", [
    "-C",
    repo.dir,
    "log",
    "-1",
    "--format=%s",
    ref.value,
  ]);
  const title = subject.ok ? subject.stdout.slice(0, 72) : "";

  if (ancestor.ok) {
    return {
      ref,
      state: "IN-MAIN",
      repo: slug,
      detail: `reachable from ${mainRef} — ${title}`,
      command,
    };
  }

  // Off main here. Before calling it orphaned, check whether the files it
  // touches now exist on some repo's main: Move B relocated whole trees between
  // these repos, so a commit can be "not on main" while the behavior it
  // introduced was reimplemented and shipped elsewhere. The 09-07 intent audit
  // found three rows of exactly this shape by hand. This does not prove the
  // behavior matches — only a human or a test can say that — so it reports
  // SUPERSEDED-ELSEWHERE for review rather than declaring the row done.
  const superseded = await supersededElsewhere(repo, ref.value);
  if (!superseded) {
    return {
      ref,
      state: "NOT-IN-MAIN",
      repo: slug,
      detail: `NOT reachable from ${mainRef} — ${title}`,
      command,
    };
  }

  const hostNames = superseded.repos.map((r) => r.split("/")[1]).join(" and ");
  const first = repoBySlug.get(superseded.repos[0] ?? "");
  return {
    ref,
    state: "SUPERSEDED-ELSEWHERE",
    repo: slug,
    detail: `NOT reachable from ${mainRef} — ${title} — but its files are present on ${hostNames} main (${superseded.hits}/${superseded.total}, e.g. ${superseded.sample})`,
    command: `${command} → false ; git -C ${first?.dir} ls-tree -r --name-only ${first?.remote}/main | grep ${superseded.sample}`,
  };
}

/**
 * Do the files a commit touches already exist on some repo's main?
 *
 * Matches on basename, because Move B moved trees to new prefixes. A majority
 * of the commit's files having to be present keeps a single shared filename
 * (`index.ts`) from triggering it.
 */
async function supersededElsewhere(
  origin: RepoSpec,
  sha: string,
): Promise<{ repos: string[]; hits: number; total: number; sample: string } | null> {
  const changed = await run("git", [
    "-C",
    origin.dir,
    "show",
    "--pretty=format:",
    "--name-only",
    sha,
  ]);
  if (!changed.ok) return null;
  const files = changed.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
  // Generic names carry no signal on their own.
  const distinctive = files.filter(
    (f) => !/^(index|types|schemas|utils|README)\.[a-z]+$/i.test(f.split("/").pop() ?? ""),
  );
  if (distinctive.length === 0) return null;

  // Report EVERY repo whose main carries the files, not the first one found.
  // After Move B a tree can be vendored into two repos at once, and naming only
  // one of them sends the reader to the less relevant place.
  const repos: string[] = [];
  let best: { hits: number; sample: string } | null = null;
  for (const repo of REPOS) {
    const tree = await run("git", [
      "-C",
      repo.dir,
      "ls-tree",
      "-r",
      "--name-only",
      `${repo.remote}/main`,
    ]);
    if (!tree.ok) continue;
    const basenames = new Set(
      tree.stdout.split("\n").map((p) => p.trim().split("/").pop() ?? ""),
    );
    const hit = distinctive.filter((f) => basenames.has(f.split("/").pop() ?? ""));
    if (hit.length > distinctive.length / 2) {
      repos.push(repo.slug);
      if (best === null || hit.length > best.hits) {
        best = { hits: hit.length, sample: (hit[0] ?? "").split("/").pop() ?? "" };
      }
    }
  }
  if (repos.length === 0 || best === null) return null;
  return {
    repos,
    hits: best.hits,
    total: distinctive.length,
    sample: best.sample,
  };
}

/** Which clones contain this commit object. A sha is globally unique in practice. */
async function reposContainingSha(value: string): Promise<string[]> {
  const found: string[] = [];
  for (const repo of REPOS) {
    const hit = await run("git", [
      "-C",
      repo.dir,
      "cat-file",
      "-e",
      `${value}^{commit}`,
    ]);
    if (hit.ok) found.push(repo.slug);
  }
  return found;
}

/** Which remotes carry this branch name, plus which clones have it locally. */
async function reposCarryingBranch(
  value: string,
  opts: ResolveOptions,
): Promise<string[]> {
  const found: string[] = [];
  for (const repo of REPOS) {
    if (!opts.offline) {
      const remote = await run("git", [
        "-C",
        repo.dir,
        "ls-remote",
        "--heads",
        repo.remote,
        `refs/heads/${value}`,
      ]);
      if (remote.ok && remote.stdout.length > 0) {
        found.push(repo.slug);
        continue;
      }
    }
    const local = await run("git", [
      "-C",
      repo.dir,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${value}`,
    ]);
    if (local.ok && local.stdout) found.push(repo.slug);
  }
  return found;
}

export async function resolve(
  ref: Reference,
  opts: ResolveOptions,
): Promise<Resolution> {
  if (ref.candidates.length !== 1) {
    // Narrow a sha by which clone actually holds the object. Safe for a sha in
    // a way it is never safe for a bare "#42".
    if (ref.kind === "sha") {
      const found = await reposContainingSha(ref.value);
      const onlyFound = found.length === 1 ? found[0] : undefined;
      if (onlyFound) {
        return await resolveSha({ ...ref, candidates: [onlyFound] }, onlyFound, opts);
      }
    }

    // Narrow a branch by which remote carries the name. Branch names in this
    // fleet are date-stamped and effectively unique across the three repos.
    if (ref.kind === "branch") {
      const found = await reposCarryingBranch(ref.value, opts);
      const onlyFound = found.length === 1 ? found[0] : undefined;
      if (onlyFound) {
        return await resolveBranch({ ...ref, candidates: [onlyFound] }, onlyFound, opts);
      }
      if (found.length === 0) {
        // Offline this means only "no local branch anywhere" — the remotes
        // were never asked, so absence cannot be concluded and must not be
        // quoted as though ls-remote had run.
        if (opts.offline) {
          return {
            ref,
            state: "UNKNOWN",
            detail:
              "no local branch in any of the three repos; remotes NOT checked (--offline)",
            command: REPOS.map(
              (r) => `git -C ${r.dir} rev-parse --verify refs/heads/${ref.value}`,
            ).join(" ; "),
          };
        }
        // Absent everywhere. The repo is undetermined, but the fact that
        // matters — the cited branch no longer exists anywhere — is certain.
        return {
          ref,
          state: "ABSENT",
          detail: `absent from all three repos (checked ${REPOS.map((r) => `${r.remote} in ${r.slug.split("/")[1]}`).join(", ")})`,
          command: REPOS.map(
            (r) => `git -C ${r.dir} ls-remote --heads ${r.remote} refs/heads/${ref.value}`,
          ).join(" ; "),
        };
      }
    }

    return {
      ref,
      state: "AMBIGUOUS",
      detail: `repo not determinable (${ref.attribution}); candidates: ${ref.candidates
        .map((c) => c.split("/")[1])
        .join(", ")}`,
      command: "",
    };
  }

  const slug = ref.candidates[0] ?? "";
  if (ref.kind === "pr-or-issue") return await resolvePrOrIssue(ref, slug, opts);
  if (ref.kind === "branch") return await resolveBranch(ref, slug, opts);
  return await resolveSha(ref, slug, opts);
}

// ---------------------------------------------------------------------------
// Disagreement rules
// ---------------------------------------------------------------------------

/**
 * Status vocabulary in the ledger is freeform prose, so classify by the claim
 * a reader would take from it rather than by exact string.
 */
export type StatusClaim = "open" | "done" | "pushed" | "acknowledged-stale" | "other";

export function classifyStatus(status: string): StatusClaim {
  const s = status.toLowerCase();
  // Order matters: "UNACCOUNTED — pushed, no PR" is a pushed-claim, not open.
  if (/\bpushed\b|\bon the remote\b|\bbranch is live\b/.test(s)) return "pushed";
  // A row whose status is literally STALE has already been marked as not
  // reflecting reality, usually with the newer state spelled out in its
  // evidence. Re-reporting it as a disagreement is noise: it agrees with the
  // reader. These rows need editing, not detecting.
  if (/\bstale\b/.test(s)) return "acknowledged-stale";

  // A completion word that comes FIRST governs the row, even when a caveat
  // follows it. "MERGED — deploy still pending" asserts the merge and defers
  // only the deploy; reading it as open would flag the merged PR it cites as a
  // contradiction of itself. Whichever kind of word appears earliest wins.
  const doneAt = s.search(
    /\b(done|closed|merged|shipped|deployed|resolved|landed|cleared)\b/,
  );
  const openAt = s.search(/\b(open|unaccounted|blocked|pending|waiting)\b/);
  if (doneAt !== -1 && (openAt === -1 || doneAt < openAt)) return "done";
  if (openAt !== -1) return "open";
  return "other";
}

export interface Finding {
  row: LedgerRow;
  resolution: Resolution;
  claim: StatusClaim;
  /** Why this is a disagreement, in the owner's terms. */
  disagreement: string;
}

/**
 * Decide whether a resolved reference contradicts the row's recorded status.
 *
 * Conservative on purpose: a row citing several references is only stale if a
 * reference actually contradicts it. "Open row cites a merged PR" is a real
 * signal; "open row cites an open PR" is the ledger working correctly.
 */
export function disagrees(row: LedgerRow, res: Resolution): string | null {
  const claim = classifyStatus(row.status);
  const { state, ref } = res;

  if (state === "AMBIGUOUS") {
    return `cites ${ref.raw} but the row names no repo, so the citation cannot be checked by anyone`;
  }
  if (state === "UNKNOWN") return null;

  // Independent of the claim: a row still pointing at a commit whose files
  // have shipped elsewhere is tracking a stale location, whatever it says.
  if (state === "SUPERSEDED-ELSEWHERE") {
    return `row tracks commit ${ref.raw}, which is not on its own main, but the files it introduced are already on another repo's main — the row is tracking a location the work has left (verify the behaviour matches before closing)`;
  }

  if (claim === "open") {
    if (state === "MERGED")
      return `status claims work is outstanding, but ${ref.raw} is MERGED`;
    if (state === "CLOSED")
      return `status claims work is outstanding, but ${ref.raw} is CLOSED`;
    if (state === "IN-MAIN")
      return `status claims work is outstanding, but commit ${ref.raw} is already on main`;
    if (state === "ABSENT")
      return `status points at branch ${ref.raw}, which no longer exists on the remote — the cited evidence is gone`;
  }

  if (claim === "pushed") {
    if (state === "ABSENT")
      return `status says the work is pushed, but branch ${ref.raw} is absent from the remote`;
    if (state === "LOCAL-ONLY")
      return `status says the work is pushed, but branch ${ref.raw} exists only locally`;
    if (state === "MERGED")
      return `status says pushed-but-not-merged, yet ${ref.raw} is MERGED`;
    if (state === "IN-MAIN")
      return `status says pushed-but-not-merged, yet commit ${ref.raw} is on main`;
  }

  if (claim === "done") {
    if (state === "OPEN")
      return `status claims completion, but ${ref.raw} is still OPEN`;
    if (state === "DRAFT")
      return `status claims completion, but ${ref.raw} is still a DRAFT and cannot be merged`;
    if (state === "ABSENT")
      return `status claims completion, but branch ${ref.raw} is absent from the remote`;
    if (state === "NOT-IN-MAIN")
      return `status claims completion, but commit ${ref.raw} is not reachable from main`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Cli {
  ledger: string;
  json: boolean;
  all: boolean;
  offline: boolean;
  strict: boolean;
  rows: Set<string>;
}

export function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    ledger: `${process.env.HOME}/code/pdpp/local/OWNER-COMMITMENTS.md`,
    json: false,
    all: false,
    offline: false,
    strict: false,
    rows: new Set(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ledger") cli.ledger = argv[(i += 1)] ?? cli.ledger;
    else if (arg === "--json") cli.json = true;
    else if (arg === "--all") cli.all = true;
    else if (arg === "--offline") cli.offline = true;
    else if (arg === "--strict") cli.strict = true;
    else if (arg === "--row") {
      const value = argv[(i += 1)];
      if (value) cli.rows.add(value);
    }
    else if (arg === "--help" || arg === "-h") {
      cli.json = false;
      console.log(
        "Usage: node --import tsx scripts/ledger-freshness.ts [--ledger <path>] [--json] [--all] [--offline] [--strict] [--row <n>]",
      );
      process.exit(0);
    }
  }
  return cli;
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const content = readFileSync(cli.ledger, "utf8");
  const allRows = parseLedger(content);
  const rows =
    cli.rows.size > 0 ? allRows.filter((r) => cli.rows.has(r.num)) : allRows;

  // Refresh first: a stale mirror reads as a stale ledger row.
  const refreshed = await refreshRemotes({ offline: cli.offline });

  const findings: Finding[] = [];
  const resolvedAll: Array<{ row: LedgerRow; resolution: Resolution }> = [];
  let refCount = 0;

  // Cache: the ledger cites the same PR from many rows.
  const cache = new Map<string, Resolution>();

  const resolveCached = async (ref: Reference): Promise<Resolution> => {
    const key = `${ref.kind}:${ref.value}:${ref.candidates.join(",")}`;
    const hit = cache.get(key);
    if (hit) return { ...hit, ref };
    const res = await resolve(ref, { offline: cli.offline });
    cache.set(key, res);
    return res;
  };

  for (const row of rows) {
    const refs = extractReferences(row);
    refCount += refs.length;

    // Pass 1.
    const pass1: Resolution[] = [];
    for (const ref of refs) pass1.push(await resolveCached(ref));

    // A reference that DID resolve pins the row's repo, which lets a sibling
    // bare "#42" in the same row be checked instead of written off as
    // ambiguous. Only pin when the row's resolved references agree on one repo.
    const pinned = new Set(
      pass1
        .filter((r) => r.state !== "AMBIGUOUS" && r.repo !== undefined)
        .map((r) => r.repo as string),
    );
    const pin = pinned.size === 1 ? [...pinned][0] : undefined;

    // Pass 2: retry the ambiguous ones against the pinned repo.
    const resolutions: Resolution[] = [];
    for (const res of pass1) {
      if (res.state === "AMBIGUOUS" && pin) {
        const narrowed: Reference = {
          ...res.ref,
          candidates: [pin],
          attribution: `${res.ref.attribution}; pinned to ${pin.split("/")[1]} by other resolved references in the same row`,
        };
        resolutions.push(await resolveCached(narrowed));
      } else {
        resolutions.push(res);
      }
    }

    for (const resolution of resolutions) {
      resolvedAll.push({ row, resolution });
      const why = disagrees(row, resolution);
      if (why) {
        findings.push({
          row,
          resolution,
          claim: classifyStatus(row.status),
          disagreement: why,
        });
      }
    }
  }

  if (cli.json) {
    console.log(
      JSON.stringify(
        {
          ledger: cli.ledger,
          remotes: refreshed,
          rowsChecked: rows.length,
          referencesResolved: refCount,
          findings: findings.map((f) => ({
            line: f.row.line,
            row: f.row.num,
            date: f.row.date,
            status: f.row.status,
            claim: f.claim,
            ref: f.resolution.ref.raw,
            kind: f.resolution.ref.kind,
            repo: f.resolution.repo ?? null,
            state: f.resolution.state,
            detail: f.resolution.detail,
            command: f.resolution.command,
            disagreement: f.disagreement,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const source = cli.all ? resolvedAll : [];
  console.log(`Ledger: ${cli.ledger}`);
  if (refreshed.length > 0) console.log(`Remotes: ${refreshed.join("   ")}`);
  console.log(
    `Rows checked: ${rows.length}   References resolved: ${refCount}   Disagreements: ${findings.length}`,
  );
  console.log("");

  if (cli.all) {
    console.log("ALL RESOLVED REFERENCES");
    for (const { row, resolution } of source) {
      console.log(
        `  row ${row.num} (line ${row.line})  ${resolution.ref.raw}  → ${resolution.state}  ${shorten(resolution.detail, 90)}`,
      );
    }
    console.log("");
  }

  // Two classes, reported apart. A row whose status contradicts a resolved
  // reference is a stale row the owner must act on. A row whose citation cannot
  // be attributed to a repo is a hygiene problem in the record. Mixing them
  // buries the first under the second: on 2026-09-07 the counts were 34 and 198.
  const stale = findings.filter((f) => f.resolution.state !== "AMBIGUOUS");
  const uncheckable = findings.filter((f) => f.resolution.state === "AMBIGUOUS");

  if (stale.length === 0) {
    console.log("No row disagrees with reality.");
  } else {
    console.log(
      `STALE ROWS — recorded status disagrees with current state (${stale.length} findings across ${new Set(stale.map((f) => f.row.line)).size} rows)`,
    );
    console.log("");
  }
  for (const f of stale) {
    console.log(`row ${f.row.num} (line ${f.row.line}, ${f.row.date})`);
    console.log(`  commitment : ${shorten(f.row.text, 100)}`);
    console.log(`  recorded   : ${shorten(f.row.status, 100)}`);
    console.log(
      `  reality    : ${f.resolution.ref.raw} → ${f.resolution.state}${
        f.resolution.repo ? ` [${f.resolution.repo.split("/")[1]}]` : ""
      } — ${shorten(f.resolution.detail, 90)}`,
    );
    console.log(`  why stale  : ${f.disagreement}`);
    if (f.resolution.command) console.log(`  proof      : ${f.resolution.command}`);
    console.log("");
  }

  if (uncheckable.length === 0) return;

  const byRow = new Map<number, Finding[]>();
  for (const f of uncheckable) {
    const list = byRow.get(f.row.line) ?? [];
    list.push(f);
    byRow.set(f.row.line, list);
  }

  console.log(
    `UNCHECKABLE CITATIONS — ${uncheckable.length} references across ${byRow.size} rows name no repo, so no one can verify them`,
  );
  if (!cli.strict) {
    console.log("(summary only; run with --strict to list every one)");
  }
  console.log("");
  for (const [line, group] of byRow) {
    const first = group[0];
    if (!first) continue;
    const refs = group.map((f) => f.resolution.ref.raw);
    const shown = cli.strict ? refs : refs.slice(0, 6);
    const more = refs.length - shown.length;
    console.log(
      `row ${first.row.num} (line ${line}): ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`,
    );
  }
  console.log("");
  console.log(
    'Fix by writing the repo next to the number, e.g. "data-connect#50" instead of "#50".',
  );
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].split("/").pop() ?? " ");

if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
