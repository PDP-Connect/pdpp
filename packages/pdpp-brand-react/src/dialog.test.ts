// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  IcDialog,
  IcDialogBackdrop,
  IcDialogClose,
  IcDialogDescription,
  IcDialogPopup,
  IcDialogPortal,
  IcDialogTitle,
  IcDialogTrigger,
} from "./dialog.tsx";

// IcDialog is a thin Ink Carbon skin over @base-ui/react's Dialog: base-ui owns
// focus-trap / dismissal / portal, this module owns ONLY the token styling.
// These checks pin (1) that the full base-ui surface is re-exported with the
// caller-facing names the console uses, and (2) that the styled parts that
// render inline (Trigger) carry the Ink Carbon contract.

const TRIGGER_BTN_TOKEN = /<button[^>]*class="[^"]*pdpp-btn/;
const TRIGGER_LABEL = />Open<\/button>/;
const POPUP_TITLE = /Clipboard/;

test("IcDialog re-exports the full base-ui Dialog surface", () => {
  for (const part of [
    IcDialog,
    IcDialogTrigger,
    IcDialogPortal,
    IcDialogClose,
    IcDialogBackdrop,
    IcDialogPopup,
    IcDialogTitle,
    IcDialogDescription,
  ]) {
    assert.ok(part, "every dialog part must be exported");
  }
});

test("IcDialogTrigger renders a button and forwards props (className merged)", () => {
  const html = renderToStaticMarkup(
    createElement(IcDialog, null, createElement(IcDialogTrigger, { className: "pdpp-btn pdpp-btn--ghost" }, "Open"))
  );
  // base-ui Trigger renders a real <button> by default; our extra class rides along.
  assert.match(html, TRIGGER_BTN_TOKEN);
  assert.match(html, TRIGGER_LABEL);
});

test("a closed IcDialog does not render its popup (base-ui owns open state)", () => {
  const html = renderToStaticMarkup(
    createElement(
      IcDialog,
      null,
      createElement(IcDialogTrigger, null, "Open"),
      createElement(
        IcDialogPortal,
        null,
        createElement(IcDialogBackdrop, null),
        createElement(
          IcDialogPopup,
          { "aria-label": "demo" },
          createElement(IcDialogTitle, null, "Clipboard"),
          createElement(IcDialogDescription, null, "Paste text")
        )
      )
    )
  );
  // Closed: only the trigger is in the static markup; the portalled popup/title
  // are absent (base-ui mounts them on open).
  assert.match(html, TRIGGER_LABEL);
  assert.doesNotMatch(html, POPUP_TITLE);
});
