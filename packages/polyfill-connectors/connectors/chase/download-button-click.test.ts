// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the QFX Download button click path.
 *
 * Live evidence (run_1786072649511, UAT container pdpp-pr81-uat, connection
 * cin_c2f766b7166a6184adf021aa, 2026-08-07T03:18:42.473Z): the connector's
 * own error message proves the CSS host locator RESOLVED —
 *   "waiting for locator('mds-button#download') - locator resolved"
 * — yet the subsequent `.click({ timeout: 10000 })` still timed out.
 * `mds-button` is a custom element (see
 * __fixtures__/current-activity-download-form-no-rows.html:29 —
 * `<mds-button id="download" label="Download"></mds-button>` with no light-DOM
 * children): its accessible name and interactive target live in shadow DOM.
 * A resolved host-element locator only proves the host is attached/visible,
 * not that Playwright's actionability checks (stable, receives pointer
 * events, enabled) can be satisfied against it — exactly the same
 * locator-vs-actionability gap already fixed for the Activity and File Type
 * controls (see clickActivityControl/clickFileTypeControl above), which use
 * a CSS-id-first, semantic-role-fallback strategy because Chase's MDS
 * elements are known to be unreliable for pure CSS-locator interaction.
 *
 * clickDownloadButton() applies that same two-tier strategy to the Download
 * button. These tests prove:
 *   - the CSS locator is tried first (cheap path stays cheap),
 *   - a CSS click failure (the observed failure mode) falls back to the
 *     semantic role locator and succeeds when the shadow-DOM button is
 *     reachable that way,
 *   - both locators failing surfaces a diagnostic error naming both
 *     failure reasons, not just the first one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright";
import { clickDownloadButton } from "./index.ts";

interface ClickCall {
  kind: "css" | "role";
}

interface FakeLocatorOptions {
  clickError?: Error | undefined;
}

function makeClickOnlyLocator(calls: ClickCall[], kind: ClickCall["kind"], opts: FakeLocatorOptions): Locator {
  const base: Pick<Locator, "click" | "first"> = {
    click(_options?: Parameters<Locator["click"]>[0]): ReturnType<Locator["click"]> {
      calls.push({ kind });
      if (opts.clickError) {
        return Promise.reject(opts.clickError);
      }
      return Promise.resolve();
    },
    first(): Locator {
      return base as Locator;
    },
  };
  return base as Locator;
}

function makePage(opts: { cssClickError?: Error; roleClickError?: Error }): { calls: ClickCall[]; page: Page } {
  const calls: ClickCall[] = [];
  const fake: Pick<Page, "getByRole" | "locator"> = {
    getByRole(role: Parameters<Page["getByRole"]>[0], options?: Parameters<Page["getByRole"]>[1]): Locator {
      assert.equal(role, "button");
      assert.match(String((options as { name?: RegExp })?.name), /download/i);
      return makeClickOnlyLocator(calls, "role", { clickError: opts.roleClickError });
    },
    locator(selector: Parameters<Page["locator"]>[0]): Locator {
      assert.equal(selector, "mds-button#download");
      return makeClickOnlyLocator(calls, "css", { clickError: opts.cssClickError });
    },
  };
  return { calls, page: fake as Page };
}

test("clickDownloadButton clicks the CSS host locator directly when it succeeds", async () => {
  const { calls, page } = makePage({});

  await clickDownloadButton(page);

  assert.deepEqual(
    calls.map((call) => call.kind),
    ["css"],
    "expected only the CSS host click, no semantic-role fallback needed"
  );
});

test("clickDownloadButton falls back to the semantic role locator when the CSS host click times out", async () => {
  // Reproduces the exact observed failure: the host-element locator
  // resolves (attached + visible) but .click()'s actionability wait times
  // out against the shadow-DOM button underneath it.
  const cssClickError = new Error(
    "locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('mds-button#download')\n    - locator resolved"
  );
  const { calls, page } = makePage({ cssClickError });

  await clickDownloadButton(page);

  assert.deepEqual(
    calls.map((call) => call.kind),
    ["css", "role"],
    "expected the CSS click to be attempted, fail, then the role-based click to succeed"
  );
});

test("clickDownloadButton surfaces both failure reasons when the CSS and role click both fail", async () => {
  const cssClickError = new Error("locator.click: Timeout 10000ms exceeded (css)");
  const roleClickError = new Error("locator.click: Timeout 10000ms exceeded (role)");
  const { page } = makePage({ cssClickError, roleClickError });

  await assert.rejects(clickDownloadButton(page), (err: Error) => {
    assert.match(err.message, /download_button_unavailable/);
    assert.match(err.message, /selector=mds-button#download/);
    assert.match(err.message, /\(css\)/);
    assert.match(err.message, /role=/);
    assert.match(err.message, /\(role\)/);
    assert.equal(err.cause, roleClickError);
    return true;
  });
});
