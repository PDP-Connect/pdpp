/**
 * biome-ignore-all lint/performance/useTopLevelRegex: Copy assertions are
 * clearer as local regex literals in tests.
 *
 * Unit tests for the per-source add-account support projection.
 *
 * These prove the Sources page can keep two facts distinct for a source that
 * already shows data: whether adding ANOTHER account is self-service, and the
 * one owner-facing next action — projected from the shared setup planner, not a
 * second classifier.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogManifestLike } from "./connection-catalog.ts";
import { buildSourceAddSupport, resolveSourceAddSupport } from "./source-add-support.ts";

const ADD_ANOTHER_ACCOUNT_LABEL_RE = /add another account/i;
const STATIC_SECRET_ROUTE_RE = /\/dashboard\/connect\/static-secret\/ynab/;
const DEVICE_EXPORTER_ROUTE_RE = /\/dashboard\/device-exporters\?connector=/;
const MANUAL_UPLOAD_ROUTE_RE = /\/dashboard\/connect\/manual-upload\/google-maps/;
const PACKAGED_PATH_PENDING_RE = /^Needs packaged path$/;
const DEMOTION_COPY_RE = /not self-service|not supported|track only|developer proof/i;
const DEV_JARGON_RE = /pnpm --dir|packages\/|monorepo|env var|connector_instance_id|PDPP_/;

/**
 * A static-secret connector manifest. The planner classifies this modality only
 * when the manifest carries a `setup.credential_capture` descriptor with at
 * least one secret field — that descriptor is what makes the static-secret
 * owner-session form manifest-authored. The `CatalogManifestLike` type models a
 * minimal subset, so the credential-capture block is attached via a structural
 * cast (the planner reads it through its own broader `ConnectorManifestLike`).
 */
function staticSecretManifest(connectorId: string): CatalogManifestLike {
  return {
    connector_id: connectorId,
    display_name: connectorId,
    runtime_requirements: { bindings: { network: {} } },
    setup: {
      modality: "static_secret",
      credential_capture: {
        credential_kind: "api_token",
        fields: [{ name: "api_token", label: "API token", secret: true }],
      },
    },
  } as unknown as CatalogManifestLike;
}

/** A browser-bound connector manifest (no manual collector proof path). */
function browserBoundManifest(connectorId: string): CatalogManifestLike {
  return {
    connector_id: connectorId,
    display_name: connectorId,
    runtime_requirements: { bindings: { browser: {} } },
  };
}

/** A local-collector connector manifest (filesystem-class). */
function localCollectorManifest(connectorId: string): CatalogManifestLike {
  return {
    connector_id: connectorId,
    display_name: connectorId,
    runtime_requirements: { bindings: { filesystem: {} } },
  };
}

/** A manifest-declared manual/upload connector (filesystem runtime, import setup). */
function manualUploadManifest(connectorId: string): CatalogManifestLike {
  return {
    connector_id: connectorId,
    display_name: connectorId,
    runtime_requirements: { bindings: { filesystem: {} } },
    setup: {
      modality: "manual_or_upload",
      manual_or_upload: {
        accepted_file_names: ["Timeline.json"],
        import_dir_env_var: "GOOGLE_MAPS_TIMELINE_DIR",
        label: "Timeline export",
      },
    },
  };
}

function providerAuthManifest(connectorId: string): CatalogManifestLike {
  return {
    connector_id: connectorId,
    display_name: connectorId,
    runtime_requirements: { bindings: { network: {} } },
    setup: {
      modality: "provider_authorization",
      deployment_config: ["GOOGLE_DATAPORTABILITY_CLIENT_ID", "GOOGLE_DATAPORTABILITY_CLIENT_SECRET"],
    },
  };
}

test("static-secret source supports self-service add-another-account with an action", () => {
  const map = buildSourceAddSupport([staticSecretManifest("ynab")]);
  const support = resolveSourceAddSupport(map, "ynab");
  assert.ok(support, "static-secret connector must appear in the support map");
  assert.equal(support.support, "self_service");
  assert.ok(support.action, "self-service add must carry a next action");
  assert.match(support.action.label, ADD_ANOTHER_ACCOUNT_LABEL_RE);
  assert.match(support.action.href, STATIC_SECRET_ROUTE_RE);
});

test("supported local collector supports self-service add and routes to enrollment", () => {
  // claude_code is in the proven local-collector set.
  const map = buildSourceAddSupport([localCollectorManifest("claude_code")]);
  const support = resolveSourceAddSupport(map, "claude_code");
  assert.ok(support);
  assert.equal(support.support, "self_service");
  assert.ok(support.action);
  assert.match(support.action.href, DEVICE_EXPORTER_ROUTE_RE);
});

test("browser-bound source is packaged-path-pending with NO action (never demoted to unsupported)", () => {
  const map = buildSourceAddSupport([browserBoundManifest("some_browser_source")]);
  const support = resolveSourceAddSupport(map, "some_browser_source");
  assert.ok(support);
  assert.equal(support.support, "packaged_path_pending");
  assert.equal(support.action, null, "packaged-path-pending add-new must not render a dead action");
  // Honest copy: the source is not inert — it is a supported-direction source
  // whose add-another path is being productized. The chip carries the SHORT
  // agreed label; the longer "browser setup moves into the dashboard" sentence
  // lives in setup guidance, not the chip (so it never reads as a second claim).
  assert.match(support.supportLabel, PACKAGED_PATH_PENDING_RE);
  assert.doesNotMatch(support.supportLabel, DEMOTION_COPY_RE);
});

test("manual/upload source supports self-service add with the generic upload route", () => {
  const map = buildSourceAddSupport([manualUploadManifest("google-maps")]);
  const support = resolveSourceAddSupport(map, "google-maps");
  assert.ok(support);
  assert.equal(support.support, "self_service");
  assert.ok(support.action, "manual/upload add-new must expose the generic upload action");
  assert.match(support.action.href, MANUAL_UPLOAD_ROUTE_RE);
  assert.doesNotMatch(support.supportLabel, DEMOTION_COPY_RE);
});

test("provider-auth source reports deployment prerequisite, not static-secret setup", () => {
  const map = buildSourceAddSupport([providerAuthManifest("google-maps-data-portability")]);
  const support = resolveSourceAddSupport(map, "google-maps-data-portability");
  assert.ok(support);
  assert.equal(support.support, "deployment_prerequisite");
  assert.equal(support.action, null);
  assert.match(support.supportLabel, /deployment setup/i);
  assert.doesNotMatch(support.supportLabel, /app password|credential|env var/i);
});

test("a connection's raw registry-prefixed connector_id resolves to the canonical key", () => {
  const map = buildSourceAddSupport([staticSecretManifest("ynab")]);
  const support = resolveSourceAddSupport(map, "https://registry.pdpp.org/connectors/ynab");
  assert.ok(support, "registry-URL connector_id must resolve via canonicalConnectorKey");
  assert.equal(support.support, "self_service");
});

test("an unknown connector_id has no support entry rather than an invented one", () => {
  const map = buildSourceAddSupport([staticSecretManifest("ynab")]);
  assert.equal(resolveSourceAddSupport(map, "totally_unknown"), null);
});

test("every support state carries an owner-safe label with no developer jargon", () => {
  const map = buildSourceAddSupport([
    staticSecretManifest("ynab"),
    browserBoundManifest("some_browser_source"),
    localCollectorManifest("claude_code"),
  ]);
  for (const support of map.values()) {
    assert.doesNotMatch(support.supportLabel, DEV_JARGON_RE);
  }
});
