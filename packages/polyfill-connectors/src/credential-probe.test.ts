// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CREDENTIAL_PROBE_REGISTRY,
  CredentialProbeError,
  credentialValidationMode,
  type GithubProbeResponse,
  hasCredentialProbe,
  probeCredential,
} from "./credential-probe.ts";

// ---------------------------------------------------------------------------
// All probes here run against deterministic injected transports. No live
// provider call is ever made; the live transport module is never imported.
// ---------------------------------------------------------------------------

// A Gmail IMAP transport double whose LOGIN succeeds or rejects deterministically.
function gmailTransport(accept: boolean) {
  const calls: Array<{ address: string; password: string }> = [];
  return {
    calls,
    imapLogin(args: { address: string; password: string }): Promise<void> {
      calls.push(args);
      return accept ? Promise.resolve() : Promise.reject(new Error("imap auth failed (synthetic)"));
    },
  };
}

// A GitHub `GET /user` transport double returning a canned status + login.
function githubTransport(response: GithubProbeResponse) {
  const calls: Array<{ token: string }> = [];
  return {
    calls,
    getUser(args: { token: string }): Promise<GithubProbeResponse> {
      calls.push(args);
      return Promise.resolve(response);
    },
  };
}

test("registry advertises gmail and github as synchronous; others first_sync", () => {
  assert.equal(hasCredentialProbe("gmail"), true);
  assert.equal(hasCredentialProbe("github"), true);
  assert.equal(hasCredentialProbe("amazon"), false);
  assert.equal(hasCredentialProbe(null), false);
  assert.equal(credentialValidationMode("gmail"), "synchronous");
  assert.equal(credentialValidationMode("github"), "synchronous");
  assert.equal(credentialValidationMode("ynab"), "first_sync");
  assert.equal(credentialValidationMode(undefined), "first_sync");
});

test("registry descriptors declare the connector's credential kind", () => {
  assert.equal(CREDENTIAL_PROBE_REGISTRY.gmail?.credentialKind, "app_password");
  assert.equal(CREDENTIAL_PROBE_REGISTRY.github?.credentialKind, "personal_access_token");
});

// ─── Gmail ───────────────────────────────────────────────────────────────

test("gmail: a valid app password resolves the mailbox address as identity", async () => {
  const transport = gmailTransport(true);
  const result = await probeCredential({
    connectorKey: "gmail",
    secret: "abcd efgh ijkl mnop",
    context: { setupFields: { account_email: "the owner@example.com" } },
    transport,
  });
  assert.equal(result.identity, "the owner@example.com");
  // The probe authenticated with the submitted secret against the given mailbox.
  assert.deepEqual(transport.calls, [{ address: "the owner@example.com", password: "abcd efgh ijkl mnop" }]);
});

test("gmail: a rejected app password throws a provider-named typed error with no secret", async () => {
  const transport = gmailTransport(false);
  await assert.rejects(
    () =>
      probeCredential({
        connectorKey: "gmail",
        secret: "wrong app password",
        context: { setupFields: { account_email: "the owner@example.com" } },
        transport,
      }),
    (err: unknown) => {
      assert.ok(err instanceof CredentialProbeError);
      assert.equal(err.code, "gmail_credential_rejected");
      assert.match(err.message, /Google rejected this app password/);
      // The owner-causal message never echoes the secret.
      assert.doesNotMatch(err.message, /wrong app password/);
      return true;
    }
  );
});

test("gmail: a missing mailbox address is a typed error, not a transport call", async () => {
  const transport = gmailTransport(true);
  await assert.rejects(
    () => probeCredential({ connectorKey: "gmail", secret: "x", context: {}, transport }),
    (err: unknown) => {
      assert.ok(err instanceof CredentialProbeError);
      assert.equal(err.code, "gmail_address_missing");
      return true;
    }
  );
  assert.equal(transport.calls.length, 0);
});

// ─── GitHub ──────────────────────────────────────────────────────────────

test("github: a valid token resolves the login as identity", async () => {
  const transport = githubTransport({ status: 200, login: "octocat" });
  const result = await probeCredential({
    connectorKey: "github",
    secret: "ghp_synthetic_token",
    transport,
  });
  assert.equal(result.identity, "octocat");
  assert.deepEqual(transport.calls, [{ token: "ghp_synthetic_token" }]);
});

test("github: a 401 throws a provider-named typed error with no token echo", async () => {
  const transport = githubTransport({ status: 401, login: null });
  await assert.rejects(
    () => probeCredential({ connectorKey: "github", secret: "ghp_bad_token", transport }),
    (err: unknown) => {
      assert.ok(err instanceof CredentialProbeError);
      assert.equal(err.code, "github_credential_rejected");
      assert.match(err.message, /GitHub rejected this token/);
      assert.doesNotMatch(err.message, /ghp_bad_token/);
      return true;
    }
  );
});

test("github: a 403 distinguishes an insufficient-scope token", async () => {
  const transport = githubTransport({ status: 403, login: null });
  await assert.rejects(
    () => probeCredential({ connectorKey: "github", secret: "ghp_scopeless", transport }),
    (err: unknown) => {
      assert.ok(err instanceof CredentialProbeError);
      assert.equal(err.code, "github_credential_insufficient");
      return true;
    }
  );
});

test("github: an unexpected status is retryable, not a hard rejection", async () => {
  const transport = githubTransport({ status: 503, login: null });
  await assert.rejects(
    () => probeCredential({ connectorKey: "github", secret: "ghp_token", transport }),
    (err: unknown) => {
      assert.ok(err instanceof CredentialProbeError);
      assert.equal(err.code, "github_unreachable");
      assert.equal(err.retryable, true);
      return true;
    }
  );
});

// ─── Orchestration guards ──────────────────────────────────────────────────

test("a connector with no probe is a distinct typed error, not a rejection", async () => {
  await assert.rejects(
    () => probeCredential({ connectorKey: "amazon", secret: "x", transport: {} }),
    (err: unknown) => {
      assert.ok(err instanceof CredentialProbeError);
      assert.equal(err.code, "no_credential_probe");
      return true;
    }
  );
});

test("an empty secret is rejected before any transport call", async () => {
  const transport = githubTransport({ status: 200, login: "octocat" });
  await assert.rejects(
    () => probeCredential({ connectorKey: "github", secret: "", transport }),
    (err: unknown) => {
      assert.ok(err instanceof CredentialProbeError);
      assert.equal(err.code, "probe_secret_invalid");
      return true;
    }
  );
  assert.equal(transport.calls.length, 0);
});

test("a missing transport function is a typed error, never a crash", async () => {
  await assert.rejects(
    () => probeCredential({ connectorKey: "github", secret: "ghp_token", transport: {} }),
    (err: unknown) => {
      assert.ok(err instanceof CredentialProbeError);
      assert.equal(err.code, "github_probe_transport_missing");
      return true;
    }
  );
});
