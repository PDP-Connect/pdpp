#!/usr/bin/env node
// End-to-end oracle for the Supporter signing journey (apps/site).
//
// WHY THIS EXISTS
// The signing flow crosses four systems that no unit test can join up: a Next.js
// route, a KV store, a mail provider, and a write to a private GitHub repo. Each
// seam is mocked in isolation, and mocks encode the same assumptions as the code
// that calls them. The failures that matter here are the ones that live BETWEEN
// the parts — a confirmation email whose links point at the wrong deployment, a
// token that verifies but whose pending record was never stored, a signatory
// file that lands on a branch nobody publishes from. Every one of those passes a
// green unit suite and breaks the real journey.
//
// So this walks the journey the way a supporter does, against a real deployment,
// and asserts the observable outcome of every step:
//
//   1. POST a valid individual submission        -> 303 /principles?signed=pending
//   2. Poll the mailbox for the confirmation      -> confirm + withdraw links
//   3. GET the confirm link, then POST its form   -> 303 signed=confirmed
//   4. Check GitHub                               -> "Add signatory <id>" commit,
//                                                    Signed-off-by trailer, and a
//                                                    signatory file whose public
//                                                    fields match what was sent
//   5. POST the confirmation form AGAIN           -> 303 signed=invalid (single use)
//   6. GET the withdraw link                      -> 303 withdraw=done, and the
//                                                    "Record a withdrawal" commit
//
// Every commit assertion is bounded to commits made after this run started. One
// of the three subjects — "Record a withdrawal" — is a constant the app writes
// for every withdrawal by anyone, so without that bound the first poll of step 6
// would match an earlier run's commit and pass having proven nothing.
//
// Step 6 is skipped under --keep, which leaves a real confirmed entry in place so
// it can be published. Use --keep only with an address you mean to publish.
//
// WHAT IT DOES NOT PROVE
//   - It does not prove the PUBLIC register renders the entry. Publication is a
//     separate scheduled script in the private repo; this stops at the private
//     write, which is the last step the site itself controls.
//   - The Signed-off-by trailer is added by the SITE, in `botCommitMessage`
//     (apps/site/src/lib/signing/providers.ts), and every write goes through it.
//     Asserting it here checks that the trailer the app composes survives the
//     round trip to GitHub and back — not that any repo setting is in force.
//     Nothing here checks the repo's own "require sign-off on web-based commits"
//     policy; that would need a separate read of the repo settings via the API.
//   - It never runs against a deployment it was not pointed at: every mailbox
//     match is filtered on links whose origin equals SIGNING_BASE_URL, because
//     previews share one mailbox and a stale email from another deployment is
//     the single most likely way this could silently pass against the wrong
//     build.
//
// USAGE
//   SIGNING_BASE_URL=https://<deployment> \
//   SIGNING_TEST_EMAIL=you@example.com \
//     node scripts/signing-journey-oracle.mjs [--keep] [--receipt path] [--quiet]
//
//   The site allows 5 submissions per IP per hour (RATE_LIMIT_MAX in
//   providers.ts). A sixth run within the hour fails at step 1 with a 429; the
//   window is a rolling hour, so wait up to an hour and retry. That matters here
//   more than usual, because the point of this script is repeated end-to-end
//   runs from one address and one IP.
//
// REHEARSALS RUN ON THE PREVIEW REGISTER
//   A run against a preview deployment writes a real, confirmed signatory record.
//   Written to `signatures` it is production data that a maintainer then has to
//   remove by hand — which has already happened once. So preview deployments
//   write `signatures-preview`, a disposable branch started empty from private
//   `main`, and this oracle REFUSES to track `signatures` for a preview target
//   (see `assertPreviewRegisterBranch`). The site enforces the same boundary in
//   `resolveRegisterBranch` (apps/site/src/lib/signing/providers.ts); this check
//   exists so the oracle fails at setup rather than polling a branch the
//   deployment is not allowed to write.
//
//   Use a marked owner-controlled address for every rehearsal — a
//   `you+pdpp-test-<run>@example.com` alias, one per run. Gmail and most
//   providers deliver a `+suffix` address to the same mailbox, so the oracle
//   still reads it, and the marking makes a stray rehearsal record identifiable
//   in the register by its address alone. This is an operations convention. The
//   branch boundary is the hard guard; the alias is not.
//
//   Preview records are NOT withdrawals from the production register. After a
//   rehearsal, delete the marked records from `signatures-preview` or reset that
//   branch to its empty base. Never publish it and never copy its
//   `withdrawn.log` into production.
//
// ENVIRONMENT
//   SIGNING_BASE_URL           required. Preview or production origin.
//   SIGNING_TEST_EMAIL         required. Address the confirmation is sent to.
//   SIGNING_MAILBOX_SEARCH_CMD mailbox search command. Default:
//                              `gog gmail messages search {query} -j --results-only`
//                              NOTE `messages search`, not `search`: the latter
//                              returns THREAD ids, and Gmail threads every
//                              confirmation together under one subject. Fetching
//                              a thread id yields the OLDEST message in it, so a
//                              thread-level reader hands this oracle a stale
//                              email from a previous run — or a previous
//                              deployment — every time. Observed, not theorised.
//   SIGNING_MAILBOX_GET_CMD    mailbox fetch command. Default:
//                              `gog gmail get {id} -j --results-only`
//   GITHUB_TOKEN               optional. Falls back to `gh auth token`.
//   PDPP_PRIVATE_REPO_OWNER    default PDP-Connect
//   PDPP_PRIVATE_REPO_NAME     default supporters-private
//   PDPP_PRIVATE_REPO_BRANCH   default signatures. Must be signatures-preview
//                              when SIGNING_BASE_URL is a Vercel preview.
//   SIGNING_TARGET             optional. `preview` or `production`. Says which
//                              the deployment is when the URL does not, e.g. a
//                              preview behind a custom domain or a local run.
//
// Exit 0 only if every step passed. Any failure exits 1 with the receipt written,
// including a missing SIGNING_BASE_URL or SIGNING_TEST_EMAIL: that failure is
// recorded as a `setup` step so a job that keys off the receipt can tell
// misconfiguration from a crash. There is no other exit code.

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAILBOX_POLL_TIMEOUT_MS = 180_000;
const MAILBOX_POLL_INTERVAL_MS = 10_000;
const REPO_POLL_TIMEOUT_MS = 90_000;
const REPO_POLL_INTERVAL_MS = 5000;
const HTTP_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 60_000;

