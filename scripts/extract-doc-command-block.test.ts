#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guards extractFencedBlockAfterAnchor against synthetic fixtures, then
// asserts it can locate the exact command blocks the friend-os-matrix
// workflow depends on in the live docs/operator/selfhost-quickstart.md — so a
// doc rewrite that renames a heading or reorders fences fails this test
// instead of silently making CI test stale, hand-copied commands forever.

import assert from "node:assert/strict";
import test from "node:test";

import { extractDocCommandBlock, extractFencedBlockAfterAnchor } from "./extract-doc-command-block.ts";

const ANCHOR_NOT_FOUND_PATTERN = /anchor not found/;
const WRONG_LANGUAGE_FENCE_PATTERN = /expected a.*fence/;
const UNTERMINATED_FENCE_PATTERN = /unterminated fence/;
const OPENSSL_BASE64_PATTERN = /openssl rand -base64 24/;
const OPENSSL_HEX_PATTERN = /openssl rand -hex 32/;
const ENV_REDIRECT_PATTERN = /> \.env/;
const RANDOM_NUMBER_GENERATOR_PATTERN = /RandomNumberGenerator/;
const SET_CONTENT_ASCII_PATTERN = /Set-Content -Path \.env -Encoding ascii/;
const COMPOSE_FETCH_URL_PATTERN = /curl -fsSLO https:\/\/github\.com\/PDP-Connect\/pdpp\/releases\/latest\/download\//;
const POWERSHELL_COMPOSE_FETCH_URL_PATTERN =
  /curl\.exe -fsSLO https:\/\/github\.com\/PDP-Connect\/pdpp\/releases\/latest\/download\//;
const COMPOSE_FILE_PATH_PATTERN = /docker-compose\.yml/;

test("extractFencedBlockAfterAnchor returns the fenced body after the anchor line", () => {
  const source = ["intro text", "### Heading", "some prose", "```sh", "echo one", "echo two", "```", "trailing"].join(
    "\n"
  );
  assert.equal(extractFencedBlockAfterAnchor(source, "### Heading", "sh"), "echo one\necho two");
});

test("extractFencedBlockAfterAnchor throws when the anchor is missing", () => {
  assert.throws(() => extractFencedBlockAfterAnchor("no anchors here", "### Missing", "sh"), ANCHOR_NOT_FOUND_PATTERN);
});

test("extractFencedBlockAfterAnchor throws when a different-language fence intervenes", () => {
  const source = ["### Heading", "```yaml", "a: 1", "```"].join("\n");
  assert.throws(() => extractFencedBlockAfterAnchor(source, "### Heading", "sh"), WRONG_LANGUAGE_FENCE_PATTERN);
});

test("extractFencedBlockAfterAnchor throws on an unterminated fence", () => {
  const source = ["### Heading", "```sh", "echo one"].join("\n");
  assert.throws(() => extractFencedBlockAfterAnchor(source, "### Heading", "sh"), UNTERMINATED_FENCE_PATTERN);
});

test("live docs: macOS/Linux secret-generation block is present under its bash anchor", () => {
  const block = extractDocCommandBlock("docs/operator/selfhost-quickstart.md", "macOS and Linux (bash or zsh):", "sh");
  assert.match(block, OPENSSL_BASE64_PATTERN);
  assert.match(block, OPENSSL_HEX_PATTERN);
  assert.match(block, ENV_REDIRECT_PATTERN);
});

test("live docs: Windows PowerShell secret-generation block is present under its anchor", () => {
  const block = extractDocCommandBlock(
    "docs/operator/selfhost-quickstart.md",
    "Windows PowerShell (the block above cannot work there",
    "powershell"
  );
  assert.match(block, RANDOM_NUMBER_GENERATOR_PATTERN);
  assert.match(block, SET_CONTENT_ASCII_PATTERN);
});

test("live docs: sh Compose-fetch block is present under the Lane A fetch heading", () => {
  const block = extractDocCommandBlock(
    "docs/operator/selfhost-quickstart.md",
    "### 1. Fetch the released compose bundle",
    "sh"
  );
  assert.match(block, COMPOSE_FETCH_URL_PATTERN);
  assert.match(block, COMPOSE_FILE_PATH_PATTERN);
});

test("live docs: powershell Compose-fetch block is present under its anchor", () => {
  const block = extractDocCommandBlock(
    "docs/operator/selfhost-quickstart.md",
    "On **Windows PowerShell**, bare",
    "powershell"
  );
  assert.match(block, POWERSHELL_COMPOSE_FETCH_URL_PATTERN);
  assert.match(block, COMPOSE_FILE_PATH_PATTERN);
});
