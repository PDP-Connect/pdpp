// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The owner twice found the optional saved-credentials section confusing
 * enough to ask whether leaving it blank erases saved credentials. These are
 * source-text invariants, matching the convention of the sibling
 * `*.invariants.test.ts` files: `page.tsx` is a React server component and
 * the credential fields live in a client component with no DOM harness in
 * this suite, so the fix is asserted against source rather than a render.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("./page.tsx", import.meta.url));
const OPTIONAL_CREDENTIAL_FIELDS_FILE = fileURLToPath(
  new URL("./optional-stored-credential-fields.tsx", import.meta.url)
);

const REPAIR_AUTO_USE_CUE = /Any sign-in details already saved for this source will be used automatically/;
const DISABLED_UNTIL_CHECKED = /disabled=\{!remember\}/;
const CHECKBOX_DRIVES_STATE = /onChange=\{\(event\) => setRemember\(event\.target\.checked\)\}/;

function readPage(): Promise<string> {
  return readFile(PAGE_FILE, "utf8");
}

function readOptionalCredentialFields(): Promise<string> {
  return readFile(OPTIONAL_CREDENTIAL_FIELDS_FILE, "utf8");
}

test("repair mode tells the owner existing saved sign-in details are used automatically", async () => {
  const src = await readPage();
  assert.match(
    src,
    REPAIR_AUTO_USE_CUE,
    "repair mode must state plainly that already-saved sign-in details are used automatically"
  );
});

test("optional credential fields stay disabled until the save checkbox is checked", async () => {
  const src = await readOptionalCredentialFields();
  assert.match(
    src,
    DISABLED_UNTIL_CHECKED,
    "credential fields must be disabled unless the owner has opted in via the checkbox"
  );
  assert.match(src, CHECKBOX_DRIVES_STATE, "the checkbox must be the only thing that can enable the credential fields");
});
