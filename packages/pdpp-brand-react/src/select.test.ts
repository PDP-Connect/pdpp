// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IcSelect } from "./select.tsx";

// IcSelect is a thin Ink Carbon skin over @base-ui/react's Select. base-ui
// owns interaction, a11y (ARIA listbox), keyboard nav, type-ahead, and form
// submission via a hidden <input name>. This module owns ONLY the token styling.
//
// SSR contract pinned here:
//   (1) The trigger <button> renders with the .pdpp-select__trigger class and
//       the wrapper <span> carries .pdpp-select — these are the client-visible
//       token anchors for all Ink Carbon styling.
//   (2) The popup (portal) does NOT render in static server markup — base-ui
//       mounts it on the client when opened (same pattern as IcDialog).
//   (3) The `name` prop flows to a hidden <input> for form submission
//       (base-ui renders this unconditionally on the server too).
//   (4) `defaultValue` / `value` flow to Select.Root and set the hidden input.
//   (5) The trigger shows the selected item's label text via Select.Value.

const TRIGGER_BTN = /<button[^>]*class="[^"]*pdpp-select__trigger/;
const WRAPPER_SPAN = /<span[^>]*class="[^"]*pdpp-select[^"]*"/;
const HIDDEN_INPUT_NAME = /name="status"/;
const HIDDEN_INPUT_VALUE = /value="active"/;
const NO_POPUP = /pdpp-select-popup/;
const NO_ITEM = /pdpp-select-item/;
const TRIGGER_ID = /id="my-select"/;
const TRIGGER_ARIA = /aria-label="Filter by status"/;
const NAME_KIND = /name="kind"/;
const VALUE_CONNECTOR = /value="connector"/;
const MERGED_CLASS = /class="pdpp-select__trigger w-40"/;

test("IcSelect renders the trigger button with Ink Carbon token class", () => {
  const html = renderToStaticMarkup(
    createElement(IcSelect, {
      name: "status",
      options: [
        { label: "active", value: "active" },
        { label: "failed", value: "failed" },
      ],
      defaultValue: "active",
    })
  );
  assert.match(html, TRIGGER_BTN, "trigger <button> must carry pdpp-select__trigger class");
  assert.match(html, WRAPPER_SPAN, "outer wrapper must carry pdpp-select class");
});

test("IcSelect renders a hidden input with name for form submission", () => {
  const html = renderToStaticMarkup(
    createElement(IcSelect, {
      name: "status",
      options: [
        { label: "active", value: "active" },
        { label: "failed", value: "failed" },
      ],
      defaultValue: "active",
    })
  );
  // base-ui Select.Root renders a hidden <input name={name} value={value}> for
  // HTML form submission — this is the form-submission contract for GET filters.
  assert.match(html, HIDDEN_INPUT_NAME, "hidden input must carry the name prop");
  assert.match(html, HIDDEN_INPUT_VALUE, "hidden input must carry the selected value");
});

test("IcSelect popup does not render in static server markup (portal only mounts on client)", () => {
  const html = renderToStaticMarkup(
    createElement(IcSelect, {
      name: "kind",
      options: [
        { label: "connector", value: "connector" },
        { label: "provider_native", value: "provider_native" },
      ],
    })
  );
  // The popup/list/items are portalled and only mount on open (client-side).
  // In SSR static markup they must be absent — same contract as IcDialog.
  assert.doesNotMatch(html, NO_POPUP, "popup must not render in SSR");
  assert.doesNotMatch(html, NO_ITEM, "items must not render in SSR");
});

test("IcSelect forwards id and aria-label to the trigger button", () => {
  const html = renderToStaticMarkup(
    createElement(IcSelect, {
      id: "my-select",
      "aria-label": "Filter by status",
      name: "status",
      options: [{ label: "all", value: "" }],
    })
  );
  assert.match(html, TRIGGER_ID, "id must be forwarded to trigger button");
  assert.match(html, TRIGGER_ARIA, "aria-label must be forwarded to trigger button");
});

test("IcSelect accepts declarative options and the hidden input carries defaultValue", () => {
  const html = renderToStaticMarkup(
    createElement(IcSelect, {
      name: "kind",
      defaultValue: "connector",
      options: [
        { label: "connector", value: "connector" },
        { label: "provider_native", value: "provider_native" },
      ],
    })
  );
  // Hidden input carries the selected value for form submission.
  assert.match(html, NAME_KIND, "name prop forwarded");
  assert.match(html, VALUE_CONNECTOR, "defaultValue flows to hidden input");
});

test("IcSelect merges a caller className onto the trigger button", () => {
  const html = renderToStaticMarkup(
    createElement(IcSelect, {
      className: "w-40",
      name: "x",
      options: [{ label: "—", value: "" }],
    })
  );
  assert.match(html, MERGED_CLASS, "caller className merged onto trigger");
});
