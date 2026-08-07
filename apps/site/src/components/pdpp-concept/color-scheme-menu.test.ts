// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { buildConceptSchemeHref } from "./color-scheme-menu.tsx";

test("adds and replaces the concept colour scheme without dropping other URL state", () => {
  assert.equal(buildConceptSchemeHref("/", "", "plum"), "/?scheme=plum");
  assert.equal(
    buildConceptSchemeHref("/specification", "section=grants", "plum"),
    "/specification?section=grants&scheme=plum"
  );
  assert.equal(
    buildConceptSchemeHref("/participate", "scheme=old&ref=footer", "plum"),
    "/participate?scheme=plum&ref=footer"
  );
});

test("returns to the default scheme by removing only its URL state", () => {
  assert.equal(buildConceptSchemeHref("/", "scheme=plum", null), "/");
  assert.equal(buildConceptSchemeHref("/self-host", "scheme=plum&step=2", null), "/self-host?step=2");
});
