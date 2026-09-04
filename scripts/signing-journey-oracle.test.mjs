// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPreviewRegisterBranch,
  buildCommand,
  createReceipt,
  describeCommandError,
  extractLinks,
  looksLikeVercelPreview,
  normalizeEmail,
  recordPathFromCommit,
  redactLink,
  sanitizeUrl,
  waitForCommit,
} from "./signing-journey-oracle.mjs";

// The link sanitizer is the one part of the oracle worth testing offline: it is
// the only step that parses attacker-influenced text that has also been through
// a mail transport, and every one of its failure modes is silent — a corrupted
// token still looks like a link and fails later as an "invalid" outcome, which
// would be reported as a broken signing flow rather than a broken parse.

const TOKEN = "eyJpZCI6ImFiYyJ9.c2lnbmF0dXJl-_x";
const BASE = "https://pdpp-preview.vercel.app";

test("sanitizeUrl reads a plain link to its end", () => {
  const body = `${BASE}/api/sign/confirm?token=${TOKEN}`;
  assert.equal(sanitizeUrl(body, 0), body);
});

test("sanitizeUrl stops at whitespace and keeps the rest of the body out", () => {
  const url = `${BASE}/api/sign/confirm?token=${TOKEN}`;
  assert.equal(sanitizeUrl(`${url}\r\n\r\nIf you did not do this, ignore this email.`, 0), url);
});

test("sanitizeUrl trims prose punctuation that is not part of the link", () => {
  const url = `${BASE}/api/sign/confirm?token=${TOKEN}`;
  // A sentence ending, a parenthetical, and a quoted link all end in characters
  // a URL may legally contain but in an email body virtually never does.
  assert.equal(sanitizeUrl(`${url}.`, 0), url);
  assert.equal(sanitizeUrl(`${url}).`, 0), url);
  assert.equal(sanitizeUrl(`<${url}>`, 1), url);
  assert.equal(sanitizeUrl(`${url},`, 0), url);
});

test("sanitizeUrl reads from an offset inside a longer body", () => {
  const url = `${BASE}/api/sign/withdraw?token=${TOKEN}`;
  const body = `Keep this message. To withdraw at any time, use this link:\n${url}\n`;
  assert.equal(sanitizeUrl(body, body.indexOf(url)), url);
});

test("sanitizeUrl refuses anything that is not an absolute http(s) URL", () => {
  assert.equal(sanitizeUrl("javascript:alert(1)", 0), null);
  assert.equal(sanitizeUrl("data:text/html,hi", 0), null);
  assert.equal(sanitizeUrl("/api/sign/confirm?token=abc", 0), null);
  assert.equal(sanitizeUrl("", 0), null);
  assert.equal(sanitizeUrl("   ", 0), null);
  assert.equal(sanitizeUrl(null, 0), null);
});

test("sanitizeUrl does not let a wrapped line splice two tokens together", () => {
  // A transport that hard-wraps mid-token leaves the two halves on separate
  // lines. Reading must stop at the break rather than silently produce a token
  // that is half of one link and half of the next.
  const wrapped = `${BASE}/api/sign/confirm?token=eyJpZCI6\r\nImFiYyJ9.sig`;
  assert.equal(sanitizeUrl(wrapped, 0), `${BASE}/api/sign/confirm?token=eyJpZCI6`);
});

test("extractLinks finds the confirm and withdraw links in a real email body", () => {
  const confirm = `${BASE}/api/sign/confirm?token=${TOKEN}`;
  const withdraw = `${BASE}/api/sign/withdraw?token=${TOKEN}`;
  const body = [
    "You asked to sign the PDPP Principles.",
    "",
    "Confirm your signature (this link expires in 48 hours and can be used once):",
    confirm,
    "",
    "If you did not do this, ignore this email and nothing will be published.",
    "",
    "Keep this message. To withdraw at any time, use this link:",
    withdraw,
  ].join("\r\n");

  assert.deepEqual(extractLinks(body, BASE, "/api/sign/confirm"), [confirm]);
  assert.deepEqual(extractLinks(body, BASE, "/api/sign/withdraw"), [withdraw]);
});

