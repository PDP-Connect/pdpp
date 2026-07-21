// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

const LIVE_STATE_PATTERNS: readonly RegExp[] = [
  /\bcurrently\s+(?:logged in|logged out|valid|invalid|healthy|degraded|broken|blocked|expired|available|unavailable)\b/iu,
  /\bcurrent\s+(?:credential|credentials|grant|health|repair|session|state|status)\s+(?:is|are)\b/iu,
  /\bthis run currently\b/iu,
  /\b(?:needs|requires)\s+login\s+again\b/iu,
  /\b(?:app|push)\s+approval\b/iu,
  /\bprovider\s+page\b/iu,
  /\bbrowser\s+action\b/iu,
  /\breconnect this account\b/iu,
];

interface Manifest {
  capabilities?: {
    human_interaction?: unknown;
    public_listing?: {
      status?: unknown;
    };
    refresh_policy?: {
      assisted_after_owner_auth?: unknown;
      background_safe?: unknown;
      interaction_posture?: unknown;
      rationale?: unknown;
      recommended_mode?: unknown;
    };
  };
  connector_id?: unknown;
  runtime_requirements?: {
    bindings?: Record<string, unknown>;
  };
  setup?: {
    credential_capture?: {
      description?: unknown;
      fields?: readonly { name?: unknown; secret?: unknown }[];
      kind?: unknown;
    };
    manual_or_upload?: {
      acquisition_methods?: readonly { detail?: unknown; label?: unknown }[];
      description?: unknown;
      help_text?: unknown;
      label?: unknown;
      large_file_fallback?: unknown;
      validation_expectations?: readonly unknown[];
    };
    modality?: unknown;
  };
}

function listManifestNames(): string[] {
  return readdirSync(MANIFESTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/u, ""))
    .sort();
}

function readManifest(name: string): Manifest {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, `${name}.json`), "utf8")) as Manifest;
}

function setupAndPolicyText(manifest: Manifest): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  const push = (path: string, value: unknown): void => {
    if (typeof value === "string" && value.trim().length > 0) {
      out.push({ path, value });
    }
  };

  push("setup.credential_capture.description", manifest.setup?.credential_capture?.description);
  push("setup.manual_or_upload.description", manifest.setup?.manual_or_upload?.description);
  push("setup.manual_or_upload.help_text", manifest.setup?.manual_or_upload?.help_text);
  push("setup.manual_or_upload.large_file_fallback", manifest.setup?.manual_or_upload?.large_file_fallback);
  push("capabilities.refresh_policy.rationale", manifest.capabilities?.refresh_policy?.rationale);

  for (const [index, method] of (manifest.setup?.manual_or_upload?.acquisition_methods ?? []).entries()) {
    push(`setup.manual_or_upload.acquisition_methods[${index}].label`, method.label);
    push(`setup.manual_or_upload.acquisition_methods[${index}].detail`, method.detail);
  }
  for (const [index, expectation] of (manifest.setup?.manual_or_upload?.validation_expectations ?? []).entries()) {
    push(`setup.manual_or_upload.validation_expectations[${index}]`, expectation);
  }

  return out;
}

const MANIFEST_NAMES = listManifestNames();

test("first-party setup and refresh-policy copy does not claim live repair state", () => {
  const offenders: string[] = [];
  for (const name of MANIFEST_NAMES) {
    const manifest = readManifest(name);
    for (const { path, value } of setupAndPolicyText(manifest)) {
      const pattern = LIVE_STATE_PATTERNS.find((candidate) => candidate.test(value));
      if (pattern) {
        offenders.push(`${name}:${path} matched ${pattern}: ${value}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "manifest setup/policy copy must describe stable mechanisms, not current connection repair state"
  );
});

test("static-secret manifests declare stable credential capture shape only", () => {
  const offenders: string[] = [];
  for (const name of MANIFEST_NAMES) {
    const manifest = readManifest(name);
    const capture = manifest.setup?.credential_capture;
    if (!capture) {
      continue;
    }
    const kind = typeof capture.kind === "string" ? capture.kind.trim() : "";
    const fields = Array.isArray(capture.fields) ? capture.fields : [];
    const hasSecretField = fields.some((field) => field.secret === true);
    if (manifest.setup?.modality !== "static_secret" || !kind || !hasSecretField) {
      offenders.push(
        `${name} (modality=${String(manifest.setup?.modality)}, kind=${String(capture.kind)}, secret_fields=${String(hasSecretField)})`
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "credential capture in manifests must be a stable static-secret setup mechanism with at least one secret field"
  );
});

test("automatic needs-human-auth manifests are explicitly session-reuse/assisted policy, not generic background auth", () => {
  const offenders: string[] = [];
  for (const name of MANIFEST_NAMES) {
    const manifest = readManifest(name);
    const listingStatus = manifest.capabilities?.public_listing?.status;
    const policy = manifest.capabilities?.refresh_policy;
    if (listingStatus !== "needs_human_auth") {
      continue;
    }
    const claimsAutomatic = policy?.recommended_mode === "automatic" || policy?.background_safe === true;
    if (claimsAutomatic && policy?.assisted_after_owner_auth !== true) {
      offenders.push(name);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "needs-human-auth manifests may be automatic/background-safe only when explicitly marked assisted-after-owner-auth"
  );
});

test("human_interaction and interaction_posture stay coarse stable hints", () => {
  const allowedInteractions = new Set(["credentials", "manual_action", "otp"]);
  const allowedPostures = new Set(["credentials", "manual_action_likely", "none", "otp_likely"]);
  const offenders: string[] = [];

  for (const name of MANIFEST_NAMES) {
    const manifest = readManifest(name);
    const interactions = manifest.capabilities?.human_interaction;
    if (Array.isArray(interactions)) {
      for (const interaction of interactions) {
        if (typeof interaction !== "string" || !allowedInteractions.has(interaction)) {
          offenders.push(`${name}:capabilities.human_interaction=${String(interaction)}`);
        }
      }
    }
    const posture = manifest.capabilities?.refresh_policy?.interaction_posture;
    if (typeof posture !== "string" || !allowedPostures.has(posture)) {
      offenders.push(`${name}:capabilities.refresh_policy.interaction_posture=${String(posture)}`);
    }
  }

  assert.deepEqual(offenders, [], "manifest interaction declarations must stay at coarse capability/posture altitude");
});
