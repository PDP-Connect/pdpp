import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IcSelect } from "./select.tsx";

// IcSelect must stay a real native <select> so native a11y + form submission
// survive — these render checks pin that contract.

const SELECT_EL = /<select[^>]*class="[^"]*pdpp-select__el/;
const SELECT_WRAP = /<span class="pdpp-select"/;
const NAME_STATUS = /name="status"/;
// The defaultValue option carries React's `selected` attribute.
const OPTION_ACTIVE = /<option value="active"[^>]*>active<\/option>/;
const OPTION_FAILED = /<option value="failed">failed<\/option>/;
const OPTION_ANY = /<option value="">any<\/option>/;
const OPTION_CONNECTOR = /<option value="connector">connector<\/option>/;
const MERGED_CLASS = /class="pdpp-select__el w-40"/;

test("IcSelect renders a native <select> with the token-driven classes", () => {
  const html = renderToStaticMarkup(
    createElement(
      IcSelect,
      { defaultValue: "active", name: "status" },
      createElement("option", { value: "active" }, "active"),
      createElement("option", { value: "failed" }, "failed")
    )
  );
  assert.match(html, SELECT_EL);
  assert.match(html, SELECT_WRAP);
  assert.match(html, NAME_STATUS);
  assert.match(html, OPTION_ACTIVE);
  assert.match(html, OPTION_FAILED);
});

test("IcSelect accepts declarative options and preserves their values", () => {
  const html = renderToStaticMarkup(
    createElement(IcSelect, {
      name: "kind",
      options: [
        { label: "any", value: "" },
        { label: "connector", value: "connector" },
      ],
    })
  );
  assert.match(html, OPTION_ANY);
  assert.match(html, OPTION_CONNECTOR);
});

test("IcSelect merges a caller className onto the underlying select", () => {
  const html = renderToStaticMarkup(
    createElement(IcSelect, { className: "w-40", name: "x" }, createElement("option", { value: "" }, "—"))
  );
  assert.match(html, MERGED_CLASS);
});