test("extractLinks ignores links belonging to another deployment", () => {
  // This is the filter that stops a stale email from a different preview being
  // mistaken for this run's. Previews share one mailbox, so without it the
  // oracle can pass while testing a build nobody asked for.
  const other = "https://pdpp-someothersha.vercel.app";
  const body = `Confirm:\n${other}/api/sign/confirm?token=${TOKEN}\n`;
  assert.deepEqual(extractLinks(body, BASE, "/api/sign/confirm"), []);
  assert.deepEqual(extractLinks(body, other, "/api/sign/confirm"), [`${other}/api/sign/confirm?token=${TOKEN}`]);
});

test("extractLinks tolerates a trailing slash on the configured base URL", () => {
  const confirm = `${BASE}/api/sign/confirm?token=${TOKEN}`;
  assert.deepEqual(extractLinks(`x ${confirm} y`, `${BASE}/`, "/api/sign/confirm"), [confirm]);
});

test("extractLinks returns nothing for a body that is not a string", () => {
  assert.deepEqual(extractLinks(undefined, BASE, "/api/sign/confirm"), []);
});

test("buildCommand substitutes placeholders and keeps quoted arguments whole", () => {
  assert.deepEqual(buildCommand("gog gmail search {query} -j --results-only", { query: "to:a@b.com" }), [
    "gog",
    "gmail",
    "search",
    "to:a@b.com",
    "-j",
    "--results-only",
  ]);
  assert.deepEqual(buildCommand("gog gmail get {id} -j", { id: "abc123" }), ["gog", "gmail", "get", "abc123", "-j"]);
  // A quoted argument stays one argv entry, so a reader whose query needs a
  // space is not silently split into two arguments.
  assert.deepEqual(buildCommand('my-reader --query "subject:{query}"', { query: "hello" }), [
    "my-reader",
    "--query",
    "subject:hello",
  ]);
  // An unknown placeholder is left alone rather than becoming "undefined".
  assert.deepEqual(buildCommand("reader {nope}", { query: "x" }), ["reader", "{nope}"]);
});

test("createReceipt has the documented shape and starts as a failure", () => {
  const receipt = createReceipt({
    baseUrl: BASE,
    branch: "signatures",
    email: "a@b.com",
    keep: false,
    owner: "PDP-Connect",
    repo: "supporters-private",
  });

  assert.equal(receipt.schema, "pdpp.signing-journey-oracle/v1");
  assert.equal(receipt.baseUrl, BASE);
  assert.equal(receipt.email, "a@b.com");
  assert.equal(receipt.keep, false);
  assert.equal(receipt.repo, "PDP-Connect/supporters-private#signatures");
  assert.equal(receipt.signatoryId, null);
  assert.equal(receipt.links, null);
  assert.equal(receipt.finishedAt, null);
  assert.deepEqual(receipt.steps, []);
  // `ok` starts false so a run that dies before it can write a verdict is read
  // as a failure, never as a pass that simply stopped early.
  assert.equal(receipt.ok, false);
  assert.ok(!Number.isNaN(Date.parse(receipt.startedAt)));
});

test("createReceipt keeps every documented key present when the run is misconfigured", () => {
  // A missing SIGNING_BASE_URL now writes a receipt rather than exiting 2, so
  // this shape is the one a reader most needs to parse. `JSON.stringify` drops
  // undefined keys, so absent config has to become null, not vanish.
  const receipt = createReceipt({
    branch: "signatures",
    keep: false,
    owner: "PDP-Connect",
    repo: "supporters-private",
  });
  const round = JSON.parse(JSON.stringify(receipt));

  assert.ok("baseUrl" in round, "baseUrl must survive JSON round-trip");
  assert.ok("email" in round, "email must survive JSON round-trip");
  assert.equal(round.baseUrl, null);
  assert.equal(round.email, null);
  assert.equal(round.links, null);
});

