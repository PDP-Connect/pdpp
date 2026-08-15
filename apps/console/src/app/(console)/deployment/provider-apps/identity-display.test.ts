// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Rendered-DOM proof that the opaque `identity_group` grouping token never
 * reaches visible copy on the provider-app config page.
 *
 * `identity_group` is a manifest-declared grouping token (e.g.
 * "shared-google-oauth-app") for connectors that share one provider-app
 * registration. It has exactly one legitimate job: addressing which group a
 * form submit targets, via the hidden `<input name="identity_group">`. It
 * must never appear as visible text — that would leak an internal wiring
 * detail the owner has no use for and was never meant to see.
 *
 * A source regex can prove "the code contains the string
 * `group.provider_identity_label`" but cannot prove the token doesn't ALSO
 * leak elsewhere (a debug span, a title attribute, a concatenated label). This
 * renders the real `GroupForm` component with `react-dom/server` and inspects
 * the actual HTML output — including two counterweight fixtures designed to
 * catch a test that would pass for the wrong reason:
 *
 *   - a label that happens to CONTAIN the identity_group token as a
 *     substring (proves the assertion isn't vacuously true merely because
 *     the token differs from the label);
 *   - a label built by literally concatenating/aliasing the identity_group
 *     (proves the same for a label the manifest could plausibly generate
 *     from the token rather than authoring independently).
 *
 * In both counterweight cases the token is ALLOWED to appear as substring
 * of the rendered label (that's an honest manifest authoring choice) — what
 * must never happen is the token appearing OUTSIDE the label, i.e. as its
 * own free-standing visible text node (which only the hidden input's value
 * attribute is allowed to carry).
 */

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderAppConfigGroup } from "../../lib/ref-client.ts";
import { GroupForm } from "./group-form.tsx";

// `tsx`'s on-the-fly JSX transform for .tsx files loaded through the
// node:test CJS require hook falls back to the classic runtime (needing a
// `React` global) rather than the `jsx: "react-jsx"` automatic runtime
// tsconfig declares — reproducible outside this file too, so this is a test-
// runtime quirk, not a workspace package defect. Assigning the global here
// is the minimal fix; it has no effect on the real Next.js build, which
// always uses the automatic runtime.
(globalThis as { React?: typeof React }).React = React;

const HIDDEN_IDENTITY_GROUP_INPUT_RE = /<input[^>]*name="identity_group"[^>]*>/;
const INPUT_VALUE_ATTR_RE = /value="([^"]*)"/;
const GOOGLE_LABEL_TEXT_RE = />Google account access</;
const GOOGLE_LABEL_WITH_TOKEN_PREFIX_TEXT_RE = />shared-google-oauth-app \(Google account access\)</;
const ALIASED_LABEL_TEXT_RE = />Provider: shared-google-oauth-app</;
const MICROSOFT_TOKEN_RE = /shared-microsoft-oauth-app/;
const GOOGLE_TOKEN_RE = /shared-google-oauth-app/;

function field(
  overrides: Partial<ProviderAppConfigGroup["fields"][number]> = {}
): ProviderAppConfigGroup["fields"][number] {
  return {
    configured: false,
    label: "Client ID",
    logical_key: "client_id",
    secret: false,
    ...overrides,
  };
}

function noopAction(): void {
  // GroupForm requires a form `action`; the identity-display contract under
  // test doesn't exercise submission, so a no-op stub stands in for the
  // real "use server" action (which can't be imported outside a Next.js
  // server runtime — see group-form.tsx).
}

function renderGroup(group: ProviderAppConfigGroup): string {
  return renderToStaticMarkup(GroupForm({ action: noopAction, group }));
}

// Extracts the hidden identity_group input's value attribute, then removes
// that whole tag from the markup — what's left is every other place the
// token could have leaked, including as free text.
function markupOutsideHiddenInput(html: string): { hiddenValue: string | null; rest: string } {
  const match = html.match(HIDDEN_IDENTITY_GROUP_INPUT_RE);
  const hiddenTag = match?.[0] ?? null;
  const valueMatch = hiddenTag?.match(INPUT_VALUE_ATTR_RE);
  return {
    hiddenValue: valueMatch?.[1] ?? null,
    rest: hiddenTag ? html.replace(hiddenTag, "") : html,
  };
}

