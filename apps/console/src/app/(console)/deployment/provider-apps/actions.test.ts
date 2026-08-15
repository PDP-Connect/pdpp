// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural assertions for `setProviderAppConfigAction`.
 *
 * The action is a `"use server"` module importing `next/cache`/`next/navigation`,
 * so it cannot be exercised directly under plain `node:test` (mirrors the
 * established pattern in sources/actions.test.ts). These regex assertions pin:
 *
 *   - the batch-write contract: one identity group, a `values` object built
 *     only from non-blank `field_*` form entries — a blank input means "keep
 *     the existing stored value," so it must never appear in `values` and
 *     must never be sent as an empty-string overwrite;
 *   - a save always redirects (success or failure), never re-rendering a form
 *     with the submitted values still present;
 *   - a failure is routed through `classifySaveError`/`ownerErrorCopy`
 *     (owner-error-copy.ts), never a raw exception message — the copy itself
 *     is pinned by behavioral tests in owner-error-copy.test.ts, not here.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ACTIONS_FILE = `${HERE}actions.ts`;

const REQUIRES_IDENTITY_GROUP_RE = /if \(!identityGroup\) \{\s*redirect\(pageHref\(\{ error:/;
const SKIPS_BLANK_FIELDS_RE = /if \(!value\) \{\s*continue;\s*\}/;
const REQUIRES_NONEMPTY_VALUES_RE = /if \(Object\.keys\(values\)\.length === 0\) \{\s*redirect\(pageHref\(\{ error:/;
const SETS_CONFIG_BATCH_RE = /await setProviderAppConfig\(\{ identityGroup, values \}\);/;
const SUCCESS_NOTICE_RE = /pageHref\(\{ notice: "saved" \}\)/;
const RAW_EXCEPTION_TEXT_RE = /err\.message|errorMessage\(err\)|String\(err\)/;
const ERROR_REDIRECT_USES_CLASSIFIED_COPY_RE =
  /target = pageHref\(\{ error: ownerErrorCopy\(classifySaveError\(err\)\) \}\);/;
const IMPORTS_OWNER_ERROR_COPY_RE =
  /import \{ type OwnerFacingSaveError, ownerErrorCopy \} from "\.\/owner-error-copy\.ts";/;
const VALUE_NOT_IN_REDIRECT_PARAMS_RE = /params\.value|error:\s*value\b/;
const FIELD_PREFIX_STRIP_RE = /name\.slice\(FIELD_PREFIX\.length\)/;

test("save action requires an identity group before writing", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, REQUIRES_IDENTITY_GROUP_RE);
});

test("save action skips blank field inputs instead of sending them as overwrites", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, SKIPS_BLANK_FIELDS_RE);
});

test("save action requires at least one non-blank value before writing", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, REQUIRES_NONEMPTY_VALUES_RE);
});

test("save action strips the field_ prefix to recover the logical key", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, FIELD_PREFIX_STRIP_RE);
});

test("save action calls setProviderAppConfig once with the identity group and a values batch", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, SETS_CONFIG_BATCH_RE);
});

test("save action redirects with a saved notice on success", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, SUCCESS_NOTICE_RE);
});

test("save action maps failures through the shared classifier/copy module, never raw exception text", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, IMPORTS_OWNER_ERROR_COPY_RE);
  assert.match(src, ERROR_REDIRECT_USES_CLASSIFIED_COPY_RE);
  assert.doesNotMatch(src, RAW_EXCEPTION_TEXT_RE);
});

test("the submitted values never ride in any redirect target", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.doesNotMatch(src, VALUE_NOT_IN_REDIRECT_PARAMS_RE);
});

test("validation guards run before the write, not after", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  const identityGuardIdx = src.indexOf("if (!identityGroup)");
  const emptyValuesGuardIdx = src.indexOf("if (Object.keys(values).length === 0)");
  const writeIdx = src.indexOf("await setProviderAppConfig(");
  assert.ok(identityGuardIdx > -1 && emptyValuesGuardIdx > -1 && writeIdx > -1);
  assert.ok(identityGuardIdx < writeIdx, "identity group guard must precede the write");
  assert.ok(emptyValuesGuardIdx < writeIdx, "non-empty values guard must precede the write");
});
