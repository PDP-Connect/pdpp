// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-regex guard for group-form.tsx (GroupForm/FieldInput), extracted
 * out of page.tsx so it can be rendered directly for the identity-display
 * proof (see identity-display.test.ts). Manifest-driven field labels only:
 * must never round-trip a stored value as a form default, must distinguish
 * configured vs missing per field, and must submit one atomic form per
 * identity group rather than one save per field.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const GROUP_FORM_FILE = `${HERE}group-form.tsx`;

const LABEL_RENDER_RE = /\{field\.label\}/;
const CONFIGURED_FIELD_RE = /field\.configured/;
const VALUE_INPUT_NO_DEFAULT_RE = /<IcInput[\s\S]*?name=\{`field_\$\{field\.logical_key\}`\}[\s\S]*?\/>/;
const DEFAULT_VALUE_ATTR_RE = /defaultValue/;
const ONE_FORM_PER_GROUP_RE = /export function GroupForm/;
const ONE_SAVE_PER_FIELD_RE = /function FieldRow/;
const RESPONSIVE_GRID_RE = /sm:grid-cols-2/;

test("group form renders manifest-declared field labels, not logical/env keys", async () => {
  const src = await readFile(GROUP_FORM_FILE, "utf8");
  assert.match(src, LABEL_RENDER_RE);
});

test("group form distinguishes configured vs missing per field", async () => {
  const src = await readFile(GROUP_FORM_FILE, "utf8");
  assert.match(src, CONFIGURED_FIELD_RE);
});

test("group form value input never round-trips a stored value as a default", async () => {
  const src = await readFile(GROUP_FORM_FILE, "utf8");
  const inputMatch = src.match(VALUE_INPUT_NO_DEFAULT_RE);
  assert.ok(inputMatch, "field <IcInput> not found");
  assert.doesNotMatch(inputMatch[0], DEFAULT_VALUE_ATTR_RE);
});

test("group form submits one form per identity group, not one save per field", async () => {
  const src = await readFile(GROUP_FORM_FILE, "utf8");
  assert.match(src, ONE_FORM_PER_GROUP_RE);
  assert.doesNotMatch(src, ONE_SAVE_PER_FIELD_RE);
});

test("group form wraps fields to a responsive grid instead of a fixed-width row", async () => {
  const src = await readFile(GROUP_FORM_FILE, "utf8");
  assert.match(src, RESPONSIVE_GRID_RE);
});
