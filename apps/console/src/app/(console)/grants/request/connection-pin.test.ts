// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the operator grant-request per-connection pin.
 *
 * Closes the open product item in
 *   openspec/changes/expose-connection-identity-on-public-read (Section 4)
 * — the operator grant-request flow can now pin a staged grant to one
 * connection of a multi-connection connector, or fan in across all the grant
 * authorizes. The pin rides on `streams[].connection_id`, an existing grant
 * field the read path already enforces (no new storage shape).
 *
 * Two layers:
 *  1. Behavioral — executes the pure projection + stream-selection helpers in
 *     `../../lib/grant-request-connection-pin.ts`. Node strips the TS types and
 *     runs the module directly (it imports only the dependency-free shared
 *     connector-display labeler), so these are real behavior assertions, not a
 *     string match. This mirrors `consent-connection-label.test.js`.
 *  2. Structural — the page/lib/actions are server components with no JSX
 *     render harness in this app, so we assert the wiring the brief requires:
 *     the staged PAR threads the selection, the select offers an explicit
 *     fan-in default (never a silent pin or silent fan-in), and the form posts
 *     the field through the action.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const LIB_DIR = `${HERE}../../lib/`;
const { buildConnectionPinOptions, streamSelectionFromDraft } = await import(
  new URL("../../lib/grant-request-connection-pin.ts", import.meta.url).href
);

const PAGE_FILE = `${HERE}page.tsx`;
const ACTIONS_FILE = `${HERE}actions.ts`;
const LIB_FILE = `${LIB_DIR}operator-grant-request.ts`;

const PLACEHOLDER_LABEL_RE = /legacy|default_account|registry\.pdpp\.org|local-device:/;
const LIB_PAR_STREAM_RE = /streams: \[streamSelectionFromDraft\(workspace\.draft, workspace\.draft\.streamName\)\]/;
const LIB_EXAMPLE_STREAM_RE =
  /streamSelectionFromDraft\(workspace\.draft, workspace\.draft\.streamName \|\| "<stream>"\)/;
const ACTION_READS_FIELD_RE = /connectionId: asString\(formData\.get\("connection_id"\)\)/;
const PAGE_FAN_IN_LABEL_RE = /All connections \(fan-in\)/;
const PAGE_FAN_IN_VALUE_RE = /const FAN_IN_OPTION_VALUE = "";/;
const PAGE_DEFAULT_OPTION_RE = /<option value=\{FAN_IN_OPTION_VALUE\}>\{FAN_IN_OPTION_LABEL\}<\/option>/;
const PAGE_COLLAPSE_GUARD_RE = /if \(connectionOptions\.length <= 1\)/;
const PAGE_FAN_IN_TESTID_RE = /data-testid="connection-pin-fan-in-only"/;
const PAGE_LOADS_OPTIONS_RE = /const connectionOptions = await loadConnectionPinOptions\(draft\)/;

function draft(overrides = {}) {
  return {
    connectionId: "",
    fields: "",
    sourceId: "gmail",
    sourceKind: "connector",
    streamName: "messages",
    view: "",
    ...overrides,
  };
}

// ── Behavioral: connection enumeration with owner-meaningful labels ──────────

test("buildConnectionPinOptions shows owner-set names verbatim and excludes other connectors", () => {
  const options = buildConnectionPinOptions({ id: "gmail", kind: "connector" }, [
    { connection_id: "cin_a", connector_id: "gmail", display_name: "Work Gmail", streams: ["messages"] },
    { connection_id: "cin_b", connector_id: "gmail", display_name: "Personal Gmail", streams: ["messages"] },
    { connection_id: "cin_s", connector_id: "slack", display_name: "Team Slack", streams: ["messages"] },
  ]);
  assert.deepEqual(options, [
    { label: "Work Gmail", value: "cin_a" },
    { label: "Personal Gmail", value: "cin_b" },
  ]);
});

test("buildConnectionPinOptions filters to connections that expose the addressed stream", () => {
  const options = buildConnectionPinOptions({ id: "gmail", kind: "connector", streamName: "messages" }, [
    { connection_id: "cin_messages", connector_id: "gmail", display_name: "Messages Gmail", streams: ["messages"] },
    { connection_id: "cin_contacts", connector_id: "gmail", display_name: "Contacts Gmail", streams: ["contacts"] },
  ]);
  assert.deepEqual(options, [{ label: "Messages Gmail", value: "cin_messages" }]);
});