// ------------------------------------------------------------------- sanitizer

/**
 * The strict URL charset an extracted link may contain.
 *
 * Links are pulled out of an email body, which is attacker-influenced text that
 * has also been through a mail transport. Two things go wrong there and both are
 * silent: a transport wraps a long line and injects `\r\n` or `=\n` mid-token, or
 * the body carries trailing punctuation that a naive match swallows into the
 * URL. Either produces a token that still LOOKS like a link and fails as a
 * 404 or an "invalid" outcome, which this oracle would then report as a broken
 * flow rather than a broken parse.
 *
 * So the charset is an allowlist, not a denylist: unreserved characters plus the
 * sub-delims and reserved characters that legitimately appear in these URLs. A
 * base64url token uses only [A-Za-z0-9_-], and the URL around it needs `:/?=&.~`
 * and friends. Anything outside that set ends the URL.
 */
const URL_SAFE = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;

/**
 * Trailing characters that are punctuation of the surrounding PROSE far more
 * often than part of the link. A URL may legally end in `)` or `.`, but in an
 * email body ending a sentence it almost never does, and the cost of the two
 * mistakes is asymmetric: trimming a real trailing `.` breaks loudly at the
 * fetch, while keeping a sentence's `.` corrupts the token silently.
 */
const TRAILING_JUNK = /[.,;:!?)\]}'"<>]+$/;

/**
 * Extracts and sanitizes a single URL starting at `index` in `text`.
 * Returns null if what is there is not a usable absolute http(s) URL.
 *
 * NOT origin-safe on its own. It will happily return
 * `https://your-site.example.com@evil.com/...`, because a userinfo section is
 * legal URL syntax. What rejects a lookalike host is `extractLinks`, which
 * searches for `origin + pathname` as a literal prefix. Anyone reusing this
 * function outside `extractLinks` has to do that origin check themselves.
 *
 * Exported for the unit test: this is the one piece of the oracle with enough
 * edge cases to be worth testing in isolation, and the only piece that can be
 * tested without a live deployment.
 */
export function sanitizeUrl(text, index = 0) {
  if (typeof text !== "string") {
    return null;
  }
  let end = index;
  while (end < text.length && URL_SAFE.test(text[end])) {
    end += 1;
  }
  const candidate = text.slice(index, end).replace(TRAILING_JUNK, "");
  if (!candidate) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  // Only http(s). An extracted `javascript:` or `data:` link is never something
  // this oracle should fetch, and refusing it here means no caller has to think
  // about it.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return parsed.toString();
}

/**
 * Finds every link in `body` that points at `pathname` on `origin`.
 *
 * Filtering on origin is what stops a stale email from a DIFFERENT preview
 * deployment being mistaken for this run's. Previews share one mailbox, so this
 * is the difference between an oracle that tests the build you asked for and one
 * that occasionally tests last night's.
 */
export function extractLinks(body, origin, pathname) {
  if (typeof body !== "string") {
    return [];
  }
  const found = [];
  const needle = `${origin.replace(/\/$/, "")}${pathname}`;
  let cursor = 0;
  for (;;) {
    const at = body.indexOf(needle, cursor);
    if (at === -1) {
      break;
    }
    cursor = at + needle.length;
    const url = sanitizeUrl(body, at);
    if (url) {
      found.push(url);
    }
  }
  return found;
}

