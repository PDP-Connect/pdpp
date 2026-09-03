// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PROVIDERS_FILE = fileURLToPath(new URL("./providers.ts", import.meta.url));
const DEFAULT_BRANCH = /PDPP_PRIVATE_REPO_BRANCH\?\.trim\(\) \|\| "signatures"/;
const DCO_TRAILER = /function botCommitMessage[\s\S]*Signed-off-by: \$\{BOT\.name\} <\$\{BOT\.email\}>/;
const SIGNATORY_WRITE =
  /writeSignatory[\s\S]*?body: JSON\.stringify\(\{[\s\S]*?branch,[\s\S]*?message: botCommitMessage\(`Add signatory \$\{record\.id\}`\)/;
const WITHDRAWAL_LOG_WRITE =
  /appendWithdrawal[\s\S]*?body: JSON\.stringify\(\{[\s\S]*?branch,[\s\S]*?message: botCommitMessage\("Record a withdrawal"\)/;
const WITHDRAWAL_BRANCH_CHECK =
  /withdrawSignatory[\s\S]*?await ensureRepoBranch\(branch\)[\s\S]*?contents\/\$\{filePath\}\?ref=\$\{encodeURIComponent\(branch\)\}/;

test("private register PUTs carry the branch and the bot DCO trailer", async () => {
  const source = await readFile(PROVIDERS_FILE, "utf8");

  assert.match(source, DEFAULT_BRANCH);
  assert.match(source, DCO_TRAILER);
  assert.match(source, SIGNATORY_WRITE);
  assert.match(source, WITHDRAWAL_LOG_WRITE);
  assert.match(source, WITHDRAWAL_BRANCH_CHECK);
});
