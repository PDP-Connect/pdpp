/**
 * Unit + consistency tests for the console add-connection modality taxonomy.
 *
 * The module is pure TS (no JSX), so it imports directly in node --test. These
 * tests pin three things:
 *   1. the supported local-collector set matches the enrollment form's
 *      test-pinned `COLLECTOR_RUN_CONNECTORS` literal (no silent drift),
 *   2. the supported-connector type guard behaves,
 *   3. the unsupported modalities stay honest: every entry names its missing
 *      primitive and the browser-bound entry keeps Amazon as the exemplar
 *      (matching the backend intent route's Amazon acceptance fixture).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isSupportedLocalCollectorConnector,
  localCollectorConnectorLabel,
  SUPPORTED_LOCAL_COLLECTOR_CONNECTORS,
  UNSUPPORTED_ADD_MODALITIES,
} from "./connection-modality.ts";

const COLLECTOR_RUN_CONNECTORS_LITERAL_RE = /COLLECTOR_RUN_CONNECTORS\s*=\s*\[([^\]]*)\]/;
const SURROUNDING_QUOTES_RE = /^["']|["']$/g;
const BROWSER_COLLECTOR_PRIMITIVE_RE = /browser-collector/;
const API_NETWORK_PRIMITIVE_RE = /implicitly on first ingest|API-connect/;

test("supported local-collector set is exactly claude_code and codex", () => {
  assert.deepEqual([...SUPPORTED_LOCAL_COLLECTOR_CONNECTORS], ["claude_code", "codex"]);
});

test("supported set matches the enrollment form's pinned COLLECTOR_RUN_CONNECTORS literal", async () => {
  // The enrollment form keeps a literal `COLLECTOR_RUN_CONNECTORS` array that
  // `enrollment-form.consistency.test.ts` pins. This module must stay in sync so
  // the records-list picker never offers a connector the enroll surface doesn't.
  const formSrc = await readFile(
    fileURLToPath(new URL("../device-exporters/enrollment-form.tsx", import.meta.url)),
    "utf8"
  );
  const match = formSrc.match(COLLECTOR_RUN_CONNECTORS_LITERAL_RE);
  assert.ok(match, "enrollment form must declare COLLECTOR_RUN_CONNECTORS");
  const formConnectors = (match[1] ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(SURROUNDING_QUOTES_RE, ""))
    .filter(Boolean);
  assert.deepEqual(formConnectors, [...SUPPORTED_LOCAL_COLLECTOR_CONNECTORS]);
});

test("isSupportedLocalCollectorConnector narrows only the supported keys", () => {
  assert.equal(isSupportedLocalCollectorConnector("claude_code"), true);
  assert.equal(isSupportedLocalCollectorConnector("codex"), true);
  assert.equal(isSupportedLocalCollectorConnector("amazon"), false);
  assert.equal(isSupportedLocalCollectorConnector("gmail"), false);
  assert.equal(isSupportedLocalCollectorConnector(""), false);
  assert.equal(isSupportedLocalCollectorConnector(null), false);
  assert.equal(isSupportedLocalCollectorConnector(undefined), false);
});

test("every supported connector has an owner-meaningful label", () => {
  for (const connectorId of SUPPORTED_LOCAL_COLLECTOR_CONNECTORS) {
    const label = localCollectorConnectorLabel(connectorId);
    assert.ok(label && label !== connectorId, `expected a friendly label for ${connectorId}, got ${label}`);
  }
  assert.equal(localCollectorConnectorLabel("claude_code"), "Claude Code");
  assert.equal(localCollectorConnectorLabel("codex"), "Codex");
});

test("unsupported modalities are honest: each names a missing primitive", () => {
  assert.ok(UNSUPPORTED_ADD_MODALITIES.length >= 2);
  for (const entry of UNSUPPORTED_ADD_MODALITIES) {
    assert.ok(entry.missingPrimitive.trim().length > 0, `${entry.modality} must name its missing primitive`);
    assert.ok(entry.ownerFacingReason.trim().length > 0, `${entry.modality} must explain the gap to owners`);
    assert.notEqual(
      entry.ownerFacingReason,
      entry.missingPrimitive,
      `${entry.modality} must keep dashboard copy distinct from the technical primitive`
    );
    assert.ok(entry.examples.length > 0, `${entry.modality} must list recognizable examples`);
    // The supported local-collector path must never be listed as unsupported.
    assert.notEqual(entry.modality, "local_collector");
  }
});

test("browser-bound modality keeps Amazon as the acceptance exemplar", () => {
  const browserBound = UNSUPPORTED_ADD_MODALITIES.find((entry) => entry.modality === "browser_bound");
  assert.ok(browserBound, "a browser_bound unsupported modality must exist");
  assert.ok(
    browserBound.examples.includes("Amazon"),
    "Amazon must remain the named browser-bound exemplar (matches the backend intent fixture)"
  );
  assert.match(browserBound.missingPrimitive, BROWSER_COLLECTOR_PRIMITIVE_RE);
});

test("api/network modality names the implicit-on-ingest gap", () => {
  const apiNetwork = UNSUPPORTED_ADD_MODALITIES.find((entry) => entry.modality === "api_network");
  assert.ok(apiNetwork, "an api_network unsupported modality must exist");
  assert.match(apiNetwork.missingPrimitive, API_NETWORK_PRIMITIVE_RE);
});
