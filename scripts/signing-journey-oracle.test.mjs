// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { buildCommand, createReceipt, extractLinks, sanitizeUrl } from "./signing-journey-oracle.mjs";

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
    "",
    "This is the only email this system sends.",
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
  assert.equal(receipt.finishedAt, null);
  assert.deepEqual(receipt.steps, []);
  // `ok` starts false so a run that dies before it can write a verdict is read
  // as a failure, never as a pass that simply stopped early.
  assert.equal(receipt.ok, false);
  assert.ok(!Number.isNaN(Date.parse(receipt.startedAt)));
});