// --------------------------------------------------------------- recency filter

// `waitForCommit` matches on a commit SUBJECT, and one of the three subjects the
// oracle waits for — "Record a withdrawal" — carries no run identifier, because
// the app writes that same subject for every withdrawal by anyone. Without a
// recency floor the very first poll matches a withdrawal from an earlier run and
// step 6 passes without this run having logged anything. That is the one vacuous
// pass the withdraw step exists to rule out, so it is asserted directly.

/** A github stub whose `commits` listing returns exactly `commits`, recording the query it was given. */
function stubGitHub(commits) {
  const queries = [];
  return {
    queries,
    request(pathname, searchParams) {
      queries.push({ pathname, searchParams });
      return Promise.resolve({ json: () => Promise.resolve(commits), ok: true, status: 200 });
    },
  };
}

function commitEntry(subject, isoDate, sha = "0".repeat(40)) {
  return { commit: { committer: { date: isoDate }, message: `${subject}\n\nSigned-off-by: bot <bot@pdpp.dev>` }, sha };
}

test("waitForCommit ignores a matching commit that predates this run", async () => {
  const since = Date.parse("2026-09-03T12:00:00Z");
  const github = stubGitHub([commitEntry("Record a withdrawal", "2026-09-03T11:59:00Z", "a".repeat(40))]);

  await assert.rejects(
    () => waitForCommit(github, "signatures", "Record a withdrawal", { since, timeoutMs: 0 }),
    /no commit titled "Record a withdrawal"/
  );
});

test("waitForCommit accepts a matching commit made during this run", async () => {
  const since = Date.parse("2026-09-03T12:00:00Z");
  const github = stubGitHub([
    commitEntry("Record a withdrawal", "2026-09-03T11:00:00Z", "a".repeat(40)),
    commitEntry("Record a withdrawal", "2026-09-03T12:00:30Z", "b".repeat(40)),
  ]);

  const match = await waitForCommit(github, "signatures", "Record a withdrawal", { since, timeoutMs: 0 });
  assert.equal(match.sha, "b".repeat(40));
});

test("waitForCommit passes `since` to GitHub so the listing itself is bounded", async () => {
  const since = Date.parse("2026-09-03T12:00:00Z");
  const github = stubGitHub([commitEntry("Record a withdrawal", "2026-09-03T12:00:30Z")]);

  await waitForCommit(github, "signatures", "Record a withdrawal", { since, timeoutMs: 0 });
  assert.equal(github.queries[0].searchParams.since, "2026-09-03T12:00:00.000Z");
});

test("waitForCommit tolerates a commit whose committer date is missing", async () => {
  // GitHub has always returned this field, but a commit without it must not be
  // silently treated as recent — that would reopen the hole this filter closes.
  const since = Date.parse("2026-09-03T12:00:00Z");
  const github = stubGitHub([{ commit: { message: "Record a withdrawal" }, sha: "c".repeat(40) }]);

  await assert.rejects(() => waitForCommit(github, "signatures", "Record a withdrawal", { since, timeoutMs: 0 }));
});

// ------------------------------------------------------------------ record path

// The signatory file lives under the year of the CONFIRMATION, which the app
// takes from the record it just wrote. Deriving that year from the oracle's own
// wall clock instead is correct for all but one second a year: a confirm at
// 23:59:59 on 31 December and a read at 00:00:00 on 1 January look in different
// directories, and the oracle reports a missing file rather than a clock skew.
// The commit is already in hand at that point, so the path is read from it.

