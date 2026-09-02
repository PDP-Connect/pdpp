// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REFERENCE_BROWSER_ORIGIN,
  REFERENCE_MODE_COMPOSED,
  REFERENCE_MODE_DIRECT,
  resolveReferenceBrowserOrigin,
  resolveReferenceMode,
  resolveReferenceTopology,
} from "../server/reference-topology.ts";

test("reference topology defaults to direct mode when no composed-origin signals are present", () => {
  assert.equal(
    resolveReferenceMode({
      env: {},
    }),
    REFERENCE_MODE_DIRECT
  );
});

test("reference topology switches to composed mode from explicit mode or browser-origin signals", () => {
  assert.equal(
    resolveReferenceMode({
      env: {},
      explicitMode: "composed",
    }),
    REFERENCE_MODE_COMPOSED
  );
  assert.equal(
    resolveReferenceMode({
      env: { PDPP_REFERENCE_ORIGIN: "http://localhost:3200" },
    }),
    REFERENCE_MODE_COMPOSED
  );
  assert.equal(
    resolveReferenceMode({
      env: { AS_PUBLIC_URL: "http://localhost:3200" },
    }),
    REFERENCE_MODE_COMPOSED
  );
});

test("reference topology ignoreAmbient keeps ephemeral servers honest", () => {
  assert.equal(
    resolveReferenceMode({
      env: {
        AS_PUBLIC_URL: "http://localhost:3200",
        PDPP_REFERENCE_MODE: "composed",
        PDPP_REFERENCE_ORIGIN: "http://localhost:3200",
        RS_PUBLIC_URL: "http://localhost:3200",
      },
      ignoreAmbient: true,
    }),
    REFERENCE_MODE_DIRECT
  );
});

test("reference topology resolves composed public urls from the browser origin", () => {
  const topology = resolveReferenceTopology({
    env: {},
    explicitMode: "composed",
    referenceOrigin: "http://localhost:3200/",
  });

  assert.equal(topology.mode, REFERENCE_MODE_COMPOSED);
  assert.equal(topology.browserOrigin, "http://localhost:3200");
  assert.equal(topology.asPublicUrl, "http://localhost:3200");
  assert.equal(topology.rsPublicUrl, "http://localhost:3200");
});

// Regression for a real GDC-demo discrepancy: composed mode with no
// operator-configured origin (the deploy artifacts used to bake
// PDPP_REFERENCE_ORIGIN=http://localhost:3000 here, which republishing the
// container on a different host port silently invalidated) must NOT let
// the browser-origin placeholder (DEFAULT_REFERENCE_BROWSER_ORIGIN) leak
// into rsPublicUrl/asPublicUrl — those feed the AS/RS's own protocol-
// critical resource_metadata/issuer URLs, unlike browserOrigin, which is
// only ever an advisory display hint. An unset origin must leave
// rsPublicUrl/asPublicUrl empty so callers fall through to per-request
// Host-header derivation instead of a boot-time-fixed wrong port.
test("reference topology in composed mode with no configured origin does not leak the browser-origin placeholder into public urls", () => {
  const topology = resolveReferenceTopology({
    env: {},
    explicitMode: "composed",
  });

  assert.equal(topology.mode, REFERENCE_MODE_COMPOSED);
  assert.equal(topology.browserOrigin, DEFAULT_REFERENCE_BROWSER_ORIGIN, "advisory browserOrigin keeps its default");
  assert.equal(topology.asPublicUrl, "", "asPublicUrl must not inherit the browser-origin placeholder");
  assert.equal(topology.rsPublicUrl, "", "rsPublicUrl must not inherit the browser-origin placeholder");
});

test("reference browser origin falls back to the default local web origin", () => {
  assert.equal(resolveReferenceBrowserOrigin({ env: {} }), DEFAULT_REFERENCE_BROWSER_ORIGIN);
});

test("reference browser origin uses the browser-visible request origin before container configuration", () => {
  assert.equal(
    resolveReferenceBrowserOrigin({
      env: { PDPP_REFERENCE_ORIGIN: "http://localhost:3000" },
      explicitOrigin: "http://localhost:3000",
      requestOrigin: "http://localhost:3012",
    }),
    "http://localhost:3012"
  );
});