test("buildConnectionPinOptions derives an owner-meaningful default for never-renamed connections", () => {
  // A blank label and a bare-connector-type label are both fallbacks; they get
  // a stable `· account N` disambiguator instead of a placeholder/URL/id.
  const options = buildConnectionPinOptions({ id: "gmail", kind: "connector" }, [
    { connection_id: "cin_a", connector_id: "gmail", display_name: null, streams: ["messages"] },
    { connection_id: "cin_b", connector_id: "gmail", display_name: "gmail", streams: ["messages"] },
  ]);
  assert.deepEqual(options, [
    { label: "gmail · account 1", value: "cin_a" },
    { label: "gmail · account 2", value: "cin_b" },
  ]);
  // No rendered label is ever the raw connection_id or a placeholder string.
  for (const opt of options) {
    assert.notEqual(opt.label, opt.value);
    assert.doesNotMatch(opt.label, PLACEHOLDER_LABEL_RE);
  }
});

test("buildConnectionPinOptions keeps a lone connection's label undisambiguated", () => {
  const options = buildConnectionPinOptions({ id: "gmail", kind: "connector" }, [
    { connection_id: "cin_a", connector_id: "gmail", display_name: "Work Gmail", streams: ["messages"] },
  ]);
  assert.deepEqual(options, [{ label: "Work Gmail", value: "cin_a" }]);
});

test("buildConnectionPinOptions returns [] for provider-native and empty sources (no connection dimension)", () => {
  const summaries = [
    { connection_id: "cin_a", connector_id: "gmail", display_name: "Work Gmail", streams: ["messages"] },
  ];
  assert.deepEqual(buildConnectionPinOptions({ id: "gmail", kind: "provider_native" }, summaries), []);
  assert.deepEqual(buildConnectionPinOptions({ id: "", kind: "connector" }, summaries), []);
});

// ── Behavioral: the selected connection_id lands in the staged stream ────────

test("streamSelectionFromDraft omits connection_id by default (fan-in)", () => {
  const selection = streamSelectionFromDraft(draft(), "messages");
  assert.equal(selection.name, "messages");
  assert.equal("connection_id" in selection, false);
});

test("streamSelectionFromDraft pins connection_id when the owner selected one", () => {
  const selection = streamSelectionFromDraft(draft({ connectionId: "cin_a", fields: "id, subject" }), "messages");
  assert.equal(selection.connection_id, "cin_a");
  assert.deepEqual(selection.fields, ["id", "subject"]);
});

test("streamSelectionFromDraft does not regress single-connection / unpinned streams", () => {
  // The pre-existing shape (name + optional fields/view, no connection_id) is
  // preserved byte-for-byte when no pin is chosen.
  const selection = streamSelectionFromDraft(draft({ view: "summary" }), "messages");
  assert.deepEqual(selection, { name: "messages", view: "summary" });
});

// ── Structural: the flow wires the pin end-to-end ────────────────────────────

test("staged PAR builds its stream selection through streamSelectionFromDraft", async () => {
  const src = await readFile(LIB_FILE, "utf8");
  // Both the real PAR body and the copy/paste equivalents use the one helper,
  // so the pin can never appear in one and be dropped in the other.
  assert.match(src, LIB_PAR_STREAM_RE);
  assert.match(src, LIB_EXAMPLE_STREAM_RE);
});

test("the grant-request action reads the connection_id field", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, ACTION_READS_FIELD_RE);
});

test("the page offers an explicit fan-in default — never a silent pin or silent fan-in", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, PAGE_FAN_IN_LABEL_RE);
  // The default option's value is the empty (fan-in) sentinel.
  assert.match(src, PAGE_FAN_IN_VALUE_RE);
  assert.match(src, PAGE_DEFAULT_OPTION_RE);
});

test("the page hides the pin control when there is nothing to disambiguate", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // <= 1 connection: collapse to a static fan-in note and post the empty value.
  assert.match(src, PAGE_COLLAPSE_GUARD_RE);
  assert.match(src, PAGE_FAN_IN_TESTID_RE);
});

test("the page loads the pin options from the live connector listing", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, PAGE_LOADS_OPTIONS_RE);
});
