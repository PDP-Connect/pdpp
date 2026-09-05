// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// The publisher reads ONE branch, and which branch it is cannot become an input.
//
// `signatures` is the production register. `signatures-preview` is a disposable
// rehearsal branch holding real confirmed records that nobody consented to
// publish. The publisher turns whatever it checks out into the public
// supporters register, so a branch input here would be enough to publish the
// rehearsal branch.
//
// The site enforces the same boundary at write time
// (`resolveRegisterBranch` in apps/site/src/lib/signing/providers.ts). This is
// the read side of it: an invariant of the workflow file, checked statically
// because there is no way to unit-test a GitHub Actions checkout.

const WORKFLOW_URL = new URL("../.github/workflows/publish-supporters.yml", import.meta.url);

const PRIVATE_CHECKOUT = /- name: Checkout private register branch\n((?: {10}.*\n| {8}.*\n)*)/;
const PINNED_REF = /^ {10}ref: signatures$/m;
const PRIVATE_REPOSITORY = /^ {10}repository: PDP-Connect\/supporters-private$/m;
const REF_VALUE = /^ {10}ref: (.*)$/m;
const WORKFLOW_INPUTS = / {4}inputs:\n((?: {6,}.*\n|\n)*)/;
const INPUT_NAME = /^ {6}(\w+):$/gm;
const PRIVATE_REGISTER_INPUT = /signature|private|register_branch/i;

async function privateCheckoutStep() {
  const workflow = await readFile(WORKFLOW_URL, "utf8");
  const match = workflow.match(PRIVATE_CHECKOUT);
  assert.ok(match, "publish-supporters.yml has no 'Checkout private register branch' step");
  return { step: match[1], workflow };
}

test("the private checkout is pinned to the production register branch", async () => {
  const { step } = await privateCheckoutStep();

  assert.match(step, PINNED_REF);
  assert.match(step, PRIVATE_REPOSITORY);
});

test("the private checkout ref is a literal, not an input or a variable", async () => {
  const { step } = await privateCheckoutStep();
  const ref = step.match(REF_VALUE)?.[1]?.trim();

  // An expression here — `${{ inputs.register_branch }}`, `${{ env.BRANCH }}` —
  // is exactly the change this test exists to fail on, whatever it is named.
  assert.equal(ref, "signatures");
  assert.ok(!ref.includes("${{"), `private checkout ref must not be an expression: ${ref}`);
});

test("no workflow input can choose the private register branch", async () => {
  const { workflow } = await privateCheckoutStep();
  const inputs = workflow.match(WORKFLOW_INPUTS)?.[1] ?? "";
  const names = [...inputs.matchAll(INPUT_NAME)].map((entry) => entry[1]);

  // `base_branch` names the PUBLIC branch the generated register is published
  // from, and `open_pr` gates the pull request. Neither reaches the private
  // checkout. Anything new that mentions the private register does.
  assert.deepEqual(names, ["base_branch", "open_pr"]);
  for (const name of names) {
    assert.ok(!PRIVATE_REGISTER_INPUT.test(name), `input ${name} may select the private register`);
  }
});

test("the publisher never checks out the preview register", async () => {
  const { workflow } = await privateCheckoutStep();

  assert.ok(
    !workflow.includes("signatures-preview"),
    "publish-supporters.yml must not reference signatures-preview: it holds unconsented rehearsal records"
  );
});