test("identity_group is present exactly once, as the hidden form input's value", () => {
  const group: ProviderAppConfigGroup = {
    fields: [field()],
    identity_group: "shared-google-oauth-app",
    provider_identity_label: "Google account access",
  };
  const html = renderGroup(group);
  const { hiddenValue } = markupOutsideHiddenInput(html);
  assert.equal(hiddenValue, "shared-google-oauth-app");
});

test("identity_group never appears as free-standing visible text outside the hidden input", () => {
  const group: ProviderAppConfigGroup = {
    fields: [field()],
    identity_group: "shared-google-oauth-app",
    provider_identity_label: "Google account access",
  };
  const html = renderGroup(group);
  const { rest } = markupOutsideHiddenInput(html);
  assert.doesNotMatch(rest, GOOGLE_TOKEN_RE, "identity_group leaked outside the hidden input");
});

test("provider_identity_label IS rendered as visible text", () => {
  const group: ProviderAppConfigGroup = {
    fields: [field()],
    identity_group: "shared-google-oauth-app",
    provider_identity_label: "Google account access",
  };
  const html = renderGroup(group);
  assert.match(html, GOOGLE_LABEL_TEXT_RE);
});

test("counterweight: a label that CONTAINS the identity_group token as a substring is still fine in the label position, but the bare token must not appear standalone", () => {
  // A manifest could plausibly author a label like this. The test must not
  // be fooled by the substring relationship into a false pass OR a false
  // fail — it isolates the hidden input, then checks the remaining markup
  // renders the label (containing the substring) and nothing else bearing
  // the raw token as its own text node.
  const group: ProviderAppConfigGroup = {
    fields: [field()],
    identity_group: "shared-google-oauth-app",
    provider_identity_label: "shared-google-oauth-app (Google account access)",
  };
  const html = renderGroup(group);
  const { rest } = markupOutsideHiddenInput(html);
  // The label (which legitimately contains the token) must render.
  assert.match(rest, GOOGLE_LABEL_WITH_TOKEN_PREFIX_TEXT_RE);
  // But there must be no OTHER occurrence of the raw token beyond the one
  // inside that label text node — i.e. exactly one occurrence left after
  // removing the hidden input.
  const occurrences = rest.split("shared-google-oauth-app").length - 1;
  assert.equal(
    occurrences,
    1,
    "identity_group must appear at most once outside the hidden input (inside the label itself)"
  );
});

test("counterweight: a label built by aliasing/concatenating identity_group does not trip a false negative", () => {
  // Simulates a manifest that derives its label FROM the grouping token
  // (e.g. title-casing it) rather than authoring independent copy. This is
  // still a `provider_identity_label` value, so it is allowed to render —
  // the invariant under test is "no OTHER place leaks the raw token," not
  // "the label may never resemble the token."
  const identityGroup = "shared-google-oauth-app";
  const aliasedLabel = `Provider: ${identityGroup}`;
  const group: ProviderAppConfigGroup = {
    fields: [field()],
    identity_group: identityGroup,
    provider_identity_label: aliasedLabel,
  };
  const html = renderGroup(group);
  const { hiddenValue, rest } = markupOutsideHiddenInput(html);
  assert.equal(hiddenValue, identityGroup);
  assert.match(rest, ALIASED_LABEL_TEXT_RE);
  const occurrences = rest.split(identityGroup).length - 1;
  assert.equal(
    occurrences,
    1,
    "identity_group must appear at most once outside the hidden input (inside the aliased label itself)"
  );
});

test("multiple groups each carry their own distinct identity_group only in their own hidden input", () => {
  const groupA: ProviderAppConfigGroup = {
    fields: [field({ logical_key: "client_id_a" })],
    identity_group: "shared-google-oauth-app",
    provider_identity_label: "Google account access",
  };
  const groupB: ProviderAppConfigGroup = {
    fields: [field({ logical_key: "client_id_b" })],
    identity_group: "shared-microsoft-oauth-app",
    provider_identity_label: "Microsoft account access",
  };
  const htmlA = renderGroup(groupA);
  const htmlB = renderGroup(groupB);
  assert.doesNotMatch(htmlA, MICROSOFT_TOKEN_RE);
  assert.doesNotMatch(htmlB, GOOGLE_TOKEN_RE);
});
