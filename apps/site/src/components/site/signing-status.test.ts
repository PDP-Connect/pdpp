// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PdppSigningStatus, signedStatusMessage } from "./signing-status.tsx";

const signedStates = [
  "pending",
  "incomplete",
  "ratelimited",
  "unavailable",
  "closed",
  "confirmed",
  "error",
  "invalid",
  "withdrawn",
];
const withdrawStates = ["done", "invalid", "error", "closed"];
const STATUS_SLOT = /data-slot="pdpp-signing-status"/;
const STATUS_ROLE = /role="status"/;
const UNKNOWN_SIGNED_STATUS = /We could not identify that signing status\. Nothing was changed\./;

test("each signing state renders an inline message", () => {
  for (const signed of signedStates) {
    const html = renderToStaticMarkup(createElement(PdppSigningStatus, { signed }));
    assert.match(html, STATUS_SLOT, signed);
    assert.match(html, STATUS_ROLE, signed);
  }
});

test("an unknown signing state renders a specific fallback message", () => {
  const html = renderToStaticMarkup(createElement(PdppSigningStatus, { signed: "unexpected" }));
  assert.match(html, UNKNOWN_SIGNED_STATUS);
  assert.equal(signedStatusMessage("unexpected"), "We could not identify that signing status. Nothing was changed.");
});

test("each withdrawal state renders an inline message", () => {
  for (const withdraw of withdrawStates) {
    const html = renderToStaticMarkup(createElement(PdppSigningStatus, { withdraw }));
    assert.match(html, STATUS_SLOT, withdraw);
    assert.match(html, STATUS_ROLE, withdraw);
  }
});