test("recordPathFromCommit reads the path out of the commit that wrote it", () => {
  const commit = {
    files: [{ filename: "signatories/2026/1111-2222.json", status: "added" }],
    sha: "d".repeat(40),
  };
  assert.equal(recordPathFromCommit(commit, "1111-2222"), "signatories/2026/1111-2222.json");
});

test("recordPathFromCommit crosses a UTC new year without guessing", () => {
  // The case the wall clock gets wrong: confirmed in 2026, read in 2027.
  const commit = { files: [{ filename: "signatories/2026/abc.json", status: "added" }] };
  assert.equal(recordPathFromCommit(commit, "abc"), "signatories/2026/abc.json");
});

test("recordPathFromCommit ignores files belonging to another signatory", () => {
  const commit = {
    files: [
      { filename: "withdrawn.log", status: "modified" },
      { filename: "signatories/2026/other-id.json", status: "added" },
    ],
  };
  assert.equal(recordPathFromCommit(commit, "abc"), null);
});

test("recordPathFromCommit returns null when the commit carries no file list", () => {
  // The caller must fall back rather than fetch `undefined`.
  assert.equal(recordPathFromCommit({}, "abc"), null);
  assert.equal(recordPathFromCommit({ files: [] }, "abc"), null);
});

// ----------------------------------------------------------- email normalisation

// The submission schema is `z.string().trim().toLowerCase()`, so the address the
// repo stores is the lowercased one. Comparing the stored value against the raw
// env var makes a correct write look like a broken one, and the failure message
// points at the private repo rather than at this comparison.

test("normalizeEmail matches what the signing schema stores", () => {
  assert.equal(normalizeEmail("Tim.Nunamaker@Example.COM"), "tim.nunamaker@example.com");
  assert.equal(normalizeEmail("  spaced@example.com  "), "spaced@example.com");
  assert.equal(normalizeEmail("already@lower.com"), "already@lower.com");
});

// ------------------------------------------------------------------- redaction

// The receipt is an ordinary file on disk and the confirm/withdraw links are
// live single-use credentials. The operator needs to know WHICH link a run used
// — which deployment, which path, which token — without the token itself being
// readable from the receipt.

test("redactLink keeps origin, path and a token fingerprint but not the token", () => {
  const token = "eyJpZCI6ImFiYyJ9.c2lnbmF0dXJl-_x";
  const redacted = redactLink(`${BASE}/api/sign/confirm?token=${token}`);

  assert.equal(redacted.url, `${BASE}/api/sign/confirm?token=REDACTED`);
  assert.equal(redacted.tokenFingerprint, "eyJpZCI6");
  assert.ok(!JSON.stringify(redacted).includes(token));
  assert.ok(!JSON.stringify(redacted).includes("c2lnbmF0dXJl"));
});

test("redactLink survives a link with no token at all", () => {
  const redacted = redactLink(`${BASE}/api/sign/confirm`);
  assert.equal(redacted.url, `${BASE}/api/sign/confirm`);
  assert.equal(redacted.tokenFingerprint, null);
});

test("redactLink returns null rather than throwing on a non-URL", () => {
  assert.equal(redactLink(null), null);
  assert.equal(redactLink("not a url"), null);
});

// ---------------------------------------------------------- command redaction

// `SIGNING_MAILBOX_SEARCH_CMD` is operator-supplied and documented as swappable,
// so a replacement reader may well carry a credential in its argv. `execFile`
// puts the whole command line into `error.message`, and that string is written
// into the receipt on a mailbox failure. Only the program name and the exit
// status may cross into the receipt.

test("describeCommandError names the program and the exit status, never the arguments", () => {
  const error = Object.assign(
    new Error("Command failed: my-reader --password hunter2 --query to:a@b.com\nauth failed for hunter2\n"),
    { code: 2 }
  );
  const described = describeCommandError(["my-reader", "--password", "hunter2", "--query", "to:a@b.com"], error);

  assert.ok(described.includes("my-reader"));
  assert.ok(described.includes("2"));
  assert.ok(!described.includes("hunter2"), described);
  assert.ok(!described.includes("--password"), described);
  assert.ok(!described.includes("to:a@b.com"), described);
});

