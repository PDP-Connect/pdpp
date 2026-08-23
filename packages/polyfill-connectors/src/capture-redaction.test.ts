// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the credential leak fixed in this change.
 *
 * A real owner password was written in plaintext to seven capture files
 * because `page.ariaSnapshot()` serializes the VALUE of a filled form field
 * and the capture path wrote that result verbatim. The raw/ tree is
 * agent-readable, so a later scrubbing pass was not a defense.
 *
 * The literals below are the shapes taken from real Playwright output,
 * verified against a live browser rather than assumed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Page } from "playwright";

import { redactAriaSnapshot, redactDomHtml } from "./capture-redaction.ts";
import { createCaptureSession } from "./fixture-capture.ts";

/** The credential shape that actually leaked. */
const SECRET = "BG54aFvx";

const ARIA_WITH_FILLED_PASSWORD = [
  "- generic [ref=e2]:",
  "  - text: Username",
  '  - textbox "Username" [ref=e3]: tim@example.com',
  '  - textbox "Password" [ref=e25]: BG54aFvx',
  '  - textbox "One-time code" [active] [ref=e5]: "123456"',
  '  - textbox "Password" [ref=e9]:',
].join("\n");

function withCaptureEnv<T>(body: () => T): T {
  const previous = process.env.PDPP_CAPTURE_FIXTURES;
  process.env.PDPP_CAPTURE_FIXTURES = "1";
  try {
    return body();
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_CAPTURE_FIXTURES;
    } else {
      process.env.PDPP_CAPTURE_FIXTURES = previous;
    }
  }
}

test("aria snapshot never writes a filled password value to disk", async () => {
  await withCaptureEnv(async () => {
    const capture = createCaptureSession(`redact_aria_${process.pid}_${Date.now()}`);
    assert.ok(capture);

    const page: Pick<Page, "ariaSnapshot" | "content" | "screenshot" | "title" | "url"> = {
      ariaSnapshot: () => Promise.resolve(ARIA_WITH_FILLED_PASSWORD),
      content: () => Promise.resolve("<html><body></body></html>"),
      screenshot: () => Promise.resolve(Buffer.from("png")),
      title: () => Promise.resolve("Login"),
      url: () => "https://venmo.test/login",
    };

    await capture.captureDom(page as Page, "login");
    const written = readFileSync(`${capture.baseDir}/aria/login.aria.yml`, "utf8");

    // The defect: this substring was present on the production volume.
    assert.ok(!written.includes(SECRET), `password value leaked into aria capture:\n${written}`);
    assert.match(written, /textbox "Password" \[ref=e25\]: \[REDACTED\]/);
  });
});

test("redaction preserves that a field existed and whether it was filled", () => {
  const out = redactAriaSnapshot(ARIA_WITH_FILLED_PASSWORD);

  // Structure survives: role, accessible name and ref are all still readable.
  assert.match(out, /textbox "Password" \[ref=e25\]: \[REDACTED\]/);
  // A filled field is still distinguishable from an empty one — the exact
  // distinction that diagnosed the real login failure.
  assert.match(out, /textbox "Password" \[ref=e9\]:$/m);
  assert.ok(!out.includes("[ref=e9]: [REDACTED]"), "an empty field must not be reported as filled");
  // The container node is untouched.
  assert.match(out, /^- generic \[ref=e2\]:$/m);
});

test("a non-sensitive field value is not redacted", () => {
  const out = redactAriaSnapshot(ARIA_WITH_FILLED_PASSWORD);

  assert.match(out, /textbox "Username" \[ref=e3\]: tim@example\.com/);
  assert.match(out, /- text: Username/);
});

test("an otp field value is redacted and keeps its quoting", () => {
  const out = redactAriaSnapshot(ARIA_WITH_FILLED_PASSWORD);

  assert.ok(!out.includes("123456"));
  assert.match(out, /textbox "One-time code" \[active\] \[ref=e5\]: "\[REDACTED\]"/);
});

test("a known credential is redacted even in a field nobody labelled secret", () => {
  const snapshot = `  - textbox "Nickname" [ref=e8]: ${SECRET}`;

  assert.equal(redactAriaSnapshot(snapshot, [SECRET]), '  - textbox "Nickname" [ref=e8]: [REDACTED]');
  // Without the run's credentials the field-based rules cannot see it — this
  // is precisely why value registration exists.
  assert.ok(redactAriaSnapshot(snapshot, []).includes(SECRET));
});

test("a colon inside an accessible name is not mistaken for a value separator", () => {
  const snapshot = '  - textbox "Time: HH:MM" [ref=e7]: 09:30';

  assert.equal(redactAriaSnapshot(snapshot), snapshot);
});

test("dom capture never writes a password value attribute to disk", async () => {
  await withCaptureEnv(async () => {
    const capture = createCaptureSession(`redact_dom_${process.pid}_${Date.now()}`);
    assert.ok(capture);

    // page.content() serializes the value ATTRIBUTE. A typed password does not
    // appear, but a server-rendered or setAttribute-set one does — verified
    // against a live browser.
    const html = `<html><body><input id="pw" name="password" type="password" value="${SECRET}"><input id="u" name="username" type="text" value="tim@example.com"></body></html>`;
    const page: Pick<Page, "ariaSnapshot" | "content" | "screenshot" | "title" | "url"> = {
      ariaSnapshot: () => Promise.resolve("- generic:"),
      content: () => Promise.resolve(html),
      screenshot: () => Promise.resolve(Buffer.from("png")),
      title: () => Promise.resolve("Login"),
      url: () => "https://venmo.test/login",
    };

    await capture.captureDom(page as Page, "login");
    const written = readFileSync(`${capture.baseDir}/dom/login.html`, "utf8");

    assert.ok(!written.includes(SECRET), `password value leaked into dom capture:\n${written}`);
    assert.match(written, /name="password" type="password" value="\[REDACTED\]"/);
  });
});

test("dom redaction keeps the field present and leaves non-sensitive values alone", () => {
  const html = `<input name="password" type="password" value="${SECRET}"><input name="username" type="text" value="tim@example.com">`;
  const out = redactDomHtml(html);

  // The input still exists, with its type and name, so the page is still
  // debuggable — only the credential is gone.
  assert.match(out, /<input name="password" type="password" value="\[REDACTED\]">/);
  assert.match(out, /<input name="username" type="text" value="tim@example\.com">/);
});

test("an unlabelled password input is redacted by its type alone", () => {
  // Deliberately no secret-ish name, id or placeholder: `type` is the ONLY
  // signal, so this fails if the type rule is dropped and the name-fragment
  // rule is left to carry the case on its own.
  const out = redactDomHtml(`<input name="field1" id="f1" type="password" value="${SECRET}">`);

  assert.equal(out, '<input name="field1" id="f1" type="password" value="[REDACTED]">');
});

test("a known credential in a non-secret dom field is redacted by value", () => {
  const html = `<input name="nickname" type="text" value="${SECRET}">`;

  assert.ok(!redactDomHtml(html, [SECRET]).includes(SECRET));
  assert.ok(redactDomHtml(html, []).includes(SECRET));
});