/**
 * Normalizes an address the way the signing schema does.
 *
 * The schema is `z.string().trim().toLowerCase()`, so the address stored in the
 * private repo is the lowercased one. Comparing the stored record against the
 * raw SIGNING_TEST_EMAIL instead would make a correct write look like a broken
 * one for any operator whose address has a capital in it — and the failure
 * message would point at the repo rather than at this comparison, which is
 * exactly the silent misdirection the rest of this file works to avoid.
 */
export function normalizeEmail(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Describes a signing link for the receipt without putting the token on disk.
 *
 * The receipt is an ordinary file and these links are live single-use
 * credentials, so the token itself must not be in it. But the operator needs to
 * know which deployment and which link a run used — under `--keep` the entry is
 * deliberately left live and withdrawable only from the email, and a failure at
 * the confirm or withdraw step otherwise cannot be re-driven by hand. Origin,
 * path, and a short fingerprint of the token body answer "which link was this?"
 * without answering "what is the token?".
 *
 * The fingerprint is the first 8 characters of the base64url body — the same
 * segment step 4 already decodes to read the signatory id — so two runs are
 * always distinguishable, and it is far too short to reconstruct a signature.
 */
export function redactLink(link) {
  let parsed;
  try {
    parsed = new URL(link);
  } catch {
    return null;
  }
  const token = parsed.searchParams.get("token");
  const fingerprint = token ? (token.split(".")[0] ?? "").slice(0, 8) || null : null;
  if (token) {
    parsed.searchParams.set("token", "REDACTED");
  }
  return { tokenFingerprint: fingerprint, url: parsed.toString() };
}

// -------------------------------------------------------------- register branch

const PRODUCTION_REGISTER_BRANCH = "signatures";
const PREVIEW_REGISTER_BRANCH = "signatures-preview";

/**
 * Recognises a Vercel preview origin from its hostname alone.
 *
 * Vercel gives every preview a `*.vercel.app` host, and production is served
 * from the project's own domain. A preview behind a custom domain is therefore
 * invisible here, which is why `SIGNING_TARGET` exists: this returns what the
 * URL can prove, and the operator says the rest.
 *
 * A production `*.vercel.app` alias exists too, so this is deliberately not the
 * only input to the decision — it makes a run MORE careful, never less.
 */
export function looksLikeVercelPreview(baseUrl) {
  let host;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  return host.endsWith(".vercel.app");
}

/**
 * Returns an error string when the target and the register branch disagree.
 * Returns null when the pair is allowed.
 *
 * A rehearsal against a preview writes a REAL confirmed record. Written to
 * `signatures` it is production data a maintainer removes by hand — which has
 * already happened. So a preview run tracking `signatures` is refused outright
 * rather than warned about: the site's own guard rejects the write, and polling
 * a branch the deployment cannot write only turns a clear setup error into a
 * 90-second timeout with a misleading message.
 *
 * `SIGNING_TARGET=production` with `signatures-preview` is refused for the
 * mirror-image reason: it would poll a branch production never writes.
 *
 * Exported for the unit test; this is a pure decision with no deployment.
 */
export function assertPreviewRegisterBranch({ baseUrl, branch, target }) {
  const declared = String(target ?? "")
    .trim()
    .toLowerCase();
  if (declared && declared !== "preview" && declared !== "production") {
    return `SIGNING_TARGET must be "preview" or "production", not ${JSON.stringify(declared)}`;
  }
  const isPreview = declared ? declared === "preview" : looksLikeVercelPreview(baseUrl);

  if (isPreview && branch !== PREVIEW_REGISTER_BRANCH) {
    return (
      `refusing to run a preview rehearsal against ${branch}: a preview deployment writes ` +
      `${PREVIEW_REGISTER_BRANCH}, and a confirmed record on ${PRODUCTION_REGISTER_BRANCH} is production data. ` +
      `Set PDPP_PRIVATE_REPO_BRANCH=${PREVIEW_REGISTER_BRANCH}, or SIGNING_TARGET=production if this origin is production.`
    );
  }
  if (declared === "production" && branch !== PRODUCTION_REGISTER_BRANCH) {
    return `SIGNING_TARGET=production cannot track ${branch}: production writes ${PRODUCTION_REGISTER_BRANCH}`;
  }
  return null;
}

// ---------------------------------------------------------------- mailbox reader

/**
 * Splits a command template into argv, substituting `{query}` / `{id}`.
 *
 * The mailbox is behind a command rather than a library on purpose: the default
 * reader is one person's authenticated `gog`, and anyone else running this has a
 * different one. A template keeps the reader swappable without this file knowing
 * anything about Gmail.
 */
export function buildCommand(template, substitutions) {
  const parts = template.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((part) => {
    const unquoted = part.replace(/^["']|["']$/g, "");
    return unquoted.replace(/\{(\w+)\}/g, (whole, key) =>
      Object.hasOwn(substitutions, key) ? substitutions[key] : whole
    );
  });
}

async function runCommand(argv) {
  const [command, ...args] = argv;
  const { stdout } = await execFileAsync(command, args, {
    maxBuffer: 32 * 1024 * 1024,
    timeout: COMMAND_TIMEOUT_MS,
  });
  return stdout;
}

/**
 * Describes a failed command using only its program name and how it failed.
 *
 * `execFile` puts the ENTIRE command line into `error.message`, and stderr can
 * echo an argument straight back. The mailbox reader is operator-supplied and
 * documented as swappable, so a replacement invoked as
 * `my-reader --password hunter2 --query {query}` would put that password into
 * `error.message` — and this oracle writes mailbox failures into the receipt,
 * which is an ordinary file on disk. The default `gog` reader carries no secret
 * in argv, so nothing leaks today; the point of the template is that someone
 * else's reader is different.
 *
 * So the arguments and stderr never cross into the returned string. The program
 * name and the exit status are enough to act on: they say which reader was run
 * and whether it was missing, timed out, or refused.
 */
export function describeCommandError(argv, error) {
  const program = argv[0] ?? "<none>";
  if (error?.code === "ENOENT") {
    return `\`${program}\` not found on PATH`;
  }
  if (error?.killed || error?.signal) {
    return `\`${program}\` timed out after ${COMMAND_TIMEOUT_MS}ms`;
  }
  if (typeof error?.code === "number") {
    return `\`${program}\` exited ${error.code} (arguments and output withheld: an operator-supplied reader may carry a credential in either)`;
  }
  return `\`${program}\` failed (arguments and output withheld: an operator-supplied reader may carry a credential in either)`;
}

/**
 * Normalizes the two mailbox shapes this needs into `{ id, subject, to, body }`.
 *
 * A reader is only required to emit JSON with a recognisable id on search, and
 * a body plus headers on get. Both `gog` shapes and a plain `{id, subject}` list
 * work, so a replacement reader does not have to imitate `gog` exactly.
 */
function normalizeSearchResults(raw) {
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : (parsed.messages ?? parsed.results ?? []);
  return list
    .map((entry) => ({
      id: entry.id ?? entry.messageId ?? entry.threadId ?? null,
      subject: entry.subject ?? "",
      date: entry.date ?? "",
    }))
    .filter((entry) => entry.id);
}

function normalizeMessage(raw) {
  const parsed = JSON.parse(raw);
  const headers = parsed.headers ?? {};
  return {
    body: parsed.body ?? parsed.text ?? "",
    subject: headers.subject ?? parsed.subject ?? "",
    to: headers.to ?? parsed.to ?? "",
    internalDate: parsed.message?.internalDate ?? null,
  };
}

// ------------------------------------------------------------------------ steps

class StepFailure extends Error {}

function fail(message) {
  throw new StepFailure(message);
}

async function fetchNoRedirect(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  return response;
}

/**
 * Asserts a 303 whose Location carries `expected` as a query pair.
 *
 * The status is asserted as well as the target because a 200 that renders the
 * right-looking page is a different system than a redirect, and the form posts
 * expect the redirect: a browser that gets a 200 here shows a JSON body.
 */
function assertRedirect(response, expectedQuery, label) {
  if (response.status !== 303) {
    fail(`${label}: expected 303, got ${response.status}`);
  }
  const location = response.headers.get("location");
  if (!location) {
    fail(`${label}: 303 with no Location header`);
  }
  const target = new URL(location, "http://placeholder.invalid");
  const [key, value] = expectedQuery;
  const actual = target.searchParams.get(key);
  if (actual !== value) {
    fail(`${label}: expected ${key}=${value}, got ${key}=${actual ?? "<absent>"} (Location: ${location})`);
  }
  if (target.pathname !== "/principles") {
    fail(`${label}: expected redirect to /principles, got ${target.pathname}`);
  }
  return location;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------------ github

function createGitHub(token, owner, repo) {
  async function request(pathname, searchParams = {}) {
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/${pathname}`);
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "pdpp-signing-journey-oracle",
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return response;
  }
  return { request };
}

async function resolveGitHubToken() {
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const stdout = await runCommand(["gh", "auth", "token"]);
    const token = stdout.trim();
    if (token) {
      return token;
    }
  } catch {
    // fall through to the explicit error below
  }
  fail("no GitHub credential: set GITHUB_TOKEN or run `gh auth login`");
}

/**
 * Waits for a commit with `subject` on `branch`, made at or after `since`.
 *
 * Polls rather than reading once because the confirm request returns as soon as
 * the GitHub write is accepted, and the commits list is eventually consistent —
 * a single immediate read is a flake generator.
 *
 * `since` is not optional, and it is the difference between this proving
 * something and proving nothing. Two of the three subjects waited for here embed
 * a per-run uuid, so they are run-unique by accident of how the app names them.
 * The third, "Record a withdrawal", is a CONSTANT — the app writes that same
 * subject for every withdrawal by anybody. Matching on subject alone, any
 * earlier withdrawal sitting in the recent history satisfies step 6 on the first
 * poll, so the step passes without this run having logged anything. That is the
 * precise defect step 6 exists to catch, so the floor is applied to every wait
 * rather than only to the one that needs it.
 *
 * It is applied twice: `since` is passed to the API so the listing is bounded
 * server-side, and each candidate's committer date is checked, so a stale entry
 * cannot slip through if the parameter is ever ignored. A commit with no
 * committer date is rejected — treating it as recent would reopen the hole.
 */
export async function waitForCommit(github, branch, subject, { since, timeoutMs }) {
  const sinceIso = new Date(since).toISOString();
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    const response = await github.request("commits", { per_page: "20", sha: branch, since: sinceIso });
    if (response.ok) {
      const commits = await response.json();
      const match = commits.find((entry) => {
        if (entry.commit?.message?.split("\n")[0] !== subject) {
          return false;
        }
        const committedAt = Date.parse(entry.commit?.committer?.date ?? "");
        return Number.isFinite(committedAt) && committedAt >= since;
      });
      if (match) {
        return match;
      }
      lastError = `no commit titled "${subject}" on ${branch} since ${sinceIso} (${commits.length} in range)`;
    } else {
      lastError = `GitHub responded ${response.status} listing commits on ${branch}`;
    }
    if (Date.now() >= deadline) {
      fail(lastError);
    }
    await sleep(REPO_POLL_INTERVAL_MS);
  }
}

/**
 * Reads this signatory's record path out of the commit that wrote it.
 *
 * The app files the record under the year of its CONFIRMATION
 * (`recordPath` in apps/site/src/lib/signing/index.ts:
 * `signatories/${record.confirmedAt.slice(0, 4)}/${record.id}.json`). Deriving
 * that year from this process's wall clock instead is right for all but one
 * second a year: a confirm at 2026-12-31T23:59:59Z read back at
 * 2027-01-01T00:00:00Z looks in `signatories/2027/` for a file the app wrote to
 * `signatories/2026/`, and reports it missing. The commit is already in hand, so
 * the year does not have to be guessed at all.
 *
 * Returns null if the commit carries no usable file list, which lets the caller
 * fall back rather than fetch an undefined path.
 */
export function recordPathFromCommit(commit, signatoryId) {
  const files = Array.isArray(commit?.files) ? commit.files : [];
  const suffix = `/${signatoryId}.json`;
  const match = files.find((file) => file?.filename?.startsWith("signatories/") && file.filename.endsWith(suffix));
  return match?.filename ?? null;
}

// -------------------------------------------------------------------- the journey

/**
 * The receipt shape. Every step appends one entry, pass or fail, so a failed run
 * still says exactly how far the journey got — which is the whole reason this
 * writes a receipt rather than just exiting.
 */
export function createReceipt(config) {
  return {
    schema: "pdpp.signing-journey-oracle/v1",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: false,
    // Defaulted to null rather than left undefined: a misconfigured run writes a
    // receipt too, and `JSON.stringify` drops undefined keys — which would make
    // the one receipt a reader most needs to parse the one with a missing field.
    baseUrl: config.baseUrl ?? null,
    email: config.email || null,
    keep: config.keep,
    repo: `${config.owner}/${config.repo}#${config.branch}`,
    signatoryId: null,
    // Filled in once the confirmation email is read. Redacted — see `redactLink`.
    links: null,
    steps: [],
  };
}

function record(receipt, name, status, detail) {
  receipt.steps.push({ name, status, detail, at: new Date().toISOString() });
}

async function main() {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep");
  const quiet = argv.includes("--quiet");
  const receiptIndex = argv.indexOf("--receipt");
  const receiptPath =
    receiptIndex !== -1 && argv[receiptIndex + 1] ? argv[receiptIndex + 1] : "signing-journey-receipt.json";

  const log = (message) => {
    if (!quiet) {
      console.error(message);
    }
  };

  const baseUrl = process.env.SIGNING_BASE_URL?.trim().replace(/\/$/, "");
  // Normalized the way the signing schema does, so the address compared against
  // the stored record in step 4 is the address the app actually stored.
  const email = normalizeEmail(process.env.SIGNING_TEST_EMAIL);

  const owner = process.env.PDPP_PRIVATE_REPO_OWNER?.trim() || "PDP-Connect";
  const repo = process.env.PDPP_PRIVATE_REPO_NAME?.trim() || "supporters-private";
  const branch = process.env.PDPP_PRIVATE_REPO_BRANCH?.trim() || "signatures";
  const searchTemplate =
    process.env.SIGNING_MAILBOX_SEARCH_CMD?.trim() || "gog gmail messages search {query} -j --results-only";
  const getTemplate = process.env.SIGNING_MAILBOX_GET_CMD?.trim() || "gog gmail get {id} -j --results-only";

  const config = { baseUrl, branch, email, keep, owner, repo };
  const receipt = createReceipt(config);

  // The run is stamped so the signatory file can be told apart from every other
  // entry in the register, including previous runs of this oracle.
  const runStamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  const submission = {
    signatory_kind: "individual",
    name: `Signing Oracle ${runStamp}`,
    email,
    affiliation: "PDPP Signing Journey Oracle",
    country: "United States",
    principles_version: "1",
    consent_principles: "on",
    consent_register: "on",
    consent_age: "on",
    // Sent explicitly, and NOT because this oracle wants the mailing list.
    // `consent_updates` is `z.union([z.literal("on"), z.undefined()])`, which in
    // zod 4 requires the KEY TO BE PRESENT — a submission that simply omits it
    // is rejected with the same opaque 400 as a malformed one. A browser never
    // hits this because the form always submits the checkbox, so the rule is
    // invisible until something posts the documented minimum field set. Proven
    // against the live preview: identical submissions differing only in this
    // key returned 400 without it and 303 with it.
    consent_updates: "on",
  };

  try {
    // Checked inside the try so a misconfigured run leaves a receipt like every
    // other failure does. A CI job that keys off "a receipt exists, read its
    // steps" would otherwise be unable to tell a missing env var from a crash.
    if (!(baseUrl && email)) {
      fail("SIGNING_BASE_URL and SIGNING_TEST_EMAIL are both required");
    }

    // Checked before anything is submitted. A preview run tracking `signatures`
    // would write a real confirmed record into the production register, and by
    // the time the branch mismatch showed up as a polling timeout the record
    // would already exist.
    const branchMismatch = assertPreviewRegisterBranch({
      baseUrl,
      branch,
      target: process.env.SIGNING_TARGET,
    });
    if (branchMismatch) {
      fail(branchMismatch);
    }

    const token = await resolveGitHubToken();
    const github = createGitHub(token, owner, repo);

    // The mailbox is read from `since` onward so an earlier confirmation for the
    // same address on the same deployment can never be mistaken for this run's.
    const since = Date.now();

    // ---- step 1: submit
    log("1/6 submitting…");
    const submitResponse = await fetchNoRedirect(`${baseUrl}/api/sign`, {
      body: new URLSearchParams(submission),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    if (submitResponse.status === 404) {
      fail("POST /api/sign returned 404: signing is not enabled on this deployment");
    }
    if (submitResponse.status === 429) {
      fail(
        "POST /api/sign returned 429: the site allows 5 submissions per IP per hour, " +
          "and this is the sixth within a rolling hour. Wait up to an hour and retry."
      );
    }
    if (submitResponse.status === 303) {
      const location = submitResponse.headers.get("location");
      const state = location ? new URL(location, baseUrl).searchParams.get("signed") : null;
      if (state === "closed") {
        fail("POST /api/sign redirected with signed=closed: signing is not enabled on this deployment");
      }
      if (state === "ratelimited") {
        fail(
          "POST /api/sign redirected with signed=ratelimited: the site allows 5 submissions per IP per hour, " +
            "and this is the sixth within a rolling hour. Wait up to an hour and retry."
        );
      }
    }
    const submitLocation = assertRedirect(submitResponse, ["signed", "pending"], "submit");
    record(receipt, "submit", "pass", `303 -> ${submitLocation}`);
    log(`    ok: 303 -> ${submitLocation}`);

    // ---- step 2: read the mailbox
    log("2/6 waiting for the confirmation email…");
    const deadline = Date.now() + MAILBOX_POLL_TIMEOUT_MS;
    let links = null;
    let mailboxError = "no matching message arrived";
    for (;;) {
      let candidates = [];
      const searchArgv = buildCommand(searchTemplate, {
        query: `to:${email} subject:"Confirm your PDPP Principles signature"`,
      });
      try {
        candidates = normalizeSearchResults(await runCommand(searchArgv));
      } catch (error) {
        // Redacted, because this string is written into the receipt and the
        // reader is operator-supplied. See `describeCommandError`. A JSON.parse
        // failure lands here too, and its message quotes the reader's STDOUT —
        // which for a reader that echoes its own invocation is another way a
        // credential reaches the receipt. Neither shape is reported verbatim.
        mailboxError =
          error instanceof SyntaxError
            ? `mailbox search failed: \`${searchArgv[0]}\` did not emit JSON (output withheld)`
            : `mailbox search failed: ${describeCommandError(searchArgv, error)}`;
      }

      for (const candidate of candidates.slice(0, 10)) {
        let message;
        try {
          message = normalizeMessage(await runCommand(buildCommand(getTemplate, { id: candidate.id })));
        } catch {
          continue;
        }
        // Three independent filters, because any one of them alone has a way to
        // match the wrong email: the address (right person), the origin of the
        // links (right deployment), and the arrival time (this run, not a
        // previous one against the same deployment).
        if (!message.to.toLowerCase().includes(email.toLowerCase())) {
          continue;
        }
        if (message.internalDate && Number(message.internalDate) < since - 120_000) {
          continue;
        }
        const confirmLinks = extractLinks(message.body, baseUrl, "/api/sign/confirm");
        const withdrawLinks = extractLinks(message.body, baseUrl, "/api/sign/withdraw");
        if (confirmLinks.length > 0 && withdrawLinks.length > 0) {
          links = {
            confirm: confirmLinks[0],
            messageId: candidate.id,
            subject: message.subject,
            withdraw: withdrawLinks[0],
          };
          break;
        }
        mailboxError = `a message reached ${email} but carried no ${baseUrl} signing links`;
      }

      if (links || Date.now() >= deadline) {
        break;
      }
      await sleep(MAILBOX_POLL_INTERVAL_MS);
    }
    if (!links) {
      fail(mailboxError);
    }
    // Recorded redacted. The operator needs to know which links a run used —
    // under --keep the entry is left live and withdrawable ONLY from the email,
    // so the receipt is the natural second copy of that withdraw link, and a
    // failure at step 3 or 5 otherwise cannot be re-driven without the mailbox.
    // The tokens themselves stay off disk: they are live single-use credentials.
    receipt.links = { confirm: redactLink(links.confirm), withdraw: redactLink(links.withdraw) };
    record(receipt, "confirmation-email", "pass", `"${links.subject}" with confirm and withdraw links on ${baseUrl}`);
    log(`    ok: "${links.subject}"`);

    // ---- step 3: load the safe landing page, then explicitly confirm
    log("3/6 opening the confirmation page…");
    const confirmPage = await fetchNoRedirect(links.confirm);
    if (confirmPage.status !== 200 || confirmPage.headers.get("cache-control") !== "no-store") {
      fail(`confirm-page: expected no-store 200, got ${confirmPage.status}`);
    }
    const confirmPageBody = await confirmPage.text();
    if (!/<form action="\/api\/sign\/confirm" method="post">/.test(confirmPageBody)) {
      fail("confirm-page: explicit confirmation form was missing");
    }
    log("    ok: no-store confirmation page");
    log("    confirming…");
    const confirmToken = new URL(links.confirm).searchParams.get("token") ?? "";
    const confirmResponse = await fetchNoRedirect(`${baseUrl}/api/sign/confirm`, {
      body: new URLSearchParams({ token: confirmToken }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const confirmLocation = assertRedirect(confirmResponse, ["signed", "confirmed"], "confirm");
    record(receipt, "confirm", "pass", `303 -> ${confirmLocation}`);
    log(`    ok: 303 -> ${confirmLocation}`);

    // ---- step 4: the private repo write
    log("4/6 verifying the private repo commit…");
    // The id is the token's subject, so it is read from the link rather than
    // guessed: it is the only thing tying the HTTP journey to the repo write.
    const tokenBody = confirmToken.split(".")[0] ?? "";
    let signatoryId = null;
    try {
      signatoryId = JSON.parse(Buffer.from(tokenBody, "base64url").toString("utf8")).id ?? null;
    } catch {
      fail("could not read the signatory id out of the confirm token");
    }
    if (!signatoryId) {
      fail("confirm token carried no signatory id");
    }
    receipt.signatoryId = signatoryId;

    const addCommit = await waitForCommit(github, branch, `Add signatory ${signatoryId}`, {
      since,
      timeoutMs: REPO_POLL_TIMEOUT_MS,
    });
    // The trailer is composed by the app, in `botCommitMessage`. This asserts it
    // survived the round trip to GitHub; it is not a check on any repo setting.
    if (!/^Signed-off-by: .+ <.+>$/m.test(addCommit.commit.message)) {
      fail(`commit ${addCommit.sha.slice(0, 8)} has no Signed-off-by trailer`);
    }

    // The path is read out of the commit rather than assembled from the clock:
    // the app files the record under the year of its confirmation, and the two
    // disagree across a UTC new year. The commits LISTING carries no file list,
    // so the commit is re-read on its own endpoint, which does.
    const addCommitDetail = await github.request(`commits/${addCommit.sha}`);
    if (!addCommitDetail.ok) {
      fail(`could not read commit ${addCommit.sha.slice(0, 8)}: GitHub responded ${addCommitDetail.status}`);
    }
    const filePath = recordPathFromCommit(await addCommitDetail.json(), signatoryId);
    if (!filePath) {
      fail(`commit ${addCommit.sha.slice(0, 8)} added no signatories/**/${signatoryId}.json file`);
    }

    // The file is read at the commit that added it, not at the branch tip: the
    // withdrawal in step 6 deletes it, so a tip read would race the same run.
    const fileResponse = await github.request(`contents/${filePath}`, { ref: addCommit.sha });
    if (!fileResponse.ok) {
      fail(`signatory file ${filePath} not readable at ${addCommit.sha.slice(0, 8)}: ${fileResponse.status}`);
    }
    const stored = JSON.parse(Buffer.from((await fileResponse.json()).content, "base64").toString("utf8"));

    // Only the fields the submission actually carried are asserted. Checking the
    // derived ones (publicName, confirmedAt) here would restate the app's own
    // logic; what this can prove that a unit test cannot is that what the form
    // sent is what the repo received, across every seam in between.
    const expectations = [
      ["id", signatoryId],
      ["displayName", submission.name],
      ["email", submission.email],
      ["country", submission.country],
      ["organisation", submission.affiliation],
      ["type", "Individual"],
      ["principlesVersion", submission.principles_version],
    ];
    for (const [field, expected] of expectations) {
      if (stored[field] !== expected) {
        fail(`signatory file ${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(stored[field])}`);
      }
    }
    if (stored.consent?.principles !== true || stored.consent?.register !== true) {
      fail(`signatory file consent not recorded: ${JSON.stringify(stored.consent)}`);
    }
    record(
      receipt,
      "private-repo-write",
      "pass",
      `${addCommit.sha.slice(0, 8)} "Add signatory ${signatoryId}" signed off, ${filePath} matches the submission`
    );
    log(`    ok: ${addCommit.sha.slice(0, 8)} ${filePath}`);

    // ---- step 5: the link is single use
    log("5/6 re-using the confirmation form…");
    const replayResponse = await fetchNoRedirect(`${baseUrl}/api/sign/confirm`, {
      body: new URLSearchParams({ token: confirmToken }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const replayLocation = assertRedirect(replayResponse, ["signed", "invalid"], "confirm-replay");
    record(receipt, "confirm-single-use", "pass", `second use -> ${replayLocation}`);
    log(`    ok: 303 -> ${replayLocation}`);

    // ---- step 6: withdraw
    if (keep) {
      record(receipt, "withdraw", "skipped", "--keep: the entry was left on the register for publication");
      log("6/6 skipped (--keep): the entry is live and withdrawable from the email");
    } else {
      log("6/6 withdrawing…");
      const withdrawResponse = await fetchNoRedirect(links.withdraw);
      const withdrawLocation = assertRedirect(withdrawResponse, ["withdraw", "done"], "withdraw");

      // `withdraw=done` is reported whether or not a file was found — that is
      // deliberate in the route, so it is NOT evidence on its own. The commits
      // are. Both are required: the delete proves this signatory was removed,
      // the log proves the withdrawal was accounted for.
      //
      // Both are bounded by `since`. "Withdraw signatory <id>" embeds this run's
      // uuid and so is run-unique on its own, but "Record a withdrawal" is a
      // constant subject the app writes for every withdrawal by anyone — an
      // earlier run's log commit would otherwise satisfy this on the first poll
      // and the assertion would prove nothing.
      const withdrawCommit = await waitForCommit(github, branch, `Withdraw signatory ${signatoryId}`, {
        since,
        timeoutMs: REPO_POLL_TIMEOUT_MS,
      });
      const logCommit = await waitForCommit(github, branch, "Record a withdrawal", {
        since,
        timeoutMs: REPO_POLL_TIMEOUT_MS,
      });
      record(
        receipt,
        "withdraw",
        "pass",
        `303 -> ${withdrawLocation}; ${withdrawCommit.sha.slice(0, 8)} deleted the file, ` +
          `${logCommit.sha.slice(0, 8)} appended to withdrawn.log`
      );
      log(`    ok: 303 -> ${withdrawLocation}`);
    }

    receipt.ok = true;
  } catch (error) {
    const detail = error instanceof StepFailure ? error.message : `unexpected: ${error.message}`;
    // The failing step is named after the one that was about to run, so the
    // receipt reads as "everything before this passed, this is where it stopped".
    record(receipt, receipt.steps.length === 0 ? "setup" : "journey", "fail", detail);
    receipt.ok = false;
    log(`    FAILED: ${detail}`);
  }

  receipt.finishedAt = new Date().toISOString();
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  log(`receipt: ${receiptPath}`);
  process.exit(receipt.ok ? 0 : 1);
}

// Only run when executed directly, so the unit test can import the helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