test("describeCommandError reports a timeout and a missing program distinguishably", () => {
  const timedOut = Object.assign(new Error("Command failed: my-reader --password hunter2"), {
    killed: true,
    signal: "SIGTERM",
  });
  assert.ok(describeCommandError(["my-reader", "--password", "hunter2"], timedOut).includes("timed out"));

  const missing = Object.assign(new Error("spawn my-reader ENOENT"), { code: "ENOENT" });
  const described = describeCommandError(["my-reader", "--password", "hunter2"], missing);
  assert.ok(described.includes("not found"), described);
  assert.ok(!described.includes("hunter2"), described);
});

test("describeCommandError never leaks stderr, which can echo an argument back", () => {
  const error = Object.assign(new Error("Command failed"), {
    code: 1,
    stderr: "fatal: token ghp_realsecret rejected\n",
  });
  const described = describeCommandError(["reader"], error);
  assert.ok(!described.includes("ghp_realsecret"), described);
});

// ------------------------------------------------------------- register branch
//
// A rehearsal writes a real confirmed record. The branch it lands on is the
// difference between disposable test data and production data a maintainer has
// to remove by hand, so the refusal is asserted in both directions.

test("a preview target refuses to track the production register", () => {
  const refusal = assertPreviewRegisterBranch({
    baseUrl: "https://pdpp-git-feature-pdpp.vercel.app",
    branch: "signatures",
  });

  assert.match(refusal ?? "", /refusing to run a preview rehearsal against signatures/);
  assert.match(refusal ?? "", /PDPP_PRIVATE_REPO_BRANCH=signatures-preview/);
});

test("a preview target on the preview register is allowed", () => {
  assert.equal(
    assertPreviewRegisterBranch({
      baseUrl: "https://pdpp-git-feature-pdpp.vercel.app",
      branch: "signatures-preview",
    }),
    null
  );
});

test("SIGNING_TARGET=preview refuses signatures on an origin the URL cannot classify", () => {
  const refusal = assertPreviewRegisterBranch({
    baseUrl: "https://staging.pdpp.dev",
    branch: "signatures",
    target: "preview",
  });

  assert.match(refusal ?? "", /refusing to run a preview rehearsal against signatures/);
});

test("SIGNING_TARGET=production overrides a vercel.app production alias", () => {
  assert.equal(
    assertPreviewRegisterBranch({
      baseUrl: "https://pdpp.vercel.app",
      branch: "signatures",
      target: "production",
    }),
    null
  );
});

test("SIGNING_TARGET=production refuses to track the preview register", () => {
  const refusal = assertPreviewRegisterBranch({
    baseUrl: "https://pdpp.dev",
    branch: "signatures-preview",
    target: "production",
  });

  assert.match(refusal ?? "", /SIGNING_TARGET=production cannot track signatures-preview/);
});

test("an unrecognised SIGNING_TARGET is rejected rather than treated as production", () => {
  const refusal = assertPreviewRegisterBranch({
    baseUrl: "https://pdpp-git-feature-pdpp.vercel.app",
    branch: "signatures",
    target: "prod",
  });

  assert.match(refusal ?? "", /SIGNING_TARGET must be "preview" or "production"/);
});

test("a production origin on the production register is allowed", () => {
  assert.equal(assertPreviewRegisterBranch({ baseUrl: "https://pdpp.dev", branch: "signatures" }), null);
});

test("looksLikeVercelPreview reads the host, and a malformed URL is not a preview", () => {
  assert.equal(looksLikeVercelPreview("https://pdpp-git-x-pdpp.vercel.app/principles"), true);
  assert.equal(looksLikeVercelPreview("https://pdpp.dev"), false);
  assert.equal(looksLikeVercelPreview("not a url"), false);
});
